"""LinkAgent: wires Hermes, the session registry, the hub connection and the bridge together.

Owns NodeInfo/Project building, the periodic ``node`` heartbeat, the hub→link method table
(design §5) and the reliable delivery of ``turn.done`` frames for deliveries.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any

from omni import PROTO, __version__
from omni.proto import NEW_PROJECT_NAME_RE, STORED_ID_RE, canonical_title, format_address
from omni.link.config import Config
from omni.link.gpu import gpu_stats
from omni.link.hermes import HermesClient, HermesError, HermesUnavailable
from omni.link.hubconn import HandlerError, HubConnection
from omni.link.projects import ProjectDir, project_for_path, scan
from omni.link.sessions import MESSAGES_MAX, SessionManager, SessionOpError
from omni.link.state import LinkState
from omni.link.util import TaskSet

log = logging.getLogger("omni.link.agent")

NODE_REFRESH_S = 30      # rescan projects / hermes / gpu
NODE_FORCE_S = 60        # send a node frame at least this often (heartbeat)


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
        self.projects: list[ProjectDir] = []
        self._node_info: dict[str, Any] | None = None
        self._node_sent_json: str | None = None
        self._node_sent_at = 0.0
        self._refresh_now = asyncio.Event()
        self._tasks = TaskSet("agent")
        self._hermes_status: dict[str, Any] = {"ok": False, "version": None, "gateway_state": None, "model": None}

    # --- lifecycle -----------------------------------------------------------------------
    async def start(self) -> None:
        self.state.write_status(False, self.cfg.hub_url, self.cfg.node_id)
        self.projects = scan(self.cfg.workspace, self.cfg.project_roots)
        await self.hermes.start()
        self.sessions.start()
        await self.hub.start()
        self._tasks.spawn(self._node_loop(), name="node-loop")

    async def stop(self) -> None:
        await self._tasks.cancel_all()
        await self.hub.close()
        await self.sessions.close()
        await self.hermes.close()
        self.state.save_now()
        self.state.write_status(False, self.cfg.hub_url, self.cfg.node_id)

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
        for did, entry in list(self.state.inflight.items()):
            if "done" in entry:
                self._emit_turn_done(entry["done"])

    def _on_hub_status(self, connected: bool) -> None:
        self.state.write_status(connected, self.cfg.hub_url, self.cfg.node_id)

    async def _on_hermes_connected(self, epoch: str | None) -> None:
        await self.sessions.on_hermes_connected(epoch)
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
            status, gpus, projects = await asyncio.gather(self.hermes.probe(), gpu_stats(), self.project_dicts())
            self._hermes_status = status
            self._node_info = {
                "node_id": self.cfg.node_id, "display_name": self.cfg.display_name, "hostname": self.cfg.hostname,
                "role": self.cfg.role, "link_version": __version__, "proto": PROTO,
                "hermes": status, "dashboard_url": self.cfg.dashboard_url, "gpus": gpus,
                "project_roots": list(self.cfg.project_roots), "projects": projects,
            }
        return self._node_info

    async def project_dicts(self) -> list[dict[str, Any]]:
        """Fresh scan + canonical summaries (one REST listing per root, best effort)."""
        self.projects = scan(self.cfg.workspace, self.cfg.project_roots)
        rows_by_id: dict[str, dict] = {}
        count_by_cwd: dict[str, int] = {}
        live: dict[str, str] = {}
        hermes_ok = self.hermes.connected.is_set()
        if hermes_ok:
            try:
                for root in self.cfg.project_roots:
                    for r in await self.sessions.fetch_sessions(root, 100, max_pages=5):
                        if r.get("id") in rows_by_id:
                            continue
                        rows_by_id[r["id"]] = r
                        count_by_cwd[r.get("cwd") or ""] = count_by_cwd.get(r.get("cwd") or "", 0) + 1
                live = await self.sessions.live_status()
            except HermesError as e:
                log.warning("session listing for projects failed: %s", e)
                hermes_ok = False
        out = []
        for p in self.projects:
            out.append({
                "name": p.name, "path": p.path, "root": p.root, "is_root": p.is_root, "is_git": p.is_git,
                "git_branch": p.git_branch, "address": format_address(self.cfg.node_id, p.name),
                "canonical": await self._canonical_summary(p, rows_by_id, live) if hermes_ok else None,
                "session_count": count_by_cwd.get(p.path, 0),
            })
        return out

    async def _canonical_summary(self, p: ProjectDir, rows: dict[str, dict], live: dict[str, str]) -> dict | None:
        entry = self.state.canonical.get(p.path)
        row = None
        if entry and entry.get("stored_id"):
            sid = entry["stored_id"]
            row = rows.get(sid)
            if row is None:
                try:
                    row = await self.hermes.rest("GET", f"/api/sessions/{sid}", allow_404=True)
                except HermesError:
                    row = None
                if row is None:
                    return None
        else:
            # Recover a lost mapping: a session with the canonical title in this folder.
            title = canonical_title(p.name)
            row = next((r for r in rows.values() if r.get("title") == title and r.get("cwd") == p.path), None)
            if row is None:
                return None
            self.state.set_canonical(p.path, row["id"], title)
        sid = row.get("id") or entry["stored_id"]
        return {"stored_id": sid, "title": row.get("title"),
                "last_active": row.get("last_activity_at") or row.get("last_active"),
                "message_count": row.get("message_count"), "running": self.sessions.is_running(sid, live)}

    def project_by_path(self, path: str) -> ProjectDir | None:
        return project_for_path(self.projects, path) or project_for_path(
            scan(self.cfg.workspace, self.cfg.project_roots), path)

    def _within_roots(self, path: str) -> bool:
        path = os.path.normpath(path)
        return any(path == r or path.startswith(r.rstrip("/") + "/") for r in self.cfg.project_roots)

    # --- addresses (bridge) --------------------------------------------------------------
    async def address_for_session(self, stored_id: str) -> str:
        try:
            cwd = await self.sessions.session_cwd(stored_id)
        except HermesError as e:
            log.warning("cwd lookup for %s failed: %s", stored_id, e)
            cwd = None
        proj = project_for_path(self.projects, cwd) if cwd else None
        if proj is None:
            return format_address(self.cfg.node_id, None, stored_id)
        canon = self.state.canonical.get(proj.path) or {}
        if canon.get("stored_id") == stored_id:
            return format_address(self.cfg.node_id, proj.name)
        return format_address(self.cfg.node_id, proj.name, stored_id)

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
            raise HandlerError(e.code, e.message) from e
        except HermesUnavailable as e:
            raise HandlerError("hermes_unavailable", e.message) from e
        except HermesError as e:
            code = "not_found" if e.code in (404, 4007) else "hermes_error"
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

    async def m_projects_list(self, params: dict) -> dict:
        info = await self.node_info(refresh=True)
        self.request_node_refresh()
        return {"projects": info["projects"]}

    async def m_projects_create(self, params: dict) -> dict:
        root, name = params.get("root"), params.get("name")
        if not isinstance(root, str) or os.path.normpath(root) not in self.cfg.project_roots:
            raise HandlerError("bad_request", "root must be one of the node's project roots")
        if not isinstance(name, str) or not NEW_PROJECT_NAME_RE.match(name) or name in (".", "..") \
                or name.startswith("."):
            raise HandlerError("bad_request", "invalid project name")
        path = os.path.join(os.path.normpath(root), name)
        try:
            os.mkdir(path)
        except FileExistsError as e:
            raise HandlerError("exists", f"{path} already exists") from e
        except OSError as e:
            raise HandlerError("io_error", f"mkdir {path}: {e.strerror}") from e
        log.info("created project folder %s", path)
        info = await self.node_info(refresh=True)
        self.request_node_refresh()
        proj = next((p for p in info["projects"] if p["path"] == path), None)
        if proj is None:
            raise HandlerError("internal", "project not found after creation")
        return {"project": proj}

    async def m_sessions_list(self, params: dict) -> dict:
        path = params.get("path")
        if path is not None and (not isinstance(path, str) or not os.path.isabs(path)):
            raise HandlerError("bad_request", "path must be absolute")
        path = os.path.normpath(path) if path else None
        return {"sessions": await self.sessions.list_sessions(path, self._limit(params, 50, 500))}

    async def m_session_messages(self, params: dict) -> dict:
        return {"messages": await self.sessions.messages(self._sid(params), self._limit(params, 200, MESSAGES_MAX))}

    async def m_session_ensure(self, params: dict) -> dict:
        path = params.get("path")
        if not isinstance(path, str):
            raise HandlerError("bad_request", "path required")
        proj = self.project_by_path(path)
        if proj is None:
            raise HandlerError("not_found", f"{path} is not a project on this node")
        res = await self.sessions.ensure_canonical(proj.path, proj.name)
        if res.get("created"):
            self.request_node_refresh()
        return res

    async def m_session_create(self, params: dict) -> dict:
        path, title = params.get("path"), params.get("title")
        if not isinstance(path, str) or not os.path.isabs(path) or not self._within_roots(path) \
                or not os.path.isdir(path):
            raise HandlerError("bad_request", "path must be an existing folder under a project root")
        if title is not None and (not isinstance(title, str) or not title.strip()):
            title = None
        res = await self.sessions.create(os.path.normpath(path), title.strip() if title else None)
        self.request_node_refresh()
        return res

    async def m_session_attach(self, params: dict) -> dict:
        return await self.sessions.attach_result(self._sid(params))

    async def m_session_prompt(self, params: dict) -> dict:
        sid = self._sid(params)
        text = params.get("text")
        if not isinstance(text, str) or not text.strip():
            raise HandlerError("bad_request", "text required")
        mode = params.get("mode") or "queue"
        if mode not in ("queue", "redirect"):
            raise HandlerError("bad_request", "mode must be queue|redirect")
        did = params.get("delivery_id")
        if did is not None and not isinstance(did, str):
            raise HandlerError("bad_request", "delivery_id must be a string")
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

    async def m_session_rename(self, params: dict) -> dict:
        title = params.get("title")
        if not isinstance(title, str) or not title.strip():
            raise HandlerError("bad_request", "title required")
        await self.sessions.rename(self._sid(params), title.strip())
        self.request_node_refresh()
        return {}

    async def m_session_delete(self, params: dict) -> dict:
        await self.sessions.delete(self._sid(params))
        self.request_node_refresh()
        return {}

    _methods = {
        "projects.list": m_projects_list,
        "projects.create": m_projects_create,
        "sessions.list": m_sessions_list,
        "session.messages": m_session_messages,
        "session.ensure": m_session_ensure,
        "session.create": m_session_create,
        "session.attach": m_session_attach,
        "session.prompt": m_session_prompt,
        "session.interrupt": m_session_interrupt,
        "session.respond": m_session_respond,
        "session.rename": m_session_rename,
        "session.delete": m_session_delete,
    }
