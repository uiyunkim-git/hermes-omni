"""Shared hub context object (stored on the aiohttp app) and the API error type."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from aiohttp import web

from .auth import Auth
from .config import Config
from .links import LinkManager
from .live import Live
from .router import Router
from .sessions import SessionIndex
from .store import Store


class ApiError(Exception):
    """Raised by handlers; rendered as {"error":{code,message,...extra}} with the given HTTP status."""

    def __init__(self, status: int, code: str, message: str, **extra: Any):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra


@dataclass
class Hub:
    cfg: Config
    store: Store
    auth: Auth
    links: LinkManager
    router: Router
    live: Live
    index: SessionIndex


HUB_KEY = web.AppKey("omni_hub", Hub)
