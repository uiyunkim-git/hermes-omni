"""Agent-to-agent message routing (design §5 link->hub methods, §6 dispatcher).

- `agent.send` validates, resolves the target address and stores a delivery (id minted by the
  sender link, so retries are idempotent). wait=true blocks the caller until the target turn
  finishes or timeout_s passes, unless the target is busy or waiting would deadlock, in which
  case the send is downgraded to async ("target_busy_async").
- The dispatcher keeps at most one 'dispatched' delivery per target session and submits it
  with link `session.prompt {mode:"queue"}`; deliveries are FIFO per target.
- `turn.done` carrying a delivery id completes the delivery. When the original sender is a
  session expecting a reply and nobody waited for it synchronously, the reply is injected back
  into the sender as a 'reply' delivery.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from omni.proto import (MAX_HOPS, MESSAGE_MAX_CHARS, STORED_ID_RE, WAIT_DEFAULT_S, WAIT_MAX_S,
                        RemoteError, format_address, format_reply_text, format_request_text,
                        new_delivery_id, parse_address)

from .links import LinkConnection, LinkManager, NodeUnavailable
from .store import ACTIVE_STATUSES, Store

if TYPE_CHECKING:
    from .live import Live

log = logging.getLogger("omni.hub.router")

DELIVERY_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
TICK_S = 30.0                 # periodic dispatcher wake-up (retries, stale reaping)
RETRY_BACKOFF_S = 30.0        # after a transient dispatch failure
MAX_DISPATCH_ATTEMPTS = 5     # transient failures before a delivery is marked error
STALE_DISPATCHED_S = 12 * 3600
LINK_CALL_TIMEOUT = 60.0
RESOLVE_CALL_TIMEOUT = 20.0   # projects.list rescan while resolving an unknown project

SessionKey = tuple[str, str]   # (node_id, stored_id or "path:<abs>")


class Rejected(Exception):
    def __init__(self, reason: str, message: str = ""):
        super().__init__(message or reason)
        self.reason = reason
        self.message = message or reason


@dataclass
class Target:
    node: str
    addr: str
    project: str | None
    path: str | None
    stored: str | None           # explicit session id
    canonical_hint: str | None   # canonical stored id from the node's last report

    @property
    def key(self) -> SessionKey:
        return (self.node, self.stored or self.canonical_hint or f"path:{self.path}")


class Router:
    def __init__(self, store: Store, links: LinkManager):
        self.store = store
        self.links = links
        self.live: Live   # wired by the server
        self._waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        # Active synchronous waits: delivery id -> (sender, target). Edges of the wait-for graph.
        self._waits: dict[str, tuple[SessionKey, SessionKey]] = {}
        self._dispatching: set[SessionKey] = set()
        self._attempts: dict[str, int] = {}
        self._retry_at: dict[str, float] = {}
        self._last_inflight: dict[str, set[str]] = {}
        self._canon: dict[tuple[str, str], str] = {}   # (node, project path) -> canonical stored id
        self._kick = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._tasks: set[asyncio.Task[Any]] = set()

    # --- lifecycle -------------------------------------------------------------------
    def start(self) -> None:
        self._task = asyncio.create_task(self._dispatch_loop())
        self.kick()

    async def stop(self) -> None:
        tasks = [t for t in [self._task, *self._tasks] if t]
        for t in tasks:
            t.cancel()
        for t in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t

    def kick(self) -> None:
        self._kick.set()

    # --- link requests ---------------------------------------------------------------
    async def handle_link_request(self, node: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if method == "agent.send":
            return await self.agent_send(node, params)
        if method == "agent.directory":
            return {"nodes": self.directory()}
        if method == "agent.inbox":
            sid = params.get("stored_id")
            if not isinstance(sid, str) or not STORED_ID_RE.match(sid):
                raise RemoteError("bad_request", "stored_id required")
            limit = _int(params.get("limit"), 20, 1, 200)
            rows = await self.store.run(self.store.deliveries_for_session, node, sid, limit)
            return {"deliveries": rows}
        if method == "delivery.get":
            did = params.get("delivery_id")
            d = await self.store.run(self.store.get_delivery, did) if isinstance(did, str) else None
            if d is None:
                raise RemoteError("not_found", "unknown delivery")
            return {"delivery": d}
        raise RemoteError("unknown_method", f"hub does not implement {method}")

    def directory(self) -> list[dict[str, Any]]:
        out = []
        for st in sorted(self.links.nodes.values(), key=lambda s: s.node_id):
            projects = []
            for p in st.info.get("projects") or []:
                if not isinstance(p, dict):
                    continue
                canon = p.get("canonical") or {}
                projects.append({
                    "address": p.get("address") or format_address(st.node_id, p.get("name")),
                    "name": p.get("name"), "path": p.get("path"),
                    "canonical_stored_id": canon.get("stored_id"),
                    "running": bool(canon.get("running")),
                })
            out.append({"node_id": st.node_id, "display_name": st.info.get("display_name") or st.node_id,
                        "online": self.links.is_online(st.node_id), "projects": projects})
        return out

    # --- agent.send ------------------------------------------------------------------
    async def agent_send(self, node: str, p: dict[str, Any]) -> dict[str, Any]:
        # The sender link gives this request timeout_s + 10s from its own send, so the whole
        # call (validation, which may call the target link, and the wait) is budgeted from here.
        t0 = time.monotonic()
        did = p.get("delivery_id")
        if not isinstance(did, str) or not DELIVERY_ID_RE.match(did):
            did = new_delivery_id()
        existing = await self.store.run(self.store.get_delivery, did)
        if existing is not None:
            return _send_result(existing)
        try:
            row, wait, timeout_s, reason = await self._validate_send(node, p, did, t0)
        except Rejected as r:
            log.info("agent.send %s from %s rejected: %s", did, node, r.reason)
            return {"delivery_id": did, "status": "rejected", "reason": r.reason}

        if not await self.store.run(self.store.insert_delivery, row):
            existing = await self.store.run(self.store.get_delivery, did)
            return _send_result(existing) if existing else {"delivery_id": did, "status": "error", "reason": "conflict"}
        d = await self.store.run(self.store.get_delivery, did)
        log.info("delivery %s queued: %s -> %s (wait=%s%s)", did, row["from_addr"], row["to_addr"], wait,
                 f", {reason}" if reason else "")
        self._publish(d)
        if not wait:
            self.kick()
            out: dict[str, Any] = {"delivery_id": did, "status": "queued"}
            if reason:
                out["reason"] = reason
            return out

        sender: SessionKey = (node, row["from_stored"])
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._waiters[did] = fut
        self._waits[did] = (sender, row["_target_key"])
        self.kick()
        try:
            remaining = max(0.0, timeout_s - (time.monotonic() - t0))
            done = await asyncio.wait_for(asyncio.shield(fut), remaining)
            return _send_result(done)
        except TimeoutError:
            log.info("delivery %s: wait timed out after %ss; reply will be injected later", did, timeout_s)
            return {"delivery_id": did, "status": "timeout",
                    "reason": f"no reply within {timeout_s}s; the reply will arrive later as a new turn"}
        finally:
            # After this point a late turn.done finds no waiter and injects a reply turn.
            self._waiters.pop(did, None)
            self._waits.pop(did, None)

    async def _validate_send(self, node: str, p: dict[str, Any], did: str,
                             t0: float) -> tuple[dict[str, Any], bool, int, str | None]:
        from_stored = p.get("from_stored_id")
        if not isinstance(from_stored, str) or not STORED_ID_RE.match(from_stored):
            raise Rejected("bad_request", "from_stored_id required")
        from_addr = p.get("from_address")
        try:
            fa = parse_address(from_addr if isinstance(from_addr, str) else "")
        except ValueError:
            raise Rejected("bad_from_address") from None
        if fa["node"] != node:
            raise Rejected("from_node_mismatch")
        chain = p.get("chain") or []
        if not isinstance(chain, list) or not all(isinstance(c, str) for c in chain):
            raise Rejected("bad_request", "chain must be a list of addresses")
        if len(chain) >= MAX_HOPS:
            raise Rejected("hop_limit")
        message = p.get("message")
        if not isinstance(message, str) or not message.strip():
            raise Rejected("empty_message")
        if len(message) > MESSAGE_MAX_CHARS:
            raise Rejected("message_too_long")
        expect_reply = bool(p.get("expect_reply", True))
        wait = bool(p.get("wait", False))
        timeout_s = _int(p.get("timeout_s"), WAIT_DEFAULT_S, 1, WAIT_MAX_S)

        def budget(cap: float) -> float:
            """Link-call timeout during validation: never beyond the caller's wait budget."""
            if not wait:
                return cap
            return min(cap, max(1.0, timeout_s - (time.monotonic() - t0)))

        target = await self.resolve(p.get("to"), budget(RESOLVE_CALL_TIMEOUT))
        sender: SessionKey = (node, from_stored)
        reason = None
        if wait and not target.stored and not target.canonical_hint and self.links.is_online(target.node):
            # Deadlock/busy checks need the concrete session; resolve it now (dispatch would anyway).
            with contextlib.suppress(RemoteError, NodeUnavailable, ConnectionError, TimeoutError):
                res = await self.links.call(target.node, "session.ensure", {"path": target.path},
                                            budget(LINK_CALL_TIMEOUT))
                if isinstance(res.get("stored_id"), str) and res["stored_id"]:
                    target.canonical_hint = res["stored_id"]
                    self._canon[(target.node, target.path or "")] = res["stored_id"]
        if wait:
            busy = await self._target_busy(target)
            if busy or self._would_deadlock(sender, target, chain):
                wait, reason = False, "target_busy_async"
            elif not self.links.is_online(target.node):
                wait, reason = False, "target_offline"
        row = {
            "id": did, "kind": "message", "from_node": node, "from_stored": from_stored,
            "from_addr": format_address(fa["node"], fa["project"], fa["stored_id"]),
            "to_node": target.node, "to_addr": target.addr, "to_path": target.path, "to_stored": target.stored,
            "message": message, "expect_reply": expect_reply, "wait": wait, "chain": chain,
            "_target_key": target.key,
        }
        return row, wait, timeout_s, reason

    async def human_send(self, to: Any, message: Any, expect_reply: bool) -> dict[str, Any]:
        """POST /api/send: a human -> session message. Raises Rejected."""
        if not isinstance(message, str) or not message.strip():
            raise Rejected("empty_message")
        if len(message) > MESSAGE_MAX_CHARS:
            raise Rejected("message_too_long")
        target = await self.resolve(to)
        did = new_delivery_id()
        await self.store.run(self.store.insert_delivery, {
            "id": did, "kind": "message", "from_node": None, "from_stored": None, "from_addr": "human",
            "to_node": target.node, "to_addr": target.addr, "to_path": target.path, "to_stored": target.stored,
            "message": message, "expect_reply": expect_reply, "chain": [],
        })
        d = await self.store.run(self.store.get_delivery, did)
        assert d is not None
        self._publish(d)
        self.kick()
        return d

    async def cancel(self, did: str) -> dict[str, Any] | None:
        """Cancel a queued delivery (not one already submitted to Hermes)."""
        d = await self.store.run(self.store.update_delivery, did, ("queued",), status="cancelled",
                                 error="cancelled")
        if d:
            self._publish(d)
            await self._finish(d)
        return d

    async def resolve(self, to: Any, call_timeout: float = RESOLVE_CALL_TIMEOUT) -> Target:
        """Parse and resolve an address; an unknown project triggers one projects.list rescan
        (bounded by call_timeout). Raises Rejected."""
        try:
            a = parse_address(to if isinstance(to, str) else "")
        except ValueError as e:
            raise Rejected("bad_address", str(e)) from None
        node = a["node"]
        st = self.links.nodes.get(node)
        if st is None:
            raise Rejected("unknown_target", f"no node named {node}")
        project, sid = a["project"], a["stored_id"]
        if project is None:
            return Target(node, format_address(node, None, sid), None, None, sid, None)
        proj = st.find_project(name=project)
        if proj is None and self.links.is_online(node):
            with contextlib.suppress(RemoteError, NodeUnavailable, ConnectionError, TimeoutError):
                res = await self.links.call(node, "projects.list", {}, timeout=call_timeout)
                if isinstance(res.get("projects"), list):
                    await self.links.update_info(node, projects=res["projects"])
                    proj = st.find_project(name=project)
        if proj is None or not proj.get("path"):
            raise Rejected("unknown_project", f"{node} has no project {project}")
        return Target(node, format_address(node, project, sid), project, proj["path"], sid,
                      self._canonical_for(node, proj["path"]))

    def _canonical_for(self, node: str, path: str | None) -> str | None:
        """Canonical stored id for a project path: node's last report, else last session.ensure."""
        st = self.links.nodes.get(node)
        proj = st.find_project(path=path) if st and path else None
        canon = ((proj or {}).get("canonical") or {}).get("stored_id")
        return canon or self._canon.get((node, path or ""))

    async def _target_busy(self, t: Target) -> bool:
        node, sid = t.key
        if self.live.is_running(node, sid):
            return True
        if not t.stored and t.path:
            proj = self.links.nodes[node].find_project(path=t.path)
            if proj and (proj.get("canonical") or {}).get("running"):
                return True
        if t.key in self._dispatching:
            return True
        for status in ACTIVE_STATUSES:
            for d in await self.store.run(self.store.deliveries_by_status, status, node):
                if self._row_key(d) == t.key:
                    return True
        return False

    def _would_deadlock(self, sender: SessionKey, t: Target, chain: list[str]) -> bool:
        if t.key == sender:
            return True
        # Walk the wait-for graph from the target: does it (transitively) wait on the sender?
        edges: dict[SessionKey, set[SessionKey]] = {}
        for src, dst in self._waits.values():
            edges.setdefault(src, set()).add(dst)
        stack, seen = [t.key], set()
        while stack:
            k = stack.pop()
            if k == sender:
                return True
            if k not in seen:
                seen.add(k)
                stack.extend(edges.get(k, ()))
        # Target already upstream in this causal chain: it is (or may be) blocked on us.
        for addr in chain:
            if addr == t.addr:
                return True
            with contextlib.suppress(ValueError):
                a = parse_address(addr)
                if a["node"] != t.node:
                    continue
                if a["stored_id"] and a["stored_id"] == (t.stored or t.canonical_hint):
                    return True
                if a["project"] and a["project"] == t.project and not a["stored_id"] and not t.stored:
                    return True
        return False

    def _row_key(self, d: dict[str, Any]) -> SessionKey:
        node = d["to_node"]
        if d.get("to_stored"):
            return (node, d["to_stored"])
        return (node, self._canonical_for(node, d.get("to_path")) or f"path:{d.get('to_path')}")

    # --- link events -----------------------------------------------------------------
    async def on_hello(self, node: str, inflight: list[str]) -> None:
        """Dispatched deliveries the restarted/reconnected link doesn't know about are lost."""
        known = set(inflight)
        self._last_inflight[node] = known
        for d in await self.store.run(self.store.deliveries_by_status, "dispatched", node):
            if d["id"] in known:
                continue
            await self._fail(d["id"], "node_restarted", ("dispatched",))

    async def on_turn_done(self, node: str, f: dict[str, Any]) -> None:
        sid = f["stored_id"]
        did = f.get("delivery_id")
        d = None
        if isinstance(did, str) and did:
            d = await self.store.run(self.store.get_delivery, did)
        elif isinstance(f.get("user_row_id"), int):
            d = await self.store.run(self.store.find_dispatched_by_row, node, sid, f["user_row_id"])
        if d is None or d["to_node"] != node or d["status"] not in ACTIVE_STATUSES:
            return
        status = f.get("status")
        text = f.get("text") if isinstance(f.get("text"), str) else None
        err = f.get("error") if isinstance(f.get("error"), str) and f.get("error") else None
        fields: dict[str, Any] = {"to_stored": sid, "partial": bool(f.get("partial"))}
        if status == "error":
            # Keep any partial assistant text as the reply; the cause goes into error.
            fields.update(status="error", reply=text, error=err or text or "turn_error")
        else:
            fields.update(status="done", reply=text, error="interrupted" if status == "interrupted" else None)
        if isinstance(f.get("user_row_id"), int):
            fields["user_row_id"] = f["user_row_id"]
        upd = await self.store.run(self.store.update_delivery, d["id"], ACTIVE_STATUSES, **fields)
        if upd is None:
            return
        log.info("delivery %s %s (%s)", upd["id"], upd["status"], status)
        self._publish(upd)
        await self._finish(upd)

    async def on_session_tip(self, node: str, old: str, new: str) -> None:
        n = await self.store.run(self.store.retarget_session, node, old, new)
        old_k, new_k = (node, old), (node, new)
        for did, (src, dst) in list(self._waits.items()):
            self._waits[did] = (new_k if src == old_k else src, new_k if dst == old_k else dst)
        for ck, sid in list(self._canon.items()):
            if ck[0] == node and sid == old:
                self._canon[ck] = new
        if n:
            log.info("node %s session %s -> %s: retargeted %d deliveries", node, old, new, n)

    # --- completion ------------------------------------------------------------------
    async def _fail(self, did: str, error: str, only_if: tuple[str, ...] = ACTIVE_STATUSES) -> None:
        upd = await self.store.run(self.store.update_delivery, did, only_if, status="error", error=error)
        if upd is None:
            return
        log.warning("delivery %s failed: %s", did, error)
        self._attempts.pop(did, None)
        self._retry_at.pop(did, None)
        self._publish(upd)
        await self._finish(upd)

    async def _finish(self, d: dict[str, Any]) -> None:
        """Resolve a waiter, or inject the reply into the sender session."""
        fut = self._waiters.get(d["id"])
        waited = fut is not None and not fut.done()
        if waited:
            assert fut is not None
            fut.set_result(d)
        if d["kind"] == "message" and d["expect_reply"] and d.get("from_stored") and d.get("from_node") \
                and not waited and d["status"] in ("done", "error"):
            await self._inject_reply(d)
        self.kick()

    async def _inject_reply(self, d: dict[str, Any]) -> None:
        if d["status"] == "done":
            body = d.get("reply")
            if d.get("error") == "interrupted":
                body = (body or "") + "\n\n(the target's turn was interrupted; this reply may be incomplete)"
        else:
            body = f"(delivery failed: {d.get('error') or 'error'} — no reply will come)"
        try:
            fa = parse_address(d["from_addr"])
            to_addr = format_address(fa["node"], fa["project"], d["from_stored"])
        except ValueError:
            to_addr = format_address(d["from_node"], None, d["from_stored"])
        rid = new_delivery_id()
        await self.store.run(self.store.insert_delivery, {
            "id": rid, "kind": "reply", "parent_id": d["id"],
            "from_node": d["to_node"], "from_stored": d.get("to_stored"), "from_addr": d["to_addr"],
            "to_node": d["from_node"], "to_addr": to_addr, "to_path": None, "to_stored": d["from_stored"],
            "message": body or "", "expect_reply": False, "chain": d.get("chain") or [],
        })
        r = await self.store.run(self.store.get_delivery, rid)
        if r:
            log.info("delivery %s: reply %s queued for %s", d["id"], rid, to_addr)
            self._publish(r)

    def _publish(self, d: dict[str, Any]) -> None:
        self.live.publish_all({"type": "delivery", "delivery": d})

    # --- dispatcher ------------------------------------------------------------------
    async def _dispatch_loop(self) -> None:
        last_reap = 0.0
        while True:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._kick.wait(), TICK_S)
            self._kick.clear()
            try:
                if time.monotonic() - last_reap > 300:
                    last_reap = time.monotonic()
                    await self._reap_stale()
                await self._dispatch_pass()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("dispatch pass failed")
                await asyncio.sleep(1)

    async def _dispatch_pass(self) -> None:
        queued = await self.store.run(self.store.deliveries_by_status, "queued")
        if not queued:
            return
        dispatched = await self.store.run(self.store.deliveries_by_status, "dispatched")
        busy = {self._row_key(d) for d in dispatched} | set(self._dispatching)
        now = time.monotonic()
        for d in queued:
            if not self.links.is_online(d["to_node"]) or self._retry_at.get(d["id"], 0) > now:
                continue
            key = self._row_key(d)
            if key in busy:
                continue
            busy.add(key)
            self._dispatching.add(key)
            t = asyncio.create_task(self._dispatch_one(d, key))
            self._tasks.add(t)
            t.add_done_callback(self._tasks.discard)

    async def _dispatch_one(self, d: dict[str, Any], key: SessionKey) -> None:
        did, node = d["id"], d["to_node"]
        conn = self.links.get(node)
        submitted = False
        extra_keys: list[SessionKey] = []
        try:
            if conn is None:
                return
            stored = d.get("to_stored")
            if not stored:
                res = await conn.call("session.ensure", {"path": d["to_path"]}, LINK_CALL_TIMEOUT)
                stored = res.get("stored_id")
                if not isinstance(stored, str) or not stored:
                    raise RemoteError("bad_response", "session.ensure returned no stored_id")
                self._canon[(node, d["to_path"] or "")] = stored
                await self.store.run(self.store.update_delivery, did, ("queued",), to_stored=stored)
            att = await conn.call("session.attach", {"stored_id": stored}, LINK_CALL_TIMEOUT)
            tip = att.get("stored_id")
            if isinstance(tip, str) and STORED_ID_RE.match(tip) and tip != stored:
                # Compression moved the tip: retarget everything (this delivery included) and
                # prompt the live id; hold the new key so the next pass doesn't double-dispatch.
                await self.links.on_session_tip(node, stored, tip)
                stored = tip
                tip_key = (node, tip)
                if tip_key not in self._dispatching:
                    self._dispatching.add(tip_key)
                    extra_keys.append(tip_key)
            if d["kind"] == "reply":
                text = format_reply_text(did, d.get("parent_id") or "?", d.get("from_addr") or "?", d["message"])
            else:
                text = format_request_text(did, d.get("from_addr") or "human", d["message"], d["expect_reply"])
            if self.links.get(node) is not conn or conn.closed:
                return  # link replaced meanwhile; next pass uses the new one
            upd = await self.store.run(self.store.update_delivery, did, ("queued",), status="dispatched",
                                       dispatched_at=time.time(), to_stored=stored)
            if upd is None:
                return  # cancelled meanwhile
            submitted = True
            self._publish(upd)
            res = await conn.call("session.prompt", {"stored_id": stored, "text": text, "mode": "queue",
                                                     "delivery_id": did}, LINK_CALL_TIMEOUT)
            self._attempts.pop(did, None)
            self._retry_at.pop(did, None)
            log.info("delivery %s dispatched to %s#%s (%s)", did, node, stored, res.get("status"))
            if isinstance(res.get("user_row_id"), int):
                upd = await self.store.run(self.store.update_delivery, did, ("dispatched",),
                                           user_row_id=res["user_row_id"])
                if upd:
                    self._publish(upd)
        except RemoteError as e:
            if submitted:
                await self._fail(did, f"{e.code}: {e.message}")
            else:
                await self._transient(did, f"{e.code}: {e.message}")
        except (ConnectionError, NodeUnavailable, TimeoutError) as e:
            if not submitted:
                await self._transient(did, f"{type(e).__name__}: {e}")
            else:
                await self._unconfirmed(did, node, conn)
        finally:
            self._dispatching.discard(key)
            for k in extra_keys:
                self._dispatching.discard(k)

    async def _transient(self, did: str, err: str) -> None:
        n = self._attempts.get(did, 0) + 1
        self._attempts[did] = n
        if n >= MAX_DISPATCH_ATTEMPTS:
            await self._fail(did, f"dispatch failed {n} times: {err}", ("queued",))
            return
        log.warning("delivery %s: dispatch attempt %d failed (%s); retrying", did, n, err)
        self._retry_at[did] = time.monotonic() + RETRY_BACKOFF_S

    async def _unconfirmed(self, did: str, node: str, conn: LinkConnection | None) -> None:
        """session.prompt outcome unknown (link dropped or timed out). Normally the next hello's
        inflight list settles it; if a newer link already said hello, settle it now."""
        cur = self.links.get(node)
        if cur is not None and cur is not conn and did not in self._last_inflight.get(node, set()):
            await self._fail(did, "node_restarted", ("dispatched",))
        else:
            log.warning("delivery %s: prompt outcome unknown; waiting for turn.done or link hello", did)

    async def _reap_stale(self) -> None:
        cutoff = time.time() - STALE_DISPATCHED_S
        for d in await self.store.run(self.store.deliveries_by_status, "dispatched"):
            if (d.get("dispatched_at") or d["updated_at"]) < cutoff:
                await self._fail(d["id"], "stale: no turn.done received", ("dispatched",))




def _send_result(d: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"delivery_id": d["id"]}
    if d["status"] == "done":
        out.update(status="done", reply=d.get("reply") or "")
        if d.get("error"):
            out["reason"] = d["error"]
    elif d["status"] in ("error", "cancelled"):
        out.update(status="error", reason=d.get("error") or d["status"])
    else:
        out["status"] = "queued"
    return out


def _int(v: Any, default: int, lo: int, hi: int) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(n, hi))
