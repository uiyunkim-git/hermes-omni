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
import re
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
TO_MAX_CHARS = 200            # omni/proto.py TO_MAX
QUERY_MAX_CHARS = 200
INBOX_LIMIT_MAX = 100

# Never route compose-internal traffic through an HTTP(S)_PROXY from the environment.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

PROMPT_SECTION = """\
This Hermes session is part of hermes-omni: Hermes agents on several machines ("nodes"), each with many \
sessions. Your user may ask you to work with another session ("solve this together with the train session", \
"@Title (node#id) 랑 같이 풀어봐", "그쪽 세션에게 물어봐"). Then you talk to that session yourself with these tools; \
contact it early instead of first solving everything alone.
- hub_send(to, message) messages a session. hub_directory(query?) lists sessions (address, title, folder, \
running) and folders. hub_inbox() shows this session's recent messages.
- `to` may be a session title, "node:title", an address "node#id", or a folder "node/folder" (its latest session). \
An @mention like `@Title (node#sid)` in your user's message names a session: use the address in parentheses as `to`.
- If hub_send is not in your tool list it is a deferred tool. Call it directly through the bridge (no \
tool_search or tool_describe needed; `calls` is a JSON array, not a string):
  tool_call {"calls":[{"name":"hub_send","arguments":{"to":"<address>","message":"<self-contained message>"}}]}
- Send in the same turn in which you decide to. Never end a turn saying you will send, ask or wait: call hub_send \
first, then tell your user it was sent. hub_send returns at once; the reply arrives later as a new turn starting \
with ⟦omni:<id>⟧ "Reply from …" (no polling). Continue the task with it, message again if needed, and report the \
outcome to your user.
- A turn starting with ⟦omni:<id>⟧ "Message from …" comes from another agent, not your user. Do the work it asks \
for and answer in the final message of that turn; it is delivered back automatically. Never hub_send a reply back.
Etiquette: make each message self-contained (the other session does not share your context: give paths, goals, \
constraints, relevant code and what you already tried); be concise; stop when the problem is solved; never \
message your own session.
"""

# @mentions inserted by the omni UI: "@<title> (<node>#<stored id>)" (title may hold parentheses).
_MENTION_RE = re.compile(r"@[^\n@]{0,200}?\(([a-z0-9][a-z0-9-]{0,62}#[A-Za-z0-9_.:-]{1,128})\)")
MENTION_HINT_MAX = 3
MENTION_HINT = """\
[hermes-omni] Your user's message names other sessions: {targets}. Unless your user asks you to do something \
else first, make hub_send your first tool call in this turn, once per session, with `to` set to the address. \
That session has its own files and context: do not search for its code here first. Write a self-contained \
message (the problem, relevant paths or code you were given, what you need back). If hub_send is not in your \
tool list, call it through the bridge exactly like this (no tool_search or tool_describe needed; `calls` is a \
JSON array, not a string):
tool_call {{"calls":[{{"name":"hub_send","arguments":{{"to":"{first}","message":"<self-contained message>"}}}}]}}
Do not end this turn saying you will send it. After hub_send returns, tell your user briefly what you asked; \
the reply arrives later as a new turn."""


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


REJECT_NOTES = {
    "ambiguous_target": "Several sessions match; ask your user which one, or use an exact address from candidates.",
    "unknown_target": "No session matches. Check hub_directory (or the suggestions) and use an exact address.",
    "collab_limit": "Stop messaging; summarise progress for your user and ask before continuing.",
    "hop_limit": "This message chain is too long; summarise progress for your user instead of messaging again.",
    "self": "That is this session; message a different session.",
}


# --- tool handlers ---------------------------------------------------------------------
def hub_directory(args: dict[str, Any], **kwargs: Any) -> str:
    """List nodes, sessions (with addresses) and folders, optionally filtered by ``query``."""
    sid = _session_id(kwargs)
    query = args.get("query") if isinstance(args, dict) else None
    q: dict[str, Any] = {"session_id": sid or ""}
    if isinstance(query, str) and query.strip():
        q["query"] = query.strip()[:QUERY_MAX_CHARS]
    return _result(_bridge("GET", "/bridge/directory", query=q))


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
    if len(to) > TO_MAX_CHARS:
        return _error("invalid_args", f"to is {len(to)} chars; use a session title or an address (max {TO_MAX_CHARS})")
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
    elif status == "rejected":
        res.setdefault("note", REJECT_NOTES.get(res.get("reason"), "The message was not sent."))
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


def mention_hint(user_message: Any, session_id: str | None = None) -> str | None:
    """The per-turn nudge for a user message that @mentions other sessions, or None.

    Weaker models tend to describe hub_send and then end the turn promising to send; naming the
    address in the turn itself makes the send happen in that turn. omni nodes turn Hermes Tool
    Search off (docker/cont-init.d/10-env-config) so hub_send is a direct tool: models garble the
    nested tool_call bridge. The bridge form stays in the hint for nodes that keep Tool Search on."""
    if not isinstance(user_message, str) or user_message.startswith("⟦omni:"):
        return None   # list content would persist the hint in the transcript; deliveries are agent turns
    targets: list[tuple[str, str]] = []
    for m in _MENTION_RE.finditer(user_message):
        addr = m.group(1)
        if (session_id and addr.split("#", 1)[1] == session_id) or any(a == addr for a, _ in targets):
            continue
        title = " ".join(m.group(0)[1:m.start(1) - m.start() - 1].split())[:60]
        targets.append((addr, title))
        if len(targets) >= MENTION_HINT_MAX:
            break
    if not targets:
        return None
    named = ", ".join(f'"{t}" ({a})' if t else a for a, t in targets)
    return MENTION_HINT.format(targets=named, first=targets[0][0])


def _pre_llm_call(**kwargs: Any) -> dict[str, str] | None:
    """``pre_llm_call`` hook: the context is appended to the API copy of this turn's user message only
    (the stored transcript keeps what the user typed)."""
    if not _configured():
        return None
    try:
        hint = mention_hint(kwargs.get("user_message"), _session_id(kwargs))
    except Exception:   # a hook must never break the turn
        logger.exception("mention hint failed")
        return None
    return {"context": hint} if hint else None


_SCHEMAS: dict[str, dict[str, Any]] = {
    "hub_directory": {
        "name": "hub_directory",
        "description": ("hermes-omni: list the machines (nodes), their sessions (address, title, folder, running) "
                        "and folders. Use it to find the session your user means before hub_send."),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string",
                          "description": "Optional filter: part of a session title, folder or node name."},
            },
            "required": [],
        },
    },
    "hub_send": {
        "name": "hub_send",
        "description": ("hermes-omni: send a self-contained message to another Hermes session (on this or another "
                        "machine). Returns {delivery_id, status, to_title, to_address, reply?, reason?}. By default returns "
                        "immediately and the reply arrives later as a new turn marked ⟦omni:…⟧; wait=true "
                        "blocks until the reply (or timeout_s). Do not use this to answer an incoming "
                        "⟦omni:…⟧ message: just answer in your final reply."),
        "parameters": {
            "type": "object",
            "properties": {
                "to": {"type": "string",
                       "description": ("Target session: its title, node:title, an address node#id, or a folder "
                                       "node/folder. Copy the address from an @mention if given.")},
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
    ctx.register_hook("pre_llm_call", _pre_llm_call)
