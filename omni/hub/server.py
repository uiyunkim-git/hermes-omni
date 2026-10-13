"""Hub application factory and process entry point (design §6).

Wires Store, Auth, LinkManager, Router and Live together, registers routes
(/link, /ws, /api/*, static) and runs background tasks for the app's lifetime.
"""

from __future__ import annotations

import logging
import os
from typing import AsyncIterator

from aiohttp import web

from omni import __version__
from omni.proto import LINK_PATH

from .api import error_middleware, setup_api
from .auth import Auth
from .config import Config
from .context import HUB_KEY, Hub
from .links import LinkManager
from .live import Live
from .router import Router
from .store import Store
from .web import security_headers, setup_web

log = logging.getLogger("omni.hub")


def build_app(cfg: Config) -> web.Application:
    store = Store(cfg.db_path)
    auth = Auth(cfg)
    links = LinkManager(store, cfg.join_token)
    router = Router(store, links)
    live = Live(links)
    links.router, links.live, router.live = router, live, live
    hub = Hub(cfg=cfg, store=store, auth=auth, links=links, router=router, live=live)

    app = web.Application(middlewares=[security_headers, error_middleware, auth.middleware],
                          client_max_size=4 * 1024 * 1024)
    app[HUB_KEY] = hub
    app.router.add_get(LINK_PATH, links.handle)
    app.router.add_get("/ws", live.handle)
    setup_api(app)
    setup_web(app)   # last: contains the SPA catch-all
    app.cleanup_ctx.append(_lifecycle)
    app.on_shutdown.append(_on_shutdown)
    return app


async def _lifecycle(app: web.Application) -> AsyncIterator[None]:
    hub = app[HUB_KEY]
    await hub.store.open()
    await hub.links.start()
    hub.router.start()
    hub.live.start()
    log.info("hermes-omni hub %s listening on %s:%d (public url: %s, %d known nodes)", __version__,
             hub.cfg.host, hub.cfg.port, hub.cfg.public_url or "-", len(hub.links.nodes))
    yield
    await hub.live.stop()
    await hub.router.stop()
    await hub.store.close()


async def _on_shutdown(app: web.Application) -> None:
    hub = app[HUB_KEY]
    await hub.links.stop()
    await hub.live.close_all()


def main() -> None:
    os.umask(0o077)   # hub.db, secret: private to the hub user
    logging.basicConfig(level=os.environ.get("OMNI_LOG_LEVEL", "INFO").upper(),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = Config.from_env()
    app = build_app(cfg)
    web.run_app(app, host=cfg.host, port=cfg.port, print=None,
                access_log=logging.getLogger("aiohttp.access") if cfg.access_log else None,
                handle_signals=True, shutdown_timeout=5)


if __name__ == "__main__":
    main()
