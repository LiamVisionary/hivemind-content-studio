from __future__ import annotations

import sys
from pathlib import Path

import pytest

from hivemind_content_studio.agent_runtime import run_registered_agent_script
from hivemind_content_studio.manifest import load_manifest
from hivemind_content_studio.planner import plan
from hivemind_content_studio.runtime_registry import RuntimeRegistry


def test_only_operator_registered_runtime_ids_can_execute(tmp_path: Path, monkeypatch) -> None:
    command = tmp_path / "runtime.py"
    command.write_text("import json,sys\nprint('# Script\\n\\n' + json.load(sys.stdin)['title'])\n", encoding="utf-8")
    monkeypatch.setenv("CONTENT_STUDIO_RUNTIME_TEST_AGENT_COMMAND", f'{sys.executable} {command}')
    registry = RuntimeRegistry.from_environment()

    assert registry.get("test-agent").id == "test-agent"
    with pytest.raises(ValueError, match="not registered"):
        registry.get("arbitrary-shell")


def test_registered_runtime_generates_script_without_accepting_agent_supplied_argv(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    runtime = tmp_path / "runtime.py"
    runtime.write_text("import json,sys\nprint('# Script\\n\\n' + json.load(sys.stdin)['title'])\n", encoding="utf-8")
    monkeypatch.setenv("CONTENT_STUDIO_RUNTIME_SAFE_AGENT_COMMAND", f'{sys.executable} {runtime}')
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: safe\nlane: first-frame-animation-ad\ntitle: Safe runtime\nscenes:\n  - beat: Hook\n", encoding="utf-8")
    manifest_path = plan(brief)

    result = run_registered_agent_script(manifest_path, runtime_id="safe-agent", confirm="AGENT_GENERATE")

    assert result["runtime"] == "safe-agent"
    assert any(item["role"] == "script" for item in load_manifest(manifest_path)["artifacts"])


def test_mcp_runtime_tool_takes_a_runtime_id_not_an_arbitrary_command() -> None:
    source = Path("src/hivemind_content_studio/mcp_server.py").read_text(encoding="utf-8")
    signature = source.split("def run_agent_script_generation(", 1)[1].split(") -> dict", 1)[0]

    assert "runtime_id" in signature
    assert "command:" not in signature
