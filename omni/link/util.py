"""Small helpers shared by the link modules: trimming, backoff, task bookkeeping."""

from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any, Coroutine

log = logging.getLogger("omni.link")


def trim(text: Any, limit: int) -> str | None:
    """Return text cut to ``limit`` chars (with an ellipsis marker), or None for None."""
    if text is None:
        return None
    if not isinstance(text, str):
        text = to_text(text)
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


def to_text(value: Any) -> str:
    """Render arbitrary message content (str, list of parts, dict) as plain text."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for p in value:
            if isinstance(p, dict) and isinstance(p.get("text"), str):
                parts.append(p["text"])
            elif isinstance(p, str):
                parts.append(p)
            else:
                parts.append(json.dumps(p, ensure_ascii=False, default=str))
        return "\n".join(parts)
    return json.dumps(value, ensure_ascii=False, default=str)


class Backoff:
    """Exponential backoff with full jitter; ``reset()`` after a stable success."""

    def __init__(self, base: float = 1.0, cap: float = 60.0):
        self.base, self.cap, self.attempt = base, cap, 0

    def next_delay(self) -> float:
        ceiling = min(self.cap, self.base * (2 ** self.attempt))
        self.attempt = min(self.attempt + 1, 16)
        return random.uniform(ceiling / 2, ceiling)

    def reset(self) -> None:
        self.attempt = 0


class TaskSet:
    """Keeps strong refs to fire-and-forget tasks and logs their failures."""

    def __init__(self, name: str):
        self.name = name
        self._tasks: set[asyncio.Task] = set()

    def spawn(self, coro: Coroutine[Any, Any, Any], name: str | None = None) -> asyncio.Task:
        task = asyncio.get_running_loop().create_task(coro, name=name)
        self._tasks.add(task)
        task.add_done_callback(self._done)
        return task

    def _done(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            log.error("%s task %s failed: %r", self.name, task.get_name(), exc, exc_info=exc)

    async def cancel_all(self) -> None:
        tasks = list(self._tasks)
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
