"""Shared protocol constants and helpers for the hub <-> link protocol (design §4/§5).

Both omni.hub and omni.link import from here; do not redefine these elsewhere.
Stdlib only.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from omni import PROTO, __version__

# --- transport -----------------------------------------------------------------------
LINK_PATH = "/link"
PING_INTERVAL = 20          # seconds between pings, each direction
OFFLINE_AFTER = 60          # hub marks a node offline after this much silence
HEADER_NODE = "X-Omni-Node"
HEADER_PROTO = "X-Omni-Proto"
HEADER_LINK_TOKEN = "X-Omni-Token"   # plugin -> link bridge
HEADER_CSRF = "X-Omni"               # browser -> hub mutations

# --- messaging -----------------------------------------------------------------------
MARKER_RE = re.compile(r"⟦omni:([A-Za-z0-9_-]{6,64})⟧")
FORWARD_REQUEST_METHODS = ("approval", "clarify", "sudo", "secret")
MAX_HOPS = 4
WAIT_MAX_S = 300
WAIT_DEFAULT_S = 120
MESSAGE_MAX_CHARS = 20000

NODE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
PROJECT_NAME_RE = re.compile(r"^[A-Za-z0-9._~-]+$")
NEW_PROJECT_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
STORED_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")

CANONICAL_TITLE_PREFIX = "📁 "


def marker(delivery_id: str) -> str:
    return f"⟦omni:{delivery_id}⟧"


def find_marker(text: str | None) -> str | None:
    """Return the delivery id of the first omni marker in text, if any."""
    if not text:
        return None
    m = MARKER_RE.search(text)
    return m.group(1) if m else None


def new_delivery_id() -> str:
    return "d_" + uuid.uuid4().hex[:16]


def new_request_id() -> str:
    return uuid.uuid4().hex


def canonical_title(project_name: str) -> str:
    return CANONICAL_TITLE_PREFIX + project_name


# --- addresses -----------------------------------------------------------------------
def format_address(node: str, project: str | None = None, stored_id: str | None = None) -> str:
    """"node/project", "node/project#sid" or "node#sid"."""
    out = node
    if project:
        out += "/" + project
    if stored_id:
        out += "#" + stored_id
    return out


def parse_address(s: str) -> dict[str, str | None]:
    """Parse an address. Raises ValueError on malformed input.

    Returns {"node": str, "project": str|None, "stored_id": str|None}.
    """
    if not isinstance(s, str) or not s.strip():
        raise ValueError("empty address")
    s = s.strip()
    stored_id = None
    if "#" in s:
        s, stored_id = s.split("#", 1)
        if not STORED_ID_RE.match(stored_id):
            raise ValueError(f"bad session id in address: {stored_id!r}")
    project = None
    if "/" in s:
        s, project = s.split("/", 1)
        if not PROJECT_NAME_RE.match(project):
            raise ValueError(f"bad project name in address: {project!r}")
    node = s.lower()
    if not NODE_ID_RE.match(node):
        raise ValueError(f"bad node id in address: {node!r}")
    if project is None and stored_id is None:
        raise ValueError("address needs a project (node/project) or a session (node#id)")
    return {"node": node, "project": project, "stored_id": stored_id}


# --- frames --------------------------------------------------------------------------
def req(id: str, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"t": "req", "id": id, "method": method, "params": params or {}}


def res_ok(id: str, result: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"t": "res", "id": id, "ok": True, "result": result or {}}


def res_err(id: str, code: str, message: str) -> dict[str, Any]:
    return {"t": "res", "id": id, "ok": False, "error": {"code": code, "message": message}}


def ev(kind: str, **fields: Any) -> dict[str, Any]:
    return {"t": "ev", "kind": kind, **fields}


class RemoteError(Exception):
    """An error returned in a {"t":"res","ok":false} frame."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


# --- prompt texts --------------------------------------------------------------------
def format_request_text(delivery_id: str, from_addr: str, message: str, expect_reply: bool) -> str:
    if expect_reply:
        tail = (f"— Answer in your final reply of this turn; it is delivered back to {from_addr} automatically. "
                "Do not hub_send your answer back yourself.")
    else:
        tail = "— No reply is expected."
    return f"{marker(delivery_id)} Message from {from_addr} (via hermes-omni)\n\n{message}\n\n{tail}"


def format_reply_text(delivery_id: str, orig_delivery_id: str, from_addr: str, reply: str | None) -> str:
    body = reply if reply else "(empty reply)"
    return (f"{marker(delivery_id)} Reply from {from_addr} to your message {orig_delivery_id} (via hermes-omni)\n\n"
            f"{body}\n\n— This is a reply. You don't need to answer it unless you want to follow up with hub_send.")


__all__ = [name for name in dir() if not name.startswith("_")] + ["PROTO", "__version__"]
