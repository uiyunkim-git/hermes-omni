"""Outbound WebSocket to the hub (design §5): hello/welcome, req/res both ways, ev, ping/pong.

Reconnects forever with jittered backoff (the hub may not exist yet, Tailscale may still be
waiting for approval). Optional SOCKS5 proxy (Tailscale userspace sidecar) via aiohttp_socks.
Outbound frames go through one queue per connection so ordering is preserved. An item may carry
an ``on_acked`` callback (used to retire delivery turn.done frames): it runs once the hub has
provably processed the frame. The hub handles a link's frames strictly in order and answers each
ping inline, so the pong for a ping written after the frame is that proof; the writer sends such
a probe ping as soon as its queue drains.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import time
from collections import deque
from typing import Any, Awaitable, Callable

import aiohttp

from omni import PROTO
from omni.proto import (HEADER_NODE, HEADER_PROTO, LINK_PATH, OFFLINE_AFTER, PING_INTERVAL, RemoteError,
                        req, res_err, res_ok)
from omni.link.config import Config
from omni.link.util import Backoff, TaskSet

log = logging.getLogger("omni.link.hub")

QUEUE_MAX = 20000
WELCOME_TIMEOUT = 20
CLOSE_REPLACED = 4000     # hub: a newer connection registered our node id
REPLACED_BACKOFF_S = 90   # another link with our node id took over: back off hard


class HubUnavailable(Exception):
    pass


class HandlerError(Exception):
    """Raised by request handlers to answer with a specific error code (+ extra error fields)."""

    def __init__(self, code: str, message: str, **extra: Any):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.extra = extra


Handler = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


class HubConnection:
    def __init__(self, cfg: Config, build_hello: Callable[[], Awaitable[dict[str, Any]]],
                 handle_request: Handler, on_welcome: Callable[[], Awaitable[None]],
                 on_status: Callable[[bool], None]):
        self.cfg = cfg
        self.url = cfg.hub_url + LINK_PATH
        self.build_hello = build_hello
        self.handle_request = handle_request
        self.on_welcome = on_welcome
        self.on_status = on_status
        self.connected = asyncio.Event()
        self.http: aiohttp.ClientSession | None = None
        self.ws: aiohttp.ClientWebSocketResponse | None = None
        self.hub_version: str | None = None
        self._queue: asyncio.Queue[tuple[dict, Callable[[], None] | None]] = asyncio.Queue(QUEUE_MAX)
        self._pending: dict[str, asyncio.Future] = {}
        self._ids = itertools.count(1)
        self._runner: asyncio.Task | None = None
        self._stopping = False
        self._tasks = TaskSet("hub")
        self._req_tasks = TaskSet("hub-req")
        self._dropped = 0
        self._last_rx = time.monotonic()
        # Per-connection ack bookkeeping (see module docstring); reset on every connect.
        self._wseq = 0                                                   # frames written so far
        self._ping_marks: deque[int] = deque()                          # wseq of each unanswered ping
        self._awaiting_ack: deque[tuple[int, Callable[[], None]]] = deque()
        self._replaced = False                                           # last socket closed with 4000

    # --- lifecycle -----------------------------------------------------------------------
    def _make_session(self) -> aiohttp.ClientSession:
        connector = None
        if self.cfg.socks_proxy:
            from aiohttp_socks import ProxyConnector  # only needed on SOCKS nodes
            connector = ProxyConnector.from_url(self.cfg.socks_proxy, rdns=True)
        return aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=None, connect=20))

    async def start(self) -> None:
        self._runner = asyncio.create_task(self._run(), name="hub-ws")

    async def close(self) -> None:
        self._stopping = True
        if self.ws is not None and not self.ws.closed:
            await self.ws.close(code=1001, message=b"link shutting down")
        if self._runner:
            self._runner.cancel()
            await asyncio.gather(self._runner, return_exceptions=True)
        await self._req_tasks.cancel_all()
        await self._tasks.cancel_all()
        if self.http is not None:
            await self.http.close()

    # --- outbound API --------------------------------------------------------------------
    def send_event(self, frame: dict, on_acked: Callable[[], None] | None = None) -> bool:
        """Queue a frame for the current connection; dropped (False) when not connected.

        ``on_acked`` runs once the hub has processed the frame; never if the connection dies first.
        """
        if not self.connected.is_set():
            return False
        try:
            self._queue.put_nowait((frame, on_acked))
            return True
        except asyncio.QueueFull:
            self._dropped += 1
            if self._dropped in (1, 100) or self._dropped % 1000 == 0:
                log.warning("hub send queue full; dropped %d frame(s)", self._dropped)
            return False

    async def request(self, method: str, params: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
        """Call a hub method. Raises RemoteError (hub said no) or HubUnavailable."""
        if not self.connected.is_set():
            try:
                await asyncio.wait_for(self.connected.wait(), min(timeout, 10))
            except asyncio.TimeoutError as e:
                raise HubUnavailable("hub not connected") from e
        rid = f"l{next(self._ids)}"
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            if not self.send_event(req(rid, method, params)):
                raise HubUnavailable("hub not connected")
            frame = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError as e:
            raise HubUnavailable(f"{method}: no answer from hub within {timeout:.0f}s") from e
        finally:
            self._pending.pop(rid, None)
        if frame.get("ok"):
            return frame.get("result") or {}
        err = frame.get("error") or {}
        extra = {k: v for k, v in err.items() if k not in ("code", "message")}
        raise RemoteError(str(err.get("code", "error")), str(err.get("message", "")), **extra)

    # --- connection loop -----------------------------------------------------------------
    async def _run(self) -> None:
        backoff = Backoff(base=1.0, cap=60.0)
        while not self._stopping:
            started = time.monotonic()
            min_delay = 0.0
            self._replaced = False
            try:
                if self.http is None or self.http.closed:
                    self.http = self._make_session()
                await self._session_once()
            except asyncio.CancelledError:
                raise
            except aiohttp.WSServerHandshakeError as e:
                if e.status == 401:
                    log.error("hub rejected the join token (401); check OMNI_JOIN_TOKEN")
                    min_delay = 60
                elif e.status == 426:
                    log.error("hub rejected protocol version %s (426): %s", PROTO, e.message)
                    min_delay = 300
                else:
                    log.warning("hub handshake failed: HTTP %s %s", e.status, e.message)
            except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as e:
                log.warning("hub connection failed: %r", e)
            except Exception as e:  # noqa: BLE001 — includes python_socks ProxyError etc.
                log.warning("hub connection error: %r", e)
            finally:
                await self._teardown()
            if self._stopping:
                break
            if self._replaced:
                # Two links share our node id and would keep evicting each other (each hello makes
                # the hub fail the other's dispatched deliveries).
                log.error("hub replaced this connection with a newer one for node %r: is another "
                          "link running with the same OMNI_NODE_ID? retrying in %ds",
                          self.cfg.node_id, REPLACED_BACKOFF_S)
                min_delay = REPLACED_BACKOFF_S
            elif time.monotonic() - started > 60:
                backoff.reset()
            delay = max(min_delay, backoff.next_delay())
            log.info("hub reconnect in %.1fs", delay)
            await asyncio.sleep(delay)

    async def _session_once(self) -> None:
        assert self.http is not None
        headers = {"Authorization": f"Bearer {self.cfg.join_token}", HEADER_NODE: self.cfg.node_id,
                   HEADER_PROTO: str(PROTO)}
        # Build the hello first: the first NodeInfo refresh can take longer than the hub's hello
        # timeout. The inflight list cannot change meanwhile (entries are added by hub requests and
        # retired by hub acks, neither of which happens while disconnected).
        hello = await self.build_hello()
        self.ws = await self.http.ws_connect(self.url, headers=headers, heartbeat=None, autoping=True,
                                             max_msg_size=32 * 1024 * 1024)
        ws = self.ws
        await ws.send_str(json.dumps(hello, ensure_ascii=False))
        msg = await asyncio.wait_for(ws.receive(), WELCOME_TIMEOUT)
        if msg.type != aiohttp.WSMsgType.TEXT:
            raise HubUnavailable(f"hub closed before welcome ({msg.type.name}, code {ws.close_code})")
        welcome = json.loads(msg.data)
        if welcome.get("t") != "welcome":
            raise HubUnavailable(f"expected welcome, got {str(welcome)[:200]}")
        self.hub_version = welcome.get("hub_version")
        log.info("connected to hub %s (hub %s, proto %s, inflight %d)", self.cfg.hub_url, self.hub_version,
                 welcome.get("proto"), len(hello.get("inflight") or []))
        self._queue = asyncio.Queue(QUEUE_MAX)
        self._wseq = 0
        self._ping_marks.clear()
        self._awaiting_ack.clear()
        self.connected.set()
        self.on_status(True)
        writer = asyncio.create_task(self._writer(ws), name="hub-writer")
        pinger = asyncio.create_task(self._pinger(ws), name="hub-pinger")
        self._tasks.spawn(self.on_welcome(), name="hub-on-welcome")
        try:
            await self._reader(ws)
        finally:
            for t in (writer, pinger):
                t.cancel()
            await asyncio.gather(writer, pinger, return_exceptions=True)

    async def _teardown(self) -> None:
        was = self.connected.is_set()
        self.connected.clear()
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(HubUnavailable("hub connection lost"))
        self._pending.clear()
        if self.ws is not None and not self.ws.closed:
            await self.ws.close()
        self.ws = None
        if was:
            log.warning("hub connection lost")
            self.on_status(False)

    async def _writer(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        probe_due = False
        while True:
            frame, on_acked = await self._queue.get()
            await self._write(ws, frame)
            if on_acked is not None:
                self._awaiting_ack.append((self._wseq, on_acked))
                probe_due = True
            elif frame.get("t") == "ping":
                probe_due = False   # this ping already follows every frame awaiting an ack
            if probe_due and self._queue.empty():
                await self._write(ws, {"t": "ping"})
                probe_due = False

    async def _write(self, ws: aiohttp.ClientWebSocketResponse, frame: dict) -> None:
        # Book-keep before awaiting the send: the pong may be read while send_str drains.
        self._wseq += 1
        if frame.get("t") == "ping":
            self._ping_marks.append(self._wseq)
        await ws.send_str(json.dumps(frame, ensure_ascii=False, default=str))

    def _on_pong(self) -> None:
        """The hub answered our oldest outstanding ping: every frame written before it is processed."""
        if not self._ping_marks:
            return
        mark = self._ping_marks.popleft()
        while self._awaiting_ack and self._awaiting_ack[0][0] < mark:
            _, cb = self._awaiting_ack.popleft()
            try:
                cb()
            except Exception:  # noqa: BLE001
                log.exception("ack callback failed")

    async def _pinger(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        while True:
            await asyncio.sleep(PING_INTERVAL)
            if time.monotonic() - self._last_rx > OFFLINE_AFTER:
                log.warning("no frames from hub for %ss; reconnecting", OFFLINE_AFTER)
                await ws.close()
                return
            self.send_event({"t": "ping"})

    async def _reader(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        self._last_rx = time.monotonic()
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                continue
            self._last_rx = time.monotonic()
            try:
                frame = json.loads(msg.data)
            except ValueError:
                log.warning("hub sent non-JSON frame")
                continue
            t = frame.get("t") if isinstance(frame, dict) else None
            if t == "req":
                self._req_tasks.spawn(self._serve(frame), name=f"hub-req-{frame.get('method')}")
            elif t == "res":
                fut = self._pending.pop(str(frame.get("id")), None)
                if fut is not None and not fut.done():
                    fut.set_result(frame)
            elif t == "ping":
                self.send_event({"t": "pong"})
            elif t == "pong":
                self._on_pong()
            elif t == "welcome":
                pass
            else:
                log.debug("ignoring hub frame t=%r", t)
        if ws.close_code == CLOSE_REPLACED:
            self._replaced = True
        else:
            log.info("hub websocket closed (code %s)", ws.close_code)

    async def _serve(self, frame: dict) -> None:
        rid = str(frame.get("id"))
        method = str(frame.get("method") or "")
        params = frame.get("params") if isinstance(frame.get("params"), dict) else {}
        started = time.monotonic()
        try:
            result = await self.handle_request(method, params)
            out = res_ok(rid, result)
        except HandlerError as e:
            out = res_err(rid, e.code, e.message, **e.extra)
        except Exception as e:  # noqa: BLE001
            log.exception("hub request %s failed", method)
            out = res_err(rid, "internal", repr(e))
        log.debug("hub req %s -> %s in %.2fs", method, "ok" if out.get("ok") else out["error"]["code"],
                  time.monotonic() - started)
        if not self.send_event(out):
            log.warning("could not answer hub request %s (%s): disconnected", rid, method)
