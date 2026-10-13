"""Process entry: logging, config, LinkAgent + Bridge lifecycle, graceful SIGTERM/SIGINT shutdown."""

from __future__ import annotations

import asyncio
import logging
import os
import signal

from omni import __version__
from omni.link.agent import LinkAgent
from omni.link.bridge import Bridge
from omni.link.config import Config, ConfigError

log = logging.getLogger("omni.link")


def _setup_logging() -> None:
    level = os.environ.get("OMNI_LOG_LEVEL", "INFO").upper()
    logging.basicConfig(level=getattr(logging, level, logging.INFO),
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)


async def _main(cfg: Config) -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    agent = LinkAgent(cfg)
    bridge = Bridge(agent)
    log.info("omni.link %s starting: node=%s role=%s hub=%s hermes=%s roots=%s%s", __version__, cfg.node_id,
             cfg.role, cfg.hub_url, cfg.hermes_url, ",".join(cfg.project_roots),
             f" via {cfg.socks_proxy}" if cfg.socks_proxy else "")
    await agent.start()
    try:
        await bridge.start()
        await stop.wait()
        log.info("shutting down")
    finally:
        await bridge.stop()
        await agent.stop()


def run() -> int:
    _setup_logging()
    try:
        cfg = Config.from_env()
    except ConfigError as e:
        log.error("configuration error: %s", e)
        return 2
    asyncio.run(_main(cfg))
    return 0
