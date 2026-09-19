"""Environment checks with secret-safe output."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from .config import Config
from .llm import mode as llm_mode
from .podcli import is_podcli_available
from .prompts import PROMPT_NAMES, available_categories


def collect_checks(cfg: Config) -> dict[str, Any]:
    checks = {
        "python": _python_current(),
        "node": _command("node", ["node", "--version"]),
        "npm": _command("npm", ["npm", "--version"]),
        "ffmpeg": _command("ffmpeg", ["ffmpeg", "-version"]),
        "ffprobe": _command("ffprobe", ["ffprobe", "-version"]),
        "docker": _command("docker", ["docker", "--version"]),
        "yt-dlp": _yt_dlp_check(),
        "podcli": _podcli_check(cfg),
        "postiz": {
            "ok": bool(cfg.postiz_url),
            "url": cfg.postiz_url,
            "api_key": "set" if cfg.postiz_api_key else "missing",
            "write_enabled": cfg.postiz_enable_write,
        },
        "prompts": _prompts_check(cfg),
        "llm": _llm_check(),
        "obsidian": {
            "ok": cfg.vault_path.exists(),
            "vault_path": str(cfg.vault_path),
            "folder": cfg.obsidian_folder,
        },
        "data_dir": {
            "ok": cfg.data_dir.exists() or cfg.data_dir.parent.exists(),
            "path": str(cfg.data_dir),
        },
    }
    checks["overall_ok"] = all(
        value.get("ok", False)
        for key, value in checks.items()
        if key in {"python", "node", "ffmpeg", "ffprobe", "docker", "yt-dlp", "podcli", "obsidian", "prompts"}
    )
    return checks


def format_checks(checks: dict[str, Any]) -> str:
    lines = ["Auto Clipper doctor", ""]
    for key, value in checks.items():
        if key == "overall_ok":
            continue
        status = "ok" if value.get("ok") else "missing"
        detail = value.get("version") or value.get("detail") or value.get("path") or ""
        lines.append(f"- {key}: {status} {detail}".rstrip())
    lines.append("")
    lines.append(f"overall_ok: {checks['overall_ok']}")
    return "\n".join(lines)


def checks_json(checks: dict[str, Any]) -> str:
    return json.dumps(checks, indent=2, sort_keys=True)


AI_CLI_GATE = "PODCLI_ALLOW_AI_CLI"


def _podcli_check(cfg: Config) -> dict[str, Any]:
    """Presence, plus proof that the transcript-egress gate survived the install.

    Stock Podcli pipes the whole transcript into `claude`/`codex` whenever one
    is on PATH. `patches/podcli-ai-select-default-off.patch` makes that opt-in.
    An install that skipped the patch — or an upgrade that dropped it — is a
    silent egress path, so it is checked every time rather than assumed.
    """
    available = is_podcli_available(cfg)
    check: dict[str, Any] = {"ok": available, "path": _redact_path(cfg.podcli_bin)}
    if not available:
        check["detail"] = "missing; run scripts/install_podcli.sh"
        return check

    gate_file = Path(cfg.podcli_bin).expanduser().parent / "backend" / "services" / "claude_suggest.py"
    try:
        gated = AI_CLI_GATE in gate_file.read_text(encoding="utf-8")
    except OSError:
        check["ok"] = False
        check["detail"] = f"found, but {gate_file.name} is unreadable — cannot confirm the AI-CLI gate"
        return check

    check["ai_cli_gate"] = gated
    if not gated:
        check["ok"] = False
        check["detail"] = (
            "UNGATED: this install sends transcripts to claude/codex by default. "
            "Apply patches/podcli-ai-select-default-off.patch."
        )
    else:
        check["detail"] = "found; transcript egress gated (opt in with --ai-select)"
    return check


def _prompts_check(cfg: Config) -> dict[str, Any]:
    missing = [name for name in PROMPT_NAMES if not (cfg.prompts_dir / name).is_file()]
    return {
        "ok": not missing,
        "path": str(cfg.prompts_dir),
        "detail": (
            f"missing {', '.join(missing)}"
            if missing
            else f"categories: {', '.join(available_categories(cfg)) or 'none'}"
        ),
    }


def _llm_check() -> dict[str, Any]:
    """Report which semantic path is reachable, without spending a call.

    Not part of overall_ok: the semantic layer is an enrichment, and a box with
    no model still renders, approves, and schedules exactly as it did before.
    """
    selected = llm_mode()
    if selected == "off":
        return {"ok": True, "detail": "AUTO_CLIPPER_LLM=off; clips render without scores or hooks"}
    loaded: list[str] = []
    try:
        from hivemind_content_studio import local_llm

        loaded = [
            str(entry.get("modelId"))
            for entry in (local_llm.runtime().snapshot().get("loaded") or [])
        ]
    except Exception as exc:
        loaded = []
        local_detail = f"local unavailable ({exc.__class__.__name__})"
    else:
        local_detail = f"local loaded: {', '.join(loaded)}" if loaded else "no local model loaded"
    cloud = importlib.util.find_spec("app.services.llm") is not None
    return {
        "ok": bool(loaded) or (cloud and selected in {"auto", "cloud"}),
        "mode": selected,
        "detail": f"{local_detail}; cloud fallback {'importable' if cloud else 'missing'}",
    }


def _command(name: str, args: list[str]) -> dict[str, Any]:
    path = shutil.which(name)
    if path is None:
        return {"ok": False, "path": None}
    try:
        result = subprocess.run(args, text=True, capture_output=True, timeout=10, check=False)
        first = (result.stdout or result.stderr).splitlines()[0] if (result.stdout or result.stderr) else ""
    except Exception as exc:
        return {"ok": False, "path": path, "detail": str(exc)}
    return {"ok": result.returncode == 0, "path": path, "version": first}


def _python_current() -> dict[str, Any]:
    return {"ok": sys.version_info >= (3, 11), "path": sys.executable, "version": sys.version.split()[0]}


def _yt_dlp_check() -> dict[str, Any]:
    path = shutil.which("yt-dlp")
    if path:
        return _command("yt-dlp", ["yt-dlp", "--version"])
    venv_candidate = Path(sys.executable).parent / "yt-dlp"
    if venv_candidate.exists():
        result = subprocess.run([str(venv_candidate), "--version"], text=True, capture_output=True, timeout=10, check=False)
        first = (result.stdout or result.stderr).splitlines()[0] if (result.stdout or result.stderr) else ""
        return {"ok": result.returncode == 0, "path": str(venv_candidate), "version": first}
    spec = importlib.util.find_spec("yt_dlp")
    return {
        "ok": spec is not None,
        "path": "python-module" if spec is not None else None,
        "version": "importable module" if spec is not None else "",
    }


def _redact_path(value: str) -> str:
    try:
        return str(Path(value).expanduser())
    except Exception:
        return value
