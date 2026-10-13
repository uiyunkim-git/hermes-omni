"""Link configuration, parsed once from the environment (design §3).

Required: OMNI_NODE_ID, OMNI_HUB_URL, OMNI_JOIN_TOKEN, OMNI_LINK_TOKEN,
HERMES_DASHBOARD_BASIC_AUTH_USERNAME / _PASSWORD.
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field

from omni.proto import NODE_ID_RE


class ConfigError(Exception):
    pass


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _paths(raw: str) -> list[str]:
    out: list[str] = []
    for part in raw.split(","):
        p = part.strip()
        if not p:
            continue
        p = os.path.normpath(p)
        if not os.path.isabs(p):
            raise ConfigError(f"project root must be absolute: {p!r}")
        if p not in out:
            out.append(p)
    return out


@dataclass(frozen=True)
class Config:
    node_id: str
    role: str
    display_name: str
    hostname: str
    hub_url: str
    join_token: str
    socks_proxy: str | None
    link_token: str
    hermes_url: str
    hermes_user: str
    hermes_password: str
    workspace: str
    project_roots: list[str] = field(default_factory=list)
    dashboard_url: str | None = None
    state_dir: str = "/state"
    bridge_host: str = "0.0.0.0"
    bridge_port: int = 8810

    @classmethod
    def from_env(cls) -> "Config":
        node_id = _env("OMNI_NODE_ID").lower()
        if not NODE_ID_RE.match(node_id):
            raise ConfigError(f"OMNI_NODE_ID missing or invalid: {node_id!r}")
        role = _env("OMNI_ROLE", "node")
        if role not in ("hub", "node"):
            raise ConfigError(f"OMNI_ROLE must be hub|node, got {role!r}")
        hub_url = _env("OMNI_HUB_URL").rstrip("/")
        if not hub_url.startswith(("http://", "https://")):
            raise ConfigError("OMNI_HUB_URL must be an http(s) URL")
        missing = [n for n in ("OMNI_JOIN_TOKEN", "OMNI_LINK_TOKEN", "HERMES_DASHBOARD_BASIC_AUTH_USERNAME",
                               "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD") if not _env(n)]
        if missing:
            raise ConfigError("missing env: " + ", ".join(missing))

        socks = _env("OMNI_SOCKS_PROXY") or None
        if socks and socks.startswith("socks5h://"):
            # python-socks rejects socks5h; remote DNS is enabled explicitly (rdns=True) instead.
            socks = "socks5://" + socks[len("socks5h://"):]

        roots = _paths(_env("OMNI_PROJECT_ROOTS"))
        workspace = _env("OMNI_WORKSPACE")
        workspace = os.path.normpath(workspace) if workspace else (roots[0] if roots else "")
        if not workspace or not os.path.isabs(workspace):
            raise ConfigError("OMNI_WORKSPACE (or OMNI_PROJECT_ROOTS) must give an absolute workspace path")
        if workspace not in roots:
            roots.insert(0, workspace)

        try:
            port = int(_env("OMNI_LINK_PORT", "8810"))
        except ValueError as e:
            raise ConfigError("OMNI_LINK_PORT must be an integer") from e

        hostname = _env("OMNI_HOSTNAME") or socket.gethostname()
        return cls(
            node_id=node_id,
            role=role,
            display_name=_env("OMNI_DISPLAY_NAME") or node_id,
            hostname=hostname,
            hub_url=hub_url,
            join_token=_env("OMNI_JOIN_TOKEN"),
            socks_proxy=socks,
            link_token=_env("OMNI_LINK_TOKEN"),
            hermes_url=(_env("OMNI_HERMES_URL") or "http://hermes:9119").rstrip("/"),
            hermes_user=_env("HERMES_DASHBOARD_BASIC_AUTH_USERNAME"),
            hermes_password=os.environ.get("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD", ""),
            workspace=workspace,
            project_roots=roots,
            dashboard_url=_env("OMNI_DASHBOARD_URL") or None,
            state_dir=_env("OMNI_STATE", "/state"),
            bridge_port=port,
        )
