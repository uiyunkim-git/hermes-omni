"""Optional GPU stats via nvidia-smi (absent binary or failure → empty list)."""

from __future__ import annotations

import asyncio
import logging
import shutil
from typing import Any

log = logging.getLogger("omni.link.gpu")

_QUERY = "index,name,utilization.gpu,memory.used,memory.total"
_missing_logged = False


def _num(s: str) -> int | None:
    try:
        return int(float(s))
    except ValueError:
        return None


async def gpu_stats(timeout: float = 5.0) -> list[dict[str, Any]]:
    global _missing_logged
    exe = shutil.which("nvidia-smi")
    if exe is None:
        if not _missing_logged:
            log.info("nvidia-smi not found; reporting no GPUs")
            _missing_logged = True
        return []
    try:
        proc = await asyncio.create_subprocess_exec(
            exe, f"--query-gpu={_QUERY}", "--format=csv,noheader,nounits",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            log.warning("nvidia-smi timed out")
            return []
    except OSError as e:
        log.warning("nvidia-smi failed: %s", e)
        return []
    gpus = []
    for line in out.decode("utf-8", "replace").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 5:
            continue
        gpus.append({"index": _num(parts[0]), "name": parts[1], "util_pct": _num(parts[2]),
                     "mem_used_mb": _num(parts[3]), "mem_total_mb": _num(parts[4])})
    return gpus
