"""Browser authentication and request guards (design §6).

- Session credential: base64url(json{u,exp}) + "." + base64url(HMAC-SHA256), used both as the
  `omni_session` cookie and as a bearer token (`Authorization: Bearer` or `/ws?token=`).
- Login rate limit: 10 attempts / 60 s / client IP.
- CSRF: non-GET /api/* and the /ws upgrade require a same-origin Origin (when present);
  /api mutations also require `X-Omni: 1` and a JSON body (when a body is sent; the two upload
  routes take multipart/form-data instead).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import time
from collections import deque
from typing import Awaitable, Callable
from urllib.parse import urlsplit

from aiohttp import web

from omni.proto import HEADER_CSRF

from .config import Config, load_or_create_secret

log = logging.getLogger("omni.hub.auth")

COOKIE_NAME = "omni_session"
SESSION_TTL = 30 * 24 * 3600
LOGIN_LIMIT = 10
LOGIN_WINDOW = 60.0

# Paths reachable without a browser session (the /link endpoint does its own auth).
PUBLIC_API = {"/api/login", "/api/logout"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

USER_KEY = "omni_user"  # request[USER_KEY] -> authenticated user name
# Upload routes take multipart bodies (still behind the X-Omni header and the origin check).
MULTIPART_PATH_RE = re.compile(r"^/api/nodes/[^/]+/(files/upload|sessions/[^/]+/attachments)$")

Handler = Callable[[web.Request], Awaitable[web.StreamResponse]]


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def json_error(status: int, code: str, message: str) -> web.Response:
    return web.json_response({"error": {"code": code, "message": message}}, status=status)


class Auth:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._key = load_or_create_secret(cfg.state_dir / "secret", 32).encode()
        self._attempts: dict[str, deque[float]] = {}
        if not cfg.admin_user or not cfg.admin_password:
            log.warning("HERMES_DASHBOARD_BASIC_AUTH_USERNAME/PASSWORD not set: browser login disabled")

    # --- tokens ----------------------------------------------------------------------
    def issue(self, user: str, ttl: int = SESSION_TTL) -> str:
        body = _b64e(json.dumps({"u": user, "exp": int(time.time()) + ttl}, separators=(",", ":")).encode())
        sig = _b64e(hmac.new(self._key, body.encode(), hashlib.sha256).digest())
        return f"{body}.{sig}"

    def verify(self, token: str | None) -> str | None:
        """Return the user for a valid, unexpired token, else None."""
        if not token or "." not in token:
            return None
        body, _, sig = token.partition(".")
        want = _b64e(hmac.new(self._key, body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, want):
            return None
        try:
            data = json.loads(_b64d(body))
        except (ValueError, TypeError):
            return None
        if not isinstance(data, dict) or int(data.get("exp", 0)) < time.time():
            return None
        user = data.get("u")
        return user if isinstance(user, str) and user else None

    def check_password(self, username: str, password: str) -> bool:
        if not self.cfg.admin_user or not self.cfg.admin_password:
            return False
        ok_u = hmac.compare_digest(username.encode(), self.cfg.admin_user.encode())
        ok_p = hmac.compare_digest(password.encode(), self.cfg.admin_password.encode())
        return ok_u and ok_p

    def login_allowed(self, ip: str) -> bool:
        """Count an attempt for ip; False when over the limit."""
        now = time.monotonic()
        q = self._attempts.setdefault(ip, deque())
        while q and now - q[0] > LOGIN_WINDOW:
            q.popleft()
        if len(q) >= LOGIN_LIMIT:
            return False
        q.append(now)
        if len(self._attempts) > 1000:   # bound memory: drop idle entries
            for k in [k for k, v in self._attempts.items() if not v or now - v[-1] > LOGIN_WINDOW]:
                self._attempts.pop(k, None)
        return True

    def request_user(self, request: web.Request, allow_query: bool = False) -> str | None:
        authz = request.headers.get("Authorization", "")
        if authz.lower().startswith("bearer "):
            return self.verify(authz[7:].strip())
        if allow_query and request.query.get("token"):
            return self.verify(request.query["token"])
        return self.verify(request.cookies.get(COOKIE_NAME))

    def set_cookie(self, resp: web.StreamResponse, token: str) -> None:
        resp.set_cookie(COOKIE_NAME, token, max_age=SESSION_TTL, path="/", httponly=True, samesite="Lax")

    def clear_cookie(self, resp: web.StreamResponse) -> None:
        resp.del_cookie(COOKIE_NAME, path="/")

    # --- origin ----------------------------------------------------------------------
    def origin_ok(self, request: web.Request) -> bool:
        """Origin header absent, or same scheme+host as this request (or OMNI_PUBLIC_URL)."""
        origin = request.headers.get("Origin")
        if origin is None:
            return True
        if origin == "null":
            return False
        o = urlsplit(origin)
        if o.scheme == request.scheme and o.netloc.lower() == request.host.lower():
            return True
        if self.cfg.public_url:
            p = urlsplit(self.cfg.public_url)
            return (o.scheme, o.netloc.lower()) == (p.scheme, p.netloc.lower())
        return False

    # --- middleware ------------------------------------------------------------------
    @web.middleware
    async def middleware(self, request: web.Request, handler: Handler) -> web.StreamResponse:
        path = request.path
        if path == "/ws":
            if not self.origin_ok(request):
                return json_error(403, "bad_origin", "cross-origin WebSocket refused")
            user = self.request_user(request, allow_query=True)
            if not user:
                return json_error(401, "unauthorized", "login required")
            request[USER_KEY] = user
        elif path.startswith("/api/"):
            if request.method not in SAFE_METHODS:
                if not self.origin_ok(request):
                    return json_error(403, "bad_origin", "cross-origin request refused")
                if request.headers.get(HEADER_CSRF) != "1":
                    return json_error(403, "csrf", f"missing {HEADER_CSRF}: 1 header")
                if request.can_read_body and request.content_type != "application/json" and not (
                        request.content_type == "multipart/form-data" and MULTIPART_PATH_RE.match(path)):
                    return json_error(415, "json_required", "request body must be application/json")
            if path not in PUBLIC_API:
                user = self.request_user(request)
                if not user:
                    return json_error(401, "unauthorized", "login required")
                request[USER_KEY] = user
        return await handler(request)
