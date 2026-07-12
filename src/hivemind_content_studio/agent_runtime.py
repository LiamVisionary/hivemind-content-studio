"""Vendor-neutral script generation and attachment contract."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Sequence

from .manifest import add_artifact, load_manifest, utc_now, write_manifest
from .runtime_registry import RuntimeRegistry


AGENT_GENERATION_CONFIRMATION = "AGENT_GENERATE"


def _script_request(manifest_path: str | Path) -> Path:
    manifest = load_manifest(manifest_path)
    matches = [Path(item["path"]) for item in manifest["artifacts"] if item["role"] == "script-request"]
    if not matches:
        raise ValueError("Run has no script-request artifact")
    return matches[-1]


def run_agent_script(
    manifest_path: str | Path,
    *,
    command: Sequence[str] | None = None,
    confirm: str = "",
    timeout_seconds: int = 600,
    runtime: str = "command",
) -> dict[str, str]:
    if confirm != AGENT_GENERATION_CONFIRMATION:
        raise ValueError(f"Agent generation requires confirm={AGENT_GENERATION_CONFIRMATION}")
    selected = list(command or shlex.split(os.environ.get("CONTENT_STUDIO_AGENT_COMMAND", "")))
    if not selected:
        raise ValueError("Set CONTENT_STUDIO_AGENT_COMMAND or pass an explicit agent command")
    request = _script_request(manifest_path)
    completed = subprocess.run(
        selected,
        input=request.read_text(encoding="utf-8"),
        text=True,
        capture_output=True,
        timeout=timeout_seconds,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"Agent runtime failed with exit code {completed.returncode}")
    if not completed.stdout.strip():
        raise RuntimeError("Agent runtime returned an empty script")
    generated = Path(manifest_path).expanduser().resolve().parent / "agent-script.md"
    generated.write_text(completed.stdout.rstrip() + "\n", encoding="utf-8")
    return attach_script(manifest_path, generated, runtime=runtime, copy=False)


def run_registered_agent_script(
    manifest_path: str | Path,
    *,
    runtime_id: str,
    confirm: str,
    registry: RuntimeRegistry | None = None,
    timeout_seconds: int = 600,
) -> dict[str, str]:
    selected = (registry or RuntimeRegistry.from_environment()).get(runtime_id)
    return run_agent_script(
        manifest_path,
        command=selected.command,
        confirm=confirm,
        timeout_seconds=timeout_seconds,
        runtime=selected.id,
    )


def attach_script(
    manifest_path: str | Path,
    script_path: str | Path,
    *,
    runtime: str = "external-agent",
    copy: bool = True,
) -> dict[str, str]:
    manifest_file = Path(manifest_path).expanduser().resolve()
    source = Path(script_path).expanduser().resolve()
    if not source.is_file() or not source.read_text(encoding="utf-8").strip():
        raise ValueError("Script must be a non-empty UTF-8 text file")
    destination = manifest_file.parent / "script.md"
    if copy or source != destination:
        shutil.copyfile(source, destination)
    receipt = {
        "runtime": runtime.strip() or "external-agent",
        "attached_at": utc_now(),
        "source": str(source),
        "script": str(destination),
    }
    receipt_path = manifest_file.parent / "script-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    manifest = load_manifest(manifest_file)
    manifest["artifacts"] = [item for item in manifest["artifacts"] if item["role"] not in {"script", "script-receipt"}]
    add_artifact(manifest, role="script", path=destination, provider="agent-runtime")
    add_artifact(manifest, role="script-receipt", path=receipt_path, provider="agent-runtime")
    write_manifest(manifest_file, manifest)
    return {"script_path": str(destination), "receipt_path": str(receipt_path), "runtime": receipt["runtime"]}
