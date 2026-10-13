"""Project discovery on this node (design §5 Project).

Projects = the workspace root itself (name "workspace", is_root) + every root's immediate
non-hidden subdirectories. Duplicate names get "~" + 4 hex of sha1(path).
Git branch is read from .git/HEAD directly (no git binary needed).
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass

from omni.proto import PROJECT_NAME_RE

log = logging.getLogger("omni.link.projects")

WORKSPACE_NAME = "workspace"


@dataclass
class ProjectDir:
    name: str
    path: str
    root: str
    is_root: bool
    is_git: bool
    git_branch: str | None


def _git_dir(path: str) -> str | None:
    dotgit = os.path.join(path, ".git")
    if os.path.isdir(dotgit):
        return dotgit
    if os.path.isfile(dotgit):  # worktree / submodule: "gitdir: <path>"
        try:
            with open(dotgit, encoding="utf-8") as f:
                line = f.readline().strip()
        except OSError:
            return None
        if line.startswith("gitdir:"):
            target = line[len("gitdir:"):].strip()
            return target if os.path.isabs(target) else os.path.normpath(os.path.join(path, target))
    return None


def git_branch(path: str) -> tuple[bool, str | None]:
    """(is_git, branch-or-short-sha)."""
    gd = _git_dir(path)
    if gd is None:
        return False, None
    try:
        with open(os.path.join(gd, "HEAD"), encoding="utf-8") as f:
            head = f.read(256).strip()
    except OSError:
        return True, None
    if head.startswith("ref:"):
        ref = head[4:].strip()
        return True, ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
    return True, head[:8] or None


def _sanitize(name: str) -> str:
    """Folder names that don't fit the address grammar get their bad chars replaced."""
    if PROJECT_NAME_RE.match(name):
        return name
    cleaned = "".join(c if PROJECT_NAME_RE.match(c) else "_" for c in name)
    return cleaned or "_"


def _suffix(path: str) -> str:
    return "~" + hashlib.sha1(path.encode("utf-8")).hexdigest()[:4]


def scan(workspace: str, roots: list[str]) -> list[ProjectDir]:
    """Scan roots; stable order: workspace first, then roots in order, subdirs sorted."""
    entries: list[tuple[str, str, str, bool]] = []   # (raw name, path, root, is_root)
    if os.path.isdir(workspace):
        entries.append((WORKSPACE_NAME, workspace, workspace, True))
    else:
        log.warning("workspace %s does not exist", workspace)
    seen_paths = {workspace}
    for root in roots:
        try:
            with os.scandir(root) as it:
                subdirs = sorted((e for e in it if not e.name.startswith(".") and e.is_dir(follow_symlinks=True)),
                                 key=lambda e: e.name)
        except OSError as e:
            log.warning("cannot scan root %s: %s", root, e)
            continue
        for d in subdirs:
            path = os.path.join(root, d.name)
            if path in seen_paths:
                continue
            seen_paths.add(path)
            entries.append((d.name, path, root, False))

    out: list[ProjectDir] = []
    used: set[str] = set()
    for raw, path, root, is_root in entries:
        name = _sanitize(raw)
        if name in used:
            name = name + _suffix(path)
        used.add(name)
        is_git, branch = git_branch(path)
        out.append(ProjectDir(name=name, path=path, root=root, is_root=is_root, is_git=is_git, git_branch=branch))
    return out


def project_for_path(projects: list[ProjectDir], path: str | None) -> ProjectDir | None:
    if not path:
        return None
    p = os.path.normpath(path)
    for proj in projects:
        if proj.path == p:
            return proj
    return None
