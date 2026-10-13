"""Browser REST API under /api (design §6, v3 spec §5.4). Auth/CSRF are enforced by auth.Auth.middleware.

Every node operation goes hub → link → Hermes; the browser never talks to a node directly.
Errors are ``{"error": {code, message, ...}}`` with the HTTP status from LINK_ERROR_STATUS.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import os
import tempfile
import urllib.parse
from typing import Any

from aiohttp import BodyPartReader, web

from omni.proto import (NEW_PROJECT_NAME_RE, NODE_ID_RE, STORED_ID_RE, TITLE_MAX, Forbidden, RemoteError,
                        check_rest, check_rpc, rpc_timeout, session_key)

from .auth import USER_KEY, json_error
from .context import HUB_KEY, ApiError, Hub
from .links import NodeUnavailable
from .router import Rejected
from .sessions import row_title

log = logging.getLogger("omni.hub.api")

REPO_URL = "https://github.com/uiyunkim-git/hermes-omni"
JOIN_ENV_KEYS = ("LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_API_MODE", "LLM_CONTEXT_LENGTH",
                 "HERMES_DASHBOARD_BASIC_AUTH_USERNAME", "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD", "TS_AUTHKEY")
SECRET_HINTS = ("KEY", "PASSWORD", "TOKEN", "SECRET")
PROMPT_MAX_CHARS = 100_000
REJECT_STATUS = {"unknown_target": 404, "ambiguous_target": 409}
LINK_ERROR_STATUS = {
    "not_found": 404, "bad_request": 400, "session_locked": 409, "running": 409, "exists": 409,
    "duplicate_title": 409, "forbidden": 403, "outside_roots": 403, "sensitive": 403, "too_large": 413,
    "node_outdated": 501, "unknown_method": 501, "hermes_unavailable": 503, "not_a_directory": 400,
    "not_a_file": 400,
}
CHUNK = 256 * 1024
UPLOAD_MAX = 50 * 1024 * 1024
ATTACH_MAX = 20 * 1024 * 1024
SEARCH_NODE_TIMEOUT = 4.0
SEARCH_MAX = 50
SPOOL_MEM = 1024 * 1024


# --- helpers ---------------------------------------------------------------------------
def hub_of(request: web.Request) -> Hub:
    return request.app[HUB_KEY]


async def read_json(request: web.Request) -> dict[str, Any]:
    if not request.can_read_body:
        return {}
    try:
        data = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise ApiError(400, "bad_json", "request body is not valid JSON") from None
    if not isinstance(data, dict):
        raise ApiError(400, "bad_json", "request body must be a JSON object")
    return data


def node_param(request: web.Request) -> str:
    node = request.match_info["node"]
    if not NODE_ID_RE.match(node):
        raise ApiError(400, "bad_node", "invalid node id")
    if node not in hub_of(request).links.nodes:
        raise ApiError(404, "unknown_node", f"no node named {node}")
    return node


def sid_param(request: web.Request) -> str:
    sid = request.match_info["sid"]
    if not STORED_ID_RE.match(sid):
        raise ApiError(400, "bad_session", "invalid session id")
    return sid


def abs_path(v: Any, field: str, required: bool = True) -> str | None:
    if v in (None, "") and not required:
        return None
    if not isinstance(v, str) or not v.startswith("/") or "\x00" in v:
        raise ApiError(400, "bad_request", f"{field} must be an absolute path")
    return v


def int_query(request: web.Request, name: str, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(int(request.query.get(name, default)), hi))
    except ValueError:
        raise ApiError(400, "bad_request", f"{name} must be an integer") from None


def require_v2(request: web.Request, node: str) -> None:
    conn = hub_of(request).links.get(node)
    if conn is not None and conn.proto < 2:
        raise ApiError(501, "node_outdated", f"{node} runs an older hermes-omni link; update it")


async def link_call(request: web.Request, node: str, method: str, params: dict[str, Any],
                    timeout: float = 30) -> dict[str, Any]:
    try:
        return await hub_of(request).links.call(node, method, params, timeout)
    except NodeUnavailable as e:
        raise ApiError(503 if e.known else 404, "node_offline" if e.known else "unknown_node", str(e)) from None
    except RemoteError as e:
        code = "node_outdated" if e.code == "unknown_method" else e.code
        raise ApiError(LINK_ERROR_STATUS.get(code, 502), code, e.message, **e.extra) from None
    except ConnectionError:
        raise ApiError(503, "node_offline", f"link {node} disconnected") from None
    except TimeoutError:
        raise ApiError(504, "node_timeout", f"node {node} did not answer {method}") from None


def mask(key: str, value: str) -> str:
    if any(h in key.upper() for h in SECRET_HINTS):
        return "••••••••" if value else ""
    return value


@web.middleware
async def error_middleware(request: web.Request, handler: Any) -> web.StreamResponse:
    try:
        return await handler(request)
    except ApiError as e:
        body: dict[str, Any] = {"code": e.code, "message": e.message, **e.extra}
        return web.json_response({"error": body}, status=e.status)
    except web.HTTPException:
        raise
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("%s %s failed", request.method, request.path)
        if request.path.startswith("/api/"):
            return json_error(500, "internal", "internal error")
        raise


def _content_disposition(kind: str, name: str) -> str:
    ascii_name = "".join(c if 32 <= ord(c) < 127 and c not in '"\\' else "_" for c in name) or "download"
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{urllib.parse.quote(name, safe='')}"


# --- auth ------------------------------------------------------------------------------
async def login(request: web.Request) -> web.Response:
    hub = hub_of(request)
    ip = request.remote or "?"
    if not hub.auth.login_allowed(ip):
        raise ApiError(429, "rate_limited", "too many login attempts; wait a minute")
    body = await read_json(request)
    user, password = body.get("username"), body.get("password")
    if not isinstance(user, str) or not isinstance(password, str) or not hub.auth.check_password(user, password):
        log.warning("failed login from %s", ip)
        raise ApiError(401, "bad_credentials", "wrong username or password")
    token = hub.auth.issue(user)
    out: dict[str, Any] = {"ok": True, "user": user}
    if body.get("token"):
        out["token"] = token
    resp = web.json_response(out)
    hub.auth.set_cookie(resp, token)
    log.info("login %s from %s", user, ip)
    return resp


async def logout(request: web.Request) -> web.Response:
    resp = web.json_response({"ok": True})
    hub_of(request).auth.clear_cookie(resp)
    return resp


async def me(request: web.Request) -> web.Response:
    return web.json_response({"user": request[USER_KEY]})


# --- nodes / folders -------------------------------------------------------------------
async def nodes(request: web.Request) -> web.Response:
    return web.json_response({"nodes": hub_of(request).links.nodes_json()})


async def forget_node(request: web.Request) -> web.Response:
    node = node_param(request)
    try:
        found = await hub_of(request).links.forget(node)
    except RuntimeError:
        raise ApiError(409, "node_online", "node is online; stop its link first")
    if not found:
        raise ApiError(404, "not_found", f"unknown node {node}")
    return web.json_response({"ok": True})


async def list_folders(request: web.Request) -> web.Response:
    node = node_param(request)
    hub = hub_of(request)
    if hub.links.is_online(node):
        conn = hub.links.get(node)
        if conn is not None and conn.proto >= 2:
            res = await link_call(request, node, "folders.list", {})
            if isinstance(res.get("folders"), list):
                await hub.links.update_info(node, projects=res["folders"])
            return web.json_response({"roots": res.get("roots") or [], "workspace": res.get("workspace"),
                                      "folders": res.get("folders") or []})
    # Offline (or an old link): the last folder list the node reported, counts from the index.
    info = hub.links.nodes[node].info
    stats = hub.index.folder_stats(node)
    folders = []
    for p in info.get("projects") or []:
        if not isinstance(p, dict) or p.get("is_root"):
            continue
        n, last = stats.get(p.get("path") or "", (0, None))
        folders.append({"name": p.get("name"), "path": p.get("path"), "root": p.get("root"), "is_root": False,
                        "is_git": bool(p.get("is_git")), "git_branch": p.get("git_branch"),
                        "session_count": n, "last_active": last})
    return web.json_response({"roots": info.get("project_roots") or [], "workspace": info.get("workspace"),
                              "folders": folders})


async def create_folder(request: web.Request) -> web.Response:
    node = node_param(request)
    body = await read_json(request)
    root = abs_path(body.get("root"), "root")
    name = body.get("name")
    if not isinstance(name, str) or not NEW_PROJECT_NAME_RE.match(name) or name in (".", ".."):
        raise ApiError(400, "bad_request", "name must match [A-Za-z0-9._-]+")
    conn = hub_of(request).links.get(node)
    if conn is not None and conn.proto < 2:
        res = await link_call(request, node, "projects.create", {"root": root, "name": name})
        folder = res.get("project")
    else:
        res = await link_call(request, node, "folders.create", {"root": root, "name": name})
        folder = res.get("folder")
    await _rescan(request, node)
    return web.json_response({"folder": folder, "project": folder})


async def rescan(request: web.Request) -> web.Response:
    node = node_param(request)
    return web.json_response({"projects": await _rescan(request, node)})


async def _rescan(request: web.Request, node: str) -> list[Any]:
    conn = hub_of(request).links.get(node)
    if conn is not None and conn.proto < 2:
        res = await link_call(request, node, "projects.list", {})
        folders = res.get("projects") if isinstance(res.get("projects"), list) else []
    else:
        res = await link_call(request, node, "folders.list", {})
        folders = res.get("folders") if isinstance(res.get("folders"), list) else []
    await hub_of(request).links.update_info(node, projects=folders)
    return folders


# --- sessions: lists and search --------------------------------------------------------
async def all_sessions(request: web.Request) -> web.Response:
    hub = hub_of(request)
    node = request.query.get("node") or None
    if node is not None and not NODE_ID_RE.match(node):
        raise ApiError(400, "bad_node", "invalid node id")
    folder = abs_path(request.query.get("folder"), "folder", required=False)
    q = (request.query.get("q") or "").strip()
    if q or "q" in request.query:
        limit = int_query(request, "limit", 8, 1, 50)
        rows = hub.index.search(q, node=node, limit=limit) if q else [
            {**r, "mention": f"@{row_title(r)} ({r['key']})"} for r in hub.index.hub_rows(node, folder)[:limit]]
    else:
        rows = hub.index.hub_rows(node, folder)[: int_query(request, "limit", 300, 1, 5000)]
    nodes_out = [{"node_id": st.node_id, "display_name": st.info.get("display_name") or st.node_id,
                  "online": hub.links.is_online(st.node_id), "proto": st.info.get("proto")}
                 for st in sorted(hub.links.nodes.values(), key=lambda s: s.node_id)]
    return web.json_response({"sessions": rows, "nodes": nodes_out, "attention": hub.index.attention()})


async def node_sessions(request: web.Request) -> web.Response:
    node = node_param(request)
    folder = abs_path(request.query.get("folder") or request.query.get("path"), "folder", required=False)
    rows = hub_of(request).index.hub_rows(node, folder)
    return web.json_response({"sessions": rows[: int_query(request, "limit", 1000, 1, 5000)]})


async def search(request: web.Request) -> web.Response:
    hub = hub_of(request)
    q = (request.query.get("q") or "").strip()
    limit = int_query(request, "limit", 30, 1, SEARCH_MAX)
    if len(q) < 1:
        return web.json_response({"results": [], "partial": []})
    targets = [n for n, c in hub.links.conns.items() if c.proto >= 2]
    partial = [n for n in hub.links.nodes if n not in targets]

    async def one(node: str) -> tuple[str, list[dict[str, Any]] | None]:
        try:
            res = await hub.links.call(node, "sessions.search", {"q": q, "limit": limit}, timeout=SEARCH_NODE_TIMEOUT)
            return node, [r for r in res.get("results") or [] if isinstance(r, dict)]
        except (RemoteError, NodeUnavailable, ConnectionError, TimeoutError) as e:
            log.info("search on %s failed: %s", node, e)
            return node, None

    results: list[dict[str, Any]] = []
    for node, rows in await asyncio.gather(*(one(n) for n in targets)):
        if rows is None:
            partial.append(node)
            continue
        for r in rows:
            sid = r.get("stored_id")
            if not isinstance(sid, str):
                continue
            row = hub.index.get(node, sid) or {}
            title = r.get("title") or (row_title(row) if row else None)
            results.append({"node": node, "node_name": hub.index.node_name(node), "stored_id": sid,
                            "key": session_key(node, sid), "title": title, "snippet": r.get("snippet") or "", "highlights": r.get("highlights") or [],
                            "role": r.get("role"), "last_active": r.get("last_active") or row.get("last_active"),
                            "folder": row.get("folder")})
    results.sort(key=lambda x: x.get("last_active") or 0, reverse=True)
    return web.json_response({"results": results[:limit], "partial": sorted(partial)})


# --- sessions: lifecycle ---------------------------------------------------------------
async def create_session(request: web.Request) -> web.Response:
    node = node_param(request)
    hub = hub_of(request)
    body = await read_json(request)
    if body.get("canonical"):
        raise ApiError(410, "gone", "folder main sessions no longer exist; create a session instead")
    folder = abs_path(body.get("folder", body.get("path")), "folder", required=False)
    params: dict[str, Any] = {"path": folder}
    title = body.get("title")
    if isinstance(title, str) and title.strip():
        params["title"] = " ".join(title.split())[:TITLE_MAX]
    text = body.get("text")
    if text is not None and (not isinstance(text, str) or len(text) > PROMPT_MAX_CHARS):
        raise ApiError(400, "bad_request", "text must be a string")
    conn = hub.links.get(node)
    if conn is not None and conn.proto < 2 and folder is None:
        raise ApiError(501, "node_outdated", "this node's link cannot create a session without a folder")
    res = await link_call(request, node, "session.create", params, timeout=60)
    sid = res.get("stored_id")
    if not isinstance(sid, str):
        raise ApiError(502, "bad_response", "link returned no session id")
    row = res.get("row")
    if isinstance(row, dict) and row.get("stored_id") == sid:
        await hub.index.on_update(node, False, [row], [])
    prompt_res = None
    if isinstance(text, str) and text.strip():
        prompt_res = await link_call(request, node, "session.prompt",
                                     {"stored_id": sid, "text": text, "mode": "queue"}, timeout=60)
    cur = hub.index.get(node, sid)
    return web.json_response({"stored_id": sid, "title": res.get("title"), "key": session_key(node, sid),
                              "row": hub.index.hub_row(node, cur) if cur else None, "prompt": prompt_res})


async def messages(request: web.Request) -> web.Response:
    node, sid = node_param(request), sid_param(request)
    limit = int_query(request, "limit", 100, 1, 500)
    offset = int_query(request, "offset", 0, 0, 10_000_000)
    res = await link_call(request, node, "session.messages", {"stored_id": sid, "limit": limit, "offset": offset},
                          timeout=60)
    if isinstance(res.get("messages"), list) and "has_more" in res:
        return web.json_response({"messages": res["messages"], "has_more": bool(res["has_more"])})
    msgs = res.get("messages") or []   # proto-1 link: newest `limit` rows, no paging
    return web.json_response({"messages": msgs, "has_more": False})


async def prompt(request: web.Request) -> web.Response:
    node, sid = node_param(request), sid_param(request)
    hub = hub_of(request)
    body = await read_json(request)
    text, mode = body.get("text"), body.get("mode", "queue")
    if not isinstance(text, str) or not text.strip():
        raise ApiError(400, "bad_request", "text required")
    if len(text) > PROMPT_MAX_CHARS:
        raise ApiError(400, "bad_request", "text too long")
    if mode not in ("queue", "steer", "redirect"):
        raise ApiError(400, "bad_request", "mode must be queue, steer or redirect")
    try:
        res = await link_call(request, node, "session.prompt", {"stored_id": sid, "text": text, "mode": mode},
                              timeout=60)
    except ApiError as e:
        if e.code == "session_locked":
            hub.live.set_locked(node, sid, str(e.extra.get("surface") or "다른 창"), e.message)
        raise
    hub.live.set_locked(node, sid, None)
    return web.json_response(res)


async def interrupt(request: web.Request) -> web.Response:
    node, sid = node_param(request), sid_param(request)
    return web.json_response(await link_call(request, node, "session.interrupt", {"stored_id": sid}))


async def respond(request: web.Request) -> web.Response:
    node, sid = node_param(request), sid_param(request)
    body = await read_json(request)
    rid, result = body.get("request_id"), body.get("result")
    if not isinstance(rid, str) or not rid or not isinstance(result, dict):
        raise ApiError(400, "bad_request", "request_id (string) and result (object) required")
    res = await link_call(request, node, "session.respond", {"stored_id": sid, "request_id": rid, "result": result})
    hub_of(request).live.drop_request(node, sid, rid)
    return web.json_response(res)


async def update_session(request: web.Request) -> web.Response:
    node, sid = node_param(request), sid_param(request)
    hub = hub_of(request)
    body = await read_json(request)
    params: dict[str, Any] = {"stored_id": sid}
    title, pinned = body.get("title"), body.get("pinned")
    if title is not None:
        if not isinstance(title, str) or not title.strip():
            raise ApiError(400, "bad_request", "title must be a non-empty string")
        params["title"] = " ".join(title.split())[:TITLE_MAX]
    if pinned is not None:
        if not isinstance(pinned, bool):
            raise ApiError(400, "bad_request", "pinned must be a boolean")
        params["pinned"] = pinned
    if len(params) == 1:
        raise ApiError(400, "bad_request", "title or pinned required")
    conn = hub.links.get(node)
    if conn is not None and conn.proto < 2:
        if "title" not in params:
            raise ApiError(501, "node_outdated", "this node's link cannot pin sessions")
        await link_call(request, node, "session.rename", {"stored_id": sid, "title": params["title"]})
        return web.json_response({"row": None})
    res = await link_call(request, node, "session.update", params)
    row = res.get("row")
    if isinstance(row, dict) and row.get("stored_id"):
        await hub.index.on_update(node, False, [row], [])
        return web.json_response({"row": hub.index.hub_row(node, row)})
    return web.json_response({"row": None})


async def delete_session(request: web.Request) -> web.Response:
    node, sid = node_param(request), sid_param(request)
    hub = hub_of(request)
    if hub.live.is_running(node, sid):
        raise ApiError(409, "running", "the session is running; stop it first")
    res = await link_call(request, node, "session.delete", {"stored_id": sid})
    await hub.index.on_update(node, False, [], [sid])
    return web.json_response(res)


# --- Hermes passthrough ----------------------------------------------------------------
async def node_rpc(request: web.Request) -> web.Response:
    node = node_param(request)
    require_v2(request, node)
    body = await read_json(request)
    method, params, sid = body.get("method"), body.get("params"), body.get("stored_id")
    params = {} if params is None else params
    if sid is not None and (not isinstance(sid, str) or not STORED_ID_RE.match(sid)):
        raise ApiError(400, "bad_session", "invalid session id")
    try:
        check_rpc(method, params, sid is not None)
    except Forbidden as e:
        raise ApiError(403, "forbidden", str(e)) from None
    p: dict[str, Any] = {"method": method, "params": params}
    if sid is not None:
        p["stored_id"] = sid
    try:
        res = await link_call(request, node, "node.rpc", p, timeout=rpc_timeout(str(method)) + 10)
    except ApiError as e:
        if e.code == "session_locked" and sid:
            hub_of(request).live.set_locked(node, sid, str(e.extra.get("surface") or "다른 창"), e.message)
        raise
    return web.json_response({"result": res})


async def node_rest(request: web.Request) -> web.Response:
    node = node_param(request)
    require_v2(request, node)
    body = await read_json(request)
    try:
        check_rest(body.get("method"), body.get("path"))
    except Forbidden as e:
        raise ApiError(403, "forbidden", str(e)) from None
    p = {"method": str(body["method"]).upper(), "path": body["path"]}
    if body.get("query") is not None:
        p["query"] = body["query"]
    if body.get("body") is not None:
        p["body"] = body["body"]
    res = await link_call(request, node, "node.rest", p, timeout=45)
    return web.json_response({"status": res.get("status"), "body": res.get("body")})


# --- files -----------------------------------------------------------------------------
async def files_list(request: web.Request) -> web.Response:
    node = node_param(request)
    require_v2(request, node)
    path = abs_path(request.query.get("path"), "path")
    return web.json_response(await link_call(request, node, "fs.list", {"path": path}))


async def files_text(request: web.Request) -> web.Response:
    node = node_param(request)
    require_v2(request, node)
    path = abs_path(request.query.get("path"), "path")
    return web.json_response(await link_call(request, node, "fs.read_text", {"path": path}))


async def files_raw(request: web.Request) -> web.StreamResponse:
    node = node_param(request)
    require_v2(request, node)
    path = abs_path(request.query.get("path"), "path")
    download = request.query.get("download") in ("1", "true")
    return await _stream_blob(request, node, {"kind": "file", "path": path}, download)


async def export_session(request: web.Request) -> web.StreamResponse:
    node, sid = node_param(request), sid_param(request)
    require_v2(request, node)
    return await _stream_blob(request, node, {"kind": "export", "stored_id": sid}, True)


async def _stream_blob(request: web.Request, node: str, open_params: dict[str, Any],
                       download: bool) -> web.StreamResponse:
    blob = await link_call(request, node, "blob.open", open_params, timeout=120)
    bid, size = blob.get("blob_id"), int(blob.get("size") or 0)
    mime = str(blob.get("mime") or "application/octet-stream")
    name = str(blob.get("name") or "download")
    resp = web.StreamResponse(headers={
        "Content-Type": mime if not mime.startswith("text/") or "charset" in mime else mime + "; charset=utf-8",
        "Content-Length": str(size), "Cache-Control": "no-store",
        "Content-Disposition": _content_disposition("attachment" if download else "inline", name),
        # Files are user content from the node: never let them run script in the hub's origin.
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    })
    try:
        # The first chunk is read before the headers go out, so an early failure is a JSON error.
        chunk = await link_call(request, node, "blob.read", {"blob_id": bid, "offset": 0, "length": CHUNK},
                                timeout=60)
        await resp.prepare(request)
        offset = 0
        while True:
            data = base64.b64decode(chunk.get("data_b64") or "")
            if data:
                await resp.write(data)
                offset += len(data)
            if not data or chunk.get("eof") or offset >= size:
                break
            try:
                chunk = await link_call(request, node, "blob.read",
                                        {"blob_id": bid, "offset": offset, "length": CHUNK}, timeout=60)
            except ApiError as e:
                # Headers are sent: all we can do is cut the body short (Content-Length shows it).
                log.warning("download of %s from %s aborted at %d/%d: %s", name, node, offset, size, e.message)
                raise ConnectionResetError("download aborted") from None
        await resp.write_eof()
    finally:
        with contextlib.suppress(Exception):
            await hub_of(request).links.call(node, "blob.close", {"blob_id": bid}, timeout=10)
    return resp


async def _spool_part(part: BodyPartReader, cap: int, tmp_dir: str) -> tuple[Any, int]:
    """Read one multipart file part into a spooled temp file (≤ cap bytes)."""
    f = tempfile.SpooledTemporaryFile(max_size=SPOOL_MEM, dir=tmp_dir)
    size = 0
    try:
        while True:
            chunk = await part.read_chunk(CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if size > cap:
                raise ApiError(413, "too_large", f"file is larger than {cap // (1024 * 1024)} MB")
            f.write(chunk)
    except BaseException:
        f.close()
        raise
    f.seek(0)
    return f, size


async def _send_upload(request: web.Request, node: str, open_params: dict[str, Any], f: Any,
                       size: int) -> dict[str, Any]:
    up = await link_call(request, node, "upload.open", {**open_params, "size": size})
    uid = up.get("upload_id")
    try:
        offset = 0
        while offset < size:
            data = f.read(CHUNK)
            if not data:
                break
            await link_call(request, node, "upload.write",
                            {"upload_id": uid, "offset": offset, "data_b64": base64.b64encode(data).decode("ascii")},
                            timeout=60)
            offset += len(data)
        return await link_call(request, node, "upload.commit", {"upload_id": uid}, timeout=180)
    except BaseException:
        with contextlib.suppress(Exception):
            await hub_of(request).links.call(node, "upload.abort", {"upload_id": uid}, timeout=10)
        raise


def _tmp_dir(request: web.Request) -> str:
    d = str(hub_of(request).cfg.state_dir / "tmp")
    os.makedirs(d, exist_ok=True)
    return d


async def files_upload(request: web.Request) -> web.Response:
    node = node_param(request)
    require_v2(request, node)
    directory = abs_path(request.query.get("dir"), "dir")
    overwrite = request.query.get("overwrite") in ("1", "true")
    reader = await request.multipart()
    spooled: list[tuple[str, Any, int]] = []
    try:
        while True:
            part = await reader.next()
            if part is None:
                break
            if not isinstance(part, BodyPartReader) or part.name != "file" or not part.filename:
                continue
            f, size = await _spool_part(part, UPLOAD_MAX, _tmp_dir(request))
            spooled.append((part.filename, f, size))
        if not spooled:
            raise ApiError(400, "bad_request", "no file in the upload")
        if not overwrite:
            # Check every name first so a conflict uploads nothing.
            listing = await link_call(request, node, "fs.list", {"path": directory})
            existing = {e.get("name") for e in listing.get("entries") or []}
            clash = [name for name, _, _ in spooled if name in existing]
            if clash:
                raise ApiError(409, "exists", "files with these names exist", names=clash)
        out = []
        for name, f, size in spooled:
            out.append(await _send_upload(request, node, {"dir": directory, "name": name, "overwrite": overwrite},
                                          f, size))
        return web.json_response({"files": out})
    finally:
        for _, f, _ in spooled:
            f.close()


async def attach(request: web.Request) -> web.Response:
    node, sid = node_param(request), sid_param(request)
    require_v2(request, node)
    reader = await request.multipart()
    while True:
        part = await reader.next()
        if part is None:
            raise ApiError(400, "bad_request", "no file in the upload")
        if isinstance(part, BodyPartReader) and part.name == "file" and part.filename:
            break
    mime = part.headers.get("Content-Type") or "application/octet-stream"
    f, size = await _spool_part(part, ATTACH_MAX, _tmp_dir(request))
    try:
        res = await _send_upload(request, node, {"purpose": "attach", "stored_id": sid, "name": part.filename,
                                                 "mime": mime}, f, size)
    finally:
        f.close()
    return web.json_response(res)


# --- requests / deliveries (kept for debugging; the UI does not use them) --------------
async def requests_(request: web.Request) -> web.Response:
    live = hub_of(request).live
    return web.json_response({"requests": live.requests_list(), "items": live.requests_items()})


async def deliveries(request: web.Request) -> web.Response:
    hub = hub_of(request)
    limit = int_query(request, "limit", 100, 1, 1000)
    address = (request.query.get("address") or "").strip() or None
    status = (request.query.get("status") or "").strip() or None
    rows = await hub.store.run(hub.store.list_deliveries, limit, address, status)
    return web.json_response({"deliveries": rows})


async def send(request: web.Request) -> web.Response:
    body = await read_json(request)
    try:
        d = await hub_of(request).router.human_send(body.get("to"), body.get("message"),
                                                    bool(body.get("expect_reply", False)))
    except Rejected as r:
        raise ApiError(REJECT_STATUS.get(r.reason, 400), r.reason, r.message, **r.extra) from None
    return web.json_response({"delivery": d})


async def cancel_delivery(request: web.Request) -> web.Response:
    hub = hub_of(request)
    did = request.match_info["did"]
    d = await hub.router.cancel(did)
    if d is None:
        cur = await hub.store.run(hub.store.get_delivery, did)
        if cur is None:
            raise ApiError(404, "not_found", "unknown delivery")
        raise ApiError(409, "not_queued", f"delivery is {cur['status']}; only queued deliveries can be cancelled")
    return web.json_response({"delivery": d})


# --- join / app ------------------------------------------------------------------------
def join_env() -> dict[str, str]:
    keys = list(JOIN_ENV_KEYS) + sorted(k for k in os.environ if k.startswith("LLM_") and k not in JOIN_ENV_KEYS)
    return {k: os.environ[k] for k in keys if os.environ.get(k, "").strip()}


async def join(request: web.Request) -> web.Response:
    cfg = hub_of(request).cfg
    hub_url = cfg.public_url or f"{request.scheme}://{request.host}"
    env = join_env()
    payload = {"hub_url": hub_url, "join_token": cfg.join_token, "env": env}
    blob = "omni1." + base64.urlsafe_b64encode(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()).decode()
    command = f"git clone {REPO_URL} hermes-omni && cd hermes-omni && ./setup.sh --join '{blob}'"
    out: dict[str, Any] = {"hub_url": hub_url, "blob": blob, "command": command,
                           "env_preview": [f"{k}={mask(k, v)}" for k, v in env.items()]}
    if not cfg.public_url:
        out["warning"] = "OMNI_PUBLIC_URL is not set; hub_url was guessed from this request"
    return web.json_response(out)


def read_apk_meta(apk_dir: Any) -> dict[str, Any] | None:
    try:
        meta = json.loads((apk_dir / "meta.json").read_text())
        return meta if isinstance(meta, dict) else None
    except (OSError, ValueError):
        return None


async def app_info(request: web.Request) -> web.Response:
    apk_dir = hub_of(request).cfg.apk_dir
    available = (apk_dir / "hermes-omni.apk").is_file()
    out: dict[str, Any] = {"available": available, "url": "/app/hermes-omni.apk"}
    meta = read_apk_meta(apk_dir) if available else None
    if meta:
        for k in ("version_name", "version_code", "sha256", "size", "built_at"):
            if k in meta:
                out[k] = meta[k]
    return web.json_response(out)


async def api_not_found(request: web.Request) -> web.Response:
    return json_error(404, "not_found", f"no API route {request.method} {request.path}")


def setup_api(app: web.Application) -> None:
    r = app.router
    r.add_post("/api/login", login)
    r.add_post("/api/logout", logout)
    r.add_get("/api/me", me)
    r.add_get("/api/nodes", nodes)
    r.add_delete("/api/nodes/{node}", forget_node)
    r.add_get("/api/sessions", all_sessions)
    r.add_get("/api/search", search)
    r.add_get("/api/nodes/{node}/folders", list_folders)
    r.add_post("/api/nodes/{node}/folders", create_folder)
    r.add_post("/api/nodes/{node}/projects", create_folder)          # v2 alias
    r.add_post("/api/nodes/{node}/projects/rescan", rescan)
    r.add_get("/api/nodes/{node}/sessions", node_sessions)
    r.add_post("/api/nodes/{node}/sessions", create_session)
    r.add_get("/api/nodes/{node}/sessions/{sid}/messages", messages)
    r.add_post("/api/nodes/{node}/sessions/{sid}/prompt", prompt)
    r.add_post("/api/nodes/{node}/sessions/{sid}/interrupt", interrupt)
    r.add_post("/api/nodes/{node}/sessions/{sid}/respond", respond)
    r.add_get("/api/nodes/{node}/sessions/{sid}/export", export_session)
    r.add_post("/api/nodes/{node}/sessions/{sid}/attachments", attach)
    r.add_patch("/api/nodes/{node}/sessions/{sid}", update_session)
    r.add_delete("/api/nodes/{node}/sessions/{sid}", delete_session)
    r.add_post("/api/nodes/{node}/rpc", node_rpc)
    r.add_post("/api/nodes/{node}/rest", node_rest)
    r.add_get("/api/nodes/{node}/files", files_list)
    r.add_get("/api/nodes/{node}/files/text", files_text)
    r.add_get("/api/nodes/{node}/files/raw", files_raw)
    r.add_post("/api/nodes/{node}/files/upload", files_upload)
    r.add_get("/api/requests", requests_)
    r.add_get("/api/deliveries", deliveries)
    r.add_post("/api/deliveries/{did}/cancel", cancel_delivery)
    r.add_post("/api/send", send)
    r.add_get("/api/join", join)
    r.add_get("/api/app", app_info)
    r.add_route("*", "/api/{tail:.*}", api_not_found)
