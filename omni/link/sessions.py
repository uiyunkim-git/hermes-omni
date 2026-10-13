"""Session registry: Hermes runtime sessions ⇄ stored sessions, event forwarding, turn tracking.

Responsibilities (design §1, §5):
* attach = ``session.resume {omit_messages}`` → our WS becomes a fan-out viewer; we keep the
  runtime↔stored mapping, follow compression tips (``session.tip``) and re-resume on stale ids.
* events are filtered/trimmed into ``session.event`` / ``session.state`` / ``session.request`` /
  ``session.request_cancel`` frames for the hub.
* every ``message.complete`` produces one ``turn.done``; its ``delivery_id`` comes from the omni
  marker in the user row (REST) whose id is ``persisted_turn.user_row_id``.
* canonical sessions per folder: ``session.create`` + ``session.title`` (4022 → reuse that id).
* reconnect: re-resume, gap-fill with ``session.events.since``, re-forward open requests, and
  settle deliveries whose turn was lost (Hermes restart) with an error ``turn.done``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable

from omni.proto import FORWARD_REQUEST_METHODS, canonical_title, ev, find_marker
from omni.link.config import Config
from omni.link.hermes import STALE_SESSION_CODES, HermesClient, HermesError, HermesUnavailable
from omni.link.state import LinkState
from omni.link.util import TaskSet, to_text, trim

log = logging.getLogger("omni.link.sessions")

TITLE_IN_USE = 4022
_IN_USE_RE = re.compile(r"in use by session ([A-Za-z0-9_.:-]+)")
REATTACH_WINDOW_S = 2 * 3600       # on link start, re-attach sessions active within this window
MSG_CONTENT_MAX = 8000
TOOL_CONTENT_MAX = 2000
MESSAGES_MAX = 1000       # session.messages cap (matches the hub API)
HERMES_PAGE_MAX = 500     # Hermes REST serves at most this many rows per request
REQUEST_PARAM_MAX = 4000
RECENT_DONE_MAX = 256
# Sessions attached to a live socket are never reaped by Hermes, so idle ones are dropped from the
# registry and the socket is recycled (Hermes then orphan-reaps whatever nobody else watches).
IDLE_DETACH_S = 2 * 3600
HOUSEKEEPING_S = 600
INFLIGHT_STALE_S = 3600   # an idle session with a delivery this old lost its turn: settle it
UNCONFIRMED_CHECK_S = 20  # cadence of checks after an ambiguous prompt.submit
UNCONFIRMED_VERIFY_S = 900


class SessionOpError(Exception):
    """A hub-facing error with a string code (sent back in res_err)."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass
class Attached:
    stored_id: str
    runtime_id: str | None = None
    epoch: str | None = None
    last_seq: int = 0
    running: bool = False
    title: str | None = None
    cwd: str | None = None
    open_requests: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_active: float = field(default_factory=time.time)
    prev_runtime: str | None = None   # runtime id from a previous link process (for gap fill)
    # While a resume + replay is in progress, live events are parked here so the replay
    # (older seqs) is applied first; otherwise the seq dedupe would discard the replay.
    replaying: bool = False
    parked: list[dict[str, Any]] = field(default_factory=list)


# --- event filtering ---------------------------------------------------------------------
def _json_trim(value: Any, limit: int) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return trim(value, limit)
    return trim(json.dumps(value, ensure_ascii=False, default=str), limit)


def _usage(u: Any) -> dict[str, Any] | None:
    if not isinstance(u, dict):
        return None
    return {"input": u.get("input"), "output": u.get("output"), "total": u.get("total")}


def filter_event(etype: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    """Map a Hermes event to the trimmed hub payload, or None to drop it."""
    if etype == "message.start":
        return {}
    if etype in ("message.delta", "reasoning.delta"):
        text = payload.get("text")
        return {"text": text} if text else None
    if etype == "tool.generating":
        return {"name": payload.get("name")}
    if etype == "tool.start":
        out = {"tool_id": payload.get("tool_id"), "name": payload.get("name"),
               "args": _json_trim(payload.get("args"), 1000)}
        if payload.get("context"):
            out["context"] = trim(to_text(payload.get("context")), 300)
        return out
    if etype == "tool.complete":
        result = payload.get("result")
        out = {"tool_id": payload.get("tool_id"), "name": payload.get("name"),
               "duration_s": payload.get("duration_s"), "result_preview": _json_trim(result, 1500)}
        err = None
        if isinstance(result, dict) and result.get("error"):
            err = result.get("error")
        elif isinstance(result, str) and result.startswith(("Error executing tool", "[Tool execution cancelled")):
            err = result
        if payload.get("error"):
            err = payload.get("error")
        if err:
            out["error"] = trim(to_text(err), 500)
        return out
    if etype == "message.complete":
        return {"text": payload.get("text"), "status": payload.get("status") or "complete",
                "usage": _usage(payload.get("usage"))}
    if etype == "error":
        return {"message": trim(to_text(payload.get("message") or payload.get("error") or payload), 2000)}
    return None


def _trim_params(params: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in params.items():
        if k == "session_id":
            continue
        if isinstance(v, str):
            out[k] = trim(v, REQUEST_PARAM_MAX)
        elif isinstance(v, (int, float, bool)) or v is None:
            out[k] = v
        else:
            text = json.dumps(v, ensure_ascii=False, default=str)
            out[k] = v if len(text) <= REQUEST_PARAM_MAX else trim(text, REQUEST_PARAM_MAX)
    return out


def _request_obj(rid: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
    return {"request_id": rid, "method": method, "params": _trim_params(params or {})}


def map_message(row: dict[str, Any]) -> dict[str, Any]:
    role = row.get("role")
    limit = TOOL_CONTENT_MAX if role == "tool" else MSG_CONTENT_MAX
    tool_calls = row.get("tool_calls")
    if tool_calls:
        text = tool_calls if isinstance(tool_calls, str) else json.dumps(tool_calls, ensure_ascii=False, default=str)
        if len(text) > TOOL_CONTENT_MAX:
            tool_calls = trim(text, TOOL_CONTENT_MAX)
    return {"id": row.get("id"), "role": role, "content": trim(to_text(row.get("content")), limit),
            "timestamp": row.get("timestamp"), "tool_name": row.get("tool_name") or None,
            "tool_calls": tool_calls or None}


# --- manager -----------------------------------------------------------------------------
class SessionManager:
    def __init__(self, cfg: Config, state: LinkState, emit: Callable[[dict], None],
                 emit_turn_done: Callable[[dict], None]):
        self.cfg = cfg
        self.state = state
        self.emit = emit                      # best-effort event to hub
        self.emit_turn_done = emit_turn_done  # reliable path for turn.done (delivery outbox)
        self.hermes: HermesClient | None = None
        self.by_stored: dict[str, Attached] = {}
        self.by_runtime: dict[str, Attached] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._recent_done: OrderedDict[str, dict] = OrderedDict()
        self._tasks = TaskSet("sessions")
        self._restore_from_state()

    def bind(self, hermes: HermesClient) -> None:
        self.hermes = hermes

    def start(self) -> None:
        self._tasks.spawn(self._housekeeping(), name="sessions-housekeeping")
        # A previous process died mid-submit (or was stopped while submitting): outcome unknown.
        for did, entry in self.state.inflight.items():
            if "done" not in entry and entry.get("status") in ("submitting", "unknown"):
                entry["status"] = "unknown"
                self._tasks.spawn(self._verify_unconfirmed(did), name=f"verify-{did}")

    async def close(self) -> None:
        await self._tasks.cancel_all()

    async def _housekeeping(self) -> None:
        while True:
            await asyncio.sleep(HOUSEKEEPING_S)
            now = time.time()
            old = {e.get("stored_id") for e in self.state.inflight.values()
                   if "done" not in e and now - float(e.get("submitted_at") or now) > INFLIGHT_STALE_S}
            for sid in old:
                a = self.by_stored.get(sid)
                if sid and not (a is not None and a.running):
                    await self._settle_lost_deliveries(sid, before=now - INFLIGHT_STALE_S)
            if any(a.running for a in self.by_stored.values()):
                continue  # recycle only while quiet
            now = time.time()
            stale = [a for a in self.by_stored.values()
                     if not a.open_requests and not self._inflight_for(a.stored_id)
                     and now - a.last_active > IDLE_DETACH_S]
            if not stale:
                continue
            for a in stale:
                self._forget(a)
            log.info("detached %d idle session(s); recycling the hermes socket", len(stale))
            await self._h().recycle()

    def _h(self) -> HermesClient:
        assert self.hermes is not None
        return self.hermes

    def _lock(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = self._locks[key] = asyncio.Lock()
        return lock

    def _restore_from_state(self) -> None:
        """Rebuild the registry from link.json so a restarted link re-attaches what it watched."""
        now = time.time()
        wanted = {e.get("stored_id") for e in self.state.inflight.values() if e.get("stored_id")}
        for sid, rt in list(self.state.runtime.items()):
            if sid in wanted or now - float(rt.get("at") or 0) < REATTACH_WINDOW_S:
                wanted.add(sid)
            else:
                self.state.runtime.pop(sid, None)
                self.state.last_seq.pop(sid, None)
        for sid in wanted:
            rt = self.state.runtime.get(sid) or {}
            self.by_stored[sid] = Attached(stored_id=sid, epoch=rt.get("epoch"), prev_runtime=rt.get("id"),
                                           last_seq=int(self.state.last_seq.get(sid, 0)))

    # --- registry helpers ----------------------------------------------------------------
    def _register(self, a: Attached, runtime_id: str, epoch: str | None) -> None:
        if a.runtime_id and self.by_runtime.get(a.runtime_id) is a:
            del self.by_runtime[a.runtime_id]
        a.runtime_id = runtime_id
        a.epoch = epoch
        self.by_runtime[runtime_id] = a
        self.by_stored[a.stored_id] = a
        self.state.runtime[a.stored_id] = {"id": runtime_id, "epoch": epoch, "at": time.time()}
        self.state.mark_dirty()

    def _rotate(self, a: Attached, new_stored: str) -> None:
        old = a.stored_id
        if new_stored == old:
            return
        log.info("session tip moved %s -> %s", old, new_stored)
        self.by_stored.pop(old, None)
        a.stored_id = new_stored
        self.by_stored[new_stored] = a
        self.state.rename_stored(old, new_stored)
        self.emit(ev("session.tip", old=old, new=new_stored))

    def _set_seq(self, a: Attached, seq: int) -> None:
        a.last_seq = seq
        self.state.last_seq[a.stored_id] = seq
        self.state.mark_dirty()

    def canonical_ids(self) -> set[str]:
        return {e["stored_id"] for e in self.state.canonical.values() if e.get("stored_id")}

    # --- attach / resume -----------------------------------------------------------------
    async def attach(self, stored_id: str, *, refresh: bool = True) -> tuple[Attached, dict[str, Any]]:
        """Resume ``stored_id`` on our socket (idempotent). Returns (entry, resume result).

        With refresh=False an already-attached entry is returned without a round trip.
        """
        async with self._lock(stored_id):
            a = self.by_stored.get(stored_id)
            if a is not None and a.runtime_id and not refresh and self._h().connected.is_set():
                return a, {}
            if a is None:
                a = Attached(stored_id=stored_id)
            return a, await self._resume(a)

    async def _resume(self, a: Attached) -> dict[str, Any]:
        a.replaying = True
        try:
            return await self._resume_inner(a)
        finally:
            a.replaying = False
            parked, a.parked = a.parked, []
            for params in parked:
                self._apply_event(a, params)

    async def _resume_inner(self, a: Attached) -> dict[str, Any]:
        h = self._h()
        prev_runtime, a.prev_runtime = a.runtime_id or a.prev_runtime, None
        prev_epoch = a.epoch
        resumed_at = time.time()
        try:
            res = await h.call("session.resume", {"session_id": a.stored_id, "omit_messages": True}, timeout=60)
        except HermesError as e:
            if e.code in STALE_SESSION_CODES:
                raise SessionOpError("not_found", f"session {a.stored_id} not found") from e
            raise
        rid = res.get("session_id")
        if not rid:
            raise SessionOpError("hermes_error", "session.resume returned no session_id")
        tip = res.get("resumed") or res.get("session_key") or a.stored_id
        if isinstance(tip, str) and tip != a.stored_id:
            self._rotate(a, tip)
        same_stream = (rid == prev_runtime and h.epoch is not None and h.epoch == prev_epoch)
        if not same_stream:
            self._set_seq(a, 0)
        self._register(a, rid, h.epoch)
        a.running = bool(res.get("running"))
        info = res.get("info") or {}
        a.cwd = info.get("cwd") or a.cwd
        a.last_active = time.time()

        if same_stream and a.last_seq > 0:
            await self._gap_fill(a)
        self._absorb_open_requests(a, res.get("open_requests") or [])
        self.emit(ev("session.state", stored_id=a.stored_id, running=a.running, cwd=a.cwd))
        if not same_stream and not a.running:
            # Snapshot now: a submit racing with this resume (still "submitting") is not lost.
            lost = self._lost_candidates(a.stored_id, before=resumed_at)
            if lost:
                self._tasks.spawn(self._settle_lost_deliveries(a.stored_id, candidates=lost),
                                  name=f"settle-{a.stored_id}")
        return res

    async def _gap_fill(self, a: Attached) -> None:
        assert a.runtime_id
        try:
            res = await self._h().call("session.events.since",
                                       {"session_id": a.runtime_id, "last_seen": a.last_seq}, timeout=30)
        except HermesError as e:
            log.warning("events.since failed for %s: %s", a.stored_id, e)
            return
        events = res.get("events") or []
        if res.get("truncated"):
            log.warning("event replay for %s truncated; some live events were lost", a.stored_id)
        for params in events:
            if isinstance(params, dict):
                self._apply_event(a, params)
        if events:
            log.info("replayed %d events for %s", len(events), a.stored_id)
        self._absorb_open_requests(a, res.get("open_requests") or [])

    def _absorb_open_requests(self, a: Attached, reqs: list[dict[str, Any]]) -> None:
        for r in reqs:
            rid, method = r.get("id"), r.get("method")
            if not rid or method not in FORWARD_REQUEST_METHODS or rid in a.open_requests:
                continue
            req = _request_obj(rid, method, r.get("params") or {})
            a.open_requests[rid] = req
            self.emit(ev("session.request", stored_id=a.stored_id, request=req))

    async def on_hermes_connected(self, epoch: str | None) -> None:
        """Re-resume every watched session after (re)connecting to Hermes."""
        entries = list(self.by_stored.values())
        if entries:
            log.info("re-attaching %d session(s) after hermes connect", len(entries))
        for a in entries:
            try:
                async with self._lock(a.stored_id):
                    await self._resume(a)
            except SessionOpError as e:
                log.warning("dropping session %s: %s", a.stored_id, e.message)
                self._forget(a)
                self._tasks.spawn(self._settle_lost_deliveries(
                    a.stored_id, missing=True, candidates=self._lost_candidates(a.stored_id, time.time())))
            except HermesError as e:
                log.warning("re-attach of %s failed: %s", a.stored_id, e)

    async def on_hermes_disconnected(self) -> None:
        # Runtime ids may survive a WS drop (same process); keep them for the gap fill.
        for a in self.by_stored.values():
            self.state.runtime[a.stored_id] = {"id": a.runtime_id, "epoch": a.epoch, "at": a.last_active}
        self.state.mark_dirty()

    def _forget(self, a: Attached) -> None:
        if a.runtime_id and self.by_runtime.get(a.runtime_id) is a:
            del self.by_runtime[a.runtime_id]
        self.by_stored.pop(a.stored_id, None)
        self.state.runtime.pop(a.stored_id, None)
        self.state.last_seq.pop(a.stored_id, None)
        self.state.mark_dirty()

    # --- inbound hermes traffic ----------------------------------------------------------
    def on_event(self, params: dict[str, Any]) -> None:
        sid = params.get("session_id") or ""
        if not sid:
            if params.get("type") == "session.reclaimed":
                p = params.get("payload") or {}
                a = self.by_runtime.get(str(p.get("session_id") or ""))
                if a is not None:
                    log.info("hermes reclaimed %s (%s); re-attach on demand", a.stored_id, p.get("reason"))
                    if self._inflight_for(a.stored_id):
                        self.by_runtime.pop(a.runtime_id or "", None)
                        a.runtime_id = None   # keep watching: a delivery is still open
                    else:
                        self._forget(a)
            return
        a = self.by_runtime.get(sid)
        if a is None:
            return
        if a.replaying:
            a.parked.append(params)
        else:
            self._apply_event(a, params)

    def _apply_event(self, a: Attached, params: dict[str, Any]) -> None:
        seq = params.get("seq")
        if isinstance(seq, int):
            if seq <= a.last_seq:
                return  # already seen (replay overlap)
            self._set_seq(a, seq)
        etype = params.get("type") or ""
        payload = params.get("payload") if isinstance(params.get("payload"), dict) else {}
        a.last_active = time.time()

        if etype == "session.info":
            self._on_info(a, payload)
            return
        if etype == "request.cancel":
            rid = payload.get("id")
            if rid and a.open_requests.pop(rid, None) is not None:
                self.emit(ev("session.request_cancel", stored_id=a.stored_id, request_id=rid,
                             reason=payload.get("reason")))
            return
        if etype == "message.start" and not a.running:
            a.running = True
            self.emit(ev("session.state", stored_id=a.stored_id, running=True))
        out = filter_event(etype, payload)
        if out is None:
            return
        self.emit(ev("session.event", stored_id=a.stored_id, seq=seq, type=etype, payload=out))
        if etype == "message.complete":
            for rid in list(a.open_requests):
                a.open_requests.pop(rid, None)
                self.emit(ev("session.request_cancel", stored_id=a.stored_id, request_id=rid, reason="turn_complete"))
            self._tasks.spawn(self._finish_turn(a.stored_id, payload), name=f"turn-{a.stored_id}")

    def _on_info(self, a: Attached, p: dict[str, Any]) -> None:
        changed: dict[str, Any] = {}
        if "running" in p and bool(p["running"]) != a.running:
            a.running = bool(p["running"])
            changed["running"] = a.running
        title = p.get("title")
        if isinstance(title, str) and title and title != a.title:
            a.title = changed["title"] = title
        cwd = p.get("cwd")
        if isinstance(cwd, str) and cwd and cwd != a.cwd:
            a.cwd = changed["cwd"] = cwd
        key = p.get("session_key")
        if isinstance(key, str) and key and key != a.stored_id:
            self._rotate(a, key)
        if changed:
            changed.setdefault("running", a.running)
            self.emit(ev("session.state", stored_id=a.stored_id, **changed))

    def on_server_request(self, frame: dict[str, Any]) -> None:
        method = frame.get("method")
        if method not in FORWARD_REQUEST_METHODS:
            return  # never answer the others (terminal.read, preview.*, vault.*, ...)
        params = frame.get("params") or {}
        a = self.by_runtime.get(str(params.get("session_id") or ""))
        rid = frame.get("id")
        if a is None or not isinstance(rid, str):
            log.debug("server request %s for unknown session %s ignored", method, params.get("session_id"))
            return
        req = _request_obj(rid, method, params)
        a.open_requests[rid] = req
        self.emit(ev("session.request", stored_id=a.stored_id, request=req))

    # --- turn completion -----------------------------------------------------------------
    def _inflight_for(self, stored_id: str) -> list[str]:
        return [d for d, e in self.state.inflight.items() if e.get("stored_id") == stored_id and "done" not in e]

    async def _finish_turn(self, stored_id: str, payload: dict[str, Any]) -> None:
        pt = payload.get("persisted_turn") if isinstance(payload.get("persisted_turn"), dict) else {}
        user_row_id = pt.get("user_row_id") if isinstance(pt.get("user_row_id"), int) else None
        status = payload.get("status") or "complete"
        if status not in ("complete", "interrupted"):
            status = "error"
        delivery_id = None
        pending = self._inflight_for(stored_id)
        if pending and user_row_id is not None:
            # Fast path: prompt.submit returned this row id for a delivery we submitted while idle.
            delivery_id = next((d for d in pending if self.state.inflight[d].get("user_row_id") == user_row_id), None)
        if pending and delivery_id is None:
            delivery_id = await self._delivery_for_row(stored_id, user_row_id)
        frame = ev("turn.done", stored_id=stored_id, user_row_id=user_row_id, delivery_id=delivery_id,
                   status=status, text=payload.get("text"),
                   partial=bool(status != "complete" or pt.get("complete") is False))
        self._complete_delivery(delivery_id, frame)

    def _complete_delivery(self, delivery_id: str | None, frame: dict) -> None:
        if delivery_id:
            self._recent_done[delivery_id] = frame
            while len(self._recent_done) > RECENT_DONE_MAX:
                self._recent_done.popitem(last=False)
            entry = self.state.inflight.get(delivery_id)
            if entry is not None:
                entry["done"] = frame
                self.state.save_now()
        log.info("turn.done %s status=%s delivery=%s", frame.get("stored_id"), frame.get("status"), delivery_id)
        self.emit_turn_done(frame)

    async def _delivery_for_row(self, stored_id: str, user_row_id: int | None) -> str | None:
        """Read the turn's user row and extract the omni marker."""
        h = self._h()
        rows: list[dict] = []
        try:
            if user_row_id is not None:
                page = await h.rest("GET", f"/api/sessions/{stored_id}/messages/around",
                                    params={"row_id": str(user_row_id), "limit": "5"}, allow_404=True)
                rows = (page or {}).get("messages") or []
                for r in rows:
                    if r.get("id") == user_row_id:
                        return find_marker(to_text(r.get("content")))
            page = await h.rest("GET", f"/api/sessions/{stored_id}/messages",
                                params={"limit": "200", "order": "latest"}, allow_404=True)
            rows = (page or {}).get("messages") or []
        except HermesError as e:
            log.warning("could not read user row for %s: %s", stored_id, e)
            return None
        if user_row_id is not None:
            for r in rows:
                if r.get("id") == user_row_id:
                    return find_marker(to_text(r.get("content")))
        # No row id (or not found): fall back to the newest user row.
        for r in reversed(rows):
            if r.get("role") == "user":
                return find_marker(to_text(r.get("content")))
        return None

    def _lost_candidates(self, stored_id: str, before: float) -> list[str]:
        """Open deliveries of ``stored_id`` submitted before ``before`` (not mid-submit)."""
        return [d for d in self._inflight_for(stored_id)
                if self.state.inflight[d].get("status") != "submitting"
                and float(self.state.inflight[d].get("submitted_at") or 0) < before]

    async def _settle_lost_deliveries(self, stored_id: str, before: float | None = None, missing: bool = False,
                                      candidates: list[str] | None = None) -> None:
        """After a Hermes restart/reap the stream is gone: settle deliveries still marked inflight.

        Considers ``candidates`` (snapshotted by the caller) or else the deliveries submitted before
        ``before``. If the DB shows the marked user row followed by an assistant reply, report it
        as complete; otherwise report status "error" (the turn did not survive).
        """
        if candidates is None:
            candidates = self._lost_candidates(stored_id, before if before is not None else time.time())
        open_ids = set(self._inflight_for(stored_id))
        pending = [d for d in candidates if d in open_ids]
        if not pending:
            return
        rows: list[dict] = []
        if not missing:
            try:
                page = await self._h().rest("GET", f"/api/sessions/{stored_id}/messages",
                                            params={"limit": "300", "order": "latest"}, allow_404=True)
                rows = (page or {}).get("messages") or []
            except HermesError as e:
                log.warning("cannot settle deliveries for %s: %s", stored_id, e)
                return
        # A still-running or queued turn would have shown up as running=True; re-check before settling.
        a = self.by_stored.get(stored_id)
        if a is not None and a.running:
            return
        for did in pending:
            entry = self.state.inflight.get(did)
            if entry is None or "done" in entry:
                continue   # settled meanwhile (turn.done or a concurrent check)
            idx = next((i for i, r in enumerate(rows)
                        if r.get("role") == "user" and find_marker(to_text(r.get("content"))) == did), None)
            text, status, row_id = None, "error", None
            if idx is not None:
                row_id = rows[idx].get("id")
                tail = rows[idx + 1:]
                end = next((i for i, r in enumerate(tail) if r.get("role") == "user"), len(tail))
                replies = [r for r in tail[:end] if r.get("role") == "assistant" and to_text(r.get("content")).strip()]
                if replies:
                    last = replies[-1]
                    text = to_text(last.get("content"))
                    # A clean finish has a finish_reason; Hermes' shutdown note ("Operation interrupted.") has none.
                    status = "complete" if last.get("finish_reason") not in (None, "", "tool_calls") else "interrupted"
            log.warning("settling lost delivery %s on %s as %s", did, stored_id, status)
            frame = ev("turn.done", stored_id=stored_id, user_row_id=row_id, delivery_id=did, status=status,
                       text=text, partial=status != "complete", error=None if status == "complete" else "node_restarted")
            self._complete_delivery(did, frame)

    # --- operations used by hub handlers -------------------------------------------------
    async def call_session(self, stored_id: str, method: str, params: dict[str, Any] | None = None,
                           timeout: float = 30) -> tuple[Attached, dict[str, Any]]:
        """Call a runtime-scoped RPC, auto-attaching and re-resuming once on a stale runtime id."""
        a, _ = await self.attach(stored_id, refresh=False)
        for attempt in (0, 1):
            try:
                res = await self._h().call(method, {"session_id": a.runtime_id, **(params or {})}, timeout=timeout)
                return a, res
            except HermesError as e:
                if e.code in STALE_SESSION_CODES and attempt == 0:
                    log.info("%s: stale runtime id for %s; re-resuming", method, a.stored_id)
                    a.runtime_id = None
                    a, _ = await self.attach(a.stored_id)
                    continue
                raise
        raise AssertionError("unreachable")

    async def attach_result(self, stored_id: str) -> dict[str, Any]:
        a, res = await self.attach(stored_id)
        inflight = res.get("inflight") if isinstance(res.get("inflight"), dict) else None
        if inflight is not None:
            inflight = {k: trim(to_text(inflight.get(k)), 20000) for k in ("user", "assistant") if inflight.get(k)}
        return {"stored_id": a.stored_id, "running": a.running,
                "open_requests": list(a.open_requests.values()), "inflight": inflight or None}

    async def prompt(self, stored_id: str, text: str, mode: str, delivery_id: str | None) -> dict[str, Any]:
        if delivery_id:
            entry = self.state.inflight.get(delivery_id)
            if entry is not None:
                if "done" in entry:
                    self.emit_turn_done(entry["done"])
                status = entry.get("status")
                return {"status": status if status in ("streaming", "queued", "redirected") else "queued",
                        "user_row_id": entry.get("user_row_id"), "duplicate": True}
            done = self._recent_done.get(delivery_id)
            if done is not None:
                self.emit_turn_done(done)
                return {"status": "queued", "duplicate": True}
            self.state.inflight[delivery_id] = {"stored_id": stored_id, "user_row_id": None,
                                                "submitted_at": time.time(), "status": "submitting"}
            self.state.save_now()
        params: dict[str, Any] = {"text": text}
        if mode != "redirect":
            params["queued"] = True
        try:
            a, res = await self.call_session(stored_id, "prompt.submit", params, timeout=60)
        except HermesUnavailable as e:
            if delivery_id and e.sent:
                # Hermes may have accepted the prompt: keep the entry so the turn's message.complete
                # still maps to this delivery, and settle it ourselves if the prompt never shows up.
                self._mark_unconfirmed(delivery_id)
                raise SessionOpError("prompt_unconfirmed",
                                     f"prompt.submit outcome unknown ({e.message}); "
                                     "turn.done will settle the delivery") from e
            self._drop_inflight(delivery_id)
            raise
        except asyncio.CancelledError:
            # Handler cancelled (link shutting down) — the frame may already be out.
            if delivery_id:
                self._mark_unconfirmed(delivery_id, verify=False)
            raise
        except BaseException:
            self._drop_inflight(delivery_id)
            raise
        status = res.get("status") or "queued"
        out: dict[str, Any] = {"status": status}
        if isinstance(res.get("user_row_id"), int):
            out["user_row_id"] = res["user_row_id"]
        if delivery_id:
            entry = self.state.inflight.get(delivery_id)
            if entry is not None:
                entry.update(stored_id=a.stored_id, status=status, user_row_id=out.get("user_row_id"))
                self.state.save_now()
        return out

    def _drop_inflight(self, delivery_id: str | None) -> None:
        """Definitive submit failure: Hermes never got the prompt, forget the delivery."""
        if delivery_id and self.state.inflight.pop(delivery_id, None) is not None:
            self.state.save_now()

    def _mark_unconfirmed(self, delivery_id: str, verify: bool = True) -> None:
        entry = self.state.inflight.get(delivery_id)
        if entry is None or "done" in entry:
            return
        entry["status"] = "unknown"
        self.state.save_now()
        log.warning("delivery %s: prompt.submit outcome unknown; keeping it inflight", delivery_id)
        if verify:
            self._tasks.spawn(self._verify_unconfirmed(delivery_id), name=f"verify-{delivery_id}")

    async def _verify_unconfirmed(self, delivery_id: str) -> None:
        """Decide whether an ambiguous prompt.submit reached Hermes.

        Found the marked user row → the prompt was accepted; its message.complete (or the restart
        settlement) produces the turn.done. Session idle and no marked row on two consecutive
        checks → the prompt was lost: settle the delivery with an error turn.done. A queued prompt
        on a busy session has no row yet, so only idle observations count.
        """
        idle_misses = 0
        give_up = time.time() + UNCONFIRMED_VERIFY_S
        while time.time() < give_up:
            await asyncio.sleep(UNCONFIRMED_CHECK_S)
            entry = self.state.inflight.get(delivery_id)
            if entry is None or "done" in entry or entry.get("status") != "unknown":
                return
            sid = str(entry.get("stored_id") or "")
            try:
                a, _ = await self.attach(sid, refresh=False)
                found = await self._marked_row_exists(a.stored_id, delivery_id)
            except SessionOpError as e:
                log.warning("delivery %s: cannot verify submit (%s); settling as lost", delivery_id, e.message)
                found, a = False, None
            except HermesError as e:
                log.debug("delivery %s: verify deferred: %s", delivery_id, e)
                continue
            entry = self.state.inflight.get(delivery_id)
            if entry is None or "done" in entry:
                return
            if found:
                entry["status"] = "queued"
                self.state.save_now()
                log.info("delivery %s: prompt was accepted by hermes after all", delivery_id)
                return
            if a is not None and a.running:
                idle_misses = 0
                continue
            idle_misses += 1
            if a is not None and idle_misses < 2:
                continue
            log.warning("delivery %s: prompt never reached %s; settling as error", delivery_id, sid)
            self._complete_delivery(delivery_id, ev(
                "turn.done", stored_id=sid, user_row_id=None, delivery_id=delivery_id, status="error",
                text=None, partial=True, error="prompt_not_accepted"))
            return
        log.warning("delivery %s: still unconfirmed after %ds; housekeeping will settle it",
                    delivery_id, UNCONFIRMED_VERIFY_S)

    async def _marked_row_exists(self, stored_id: str, delivery_id: str) -> bool:
        page = await self._h().rest("GET", f"/api/sessions/{stored_id}/messages",
                                    params={"limit": "500", "order": "latest"}, allow_404=True)
        return any(r.get("role") == "user" and find_marker(to_text(r.get("content"))) == delivery_id
                   for r in (page or {}).get("messages") or [])

    async def interrupt(self, stored_id: str) -> None:
        await self.call_session(stored_id, "session.interrupt")

    async def respond(self, stored_id: str, request_id: str, result: dict[str, Any]) -> None:
        a = self.by_stored.get(stored_id)
        if a is None or not a.runtime_id:
            a, _ = await self.attach(stored_id)
        await self._h().respond(request_id, result)
        if a.open_requests.pop(request_id, None) is not None:
            self.emit(ev("session.request_cancel", stored_id=a.stored_id, request_id=request_id, reason="answered"))

    async def ensure_canonical(self, path: str, project_name: str) -> dict[str, Any]:
        title = canonical_title(project_name)
        async with self._lock("ensure:" + path):
            entry = self.state.canonical.get(path)
            if entry and entry.get("stored_id"):
                row = await self._h().rest("GET", f"/api/sessions/{entry['stored_id']}", allow_404=True)
                if row:
                    return {"stored_id": entry["stored_id"], "title": row.get("title") or entry.get("title") or title,
                            "created": False}
                log.info("canonical session %s for %s is gone; recreating", entry["stored_id"], path)
                self.state.drop_canonical(path)
            h = self._h()
            res = await h.call("session.create", {"cwd": path}, timeout=60)
            rid, stored = res.get("session_id"), res.get("stored_session_id")
            if not rid or not stored:
                raise SessionOpError("hermes_error", "session.create returned no ids")
            # Title is the DB-unique key: 4022 names the session that already holds it. Adopt it when it
            # lives in this folder; otherwise (someone reused the title elsewhere) fall back to a
            # path-suffixed title.
            for candidate in (title, f"{title}~{hashlib.sha1(path.encode()).hexdigest()[:4]}"):
                try:
                    await h.call("session.title", {"session_id": rid, "title": candidate})
                except HermesError as e:
                    m = _IN_USE_RE.search(e.message) if e.code == TITLE_IN_USE else None
                    if m is None:
                        await self._close_runtime(rid)
                        raise
                    existing = m.group(1)
                    row = await h.rest("GET", f"/api/sessions/{existing}", allow_404=True)
                    if row and os.path.normpath(row.get("cwd") or "") == path:
                        await self._close_runtime(rid)
                        log.info("canonical title %r already used by %s; adopting it", candidate, existing)
                        self.state.set_canonical(path, existing, candidate)
                        return {"stored_id": existing, "title": candidate, "created": False}
                    log.warning("title %r is used by %s in another folder; trying a suffixed title", candidate, existing)
                    continue
                self._register(Attached(stored_id=stored, cwd=path, title=candidate), rid, h.epoch)
                self.state.set_canonical(path, stored, candidate)
                return {"stored_id": stored, "title": candidate, "created": True}
            await self._close_runtime(rid)
            raise SessionOpError("title_in_use", f"canonical title {title!r} is taken by sessions in other folders")

    async def _close_runtime(self, runtime_id: str) -> None:
        try:
            await self._h().call("session.close", {"session_id": runtime_id})
        except HermesError as e:
            log.debug("session.close %s: %s", runtime_id, e)

    async def create(self, path: str, title: str | None) -> dict[str, Any]:
        h = self._h()
        res = await h.call("session.create", {"cwd": path}, timeout=60)
        rid, stored = res.get("session_id"), res.get("stored_session_id")
        if not rid or not stored:
            raise SessionOpError("hermes_error", "session.create returned no ids")
        final_title = None
        if title:
            for n in range(1, 10):
                candidate = title if n == 1 else f"{title} ({n})"
                try:
                    r = await h.call("session.title", {"session_id": rid, "title": candidate})
                    final_title = r.get("title") or candidate
                    break
                except HermesError as e:
                    if e.code != TITLE_IN_USE:
                        await self._close_runtime(rid)
                        raise
        # Without a title the DB row appears on the first prompt; the runtime stays alive on our socket.
        self._register(Attached(stored_id=stored, cwd=path, title=final_title), rid, h.epoch)
        return {"stored_id": stored, "title": final_title}

    async def rename(self, stored_id: str, title: str) -> None:
        await self._h().rest("PATCH", f"/api/sessions/{stored_id}", json_body={"title": title})
        for entry in self.state.canonical.values():
            if entry.get("stored_id") == stored_id:
                entry["title"] = title
                self.state.mark_dirty()

    async def delete(self, stored_id: str) -> None:
        a = self.by_stored.get(stored_id)
        if a is not None:
            if a.runtime_id:
                await self._close_runtime(a.runtime_id)
            self._forget(a)
        await self._h().rest("DELETE", f"/api/sessions/{stored_id}", allow_404=True)
        for path, entry in list(self.state.canonical.items()):
            if entry.get("stored_id") == stored_id:
                self.state.drop_canonical(path)

    async def messages(self, stored_id: str, limit: int) -> list[dict[str, Any]]:
        """The newest ``limit`` rows (≤ MESSAGES_MAX), ascending. Hermes serves at most
        HERMES_PAGE_MAX rows per request; ``order=latest&offset=N`` pages further back."""
        limit = max(1, min(limit, MESSAGES_MAX))
        rows: list[dict[str, Any]] = []
        offset = 0
        while offset < limit:
            size = min(HERMES_PAGE_MAX, limit - offset)
            page = await self._h().rest("GET", f"/api/sessions/{stored_id}/messages",
                                        params={"limit": str(size), "offset": str(offset), "order": "latest"},
                                        allow_404=True)
            if page is None:
                if offset == 0:
                    raise SessionOpError("not_found", f"session {stored_id} not found")
                break
            batch = page.get("messages") or []
            rows[:0] = batch    # older page goes in front
            if len(batch) < size:
                break
            offset += size
        seen: set[Any] = set()
        out = []
        for r in rows:   # a row appended between page reads can show up twice
            rid = r.get("id")
            if rid is not None and rid in seen:
                continue
            seen.add(rid)
            out.append(map_message(r))
        return out

    async def live_status(self) -> dict[str, str]:
        """stored id → live status (working|waiting|idle) for sessions live in Hermes."""
        try:
            res = await self._h().call("session.active_list", {}, timeout=15)
        except HermesError as e:
            log.debug("active_list failed: %s", e)
            return {}
        out = {}
        for row in res.get("sessions") or []:
            key = row.get("session_key")
            if key:
                out[key] = row.get("status") or "idle"
        return out

    def is_running(self, stored_id: str, live: dict[str, str]) -> bool:
        a = self.by_stored.get(stored_id)
        if a is not None and a.runtime_id:
            return a.running
        return live.get(stored_id) in ("working", "waiting")

    async def fetch_sessions(self, cwd_prefix: str | None, limit: int, max_pages: int = 1) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        params: dict[str, str] = {"limit": str(max(1, min(limit, 100))), "order": "recent", "archived": "exclude"}
        if cwd_prefix:
            params["cwd_prefix"] = cwd_prefix
        for page in range(max_pages):
            params["offset"] = str(page * int(params["limit"]))
            res = await self._h().rest("GET", "/api/sessions", params=params)
            batch = res.get("sessions") or []
            rows.extend(batch)
            if len(batch) < int(params["limit"]):
                break
        return rows

    async def list_sessions(self, path: str | None, limit: int) -> list[dict[str, Any]]:
        rows = await self.fetch_sessions(path, max(limit, 100) if path else limit)
        live = await self.live_status()
        canon = self.canonical_ids()
        out = []
        for r in rows:
            if path and r.get("cwd") != path:
                continue
            sid = r.get("id")
            out.append({"stored_id": sid, "title": r.get("title"), "cwd": r.get("cwd"), "source": r.get("source"),
                        "last_active": r.get("last_activity_at") or r.get("last_active"),
                        "started_at": r.get("started_at"), "message_count": r.get("message_count"),
                        "running": self.is_running(sid, live), "canonical": sid in canon})
            if len(out) >= limit:
                break
        return out

    async def session_cwd(self, stored_id: str) -> str | None:
        a = self.by_stored.get(stored_id)
        if a is not None and a.cwd:
            return a.cwd
        row = await self._h().rest("GET", f"/api/sessions/{stored_id}", allow_404=True)
        return (row or {}).get("cwd")

    async def current_delivery(self, stored_id: str) -> str | None:
        """Delivery id of the turn currently running in ``stored_id`` (marker of the newest user row)."""
        try:
            page = await self._h().rest("GET", f"/api/sessions/{stored_id}/messages",
                                        params={"limit": "50", "order": "latest"}, allow_404=True)
        except HermesError as e:
            log.warning("cannot read messages of %s: %s", stored_id, e)
            return None
        for r in reversed((page or {}).get("messages") or []):
            if r.get("role") == "user":
                return find_marker(to_text(r.get("content")))
        return None
