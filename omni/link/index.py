"""SessionIndex: this node's list of human-facing sessions, kept current and pushed to the hub (v3 spec §5.2).

Why not just ask Hermes on every request (the v2 bug): ``GET /api/sessions`` serves at most 100 rows
per page and always drops ``hidden`` rows (the TUI "Bot Chat" is hidden), and v2 also filtered folders
by exact cwd, so subfolder sessions vanished. The index is built from three sources:

* REST ``/api/sessions`` pages (order=recent, internal sources excluded): rich rows with cwd,
  last_active, pinned, first prompt, token/cost totals.
* WS ``session.list {include_hidden}``: the complete membership, including hidden rows; ids missing
  from the REST pages are read one by one with ``GET /api/sessions/{id}``.
* Live state: sessions this link watches (running, open requests, activity, last turn status) and
  ``session.active_list`` for runtimes other clients started in the dashboard process.

Previews (the newest meaningful message) are read for rows whose message count or activity time
moved, newest first and bounded per pass. A turn running in another process (terminal TUI) is
detected from the newest rows: an unfinished turn that was active within EXTERNAL_RUNNING_S.

Hermes' ``sessions.changed`` broadcast (state.db moved, at most every 2 s) and mutations through
this link trigger a *light* relist: only the most recent page, merged into the index. A *full*
relist (every page, removals) runs on the periodic timer, after (re)connects and on demand
(``sessions.list`` when the index is older than FRESH_S).
Changes go to the hub as ``sessions.update`` deltas; ``full:true`` after the hub welcome.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import TYPE_CHECKING, Any, Callable

from omni.proto import EXCLUDED_SOURCES, ev, parse_omni_header
from omni.link.hermes import HermesError
from omni.link.titles import has_hangul, title_hint_for
from omni.link.util import TaskSet, to_text

if TYPE_CHECKING:
    from omni.link.projects import ProjectDir
    from omni.link.sessions import SessionManager

log = logging.getLogger("omni.link.index")

PAGE = 100                 # Hermes REST page cap
INDEX_MAX = 2000           # rows kept per node
FRESH_S = 10.0             # sessions.list relists first when the index is older than this
PERIODIC_S = 30.0          # full relist at least this often (removals, hidden rows, missed changes)
DEBOUNCE_S = 0.6
MIN_INTERVAL_S = 2.0       # between relists
LIGHT_PAGE = 100           # a light relist (after sessions.changed) reads only the most recent rows
PREVIEW_FETCH_MAX = 40     # preview reads per relist pass (newest rows first)
PREVIEW_CONCURRENCY = 4
DETAIL_FETCH_MAX = 50      # hidden-row detail reads per pass
PREVIEW_CHARS = 200
FIRST_PROMPT_CHARS = 200
EXTERNAL_RUNNING_S = 180.0
ACTIVITY_THROTTLE_S = 2.0
DRAFT_TTL_S = 24 * 3600
# A title hint stays open this long: Hermes defers the model title past the whole first turn when the
# title call would share a self-hosted endpoint with it, and a first turn can run for a long time.
TITLE_HINT_TTL_S = 6 * 3600
TITLE_RETRY_MAX = 3


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _one_line(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def preview_from_rows(rows: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, bool]:
    """(preview, unfinished) from the newest message rows (ascending order).

    preview = {role: user|assistant|agent, text, at, from}; agent = a delivered omni message/reply.
    unfinished = the newest row shows a turn still in progress (user/tool row or a tool-call step).
    """
    unfinished = False
    if rows:
        last = rows[-1]
        role = last.get("role")
        unfinished = role in ("user", "tool") or (role == "assistant" and (
            bool(last.get("tool_calls")) or not to_text(last.get("content")).strip()))
    for r in reversed(rows):
        role = r.get("role")
        text = to_text(r.get("content")).strip()
        if role not in ("user", "assistant") or not text:
            continue
        at = _num(r.get("timestamp"))
        if role == "user":
            omni = parse_omni_header(text)
            if omni is not None:
                return ({"role": "agent", "text": _one_line(omni["body"] or "", PREVIEW_CHARS), "at": at,
                         "from": omni["from_title"] or omni["from"]}, unfinished)
        return {"role": role, "text": _one_line(text, PREVIEW_CHARS), "at": at, "from": None}, unfinished
    return None, unfinished


def first_prompt(raw: Any) -> str | None:
    text = to_text(raw).strip()
    if not text:
        return None
    omni = parse_omni_header(text)
    if omni is not None:
        text = omni["body"] or ""
    return _one_line(text, FIRST_PROMPT_CHARS) or None


class SessionIndex:
    def __init__(self, sessions: "SessionManager", folders: Callable[[], list["ProjectDir"]],
                 emit: Callable[[dict], bool], workspace: str):
        self.sessions = sessions
        self.folders = folders
        self.emit = emit                      # returns False when the hub is not connected
        self.workspace = os.path.normpath(workspace)
        self.rows: dict[str, dict[str, Any]] = {}
        self.at = 0.0                         # monotonic time of the last completed relist
        self._preview: dict[str, tuple[Any, Any, dict | None, bool]] = {}   # sid -> (count, active, preview, unfinished)
        self._hidden_detail: dict[str, tuple[Any, dict]] = {}              # sid -> (message_count, detail row)
        self._sent: dict[str, str] = {}       # sid -> JSON last sent to the hub
        self._last_activity_emit: dict[str, float] = {}
        self._activity_timers: dict[str, asyncio.TimerHandle] = {}
        self._lock = asyncio.Lock()
        self._dirty = asyncio.Event()
        self._full_wanted = True
        self._last_relist_start = 0.0
        self._last_full = 0.0
        self._full_due = True                 # next emit is a full snapshot (hub welcome)
        self._tasks = TaskSet("index")
        self._retitling: set[str] = set()     # sids with a title-language rename in flight
        self._first = asyncio.Event()

    # --- lifecycle -----------------------------------------------------------------------
    def start(self) -> None:
        self._tasks.spawn(self._loop(), name="index-loop")
        self.trigger()

    async def close(self) -> None:
        for h in self._activity_timers.values():
            h.cancel()
        await self._tasks.cancel_all()

    def trigger(self, full: bool = False) -> None:
        """Ask for a relist soon (debounced, at most one per MIN_INTERVAL_S)."""
        if full:
            self._full_wanted = True
        self._dirty.set()

    def on_hub_welcome(self) -> None:
        self._full_due = True
        if self._first.is_set():
            self._emit_full()
        self.trigger(full=True)

    async def _loop(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self._dirty.wait(), PERIODIC_S)
            except asyncio.TimeoutError:
                pass
            await asyncio.sleep(DEBOUNCE_S)
            wait = self._last_relist_start + MIN_INTERVAL_S - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._dirty.clear()
            full = self._full_wanted or time.monotonic() - self._last_full >= PERIODIC_S
            self._full_wanted = False
            try:
                await self.relist(full)
            except asyncio.CancelledError:
                raise
            except HermesError as e:
                log.warning("session relist failed: %s", e)
            except Exception:  # noqa: BLE001
                log.exception("session relist failed")

    # --- queries -------------------------------------------------------------------------
    async def ensure_fresh(self, max_age: float = FRESH_S) -> None:
        if time.monotonic() - self.at > max_age:
            try:
                await self.relist()
            except HermesError as e:
                if not self._first.is_set():
                    raise
                log.warning("relist failed, serving the cached index: %s", e)

    def list(self, path: str | None = None, limit: int = 1000) -> list[dict[str, Any]]:
        rows = list(self.rows.values())
        if path:
            p = os.path.normpath(path)
            rows = [r for r in rows if r.get("cwd") and (r["cwd"] == p or r["cwd"].startswith(p.rstrip("/") + "/"))]
        rows.sort(key=lambda r: r.get("last_active") or 0, reverse=True)
        return rows[:limit]

    def get(self, sid: str) -> dict[str, Any] | None:
        return self.rows.get(sid)

    def folder_stats(self) -> dict[str, tuple[int, float | None]]:
        """folder path -> (session count, newest last_active)."""
        out: dict[str, tuple[int, float | None]] = {}
        for r in self.rows.values():
            f = r.get("folder")
            if not f:
                continue
            n, la = out.get(f["path"], (0, None))
            cur = r.get("last_active")
            out[f["path"]] = (n + 1, max(la or 0, cur or 0) or None)
        return out

    def is_no_folder(self, cwd: str | None) -> bool:
        """A session without a chosen folder: no cwd (Desktop) or the node's default working directory.
        Hermes stamps that default on the row of a session created without a cwd (only Desktop-sourced
        rows keep NULL), so "폴더 없음" is recorded here rather than as a NULL cwd."""
        return not cwd or os.path.normpath(cwd) == self.workspace

    def folder_for(self, cwd: str | None) -> dict[str, str] | None:
        if not cwd:
            return None
        c = os.path.normpath(cwd)
        best = None
        for f in self.folders():
            if f.is_root:
                continue   # the workspace root is "no folder" (the default working directory)
            if c == f.path or c.startswith(f.path.rstrip("/") + "/"):
                if best is None or len(f.path) > len(best.path):
                    best = f
        return {"name": best.name, "path": best.path} if best else None

    # --- relist --------------------------------------------------------------------------
    async def relist(self, full: bool = True) -> None:
        async with self._lock:
            full = full or not self._first.is_set()
            self._last_relist_start = time.monotonic()
            await self._relist_locked(full)
            if full:
                self.at = self._last_full = time.monotonic()
            self._first.set()

    async def _relist_locked(self, full: bool) -> None:
        h = self.sessions.hermes
        assert h is not None
        rest_rows: dict[str, dict[str, Any]] = {}
        offset = 0
        excluded = ",".join(EXCLUDED_SOURCES)
        while offset < (INDEX_MAX if full else LIGHT_PAGE):
            page = await h.rest("GET", "/api/sessions", params={
                "limit": str(PAGE), "offset": str(offset), "order": "recent", "archived": "exclude",
                "exclude_sources": excluded})
            batch = (page or {}).get("sessions") or []
            for r in batch:
                if isinstance(r, dict) and isinstance(r.get("id"), str):
                    rest_rows.setdefault(r["id"], r)
            if len(batch) < PAGE:
                break
            offset += PAGE
        members: dict[str, dict[str, Any]] = {}
        try:
            res = await h.call("session.list", {"limit": INDEX_MAX if full else LIGHT_PAGE, "include_hidden": True},
                               timeout=30)
            for r in res.get("sessions") or []:
                if isinstance(r, dict) and isinstance(r.get("id"), str):
                    members[r["id"]] = r
        except HermesError as e:
            log.debug("session.list (hidden rows) failed: %s", e)
        # Rows only the WS listing knows are hidden ones (REST always drops hidden rows).
        missing = [sid for sid, m in members.items()
                   if sid not in rest_rows and (m.get("source") or "") not in EXCLUDED_SOURCES]
        fetched = 0
        for sid in missing:
            cached = self._hidden_detail.get(sid)
            count = members[sid].get("message_count")
            if cached is not None and cached[0] == count:
                rest_rows[sid] = cached[1]
                continue
            if fetched >= DETAIL_FETCH_MAX:
                if cached is not None:
                    rest_rows[sid] = cached[1]
                continue
            fetched += 1
            try:
                row = await h.rest("GET", f"/api/sessions/{sid}", allow_404=True)
            except HermesError as e:
                log.debug("detail of hidden session %s failed: %s", sid, e)
                continue
            if isinstance(row, dict) and not row.get("archived"):
                row.setdefault("preview", members[sid].get("preview"))
                self._hidden_detail[sid] = (count, row)
                rest_rows[sid] = row
        if full:
            for sid in list(self._hidden_detail):
                if sid not in members:
                    self._hidden_detail.pop(sid, None)

        live = await self.sessions.live_status()
        await self._refresh_previews(rest_rows)
        now = time.time()
        # A light relist saw only the newest rows: merge them into the index and remove nothing.
        new_rows: dict[str, dict[str, Any]] = {} if full else dict(self.rows)
        for sid, r in rest_rows.items():
            if (r.get("source") or "") in EXCLUDED_SOURCES:
                continue
            new_rows[sid] = self._build_row(sid, r, live, now)
        for sid, d in list(self.sessions.drafts.items()):
            if sid in new_rows:
                self.sessions.drop_draft(sid)
            elif now - float(d.get("created_at") or 0) > DRAFT_TTL_S:
                self.sessions.drop_draft(sid)
            else:
                new_rows[sid] = self._draft_row(sid, d, live)
        if full:
            for sid in list(self._preview):
                if sid not in new_rows:
                    self._preview.pop(sid, None)
            self._expire_title_hints(new_rows, now)
        self._apply(new_rows, authoritative=full)

    async def _refresh_previews(self, rows: dict[str, dict[str, Any]]) -> None:
        due = []
        for sid, r in rows.items():
            key = (r.get("message_count"), r.get("last_active") or r.get("last_activity_at"))
            cached = self._preview.get(sid)
            if cached is None or (cached[0], cached[1]) != key:
                due.append((key[1] or r.get("started_at") or 0, sid, key))
        if not due:
            return
        due.sort(reverse=True)
        sem = asyncio.Semaphore(PREVIEW_CONCURRENCY)
        h = self.sessions.hermes
        assert h is not None

        async def one(sid: str, key: tuple[Any, Any]) -> None:
            async with sem:
                try:
                    page = await h.rest("GET", f"/api/sessions/{sid}/messages",
                                        params={"limit": "6", "order": "latest"}, allow_404=True)
                except HermesError as e:
                    log.debug("preview of %s failed: %s", sid, e)
                    return
            msgs = (page or {}).get("messages") or []
            preview, unfinished = preview_from_rows(msgs)
            self._preview[sid] = (key[0], key[1], preview, unfinished)

        await asyncio.gather(*(one(sid, key) for _, sid, key in due[:PREVIEW_FETCH_MAX]))

    def _live(self, sid: str, live: dict[str, str], unfinished: bool, last_active: float | None,
              now: float) -> dict[str, Any]:
        st = self.sessions.live_row_state(sid)
        if st is not None:
            return st
        status = live.get(sid)
        if status in ("working", "waiting"):
            return {"running": True, "status": status, "pending_requests": None if status == "waiting" else 0,
                    "activity": None, "last_turn_status": None}
        if unfinished and last_active and now - last_active < EXTERNAL_RUNNING_S:
            return {"running": True, "status": "working", "pending_requests": 0, "activity": None,
                    "last_turn_status": None}
        return {"running": False, "status": "idle", "pending_requests": 0, "activity": None,
                "last_turn_status": None}

    def _build_row(self, sid: str, r: dict[str, Any], live: dict[str, str], now: float) -> dict[str, Any]:
        cwd = r.get("cwd") if isinstance(r.get("cwd"), str) and r.get("cwd") else None
        last_active = _num(r.get("last_active")) or _num(r.get("last_activity_at")) or _num(r.get("started_at"))
        cached = self._preview.get(sid)
        old = self.rows.get(sid) or {}
        preview = cached[2] if cached else old.get("preview")
        unfinished = bool(cached[3]) if cached else False
        row = {
            "stored_id": sid, "title": self._keep_title_language(sid, r.get("title") or None, r.get("title_source")),
            "cwd": cwd, "folder": self.folder_for(cwd),
            "no_folder": self.is_no_folder(cwd), "source": r.get("source") or None, "hidden": bool(r.get("hidden")), "pinned": bool(r.get("pinned")),
            "started_at": _num(r.get("started_at")), "last_active": last_active,
            "message_count": r.get("message_count") if isinstance(r.get("message_count"), int) else None,
            "preview": preview, "first_prompt": first_prompt(r.get("preview")), "draft": False,
            "usage": {"input": r.get("input_tokens"), "output": r.get("output_tokens"),
                      "cost_usd": _num(r.get("actual_cost_usd")) or _num(r.get("estimated_cost_usd")),
                      "cost_status": r.get("cost_status")},
        }
        row.update(self._live(sid, live, unfinished, last_active, now))
        return row

    def _draft_row(self, sid: str, d: dict[str, Any], live: dict[str, str]) -> dict[str, Any]:
        cwd = d.get("cwd") or None
        row = {"stored_id": sid, "title": d.get("title") or None, "cwd": cwd, "folder": self.folder_for(cwd),
               "no_folder": self.is_no_folder(cwd), "source": None, "hidden": False, "pinned": False, "started_at": d.get("created_at"),
               "last_active": d.get("created_at"), "message_count": 0, "preview": None, "first_prompt": None,
               "draft": True, "usage": None}
        row.update(self._live(sid, live, False, None, time.time()))
        return row

    # --- title language (omni/link/titles.py) ---------------------------------------------
    def note_first_prompt(self, sid: str, text: str) -> None:
        """A human prompt is about to open session ``sid``: keep its auto-title Korean if it is."""
        title = title_hint_for(text)
        if title is None:
            self.sessions.state.drop_title_hint(sid)
            return
        self.sessions.state.title_hints[sid] = {"title": title, "at": time.time(), "tries": 0}
        self.sessions.state.mark_dirty()

    def drop_title_hint(self, sid: str) -> None:
        """The session was renamed on purpose (or deleted): its title is no longer ours to keep."""
        self.sessions.state.drop_title_hint(sid)

    def _keep_title_language(self, sid: str, title: str | None, source: Any) -> str | None:
        """The title to list for a database row. With an open hint, a title without Hangul is shown
        as the hint; a settled one (``llm``) is renamed to it in Hermes. A Korean model title or a
        name the user typed closes the hint."""
        hint = self.sessions.state.title_hints.get(sid)
        if hint is None or not title:
            return title
        if has_hangul(title) or source == "user":
            if source in ("llm", "user"):
                self.sessions.state.drop_title_hint(sid)
            return title
        if source == "llm" and sid not in self._retitling:
            self._retitling.add(sid)
            self._tasks.spawn(self._retitle(sid, hint["title"]), name=f"retitle-{sid}")
        return hint.get("title") or title

    async def _retitle(self, sid: str, title: str) -> None:
        try:
            done = await self.sessions.retitle(sid, title)
        except HermesError as e:
            # Possibly transient (Hermes restarting): keep the hint so a later relist retries, a few times.
            hint = self.sessions.state.title_hints.get(sid)
            if hint is not None:
                hint["tries"] = int(hint.get("tries") or 0) + 1
                if hint["tries"] >= TITLE_RETRY_MAX:
                    self.sessions.state.drop_title_hint(sid)
                else:
                    self.sessions.state.mark_dirty()
            log.warning("could not keep the Korean title of %s: %s", sid, e)
            return
        except Exception as e:   # SessionOpError (gone, refused): give up on this session
            log.warning("could not keep the Korean title of %s: %s", sid, e)
            self.sessions.state.drop_title_hint(sid)
            return
        finally:
            self._retitling.discard(sid)
        self.sessions.state.drop_title_hint(sid)
        if done is None:
            log.warning("could not keep the Korean title of %s: %r and its numbered variants are taken", sid, title)
            self.trigger()
            return
        log.info("session %s: replaced the English auto-title with %r (first prompt is Korean)", sid, done)
        self.upsert_now(sid, {"title": done})

    def _expire_title_hints(self, rows: dict[str, dict[str, Any]], now: float) -> None:
        hints = self.sessions.state.title_hints
        for sid, hint in list(hints.items()):
            age = now - float(hint.get("at") or 0)
            if age > TITLE_HINT_TTL_S or (sid not in rows and age > 120):
                self.sessions.state.drop_title_hint(sid)

    # --- live patches --------------------------------------------------------------------
    def patch_live(self, sid: str, activity_only: bool = False) -> None:
        """A watched session's live state changed: refresh its row and push it (activity-only
        changes are throttled to one upsert per ACTIVITY_THROTTLE_S)."""
        row = self.rows.get(sid)
        if row is None:
            self.trigger()
            return
        if activity_only:
            last = self._last_activity_emit.get(sid, 0.0)
            wait = last + ACTIVITY_THROTTLE_S - time.monotonic()
            if wait > 0:
                if sid not in self._activity_timers:
                    self._activity_timers[sid] = asyncio.get_running_loop().call_later(
                        wait, self._flush_activity, sid)
                return
        self._flush_activity(sid)

    def _flush_activity(self, sid: str) -> None:
        self._activity_timers.pop(sid, None)
        row = self.rows.get(sid)
        if row is None:
            return
        st = self.sessions.live_row_state(sid)
        if st is None:
            return
        new = dict(row)
        new.update(st)
        self._last_activity_emit[sid] = time.monotonic()
        self._apply({**self.rows, sid: new}, authoritative=False, only={sid})

    def note_message(self, sid: str, role: str, text: str | None, from_title: str | None = None) -> None:
        """Update the preview right away (the next relist confirms it from the database)."""
        row = self.rows.get(sid)
        if row is None or not text or not text.strip():
            return
        now = time.time()
        new = dict(row)
        new["preview"] = {"role": role, "text": _one_line(text, PREVIEW_CHARS), "at": now, "from": from_title}
        new["last_active"] = now
        self._apply({**self.rows, sid: new}, authoritative=False, only={sid})
        self.trigger()

    def rotate(self, old: str, new: str) -> None:
        row = self.rows.get(old)
        if row is None:
            self.trigger()
            return
        rows = dict(self.rows)
        moved = dict(rows.pop(old))
        moved["stored_id"] = new
        rows[new] = moved
        if old in self._preview:
            self._preview[new] = self._preview.pop(old)
        self._apply(rows, authoritative=True)
        self.trigger()

    def upsert_now(self, sid: str, fields: dict[str, Any]) -> dict[str, Any] | None:
        """Apply known fields to a row immediately (rename/pin through this link)."""
        row = self.rows.get(sid)
        if row is None:
            return None
        new = dict(row)
        new.update(fields)
        self._apply({**self.rows, sid: new}, authoritative=False, only={sid})
        self.trigger()
        return new

    def remove_now(self, sid: str) -> None:
        if sid in self.rows:
            rows = dict(self.rows)
            rows.pop(sid)
            self._apply(rows, authoritative=True)

    def add_draft_now(self, sid: str) -> dict[str, Any] | None:
        d = self.sessions.drafts.get(sid)
        if d is None:
            return None
        row = self._draft_row(sid, d, {})
        self._apply({**self.rows, sid: row}, authoritative=False, only={sid})
        return row

    # --- emission ------------------------------------------------------------------------
    def _apply(self, new_rows: dict[str, dict[str, Any]], authoritative: bool, only: set[str] | None = None) -> None:
        removed = [sid for sid in self.rows if sid not in new_rows] if authoritative else []
        self.rows = new_rows
        if self._full_due:
            if self._first.is_set() or authoritative:
                self._emit_full()
            return
        upsert = []
        for sid in (only if only is not None else new_rows.keys()):
            row = new_rows.get(sid)
            if row is None:
                continue
            enc = json.dumps(row, sort_keys=True, ensure_ascii=False, default=str)
            if self._sent.get(sid) != enc:
                self._sent[sid] = enc
                upsert.append(row)
        for sid in removed:
            self._sent.pop(sid, None)
        if upsert or removed:
            if not self.emit(ev("sessions.update", full=False, upsert=upsert, remove=removed)):
                self._full_due = True   # dropped: resend everything once the hub is back

    def _emit_full(self) -> None:
        rows = list(self.rows.values())
        if self.emit(ev("sessions.update", full=True, upsert=rows, remove=[])):
            self._full_due = False
            self._sent = {r["stored_id"]: json.dumps(r, sort_keys=True, ensure_ascii=False, default=str) for r in rows}
