"""Link connections: the hub side of the link <-> hub WebSocket protocol (design §5).

One `LinkConnection` per connected node. A new connection for a node id replaces the old one
(closed with code 4000). Requests in either direction are correlated by id; link->hub requests
run as tasks so a long `agent.send wait=true` never blocks the reader. A node is marked offline
when its socket closes or nothing has been received for OFFLINE_AFTER seconds.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import itertools
import json
import logging
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from aiohttp import WSMsgType, web

from omni import PROTO, __version__
from omni.proto import (HEADER_NODE, HEADER_PROTO, NODE_ID_RE, OFFLINE_AFTER, PING_INTERVAL,
                        RemoteError, req, res_err, res_ok)

from .store import Store

if TYPE_CHECKING:
    from .live import Live
    from .router import Router

log = logging.getLogger("omni.hub.links")

HELLO_TIMEOUT = 15.0
DEFAULT_CALL_TIMEOUT = 30.0
CLOSE_REPLACED = 4000
CLOSE_TIMEOUT = 4001
CLOSE_PROTOCOL = 4002
MAX_MSG = 32 * 1024 * 1024


class NodeUnavailable(Exception):
    """The node is unknown (known=False) or currently offline (known=True)."""

    def __init__(self, node_id: str, known: bool):
        super().__init__(f"node {node_id} is {'offline' if known else 'unknown'}")
        self.node_id = node_id
        self.known = known


@dataclass
class NodeState:
    node_id: str
    info: dict[str, Any] = field(default_factory=dict)
    online: bool = False
    last_seen: float | None = None
    first_seen: float | None = None

    def to_json(self) -> dict[str, Any]:
        out = dict(self.info)
        out["node_id"] = self.node_id
        out.setdefault("display_name", self.node_id)
        out.setdefault("projects", [])
        out["online"] = self.online
        out["last_seen"] = self.last_seen
        return out

    def find_project(self, name: str | None = None, path: str | None = None) -> dict[str, Any] | None:
        for p in self.info.get("projects") or []:
            if not isinstance(p, dict):
                continue
            if name is not None and p.get("name") == name:
                return p
            if path is not None and p.get("path") == path:
                return p
        return None


class LinkConnection:
    def __init__(self, node_id: str, ws: web.WebSocketResponse, remote: str | None):
        self.node_id = node_id
        self.ws = ws
        self.remote = remote
        self.connected_at = time.time()
        self.last_rx = time.monotonic()
        self.closed = False
        self._ids = itertools.count(1)
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._send_lock = asyncio.Lock()
        self.tasks: set[asyncio.Task[Any]] = set()

    async def send(self, frame: dict[str, Any]) -> None:
        if self.closed or self.ws.closed:
            raise ConnectionError(f"link {self.node_id} closed")
        async with self._send_lock:
            await self.ws.send_str(json.dumps(frame, ensure_ascii=False))

    async def call(self, method: str, params: dict[str, Any] | None = None,
                   timeout: float = DEFAULT_CALL_TIMEOUT) -> dict[str, Any]:
        """Send a hub->link request and wait for its result. Raises RemoteError,
        ConnectionError (link went away) or TimeoutError."""
        rid = f"h{next(self._ids)}"
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            await self.send(req(rid, method, params or {}))
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(rid, None)

    def resolve(self, frame: dict[str, Any]) -> None:
        fut = self._pending.get(str(frame.get("id")))
        if fut is None or fut.done():
            return
        if frame.get("ok"):
            result = frame.get("result")
            fut.set_result(result if isinstance(result, dict) else {})
        else:
            err = frame.get("error") or {}
            fut.set_exception(RemoteError(str(err.get("code", "error")), str(err.get("message", ""))))

    def spawn(self, coro: Any) -> None:
        t = asyncio.create_task(coro)
        self.tasks.add(t)
        t.add_done_callback(self.tasks.discard)

    async def close(self, code: int, message: str) -> None:
        self.closed = True
        with contextlib.suppress(Exception):
            await self.ws.close(code=code, message=message.encode())

    def shutdown(self) -> None:
        """Fail pending calls and cancel request handlers (called once the socket is gone)."""
        self.closed = True
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(ConnectionError(f"link {self.node_id} disconnected"))
        self._pending.clear()
        for t in list(self.tasks):
            t.cancel()


class LinkManager:
    def __init__(self, store: Store, join_token: str):
        self.store = store
        self.join_token = join_token
        self.nodes: dict[str, NodeState] = {}
        self.conns: dict[str, LinkConnection] = {}
        # Wired by the server after construction.
        self.router: Router
        self.live: Live
        self._watchdog: asyncio.Task[None] | None = None

    # --- lifecycle -------------------------------------------------------------------
    async def start(self) -> None:
        await self.store.run(self.store.mark_all_offline)
        for n in await self.store.run(self.store.load_nodes):
            self.nodes[n["node_id"]] = NodeState(n["node_id"], n["info"], False, n["last_seen"], n["first_seen"])
        self._watchdog = asyncio.create_task(self._watch())

    async def stop(self) -> None:
        if self._watchdog:
            self._watchdog.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._watchdog
        for conn in list(self.conns.values()):
            await conn.close(1001, "hub shutting down")

    async def _watch(self) -> None:
        """Close links that went silent (the close handler then marks them offline)."""
        while True:
            await asyncio.sleep(10)
            now = time.monotonic()
            for conn in list(self.conns.values()):
                if now - conn.last_rx > OFFLINE_AFTER:
                    log.warning("node %s silent for %.0fs, dropping", conn.node_id, now - conn.last_rx)
                    conn.last_rx = now  # don't re-trigger while the close is in progress
                    _background(conn.close(CLOSE_TIMEOUT, "timeout"))

    # --- queries ---------------------------------------------------------------------
    def is_online(self, node_id: str) -> bool:
        return node_id in self.conns

    def get(self, node_id: str) -> LinkConnection | None:
        return self.conns.get(node_id)

    def nodes_json(self) -> list[dict[str, Any]]:
        return [self.nodes[k].to_json() for k in sorted(self.nodes)]

    async def forget(self, node_id: str) -> bool:
        """Remove an offline node from the registry. Returns False if it is unknown.

        Raises RuntimeError if the node is currently connected (it would just re-register).
        """
        if node_id in self.conns:
            raise RuntimeError("node is online")
        if node_id not in self.nodes:
            return False
        del self.nodes[node_id]
        await self.store.run(self.store.delete_node, node_id)
        log.info("node %s forgotten", node_id)
        self.live.nodes_changed()
        return True

    async def call(self, node_id: str, method: str, params: dict[str, Any] | None = None,
                   timeout: float = DEFAULT_CALL_TIMEOUT) -> dict[str, Any]:
        conn = self.conns.get(node_id)
        if conn is None:
            raise NodeUnavailable(node_id, node_id in self.nodes)
        return await conn.call(method, params, timeout)

    async def on_session_tip(self, node_id: str, old: str, new: str) -> None:
        """A stored session moved to a new compression tip: retarget deliveries and live state.

        Reached from the link's `session.tip` event and from `session.attach` results whose
        stored_id differs from the requested one; both handlers are idempotent, so seeing the
        same move twice (event + attach result) is harmless.
        """
        if old and new and old != new:
            await self.router.on_session_tip(node_id, old, new)
            self.live.on_session_tip(node_id, old, new)

    async def update_info(self, node_id: str, **changes: Any) -> None:
        """Patch a node's cached NodeInfo (e.g. after a hub-initiated rescan)."""
        st = self.nodes.get(node_id)
        if st is None:
            return
        st.info.update(changes)
        await self.store.run(self.store.upsert_node, node_id, st.info, st.online, st.last_seen or time.time())
        self.live.nodes_changed()

    # --- /link endpoint --------------------------------------------------------------
    async def handle(self, request: web.Request) -> web.StreamResponse:
        authz = request.headers.get("Authorization", "")
        token = authz[7:].strip() if authz.lower().startswith("bearer ") else ""
        if not token or not hmac.compare_digest(token.encode(), self.join_token.encode()):
            log.warning("link auth failed from %s", request.remote)
            return web.json_response({"error": "bad join token"}, status=401)
        node_id = (request.headers.get(HEADER_NODE) or "").strip().lower()
        if not NODE_ID_RE.match(node_id):
            return web.json_response({"error": f"bad or missing {HEADER_NODE}"}, status=400)
        proto = request.headers.get(HEADER_PROTO, "")
        if proto != str(PROTO):
            return web.json_response(
                {"error": f"protocol mismatch: hub speaks proto {PROTO}, link sent {proto or 'none'}; "
                          "update hermes-omni on this node (git pull && ./setup.sh)"}, status=426)

        ws = web.WebSocketResponse(heartbeat=None, max_msg_size=MAX_MSG, autoping=True)
        await ws.prepare(request)
        conn = LinkConnection(node_id, ws, request.remote)
        try:
            hello = await self._read_hello(conn)
            if hello is None:
                return ws
            await self._register(conn, hello)
            pinger = asyncio.create_task(self._ping(conn))
            try:
                await self._read_loop(conn)
            finally:
                pinger.cancel()
        finally:
            conn.shutdown()
            await self._unregister(conn)
        return ws

    async def _read_hello(self, conn: LinkConnection) -> dict[str, Any] | None:
        try:
            msg = await conn.ws.receive(timeout=HELLO_TIMEOUT)
        except TimeoutError:
            await conn.close(CLOSE_PROTOCOL, "hello timeout")
            return None
        frame = _parse(msg)
        if not frame or frame.get("t") != "hello" or not isinstance(frame.get("node"), dict):
            await conn.close(CLOSE_PROTOCOL, "expected hello")
            return None
        return frame

    async def _register(self, conn: LinkConnection, hello: dict[str, Any]) -> None:
        node_id = conn.node_id
        old = self.conns.get(node_id)
        if old is not None:
            log.info("node %s reconnected from %s, replacing old link", node_id, conn.remote)
            self.conns.pop(node_id, None)
            old.shutdown()
            # Don't await the close handshake: a dead peer would stall this registration.
            _background(old.close(CLOSE_REPLACED, "replaced by a newer connection"))
        now = time.time()
        st = self.nodes.get(node_id) or NodeState(node_id, first_seen=now)
        st.info = _clean_info(node_id, hello["node"])
        st.online = True
        st.last_seen = now
        self.nodes[node_id] = st
        await self.store.run(self.store.upsert_node, node_id, st.info, True, now)
        await conn.send({"t": "welcome", "hub_version": __version__, "proto": PROTO})
        inflight = [str(x) for x in hello.get("inflight") or [] if isinstance(x, str | int)]
        # Reconcile before the node becomes visible to the dispatcher.
        await self.router.on_hello(node_id, inflight)
        self.conns[node_id] = conn
        log.info("node %s online (%s, %d projects, %d inflight)", node_id, conn.remote,
                 len(st.info.get("projects") or []), len(inflight))
        self.live.nodes_changed()
        self.live.on_link_up(node_id)
        self.router.kick()

    async def _unregister(self, conn: LinkConnection) -> None:
        if self.conns.get(conn.node_id) is not conn:
            return  # never registered, or already replaced
        del self.conns[conn.node_id]
        st = self.nodes.get(conn.node_id)
        now = time.time()
        if st:
            st.online = False
            st.last_seen = now
        await self.store.run(self.store.set_node_online, conn.node_id, False, now)
        log.info("node %s offline", conn.node_id)
        self.live.nodes_changed()

    async def _ping(self, conn: LinkConnection) -> None:
        while not conn.closed:
            await asyncio.sleep(PING_INTERVAL)
            try:
                await conn.send({"t": "ping"})
            except (ConnectionError, RuntimeError):
                return

    async def _read_loop(self, conn: LinkConnection) -> None:
        async for msg in conn.ws:
            if msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED, WSMsgType.ERROR):
                break
            conn.last_rx = time.monotonic()
            frame = _parse(msg)
            if frame is None:
                continue
            t = frame.get("t")
            try:
                if t == "ev":
                    await self._on_event(conn, frame)
                elif t == "res":
                    conn.resolve(frame)
                elif t == "req":
                    conn.spawn(self._serve_request(conn, frame))
                elif t == "node":
                    await self._on_node(conn, frame)
                elif t == "ping":
                    await conn.send({"t": "pong"})
                elif t == "pong":
                    pass
                else:
                    log.debug("node %s: ignoring frame type %r", conn.node_id, t)
            except ConnectionError:
                break
            except Exception:
                log.exception("node %s: error handling %s frame", conn.node_id, t)

    async def _on_node(self, conn: LinkConnection, frame: dict[str, Any]) -> None:
        info = frame.get("node")
        if not isinstance(info, dict):
            return
        st = self.nodes[conn.node_id]
        new = _clean_info(conn.node_id, info)
        st.last_seen = time.time()
        changed = new != st.info
        st.info = new
        await self.store.run(self.store.upsert_node, conn.node_id, st.info, True, st.last_seen)
        if changed:
            self.live.nodes_changed()

    async def _on_event(self, conn: LinkConnection, frame: dict[str, Any]) -> None:
        node = conn.node_id
        kind = frame.get("kind")
        if kind == "session.tip":
            old, new = frame.get("old"), frame.get("new")
            if isinstance(old, str) and isinstance(new, str):
                await self.on_session_tip(node, old, new)
            return
        if kind not in ("session.event", "session.state", "session.request",
                        "session.request_cancel", "turn.done"):
            log.debug("node %s: unknown event kind %r", node, kind)
            return
        if not isinstance(frame.get("stored_id"), str):
            return
        self.live.on_link_event(node, frame)
        if kind == "turn.done":
            await self.router.on_turn_done(node, frame)

    async def _serve_request(self, conn: LinkConnection, frame: dict[str, Any]) -> None:
        rid = str(frame.get("id"))
        method = str(frame.get("method"))
        params = frame.get("params") if isinstance(frame.get("params"), dict) else {}
        try:
            result = await self.router.handle_link_request(conn.node_id, method, params)
            reply = res_ok(rid, result)
        except RemoteError as e:
            reply = res_err(rid, e.code, e.message)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("node %s: %s failed", conn.node_id, method)
            reply = res_err(rid, "internal", f"{type(e).__name__}: {e}")
        with contextlib.suppress(ConnectionError, RuntimeError):
            await conn.send(reply)


_BACKGROUND: set[asyncio.Task[Any]] = set()


def _background(coro: Any) -> None:
    """Fire-and-forget with a strong reference (asyncio only keeps weak refs to tasks)."""
    t = asyncio.create_task(coro)
    _BACKGROUND.add(t)
    t.add_done_callback(_BACKGROUND.discard)


def _parse(msg: Any) -> dict[str, Any] | None:
    if msg.type != WSMsgType.TEXT:
        return None
    try:
        frame = json.loads(msg.data)
    except ValueError:
        return None
    return frame if isinstance(frame, dict) else None


def _clean_info(node_id: str, info: dict[str, Any]) -> dict[str, Any]:
    out = dict(info)
    out["node_id"] = node_id   # the authenticated header wins over the payload
    if not isinstance(out.get("projects"), list):
        out["projects"] = []
    out.pop("online", None)
    out.pop("last_seen", None)
    return out
