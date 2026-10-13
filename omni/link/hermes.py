"""Client for the local Hermes dashboard backend (design §1).

* Auth: basic password login → access/refresh tokens; REST uses ``Authorization: Bearer``.
  Refresh via /auth/native/refresh; re-login only when the refresh token is rejected
  (login is rate limited to 10/min/IP).
* One persistent ``/api/ws`` JSON-RPC connection (ticket auth) with request correlation,
  event and server→client request dispatch, and reconnect with jittered backoff.
  Callbacks: ``on_event(params)`` and ``on_server_request(frame)`` are synchronous and called in
  wire order; ``on_connected(epoch)`` / ``on_disconnected()`` are coroutines run as tasks.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import time
from typing import Any, Awaitable, Callable

import aiohttp

from omni.link.config import Config
from omni.link.util import Backoff, TaskSet

log = logging.getLogger("omni.link.hermes")

ACCESS_TTL_FALLBACK = 11 * 3600   # AT lives 12h; refresh a bit early when expiry is unknown
LOGIN_MIN_INTERVAL = 10.0
STALE_SESSION_CODES = (4001, 4007)


class HermesError(Exception):
    """A JSON-RPC error from /api/ws or a non-2xx REST response."""

    def __init__(self, code: int, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class HermesUnavailable(HermesError):
    """Hermes could not be reached or did not answer.

    ``sent`` is True when the request frame had already been written to the socket, i.e. Hermes
    may have executed the call even though we never saw its answer (ambiguous outcome).
    """

    def __init__(self, message: str = "hermes not connected", *, sent: bool = False):
        super().__init__(-1, message)
        self.sent = sent


class HermesClient:
    def __init__(self, cfg: Config,
                 on_event: Callable[[dict], None],
                 on_server_request: Callable[[dict], None],
                 on_connected: Callable[[str | None], Awaitable[None]],
                 on_disconnected: Callable[[], Awaitable[None]]):
        self.cfg = cfg
        self.base = cfg.hermes_url
        self.on_event = on_event
        self.on_server_request = on_server_request
        self.on_connected = on_connected
        self.on_disconnected = on_disconnected

        self.http: aiohttp.ClientSession | None = None
        self._at: str | None = None
        self._rt: str | None = None
        self._at_expires = 0.0
        self._last_login = 0.0
        self._auth_lock = asyncio.Lock()

        self.ws: aiohttp.ClientWebSocketResponse | None = None
        self.connected = asyncio.Event()
        self.epoch: str | None = None
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}
        self._send_lock = asyncio.Lock()
        self._runner: asyncio.Task | None = None
        self._stopping = False
        self._tasks = TaskSet("hermes")

    # --- lifecycle -----------------------------------------------------------------------
    async def start(self) -> None:
        self.http = aiohttp.ClientSession(cookie_jar=aiohttp.DummyCookieJar(),
                                          timeout=aiohttp.ClientTimeout(total=60, connect=10))
        self._runner = asyncio.create_task(self._run(), name="hermes-ws")

    async def close(self) -> None:
        self._stopping = True
        if self._runner:
            self._runner.cancel()
            await asyncio.gather(self._runner, return_exceptions=True)
        await self._tasks.cancel_all()
        if self.ws is not None and not self.ws.closed:
            await self.ws.close()
        if self.http:
            await self.http.close()

    # --- auth ----------------------------------------------------------------------------
    async def _login(self) -> None:
        assert self.http is not None
        wait = self._last_login + LOGIN_MIN_INTERVAL - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        self._last_login = time.monotonic()
        body = {"provider": "basic", "username": self.cfg.hermes_user,
                "password": self.cfg.hermes_password, "next": ""}
        async with self.http.post(f"{self.base}/auth/password-login", json=body) as r:
            if r.status != 200:
                raise HermesError(r.status, f"login failed: HTTP {r.status} {(await r.text())[:200]}")
            at = r.cookies.get("hermes_session_at")
            rt = r.cookies.get("hermes_session_rt")
        if at is None or not at.value:
            raise HermesError(500, "login returned no access token cookie")
        self._at = at.value
        self._rt = rt.value if rt is not None else None
        self._at_expires = time.time() + ACCESS_TTL_FALLBACK
        log.info("logged in to hermes as %s", self.cfg.hermes_user)

    async def _refresh(self) -> bool:
        """Rotate tokens with the refresh token. False if the RT was rejected (→ re-login)."""
        assert self.http is not None
        if not self._rt:
            return False
        async with self.http.post(f"{self.base}/auth/native/refresh",
                                  json={"refresh_token": self._rt, "provider": "basic"}) as r:
            if r.status in (400, 401, 403):
                log.info("hermes refresh token rejected (HTTP %s)", r.status)
                return False
            if r.status != 200:
                raise HermesError(r.status, f"refresh failed: HTTP {r.status}")
            j = await r.json(content_type=None)
        self._at = j.get("access_token") or self._at
        self._rt = j.get("refresh_token") or self._rt
        exp = j.get("expires_at")
        if isinstance(exp, (int, float)) and exp > time.time():
            self._at_expires = float(exp) - 600
        else:
            self._at_expires = time.time() + ACCESS_TTL_FALLBACK
        log.debug("refreshed hermes access token")
        return True

    async def _auth(self, force: bool = False) -> str:
        async with self._auth_lock:
            if self._at and not force and time.time() < self._at_expires:
                return self._at
            if self._rt and await self._refresh():
                assert self._at
                return self._at
            await self._login()
            assert self._at
            return self._at

    # --- REST ----------------------------------------------------------------------------
    async def rest(self, method: str, path: str, *, params: dict[str, Any] | None = None,
                   json_body: Any = None, allow_404: bool = False, timeout: float = 30) -> Any:
        """Bearer-authenticated REST call. Returns parsed JSON (None for 404 when allowed)."""
        assert self.http is not None
        for attempt in (0, 1):
            token = await self._auth(force=attempt == 1)
            try:
                async with self.http.request(method, f"{self.base}{path}", params=params, json=json_body,
                                             headers={"Authorization": f"Bearer {token}"},
                                             timeout=aiohttp.ClientTimeout(total=timeout)) as r:
                    if r.status == 401 and attempt == 0:
                        continue
                    if r.status == 404 and allow_404:
                        return None
                    text = await r.text()
                    if r.status >= 400:
                        raise HermesError(r.status, f"{method} {path}: HTTP {r.status} {text[:300]}")
                    return json.loads(text) if text else {}
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                raise HermesUnavailable(f"{method} {path}: {e!r}") from e
        raise HermesError(401, f"{method} {path}: unauthorized")

    async def rest_raw(self, method: str, path: str, *, params: dict[str, Any] | None = None,
                       json_body: Any = None, timeout: float = 30) -> tuple[int, Any]:
        """Bearer-authenticated REST call that does not raise on HTTP errors: (status, body).
        The body is parsed JSON when possible, else the text (capped)."""
        assert self.http is not None
        for attempt in (0, 1):
            token = await self._auth(force=attempt == 1)
            try:
                async with self.http.request(method, f"{self.base}{path}", params=params, json=json_body,
                                             headers={"Authorization": f"Bearer {token}"},
                                             timeout=aiohttp.ClientTimeout(total=timeout)) as r:
                    if r.status == 401 and attempt == 0:
                        continue
                    text = await r.text()
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                raise HermesUnavailable(f"{method} {path}: {e!r}") from e
            try:
                return r.status, (json.loads(text) if text else None)
            except ValueError:
                return r.status, text[:20000]
        raise HermesError(401, f"{method} {path}: unauthorized")

    async def public_get(self, path: str) -> Any:
        assert self.http is not None
        try:
            async with self.http.get(f"{self.base}{path}", timeout=aiohttp.ClientTimeout(total=10)) as r:
                if r.status >= 400:
                    raise HermesError(r.status, f"GET {path}: HTTP {r.status}")
                return await r.json(content_type=None)
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as e:
            raise HermesUnavailable(f"GET {path}: {e!r}") from e

    # --- WebSocket -----------------------------------------------------------------------
    async def _run(self) -> None:
        backoff = Backoff(base=1.0, cap=30.0)
        while not self._stopping:
            started = time.monotonic()
            try:
                await self._connect_and_read()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — any failure means reconnect
                log.warning("hermes ws: %s", e if isinstance(e, HermesError) else repr(e))
            finally:
                await self._teardown()
            if self._stopping:
                break
            if time.monotonic() - started > 60:
                backoff.reset()
            delay = backoff.next_delay()
            log.info("hermes ws reconnect in %.1fs", delay)
            await asyncio.sleep(delay)

    async def _ticket(self) -> str:
        for attempt in (0, 1):
            token = await self._auth(force=attempt == 1)
            assert self.http is not None
            async with self.http.post(f"{self.base}/api/auth/ws-ticket",
                                      headers={"Authorization": f"Bearer {token}"}) as r:
                if r.status == 401 and attempt == 0:
                    continue
                if r.status != 200:
                    raise HermesError(r.status, f"ws-ticket: HTTP {r.status}")
                return (await r.json(content_type=None))["ticket"]
        raise HermesError(401, "ws-ticket unauthorized")

    async def _connect_and_read(self) -> None:
        assert self.http is not None
        ticket = await self._ticket()
        ws_url = self.base.replace("http://", "ws://", 1).replace("https://", "wss://", 1)
        self.ws = await self.http.ws_connect(f"{ws_url}/api/ws", params={"ticket": ticket},
                                             max_msg_size=0, heartbeat=30, autoping=True)
        log.info("hermes ws connected")
        ready = asyncio.get_running_loop().create_future()
        reader = asyncio.create_task(self._read(ready), name="hermes-ws-read")
        try:
            await asyncio.wait({ready, reader}, timeout=30, return_when=asyncio.FIRST_COMPLETED)
            if not ready.done():
                raise HermesError(-1, "no gateway.ready from hermes ws")
            self.epoch = ready.result()
            await self._call_raw("client.capabilities", {"server_requests": True}, 30)
            self.connected.set()
            self._tasks.spawn(self.on_connected(self.epoch), name="hermes-on-connected")
            await reader
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)

    async def _read(self, ready: asyncio.Future) -> None:
        assert self.ws is not None
        async for msg in self.ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                if msg.type == aiohttp.WSMsgType.ERROR:
                    log.warning("hermes ws error frame: %r", self.ws.exception())
                continue
            try:
                frame = json.loads(msg.data)
            except ValueError:
                log.warning("hermes ws: non-JSON frame dropped")
                continue
            if not isinstance(frame, dict):
                continue
            method = frame.get("method")
            if method == "event":
                params = frame.get("params") or {}
                if params.get("type") == "gateway.ready" and not ready.done():
                    ready.set_result((params.get("payload") or {}).get("replay_epoch"))
                    continue
                try:
                    self.on_event(params)
                except Exception:  # noqa: BLE001
                    log.exception("event handler failed for %s", params.get("type"))
            elif method is not None and "id" in frame:
                try:
                    self.on_server_request(frame)
                except Exception:  # noqa: BLE001
                    log.exception("server request handler failed for %s", method)
            elif "id" in frame:
                fut = self._pending.pop(frame["id"], None)
                if fut is not None and not fut.done():
                    fut.set_result(frame)
        log.info("hermes ws closed (code %s)", self.ws.close_code)

    async def _teardown(self) -> None:
        was_connected = self.connected.is_set()
        self.connected.clear()
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(HermesUnavailable("hermes ws closed"))
        self._pending.clear()
        if self.ws is not None and not self.ws.closed:
            await self.ws.close()
        self.ws = None
        if was_connected and not self._stopping:
            self._tasks.spawn(self.on_disconnected(), name="hermes-on-disconnected")

    async def _send(self, frame: dict) -> None:
        ws = self.ws
        if ws is None or ws.closed:
            raise HermesUnavailable()
        async with self._send_lock:
            await ws.send_str(json.dumps(frame, ensure_ascii=False))

    async def _call_raw(self, method: str, params: dict, timeout: float) -> dict:
        rid = next(self._ids)
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut   # registered before sending: the answer may race the send's return
        sent = False
        try:
            try:
                await self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
            except (aiohttp.ClientError, ConnectionError) as e:
                # Writing to a closing transport fails before anything reaches Hermes.
                raise HermesUnavailable(f"{method}: send failed: {e!r}") from e
            sent = True
            frame = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError as e:
            raise HermesUnavailable(f"{method}: timed out after {timeout}s", sent=True) from e
        except HermesUnavailable as e:
            if e.sent == sent:
                raise
            raise HermesUnavailable(e.message, sent=sent) from e
        finally:
            self._pending.pop(rid, None)
            if fut.done() and not fut.cancelled():
                fut.exception()   # teardown may have failed it while nobody awaited it
        if "error" in frame and frame["error"] is not None:
            err = frame["error"]
            raise HermesError(int(err.get("code", -32000)), str(err.get("message", "error")))
        result = frame.get("result")
        return result if isinstance(result, dict) else {"value": result}

    async def call(self, method: str, params: dict | None = None, timeout: float = 30) -> dict:
        """JSON-RPC call over /api/ws; waits briefly for a connection if currently down."""
        if not self.connected.is_set():
            try:
                await asyncio.wait_for(self.connected.wait(), min(timeout, 15))
            except asyncio.TimeoutError as e:
                raise HermesUnavailable() from e
        return await self._call_raw(method, params or {}, timeout)

    async def recycle(self) -> None:
        """Drop the WS so Hermes forgets our viewer registrations; the run loop reconnects."""
        if self.ws is not None and not self.ws.closed:
            await self.ws.close()

    async def respond(self, request_id: str, result: dict) -> None:
        """Answer a server→client request (srq id) from this socket."""
        if not self.connected.is_set():
            raise HermesUnavailable()
        await self._send({"jsonrpc": "2.0", "id": request_id, "result": result})

    # --- status --------------------------------------------------------------------------
    async def probe(self) -> dict[str, Any]:
        """NodeInfo.hermes: {ok, version, gateway_state, model}."""
        out: dict[str, Any] = {"ok": False, "version": None, "gateway_state": None, "model": None}
        try:
            st = await self.public_get("/api/status")
            out["version"] = st.get("version")
            out["gateway_state"] = st.get("gateway_state")
            out["ok"] = self.connected.is_set()
        except HermesError as e:
            log.debug("status probe failed: %s", e)
            return out
        try:
            mi = await self.public_get("/api/model/info")
            if isinstance(mi, dict):
                out["model"] = mi.get("model") or mi.get("default") or mi.get("name")
        except HermesError:
            pass
        return out
