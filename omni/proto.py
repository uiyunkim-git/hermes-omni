"""Shared protocol constants and helpers for the hub <-> link protocol (design §4/§5, v3 spec §5).

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
PROTO_MIN = 1               # oldest link protocol the hub still accepts (rollout window)
PING_INTERVAL = 20          # seconds between pings, each direction
OFFLINE_AFTER = 60          # hub marks a node offline after this much silence
HEADER_NODE = "X-Omni-Node"
HEADER_PROTO = "X-Omni-Proto"
HEADER_LINK_TOKEN = "X-Omni-Token"   # plugin -> link bridge
HEADER_CSRF = "X-Omni"               # browser -> hub mutations

# --- messaging -----------------------------------------------------------------------
MARKER_RE = re.compile(r"⟦omni:([A-Za-z0-9_-]{6,64})⟧")
HEADER_RE = re.compile(r'^⟦omni:(?P<id>[A-Za-z0-9_-]{6,64})⟧ (?P<kind>Message|Reply) from '
                       r'(?:"(?P<title>[^"\n]{0,80})" \((?P<addr>[^)\s]+)\)|(?P<addr2>\S+))(?P<rest>[^\n]*)$')
FORWARD_REQUEST_METHODS = ("approval", "clarify", "sudo", "secret")
MAX_HOPS = 16               # causal chain length (message → reply → message …)
PAIR_MESSAGE_CAP = 12       # messages between one pair of sessions within one conversation
WAIT_MAX_S = 300
WAIT_DEFAULT_S = 120
MESSAGE_MAX_CHARS = 20000
TITLE_MAX = 200             # session titles (rename / create)
TO_MAX = 200                # hub_send "to"
HEADER_TITLE_MAX = 80       # titles quoted in message headers

# Sessions that never appear in the hub (internal runs of Hermes itself).
EXCLUDED_SOURCES = ("tool", "oneshot", "kanban", "subagent", "cron")

NODE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
PROJECT_NAME_RE = re.compile(r"^[A-Za-z0-9._~-]+$")
NEW_PROJECT_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
STORED_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")

CANONICAL_TITLE_PREFIX = "📁 "   # legacy (v2 "main session per folder"); no longer created


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
    """Legacy only: the v2 canonical-session title of a folder."""
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


def session_key(node: str, stored_id: str) -> str:
    """The hub-wide key (and canonical address) of a session: ``node#sid``."""
    return f"{node}#{stored_id}"


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


def try_parse_address(s: Any) -> dict[str, str | None] | None:
    """Like parse_address but never raises: strips a leading "omni:" / "@" and returns None for
    anything that is not an address (e.g. a session title)."""
    if not isinstance(s, str):
        return None
    s = s.strip()
    if s.startswith("@"):
        s = s[1:].strip()
    if s.lower().startswith("omni:"):
        s = s[5:].strip()
    if not s or any(c.isspace() for c in s):
        return None
    try:
        return parse_address(s)
    except ValueError:
        return None


def clean_title(t: Any) -> str:
    """A session title as quoted in message headers: no double quotes, one line, ≤ 80 chars."""
    if not isinstance(t, str):
        return ""
    t = " ".join(t.replace('"', "'").split())
    return t if len(t) <= HEADER_TITLE_MAX else t[: HEADER_TITLE_MAX - 1] + "…"


# --- frames --------------------------------------------------------------------------
def req(id: str, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"t": "req", "id": id, "method": method, "params": params or {}}


def res_ok(id: str, result: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"t": "res", "id": id, "ok": True, "result": result or {}}


def res_err(id: str, code: str, message: str, **extra: Any) -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message}
    err.update(extra)
    return {"t": "res", "id": id, "ok": False, "error": err}


def ev(kind: str, **fields: Any) -> dict[str, Any]:
    return {"t": "ev", "kind": kind, **fields}


class RemoteError(Exception):
    """An error returned in a {"t":"res","ok":false} frame. ``extra`` keeps additional fields
    of the error object (e.g. ``surface`` for session_locked)."""

    def __init__(self, code: str, message: str, **extra: Any):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.extra = extra


# --- prompt texts --------------------------------------------------------------------
REQUEST_TAIL = ("— Answer in your final reply of this turn; it is delivered back to {from_addr} automatically. "
                "Do not hub_send your answer back yourself. You may ask clarifying questions in your reply.")
NO_REPLY_TAIL = "— No reply is expected."
REPLY_TAIL = ("— This is the reply to your message. Continue the task your user gave you; if you need more "
              "from them, hub_send again; when done, report the outcome to your user.")


def _from_part(from_addr: str, from_title: str | None) -> str:
    title = clean_title(from_title) if from_title else ""
    return f'"{title}" ({from_addr})' if title else from_addr


def format_request_text(delivery_id: str, from_addr: str, message: str, expect_reply: bool,
                        from_title: str | None = None) -> str:
    tail = REQUEST_TAIL.format(from_addr=from_addr) if expect_reply else NO_REPLY_TAIL
    return (f"{marker(delivery_id)} Message from {_from_part(from_addr, from_title)} via hermes-omni\n\n"
            f"{message}\n\n{tail}")


def format_reply_text(delivery_id: str, orig_delivery_id: str, from_addr: str, reply: str | None,
                      from_title: str | None = None) -> str:
    body = reply if reply else "(empty reply)"
    return (f"{marker(delivery_id)} Reply from {_from_part(from_addr, from_title)} to your message "
            f"{orig_delivery_id} (via hermes-omni)\n\n{body}\n\n{REPLY_TAIL}")


def parse_omni_header(text: Any) -> dict[str, Any] | None:
    """Parse a delivered message (the user row of a delivery turn).

    Returns {delivery_id, kind: "message"|"reply", from, from_title|None, body} or None when the
    text does not start with an omni header. ``body`` drops the header line, leading blank lines
    and a trailing "— …" instruction paragraph.
    """
    if not isinstance(text, str) or not text.startswith("⟦omni:"):
        return None
    first, _, rest = text.partition("\n")
    m = HEADER_RE.match(first)
    if m is None:
        return None
    body = rest.lstrip("\n")
    paras = body.rstrip().split("\n\n")
    if len(paras) > 1 and paras[-1].lstrip().startswith("— "):
        paras = paras[:-1]
    elif len(paras) == 1 and paras[0].lstrip().startswith("— "):
        paras = []
    title = m.group("title")
    return {"delivery_id": m.group("id"), "kind": "message" if m.group("kind") == "Message" else "reply",
            "from": m.group("addr") or m.group("addr2"), "from_title": title if title else None,
            "body": "\n\n".join(paras).strip()}


# --- Hermes passthrough allowlist (spec §5b.1) -------------------------------------------
# Enforced by the link (authoritative) and re-checked by the hub. A rule names the allowed
# params and whether a session (stored_id) is required ("S"), forbidden ("N") or optional ("*").
SLASH_BLOCKED = frozenset(("/quit", "/exit", "/clear", "/config", "/statusbar", "/approve", "/deny", "/login",
                           "/logout", "/model", "/skills", "/new", "/resume", "/yolo"))
SESSION_CONFIG_KEYS = frozenset(("model", "reasoning", "fast", "yolo"))
APPROVAL_MODES = ("manual", "smart", "off")
RPC_TIMEOUT_S = 30.0
RPC_LONG_TIMEOUT_S = 60.0
RPC_LONG = frozenset(("session.compress", "slash.exec"))

_RPC_PARAMS: dict[str, tuple[str, frozenset[str]]] = {
    "model.options": ("*", frozenset()),
    "config.set": ("*", frozenset(("key", "value", "confirm_expensive_model"))),
    "config.get": ("N", frozenset(("key",))),
    "session.usage": ("S", frozenset()),
    "session.context_breakdown": ("S", frozenset()),
    "session.status": ("S", frozenset()),
    "tools.list": ("S", frozenset()),
    "commands.catalog": ("S", frozenset()),
    "session.compress": ("S", frozenset(("focus_topic",))),
    "complete.slash": ("S", frozenset(("text",))),
    "slash.exec": ("S", frozenset(("command",))),
    "command.dispatch": ("S", frozenset(("name", "arg"))),
    "profiles.list": ("N", frozenset()),
}
RPC_METHODS = frozenset(_RPC_PARAMS)


class Forbidden(ValueError):
    """A passthrough call outside the allowlist."""


def check_rpc(method: Any, params: Any, has_session: bool) -> None:
    """Raise Forbidden unless ``method(params)`` is allowed (with or without a session)."""
    rule = _RPC_PARAMS.get(method) if isinstance(method, str) else None
    if rule is None:
        raise Forbidden(f"method {method!r} is not allowed")
    scope, allowed = rule
    if not isinstance(params, dict):
        raise Forbidden("params must be an object")
    extra = set(params) - allowed
    if extra:
        raise Forbidden(f"{method}: parameter(s) not allowed: {', '.join(sorted(extra))}")
    if scope == "S" and not has_session:
        raise Forbidden(f"{method} needs a session")
    if scope == "N" and has_session:
        raise Forbidden(f"{method} is node-scoped")
    if method == "config.set":
        key, value = params.get("key"), params.get("value")
        if has_session:
            if key not in SESSION_CONFIG_KEYS:
                raise Forbidden(f"config.set key {key!r} is not allowed for a session")
        elif key != "approvals.mode" or value not in APPROVAL_MODES:
            raise Forbidden("node config.set only allows approvals.mode = manual|smart|off")
        if not isinstance(value, (str, bool, int, float)):
            raise Forbidden("config.set value must be a scalar")
    elif method == "config.get":
        if params.get("key") != "approvals.mode":
            raise Forbidden("config.get only allows approvals.mode")
    elif method == "slash.exec":
        command = params.get("command")
        if not isinstance(command, str) or not command.startswith("/"):
            raise Forbidden("slash.exec command must start with /")
        name = command.split(None, 1)[0].lower() if command.strip() else ""
        if name in SLASH_BLOCKED:
            raise Forbidden(f"{name} is not available here")
    elif method == "command.dispatch":
        name = params.get("name")
        if not isinstance(name, str) or not name.strip():
            raise Forbidden("command.dispatch needs a name")
        if "/" + name.strip().lstrip("/").split(None, 1)[0].lower() in SLASH_BLOCKED:
            raise Forbidden(f"/{name} is not available here")
    for k in ("text", "focus_topic", "arg"):
        if k in params and not isinstance(params[k], str):
            raise Forbidden(f"{k} must be a string")


def rpc_timeout(method: str) -> float:
    return RPC_LONG_TIMEOUT_S if method in RPC_LONG else RPC_TIMEOUT_S


_W = r"[A-Za-z0-9_-]+"
REST_ALLOW: tuple[tuple[frozenset[str], re.Pattern[str]], ...] = tuple(
    (frozenset(methods), re.compile(pattern)) for methods, pattern in (
        (("GET",), r"^/api/(status|system/stats|logs|profiles|model/options|memory)$"),
        (("GET",), r"^/api/skills(/content)?$"),
        (("PUT",), r"^/api/skills/toggle$"),
        (("GET",), r"^/api/learning/(graph|node)$"),
        (("PUT", "DELETE"), r"^/api/learning/node$"),
        (("GET",), rf"^/api/cron/(jobs|jobs/{_W}/runs|delivery-targets)$"),
        (("POST",), rf"^/api/cron/jobs(/{_W}/(pause|resume|trigger))?$"),
        (("PUT", "DELETE"), rf"^/api/cron/jobs/{_W}$"),
        (("GET",), r"^/api/analytics/usage$"),
    ))


def check_rest(method: Any, path: Any) -> None:
    """Raise Forbidden unless ``method path`` (path before any '?') is on the allowlist."""
    if not isinstance(method, str) or not isinstance(path, str):
        raise Forbidden("method and path required")
    m = method.upper()
    p = path.split("?", 1)[0]
    if ".." in p or "//" in p or "\\" in p or "%" in p:
        raise Forbidden("bad path")
    for methods, pattern in REST_ALLOW:
        if m in methods and pattern.match(p):
            return
    raise Forbidden(f"{m} {p} is not allowed")


__all__ = [name for name in dir() if not name.startswith("_")] + ["PROTO", "__version__"]
