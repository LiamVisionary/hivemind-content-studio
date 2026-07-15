import json
from pathlib import Path

import pytest

from mobile_metadata import (
    MetadataPathError,
    extract_loadable_workflow_from_metadata,
    extract_workflow_from_metadata,
    is_encrypted_workflow_envelope,
    prompt_to_fallback_workflow,
    resolve_metadata_path,
)


def encrypted_workflow(label: str = "secret-workflow"):
    return {
        "encrypted": True,
        "format": "comfyui-mobile-encrypted-workflow",
        "version": 1,
        "iterations": 250000,
        "salt": "c2FsdA==",
        "iv": "aXY=",
        "data": label,
    }


def test_resolve_metadata_path_uses_video_sidecar_image(tmp_path: Path):
    output_dir = tmp_path / "output"
    input_dir = tmp_path / "input"
    output_dir.mkdir()
    input_dir.mkdir()
    video = output_dir / "clip.mp4"
    sidecar = output_dir / "clip.png"
    video.write_bytes(b"video")
    sidecar.write_bytes(b"image")

    resolved = resolve_metadata_path("clip.mp4", "output", str(input_dir), str(output_dir))
    assert resolved == str(sidecar)


def test_resolve_metadata_path_rejects_path_traversal(tmp_path: Path):
    output_dir = tmp_path / "output"
    input_dir = tmp_path / "input"
    output_dir.mkdir()
    input_dir.mkdir()
    outside_file = tmp_path / "outside.png"
    outside_file.write_bytes(b"x")

    with pytest.raises(MetadataPathError) as exc:
        resolve_metadata_path("../outside.png", "output", str(input_dir), str(output_dir))
    assert exc.value.status_code == 403


def test_resolve_metadata_path_errors_when_video_has_no_sidecar(tmp_path: Path):
    output_dir = tmp_path / "output"
    input_dir = tmp_path / "input"
    output_dir.mkdir()
    input_dir.mkdir()
    (output_dir / "clip.mp4").write_bytes(b"video")

    with pytest.raises(MetadataPathError) as exc:
        resolve_metadata_path("clip.mp4", "output", str(input_dir), str(output_dir))
    assert exc.value.status_code == 404
    assert str(exc.value) == "No image metadata found for video"


def test_extract_workflow_from_metadata_prefers_workflow_field():
    envelope = encrypted_workflow("workflow-from-field")
    metadata = {
        "workflow": json.dumps(envelope),
        "prompt": json.dumps(
            {
                "extra_pnginfo": {
                    "workflow": encrypted_workflow("workflow-from-prompt"),
                }
            }
        ),
    }

    workflow = extract_workflow_from_metadata(metadata)
    assert workflow == envelope
    assert is_encrypted_workflow_envelope(workflow)


def test_extract_workflow_from_metadata_reads_prompt_fallback():
    envelope = encrypted_workflow("workflow-from-prompt")
    metadata = {
        "prompt": json.dumps(
            {
                "extra_pnginfo": {
                    "workflow": envelope,
                }
            }
        )
    }

    workflow = extract_workflow_from_metadata(metadata)
    assert workflow == envelope


def test_prompt_only_metadata_is_not_loadable_by_default():
    prompt = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "model.safetensors"}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 1], "text": "hello"}},
        "3_sampler": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["2", 0], "steps": 4}},
    }
    metadata = {"prompt": json.dumps(prompt)}

    workflow = extract_loadable_workflow_from_metadata(metadata)

    assert workflow is None


def test_prompt_only_metadata_can_build_legacy_fallback_when_explicitly_enabled():
    prompt = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "model.safetensors"}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 1], "text": "hello"}},
        "3_sampler": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["2", 0], "steps": 4}},
    }
    metadata = {"prompt": json.dumps(prompt)}

    workflow = extract_loadable_workflow_from_metadata(metadata, allow_prompt_fallback=True)

    assert workflow is not None
    assert workflow["extra"]["source"] == "embedded_api_prompt_fallback"
    assert len(workflow["nodes"]) == 3
    assert workflow["last_link_id"] == 3
    sampler = next(node for node in workflow["nodes"] if node["type"] == "KSampler")
    assert sampler["properties"]["api_prompt_id"] == "3_sampler"
    assert sampler["widgets_values"]["steps"] == 4


def test_prompt_to_fallback_workflow_rejects_empty_prompt():
    assert prompt_to_fallback_workflow({}) is None
