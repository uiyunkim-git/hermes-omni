"""Static web UI, APK downloads and /healthz (design §6, §9).

Serves omni/web (or OMNI_WEB_DIR) at both / and /assets/: index.html loads /assets/app.js,
whose relative module imports then also resolve under /assets/. Unknown paths without a
file extension fall back to index.html (SPA); missing assets (paths with an extension) are a plain 404 so a broken
<script src> fails loudly instead of receiving HTML.
"""

from __future__ import annotations

import logging
import mimetypes
from pathlib import Path

from aiohttp import web

from omni import __version__

from .context import HUB_KEY

log = logging.getLogger("omni.hub.web")

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/manifest+json", ".webmanifest")

NO_CACHE = {"Cache-Control": "no-cache"}
APK_NAME = "hermes-omni.apk"
ASSETS_PREFIX = "assets/"   # /assets/<f> -> <web_dir>/<f> (design §6)


async def healthz(request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "version": __version__})


async def apk(request: web.Request) -> web.StreamResponse:
    path = request.app[HUB_KEY].cfg.apk_dir / APK_NAME
    if not path.is_file():
        return web.json_response({"error": {"code": "not_found", "message": "APK not built yet"}}, status=404)
    return web.FileResponse(path, headers={
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition": f'attachment; filename="{APK_NAME}"',
        "Cache-Control": "no-cache",
    })


async def apk_meta(request: web.Request) -> web.StreamResponse:
    path = request.app[HUB_KEY].cfg.apk_dir / "meta.json"
    if not path.is_file():
        return web.json_response({"error": {"code": "not_found", "message": "APK not built yet"}}, status=404)
    return web.FileResponse(path, headers={"Content-Type": "application/json", **NO_CACHE})


def _index(web_dir: Path) -> web.StreamResponse:
    index = web_dir / "index.html"
    if not index.is_file():
        return web.Response(status=503, text="hermes-omni web UI is not installed (omni/web/index.html missing)\n")
    return web.FileResponse(index, headers={"Content-Type": "text/html; charset=utf-8", **NO_CACHE})


async def static(request: web.Request) -> web.StreamResponse:
    web_dir: Path = request.app[HUB_KEY].cfg.web_dir
    tail = request.match_info.get("tail", "")
    if tail.startswith("api/") or tail == "api":
        return web.json_response({"error": {"code": "not_found", "message": "no such API route"}}, status=404)
    if tail.startswith(ASSETS_PREFIX):
        tail = tail[len(ASSETS_PREFIX):]
    if not tail or tail.endswith("/"):
        return _index(web_dir)
    root = web_dir.resolve()
    try:
        target = (root / tail).resolve()
    except (OSError, ValueError):
        raise web.HTTPNotFound() from None
    if not target.is_relative_to(root) or any(p.startswith(".") for p in Path(tail).parts):
        raise web.HTTPNotFound()
    if target.is_file():
        ctype, _ = mimetypes.guess_type(target.name)
        headers = dict(NO_CACHE)
        if ctype:
            headers["Content-Type"] = ctype + ("; charset=utf-8" if ctype.startswith("text/") else "")
        return web.FileResponse(target, headers=headers)
    if "." in Path(tail).name:
        raise web.HTTPNotFound()
    return _index(web_dir)


@web.middleware
async def security_headers(request: web.Request, handler):  # type: ignore[no-untyped-def]
    resp = await handler(request)
    if not resp.prepared:
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault("X-Frame-Options", "DENY")
    return resp


def setup_web(app: web.Application) -> None:
    r = app.router
    r.add_get("/healthz", healthz)
    r.add_get("/app/hermes-omni.apk", apk)
    r.add_get("/app/meta.json", apk_meta)
    r.add_get("/", static)
    r.add_get("/{tail:.*}", static)
