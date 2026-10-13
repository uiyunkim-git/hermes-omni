"""Persistent link state in /state (design §5 "Link persistence").

link.json  {node_key?, canonical:{path:{stored_id,title}}, inflight:{delivery_id:{stored_id,user_row_id,submitted_at}},
            last_seq:{stored_id:n}, runtime:{stored_id:{id,epoch}}}
status.json {connected, hub_url, node_id, at}   (polled by setup.sh)

All writes are atomic (tmp + rename). ``mark_dirty()`` coalesces bursts into one write.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
from typing import Any

log = logging.getLogger("omni.link.state")

_SAVE_DELAY = 0.5


def atomic_write_json(path: str, data: Any) -> None:
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class LinkState:
    def __init__(self, state_dir: str):
        self.dir = state_dir
        self.path = os.path.join(state_dir, "link.json")
        self.status_path = os.path.join(state_dir, "status.json")
        self.data: dict[str, Any] = {"canonical": {}, "inflight": {}, "last_seq": {}, "runtime": {}}
        self._save_handle: asyncio.TimerHandle | None = None

    # --- io ------------------------------------------------------------------------------
    def load(self) -> None:
        os.makedirs(self.dir, exist_ok=True)
        try:
            with open(self.path, encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                self.data.update(loaded)
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as e:
            log.warning("could not read %s (%s); starting with empty state", self.path, e)
        for key in ("canonical", "inflight", "last_seq", "runtime"):
            if not isinstance(self.data.get(key), dict):
                self.data[key] = {}

    def save_now(self) -> None:
        if self._save_handle is not None:
            self._save_handle.cancel()
            self._save_handle = None
        try:
            atomic_write_json(self.path, self.data)
        except OSError as e:
            log.error("failed to write %s: %s", self.path, e)

    def mark_dirty(self) -> None:
        if self._save_handle is None:
            loop = asyncio.get_running_loop()
            self._save_handle = loop.call_later(_SAVE_DELAY, self._deferred_save)

    def _deferred_save(self) -> None:
        self._save_handle = None
        self.save_now()

    def write_status(self, connected: bool, hub_url: str, node_id: str) -> None:
        try:
            atomic_write_json(self.status_path, {"connected": connected, "hub_url": hub_url,
                                                 "node_id": node_id, "at": time.time()})
        except OSError as e:
            log.error("failed to write %s: %s", self.status_path, e)

    # --- accessors -----------------------------------------------------------------------
    @property
    def canonical(self) -> dict[str, dict[str, Any]]:
        return self.data["canonical"]

    @property
    def inflight(self) -> dict[str, dict[str, Any]]:
        return self.data["inflight"]

    @property
    def last_seq(self) -> dict[str, int]:
        return self.data["last_seq"]

    @property
    def runtime(self) -> dict[str, dict[str, Any]]:
        return self.data["runtime"]

    def set_canonical(self, path: str, stored_id: str, title: str) -> None:
        self.canonical[path] = {"stored_id": stored_id, "title": title}
        self.mark_dirty()

    def drop_canonical(self, path: str) -> None:
        if self.canonical.pop(path, None) is not None:
            self.mark_dirty()

    def rename_stored(self, old: str, new: str) -> None:
        """A session's stored id rotated (compression tip); rewrite every reference."""
        for entry in self.canonical.values():
            if entry.get("stored_id") == old:
                entry["stored_id"] = new
        for entry in self.inflight.values():
            if entry.get("stored_id") == old:
                entry["stored_id"] = new
        if old in self.last_seq:
            self.last_seq[new] = self.last_seq.pop(old)
        if old in self.runtime:
            self.runtime[new] = self.runtime.pop(old)
        self.mark_dirty()
