"""Browser live channel (/ws) and per-session live buffers (design §6, v3 spec §5.6).

The hub keeps, per (node, stored_id), the in-progress turn (text, reasoning tail, tool chips),
the running flag, the open server requests, the last ``session.meta``, the queued prompts and a
``locked`` marker (the session is open in another Hermes window), built from forwarded link events.
A browser `sub` makes the hub call link `session.attach` and then sends a `session.snapshot`;
afterwards events for that session are fanned out to every subscribed browser. Every browser also
gets the session list (`sessions` frames) and the pending requests (`requests`). Each browser has
its own bounded outbound queue so a slow client never stalls the link reader.

Run state is only trusted while the node's link is up: on link-up every buffer of that node is
reset and the sessions browsers watch are re-attached. Watched sessions are also re-attached
every REATTACH_S so the link (which detaches sessions idle for 2h) keeps streaming turns
started elsewhere (dashboard, TUI, cron).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from aiohttp import WSMsgType, web

from omni import __version__
from omni.proto import NODE_ID_RE, STORED_ID_RE, RemoteError, session_key

from .auth import USER_KEY
from .links import LinkManager, NodeUnavailable
from .sessions import row_title

if TYPE_CHECKING:
    from .sessions import SessionIndex

log = logging.getLogger("omni.hub.live")

SessionKey = tuple[str, str]
TEXT_CAP = 400_000          # chars of streamed assistant text kept for snapshots
REASONING_TAIL = 4000
MAX_TOOLS = 50
CLIENT_QUEUE = 2000
NODES_DEBOUNCE_S = 1.0
REQUESTS_DEBOUNCE_S = 0.2
REATTACH_S = 20 * 60        # well below the link's 2h idle detach
ATTACH_TIMEOUT = 30.0


@dataclass
class SessionBuffer:
    running: bool = False
    turn: dict[str, Any] | None = None
    tools: dict[str, dict[str, Any]] = field(default_factory=dict)
    requests: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_seq: int = 0
    meta: dict[str, Any] | None = None
    queue: list[dict[str, Any]] = field(default_factory=list)
    locked: dict[str, Any] | None = None

    def reset_run(self) -> None:
        """Forget the in-progress turn (its end may have been missed while the link was down)."""
        self.running = False
        self.turn = None
        self.tools = {}

    def start_turn(self, text: str = "") -> None:
        self.turn = {"text": text, "reasoning": "", "started_at": time.time()}
        self.tools = {}

    def snapshot_turn(self) -> dict[str, Any] | None:
        if self.turn is None:
            return None
        return {**self.turn, "tools": list(self.tools.values())}


class BrowserClient:
    def __init__(self, ws: web.WebSocketResponse, user: str):
        self.ws = ws
        self.user = user
        self.subs: set[SessionKey] = set()
        self.deliveries = False      # wants raw `delivery` frames (debug)
        self.queue: asyncio.Queue[str | None] = asyncio.Queue(CLIENT_QUEUE)
        self.writer: asyncio.Task[None] | None = None
        self.dead = False

    def put(self, msg: dict[str, Any]) -> None:
        if self.dead:
            return
        try:
            self.queue.put_nowait(json.dumps(msg, ensure_ascii=False))
        except asyncio.QueueFull:
            # It will reconnect and get fresh snapshots; better than unbounded memory.
            log.warning("browser client too slow, disconnecting")
            self.dead = True
            _spawn(self.ws.close(code=1013, message=b"slow consumer"))

    async def write_loop(self) -> None:
        try:
            while True:
                data = await self.queue.get()
                if data is None or self.ws.closed:
                    return
                await self.ws.send_str(data)
        except (ConnectionError, RuntimeError):
            pass


class Live:
    def __init__(self, links: LinkManager, index: "SessionIndex"):
        self.links = links
        self.index = index
        self.clients: set[BrowserClient] = set()
        self.buffers: dict[SessionKey, SessionBuffer] = {}
        self._nodes_timer: asyncio.TimerHandle | None = None
        self._requests_timer: asyncio.TimerHandle | None = None
        self._reattacher: asyncio.Task[None] | None = None

    # --- lifecycle -------------------------------------------------------------------
    def start(self) -> None:
        self._reattacher = asyncio.create_task(self._reattach_loop())

    async def stop(self) -> None:
        if self._reattacher:
            self._reattacher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reattacher

    async def _reattach_loop(self) -> None:
        """Periodically re-attach every watched session on an online node (keeps it attached
        on the link); a snapshot is pushed only when the attach revealed a change."""
        while True:
            await asyncio.sleep(REATTACH_S)
            keys = {k for c in self.clients for k in c.subs if self.links.is_online(k[0])}
            if keys:
                log.debug("re-attaching %d watched session(s)", len(keys))
            for node, sid in sorted(keys):
                try:
                    await self._reattach_one(node, sid)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("periodic re-attach of %s/%s failed", node, sid)

    async def _reattach_one(self, node: str, sid: str) -> None:
        b = self.buf(node, sid)
        before = (b.running, set(b.requests))
        cur, err = await self._attach(node, sid)
        if err:
            log.info("periodic re-attach of %s/%s: %s", node, sid, err)
            return
        nb = self.buffers.get((node, cur))
        if cur != sid or nb is None or before != (nb.running, set(nb.requests)):
            self.publish((node, cur), self.snapshot(node, cur))

    # --- publishing ------------------------------------------------------------------
    def publish_all(self, msg: dict[str, Any]) -> None:
        for c in list(self.clients):
            c.put(msg)

    def publish(self, key: SessionKey, msg: dict[str, Any]) -> None:
        for c in list(self.clients):
            if key in c.subs:
                c.put(msg)

    def publish_delivery(self, d: dict[str, Any]) -> None:
        msg = {"type": "delivery", "delivery": d}
        for c in list(self.clients):
            if c.deliveries:
                c.put(msg)

    def publish_incoming(self, node: str, sid: str, d: dict[str, Any]) -> None:
        """A delivery was just submitted to (node, sid): show it in that session's open chats."""
        from_key = session_key(d["from_node"], d["from_stored"]) if d.get("from_node") and d.get("from_stored") \
            else None
        self.publish((node, sid), {
            "type": "session.incoming", "node": node, "stored_id": sid,
            "delivery": {"id": d["id"], "kind": d["kind"], "from_addr": d.get("from_addr"), "from_key": from_key,
                         "from_title": d.get("from_title") or ("사용자" if from_key is None else None),
                         "message": d.get("message") or "", "expect_reply": bool(d.get("expect_reply")),
                         "at": d.get("dispatched_at") or time.time()}})

    def nodes_changed(self) -> None:
        """Debounced {"type":"nodes"} broadcast."""
        if self._nodes_timer is None:
            self._nodes_timer = asyncio.get_running_loop().call_later(NODES_DEBOUNCE_S, self._flush_nodes)

    def _flush_nodes(self) -> None:
        self._nodes_timer = None
        self.publish_all({"type": "nodes", "nodes": self.links.nodes_json()})

    def _requests_changed(self, node: str | None = None, sid: str | None = None) -> None:
        if node is not None and sid is not None:
            self.index.live_changed(node, sid)
        if self._requests_timer is None:
            self._requests_timer = asyncio.get_running_loop().call_later(REQUESTS_DEBOUNCE_S, self._flush_requests)

    def _flush_requests(self) -> None:
        self._requests_timer = None
        self.publish_all(self.requests_frame())

    def requests_frame(self) -> dict[str, Any]:
        items = self.requests_items()
        return {"type": "requests", "count": len(items), "items": items}

    # --- queries ---------------------------------------------------------------------
    def buf(self, node: str, sid: str) -> SessionBuffer:
        return self.buffers.setdefault((node, sid), SessionBuffer())

    def is_running(self, node: str, sid: str) -> bool:
        b = self.buffers.get((node, sid))
        return bool(b and b.running)

    def requests_items(self) -> list[dict[str, Any]]:
        out = []
        for (node, sid), b in self.buffers.items():
            if not self.links.is_online(node) or not b.requests:
                continue
            row = self.index.get(node, sid) or {}
            for r in b.requests.values():
                out.append({"node": node, "stored_id": sid, "title": row_title(row) if row else sid,
                            "request_id": r.get("request_id"), "method": r.get("method"), "at": r.get("_at")})
        out.sort(key=lambda x: x.get("at") or 0)
        return out

    def requests_list(self) -> list[dict[str, Any]]:
        """GET /api/requests (v2 shape, kept for debugging)."""
        out = []
        for (node, sid), b in sorted(self.buffers.items()):
            if not self.links.is_online(node):
                continue
            for r in b.requests.values():
                out.append({"node": node, "stored_id": sid, "request": _public_request(r)})
        return out

    def snapshot(self, node: str, sid: str) -> dict[str, Any]:
        """Current live state. `seq` is the last event seq folded into it: events with a
        seq <= this are already reflected (0 = unknown, accept everything)."""
        b = self.buf(node, sid)
        return {"type": "session.snapshot", "node": node, "stored_id": sid, "seq": b.last_seq,
                "running": b.running, "turn": b.snapshot_turn(),
                "requests": [_public_request(r) for r in b.requests.values()],
                "meta": b.meta, "queue": b.queue, "locked": b.locked, "online": self.links.is_online(node)}

    def drop_request(self, node: str, sid: str, request_id: str) -> None:
        """Forget a request (e.g. answered through the hub)."""
        b = self.buffers.get((node, sid))
        if b and b.requests.pop(request_id, None) is not None:
            self.publish((node, sid), {"type": "session.request_cancel", "node": node, "stored_id": sid,
                                       "request_id": request_id})
            self._requests_changed(node, sid)

    def set_locked(self, node: str, sid: str, surface: str | None, message: str = "") -> None:
        b = self.buf(node, sid)
        new = {"surface": surface or "다른 창"} if surface is not None else None
        if new == b.locked:
            return
        b.locked = new
        if new is not None:
            self.publish((node, sid), {"type": "session.error", "node": node, "stored_id": sid,
                                       "code": "session_locked", "message": message, "surface": new["surface"]})

    # --- link events -----------------------------------------------------------------
    def on_link_event(self, node: str, f: dict[str, Any]) -> None:
        kind = f["kind"]
        sid = f["stored_id"]
        key = (node, sid)
        b = self.buf(node, sid)
        if kind == "session.event":
            etype = str(f.get("type") or "")
            payload = f.get("payload") if isinstance(f.get("payload"), dict) else {}
            seq = f.get("seq")
            if isinstance(seq, int):
                b.last_seq = seq
            was = b.running
            self._apply_event(b, etype, payload)
            if b.running != was:
                self.index.live_changed(node, sid)
            self.publish(key, {"type": "session.event", "node": node, "stored_id": sid, "seq": seq,
                               "event_type": etype, "payload": payload})
        elif kind == "session.state":
            b.running = bool(f.get("running"))
            if not b.running:
                b.turn = None
            msg = {"type": "session.state", "node": node, "stored_id": sid, "running": b.running}
            for k in ("title", "cwd", "status", "last_turn_status"):
                if k in f:
                    msg[k] = f[k]
            self.publish(key, msg)
            self.index.live_changed(node, sid)
        elif kind == "session.request":
            r = f.get("request")
            if isinstance(r, dict) and r.get("request_id"):
                r = {**r, "_at": time.time()}
                b.requests[str(r["request_id"])] = r
                self.publish(key, {"type": "session.request", "node": node, "stored_id": sid,
                                   "request": _public_request(r)})
                self._requests_changed(node, sid)
        elif kind == "session.request_cancel":
            rid = str(f.get("request_id") or "")
            b.requests.pop(rid, None)
            self.publish(key, {"type": "session.request_cancel", "node": node, "stored_id": sid,
                               "request_id": rid, "reason": f.get("reason")})
            self._requests_changed(node, sid)
        elif kind == "session.meta":
            if isinstance(f.get("meta"), dict):
                b.meta = f["meta"]
                self.publish(key, {"type": "session.meta", "node": node, "stored_id": sid, "meta": b.meta})
        elif kind == "session.queue":
            items = f.get("items") if isinstance(f.get("items"), list) else []
            b.queue = [i for i in items if isinstance(i, dict)]
            msg = {"type": "session.queue", "node": node, "stored_id": sid, "items": b.queue}
            dropped = f.get("dropped")
            if isinstance(dropped, list) and dropped:
                # Queued prompts Hermes dropped and the link could not resubmit: the browser returns
                # the text to the composer (one-off, not part of the snapshot).
                msg["dropped"] = [t for t in dropped if isinstance(t, str)]
            self.publish(key, msg)
        elif kind == "turn.done":
            b.turn = None
            b.tools = {}
            msg = {k: v for k, v in f.items() if k not in ("t", "kind")}
            self.publish(key, {"type": "turn.done", "node": node, **msg})
            if b.requests:   # nothing can still be pending once the turn is over
                b.requests.clear()
                self._requests_changed(node, sid)

    def _apply_event(self, b: SessionBuffer, etype: str, p: dict[str, Any]) -> None:
        if etype == "message.start":
            b.running = True
            b.start_turn()
            return
        if b.turn is None and etype in ("message.delta", "reasoning.delta", "tool.generating",
                                        "tool.start", "tool.complete"):
            b.running = True
            b.start_turn()   # joined mid-turn
        if b.turn is None:
            return
        if etype == "message.delta":
            text = b.turn["text"] + str(p.get("text") or "")
            b.turn["text"] = text[-TEXT_CAP:]
        elif etype == "reasoning.delta":
            b.turn["reasoning"] = (b.turn["reasoning"] + str(p.get("text") or ""))[-REASONING_TAIL:]
        elif etype == "tool.generating":
            name = str(p.get("name") or "tool")
            b.tools.setdefault(f"gen:{name}", {"tool_id": None, "name": name, "state": "generating", "preview": None,
                                               "args": None, "error": None, "duration_s": None})
        elif etype == "tool.start":
            name = str(p.get("name") or "tool")
            b.tools.pop(f"gen:{name}", None)
            tid = str(p.get("tool_id") or f"anon:{len(b.tools)}")
            b.tools[tid] = {"tool_id": tid, "name": name, "state": "running", "preview": None,
                            "args": p.get("args"), "error": None, "duration_s": None, "started_at": time.time()}
        elif etype == "tool.complete":
            tid = str(p.get("tool_id") or "")
            chip = b.tools.get(tid)
            if chip is None:   # no id: complete the oldest running chip with this name
                chip = next((c for c in b.tools.values()
                             if c["name"] == p.get("name") and c["state"] == "running"), None)
            if chip is not None:
                chip["state"] = "error" if p.get("error") else "done"
                chip["preview"] = p.get("result_preview") or p.get("error")
                chip["error"] = p.get("error")
                chip["duration_s"] = p.get("duration_s")
        elif etype == "message.complete":
            text = p.get("text")
            if isinstance(text, str):
                b.turn["text"] = text[-TEXT_CAP:]
        if len(b.tools) > MAX_TOOLS:
            for k in list(b.tools)[: len(b.tools) - MAX_TOOLS]:
                del b.tools[k]

    def on_session_tip(self, node: str, old: str, new: str) -> None:
        """Move live state and subscriptions to the new tip. Idempotent: a repeated notice
        (link event + attach result) changes nothing and is not re-published."""
        ok, nk = (node, old), (node, new)
        moved = ok in self.buffers
        if moved:
            ob = self.buffers.pop(ok)
            self.buffers.setdefault(nk, ob)
        self.index.on_session_tip(node, old, new)
        watchers = [c for c in self.clients if ok in c.subs]
        if not moved and not watchers:
            return
        msg = {"type": "session.tip", "node": node, "old": old, "new": new}
        for c in watchers:
            c.subs.add(nk)
            c.put(msg)
            # Drop the old key so nothing re-attaches the superseded id.
            c.subs.discard(ok)

    def on_link_up(self, node: str) -> None:
        """Fresh link: forget run state we may have missed, then re-attach sessions browsers
        watch (or that had open requests) to rebuild it."""
        for (n, _), b in self.buffers.items():
            if n == node:
                b.reset_run()
                b.last_seq = 0   # the link may have restarted its event stream
        keys = {k for k, b in self.buffers.items() if k[0] == node and b.requests}
        for c in self.clients:
            keys |= {k for k in c.subs if k[0] == node}
        for _, sid in keys:
            _spawn(self._refresh(node, sid))

    async def _refresh(self, node: str, sid: str) -> None:
        cur, _ = await self._attach(node, sid)
        self.publish((node, cur), self.snapshot(node, cur))

    async def _attach(self, node: str, sid: str) -> tuple[str, str | None]:
        """Call link session.attach and fold the result into the buffer.

        Returns (current stored id, error). The link may answer with a newer compression tip;
        that move is applied (deliveries, buffers, subscriptions) before returning it.
        """
        try:
            res = await self.links.call(node, "session.attach", {"stored_id": sid}, timeout=ATTACH_TIMEOUT)
        except RemoteError as e:
            if e.code == "session_locked":
                self.set_locked(node, sid, str(e.extra.get("surface") or "다른 창"), e.message)
            return sid, f"{e.code}: {e.message}"
        except NodeUnavailable as e:
            return sid, str(e)
        except (ConnectionError, TimeoutError):
            return sid, "link did not answer session.attach"
        tip = res.get("stored_id")
        if isinstance(tip, str) and STORED_ID_RE.match(tip) and tip != sid:
            log.info("session %s/%s attached at newer tip %s", node, sid, tip)
            await self.links.on_session_tip(node, sid, tip)
            sid = tip
        b = self.buf(node, sid)
        b.locked = None
        # Snapshots are built right after this without yielding, so this is the seq they carry.
        last_seq = res.get("last_seq")
        b.last_seq = last_seq if isinstance(last_seq, int) and last_seq >= 0 else 0
        b.running = bool(res.get("running"))
        if isinstance(res.get("meta"), dict):
            b.meta = res["meta"]
        if isinstance(res.get("queue"), list):
            b.queue = [i for i in res["queue"] if isinstance(i, dict)]
        reqs = res.get("open_requests") if isinstance(res.get("open_requests"), list) else []
        now = time.time()
        new_reqs = {str(r["request_id"]): {**r, "_at": (b.requests.get(str(r["request_id"])) or {}).get("_at", now)}
                    for r in reqs if isinstance(r, dict) and r.get("request_id")}
        changed = new_reqs.keys() != b.requests.keys()
        b.requests = new_reqs
        if b.running and b.turn is None:
            inflight = res.get("inflight") if isinstance(res.get("inflight"), dict) else {}
            b.start_turn(str(inflight.get("assistant") or "")[-TEXT_CAP:])
        elif not b.running:
            b.turn = None
            b.tools = {}
        if changed:
            self._requests_changed(node, sid)
        return sid, None

    # --- /ws endpoint ----------------------------------------------------------------
    async def handle(self, request: web.Request) -> web.StreamResponse:
        ws = web.WebSocketResponse(heartbeat=30, max_msg_size=1024 * 1024)
        await ws.prepare(request)
        client = BrowserClient(ws, request[USER_KEY])
        client.writer = asyncio.create_task(client.write_loop())
        self.clients.add(client)
        client.put({"type": "hello", "user": client.user, "hub_version": __version__})
        client.put({"type": "nodes", "nodes": self.links.nodes_json()})
        client.put(self.index.full_frame())
        client.put(self.requests_frame())
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    if msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                        break
                    continue
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    client.put({"type": "error", "message": "invalid JSON"})
                    continue
                if isinstance(data, dict):
                    self._on_client_op(client, data)
        finally:
            self.clients.discard(client)
            client.dead = True
            if client.writer:
                client.writer.cancel()
        return ws

    def _on_client_op(self, client: BrowserClient, data: dict[str, Any]) -> None:
        op = data.get("op")
        if op == "ping":
            client.put({"type": "pong"})
            return
        if op == "resync":
            client.put({"type": "nodes", "nodes": self.links.nodes_json()})
            client.put(self.index.full_frame())
            client.put(self.requests_frame())
            return
        if op == "sub_deliveries":
            client.deliveries = True
            return
        if op in ("sub", "unsub"):
            node, sid = data.get("node"), data.get("stored_id")
            if not (isinstance(node, str) and NODE_ID_RE.match(node)
                    and isinstance(sid, str) and STORED_ID_RE.match(sid)):
                client.put({"type": "error", "message": "sub/unsub need node and stored_id"})
                return
            key = (node, sid)
            if op == "unsub":
                client.subs.discard(key)
                return
            client.subs.add(key)
            _spawn(self._subscribe(client, node, sid))
            return
        client.put({"type": "error", "message": f"unknown op {op!r}"})

    async def _subscribe(self, client: BrowserClient, node: str, sid: str) -> None:
        cur, err = await self._attach(node, sid) if self.links.is_online(node) else (sid, None)
        if (node, cur) not in client.subs:
            return   # unsubscribed meanwhile
        snap = self.snapshot(node, cur)
        if err:
            snap["error"] = err
            if not err.startswith("session_locked"):
                client.put({"type": "session.error", "node": node, "stored_id": cur, "code": "attach_failed",
                            "message": err})
        elif not self.links.is_online(node):
            client.put({"type": "session.error", "node": node, "stored_id": cur, "code": "node_offline",
                        "message": f"{node} is offline"})
        client.put(snap)

    async def close_all(self) -> None:
        for c in list(self.clients):
            with contextlib.suppress(Exception):
                await c.ws.close(code=1001, message=b"hub shutting down")


def _public_request(r: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in r.items() if k != "_at"}
    out["at"] = r.get("_at")
    return out


_TASKS: set[asyncio.Task[Any]] = set()


def _spawn(coro: Any) -> None:
    t = asyncio.create_task(coro)
    _TASKS.add(t)
    t.add_done_callback(_TASKS.discard)
