from __future__ import annotations

from pathlib import Path

from hivemind_content_studio.machine_privacy import machine_operation_receipt, machine_run_receipt


def test_machine_run_receipt_excludes_prompts_paths_media_and_error_text(tmp_path: Path) -> None:
    run = {
        "ok": True,
        "run_id": "run-private",
        "lane": "animation",
        "status": "awaiting_generation",
        "current_step": "keyframes",
        "revision": 4,
        "manifest_path": str(tmp_path / "manifest.json"),
        "brief": {"concept": "private concept", "scenes": [{"image_prompt": "private scene prompt"}]},
        "user_prompt": "private user prompt",
        "steps": [{
            "step_id": "keyframes",
            "status": "failed",
            "attempts": 1,
            "max_attempts": 3,
            "error": "provider failed while rendering private scene prompt",
            "next_actions": [{
                "intent": "generate_keyframes",
                "tool": "execute_content_intent",
                "arguments": {"run_id": "run-private", "prompt": "private next prompt", "manifest_path": str(tmp_path)},
                "reason": "private reason",
            }],
        }],
        "artifact_records": [{"id": "a1", "role": "keyframe", "path": str(tmp_path / "private.png")}],
        "artifacts": {"keyframe": str(tmp_path / "private.png")},
        "next_actions": [],
    }

    receipt = machine_run_receipt(run)
    serialized = repr(receipt).lower()

    assert receipt["run_id"] == "run-private"
    assert receipt["steps"][0]["error_type"] == "StepError"
    assert receipt["artifact_count"] == 1
    for forbidden in ("private concept", "private scene prompt", "private user prompt", "manifest.json", "private.png", "private next prompt"):
        assert forbidden not in serialized


def test_machine_operation_receipt_drops_media_urls_and_creative_payloads() -> None:
    receipt = machine_operation_receipt({
        "ok": True,
        "run_id": "run-1",
        "status": "success",
        "prompt": "private prompt",
        "output": "/private/output.png",
        "image_urls": ["https://private/image.png?token=secret"],
        "job": {"id": "job-1", "status": "success", "prompt": "private nested prompt", "outputs": ["private.png"]},
    })

    assert receipt["run_id"] == "run-1"
    assert receipt["job"]["id"] == "job-1"
    assert "private" not in repr(receipt).lower()
    assert receipt["prompts_redacted"] is True
    assert receipt["media_redacted"] is True


def test_media_mcp_defaults_to_receipts_without_prompt_or_image_outputs() -> None:
    source = Path("packages/media-gateway/bin/media-studio-mcp.mjs").read_text(encoding="utf-8")

    assert "MEDIA_STUDIO_MCP_MACHINE_PRIVATE !== '0'" in source
    assert "prompts_redacted" in source
    assert "media_redacted" in source
    assert "publicWorkflowDefaults" in source
    assert "const receipt = {};" in source
    assert "'id', 'job_id', 'jobId', 'prompt_id', 'comfy_prompt_id', 'status', 'state'" in source
    assert "const includeUrls = machinePrivate ? false : include_urls" in source
