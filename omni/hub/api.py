"""Browser REST API under /api (design §6). Auth/CSRF are enforced by auth.Auth.middleware."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from typing import Any

from aiohttp import web

from omni.proto import NEW_PROJECT_NAME_RE, NODE_ID_RE, STORED_ID_RE, RemoteError

from .auth import USER_KEY, json_error
from .context import HUB_KEY, ApiError, Hub
from .links import NodeUnavailable
from .router import Rejected

log = logging.getLogger("omni.hub.api")

REPO_URL = "https://github.com/uiyunkim-git/hermes-omni"
JOIN_ENV_KEYS = ("LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_API_MODE", "LLM_CONTEXT_LENGTH",
                 "HERMES_DASHBOARD_BASIC_AUTH_USERNAME", "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD", "TS_AUTHKEY")
SECRET_HINTS = ("KEY", "PASSWORD", "TOKEN", "SECRET")
PROMPT_MAX_CHARS = 100_000
REJECT_STATUS = {"unknown_target": 404, "unknown_project": 404}


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


async def link_call(request: web.Request, node: str, method: str, params: dict[str, Any],
                    timeout: float = 30) -> dict[str, Any]:
    try:
        return await hub_of(request).links.call(node, method, params, timeout)
    except NodeUnavailable as e:
        raise ApiError(503 if e.known else 404, "node_offline" if e.known else "unknown_node", str(e)) from None
    except RemoteError as e:
        raise ApiError(502, e.code, e.message) from None
    except ConnectionError:
        raise ApiError(503, "node_offline", f"link {node} disconnected") from None
    except TimeoutError:
        raise ApiError(504, "link_timeout", f"node {node} did not answer {method}") from None


def mask(key: str, value: str) -> str:
    if any(h in key.upper() for h in SECRET_HINTS):
        return "••••••••" if value else ""
    return value


@web.middleware
async def error_middleware(request: web.Request, handler: Any) -> web.StreamResponse:
    try:
        return await handler(request)
    except ApiError as e:
        return json_error(e.status, e.code, e.message)
    except web.HTTPException:
        raise
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("%s %s failed", request.method, request.path)
        if request.path.startswith("/api/"):
            return json_error(500, "internal", "internal error")
        raise


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


# --- nodes / projects ------------------------------------------------------------------
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


async def create_project(request: web.Request) -> web.Response:
    node = node_param(request)
    body = await read_json(request)
    root = abs_path(body.get("root"), "root")
    name = body.get("name")
    if not isinstance(name, str) or not NEW_PROJECT_NAME_RE.match(name) or name in (".", ".."):
        raise ApiError(400, "bad_request", "name must match [A-Za-z0-9._-]+")
    res = await link_call(request, node, "projects.create", {"root": root, "name": name})
    await _rescan(request, node)
    return web.json_response({"project": res.get("project")})


async def rescan(request: web.Request) -> web.Response:
    node = node_param(request)
    return web.json_response({"projects": await _rescan(request, node)})


async def _rescan(request: web.Request, node: str) -> list[Any]:
    res = await link_call(request, node, "projects.list", {})
    projects = res.get("projects") if isinstance(res.get("projects"), list) else []
    await hub_of(request).links.update_info(node, projects=projects)
    return projects


# --- sessions --------------------------------------------------------------------------
async def list_sessions(request: web.Request) -> web.Response:
    node = node_param(request)
    params: dict[str, Any] = {"limit": int_query(request, "limit", 50, 1, 500)}
    path = abs_path(request.query.get("path"), "path", required=False)
    if path:
        params["path"] = path
    res = await link_call(request, node, "sessions.list", params)
    return web.json_response({"sessions": res.get("sessions", [])})


async def create_session(request: web.Request) -> web.Response:
    node = node_param(request)
    body = await read_json(request)
    path = abs_path(body.get("path"), "path")
    if body.get("canonical"):
        res = await link_call(request, node, "session.ensure", {"path": path}, timeout=60)
    else:
        params: dict[str, Any] = {"path": path}
        title = body.get("title")
        if isinstance(title, str) and title.strip():
            params["title"] = title.strip()[:200]
        res = await link_call(request, node, "session.create", params, timeout=60)
    return web.json_response(res)


async def messages(request: web.Request) -> web.Response:
    node, sid = node_param(request), sid_param(request)
    limit = int_query(request, "limit", 200, 1, 1000)
    res = await link_call(request, node, "session.messages", {"stored_id": sid, "limit": limit}, timeout=60)
    return web.json_response({"messages": res.get("messages", [])})


async def prompt(request: web.Request) -> web.Response:
    node, sid = node_param(request), sid_param(request)
    body = await read_json(request)
    text, mode = body.get("text"), body.get("mode", "queue")
    if not isinstance(text, str) or not text.strip():
        raise ApiError(400, "bad_request", "text required")
    if len(text) > PROMPT_MAX_CHARS:
        raise ApiError(400, "bad_request", "text too long")
    if mode not in ("queue", "redirect"):
        raise ApiError(400, "bad_request", "mode must be queue or redirect")
    res = await link_call(request, node, "session.prompt", {"stored_id": sid, "text": text, "mode": mode},
                          timeout=60)
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


async def rename(request: web.Request) -> web.Response:
    node, sid = node_param(request), sid_param(request)
    body = await read_json(request)
    title = body.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ApiError(400, "bad_request", "title required")
    return web.json_response(await link_call(request, node, "session.rename",
                                             {"stored_id": sid, "title": title.strip()[:200]}))


async def delete_session(request: web.Request) -> web.Response:
    node, sid = node_param(request), sid_param(request)
    return web.json_response(await link_call(request, node, "session.delete", {"stored_id": sid}))


# --- requests / deliveries -------------------------------------------------------------
async def requests_(request: web.Request) -> web.Response:
    return web.json_response({"requests": hub_of(request).live.requests_list()})


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
        raise ApiError(REJECT_STATUS.get(r.reason, 400), r.reason, r.message) from None
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
    r.add_post("/api/nodes/{node}/projects", create_project)
    r.add_post("/api/nodes/{node}/projects/rescan", rescan)
    r.add_get("/api/nodes/{node}/sessions", list_sessions)
    r.add_post("/api/nodes/{node}/sessions", create_session)
    r.add_get("/api/nodes/{node}/sessions/{sid}/messages", messages)
    r.add_post("/api/nodes/{node}/sessions/{sid}/prompt", prompt)
    r.add_post("/api/nodes/{node}/sessions/{sid}/interrupt", interrupt)
    r.add_post("/api/nodes/{node}/sessions/{sid}/respond", respond)
    r.add_patch("/api/nodes/{node}/sessions/{sid}", rename)
    r.add_delete("/api/nodes/{node}/sessions/{sid}", delete_session)
    r.add_get("/api/requests", requests_)
    r.add_get("/api/deliveries", deliveries)
    r.add_post("/api/deliveries/{did}/cancel", cancel_delivery)
    r.add_post("/api/send", send)
    r.add_get("/api/join", join)
    r.add_get("/api/app", app_info)
    r.add_route("*", "/api/{tail:.*}", api_not_found)
