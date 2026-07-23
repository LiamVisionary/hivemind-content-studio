from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from hivemind_content_studio.agent_runtime import attach_script, run_agent_script
from hivemind_content_studio.manifest import load_manifest
from hivemind_content_studio.planner import plan
from hivemind_content_studio.private_access import ENCRYPTED_PREFIX, read_private_json, read_private_text


def _planned_run(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text(
        """id: general-agent
lane: first-frame-animation-ad
title: General runtime
scenes:
  - title: Hook
    beat: Show that any agent can author this script.
""",
        encoding="utf-8",
    )
    return plan(brief)


def test_agent_script_execution_requires_an_explicit_generation_gate(tmp_path: Path, monkeypatch) -> None:
    manifest = _planned_run(tmp_path, monkeypatch)

    with pytest.raises(ValueError, match="AGENT_GENERATE"):
        run_agent_script(manifest, command=[sys.executable, "-c", "print('script')"], confirm="")


def test_any_stdin_stdout_agent_command_can_generate_the_canonical_script(tmp_path: Path, monkeypatch) -> None:
    manifest_path = _planned_run(tmp_path, monkeypatch)
    runtime = tmp_path / "runtime.py"
    runtime.write_text(
        "import json, sys\nrequest=json.load(sys.stdin)\nprint('# Script\\n\\n' + request['title'])\n",
        encoding="utf-8",
    )

    output = run_agent_script(
        manifest_path,
        command=[sys.executable, str(runtime)],
        confirm="AGENT_GENERATE",
    )

    script_path = Path(output["script_path"])
    assert read_private_text(script_path) == "# Script\n\nGeneral runtime\n"
    assert script_path.read_text(encoding="utf-8").startswith(ENCRYPTED_PREFIX)
    manifest = load_manifest(manifest_path)
    assert any(item["role"] == "script" and item["provider"] == "agent-runtime" for item in manifest["artifacts"])


def test_external_agent_can_attach_a_script_without_a_vendor_specific_runtime(tmp_path: Path, monkeypatch) -> None:
    manifest_path = _planned_run(tmp_path, monkeypatch)
    script = tmp_path / "finished.md"
    script.write_text("# Finished script\n", encoding="utf-8")

    result = attach_script(manifest_path, script, runtime="hermes")

    assert Path(result["script_path"]).parent == manifest_path.parent
    receipt = read_private_json(manifest_path.parent / "script-receipt.json")
    assert receipt["runtime"] == "hermes"
