"""Files under the node's project roots, for the hub's file browser and attachments (v3 spec §5.2).

Every path is resolved with ``os.path.realpath`` (symlinks followed) and must be a project root or lie
under one; secrets (``.env*``, ``*.pem``, ``*.key``, ``id_rsa*``, ``.git/`` contents) are neither
listed nor served. The link writes directly to disk: the roots are mounted in the link container at
the same absolute paths as on the host and in Hermes.

Large transfers are chunked through the hub: a *blob* is a file (or a session export) opened for
reading in 256 KiB pieces; an *upload* is written piecewise into a temp file and moved into place
on commit. Both expire after BLOB_IDLE_S without use.
"""

from __future__ import annotations

import base64
import fnmatch
import logging
import mimetypes
import os
import secrets
import stat
import time
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("omni.link.files")

LIST_MAX = 2000
READ_TEXT_MAX = 512 * 1024
CHUNK_MAX = 256 * 1024
DOWNLOAD_MAX = 200 * 1024 * 1024
UPLOAD_MAX = 50 * 1024 * 1024
ATTACH_MAX = 20 * 1024 * 1024
BLOB_IDLE_S = 120.0
SENSITIVE_PATTERNS = (".env*", "*.pem", "*.key", "id_rsa*")
NAME_FORBIDDEN = ("/", "\\", "\x00")


class FileOpError(Exception):
    def __init__(self, code: str, message: str, **extra: Any):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.extra = extra


def is_sensitive_name(name: str) -> bool:
    return any(fnmatch.fnmatchcase(name, p) for p in SENSITIVE_PATTERNS)


def is_sensitive_path(path: str) -> bool:
    parts = [p for p in path.split("/") if p]
    if any(p == ".git" for p in parts[:-1]):
        return True   # inside .git/ (the .git entry itself may be listed but not opened)
    return bool(parts) and is_sensitive_name(parts[-1])


@dataclass
class _Transfer:
    id: str
    kind: str                     # "blob" | "upload"
    path: str                     # blob source / upload temp file
    size: int
    name: str
    mime: str
    final: str | None = None      # upload destination (files) or None (attach)
    stored_id: str | None = None  # attach target
    received: int = 0
    delete_after: bool = False    # blob backed by a temp file (export)
    touched: float = field(default_factory=time.monotonic)


class Files:
    def __init__(self, roots: list[str], tmp_dir: str):
        self.roots = [os.path.realpath(r) for r in roots]
        self.tmp_dir = tmp_dir
        self._open: dict[str, _Transfer] = {}

    # --- paths ---------------------------------------------------------------------------
    def resolve(self, path: Any, *, must_exist: bool = True) -> tuple[str, str]:
        """(realpath, root) or FileOpError(outside_roots|not_found|bad_request)."""
        if not isinstance(path, str) or not path.startswith("/") or "\x00" in path:
            raise FileOpError("bad_request", "path must be absolute")
        real = os.path.realpath(path)
        root = self.root_of(real)
        if root is None:
            raise FileOpError("outside_roots", "path is outside the node's project roots")
        if must_exist and not os.path.exists(real):
            raise FileOpError("not_found", f"{path} does not exist")
        return real, root

    def root_of(self, real: str) -> str | None:
        best = None
        for r in self.roots:
            if real == r or real.startswith(r.rstrip("/") + "/"):
                if best is None or len(r) > len(best):
                    best = r
        return best

    def _check_sensitive(self, real: str, root: str) -> None:
        rel = real[len(root):]
        if is_sensitive_path(rel) or (real != root and os.path.basename(real) == ".git"):
            raise FileOpError("sensitive", "this file is not available through the hub")

    # --- listing / reading ---------------------------------------------------------------
    def list(self, path: Any) -> dict[str, Any]:
        real, root = self.resolve(path)
        self._check_sensitive(real, root)
        if not os.path.isdir(real):
            raise FileOpError("not_a_directory", f"{path} is not a directory")
        entries = []
        truncated = False
        try:
            with os.scandir(real) as it:
                for e in it:
                    if is_sensitive_name(e.name) or e.name.endswith(".omni-upload"):
                        continue
                    try:
                        st = e.stat(follow_symlinks=True)
                    except OSError:
                        continue   # dangling symlink etc.
                    is_dir = stat.S_ISDIR(st.st_mode)
                    if e.is_symlink() and self.root_of(os.path.realpath(e.path)) is None:
                        continue   # a symlink leading out of the roots is neither browsable nor readable
                    if len(entries) >= LIST_MAX:
                        truncated = True
                        break
                    entries.append({"name": e.name, "path": os.path.join(real, e.name), "dir": is_dir,
                                    "size": None if is_dir else st.st_size, "mtime": st.st_mtime})
        except PermissionError as e:
            raise FileOpError("forbidden", f"cannot read {path}: {e.strerror}") from e
        entries.sort(key=lambda x: (not x["dir"], x["name"].lower()))
        out: dict[str, Any] = {"path": real, "root": root, "parent": None if real == root else os.path.dirname(real),
                               "writable": os.access(real, os.W_OK), "entries": entries}
        if truncated:
            out["truncated"] = True
        return out

    def read_text(self, path: Any, max_bytes: Any = READ_TEXT_MAX) -> dict[str, Any]:
        real, root = self.resolve(path)
        self._check_sensitive(real, root)
        if not os.path.isfile(real):
            raise FileOpError("not_a_file", f"{path} is not a file")
        try:
            limit = max(1, min(int(max_bytes or READ_TEXT_MAX), READ_TEXT_MAX))
        except (TypeError, ValueError):
            limit = READ_TEXT_MAX
        st = os.stat(real)
        try:
            with open(real, "rb") as f:
                data = f.read(limit)
        except PermissionError as e:
            raise FileOpError("forbidden", f"cannot read {path}: {e.strerror}") from e
        truncated = st.st_size > len(data)
        text: str | None = None
        binary = b"\x00" in data[:8192]
        if not binary:
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError as e:
                if truncated and e.start >= len(data) - 3:
                    text = data[: e.start].decode("utf-8", errors="replace")
                else:
                    binary = True
        return {"text": None if binary else text, "binary": binary, "truncated": truncated,
                "size": st.st_size, "mtime": st.st_mtime}

    # --- blobs ---------------------------------------------------------------------------
    def open_file_blob(self, path: Any) -> dict[str, Any]:
        real, root = self.resolve(path)
        self._check_sensitive(real, root)
        if not os.path.isfile(real):
            raise FileOpError("not_a_file", f"{path} is not a file")
        size = os.path.getsize(real)
        if size > DOWNLOAD_MAX:
            raise FileOpError("too_large", f"file is larger than {DOWNLOAD_MAX // (1024 * 1024)} MB")
        name = os.path.basename(real)
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        return self._new("blob", real, size, name, mime)

    def open_temp_blob(self, data: bytes, name: str, mime: str) -> dict[str, Any]:
        os.makedirs(self.tmp_dir, exist_ok=True)
        tid = secrets.token_hex(12)
        tmp = os.path.join(self.tmp_dir, f"{tid}.blob")
        with open(tmp, "wb") as f:
            f.write(data)
        info = self._new("blob", tmp, len(data), name, mime, tid=tid)
        self._open[tid].delete_after = True
        return info

    def read_blob(self, blob_id: Any, offset: Any, length: Any) -> dict[str, Any]:
        t = self._get(blob_id, "blob")
        try:
            off, n = int(offset), max(1, min(int(length), CHUNK_MAX))
        except (TypeError, ValueError) as e:
            raise FileOpError("bad_request", "offset/length must be integers") from e
        if off < 0:
            raise FileOpError("bad_request", "negative offset")
        with open(t.path, "rb") as f:
            f.seek(off)
            data = f.read(n)
        return {"data_b64": base64.b64encode(data).decode("ascii"), "eof": off + len(data) >= t.size}

    def close(self, tid: Any) -> None:
        t = self._open.pop(tid, None) if isinstance(tid, str) else None
        if t is not None:
            self._discard(t)

    # --- uploads -------------------------------------------------------------------------
    def open_upload(self, directory: Any, name: Any, size: Any, overwrite: bool) -> dict[str, Any]:
        real, root = self.resolve(directory)
        self._check_sensitive(real, root)
        if not os.path.isdir(real):
            raise FileOpError("not_a_directory", f"{directory} is not a directory")
        name = self._clean_name(name)
        if is_sensitive_name(name):
            raise FileOpError("sensitive", "this file name is not allowed")
        n = self._size(size, UPLOAD_MAX)
        final = os.path.join(real, name)
        if os.path.lexists(final):
            if not overwrite:
                raise FileOpError("exists", f"{name} already exists", names=[name])
            if os.path.isdir(final) or os.path.islink(final):
                raise FileOpError("exists", f"{name} is a directory or a link", names=[name])
        if not os.access(real, os.W_OK):
            raise FileOpError("forbidden", f"{directory} is not writable")
        tid = secrets.token_hex(12)
        tmp = os.path.join(real, f".{name}.{tid[:8]}.omni-upload")
        with open(tmp, "wb"):
            pass
        self._new("upload", tmp, n, name, mimetypes.guess_type(name)[0] or "application/octet-stream",
                         tid=tid)
        self._open[tid].final = final
        return {"upload_id": tid}

    def open_attach(self, stored_id: str, name: Any, size: Any, mime: Any) -> dict[str, Any]:
        name = self._clean_name(name)
        n = self._size(size, ATTACH_MAX)
        os.makedirs(self.tmp_dir, exist_ok=True)
        tid = secrets.token_hex(12)
        tmp = os.path.join(self.tmp_dir, f"{tid}.attach")
        with open(tmp, "wb"):
            pass
        m = mime if isinstance(mime, str) and "/" in mime else (mimetypes.guess_type(name)[0]
                                                                  or "application/octet-stream")
        self._new("upload", tmp, n, name, m, tid=tid)
        self._open[tid].stored_id = stored_id
        return {"upload_id": tid}

    def write(self, upload_id: Any, offset: Any, data_b64: Any) -> dict[str, Any]:
        t = self._get(upload_id, "upload")
        try:
            data = base64.b64decode(data_b64 if isinstance(data_b64, str) else "", validate=True)
            off = int(offset)
        except (ValueError, TypeError) as e:
            raise FileOpError("bad_request", "bad chunk") from e
        if off != t.received:
            raise FileOpError("bad_request", f"expected offset {t.received}, got {off}")
        if t.received + len(data) > t.size:
            raise FileOpError("too_large", "more data than announced")
        with open(t.path, "ab") as f:
            f.write(data)
        t.received += len(data)
        return {"received": t.received}

    def commit_file(self, upload_id: Any) -> dict[str, Any]:
        t = self._get(upload_id, "upload")
        if t.final is None:
            raise FileOpError("bad_request", "not a file upload")
        self._complete(t)
        os.replace(t.path, t.final)
        self._open.pop(t.id, None)
        log.info("uploaded %s (%d bytes)", t.final, t.size)
        return {"path": t.final, "size": t.size}

    def take_attach(self, upload_id: Any) -> tuple[_Transfer, bytes]:
        """Finish an attach upload: (transfer, bytes); the temp file is removed."""
        t = self._get(upload_id, "upload")
        if t.stored_id is None:
            raise FileOpError("bad_request", "not an attachment upload")
        self._complete(t)
        with open(t.path, "rb") as f:
            data = f.read()
        self._open.pop(t.id, None)
        self._discard(t)
        return t, data

    # --- housekeeping --------------------------------------------------------------------
    def expire(self) -> None:
        now = time.monotonic()
        for tid, t in list(self._open.items()):
            if now - t.touched > BLOB_IDLE_S:
                log.info("%s %s expired", t.kind, tid)
                self._open.pop(tid, None)
                self._discard(t)

    def close_all(self) -> None:
        for t in list(self._open.values()):
            self._discard(t)
        self._open.clear()

    def sweep_tmp(self) -> None:
        """Remove leftovers of a previous process in the state tmp dir."""
        try:
            for name in os.listdir(self.tmp_dir):
                if name.endswith((".blob", ".attach")):
                    os.unlink(os.path.join(self.tmp_dir, name))
        except OSError:
            pass

    # --- internals -----------------------------------------------------------------------
    def _new(self, kind: str, path: str, size: int, name: str, mime: str, tid: str | None = None) -> dict[str, Any]:
        tid = tid or secrets.token_hex(12)
        self._open[tid] = _Transfer(tid, kind, path, size, name, mime)
        return {"blob_id": tid, "size": size, "mime": mime, "name": name}

    def _get(self, tid: Any, kind: str) -> _Transfer:
        t = self._open.get(tid) if isinstance(tid, str) else None
        if t is None or t.kind != kind:
            raise FileOpError("not_found", f"unknown or expired {kind}")
        t.touched = time.monotonic()
        return t

    def _complete(self, t: _Transfer) -> None:
        if t.received != t.size:
            raise FileOpError("bad_request", f"incomplete upload ({t.received}/{t.size} bytes)")

    def _discard(self, t: _Transfer) -> None:
        if t.kind == "upload" or t.delete_after:
            try:
                os.unlink(t.path)
            except OSError:
                pass

    @staticmethod
    def _clean_name(name: Any) -> str:
        if not isinstance(name, str):
            raise FileOpError("bad_request", "name required")
        name = name.strip()
        if not name or name in (".", "..") or any(c in name for c in NAME_FORBIDDEN) or len(name) > 255:
            raise FileOpError("bad_request", "invalid file name")
        return name

    @staticmethod
    def _size(size: Any, cap: int) -> int:
        try:
            n = int(size)
        except (TypeError, ValueError) as e:
            raise FileOpError("bad_request", "size must be an integer") from e
        if n < 0:
            raise FileOpError("bad_request", "negative size")
        if n > cap:
            raise FileOpError("too_large", f"file is larger than {cap // (1024 * 1024)} MB")
        return n
