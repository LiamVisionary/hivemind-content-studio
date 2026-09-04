"""Read-only readiness report for the unified studio."""

from __future__ import annotations

import importlib.util
import shutil
import sys
import time
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from pathlib import Path
from threading import Lock

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


# ── the report the app reads ────────────────────────────────────────────────
#
# `collect_checks()` above is the CLI's answer and stays exactly that. The app
# needs three more things in the same breath — what the engines are doing, what
# this machine is, and how many weights are on the disk — and it needs them
# while a page is painting, which the CLI never had to care about.
#
# So this report is built to a DEADLINE rather than to completion. Each section
# is memoised with its own lifetime and, when a slow section overruns the
# budget, the last good answer for it is served marked `stale` instead of
# holding the whole page. A section nobody has ever computed comes back
# `pending`, which the UI renders as "still checking" — never as a fault.

_SECTION_TTLS = {"checks": 30.0, "runtime": 10.0, "hardware": 300.0, "models": 60.0}
_report_cache: dict[str, dict] = {}
# One pool for the life of the process, never a `with` block: a `with` waits for
# every worker on the way out, which would hand a hung probe exactly the power
# over the response time that the deadline exists to take away.
_pool = ThreadPoolExecutor(max_workers=len(_SECTION_TTLS), thread_name_prefix="doctor")
_inflight: dict[str, Future] = {}
_inflight_lock = Lock()


def forget_doctor_cache() -> None:
    """Drop every memoised section. Tests and a settings change both need it."""
    from .hardware import forget_hardware_cache

    _report_cache.clear()
    with _inflight_lock:
        _inflight.clear()
    forget_hardware_cache()


def _section_builders() -> dict:
    from .hardware import hardware_profile, model_inventory
    from .unified_runtime import unified_runtime_snapshot

    return {
        "checks": collect_checks,
        "runtime": unified_runtime_snapshot,
        "hardware": hardware_profile,
        "models": model_inventory,
    }


def _fresh(name: str) -> dict | None:
    entry = _report_cache.get(name)
    if entry is None:
        return None
    return entry if time.monotonic() - entry["at"] <= _SECTION_TTLS[name] else None


def _stale(name: str) -> dict:
    entry = _report_cache.get(name)
    if entry is None or not isinstance(entry["value"], dict):
        return {"pending": True}
    return {**entry["value"], "stale": True}


def _start(name: str, build) -> Future:
    """The running probe for this section, started if nobody started it.

    Sharing one future matters: without it, a page load arriving while a slow
    probe is still out would start a second copy of the same subprocess.
    """
    with _inflight_lock:
        running = _inflight.get(name)
        if running is not None and not running.done():
            return running
        future = _pool.submit(build)
        _inflight[name] = future

    def remember(done: Future) -> None:
        with _inflight_lock:
            if _inflight.get(name) is done:
                _inflight.pop(name, None)
        try:
            value = done.result()
        except Exception:  # noqa: BLE001 — a failed probe simply has nothing to cache
            return
        _report_cache[name] = {"value": value, "at": time.monotonic()}

    future.add_done_callback(remember)
    return future


def collect_report(*, deadline_seconds: float = 2.0) -> dict:
    """Everything the Models page needs to answer "will this run here?"."""
    sections: dict[str, dict] = {}
    running: dict[str, Future] = {}
    for name, build in _section_builders().items():
        cached = _fresh(name)
        if cached is not None:
            sections[name] = cached["value"]
        else:
            running[name] = _start(name, build)

    deadline = time.monotonic() + max(0.1, deadline_seconds)
    for name, future in running.items():
        remaining = max(0.0, deadline - time.monotonic())
        try:
            sections[name] = future.result(timeout=remaining)
        except FuturesTimeout:
            # The work keeps running and lands in the cache for the next ask;
            # this answer is the previous one, honestly labelled.
            sections[name] = _stale(name)
        except Exception as exc:  # noqa: BLE001 — one broken probe is not a broken page
            sections[name] = {"error": str(exc)[:200]}

    checks = sections.get("checks") or {}
    return {
        "ok": bool(checks.get("ok")),
        "checks": checks.get("checks", {}),
        "providers": checks.get("providers", []),
        "live_publish_enabled": bool(checks.get("live_publish_enabled")),
        "runtime": sections.get("runtime", {}),
        "hardware": sections.get("hardware", {}),
        "models": sections.get("models", {}),
    }
