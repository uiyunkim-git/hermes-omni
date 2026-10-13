"""Hub configuration, read once from the environment (design §3).

Env:
  OMNI_HUB_PORT (8800), OMNI_HUB_HOST (0.0.0.0), OMNI_STATE (/state), OMNI_APK_DIR (/apk),
  OMNI_PUBLIC_URL, OMNI_JOIN_TOKEN (else <state>/join_token, generated if missing),
  HERMES_DASHBOARD_BASIC_AUTH_USERNAME / _PASSWORD (admin login),
  OMNI_WEB_DIR (override for the static dir; default: <omni package>/web),
  OMNI_LOG_LEVEL (INFO), OMNI_ACCESS_LOG (0).
"""

from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

import omni

log = logging.getLogger("omni.hub.config")


def _write_private(path: Path, content: str) -> None:
    """Atomically write a mode-600 file."""
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(content)
    os.replace(tmp, path)


def load_or_create_secret(path: Path, nbytes: int = 32) -> str:
    """Read a secret file, creating it with a random value if missing/empty."""
    try:
        value = path.read_text().strip()
        if value:
            return value
    except FileNotFoundError:
        pass
    value = secrets.token_urlsafe(nbytes)
    _write_private(path, value + "\n")
    log.info("generated %s", path)
    return value


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    state_dir: Path
    apk_dir: Path
    web_dir: Path
    public_url: str
    join_token: str
    admin_user: str
    admin_password: str
    access_log: bool

    @property
    def db_path(self) -> Path:
        return self.state_dir / "hub.db"

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Config:
        e = os.environ if env is None else env
        state_dir = Path(e.get("OMNI_STATE") or "/state")
        state_dir.mkdir(parents=True, exist_ok=True)
        join_token = (e.get("OMNI_JOIN_TOKEN") or "").strip()
        if not join_token:
            join_token = load_or_create_secret(state_dir / "join_token", 24)
        web_dir = Path(e.get("OMNI_WEB_DIR") or Path(omni.__file__).parent / "web")
        return cls(
            host=e.get("OMNI_HUB_HOST") or "0.0.0.0",
            port=int(e.get("OMNI_HUB_PORT") or 8800),
            state_dir=state_dir,
            apk_dir=Path(e.get("OMNI_APK_DIR") or "/apk"),
            web_dir=web_dir,
            public_url=(e.get("OMNI_PUBLIC_URL") or "").strip().rstrip("/"),
            join_token=join_token,
            admin_user=(e.get("HERMES_DASHBOARD_BASIC_AUTH_USERNAME") or "").strip(),
            admin_password=e.get("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD") or "",
            access_log=(e.get("OMNI_ACCESS_LOG") or "0").lower() in ("1", "true", "yes", "on"),
        )
