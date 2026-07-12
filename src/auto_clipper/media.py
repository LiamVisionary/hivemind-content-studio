"""Local media helpers adapted from Podcli's ffprobe utility style."""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

FFPROBE_TIMEOUT = 60


def run_capture(args: list[str], timeout: int = FFPROBE_TIMEOUT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=False)


def ffprobe_json(path: str | Path) -> dict:
    if shutil.which("ffprobe") is None:
        raise RuntimeError("ffprobe is not installed")
    result = run_capture(
        [
            "ffprobe",
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ]
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr.strip()}")
    return json.loads(result.stdout)


def parse_duration_seconds(value: object) -> float | None:
    try:
        parsed = float(str(value).strip())
    except Exception:
        return None
    if not math.isfinite(parsed) or parsed <= 0:
        return None
    return parsed


def duration_seconds(path: str | Path) -> float | None:
    try:
        info = ffprobe_json(path)
    except Exception:
        return None
    candidates: list[float] = []
    fmt = parse_duration_seconds(info.get("format", {}).get("duration"))
    if fmt is not None:
        candidates.append(fmt)
    for stream in info.get("streams", []):
        stream_duration = parse_duration_seconds(stream.get("duration"))
        if stream_duration is not None:
            candidates.append(stream_duration)
    return max(candidates) if candidates else None


def dimensions(path: str | Path) -> tuple[int, int] | None:
    try:
        info = ffprobe_json(path)
    except Exception:
        return None
    for stream in info.get("streams", []):
        if stream.get("codec_type") == "video":
            return int(stream["width"]), int(stream["height"])
    return None

