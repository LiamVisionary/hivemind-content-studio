"""Read-only readiness report for the unified studio."""

from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

from .config import load_config
from .providers import provider_report


def collect_checks() -> dict:
    cfg = load_config()
    checks = {
        "python": {"ok": sys.version_info[:2] >= (3, 11), "version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"},
        "ffmpeg": {"ok": shutil.which("ffmpeg") is not None, "path": shutil.which("ffmpeg")},
        "ffprobe": {"ok": shutil.which("ffprobe") is not None, "path": shutil.which("ffprobe")},
        "yaml": {"ok": importlib.util.find_spec("yaml") is not None},
        "shared_skills": _skill_check(cfg.project_root / "skills" / "shared"),
    }
    return {
        "ok": all(checks[name]["ok"] for name in ("python", "ffmpeg", "ffprobe", "yaml", "shared_skills")),
        "checks": checks,
        "providers": provider_report(cfg),
        "live_publish_enabled": cfg.live_publish_enabled,
    }


def _skill_check(root: Path) -> dict:
    skills = sorted(path.parent.name for path in root.glob("*/SKILL.md")) if root.is_dir() else []
    return {"ok": len(skills) >= 10, "count": len(skills), "skills": skills}

