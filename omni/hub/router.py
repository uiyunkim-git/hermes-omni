"""Agent-to-agent message routing (design §5/§6, v3 spec §5.3).

- `agent.send` validates, resolves ``to`` (an address ``node#sid`` / ``node/folder#sid``, a folder
  ``node/folder``, or a session title, optionally ``node:title``) against the hub's session index
  and stores a delivery (id minted by the sender link, so retries are idempotent). wait=true blocks
  the caller until the target turn finishes or timeout_s passes, unless the target is busy or
  waiting would deadlock, in which case the send is downgraded to async ("target_busy_async").
- Loops are bounded twice: the causal chain (message → reply → message …) by MAX_HOPS, and the
  messages between one pair of sessions within one conversation by PAIR_MESSAGE_CAP. A
  conversation starts with a message sent from a turn that is not itself a delivery turn.
- The dispatcher keeps at most one 'dispatched' delivery per target session and submits it
  with link `session.prompt {mode:"queue"}`; deliveries are FIFO per target. Dispatching also
  tells the target's open chats (`session.incoming`).
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

from omni.proto import (MAX_HOPS, MESSAGE_MAX_CHARS, PAIR_MESSAGE_CAP, STORED_ID_RE, TO_MAX, WAIT_DEFAULT_S,
                        WAIT_MAX_S, RemoteError, clean_title, format_address, format_reply_text,
                        format_request_text, new_delivery_id, session_key, try_parse_address)

from .links import LinkConnection, LinkManager, NodeUnavailable
from .sessions import SessionIndex, row_title
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
RESOLVE_CALL_TIMEOUT = 20.0   # folders.list / session.create while resolving a folder target
CANDIDATES_MAX = 5
DIRECTORY_SESSIONS_MAX = 60
_MENTION_TAIL_RE = re.compile(r"\(([^()\s]+)\)\s*$")

SessionKey = tuple[str, str]   # (node_id, stored_id or "path:<abs>")


class Rejected(Exception):
    def __init__(self, reason: str, message: str = "", **extra: Any):
        super().__init__(message or reason)
        self.reason = reason
        self.message = message or reason
        self.extra = extra


@dataclass
class Target:
    node: str
    stored: str | None            # concrete session (None: folder target on an offline node)
    path: str | None = None       # folder path (folder targets)
    folder: str | None = None     # folder name
    title: str | None = None

    @property
    def key(self) -> SessionKey:
        return (self.node, self.stored or f"path:{self.path}")

    @property
    def addr(self) -> str:
        return session_key(self.node, self.stored) if self.stored else format_address(self.node, self.folder)


class Router:
    def __init__(self, store: Store, links: LinkManager, index: SessionIndex):
        self.store = store
        self.links = links
        self.index = index
        self.live: Live   # wired by the server
        self._waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        # Active synchronous waits: delivery id -> (sender, target). Edges of the wait-for graph.
        self._waits: dict[str, tuple[SessionKey, SessionKey]] = {}
        self._dispatching: set[SessionKey] = set()
        self._attempts: dict[str, int] = {}
        self._retry_at: dict[str, float] = {}
        self._last_inflight: dict[str, set[str]] = {}
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
            sid = params.get("stored_id")
            query = params.get("query")
            return self.directory(query if isinstance(query, str) else None,
                                  (node, sid) if isinstance(sid, str) else None)
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

    def directory(self, query: str | None = None, you: SessionKey | None = None) -> dict[str, Any]:
        nodes = [{"node_id": st.node_id, "display_name": st.info.get("display_name") or st.node_id,
                  "online": self.links.is_online(st.node_id)}
                 for st in sorted(self.links.nodes.values(), key=lambda s: s.node_id)]
        if query and query.strip():
            rows = self.index.search(query, limit=DIRECTORY_SESSIONS_MAX, include_hidden=False)
        else:
            rows = [r for r in self.index.hub_rows() if not r.get("hidden")][:DIRECTORY_SESSIONS_MAX]
        sessions = [{"address": r["key"], "title": row_title(r), "node": r["node"],
                     "folder": (r.get("folder") or {}).get("name"), "running": bool(r.get("running")),
                     "online": r.get("node_online"), "last_active": r.get("last_active"),
                     "you": you is not None and (r["node"], r["stored_id"]) == you} for r in rows]
        folders = []
        for st in sorted(self.links.nodes.values(), key=lambda s: s.node_id):
            for p in st.info.get("projects") or []:
                if isinstance(p, dict) and p.get("name") and not p.get("is_root"):
                    if query and query.strip() and query.strip().lower() not in str(p["name"]).lower():
                        continue
                    folders.append({"address": format_address(st.node_id, p["name"]), "node": st.node_id,
                                    "name": p["name"]})
        return {"nodes": nodes, "sessions": sessions, "folders": folders}

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
            return {"delivery_id": did, "status": "rejected", "reason": r.reason, **r.extra}

        target_key = row.pop("_target_key")
        if not await self.store.run(self.store.insert_delivery, row):
            existing = await self.store.run(self.store.get_delivery, did)
            return _send_result(existing) if existing else {"delivery_id": did, "status": "error", "reason": "conflict"}
        d = await self.store.run(self.store.get_delivery, did)
        assert d is not None
        log.info("delivery %s queued: %s -> %s (wait=%s%s)", did, row["from_addr"], row["to_addr"], wait,
                 f", {reason}" if reason else "")
        self._publish(d)
        if not wait:
            self.kick()
            out: dict[str, Any] = {"delivery_id": did, "status": "queued", **_target_fields(d)}
            if reason:
                out["reason"] = reason
            return out

        sender: SessionKey = (node, row["from_stored"])
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._waiters[did] = fut
        self._waits[did] = (sender, target_key)
        self.kick()
        try:
            remaining = max(0.0, timeout_s - (time.monotonic() - t0))
            done = await asyncio.wait_for(asyncio.shield(fut), remaining)
            return _send_result(done)
        except TimeoutError:
            log.info("delivery %s: wait timed out after %ss; reply will be injected later", did, timeout_s)
            return {"delivery_id": did, "status": "timeout", **_target_fields(d),
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
        sender: SessionKey = (node, from_stored)

        def budget(cap: float) -> float:
            """Link-call timeout during validation: never beyond the caller's wait budget."""
            if not wait:
                return cap
            return min(cap, max(1.0, timeout_s - (time.monotonic() - t0)))

        target = await self.resolve(p.get("to"), sender, budget(RESOLVE_CALL_TIMEOUT))
        conv_id = await self._conversation(p.get("cause_id"), did)
        if target.stored:
            n = await self.store.run(self.store.count_pair_messages, conv_id, sender, (target.node, target.stored))
            if n >= PAIR_MESSAGE_CAP:
                raise Rejected("collab_limit", f"{n} messages between these sessions in this conversation")
        reason = None
        if wait:
            busy = await self._target_busy(target)
            if busy or self._would_deadlock(sender, target, chain):
                wait, reason = False, "target_busy_async"
            elif not self.links.is_online(target.node):
                wait = False
        if not self.links.is_online(target.node):
            reason = "offline_queued"
        sender_row = self.index.get(node, from_stored)
        from_title = p.get("from_title") if isinstance(p.get("from_title"), str) and p.get("from_title") \
            else (row_title(sender_row) if sender_row else None)
        row = {
            "id": did, "kind": "message", "from_node": node, "from_stored": from_stored,
            "from_addr": session_key(node, from_stored), "from_title": clean_title(from_title) or None,
            "to_node": target.node, "to_addr": target.addr, "to_path": target.path, "to_stored": target.stored,
            "to_title": target.title, "conv_id": conv_id,
            "message": message, "expect_reply": expect_reply, "wait": wait, "chain": chain,
            "_target_key": target.key,
        }
        return row, wait, timeout_s, reason

    async def _conversation(self, cause_id: Any, did: str) -> str:
        """The conversation a new message belongs to: that of the delivery its sender is answering
        (a message or reply turn), or a new one when the sender's turn came from its user."""
        if isinstance(cause_id, str) and DELIVERY_ID_RE.match(cause_id):
            cause = await self.store.run(self.store.get_delivery, cause_id)
            if cause is not None:
                return cause.get("conv_id") or cause["id"]
        return did

    async def human_send(self, to: Any, message: Any, expect_reply: bool) -> dict[str, Any]:
        """POST /api/send: a human -> session message (debugging aid). Raises Rejected."""
        if not isinstance(message, str) or not message.strip():
            raise Rejected("empty_message")
        if len(message) > MESSAGE_MAX_CHARS:
            raise Rejected("message_too_long")
        target = await self.resolve(to, None)
        did = new_delivery_id()
        await self.store.run(self.store.insert_delivery, {
            "id": did, "kind": "message", "from_node": None, "from_stored": None, "from_addr": "human",
            "to_node": target.node, "to_addr": target.addr, "to_path": target.path, "to_stored": target.stored,
            "to_title": target.title, "conv_id": did, "message": message, "expect_reply": expect_reply, "chain": [],
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

    # --- target resolution -----------------------------------------------------------
    async def resolve(self, to: Any, sender: SessionKey | None,
                      call_timeout: float = RESOLVE_CALL_TIMEOUT) -> Target:
        """Resolve ``to`` (v3 spec §5.3 order). Raises Rejected."""
        if not isinstance(to, str) or not to.strip() or len(to.strip()) > TO_MAX + 40:
            raise Rejected("bad_target", "to must be a non-empty string")
        s = to.strip()
        if s.startswith("@"):
            s = s[1:].strip()
        if s.lower().startswith("omni:"):
            s = s[5:].strip()
        m = _MENTION_TAIL_RE.search(s)
        if m and try_parse_address(m.group(1)):
            s = m.group(1)   # "@Title (node#sid)" mention: the address wins
        a = try_parse_address(s)
        if a is not None and a["node"] in self.links.nodes:
            target = await self._resolve_address(a, call_timeout)
        else:
            target = self._resolve_title(s)
        if sender is not None and target.stored and (target.node, target.stored) == sender:
            raise Rejected("self", "a session cannot message itself")
        return target

    async def _resolve_address(self, a: dict[str, str | None], call_timeout: float) -> Target:
        node = str(a["node"])
        sid, folder = a["stored_id"], a["project"]
        if sid:
            row = self.index.get(node, sid)
            return Target(node, sid, title=row_title(row) if row else None,
                          folder=(row.get("folder") or {}).get("name") if row else folder)
        st = self.links.nodes[node]
        proj = st.find_project(name=folder)
        if proj is None and self.links.is_online(node):
            with contextlib.suppress(RemoteError, NodeUnavailable, ConnectionError, TimeoutError):
                res = await self.links.call(node, "folders.list", {}, timeout=call_timeout)
                if isinstance(res.get("folders"), list):
                    await self.links.update_info(node, projects=res["folders"])
                    proj = st.find_project(name=folder)
        if proj is None or not proj.get("path"):
            raise Rejected("unknown_target", f"{node} has no folder {folder}",
                           suggestions=self._suggestions(str(folder or "")))
        path = str(proj["path"])
        target = Target(node, None, path=path, folder=str(folder))
        await self._bind_folder(target, call_timeout)
        return target

    async def _bind_folder(self, t: Target, call_timeout: float = LINK_CALL_TIMEOUT) -> None:
        """A folder target becomes its most recent session, or a new one titled after the folder.
        Without a link (offline node) the target stays a folder and is bound at dispatch."""
        rows = [r for r in self.index.rows.get(t.node, {}).values()
                if not r.get("hidden") and (r.get("folder") or {}).get("path") == t.path]
        if rows:
            best = max(rows, key=lambda r: r.get("last_active") or 0)
            t.stored, t.title = best["stored_id"], row_title(best)
            return
        if not self.links.is_online(t.node):
            t.title = t.folder
            return
        try:
            res = await self.links.call(t.node, "session.create", {"path": t.path, "title": t.folder},
                                        timeout=call_timeout)
        except (RemoteError, NodeUnavailable, ConnectionError, TimeoutError) as e:
            raise Rejected("unknown_target", f"could not start a session in {t.folder}: {e}") from None
        t.stored, t.title = res.get("stored_id"), res.get("title") or t.folder
        row = res.get("row")
        if isinstance(row, dict) and isinstance(row.get("stored_id"), str):
            await self.index.on_update(t.node, False, [row], [])
        log.info("started session %s#%s in folder %s for a message", t.node, t.stored, t.folder)

    def _resolve_title(self, s: str) -> Target:
        scope: str | None = None
        title = s
        head, sep, rest = s.partition(":")
        if sep and head.strip().lower() in self.links.nodes and rest.strip():
            scope, title = head.strip().lower(), rest.strip()
        q = title.strip().lower()
        rows = [(n, r) for n, r in self.index.all_rows()
                if not r.get("hidden") and (scope is None or n == scope)]
        exact = [(n, r) for n, r in rows if (r.get("title") or "").strip().lower() == q]
        matches = exact or [(n, r) for n, r in rows if (r.get("title") or "").strip().lower().startswith(q)]
        if len(matches) == 1:
            n, r = matches[0]
            return Target(n, r["stored_id"], title=row_title(r), folder=(r.get("folder") or {}).get("name"))
        if matches:
            matches.sort(key=lambda x: x[1].get("last_active") or 0, reverse=True)
            cands = [{"address": session_key(n, r["stored_id"]), "title": row_title(r), "node": n,
                      "folder": (r.get("folder") or {}).get("name")} for n, r in matches[:CANDIDATES_MAX]]
            raise Rejected("ambiguous_target", f"{len(matches)} sessions match {title!r}", candidates=cands)
        raise Rejected("unknown_target", f"no session matches {title!r}",
                       suggestions=self._suggestions(title, scope))

    def _suggestions(self, q: str, node: str | None = None) -> list[dict[str, Any]]:
        return [{"address": r["key"], "title": row_title(r), "node": r["node"],
                 "folder": (r.get("folder") or {}).get("name")}
                for r in self.index.search(q, node=node, limit=CANDIDATES_MAX, include_hidden=False)]

    async def _target_busy(self, t: Target) -> bool:
        node, sid = t.key
        if self.live.is_running(node, sid):
            return True
        row = self.index.get(node, sid)
        if row and row.get("running"):
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
            a = try_parse_address(addr)
            if a is None or a["node"] != t.node:
                continue
            if a["stored_id"] and a["stored_id"] == t.stored:
                return True
            if a["project"] and not a["stored_id"] and a["project"] == t.folder:
                return True
        return False

    @staticmethod
    def _row_key(d: dict[str, Any]) -> SessionKey:
        node = d["to_node"]
        if d.get("to_stored"):
            return (node, d["to_stored"])
        return (node, f"path:{d.get('to_path')}")

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
        to_addr = session_key(d["from_node"], d["from_stored"])
        from_addr = session_key(d["to_node"], d["to_stored"]) if d.get("to_stored") else d["to_addr"]
        rid = new_delivery_id()
        await self.store.run(self.store.insert_delivery, {
            "id": rid, "kind": "reply", "parent_id": d["id"],
            "from_node": d["to_node"], "from_stored": d.get("to_stored"), "from_addr": from_addr,
            "from_title": d.get("to_title"), "to_node": d["from_node"], "to_addr": to_addr, "to_path": None,
            "to_stored": d["from_stored"], "to_title": d.get("from_title"), "conv_id": d.get("conv_id") or d["id"],
            "message": body or "", "expect_reply": False, "chain": d.get("chain") or [],
        })
        r = await self.store.run(self.store.get_delivery, rid)
        if r:
            log.info("delivery %s: reply %s queued for %s", d["id"], rid, to_addr)
            self._publish(r)

    def _publish(self, d: dict[str, Any]) -> None:
        self.live.publish_delivery(d)
        self.index.deliveries_changed()

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
                # A folder target queued while its node was offline: bind it now.
                t = Target(node, None, path=d.get("to_path"), folder=_folder_of(d.get("to_addr")))
                try:
                    await self._bind_folder(t)
                except Rejected as r:
                    raise RemoteError("unknown_target", r.message) from None
                if not t.stored:
                    raise RemoteError("bad_response", "no session for the folder target")
                stored = t.stored
                await self.store.run(self.store.update_delivery, did, ("queued",), to_stored=stored,
                                     to_title=t.title)
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
                text = format_reply_text(did, d.get("parent_id") or "?", d.get("from_addr") or "?", d["message"],
                                         from_title=d.get("from_title"))
            else:
                text = format_request_text(did, d.get("from_addr") or "human", d["message"], d["expect_reply"],
                                           from_title=d.get("from_title"))
            if self.links.get(node) is not conn or conn.closed:
                return  # link replaced meanwhile; next pass uses the new one
            upd = await self.store.run(self.store.update_delivery, did, ("queued",), status="dispatched",
                                       dispatched_at=time.time(), to_stored=stored)
            if upd is None:
                return  # cancelled meanwhile
            submitted = True
            self._publish(upd)
            self.live.publish_incoming(node, stored, upd)
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
            elif e.code in ("not_found", "unknown_target"):
                await self._fail(did, f"{e.code}: {e.message}", ("queued",))
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


def _folder_of(addr: Any) -> str | None:
    a = try_parse_address(addr)
    return a["project"] if a else None


def _target_fields(d: dict[str, Any]) -> dict[str, Any]:
    addr = session_key(d["to_node"], d["to_stored"]) if d.get("to_stored") else d.get("to_addr")
    return {"to_address": addr, "to_title": d.get("to_title")}


def _send_result(d: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"delivery_id": d["id"], **_target_fields(d)}
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
