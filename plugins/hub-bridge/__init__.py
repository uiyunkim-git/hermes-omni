"""hermes-omni hub-bridge plugin: lets a Hermes session talk to sessions on other projects/machines.

Registers three tools (toolset "hub") that call the local omni link bridge over HTTP
(``$OMNI_LINK_URL/bridge/...`` with header ``X-Omni-Token: $OMNI_LINK_TOKEN``); the link
forwards to the hub. See design §7.

Notes for maintainers:
- ``register()`` runs in several Hermes processes (gateway, dashboard, workers): it must stay
  cheap and side-effect free.
- Handlers run on worker threads and must accept ``**kwargs``; Hermes passes ``session_id``
  (the stored session id, i.e. the current compression tip) only to handlers that accept it.
- This file runs inside the hermes container where the ``omni`` package is NOT importable,
  so the few protocol constants it needs are copied below. Stdlib only.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

logger = logging.getLogger(__name__)

# --- copied from omni/proto.py (keep in sync) ------------------------------------------
HEADER_LINK_TOKEN = "X-Omni-Token"
WAIT_MAX_S = 300
WAIT_DEFAULT_S = 120
MESSAGE_MAX_CHARS = 20000
# ----------------------------------------------------------------------------------------

ENV_URL = "OMNI_LINK_URL"
ENV_TOKEN = "OMNI_LINK_TOKEN"
TOOLSET = "hub"
EMOJI = "🛰"
HTTP_TIMEOUT_S = 30           # non-blocking bridge calls
WAIT_HTTP_SLACK_S = 15        # added to timeout_s for hub_send(wait=true)
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
ADDRESS_MAX_CHARS = 300
INBOX_LIMIT_MAX = 100

# Never route compose-internal traffic through an HTTP(S)_PROXY from the environment.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

PROMPT_SECTION = """\
This Hermes session is part of hermes-omni, a network of Hermes agents across machines ("nodes"). \
Each project folder on each node has a main session, and you can message any session.
Addresses: "node/project" = that project's main session; "node/project#id" or "node#id" = a specific session.
Tools (find them via tool search if not listed): hub_directory() lists nodes, projects and addresses; \
hub_send(to, message, wait=false, expect_reply=true, timeout_s=120) sends a message; \
hub_inbox(limit) shows recent messages to/from this session.
- By default hub_send returns at once; the reply arrives later as a new turn starting with ⟦omni:<id>⟧ "Reply from ...". \
wait=true blocks up to timeout_s (max 300) and returns the reply directly if the target is idle.
- A turn starting with ⟦omni:<id>⟧ "Message from ..." comes from another agent, not your human. \
If a reply is expected, answer in your final message of that turn; it is delivered back automatically. \
Never hub_send a reply back yourself.
Etiquette: make messages self-contained (the recipient does not share your context: give paths, goals, constraints); \
be concise; avoid back-and-forth loops; never message your own session."""


# --- helpers ---------------------------------------------------------------------------
class _ArgError(ValueError):
    """Invalid tool arguments; reported to the model as reason "invalid_args"."""


def _result(obj: dict[str, Any]) -> str:
    return json.dumps(obj, ensure_ascii=False)


def _error(reason: str, message: str, **extra: Any) -> str:
    return _result({"status": "error", "reason": reason, "message": message, **extra})


def _configured() -> bool:
    return bool(os.environ.get(ENV_URL, "").strip() and os.environ.get(ENV_TOKEN, "").strip())


def _session_id(kwargs: dict[str, Any]) -> str | None:
    sid = kwargs.get("session_id") or kwargs.get("task_id")
    return sid.strip() if isinstance(sid, str) and sid.strip() else None


def _as_bool(args: dict[str, Any], key: str, default: bool) -> bool:
    v = args.get(key)
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)) and v in (0, 1):
        return bool(v)
    if isinstance(v, str) and v.strip().lower() in ("true", "yes", "1", "false", "no", "0"):
        return v.strip().lower() in ("true", "yes", "1")
    raise _ArgError(f"{key} must be a boolean")


def _as_int(args: dict[str, Any], key: str, default: int, lo: int, hi: int) -> int:
    """Parse an integer argument and clamp it to [lo, hi]."""
    v = args.get(key)
    if v is None or v == "":
        return default
    if isinstance(v, bool):
        raise _ArgError(f"{key} must be an integer")
    try:
        n = int(float(v)) if isinstance(v, (str, float)) else int(v)
    except (TypeError, ValueError):
        raise _ArgError(f"{key} must be an integer") from None
    return max(lo, min(hi, n))


def _as_str(args: dict[str, Any], key: str) -> str:
    v = args.get(key)
    if not isinstance(v, str) or not v.strip():
        raise _ArgError(f"{key} is required and must be a non-empty string")
    return v


def _bridge(method: str, path: str, *, query: dict[str, Any] | None = None,
            body: dict[str, Any] | None = None, timeout: float = HTTP_TIMEOUT_S) -> dict[str, Any]:
    """Call the link bridge. Always returns a dict; failures become {"status":"error",...}."""
    base = os.environ.get(ENV_URL, "").strip().rstrip("/")
    token = os.environ.get(ENV_TOKEN, "").strip()
    if not base or not token:
        return {"status": "error", "reason": "not_configured",
                "message": f"{ENV_URL}/{ENV_TOKEN} are not set; hermes-omni is not available on this node"}
    url = base + path + ("?" + urllib.parse.urlencode(query) if query else "")
    headers = {HEADER_LINK_TOKEN: token, "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            status, raw = resp.status, resp.read(MAX_RESPONSE_BYTES)
    except urllib.error.HTTPError as e:
        status, raw = e.code, (e.read(MAX_RESPONSE_BYTES) if e.fp else b"")
    except TimeoutError:
        logger.warning("%s %s timed out after %.0fs", method, path, timeout)
        return {"status": "error", "reason": "link_timeout",
                "message": f"no answer from the omni link within {timeout:.0f}s"}
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, TimeoutError):
            logger.warning("%s %s connect timed out", method, path)
        else:
            logger.warning("%s %s failed: %s", method, path, reason)
        return {"status": "error", "reason": "link_unreachable",
                "message": "the omni link on this machine is not reachable; try again later"}

    try:
        payload = json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = None
    if 200 <= status < 300:
        if isinstance(payload, dict):
            return payload
        logger.warning("%s %s returned non-object JSON (HTTP %s)", method, path, status)
        return {"status": "error", "reason": "bad_response", "message": "the omni link returned an invalid response"}

    # The bridge reports bad input as HTTP 400 {"status":"rejected","reason"}; pass it through so the
    # model sees the same shape the hub returns (HTTP 200) for the same kind of problem.
    if isinstance(payload, dict) and payload.get("status") == "rejected" and status not in (401, 403):
        logger.warning("%s %s -> HTTP %s rejected (%s)", method, path, status, payload.get("reason"))
        payload.setdefault("message", str(payload.get("reason") or "the request was rejected"))
        return payload

    # Error response: accept {"reason","message"} or {"error": str | {"code","message"}}.
    reason, message = f"http_{status}", ""
    if isinstance(payload, dict):
        err = payload.get("error")
        if isinstance(err, dict):
            reason = str(err.get("code") or reason)
            message = str(err.get("message") or "")
        elif isinstance(err, str) and err:
            reason = err
        reason = str(payload.get("reason") or reason)
        message = str(payload.get("message") or message)
    if status in (401, 403):
        reason = "link_auth_failed"
        message = message or "the omni link rejected this node's token"
    logger.warning("%s %s -> HTTP %s (%s)", method, path, status, reason)
    return {"status": "error", "reason": reason, "message": message or f"omni link error (HTTP {status})"}


# --- tool handlers ---------------------------------------------------------------------
def hub_directory(args: dict[str, Any], **kwargs: Any) -> str:
    """List nodes, their projects and the addresses usable with hub_send."""
    sid = _session_id(kwargs)
    return _result(_bridge("GET", "/bridge/directory", query={"session_id": sid or ""}))


def hub_send(args: dict[str, Any], **kwargs: Any) -> str:
    """Send a message to another session through the hub."""
    sid = _session_id(kwargs)
    if not sid:
        return _error("no_session", "hub_send needs a session id; it is not available in this context")
    try:
        to = _as_str(args, "to").strip()
        message = _as_str(args, "message")
        wait = _as_bool(args, "wait", False)
        expect_reply = _as_bool(args, "expect_reply", True)
        timeout_s = _as_int(args, "timeout_s", WAIT_DEFAULT_S, 1, WAIT_MAX_S)
    except _ArgError as e:
        return _error("invalid_args", str(e))
    if len(to) > ADDRESS_MAX_CHARS or any(c.isspace() for c in to) or ("/" not in to and "#" not in to):
        return _error("invalid_args", 'to must be an address like "node/project", "node/project#id" or "node#id" '
                                      "(see hub_directory)")
    if len(message) > MESSAGE_MAX_CHARS:
        return _error("invalid_args", f"message is {len(message)} chars; the limit is {MESSAGE_MAX_CHARS}")

    body = {"session_id": sid, "to": to, "message": message, "wait": wait,
            "expect_reply": expect_reply, "timeout_s": timeout_s}
    http_timeout = timeout_s + WAIT_HTTP_SLACK_S if wait else HTTP_TIMEOUT_S
    res = _bridge("POST", "/bridge/send", body=body, timeout=http_timeout)
    status = res.get("status")
    logger.info("hub_send %s -> %s wait=%s: %s %s", sid, to, wait, status, res.get("reason") or "")

    if status == "queued" and expect_reply:
        res.setdefault("note", "Sent. The reply will arrive later as a new turn starting with ⟦omni:…⟧; "
                               "no need to poll.")
    elif status == "timeout":
        res.setdefault("note", "No reply within timeout_s. The message is still being handled; "
                               "the reply will arrive later as a new turn starting with ⟦omni:…⟧.")
    elif status == "error" and res.get("reason") == "link_timeout":
        res["note"] = "The message may still have been delivered; check hub_inbox before resending."
    return _result(res)


def hub_inbox(args: dict[str, Any], **kwargs: Any) -> str:
    """Recent deliveries to/from this session."""
    sid = _session_id(kwargs)
    if not sid:
        return _error("no_session", "hub_inbox needs a session id; it is not available in this context")
    try:
        limit = _as_int(args, "limit", 20, 1, INBOX_LIMIT_MAX)
    except _ArgError as e:
        return _error("invalid_args", str(e))
    return _result(_bridge("GET", "/bridge/inbox", query={"session_id": sid, "limit": limit}))


# --- registration ----------------------------------------------------------------------
def _prompt_section(_session_info: Any) -> str:
    """System prompt text; empty (section skipped) when the link is not configured."""
    return PROMPT_SECTION if _configured() else ""


_SCHEMAS: dict[str, dict[str, Any]] = {
    "hub_directory": {
        "name": "hub_directory",
        "description": ("hermes-omni: list the nodes (machines) in the network, whether they are online, and "
                        "their projects with the addresses to use with hub_send."),
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "hub_send": {
        "name": "hub_send",
        "description": ("hermes-omni: send a self-contained message to another Hermes session (another project "
                        "or machine). Returns {delivery_id, status, reply?, reason?}. By default returns "
                        "immediately and the reply arrives later as a new turn marked ⟦omni:…⟧; wait=true "
                        "blocks until the reply (or timeout_s). Do not use this to answer an incoming "
                        "⟦omni:…⟧ message: just answer in your final reply."),
        "parameters": {
            "type": "object",
            "properties": {
                "to": {"type": "string",
                       "description": 'Address: "node/project", "node/project#session_id" or "node#session_id".'},
                "message": {"type": "string",
                            "description": f"Self-contained message text (max {MESSAGE_MAX_CHARS} chars)."},
                "wait": {"type": "boolean", "default": False,
                         "description": "Block until the target replies (only if it is idle). Default false."},
                "expect_reply": {"type": "boolean", "default": True,
                                 "description": "Whether the recipient should reply. Default true."},
                "timeout_s": {"type": "integer", "default": WAIT_DEFAULT_S, "minimum": 1, "maximum": WAIT_MAX_S,
                              "description": f"Max seconds to block when wait=true (max {WAIT_MAX_S})."},
            },
            "required": ["to", "message"],
        },
    },
    "hub_inbox": {
        "name": "hub_inbox",
        "description": ("hermes-omni: recent messages sent to or from this session, with their status and "
                        "replies."),
        "parameters": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": INBOX_LIMIT_MAX,
                          "description": "How many deliveries to return (default 20)."},
            },
            "required": [],
        },
    },
}

_HANDLERS = {"hub_directory": hub_directory, "hub_send": hub_send, "hub_inbox": hub_inbox}


def register(ctx: Any) -> None:
    """Hermes plugin entry point."""
    for name, handler in _HANDLERS.items():
        schema = _SCHEMAS[name]
        ctx.register_tool(name=name, toolset=TOOLSET, schema=schema, handler=handler,
                          check_fn=_configured, emoji=EMOJI, description=schema["description"])
    ctx.register_system_prompt_section("hermes-omni", _prompt_section, position="after_memory")
