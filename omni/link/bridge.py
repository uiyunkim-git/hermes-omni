"""Bridge HTTP server for the hub-bridge plugin (design §7), aiohttp on :8810 (compose network only).

Every request must carry ``X-Omni-Token: $OMNI_LINK_TOKEN``.
  GET  /bridge/health
  GET  /bridge/directory?session_id=
  POST /bridge/send   {session_id, to, message, wait, expect_reply, timeout_s}
  GET  /bridge/inbox?session_id=&limit=
The plugin's ``session_id`` is the stored session id (current tip). The sender address is
``node#sid`` (plus the session title for the message header); the hop chain and the conversation
come from the delivery the session is currently answering (``cause_id``). The link mints the
delivery id and calls hub ``agent.send``; the hub resolves ``to`` (address, folder or title).
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import time
from typing import TYPE_CHECKING, Any

from aiohttp import web

from omni.proto import (HEADER_LINK_TOKEN, MESSAGE_MAX_CHARS, STORED_ID_RE, TO_MAX, WAIT_DEFAULT_S, WAIT_MAX_S,
                        RemoteError, new_delivery_id)
from omni.link.hubconn import HubUnavailable

if TYPE_CHECKING:
    from omni.link.agent import LinkAgent

log = logging.getLogger("omni.link.bridge")

POLL_INTERVAL = 3.0
RECONNECT_GRACE = 20.0     # async send: how long to wait for the hub to come back
PREP_TIMEOUT_S = 5.0       # sender address / hop chain lookups before agent.send
# Answer budgets, counted from request arrival. The plugin's HTTP timeout is timeout_s + 15 for
# a waiting send and 30 s otherwise; stay a few seconds inside both.
WAIT_SLACK_S = 10.0
ASYNC_BUDGET_S = 25.0
INJECT_RECHECK_S = 1.5


def _json(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=lambda o: json.dumps(o, ensure_ascii=False))


def _bool(v: Any, default: bool) -> bool:
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on")
    return bool(v)


class Bridge:
    def __init__(self, agent: "LinkAgent"):
        self.agent = agent
        self.cfg = agent.cfg
        self._runner: web.AppRunner | None = None
        self._token = self.cfg.link_token.encode("utf-8")

    async def start(self) -> None:
        app = web.Application(middlewares=[self._auth], client_max_size=256 * 1024)
        app.router.add_get("/bridge/health", self.health)
        app.router.add_get("/bridge/directory", self.directory)
        app.router.add_post("/bridge/send", self.send)
        app.router.add_get("/bridge/inbox", self.inbox)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.cfg.bridge_host, self.cfg.bridge_port)
        await site.start()
        log.info("bridge listening on %s:%s", self.cfg.bridge_host, self.cfg.bridge_port)

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()

    @web.middleware
    async def _auth(self, request: web.Request, handler):
        given = request.headers.get(HEADER_LINK_TOKEN, "").encode("utf-8")
        if not given or not hmac.compare_digest(given, self._token):
            return _json({"error": "unauthorized"}, 401)
        try:
            return await handler(request)
        except web.HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("bridge %s failed", request.path)
            return _json({"error": f"internal: {e!r}"}, 500)

    # --- helpers -------------------------------------------------------------------------
    @staticmethod
    def _session_id(value: Any) -> str | None:
        return value if isinstance(value, str) and STORED_ID_RE.match(value) else None

    async def _hub(self, method: str, params: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
        return await self.agent.hub.request(method, params, timeout=timeout)

    async def _chain_for(self, stored_id: str) -> tuple[str | None, list[str]]:
        """(cause delivery id, hop chain): if the session is answering a delivery, that delivery's
        chain + its sender."""
        did = await self.agent.sessions.current_delivery(stored_id)
        if not did:
            return None, []
        try:
            res = await self._hub("delivery.get", {"delivery_id": did}, timeout=PREP_TIMEOUT_S)
        except (RemoteError, HubUnavailable) as e:
            log.warning("delivery.get %s failed (%s); sending with empty chain", did, e)
            return did, []
        d = res.get("delivery") or {}
        chain = d.get("chain")
        if chain is None and isinstance(d.get("chain_json"), str):
            try:
                chain = json.loads(d["chain_json"])
            except ValueError:
                chain = None
        chain = [c for c in (chain or []) if isinstance(c, str)]
        sender = d.get("from_addr") or d.get("from_address")
        if isinstance(sender, str) and sender:
            chain.append(sender)
        return did, chain

    # --- routes --------------------------------------------------------------------------
    async def health(self, request: web.Request) -> web.Response:
        return _json({"ok": True, "node_id": self.cfg.node_id, "hub_connected": self.agent.hub.connected.is_set(),
                      "hermes_connected": self.agent.hermes.connected.is_set()})

    async def directory(self, request: web.Request) -> web.Response:
        params: dict[str, Any] = {}
        query = (request.query.get("query") or "").strip()
        if query:
            params["query"] = query[:200]
        sid = self._session_id(request.query.get("session_id"))
        if sid:
            params["stored_id"] = sid
        try:
            return _json(await self._hub("agent.directory", params))
        except RemoteError as e:
            return _json({"error": f"{e.code}: {e.message}"}, 502)
        except HubUnavailable as e:
            return _json({"error": f"hub unavailable: {e}"}, 503)

    async def inbox(self, request: web.Request) -> web.Response:
        sid = self._session_id(request.query.get("session_id"))
        if sid is None:
            return _json({"error": "session_id required"}, 400)
        try:
            limit = max(1, min(int(request.query.get("limit") or 20), 100))
        except ValueError:
            limit = 20
        try:
            return _json(await self._hub("agent.inbox", {"stored_id": sid, "limit": limit}))
        except RemoteError as e:
            return _json({"error": f"{e.code}: {e.message}"}, 502)
        except HubUnavailable as e:
            return _json({"error": f"hub unavailable: {e}"}, 503)

    async def send(self, request: web.Request) -> web.Response:
        # The plugin gives up after timeout_s + 15 (wait) or 30 s (async); every path below answers
        # by a deadline counted from the request's arrival so the plugin never times out first.
        arrived = time.monotonic()
        try:
            body = await request.json()
        except ValueError:
            return _json({"status": "rejected", "reason": "invalid JSON"}, 400)
        if not isinstance(body, dict):
            return _json({"status": "rejected", "reason": "JSON object expected"}, 400)
        sid = self._session_id(body.get("session_id"))
        if sid is None:
            return _json({"status": "rejected", "reason": "session_id required"}, 400)
        to, message = body.get("to"), body.get("message")
        if not isinstance(to, str) or not to.strip() or len(to.strip()) > TO_MAX:
            return _json({"status": "rejected", "reason": "bad_target",
                          "message": f"to must be 1-{TO_MAX} characters"}, 400)
        if not isinstance(message, str) or not message.strip():
            return _json({"status": "rejected", "reason": "message required"}, 400)
        if len(message) > MESSAGE_MAX_CHARS:
            return _json({"status": "rejected", "reason": f"message longer than {MESSAGE_MAX_CHARS} chars"}, 400)
        wait = _bool(body.get("wait"), False)
        expect_reply = _bool(body.get("expect_reply"), True)
        try:
            timeout_s = int(body.get("timeout_s") or WAIT_DEFAULT_S)
        except (TypeError, ValueError):
            timeout_s = WAIT_DEFAULT_S
        timeout_s = max(1, min(timeout_s, WAIT_MAX_S))
        deadline = arrived + (timeout_s + WAIT_SLACK_S if wait else ASYNC_BUDGET_S)

        delivery_id = new_delivery_id()
        from_address = self.agent.address_for_session(sid)
        cause_id, chain = await self._bounded_chain(sid)
        params = {"delivery_id": delivery_id, "from_stored_id": sid, "from_address": from_address,
                  "from_title": self.agent.title_for_session(sid), "cause_id": cause_id,
                  "chain": chain, "to": to.strip(), "message": message, "expect_reply": expect_reply,
                  "wait": wait, "timeout_s": timeout_s}
        log.info("agent.send %s %s -> %s (wait=%s, chain=%d)", delivery_id, from_address, params["to"], wait,
                 len(chain))
        try:
            return _json(await self._hub("agent.send", params, timeout=_remaining(deadline)))
        except RemoteError as e:
            return _json({"delivery_id": delivery_id, "status": "error", "reason": f"{e.code}: {e.message}"})
        except HubUnavailable as e:
            log.warning("agent.send %s: %s; recovering", delivery_id, e)
        return _json(await self._recover(params, deadline))

    async def _bounded_chain(self, sid: str) -> tuple[str | None, list[str]]:
        try:
            return await asyncio.wait_for(self._chain_for(sid), PREP_TIMEOUT_S)
        except asyncio.TimeoutError:
            log.warning("hop chain lookup for %s timed out; sending with empty chain", sid)
            return None, []

    async def _recover(self, params: dict[str, Any], deadline: float) -> dict[str, Any]:
        """The hub link dropped (or went silent) mid-send; answer by ``deadline`` at the latest.

        The hub upserts by delivery id, so re-sending is safe. If the delivery already exists, the
        hub lost our original call: for a waiting send it has also dropped the waiter, so the reply
        will be injected into the sender as a new turn — never also return it here (no duplicate).
        """
        did, wait = params["delivery_id"], params["wait"]
        end = deadline if wait else min(deadline, time.monotonic() + RECONNECT_GRACE)
        while (remaining := end - time.monotonic()) > 0:
            try:
                await asyncio.wait_for(self.agent.hub.connected.wait(), remaining)
            except asyncio.TimeoutError:
                break
            try:
                try:
                    existing = (await self._hub("delivery.get", {"delivery_id": did},
                                                timeout=min(10.0, _remaining(end)))).get("delivery")
                except RemoteError:
                    existing = None   # not_found: the hub never saw the original call
                if not existing:
                    return await self._resend(params, end)
                if not wait:
                    return {"delivery_id": did, "status": "queued"}
                return await self._settle_lost_wait(params, existing, end)
            except RemoteError as e:
                return {"delivery_id": did, "status": "error", "reason": f"{e.code}: {e.message}"}
            except HubUnavailable as e:
                log.info("agent.send %s: recovery attempt failed (%s)", did, e)
                await asyncio.sleep(min(1.0, max(0.0, end - time.monotonic())))
        if wait:
            return {"delivery_id": did, "status": "timeout",
                    "reason": "hub unreachable; if the message was delivered, the reply will arrive as a new turn"}
        return {"delivery_id": did, "status": "error", "reason": "hub unavailable"}

    async def _resend(self, params: dict[str, Any], end: float) -> dict[str, Any]:
        remaining = end - time.monotonic()
        p = dict(params)
        if p["wait"]:
            if remaining < WAIT_SLACK_S:
                p["wait"] = False   # too little time left to wait: the reply comes as a new turn
            else:
                p["timeout_s"] = max(1, min(int(p["timeout_s"]), int(remaining - WAIT_SLACK_S / 2)))
        return await self._hub("agent.send", p, timeout=_remaining(end))

    async def _settle_lost_wait(self, params: dict[str, Any], d: dict[str, Any], end: float) -> dict[str, Any]:
        """A waiting send whose hub-side waiter is gone. Without expect_reply nothing is injected,
        so polling is safe; otherwise the reply comes back as a turn unless the waiter consumed it."""
        did = params["delivery_id"]
        if not params["expect_reply"]:
            return await self._poll(did, end)
        status = d.get("status")
        if status in ("error", "cancelled"):
            return {"delivery_id": did, "status": "error", "reason": d.get("error") or status}
        if status != "done":
            return {"delivery_id": did, "status": "queued",
                    "reason": "hub connection was interrupted; the reply will arrive later as a new turn"}
        # Done: either the waiter took the reply before the drop (nothing injected; only its answer
        # frame was lost) or the hub finished it afterwards and queued a reply turn.
        for attempt in (0, 1):
            if await self._reply_injected(params["from_stored_id"], did, end):
                return {"delivery_id": did, "status": "queued",
                        "reason": "hub reconnected; the reply will arrive as a new turn"}
            if attempt == 0:   # the reply row is inserted just after the status update
                await asyncio.sleep(min(INJECT_RECHECK_S, max(0.0, end - time.monotonic() - 1)))
        out = {"delivery_id": did, "status": "done", "reply": d.get("reply") or ""}
        if d.get("error"):
            out["reason"] = d["error"]
        return out

    async def _reply_injected(self, sender: str, did: str, end: float) -> bool:
        res = await self._hub("agent.inbox", {"stored_id": sender, "limit": 100},
                              timeout=min(10.0, _remaining(end)))
        return any(x.get("kind") == "reply" and x.get("parent_id") == did for x in res.get("deliveries") or [])

    async def _poll(self, did: str, end: float) -> dict[str, Any]:
        while time.monotonic() < end:
            d = (await self._hub("delivery.get", {"delivery_id": did},
                                 timeout=min(10.0, _remaining(end)))).get("delivery") or {}
            status = d.get("status")
            if status == "done":
                return {"delivery_id": did, "status": "done", "reply": d.get("reply")}
            if status in ("error", "cancelled"):
                return {"delivery_id": did, "status": "error", "reason": d.get("error") or status}
            await asyncio.sleep(min(POLL_INTERVAL, max(0.0, end - time.monotonic())))
        return {"delivery_id": did, "status": "timeout"}


def _remaining(deadline: float) -> float:
    return max(1.0, deadline - time.monotonic())
