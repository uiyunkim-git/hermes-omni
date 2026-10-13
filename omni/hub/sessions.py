"""The hub's session index: every session row of every node (v3 spec §5.3).

Links push their rows (``sessions.update``); the hub keeps them in memory and in ``node_sessions``
so offline nodes stay listed (``node_online:false``). Browser rows (HubRow) add node fields, the
live open-request count and ``collab`` (an agent conversation in flight, from active deliveries).
Changes reach browsers as ``sessions`` frames, batched every BATCH_S.

Proto-1 links have no ``sessions.update``: their rows are polled with ``sessions.list``.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import TYPE_CHECKING, Any

from omni.proto import RemoteError, session_key

from .links import LinkManager, NodeUnavailable
from .store import ACTIVE_STATUSES, Store

if TYPE_CHECKING:
    from .live import Live

log = logging.getLogger("omni.hub.sessions")

BATCH_S = 0.3
LEGACY_POLL_S = 30.0
MENTION_TITLE_MAX = 60

Key = tuple[str, str]


def row_title(row: dict[str, Any]) -> str:
    """Display title: title, else the first prompt's first line, else "새 세션"."""
    t = row.get("title")
    if isinstance(t, str) and t.strip():
        return t.strip()
    fp = row.get("first_prompt")
    if isinstance(fp, str) and fp.strip():
        line = fp.strip().splitlines()[0]
        return line if len(line) <= MENTION_TITLE_MAX else line[: MENTION_TITLE_MAX - 1] + "…"
    return "새 세션"


def _legacy_row(r: dict[str, Any]) -> dict[str, Any]:
    """A proto-1 (v2 link) sessions.list row in the v3 Row shape."""
    running = bool(r.get("running"))
    return {"stored_id": r.get("stored_id"), "title": r.get("title"), "cwd": r.get("cwd"), "folder": None,
            "source": r.get("source"), "hidden": False, "pinned": False, "started_at": r.get("started_at"),
            "last_active": r.get("last_active"), "message_count": r.get("message_count"), "running": running,
            "status": "working" if running else "idle", "pending_requests": 0, "last_turn_status": None,
            "preview": None, "activity": None, "first_prompt": None, "draft": False}


def score(row: dict[str, Any], q: str, node_name: str = "") -> int:
    """Relevance of ``row`` for a free-text query (0 = no match). Used by the @mention picker,
    target suggestions and title resolution."""
    ql = q.strip().lower()
    if not ql:
        return 1
    title = row_title(row).lower()
    if title == ql:
        return 100
    if title.startswith(ql):
        return 80
    if any(w.startswith(ql) for w in title.split()):
        return 60
    if ql in title:
        return 40
    sid = str(row.get("stored_id") or "").lower()
    if sid.startswith(ql):
        return 30
    folder = ((row.get("folder") or {}).get("name") or "").lower()
    if folder and ql in folder:
        return 20
    if node_name and node_name.lower().startswith(ql):
        return 15
    fp = (row.get("first_prompt") or "").lower()
    if ql in fp:
        return 10
    return 0


class SessionIndex:
    def __init__(self, store: Store, links: "LinkManager"):
        self.store = store
        self.links = links
        self.live: "Live"   # wired by the server
        self.rows: dict[str, dict[str, dict[str, Any]]] = {}       # node -> sid -> link row
        self.collab: dict[Key, dict[str, Any]] = {}
        self._dirty: set[Key] = set()
        self._removed: set[Key] = set()
        self._timer: asyncio.TimerHandle | None = None
        self._legacy_task: asyncio.Task[None] | None = None
        self._collab_task: asyncio.Task[None] | None = None
        self._collab_again = False

    # --- lifecycle -------------------------------------------------------------------
    async def start(self) -> None:
        for node, sid, row in await self.store.run(self.store.load_node_sessions):
            self.rows.setdefault(node, {})[sid] = row
        await self._recompute_collab()
        self._legacy_task = asyncio.create_task(self._legacy_loop())

    async def stop(self) -> None:
        for t in (self._legacy_task, self._collab_task):
            if t:
                t.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await t

    # --- link input ------------------------------------------------------------------
    async def on_update(self, node: str, full: bool, upsert: list[Any], remove: list[Any]) -> None:
        rows = [r for r in upsert if isinstance(r, dict) and isinstance(r.get("stored_id"), str)]
        gone = [s for s in remove if isinstance(s, str)]
        cur = self.rows.setdefault(node, {})
        if full:
            keep = {r["stored_id"] for r in rows}
            gone += [sid for sid in cur if sid not in keep]
        for sid in gone:
            if cur.pop(sid, None) is not None:
                self._mark_removed((node, sid))
        for r in rows:
            cur[r["stored_id"]] = r
            self._mark((node, r["stored_id"]))
        if full:
            await self.store.run(self.store.replace_node_sessions, node, rows)
        else:
            await self.store.run(self.store.upsert_node_sessions, node, rows, gone)

    def node_changed(self, node: str) -> None:
        """Online state or display name of a node changed: its rows' node fields changed."""
        for sid in self.rows.get(node, {}):
            self._mark((node, sid))

    def live_changed(self, node: str, sid: str) -> None:
        if sid in self.rows.get(node, {}):
            self._mark((node, sid))

    async def forget_node(self, node: str) -> None:
        for sid in list(self.rows.pop(node, {})):
            self._mark_removed((node, sid))

    def on_session_tip(self, node: str, old: str, new: str) -> None:
        cur = self.rows.get(node, {})
        row = cur.pop(old, None)
        if row is not None:
            self._mark_removed((node, old))
            if new not in cur:
                cur[new] = {**row, "stored_id": new}
                self._mark((node, new))
        self.deliveries_changed()

    # --- queries ---------------------------------------------------------------------
    def get(self, node: str, sid: str) -> dict[str, Any] | None:
        return self.rows.get(node, {}).get(sid)

    def all_rows(self) -> list[tuple[str, dict[str, Any]]]:
        return [(node, r) for node, rows in self.rows.items() for r in rows.values()]

    def node_name(self, node: str) -> str:
        st = self.links.nodes.get(node)
        return str((st.info.get("display_name") if st else None) or node)

    def hub_row(self, node: str, row: dict[str, Any]) -> dict[str, Any]:
        sid = row["stored_id"]
        out = dict(row)
        live = self.live.buffers.get((node, sid)) if hasattr(self, "live") else None
        live_n = len(live.requests) if live else 0
        link_n = row.get("pending_requests")
        out["pending_requests"] = (max(link_n, live_n) if isinstance(link_n, int)
                                   else (live_n if live_n else None))
        if live_n and not out.get("running"):
            out["running"], out["status"] = True, "waiting"
        online = self.links.is_online(node)
        out.update(node=node, node_name=self.node_name(node), node_online=online, key=session_key(node, sid),
                   address=session_key(node, sid), collab=self.collab.get((node, sid)))
        if not online:
            out.update(running=False, status="offline", activity=None)
        return out

    @staticmethod
    def needs_you(row: dict[str, Any]) -> bool:
        pr = row.get("pending_requests")
        return (isinstance(pr, int) and pr > 0) or (pr is None and row.get("status") == "waiting")

    def hub_rows(self, node: str | None = None, folder: str | None = None) -> list[dict[str, Any]]:
        out = []
        for n, r in self.all_rows():
            if node and n != node:
                continue
            if folder and (r.get("folder") or {}).get("path") != folder and not (
                    r.get("cwd") and (r["cwd"] == folder or r["cwd"].startswith(folder.rstrip("/") + "/"))):
                continue
            hr = self.hub_row(n, r)
            # Hermes-internal hidden sessions (e.g. the Bot Mode "Bot Chat") stay out of the list
            # unless they need the user right now.
            if r.get("hidden") and not hr.get("running") and not hr.get("pending_requests"):
                continue
            out.append(hr)
        out.sort(key=lambda r: r.get("last_active") or 0, reverse=True)
        return out

    def attention(self, rows: list[dict[str, Any]] | None = None) -> int:
        rows = rows if rows is not None else self.hub_rows()
        return sum(1 for r in rows if r.get("node_online") and self.needs_you(r))

    def search(self, q: str, node: str | None = None, limit: int = 8, exclude: Key | None = None,
               include_hidden: bool = True) -> list[dict[str, Any]]:
        scored = []
        for n, r in self.all_rows():
            if node and n != node:
                continue
            if exclude and (n, r["stored_id"]) == exclude:
                continue
            if not include_hidden and r.get("hidden"):
                continue
            s = score(r, q, self.node_name(n))
            if s > 0:
                scored.append((s, r.get("last_active") or 0, n, r))
        scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
        out = []
        for _, _, n, r in scored[:limit]:
            hr = self.hub_row(n, r)
            hr["mention"] = f"@{row_title(r)} ({hr['key']})"
            out.append(hr)
        return out

    def folder_stats(self, node: str) -> dict[str, tuple[int, float | None]]:
        out: dict[str, tuple[int, float | None]] = {}
        for r in self.rows.get(node, {}).values():
            f = r.get("folder")
            if not f:
                continue
            n, la = out.get(f["path"], (0, None))
            cur = r.get("last_active")
            out[f["path"]] = (n + 1, max(la or 0, cur or 0) or None)
        return out

    # --- collab ----------------------------------------------------------------------
    def deliveries_changed(self) -> None:
        """Recompute ``collab`` from active deliveries (coalesced)."""
        if self._collab_task is not None and not self._collab_task.done():
            self._collab_again = True
            return
        self._collab_task = asyncio.create_task(self._collab_runner())

    async def _collab_runner(self) -> None:
        while True:
            self._collab_again = False
            try:
                await self._recompute_collab()
            except Exception:  # noqa: BLE001
                log.exception("collab recompute failed")
            if not self._collab_again:
                return

    async def _recompute_collab(self) -> None:
        active = []
        for status in ACTIVE_STATUSES:
            active += await self.store.run(self.store.deliveries_by_status, status)
        new: dict[Key, dict[str, Any]] = {}
        for d in active:
            if d["kind"] != "message" or not d.get("to_stored"):
                continue
            to_k: Key = (d["to_node"], d["to_stored"])
            from_k: Key | None = (d["from_node"], d["from_stored"]) if d.get("from_node") and d.get("from_stored") \
                else None
            new[to_k] = {"peer_key": session_key(*from_k) if from_k else None,
                         "peer_title": d.get("from_title") or ("사용자" if from_k is None else from_k[1]),
                         "direction": "in"}
            if from_k and d.get("expect_reply"):
                new.setdefault(from_k, {"peer_key": session_key(*to_k),
                                        "peer_title": d.get("to_title") or self._title_of(to_k),
                                        "direction": "out"})
        for k in set(new) | set(self.collab):
            if new.get(k) != self.collab.get(k):
                self._mark(k)
        self.collab = new

    def _title_of(self, k: Key) -> str:
        row = self.get(*k)
        return row_title(row) if row else k[1]

    # --- browser publishing ----------------------------------------------------------
    def _mark(self, k: Key) -> None:
        self._removed.discard(k)
        self._dirty.add(k)
        self._schedule()

    def _mark_removed(self, k: Key) -> None:
        self._dirty.discard(k)
        self._removed.add(k)
        self._schedule()

    def _schedule(self) -> None:
        if self._timer is None:
            self._timer = asyncio.get_running_loop().call_later(BATCH_S, self._flush)

    def _flush(self) -> None:
        self._timer = None
        dirty, removed = self._dirty, self._removed
        self._dirty, self._removed = set(), set()
        upsert = []
        for node, sid in dirty:
            row = self.get(node, sid)
            if row is not None:
                upsert.append(self.hub_row(node, row))
        rm = [{"node": n, "stored_id": s} for n, s in removed]
        if upsert or rm:
            self.live.publish_all({"type": "sessions", "full": False, "upsert": upsert, "remove": rm})

    def full_frame(self) -> dict[str, Any]:
        return {"type": "sessions", "full": True, "sessions": self.hub_rows()}

    # --- proto-1 links ---------------------------------------------------------------
    async def _legacy_loop(self) -> None:
        while True:
            await asyncio.sleep(LEGACY_POLL_S)
            for node in [n for n, c in self.links.conns.items() if c.proto < 2]:
                await self.poll_legacy(node)

    async def poll_legacy(self, node: str) -> None:
        try:
            res = await self.links.call(node, "sessions.list", {"limit": 500}, timeout=30)
        except (RemoteError, NodeUnavailable, ConnectionError, TimeoutError) as e:
            log.info("legacy sessions.list on %s failed: %s", node, e)
            return
        rows = [_legacy_row(r) for r in res.get("sessions") or [] if isinstance(r, dict)
                and isinstance(r.get("stored_id"), str)]
        await self.on_update(node, True, rows, [])
