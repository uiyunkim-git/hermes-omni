"""LinkAgent: wires Hermes, the session registry and index, the hub connection and the bridge together.

Owns NodeInfo/folder scanning, the periodic ``node`` heartbeat, the hub→link method table
(v3 spec §5.2) and the reliable delivery of ``turn.done`` frames for deliveries.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import time
from typing import Any

from omni import PROTO, __version__
from omni.proto import (EXCLUDED_SOURCES, MARKER_RE, NEW_PROJECT_NAME_RE, STORED_ID_RE, TITLE_MAX, Forbidden,
                        check_rest, check_rpc, format_address, parse_omni_header, rpc_timeout, session_key)
from omni.link.config import Config
from omni.link.files import FileOpError, Files
from omni.link.gpu import gpu_stats
from omni.link.hermes import HermesClient, HermesError, HermesUnavailable
from omni.link.hubconn import HandlerError, HubConnection
from omni.link.index import SessionIndex
from omni.link.projects import ProjectDir, project_for_path, scan
from omni.link.sessions import MESSAGES_MAX, SessionManager, SessionOpError
from omni.link.state import LinkState
from omni.link.util import TaskSet, to_text

log = logging.getLogger("omni.link.agent")

NODE_REFRESH_S = 30      # rescan folders / hermes / gpu
NODE_FORCE_S = 60        # send a node frame at least this often (heartbeat)
FILES_HOUSEKEEPING_S = 30
SEARCH_LIMIT_MAX = 50
SEARCH_RESNIP_ROWS = 300       # transcript rows scanned to re-snip a noisy full-text hit
SEARCH_RESNIP_TIMEOUT_S = 2.5  # within the hub's per-node search timeout
SEARCH_RESNIP_PARALLEL = 6
SNIPPET_BEFORE = 40
SNIPPET_AFTER = 140
_HL_RE = re.compile(r">>>(.*?)<<<", re.S)
_WS_RE = re.compile(r"\s+")
# A JSON object key, plain or escaped inside a JSON string ("path": / \"path\":): tool-call arguments.
_JSON_KEY_RE = re.compile(r'\\?"[A-Za-z_][A-Za-z0-9_]*\\?"\s*:')
# Hangul, kana and CJK ideographs: Hermes searches these by substring, not by FTS word prefix.
_CJK_RE = re.compile("[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3]")
# Text of omni delivery rows that is not the message itself (header line, instruction tails).
_DELIVERY_FRAGMENTS = ("⟦omni:", "hermes-omni", "Answer in your final reply", "hub_send your answer back",
                       "You may ask clarifying questions in your reply", "This is the reply to your message",
                       "Continue the task your user gave you", "No reply is expected")


def search_terms(q: str) -> list[str]:
    """The words of a search query as Hermes matches them (quotes, ``*`` and FTS operators dropped)."""
    terms: list[str] = []
    for tok in re.findall(r'"[^"]*"|\S+', q):
        for t in tok.strip('"').split():
            t = t.strip("*")
            if t and t not in ("AND", "OR", "NOT") and t.casefold() not in (x.casefold() for x in terms):
                terms.append(t)
    return terms


def hermes_search_query(q: str) -> str:
    """The query to send to Hermes' ``/api/sessions/search``.

    Hermes appends ``*`` to every unquoted word, which makes its CJK route (substring search) match
    nothing. A query with CJK text is therefore sent as one quoted phrase of its words: that route
    then matches messages containing every word."""
    if not _CJK_RE.search(q):
        return q
    return '"' + " ".join(search_terms(q)) + '"'


def _term_pattern(terms: list[str]) -> re.Pattern[str] | None:
    if not terms:
        return None
    return re.compile("|".join(re.escape(t) for t in sorted(terms, key=len, reverse=True)), re.I)


def search_snippet(raw: Any, terms: list[str] | None = None) -> tuple[str, list[list[int]]]:
    """Hermes FTS snippet (``>>>hit<<<`` markers) → one line of plain text + highlight ranges
    [start, end). Omni delivery markers are removed so they never reach the UI. Snippets from
    Hermes' substring routes carry no markers; their ranges come from ``terms``."""
    text = raw if isinstance(raw, str) else ""
    pieces: list[tuple[str, bool]] = []
    pos = 0
    for m in _HL_RE.finditer(text):
        pieces += [(text[pos:m.start()], False), (m.group(1), True)]
        pos = m.end()
    pieces.append((text[pos:], False))
    out: list[str] = []
    ranges: list[list[int]] = []
    n = 0
    for i, (piece, hit) in enumerate(pieces):
        piece = _WS_RE.sub(" ", MARKER_RE.sub("", piece).replace(">>>", "").replace("<<<", ""))
        if i == 0:
            piece = piece.lstrip()
            piece = "…" + piece[3:] if piece.startswith("...") else piece
        if i == len(pieces) - 1:
            piece = piece.rstrip()
            piece = piece[:-3] + "…" if piece.endswith("...") else piece
        if piece.startswith(" ") and out and out[-1].endswith(" "):
            piece = piece[1:]
        if hit and piece:
            ranges.append([n, n + len(piece)])
        out.append(piece)
        n += len(piece)
    plain = "".join(out)
    if not ranges and (pattern := _term_pattern(terms or [])) is not None:
        ranges = [[m.start(), m.end()] for m in pattern.finditer(plain)]
    return plain, ranges


def search_hit_is_noise(role: Any, snippet: Any) -> bool:
    """True for a full-text hit the UI must not show as is: a tool result, or an assistant row
    whose match sits in its tool-call JSON (Hermes indexes ``tool_calls`` with the content), or a
    delivered agent message whose excerpt includes the omni header or instructions."""
    if role is None:
        return False
    if role not in ("user", "assistant"):
        return True
    text = snippet.replace(">>>", "").replace("<<<", "") if isinstance(snippet, str) else ""
    if role == "user":
        return any(f in text for f in _DELIVERY_FRAGMENTS)
    return bool(_JSON_KEY_RE.search(text))


def text_snippet(text: str, terms: list[str]) -> tuple[str, list[list[int]]] | None:
    """A one-line excerpt of ``text`` around the first occurrence of any term, with highlight
    ranges [start, end) for every occurrence inside it; None when no term occurs."""
    pattern = _term_pattern(terms)
    flat = " ".join(text.split())
    m = pattern.search(flat) if pattern is not None else None
    if m is None:
        return None
    first = m.start()
    start = max(0, first - SNIPPET_BEFORE)
    if start:
        space = flat.find(" ", start, first)
        start = space + 1 if space >= 0 else start
    end = min(len(flat), first + SNIPPET_AFTER)
    if end < len(flat):
        space = flat.rfind(" ", first, end)
        end = space if space > first + SNIPPET_AFTER // 2 else end
    prefix = "…" if start else ""
    seg = flat[start:end]
    spans = [[h.start() + len(prefix), h.end() + len(prefix)] for h in pattern.finditer(seg)]
    return prefix + seg + ("…" if end < len(flat) else ""), spans


class LinkAgent:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.state = LinkState(cfg.state_dir)
        self.state.load()
        self.sessions = SessionManager(cfg, self.state, emit=self._emit, emit_turn_done=self._emit_turn_done)
        self.hermes = HermesClient(cfg, on_event=self.sessions.on_event,
                                   on_server_request=self.sessions.on_server_request,
                                   on_connected=self._on_hermes_connected,
                                   on_disconnected=self._on_hermes_disconnected)
        self.sessions.bind(self.hermes)
        self.hub = HubConnection(cfg, build_hello=self._build_hello, handle_request=self._handle,
                                 on_welcome=self._on_welcome, on_status=self._on_hub_status)
        self.projects: list[ProjectDir] = scan(cfg.workspace, cfg.project_roots)
        self.index = SessionIndex(self.sessions, lambda: self.projects, emit=self.hub.send_event,
                                  workspace=cfg.workspace)
        self.files = Files(cfg.project_roots, os.path.join(cfg.state_dir, "tmp"))
        s = self.sessions
        s.on_live_change = self.index.patch_live
        s.on_message = self.index.note_message
        s.on_rotate = self.index.rotate
        s.on_sessions_changed = self.index.trigger
        s.cost_for = lambda sid: (self.index.get(sid) or {}).get("usage")
        self._node_info: dict[str, Any] | None = None
        self._node_sent_json: str | None = None
        self._node_sent_at = 0.0
        self._refresh_now = asyncio.Event()
        self._tasks = TaskSet("agent")
        self._hermes_status: dict[str, Any] = {"ok": False, "version": None, "gateway_state": None, "model": None}

    # --- lifecycle -----------------------------------------------------------------------
    async def start(self) -> None:
        self.state.write_status(False, self.cfg.hub_url, self.cfg.node_id)
        self.files.sweep_tmp()
        await self.hermes.start()
        self.sessions.start()
        self.index.start()
        await self.hub.start()
        self._tasks.spawn(self._node_loop(), name="node-loop")
        self._tasks.spawn(self._files_loop(), name="files-housekeeping")

    async def stop(self) -> None:
        await self._tasks.cancel_all()
        await self.hub.close()
        await self.index.close()
        await self.sessions.close()
        await self.hermes.close()
        self.files.close_all()
        self.state.save_now()
        self.state.write_status(False, self.cfg.hub_url, self.cfg.node_id)

    async def _files_loop(self) -> None:
        while True:
            await asyncio.sleep(FILES_HOUSEKEEPING_S)
            self.files.expire()

    # --- hub plumbing --------------------------------------------------------------------
    def _emit(self, frame: dict) -> None:
        self.hub.send_event(frame)

    def _emit_turn_done(self, frame: dict) -> None:
        did = frame.get("delivery_id")
        if not did:
            self.hub.send_event(frame)
            return
        # Retire the inflight entry only once the hub has processed the frame (ping/pong ack).
        # Until then it stays in link.json, is listed in the next hello's inflight (so the hub does
        # not fail it as node_restarted) and is re-sent after the welcome; the hub ignores repeats.
        self.hub.send_event(frame, on_acked=lambda: self._retire(did))

    def _retire(self, delivery_id: str) -> None:
        if self.state.inflight.pop(delivery_id, None) is not None:
            self.state.mark_dirty()

    async def _build_hello(self) -> dict[str, Any]:
        info = await self.node_info(refresh=self._node_info is None)
        self._node_sent_json = json.dumps(info, sort_keys=True, default=str)
        self._node_sent_at = time.monotonic()
        return {"t": "hello", "node": info, "inflight": sorted(self.state.inflight)}

    async def _on_welcome(self) -> None:
        self.index.on_hub_welcome()
        for did, entry in list(self.state.inflight.items()):
            if "done" in entry:
                self._emit_turn_done(entry["done"])
        # Live state the hub lost with the old connection: meta and queues of watched sessions.
        for a in list(self.sessions.by_stored.values()):
            meta = self.sessions.meta_for(a.stored_id)
            if meta:
                self._emit({"t": "ev", "kind": "session.meta", "stored_id": a.stored_id, "meta": meta})

    def _on_hub_status(self, connected: bool) -> None:
        self.state.write_status(connected, self.cfg.hub_url, self.cfg.node_id)

    async def _on_hermes_connected(self, epoch: str | None) -> None:
        await self.sessions.on_hermes_connected(epoch)
        self.index.trigger(full=True)
        self._refresh_now.set()

    async def _on_hermes_disconnected(self) -> None:
        await self.sessions.on_hermes_disconnected()
        self._refresh_now.set()

    # --- NodeInfo ------------------------------------------------------------------------
    async def _node_loop(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self._refresh_now.wait(), NODE_REFRESH_S)
            except asyncio.TimeoutError:
                pass
            self._refresh_now.clear()
            try:
                info = await self.node_info(refresh=True)
            except Exception:  # noqa: BLE001
                log.exception("node info refresh failed")
                continue
            if not self.hub.connected.is_set():
                continue
            encoded = json.dumps(info, sort_keys=True, default=str)
            if encoded != self._node_sent_json or time.monotonic() - self._node_sent_at >= NODE_FORCE_S - 1:
                if self.hub.send_event({"t": "node", "node": info}):
                    self._node_sent_json, self._node_sent_at = encoded, time.monotonic()

    def request_node_refresh(self) -> None:
        self._refresh_now.set()

    async def node_info(self, refresh: bool = True) -> dict[str, Any]:
        if refresh or self._node_info is None:
            status, gpus = await asyncio.gather(self.hermes.probe(), gpu_stats())
            self.projects = scan(self.cfg.workspace, self.cfg.project_roots)
            self._hermes_status = status
            self._node_info = {
                "node_id": self.cfg.node_id, "display_name": self.cfg.display_name, "hostname": self.cfg.hostname,
                "role": self.cfg.role, "link_version": __version__, "proto": PROTO,
                "hermes": status, "dashboard_url": self.cfg.dashboard_url, "gpus": gpus,
                "project_roots": list(self.cfg.project_roots), "workspace": self.cfg.workspace,
                "projects": self.folder_dicts(),
            }
        return self._node_info

    def folder_dicts(self) -> list[dict[str, Any]]:
        """Folders (immediate subfolders of the project roots) with session stats from the index.
        The workspace root itself is not a folder: sessions there count as "no folder"."""
        stats = self.index.folder_stats()
        out = []
        for p in self.projects:
            if p.is_root:
                continue
            count, last = stats.get(p.path, (0, None))
            out.append({"name": p.name, "path": p.path, "root": p.root, "is_root": False, "is_git": p.is_git,
                        "git_branch": p.git_branch, "address": format_address(self.cfg.node_id, p.name),
                        "session_count": count, "last_active": last})
        return out

    def project_by_path(self, path: str) -> ProjectDir | None:
        return project_for_path(self.projects, path) or project_for_path(
            scan(self.cfg.workspace, self.cfg.project_roots), path)

    def _within_roots(self, path: str) -> bool:
        real = os.path.realpath(path)
        return any(real == os.path.realpath(r) or real.startswith(os.path.realpath(r).rstrip("/") + "/")
                   for r in self.cfg.project_roots)

    # --- addresses (bridge) --------------------------------------------------------------
    def address_for_session(self, stored_id: str) -> str:
        return session_key(self.cfg.node_id, stored_id)

    def title_for_session(self, stored_id: str) -> str | None:
        row = self.index.get(stored_id)
        if row is None:
            return None
        return row.get("title") or row.get("first_prompt") or None

    # --- hub → link methods --------------------------------------------------------------
    async def _handle(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        fn = self._methods.get(method)
        if fn is None:
            raise HandlerError("unknown_method", f"unknown method {method!r}")
        try:
            return await fn(self, params)
        except HandlerError:
            raise
        except SessionOpError as e:
            raise HandlerError(e.code, e.message, **e.extra) from e
        except FileOpError as e:
            raise HandlerError(e.code, e.message, **e.extra) from e
        except Forbidden as e:
            raise HandlerError("forbidden", str(e)) from e
        except HermesUnavailable as e:
            raise HandlerError("hermes_unavailable", e.message) from e
        except HermesError as e:
            code = "not_found" if e.code in (404, 4001, 4007) else "hermes_error"
            raise HandlerError(code, f"{e.code}: {e.message}") from e
        except (KeyError, TypeError, ValueError) as e:
            raise HandlerError("bad_request", str(e)) from e

    @staticmethod
    def _sid(params: dict[str, Any]) -> str:
        sid = params.get("stored_id")
        if not isinstance(sid, str) or not STORED_ID_RE.match(sid):
            raise HandlerError("bad_request", "stored_id required")
        return sid

    @staticmethod
    def _limit(params: dict[str, Any], default: int, cap: int) -> int:
        try:
            return max(1, min(int(params.get("limit") or default), cap))
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _title(v: Any) -> str | None:
        if v is None:
            return None
        if not isinstance(v, str) or not v.strip():
            raise HandlerError("bad_request", "title must be a non-empty string")
        return " ".join(v.split())[:TITLE_MAX]

    # sessions ---------------------------------------------------------------------------
    async def m_sessions_list(self, params: dict) -> dict:
        path = params.get("path")
        if path is not None and (not isinstance(path, str) or not os.path.isabs(path)):
            raise HandlerError("bad_request", "path must be absolute")
        await self.index.ensure_fresh()
        rows = self.index.list(os.path.normpath(path) if path else None, self._limit(params, 1000, 5000))
        return {"sessions": rows, "at": time.time()}

    async def m_sessions_search(self, params: dict) -> dict:
        q = params.get("q")
        if not isinstance(q, str) or not q.strip():
            return {"results": []}
        q = q.strip()[:200]
        limit = self._limit(params, 20, SEARCH_LIMIT_MAX)
        # Hermes keeps one hit per conversation, and that hit may be a tool row (raw JSON). Those
        # are re-snipped from the conversation's own prose below, or dropped; over-fetch to
        # make up for the dropped ones.
        res = await self.hermes.rest("GET", "/api/sessions/search", params={
            "q": hermes_search_query(q), "limit": str(min(limit * 2, 100)),
            "exclude_sources": ",".join(EXCLUDED_SOURCES)}, timeout=10)
        terms = search_terms(q)
        out: list[dict[str, Any]] = []
        noisy: list[dict[str, Any]] = []
        seen: set[str] = set()
        for r in (res or {}).get("results") or []:
            if not isinstance(r, dict) or (r.get("source") or "") in EXCLUDED_SOURCES:
                continue
            sid = r.get("session_id") or r.get("id")
            if not isinstance(sid, str) or sid in seen:
                continue
            seen.add(sid)
            row = self.index.get(sid) or {}
            item = {"stored_id": sid, "title": r.get("title") or row.get("title"), "snippet": "",
                    "highlights": [], "role": r.get("role"), "source": r.get("source"),
                    "last_active": r.get("last_active") or row.get("last_active") or r.get("session_started"),
                    "message_count": r.get("message_count")}
            out.append(item)
            if search_hit_is_noise(r.get("role"), r.get("snippet")):
                noisy.append(item)
            else:
                item["snippet"], item["highlights"] = search_snippet(r.get("snippet"), terms)
        if noisy:
            await self._resnip(noisy, terms)
        return {"results": [r for r in out if r["snippet"]][:limit]}

    async def _resnip(self, items: list[dict[str, Any]], terms: list[str]) -> None:
        """Replace noisy hits' snippets with an excerpt of the newest user/assistant message that
        contains a query term. Items left without one (the term occurs only in tool traffic, or
        the lookup did not finish in time) keep an empty snippet and are dropped by the caller."""
        sem = asyncio.Semaphore(SEARCH_RESNIP_PARALLEL)

        async def one(item: dict[str, Any]) -> None:
            async with sem:
                page = await self.hermes.rest("GET", f"/api/sessions/{item['stored_id']}/messages", params={
                    "limit": str(SEARCH_RESNIP_ROWS), "order": "latest"}, allow_404=True,
                    timeout=SEARCH_RESNIP_TIMEOUT_S)
            for m in reversed((page or {}).get("messages") or []):
                role = m.get("role")
                if role not in ("user", "assistant"):
                    continue
                text = to_text(m.get("content"))
                if role == "user" and text.startswith("⟦omni:"):
                    parsed = parse_omni_header(text)
                    text = parsed["body"] if parsed else MARKER_RE.sub("", text)
                hit = text_snippet(text, terms)
                if hit is not None:
                    item["snippet"], item["highlights"] = hit
                    item["role"] = role
                    return

        tasks = [asyncio.create_task(one(i)) for i in items]
        done, pending = await asyncio.wait(tasks, timeout=SEARCH_RESNIP_TIMEOUT_S)
        for t in pending:
            t.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for t in done:
            if not t.cancelled() and t.exception() is not None:
                log.info("search: could not re-snip a hit: %r", t.exception())

    async def m_session_create(self, params: dict) -> dict:
        path, title = params.get("path"), self._title(params.get("title"))
        if path is not None:
            if not isinstance(path, str) or not os.path.isabs(path) or not self._within_roots(path) \
                    or not os.path.isdir(path):
                raise HandlerError("bad_request", "path must be an existing folder under a project root")
            path = os.path.realpath(path)
        res = await self.sessions.create(path, title)
        sid = res["stored_id"]
        if title is not None:
            await self.index.relist(full=False)   # the titled row exists now; drafts are added below
        row = self.index.get(sid) or self.index.add_draft_now(sid)
        self.request_node_refresh()
        return {"stored_id": sid, "title": res.get("title"), "row": row}

    async def m_session_update(self, params: dict) -> dict:
        sid = self._sid(params)
        title = self._title(params.get("title"))
        pinned = params.get("pinned")
        if pinned is not None and not isinstance(pinned, bool):
            raise HandlerError("bad_request", "pinned must be a boolean")
        if title is None and pinned is None:
            raise HandlerError("bad_request", "title or pinned required")
        await self.sessions.update(sid, title, pinned)
        fields: dict[str, Any] = {}
        if title is not None:
            fields["title"] = title
            self.index.drop_title_hint(sid)
        if pinned is not None:
            fields["pinned"] = pinned
        row = self.index.upsert_now(sid, fields)
        if row is None:
            await self.index.relist(full=False)
            row = self.index.get(sid)
        return {"row": row}

    async def m_session_rename(self, params: dict) -> dict:   # v2 alias
        if self._title(params.get("title")) is None:
            raise HandlerError("bad_request", "title required")
        return await self.m_session_update({"stored_id": params.get("stored_id"), "title": params.get("title")})

    async def m_session_delete(self, params: dict) -> dict:
        sid = self._sid(params)
        await self.sessions.delete(sid)
        self.index.drop_title_hint(sid)
        self.index.remove_now(sid)
        self.index.trigger()
        self.request_node_refresh()
        return {}

    async def m_session_messages(self, params: dict) -> dict:
        try:
            offset = max(0, int(params.get("offset") or 0))
        except (TypeError, ValueError):
            offset = 0
        return await self.sessions.messages(self._sid(params), self._limit(params, 100, MESSAGES_MAX), offset)

    async def m_session_attach(self, params: dict) -> dict:
        return await self.sessions.attach_result(self._sid(params))

    async def m_session_prompt(self, params: dict) -> dict:
        sid = self._sid(params)
        text = params.get("text")
        if not isinstance(text, str) or not text.strip():
            raise HandlerError("bad_request", "text required")
        mode = params.get("mode") or "queue"
        if mode not in ("queue", "steer", "redirect"):
            raise HandlerError("bad_request", "mode must be queue|steer|redirect")
        did = params.get("delivery_id")
        if did is not None and not isinstance(did, str):
            raise HandlerError("bad_request", "delivery_id must be a string")
        if not did and (sid in self.sessions.drafts or (self.index.get(sid) or {}).get("message_count") == 0):
            # The opening prompt: Hermes auto-titles the session from it (see omni/link/titles.py).
            self.index.note_first_prompt(sid, text)
        return await self.sessions.prompt(sid, text, mode, did or None)

    async def m_session_interrupt(self, params: dict) -> dict:
        await self.sessions.interrupt(self._sid(params))
        return {}

    async def m_session_respond(self, params: dict) -> dict:
        rid, result = params.get("request_id"), params.get("result")
        if not isinstance(rid, str) or not rid:
            raise HandlerError("bad_request", "request_id required")
        if not isinstance(result, dict):
            raise HandlerError("bad_request", "result must be an object")
        await self.sessions.respond(self._sid(params), rid, result)
        return {}

    async def m_session_ensure(self, params: dict) -> dict:   # legacy (v2 hubs)
        path = params.get("path")
        if not isinstance(path, str):
            raise HandlerError("bad_request", "path required")
        proj = self.project_by_path(path)
        if proj is None:
            raise HandlerError("not_found", f"{path} is not a project on this node")
        res = await self.sessions.ensure_canonical(proj.path, proj.name)
        self.index.trigger()
        return res

    # folders ----------------------------------------------------------------------------
    async def m_folders_list(self, params: dict) -> dict:
        self.projects = scan(self.cfg.workspace, self.cfg.project_roots)
        folders = [{k: f[k] for k in ("name", "path", "root", "is_root", "is_git", "git_branch",
                                      "session_count", "last_active")} for f in self.folder_dicts()]
        return {"roots": list(self.cfg.project_roots), "workspace": self.cfg.workspace, "folders": folders}

    async def m_folders_create(self, params: dict) -> dict:
        root, name = params.get("root"), params.get("name")
        if not isinstance(root, str) or os.path.normpath(root) not in self.cfg.project_roots:
            raise HandlerError("bad_request", "root must be one of the node's project roots")
        if not isinstance(name, str) or not NEW_PROJECT_NAME_RE.match(name) or name in (".", "..") \
                or name.startswith("."):
            raise HandlerError("bad_request", "invalid folder name")
        path = os.path.join(os.path.normpath(root), name)
        try:
            os.mkdir(path)
        except FileExistsError as e:
            raise HandlerError("exists", f"{path} already exists") from e
        except OSError as e:
            raise HandlerError("io_error", f"mkdir {path}: {e.strerror}") from e
        log.info("created folder %s", path)
        self.projects = scan(self.cfg.workspace, self.cfg.project_roots)
        self.request_node_refresh()
        folder = next((f for f in self.folder_dicts() if f["path"] == path), None)
        if folder is None:
            raise HandlerError("internal", "folder not found after creation")
        return {"folder": folder}

    async def m_projects_list(self, params: dict) -> dict:   # v2 alias
        return {"projects": (await self.node_info(refresh=True))["projects"]}

    async def m_projects_create(self, params: dict) -> dict:   # v2 alias
        return {"project": (await self.m_folders_create(params))["folder"]}

    # Hermes passthrough -----------------------------------------------------------------
    async def m_node_rpc(self, params: dict) -> dict:
        method = params.get("method")
        p = params.get("params") if params.get("params") is not None else {}
        sid = params.get("stored_id")
        if sid is not None and (not isinstance(sid, str) or not STORED_ID_RE.match(sid)):
            raise HandlerError("bad_request", "bad stored_id")
        check_rpc(method, p, sid is not None)
        timeout = rpc_timeout(method)
        if sid is not None:
            _, res = await self.sessions.call_session(sid, method, dict(p), timeout=timeout)
            if method in ("config.set", "session.compress"):
                self.sessions._tasks.spawn(self.sessions._refresh_usage(sid), name=f"usage-{sid}")
            return res
        return await self.hermes.call(method, dict(p), timeout=timeout)

    async def m_node_rest(self, params: dict) -> dict:
        method, path = params.get("method"), params.get("path")
        check_rest(method, path)
        query = params.get("query")
        if query is not None and (not isinstance(query, dict)
                                  or not all(isinstance(v, (str, int, float, bool)) for v in query.values())):
            raise HandlerError("bad_request", "query must be an object of scalars")
        q = {str(k): (str(v).lower() if isinstance(v, bool) else str(v)) for k, v in (query or {}).items()}
        status, body = await self.hermes.rest_raw(str(method).upper(), str(path).split("?", 1)[0],
                                                  params=q or None, json_body=params.get("body"))
        return {"status": status, "body": body}

    # files ------------------------------------------------------------------------------
    async def m_fs_list(self, params: dict) -> dict:
        return await asyncio.to_thread(self.files.list, params.get("path"))

    async def m_fs_read_text(self, params: dict) -> dict:
        return await asyncio.to_thread(self.files.read_text, params.get("path"), params.get("max_bytes"))

    async def m_blob_open(self, params: dict) -> dict:
        kind = params.get("kind")
        if kind == "file":
            return await asyncio.to_thread(self.files.open_file_blob, params.get("path"))
        if kind == "export":
            sid = self._sid(params)
            data = await self.hermes.rest("GET", f"/api/sessions/{sid}/export", allow_404=True, timeout=120)
            if data is None:
                raise HandlerError("not_found", f"session {sid} not found")
            title = (self.index.get(sid) or {}).get("title") or sid
            name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", title).strip(" .")[:120] or sid
            raw = json.dumps(data, ensure_ascii=False, indent=1).encode("utf-8")
            return await asyncio.to_thread(self.files.open_temp_blob, raw, name + ".json", "application/json")
        raise HandlerError("bad_request", "kind must be file|export")

    async def m_blob_read(self, params: dict) -> dict:
        return await asyncio.to_thread(self.files.read_blob, params.get("blob_id"), params.get("offset"),
                                       params.get("length"))

    async def m_blob_close(self, params: dict) -> dict:
        self.files.close(params.get("blob_id"))
        return {}

    async def m_upload_open(self, params: dict) -> dict:
        if params.get("purpose") == "attach":
            return self.files.open_attach(self._sid(params), params.get("name"), params.get("size"),
                                          params.get("mime"))
        return await asyncio.to_thread(self.files.open_upload, params.get("dir"), params.get("name"),
                                       params.get("size"), bool(params.get("overwrite")))

    async def m_upload_write(self, params: dict) -> dict:
        return await asyncio.to_thread(self.files.write, params.get("upload_id"), params.get("offset"),
                                       params.get("data_b64"))

    async def m_upload_commit(self, params: dict) -> dict:
        uid = params.get("upload_id")
        t = self.files._open.get(uid) if isinstance(uid, str) else None
        if t is not None and t.stored_id is None:
            return await asyncio.to_thread(self.files.commit_file, uid)
        t, data = await asyncio.to_thread(self.files.take_attach, uid)
        return await self._attach(t.stored_id or "", t.name, t.mime, data)

    async def m_upload_abort(self, params: dict) -> dict:
        self.files.close(params.get("upload_id"))
        return {}

    async def _attach(self, sid: str, name: str, mime: str, data: bytes) -> dict[str, Any]:
        b64 = base64.b64encode(data).decode("ascii")
        if mime.startswith("image/"):
            _, res = await self.sessions.call_session(sid, "image.attach_bytes",
                                                      {"content_base64": b64, "filename": name}, timeout=60)
            return {"kind": "image", "name": name, "width": res.get("width"), "height": res.get("height")}
        if mime == "application/pdf":
            _, res = await self.sessions.call_session(sid, "pdf.attach", {"content_base64": b64, "filename": name},
                                                      timeout=150)
            return {"kind": "pdf", "name": name, "pages": res.get("pages_attached")}
        _, res = await self.sessions.call_session(sid, "file.attach",
                                                  {"data_url": f"data:{mime};base64,{b64}", "name": name},
                                                  timeout=60)
        return {"kind": "file", "name": res.get("name") or name, "ref_text": res.get("ref_text")}

    _methods = {
        "sessions.list": m_sessions_list,
        "sessions.search": m_sessions_search,
        "session.create": m_session_create,
        "session.update": m_session_update,
        "session.rename": m_session_rename,
        "session.delete": m_session_delete,
        "session.messages": m_session_messages,
        "session.attach": m_session_attach,
        "session.prompt": m_session_prompt,
        "session.interrupt": m_session_interrupt,
        "session.respond": m_session_respond,
        "session.ensure": m_session_ensure,
        "folders.list": m_folders_list,
        "folders.create": m_folders_create,
        "projects.list": m_projects_list,
        "projects.create": m_projects_create,
        "node.rpc": m_node_rpc,
        "node.rest": m_node_rest,
        "fs.list": m_fs_list,
        "fs.read_text": m_fs_read_text,
        "blob.open": m_blob_open,
        "blob.read": m_blob_read,
        "blob.close": m_blob_close,
        "upload.open": m_upload_open,
        "upload.write": m_upload_write,
        "upload.commit": m_upload_commit,
        "upload.abort": m_upload_abort,
    }
