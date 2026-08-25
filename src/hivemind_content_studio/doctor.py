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
        "hive_env": _hive_env_check(),
    }
    return {
        "ok": all(checks[name]["ok"] for name in ("python", "ffmpeg", "ffprobe", "yaml", "shared_skills", "hive_env")),
        "checks": checks,
        "providers": provider_report(cfg),
        "live_publish_enabled": cfg.live_publish_enabled,
    }


def _skill_check(root: Path) -> dict:
    skills = sorted(path.parent.name for path in root.glob("*/SKILL.md")) if root.is_dir() else []
    return {"ok": len(skills) >= 10, "count": len(skills), "skills": skills}



def _hive_env_check() -> dict:
    """The shared credential store, and whether packaging can reach it.

    This is the check that turns a silent class of failure into a loud one. A
    sandboxed build resolves `~` to its own container, so the store is simply
    not there and every provider reports "key not set" — which reads as a
    credential problem and is a packaging one. Say so here instead.
    """
    from .shared_env import hive_env_status

    state = hive_env_status()
    if state["home_is_container"]:
        return {
            "ok": False,
            "reachable": False,
            "detail": state["detail"],
            "remedy": (
                "Ship this build without the App Sandbox, or launch it with HIVE_HOME "
                "pointing at the real store (for example ~/.hivemindos)."
            ),
        }
    from .shared_env import machine_links, sealing_status

    optional = sealing_status()
    return {
        # A machine with no store yet is not broken — the first app to need one
        # creates it. Only an unreachable store is a failure.
        "ok": True,
        "reachable": True,
        "exists": state["exists"],
        "path": state["path"],
        "writes_to": state["writes_to"],
        "workspace": state["workspace"] or "main",
        "keys": len(state["keys"]),
        "apps": state["apps"],
        # Sealing and linking are optional, so their absence is reported and not
        # failed. Reporting it is still the point: without it the first sign is
        # a command refusing at the moment someone needs it.
        "sealing_and_linking": bool(optional.get("supported") and machine_links().get("available")),
        "detail": state["detail"],
        "remedy": (
            ""
            if optional.get("supported")
            else "Run `passbook install` to provision the runtime that sealing and linking need."
        ),
    }
