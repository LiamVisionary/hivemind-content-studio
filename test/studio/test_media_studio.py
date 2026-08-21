from __future__ import annotations

import contextlib
import json
import urllib.error
from pathlib import Path

import pytest

from hivemind_content_studio.media_studio import (
    MediaStudioDescriptor,
    _comfy_history_error,
    _private_video_url,
    _reachable,
    _token,
    discover_media_studio,
    generate_video,
    start_video,
    video_dimensions_for_request,
)
from hivemind_content_studio.planner import DEFAULT_PROVIDERS


def test_media_catalog_preserves_workflow_geometry_and_duration(monkeypatch) -> None:
    monkeypatch.setattr(
        "hivemind_content_studio.media_studio.list_media_studio_workflows",
        lambda _kind: [{
            "id": "ltx23-ic-ingredients-lora",
            "title": "LTX 2.3 IC-LoRA Ingredients",
            "accepts": ["prompt", "ingredient_images", "image_base64"],
            "aspect_ratios": ["16:9", "9:16", "4:3", "3:4", "1:1"],
            "defaults": {"duration_seconds": 5},
        }],
    )
    from hivemind_content_studio.media_catalog import _media_studio_video_models

    model = next(item for item in _media_studio_video_models({"available": True}) if item.id == "ltx23-ic-ingredients-lora")

    assert model.aspect_ratios == ("16:9", "9:16", "4:3", "3:4", "1:1")
    assert model.default_duration_seconds == 5


def test_unreachable_probe_keeps_the_last_live_workflow_capabilities(monkeypatch) -> None:
    """The reachability probe is a 3s initialize POST gating a 30s registry read,
    so a gateway that is merely busy fails it. Falling back to the built-in model
    list there silently strips reference mode off MiniMax H3 — same model, no
    References panel — which is the studio's most confusing failure: nothing
    looks broken, the controls are just the old ones."""
    from hivemind_content_studio import media_catalog as catalog_module

    monkeypatch.setattr(
        "hivemind_content_studio.media_studio.list_media_studio_workflows",
        lambda _kind: [{
            "id": "minimax-h3-reference",
            "title": "MiniMax H3 Reference",
            "accepts": ["prompt", "reference_images"],
            "reference_slots": {"images": 9, "videos": 3, "audios": 3},
            "routing_only": True,
            "family": "minimax",
        }],
    )
    monkeypatch.setattr(catalog_module, "_last_live_media_studio_models", ())

    live, is_live = catalog_module._media_studio_registry({"available": True})
    assert is_live is True
    assert any(model.id == "minimax-h3-reference" for model in live)

    remembered, is_live = catalog_module._media_studio_registry({"available": False})
    assert is_live is False, "a probe miss must be reported, not passed off as a live read"
    reference = next(model for model in remembered if model.id == "minimax-h3-reference")
    assert reference.reference_slots == {"images": 9, "videos": 3, "audios": 3}

    # Only a process that has never had a live read falls back to the built-ins,
    # and it says so.
    monkeypatch.setattr(catalog_module, "_last_live_media_studio_models", ())
    cold, is_live = catalog_module._media_studio_registry({"available": False})
    assert is_live is False
    assert not any(model.id == "minimax-h3-reference" for model in cold)


def test_media_studio_is_discovered_from_hivemind_preferences(tmp_path: Path, monkeypatch) -> None:
    preferences = tmp_path / "app-preferences.json"
    preferences.write_text(
        json.dumps(
            {
                "preferences": [
                    {
                        "appId": "host:8788:studio",
                        "appName": "Media Studio",
                        "capabilities": ["video", "image-to-video"],
                        "mcpVideo": {
                            "url": "http://example.test:8789/mcp",
                            "uploadBase": "http://example.test:8788",
                            "authEnvKey": "MEDIA_STUDIO_TOKEN",
                            "tool": "media_generate_video",
                            "jobTool": "media_get_job",
                            "workflowId": "local-workflow",
                        },
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HIVEMINDOS_APP_PREFERENCES", str(preferences))
    descriptor = discover_media_studio()
    assert descriptor is not None
    assert descriptor.app_name == "Media Studio"
    assert descriptor.auth_env_key == "MEDIA_STUDIO_TOKEN"
    assert descriptor.tool == "media_generate_video"
    assert descriptor.job_tool == "media_get_job"
    assert DEFAULT_PROVIDERS["motion"] == "media-studio-mcp"


def test_media_studio_falls_back_to_the_managed_local_mcp_descriptor(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HIVEMINDOS_APP_PREFERENCES", str(tmp_path / "missing-preferences.json"))
    monkeypatch.setenv("MEDIA_STUDIO_MCP_PORT", "9876")
    monkeypatch.setenv("MEDIA_STUDIO_UPLOAD_BASE", "http://127.0.0.1:8788")

    descriptor = discover_media_studio()

    assert descriptor is not None
    assert descriptor.app_id == "managed:media-studio-mcp"
    assert descriptor.mcp_url == "http://127.0.0.1:9876/mcp"
    assert descriptor.upload_base == "http://127.0.0.1:8788"
    assert descriptor.auth_env_key == "ZIMG_TOKEN"
    assert descriptor.tool == "media_generate_video"


def test_managed_media_studio_uses_canonical_token_file_over_stale_media_env(tmp_path: Path, monkeypatch) -> None:
    state = tmp_path / "media-state"
    token_file = state / "secure" / "zimg-token"
    token_file.parent.mkdir(parents=True)
    token_file.write_text("canonical-local-token\n", encoding="utf-8")
    monkeypatch.setenv("HIVEMINDOS_APP_PREFERENCES", str(tmp_path / "missing-preferences.json"))
    monkeypatch.setenv("HIVEMIND_MEDIA_STATE_DIR", str(state))
    monkeypatch.setenv("MEDIA_STUDIO_TOKEN", "stale-shared-env-token")
    monkeypatch.delenv("ZIMG_TOKEN", raising=False)

    descriptor = discover_media_studio()

    assert descriptor is not None
    assert descriptor.app_id == "managed:media-studio-mcp"
    assert _token(descriptor) == "canonical-local-token"


def test_media_studio_reachability_rejects_bad_mcp_auth(monkeypatch) -> None:
    def fail_auth(request, timeout=0):
        raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, None)

    monkeypatch.setattr("hivemind_content_studio.media_studio.urllib.request.urlopen", fail_auth)

    assert _reachable("http://example.test/mcp", "wrong-token") is False


def test_private_output_lookup_uses_server_auth_without_returning_it_through_mcp(monkeypatch) -> None:
    descriptor = MediaStudioDescriptor(
        app_id="test",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8788",
        auth_env_key="TEST_MEDIA_STUDIO_TOKEN",
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id="ltx23-eros-fast",
    )
    monkeypatch.setenv("TEST_MEDIA_STUDIO_TOKEN", "server-private-token")
    requests = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return json.dumps({
                "id": "job-private",
                "status": "success",
                "image_urls": ["/image/private-video.mp4?token=server-private-token"],
            }).encode("utf-8")

    def fake_urlopen(request, timeout=0):
        requests.append(request)
        return Response()

    monkeypatch.setattr("hivemind_content_studio.media_studio.urllib.request.urlopen", fake_urlopen)

    result = _private_video_url(descriptor, "job-private")

    assert result == "http://127.0.0.1:8788/image/private-video.mp4?token=server-private-token"
    assert requests[0].get_header("Authorization") == "Bearer server-private-token"


def test_remote_lane_failure_reason_is_read_from_the_private_history() -> None:
    # MCP receipts are machine-redacted and remote prompts have no /api/job
    # record, so this history read is the only thing standing between the user
    # and "Media Studio reported a failed generation" (2026-08-07).
    history = {
        "prompt-1": {
            "status": {
                "status_str": "error",
                "completed": True,
                "messages": [[
                    "hivemind_remote_error",
                    {"error": "SpectrumApplyMiniMaxH3 (node 30) failed — ValueError: bootstrap_first_forecast requires degree == 1"},
                ]],
            },
            "outputs": {},
        }
    }
    assert "bootstrap_first_forecast" in _comfy_history_error(history)


def _descriptor_for_check() -> MediaStudioDescriptor:
    return MediaStudioDescriptor(
        app_id="test",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8788",
        auth_env_key="TEST_MEDIA_STUDIO_TOKEN",
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id="minimax-h3",
    )


def test_in_flight_remote_job_takes_status_and_progress_from_the_private_record(monkeypatch) -> None:
    # The MCP answers 404 for a remote prompt's whole life and its receipts are
    # machine-redacted (no progress field survives), so without the gateway's
    # own job record the studio sees neither state nor progress.
    from hivemind_content_studio import media_studio

    monkeypatch.setattr(media_studio, "_required_descriptor", _descriptor_for_check)
    monkeypatch.setattr(media_studio, "_client", lambda descriptor, *_pub: object())
    monkeypatch.setattr(media_studio, "_result_json", lambda _call: {"ok": False, "error": "MediaStudioError", "status": 404})
    monkeypatch.setattr(media_studio, "_client", lambda descriptor, *_pub: type("C", (), {"call_tool": lambda *a, **k: None})())
    monkeypatch.setattr(
        media_studio, "_private_json",
        lambda descriptor, path, *_pub: {"id": "p1", "status": "running", "progress": 0.45, "backend": "comfy-remote"},
    )

    state = media_studio.check_video("p1")
    assert state["status"] == "running"
    assert state["progress"] == 0.45
    assert state["failed"] is False


def test_step_counters_surface_only_when_the_backend_measures_them(monkeypatch) -> None:
    from hivemind_content_studio import media_studio

    monkeypatch.setattr(media_studio, "_required_descriptor", _descriptor_for_check)
    monkeypatch.setattr(media_studio, "_client", lambda descriptor, *_pub: type("C", (), {"call_tool": lambda *a, **k: None})())
    monkeypatch.setattr(media_studio, "_result_json", lambda _call: {"ok": False, "status": 404})

    monkeypatch.setattr(
        media_studio, "_private_json",
        lambda descriptor, path, *_pub: {"status": "running", "progress": 0.36, "progress_step": 6, "progress_total": 15},
    )
    measured = media_studio.check_video("p3")
    assert (measured["progress_step"], measured["progress_total"]) == (6, 15)

    # A backend without counters must not invent them: the label would imply a
    # precision the time-based bar does not have.
    monkeypatch.setattr(media_studio, "_private_json", lambda descriptor, path, *_pub: {"status": "running"})
    assert "progress_step" not in media_studio.check_video("p4")


def test_finished_remote_job_resolves_the_sealed_output_url(monkeypatch) -> None:
    from hivemind_content_studio import media_studio

    monkeypatch.setattr(media_studio, "_required_descriptor", _descriptor_for_check)
    monkeypatch.setattr(media_studio, "_client", lambda descriptor, *_pub: type("C", (), {"call_tool": lambda *a, **k: None})())
    monkeypatch.setattr(media_studio, "_result_json", lambda _call: {"ok": False, "error": "MediaStudioError", "status": 404})
    monkeypatch.setattr(
        media_studio, "_private_json",
        lambda descriptor, path, *_pub: {
            "id": "p2", "status": "success",
            "image_urls": ["/image/cmf-p2-clip.mp4"],
        },
    )

    state = media_studio.check_video("p2")
    assert state["status"] == "success"
    # Resolved against the studio's own gateway origin, so the finisher can
    # download the sealed envelope instead of spinning to the poll limit.
    assert state["video_url"] == "http://127.0.0.1:8788/image/cmf-p2-clip.mp4"


def test_native_execution_errors_surface_the_node_but_not_its_inputs() -> None:
    history = {
        "prompt-2": {
            "status": {
                "status_str": "error",
                "messages": [[
                    "execution_error",
                    {
                        "node_id": "6",
                        "node_type": "UNETLoader",
                        "exception_type": "FileNotFoundError",
                        "exception_message": "model is missing",
                        "current_inputs": {"prompt": ["a private prompt the customer typed"]},
                    },
                ]],
            },
        }
    }
    message = _comfy_history_error(history)
    assert message == "UNETLoader node 6 failed — model is missing"
    assert "private prompt" not in message


def test_an_out_of_memory_failure_names_the_control_the_user_actually_has() -> None:
    """The raw allocator dump is bookkeeping, truncated mid-sentence at 400 chars.

    Its own advice is about batch_size, which this studio does not expose. What
    actually blows the budget is clip length: measured 2026-08-13 on a 5090 in
    MiniMax H3 reference mode at 1216x704 with nine pictures, a motion clip and
    a voice clip, 141 frames (5.9s) peaked at 29.63GiB of 31.36 and 158 frames
    (6.6s) ran out — while the duration slider goes to 15s."""
    history = {
        "p": {
            "status": {
                "status_str": "error",
                "messages": [[
                    "execution_error",
                    {
                        "node_id": "14",
                        "node_type": "SamplerCustomAdvanced",
                        "exception_type": "OutOfMemoryError",
                        "exception_message": (
                            "Allocation on device 0 would exceed allowed memory. (out of memory) "
                            "Currently allocated : 28.69 GiB Requested : 7.29 GiB "
                            "Device limit : 31.36 GiB Free (according to CUDA): 29.94 MiB "
                            "This error means you ran out of memory on your GPU. TIPS: If the "
                            "workflow worked before you might have accidentally set the "
                            "batch_size to a large number."
                        ),
                    },
                ]],
            },
        }
    }
    message = _comfy_history_error(history)
    assert "ran out of memory" in message
    assert "7.29 GiB" in message, "the shortfall is the one number worth keeping"
    assert "shorter duration" in message
    # The knob the raw text recommends does not exist in this studio.
    assert "batch_size" not in message


def test_a_non_memory_failure_is_still_reported_verbatim() -> None:
    """Only OOM is translated; everything else keeps its own reason."""
    history = {
        "p": {
            "status": {
                "status_str": "error",
                "messages": [[
                    "execution_error",
                    {"node_id": "6", "node_type": "UNETLoader",
                     "exception_message": "model is missing"},
                ]],
            },
        }
    }
    assert _comfy_history_error(history) == "UNETLoader node 6 failed — model is missing"


def test_a_successful_history_reports_no_error() -> None:
    assert _comfy_history_error({"p": {"status": {"status_str": "success", "messages": []}}}) == ""
    assert _comfy_history_error({}) == ""


def test_private_output_lookup_supports_comfy_video_history(monkeypatch) -> None:
    descriptor = MediaStudioDescriptor(
        app_id="test",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8788",
        auth_env_key=None,
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id="ltx23-regular-fp8",
    )

    class Response:
        def __init__(self, payload):
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return json.dumps(self.payload).encode("utf-8")

    def fake_urlopen(request, timeout=0):
        if request.full_url.endswith("/api/job/comfy-job"):
            raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, None)
        return Response({
            "comfy-job": {
                "outputs": {
                    "video": {
                        "gifs": [{"filename": "private result.mp4", "subfolder": "ltx", "type": "output"}],
                    },
                },
            },
        })

    monkeypatch.setattr("hivemind_content_studio.media_studio.urllib.request.urlopen", fake_urlopen)

    result = _private_video_url(descriptor, "comfy-job")

    assert result == "http://127.0.0.1:8788/comfy/view?filename=private+result.mp4&subfolder=ltx&type=output"


def test_video_generation_removes_uploaded_reference_and_qa_frame(tmp_path: Path, monkeypatch) -> None:
    descriptor = MediaStudioDescriptor(
        app_id="test",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8788",
        auth_env_key=None,
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id="ltx23-eros-fast",
    )
    image = tmp_path / "reference.png"
    image.write_bytes(b"reference")
    deleted_inputs: list[str] = []
    private_output_lookups: list[str] = []

    class Client:
        def call_tool(self, name, arguments, **_kwargs):
            if name == descriptor.tool:
                assert arguments["image_path"] == "media-studio-input-private.png"
                assert arguments["loras"] == [{"id": "ltx/style.safetensors", "strength": 0.65}]
                payload = {"job": {"id": "job-private", "status": "queued", "media_redacted": True}}
            else:
                assert name == descriptor.job_tool
                assert arguments["id"] == "job-private"
                payload = {"job": {"id": "job-private", "status": "success", "media_redacted": True}}
            return {
                "content": [{
                    "type": "text",
                    "text": json.dumps(payload),
                }],
            }

    def fake_private_video_url(_descriptor, job_id):
        private_output_lookups.append(job_id)
        return "http://127.0.0.1:8788/private.mp4"

    def fake_download(_url, destination, *, token=""):
        assert token == ""
        destination.write_bytes(b"private-video")

    def fake_qa(video, *, output_dir, require_audio):
        frame = Path(output_dir) / "private-middle.jpg"
        frame.parent.mkdir(parents=True, exist_ok=True)
        frame.write_bytes(b"private-frame")
        return {"ok": True, "video": str(video), "representative_frame": str(frame), "failures": []}

    monkeypatch.setattr("hivemind_content_studio.media_studio._required_descriptor", lambda: descriptor)
    monkeypatch.setattr("hivemind_content_studio.media_studio._upload_image", lambda *_args: "media-studio-input-private.png")
    monkeypatch.setattr("hivemind_content_studio.media_studio._client", lambda *_args: Client())
    monkeypatch.setattr("hivemind_content_studio.media_studio._private_video_url", fake_private_video_url)
    monkeypatch.setattr("hivemind_content_studio.media_studio._download", fake_download)
    monkeypatch.setattr("hivemind_content_studio.media_studio.time.sleep", lambda _seconds: None)
    monkeypatch.setattr("hivemind_content_studio.media_studio.qa_video", fake_qa)
    monkeypatch.setattr(
        "hivemind_content_studio.media_studio._delete_uploaded_image",
        lambda _descriptor, name: deleted_inputs.append(name),
    )
    monkeypatch.setattr("hivemind_content_studio.media_studio._video_dimensions", lambda _path, **_kwargs: (768, 768))

    result = generate_video(
        image_path=image,
        prompt="private prompt",
        loras=[{"id": "ltx/style.safetensors", "strength": 0.65}],
        output_dir=tmp_path / "outputs",
    )

    assert deleted_inputs == ["media-studio-input-private.png"]
    assert private_output_lookups == ["job-private"]
    assert result["qa"]["representative_frame"] is None
    assert not (tmp_path / "outputs" / "qa" / "private-middle.jpg").exists()


def test_video_generation_surfaces_private_backend_error_and_removes_upload(tmp_path: Path, monkeypatch) -> None:
    descriptor = MediaStudioDescriptor(
        app_id="test",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8788",
        auth_env_key=None,
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id="ltx23-ic-ingredients-lora",
    )
    image = tmp_path / "start.png"
    image.write_bytes(b"start")
    deleted_inputs: list[str] = []

    class Client:
        def call_tool(self, name, arguments, **_kwargs):
            assert name in {descriptor.tool, descriptor.job_tool}
            payload = (
                {"job": {"id": "job-failed", "status": "queued"}}
                if name == descriptor.tool
                else {"job": {"id": "job-failed", "status": "error", "media_redacted": True}}
            )
            return {"content": [{"type": "text", "text": json.dumps(payload)}]}

    monkeypatch.setattr("hivemind_content_studio.media_studio._required_descriptor", lambda: descriptor)
    monkeypatch.setattr("hivemind_content_studio.media_studio._upload_image", lambda *_args: "uploaded-start.png")
    monkeypatch.setattr("hivemind_content_studio.media_studio._client", lambda *_args: Client())
    monkeypatch.setattr("hivemind_content_studio.media_studio._video_dimensions", lambda _path, **_kwargs: (768, 448))
    monkeypatch.setattr("hivemind_content_studio.media_studio.time.sleep", lambda _seconds: None)
    monkeypatch.setattr(
        "hivemind_content_studio.media_studio._private_json",
        lambda *_args: {
            "id": "job-failed",
            "status": "error",
            "error": "native MLX LTX LoRA not found: ingredients.safetensors",
        },
    )
    monkeypatch.setattr(
        "hivemind_content_studio.media_studio._delete_uploaded_image",
        lambda _descriptor, name: deleted_inputs.append(name),
    )

    with pytest.raises(RuntimeError, match="native MLX LTX LoRA not found: ingredients.safetensors"):
        generate_video(
            image_path=image,
            prompt="Keep the same character identity.",
            output_dir=tmp_path / "outputs",
        )

    assert deleted_inputs == ["uploaded-start.png"]


def test_video_generation_routes_source_video_to_ltx_extension(tmp_path: Path, monkeypatch) -> None:
    descriptor = MediaStudioDescriptor(
        app_id="test",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8788",
        auth_env_key=None,
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id="ltx23-eros-fast",
    )
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source-video")
    captured: dict = {}
    deleted_inputs: list[str] = []

    class Client:
        def call_tool(self, name, arguments, **_kwargs):
            # generate_video is start_video + finish_video now, and finish_video
            # only receives a job id, so it ALWAYS polls job_tool at least once.
            # Only the generate call's arguments are the ones under test — the
            # poll's {"id", "include_urls"} would otherwise clobber them.
            assert name in {descriptor.tool, descriptor.job_tool}
            if name == descriptor.tool:
                captured.update(arguments)
            return {
                "content": [{
                    "type": "text",
                    "text": json.dumps({
                        "job": {
                            "id": "job-extend",
                            "status": "success",
                            "media_urls": ["http://127.0.0.1:8788/image/extended.mp4"],
                        },
                    }),
                }],
            }

    def fake_download(_url, destination, *, token=""):
        destination.write_bytes(b"extended-video")

    def fake_qa(video, *, output_dir, require_audio):
        return {"ok": True, "video": str(video), "representative_frame": None, "failures": []}

    monkeypatch.setattr("hivemind_content_studio.media_studio._required_descriptor", lambda: descriptor)
    monkeypatch.setattr("hivemind_content_studio.media_studio._upload_video", lambda *_args: "media-studio-input-source.mp4")
    monkeypatch.setattr("hivemind_content_studio.media_studio._client", lambda *_args: Client())
    monkeypatch.setattr("hivemind_content_studio.media_studio._download", fake_download)
    monkeypatch.setattr("hivemind_content_studio.media_studio.qa_video", fake_qa)
    monkeypatch.setattr(
        "hivemind_content_studio.media_studio._delete_uploaded_image",
        lambda _descriptor, name: deleted_inputs.append(name),
    )

    result = generate_video(
        video_path=source,
        video_mode="extend",
        prompt="continue the same shot",
        duration_seconds=2,
        output_dir=tmp_path / "outputs",
    )

    assert captured["video_path"] == "media-studio-input-source.mp4"
    assert captured["video_mode"] == "extend"
    assert captured["duration_seconds"] == 2
    assert captured["frame_rate"] == 24
    assert "image_path" not in captured
    assert "width" not in captured
    assert deleted_inputs == ["media-studio-input-source.mp4"]
    assert Path(result["output"]).read_bytes() == b"extended-video"


def test_video_generation_forwards_ingredient_views_without_start_frame(tmp_path: Path, monkeypatch) -> None:
    descriptor = MediaStudioDescriptor(
        app_id="test",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8788",
        auth_env_key=None,
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id="ltx23-ic-ingredients-lora",
    )
    front = tmp_path / "front.png"
    profile = tmp_path / "profile.png"
    front.write_bytes(b"front")
    profile.write_bytes(b"profile")
    captured: dict = {}
    deleted_inputs: list[str] = []

    class Client:
        def call_tool(self, name, arguments, **_kwargs):
            # generate_video is start_video + finish_video now, and finish_video
            # only receives a job id, so it ALWAYS polls job_tool at least once.
            # Only the generate call's arguments are the ones under test — the
            # poll's {"id", "include_urls"} would otherwise clobber them.
            assert name in {descriptor.tool, descriptor.job_tool}
            if name == descriptor.tool:
                captured.update(arguments)
            return {"content": [{"type": "text", "text": json.dumps({
                "job": {"id": "ingredients-job", "status": "success", "media_urls": ["http://127.0.0.1:8788/image/ingredients.mp4"]},
            })}]}

    def fake_upload(_descriptor, image):
        return f"uploaded-{Path(image).stem}.png"

    monkeypatch.setattr("hivemind_content_studio.media_studio._required_descriptor", lambda: descriptor)
    monkeypatch.setattr("hivemind_content_studio.media_studio._upload_image", fake_upload)
    monkeypatch.setattr("hivemind_content_studio.media_studio._client", lambda *_args: Client())
    monkeypatch.setattr("hivemind_content_studio.media_studio._download", lambda _url, destination, **_kwargs: destination.write_bytes(b"video"))
    monkeypatch.setattr("hivemind_content_studio.media_studio.qa_video", lambda *_args, **_kwargs: {"ok": True, "representative_frame": None, "failures": []})
    monkeypatch.setattr(
        "hivemind_content_studio.media_studio._delete_uploaded_image",
        lambda _descriptor, name: deleted_inputs.append(name),
    )

    generate_video(
        prompt="The same character turns toward camera.",
        reference_description="Two views of the same character.",
        ingredient_images=[
            {"image_path": front, "description": "front view"},
            {"image_path": profile, "description": "right profile"},
        ],
        output_dir=tmp_path / "outputs",
    )

    assert "image_path" not in captured
    assert "video_path" not in captured
    assert captured["ingredient_images"] == [
        {"image_path": "uploaded-front.png", "description": "front view"},
        {"image_path": "uploaded-profile.png", "description": "right profile"},
    ]
    assert captured["reference_description"] == "Two views of the same character."
    assert "width" not in captured and "height" not in captured
    assert deleted_inputs == ["uploaded-front.png", "uploaded-profile.png"]


def test_video_dimensions_support_a_high_resolution_tier() -> None:
    assert video_dimensions_for_request(aspect_ratio="16:9") == (768, 448)
    assert video_dimensions_for_request(aspect_ratio="16:9", resolution="high") == (1216, 704)
    assert video_dimensions_for_request(aspect_ratio="3:4", resolution="high") == (768, 1024)
    assert video_dimensions_for_request(aspect_ratio="1:1", resolution="High") == (896, 896)
    # Unknown tiers fall back to the standard buckets.
    assert video_dimensions_for_request(aspect_ratio="9:16", resolution="ultra") == (448, 768)
    # Every high bucket stays VAE-aligned and close to its nominal aspect.
    for aspect, (width, height) in {
        "16:9": (1216, 704), "9:16": (704, 1216), "4:3": (1024, 768),
        "3:4": (768, 1024), "1:1": (896, 896),
    }.items():
        assert width % 32 == 0 and height % 32 == 0
        nominal_w, nominal_h = (int(part) for part in aspect.split(":"))
        assert abs((width / height) - (nominal_w / nominal_h)) / (nominal_w / nominal_h) <= 0.05


def test_video_dimensions_support_the_max_native_tier() -> None:
    # "max" is MiniMax H3's native canvas (~1.0MP, 768px short edge at 16:9) —
    # the community-measured quality knee. Nothing above ~1.05MP is offered
    # because H3 grows less coherent past 1MP.
    assert video_dimensions_for_request(aspect_ratio="16:9", resolution="max") == (1344, 768)
    assert video_dimensions_for_request(aspect_ratio="9:16", resolution="Max") == (768, 1344)
    for aspect, (width, height) in {
        "16:9": (1344, 768), "9:16": (768, 1344), "4:3": (1152, 864),
        "3:4": (864, 1152), "1:1": (1024, 1024),
    }.items():
        assert video_dimensions_for_request(aspect_ratio=aspect, resolution="max") == (width, height)
        assert width % 32 == 0 and height % 32 == 0
        assert width * height <= 1_050_000, "the max tier must stay at H3's ~1MP stability ceiling"
        nominal_w, nominal_h = (int(part) for part in aspect.split(":"))
        assert abs((width / height) - (nominal_w / nominal_h)) / (nominal_w / nominal_h) <= 0.05


def test_matched_aspect_video_dimensions_snap_to_the_two_stage_grid(tmp_path: Path) -> None:
    # No fixed aspect: dimensions derive from the source frame. The two-stage
    # LTX pipelines floor anything not divisible by 64 (928 -> 896), so the
    # derived request must already sit on that grid.
    from PIL import Image

    source = tmp_path / "anchor.png"
    Image.new("RGB", (1024, 1024)).save(source)
    assert video_dimensions_for_request(image=source, resolution="high") == (896, 896)
    for resolution in ("", "high", "max"):
        width, height = video_dimensions_for_request(image=source, resolution=resolution)
        assert width % 64 == 0 and height % 64 == 0


def test_video_generation_forwards_high_resolution_dimensions(tmp_path: Path, monkeypatch) -> None:
    descriptor = MediaStudioDescriptor(
        app_id="test",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8788",
        auth_env_key=None,
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id="ltx23-ic-ingredients-lora",
    )
    sheet = tmp_path / "sheet.png"
    sheet.write_bytes(b"sheet")
    captured: dict = {}

    class Client:
        def call_tool(self, name, arguments, **_kwargs):
            # generate_video is start_video + finish_video now, and finish_video
            # only receives a job id, so it ALWAYS polls job_tool at least once.
            # Only the generate call's arguments are the ones under test — the
            # poll's {"id", "include_urls"} would otherwise clobber them.
            assert name in {descriptor.tool, descriptor.job_tool}
            if name == descriptor.tool:
                captured.update(arguments)
            return {"content": [{"type": "text", "text": json.dumps({
                "job": {"id": "high-res-job", "status": "success", "media_urls": ["http://127.0.0.1:8788/image/high.mp4"]},
            })}]}

    monkeypatch.setattr("hivemind_content_studio.media_studio._required_descriptor", lambda: descriptor)
    monkeypatch.setattr("hivemind_content_studio.media_studio._upload_image", lambda _descriptor, image: f"uploaded-{Path(image).stem}.png")
    monkeypatch.setattr("hivemind_content_studio.media_studio._client", lambda *_args: Client())
    monkeypatch.setattr("hivemind_content_studio.media_studio._download", lambda _url, destination, **_kwargs: destination.write_bytes(b"video"))
    monkeypatch.setattr("hivemind_content_studio.media_studio.qa_video", lambda *_args, **_kwargs: {"ok": True, "representative_frame": None, "failures": []})
    monkeypatch.setattr("hivemind_content_studio.media_studio._delete_uploaded_image", lambda _descriptor, name: None)

    generate_video(
        prompt="A closeup of the character.",
        reference_description="The reference sheet of the character.",
        ingredient_images=[{"image_path": sheet, "description": ""}],
        aspect_ratio="3:4",
        resolution="high",
        output_dir=tmp_path / "outputs",
    )

    assert captured["width"] == 768
    assert captured["height"] == 1024


def test_video_generation_forwards_start_frame_with_ingredient_views(tmp_path: Path, monkeypatch) -> None:
    descriptor = MediaStudioDescriptor(
        app_id="test",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8788",
        auth_env_key=None,
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id="ltx23-ic-ingredients-lora",
    )
    start = tmp_path / "start.png"
    front = tmp_path / "front.png"
    profile = tmp_path / "profile.png"
    start.write_bytes(b"start")
    front.write_bytes(b"front")
    profile.write_bytes(b"profile")
    captured: dict = {}
    deleted_inputs: list[str] = []

    class Client:
        def call_tool(self, name, arguments, **_kwargs):
            # generate_video is start_video + finish_video now, and finish_video
            # only receives a job id, so it ALWAYS polls job_tool at least once.
            # Only the generate call's arguments are the ones under test — the
            # poll's {"id", "include_urls"} would otherwise clobber them.
            assert name in {descriptor.tool, descriptor.job_tool}
            if name == descriptor.tool:
                captured.update(arguments)
            return {"content": [{"type": "text", "text": json.dumps({
                "job": {"id": "ingredients-start-job", "status": "success", "media_urls": ["http://127.0.0.1:8788/image/ingredients.mp4"]},
            })}]}

    def fake_upload(_descriptor, image):
        return f"uploaded-{Path(image).stem}.png"

    monkeypatch.setattr("hivemind_content_studio.media_studio._required_descriptor", lambda: descriptor)
    monkeypatch.setattr("hivemind_content_studio.media_studio._upload_image", fake_upload)
    monkeypatch.setattr("hivemind_content_studio.media_studio._client", lambda *_args: Client())
    monkeypatch.setattr("hivemind_content_studio.media_studio._download", lambda _url, destination, **_kwargs: destination.write_bytes(b"video"))
    monkeypatch.setattr("hivemind_content_studio.media_studio.qa_video", lambda *_args, **_kwargs: {"ok": True, "representative_frame": None, "failures": []})
    monkeypatch.setattr(
        "hivemind_content_studio.media_studio._delete_uploaded_image",
        lambda _descriptor, name: deleted_inputs.append(name),
    )

    generate_video(
        image_path=start,
        prompt="The same character turns toward camera.",
        reference_description="Two views of the same character.",
        ingredient_images=[
            {"image_path": front, "description": "front view"},
            {"image_path": profile, "description": "right profile"},
        ],
        aspect_ratio="9:16",
        output_dir=tmp_path / "outputs",
    )

    assert captured["image_path"] == "uploaded-start.png"
    assert captured["ingredient_images"] == [
        {"image_path": "uploaded-front.png", "description": "front view"},
        {"image_path": "uploaded-profile.png", "description": "right profile"},
    ]
    assert captured["width"] == 448
    assert captured["height"] == 768
    assert deleted_inputs == ["uploaded-start.png", "uploaded-front.png", "uploaded-profile.png"]


def test_video_generation_forwards_the_grain_cleanup_choice(tmp_path: Path, monkeypatch) -> None:
    """The denoise choice must reach the MCP verbatim — and only when set."""
    descriptor = MediaStudioDescriptor(
        app_id="test",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8788",
        auth_env_key=None,
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id="ltx23-eros-fast",
    )
    captured: dict = {}

    class Client:
        def call_tool(self, name, arguments, **_kwargs):
            captured.clear()
            captured.update(arguments)
            return {"content": [{"type": "text", "text": json.dumps({"job": {"id": "job-dn", "status": "running"}})}]}

    monkeypatch.setattr("hivemind_content_studio.media_studio._required_descriptor", lambda: descriptor)
    monkeypatch.setattr("hivemind_content_studio.media_studio._client", lambda *_args: Client())

    start_video(
        prompt="a slow push in",
        duration_seconds=2,
        denoise="strong",
        studio_lane="video:window-a:2",
    )
    assert captured["denoise"] == "strong"
    assert captured["studio_lane"] == "video:window-a:2"

    start_video(prompt="a slow push in", duration_seconds=2)
    assert "denoise" not in captured

    # Unknown tiers are dropped rather than forwarded to the runner.
    start_video(prompt="a slow push in", duration_seconds=2, denoise="nuclear")
    assert "denoise" not in captured


def test_video_start_waits_long_enough_for_the_lane_to_accept_it(monkeypatch) -> None:
    """Queueing is slow and abandoning it does not cancel it.

    The references are staged on the target lane inside this call, and ComfyUI
    only answers /prompt once its executor frees up, so a submit behind a
    running render routinely passed the 30s default. The studio then reported
    "timed out" for a job that went on to render, finish and be harvested with
    nobody holding its id. The wait has to fit the work — and stay under the
    190s Hivemind Link proxy leg, or a phone never hears the answer either.
    """
    from hivemind_content_studio import media_studio

    descriptor = MediaStudioDescriptor(
        app_id="test",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8788",
        auth_env_key=None,
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id="minimax-h3-reference",
    )
    seen: dict = {}

    class Client:
        def call_tool(self, name, arguments, **kwargs):
            seen.update(kwargs)
            return {"content": [{"type": "text", "text": json.dumps({"job": {"id": "job-1", "status": "running"}})}]}

    monkeypatch.setattr("hivemind_content_studio.media_studio._required_descriptor", lambda: descriptor)
    monkeypatch.setattr("hivemind_content_studio.media_studio._client", lambda *_args: Client())

    media_studio.start_video(prompt="a slow push in", duration_seconds=5)
    assert seen["timeout"] >= 120, "a submit gets long enough to stage its references and be accepted"
    assert seen["timeout"] < 190, "and still fits inside the Hivemind Link proxy leg"


def test_spectrum_toggle_is_tri_state_towards_the_mcp(monkeypatch) -> None:
    """Only an explicit choice may override the registered graph.

    Spectrum trades fidelity for speed (measured: 50s vs 105s sampling, softer
    detail), so it is user-switchable — but a caller that says nothing must get
    whatever the workflow ships with, not a value this layer invented."""
    from hivemind_content_studio import media_studio

    sent: list[dict] = []

    class Client:
        def call_tool(self, name, arguments, **_kwargs):
            sent.append(arguments)
            return {"content": [{"type": "text", "text": json.dumps({"id": "job-1"})}]}

    monkeypatch.setattr(media_studio, "_required_descriptor", _descriptor_for_check)
    monkeypatch.setattr(media_studio, "_client", lambda descriptor: Client())
    monkeypatch.setattr(media_studio, "_upload_image", lambda *a, **k: "ref.png")

    for choice in (None, True, False):
        sent.clear()
        with contextlib.suppress(Exception):
            media_studio.start_video(prompt="a lighthouse", spectrum=choice, duration_seconds=5)
        if not sent:
            continue
        if choice is None:
            assert "spectrum" not in sent[0], "silence must not override the workflow default"
        else:
            assert sent[0]["spectrum"] is choice


def test_steps_override_rides_the_params_record_to_the_mcp(monkeypatch) -> None:
    """The refinement setting (MiniMax H3 32-step preset) travels as
    params.steps — the MCP's registry-slot channel — and silence keeps the
    workflow's registered step count."""
    from hivemind_content_studio import media_studio

    sent: list[dict] = []

    class Client:
        def call_tool(self, name, arguments, **_kwargs):
            sent.append(arguments)
            return {"content": [{"type": "text", "text": json.dumps({"id": "job-1"})}]}

    monkeypatch.setattr(media_studio, "_required_descriptor", _descriptor_for_check)
    monkeypatch.setattr(media_studio, "_client", lambda descriptor: Client())
    monkeypatch.setattr(media_studio, "_upload_image", lambda *a, **k: "ref.png")

    for choice, expected in ((None, None), (32, {"steps": 32}), (0, None)):
        sent.clear()
        with contextlib.suppress(Exception):
            media_studio.start_video(prompt="a lighthouse", steps=choice, duration_seconds=5)
        if not sent:
            continue
        if expected is None:
            assert "params" not in sent[0], "no override must mean no params record"
        else:
            assert sent[0]["params"] == expected


def test_start_video_uploads_and_forwards_the_motion_context_clip(tmp_path: Path, monkeypatch) -> None:
    """Scene chaining: the previous clip uploads like any video input, but its
    gateway name travels as motion_context_path — never video_path, which would
    flip the LTX extension lane."""
    descriptor = MediaStudioDescriptor(
        app_id="test",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8788",
        auth_env_key=None,
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id="minimax-h3",
    )
    clip = tmp_path / "shot-1.mp4"
    clip.write_bytes(b"previous-clip")
    captured: dict = {}
    uploads: list[str] = []

    class Client:
        def call_tool(self, name, arguments, **_kwargs):
            # generate_video is start_video + finish_video now, and finish_video
            # only receives a job id, so it ALWAYS polls job_tool at least once.
            # Only the generate call's arguments are the ones under test — the
            # poll's {"id", "include_urls"} would otherwise clobber them.
            assert name in {descriptor.tool, descriptor.job_tool}
            if name == descriptor.tool:
                captured.update(arguments)
            return {
                "content": [{
                    "type": "text",
                    "text": json.dumps({"job": {"id": "job-chain", "status": "queued"}}),
                }],
            }

    def fake_upload_video(_descriptor, video):
        uploads.append(str(video))
        return "media-studio-input-chain.mp4"

    monkeypatch.setattr("hivemind_content_studio.media_studio._required_descriptor", lambda: descriptor)
    monkeypatch.setattr("hivemind_content_studio.media_studio._upload_video", fake_upload_video)
    monkeypatch.setattr("hivemind_content_studio.media_studio._client", lambda *_args: Client())

    started = start_video(
        motion_context_path=clip,
        prompt="the scene continues from the previous shot",
        duration_seconds=5,
    )

    assert uploads == [str(clip)]
    assert captured["motion_context_path"] == "media-studio-input-chain.mp4"
    assert "video_path" not in captured
    assert "video_mode" not in captured
    assert started["job_id"] == "job-chain"
    assert "media-studio-input-chain.mp4" in started["uploaded_names"]


def test_start_video_forwards_each_reference_video_with_its_canvas(tmp_path: Path, monkeypatch) -> None:
    """Reference mode: every motion clip goes to the MCP as {video_path,
    use_audio, canvas}. "compact" is the opt-in 384x1152 staging (a measured
    motion-only result); anything else — including an absent key, or the UI's
    own "full" — forwards as "full", the node's own reference canvas."""
    descriptor = MediaStudioDescriptor(
        app_id="test",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8788",
        auth_env_key=None,
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id="minimax-h3-reference",
    )
    walk = tmp_path / "walk.mp4"
    walk.write_bytes(b"walk")
    wave = tmp_path / "wave.mp4"
    wave.write_bytes(b"wave")
    nod = tmp_path / "nod.mp4"
    nod.write_bytes(b"nod")
    captured: dict = {}

    class Client:
        def call_tool(self, name, arguments, **_kwargs):
            assert name in {descriptor.tool, descriptor.job_tool}
            if name == descriptor.tool:
                captured.update(arguments)
            return {
                "content": [{
                    "type": "text",
                    "text": json.dumps({"job": {"id": "job-canvas", "status": "queued"}}),
                }],
            }

    monkeypatch.setattr("hivemind_content_studio.media_studio._required_descriptor", lambda: descriptor)
    monkeypatch.setattr("hivemind_content_studio.media_studio._upload_video", lambda _descriptor, video: f"up-{Path(video).name}")
    monkeypatch.setattr("hivemind_content_studio.media_studio._client", lambda *_args: Client())

    start_video(
        prompt="<Video 1> walks, <Video 2> waves, <Video 3> nods",
        reference_videos=[
            {"video_path": walk, "use_audio": True, "canvas": "compact"},
            {"video_path": wave, "use_audio": False, "canvas": "full"},
            {"video_path": nod},
        ],
        duration_seconds=5,
    )

    assert captured["reference_videos"] == [
        {"video_path": "up-walk.mp4", "use_audio": True, "canvas": "compact"},
        {"video_path": "up-wave.mp4", "use_audio": False, "canvas": "full"},
        {"video_path": "up-nod.mp4", "use_audio": False, "canvas": "full"},
    ]


def test_start_video_refuses_motion_context_plus_source_video(tmp_path: Path, monkeypatch) -> None:
    descriptor = MediaStudioDescriptor(
        app_id="test",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8788",
        auth_env_key=None,
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id="minimax-h3",
    )
    monkeypatch.setattr("hivemind_content_studio.media_studio._required_descriptor", lambda: descriptor)
    clip = tmp_path / "shot-1.mp4"
    clip.write_bytes(b"previous-clip")
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source-video")
    with pytest.raises(ValueError, match="cannot be combined"):
        start_video(
            motion_context_path=clip,
            video_path=source,
            prompt="x",
            duration_seconds=2,
        )


# Comfy's memory planner is blind to every reference row and the DynamicVRAM
# loader fills the card with the DiT, so what has to fit is the whole packed
# sequence: the clip, each motion clip at the node's OWN reference canvas plus
# its soundtrack, the pictures, the voice clips. Anchored 2026-08-21 on a rented
# 5090: a 10s clip at 1216x704 with a 13.3s phone reference (142,366 rows) ran
# out of memory three times, and the same with the reference trimmed to 4s
# (95,092 rows) thrashed and died at step 4. The studio publishes the ceiling so
# an impossible length is never offered; before it did, the run was accepted
# and died minutes later on an allocator dump.
def test_motion_reference_ceiling_matches_the_measured_card_limit():
    from hivemind_content_studio.media_studio import (
        _VIDEO_TIER_DIMENSIONS,
        _h3_packed_rows,
        motion_reference_duration_limits,
    )

    workflow = {
        "motion_reference_max_packed_rows": 85_000,
        "frame_grid": {"modulus": 17, "offset": 5},
        "defaults": {"frame_rate": 24},
    }
    limits = motion_reference_duration_limits(workflow)

    # The High canvas, both orientations: 124 frames with a reference as long
    # as the clip, nine pictures and a voice clip assumed alongside.
    assert limits["high|16:9"] == round(124 / 24, 3)
    assert limits["high|9:16"] == round(124 / 24, 3)
    # The native tier costs more per frame, so it buys less: 107 frames.
    assert limits["max|16:9"] == round(107 / 24, 3)
    # Every ceiling sits on the graph's own 17k+5 lattice — a cap that snapped
    # UP would name a length that does not actually fit.
    for seconds in limits.values():
        assert round(seconds * 24) % 17 == 5
    # ...and none of them exceeds the budget at its own canvas, priced the way
    # the MCP guard prices a run (reference as long as the clip, every picture
    # slot filled, the full voice allowance).
    for key, seconds in limits.items():
        tier, aspect = key.split("|")
        width, height = _VIDEO_TIER_DIMENSIONS[tier][aspect]
        frames = round(seconds * 24)
        rows = _h3_packed_rows(workflow["frame_grid"], 24, width, height, frames, reference_seconds=frames / 24)
        assert rows <= workflow["motion_reference_max_packed_rows"]
        # ...and the next lattice point would not fit, or the ceiling is the card's 15s.
        assert frames == 362 or _h3_packed_rows(
            workflow["frame_grid"], 24, width, height, frames + 17, reference_seconds=(frames + 17) / 24,
        ) > workflow["motion_reference_max_packed_rows"]
    # The native tier costs more per frame, so it buys less time.
    assert limits["max|16:9"] < limits["high|16:9"] < limits["standard|16:9"]


def test_motion_reference_ceiling_is_absent_without_a_measured_budget():
    from hivemind_content_studio.media_studio import motion_reference_duration_limits

    # An UNMEASURED card is not a card that cannot do it: with no budget the
    # studio must keep the full duration range rather than guess a ceiling.
    assert motion_reference_duration_limits({"frame_grid": {"modulus": 17, "offset": 5}}) == {}
    assert motion_reference_duration_limits({"motion_reference_max_packed_rows": 0}) == {}
    assert motion_reference_duration_limits({"motion_reference_max_packed_rows": "lots"}) == {}


def test_h3_reference_canvas_mirrors_the_node():
    """adapt_canvas() in comfy_extras/nodes_minimax_h3.py, plus its never-upscale
    rule: the reference is encoded at ITS OWN canvas, not the output's."""
    from hivemind_content_studio.media_studio import (
        _H3_REFERENCE_ROWS_PER_LATENT_FRAME_MAX,
        _h3_reference_canvas,
        _h3_rows_per_latent_frame,
    )

    # The phone clip that broke the old budget: staged 688x1496 lands on
    # 704x1504 — 1,034 rows per latent frame against 836 for a 1216x704 output.
    assert _h3_reference_canvas(688, 1496) == (704, 1504)
    assert _h3_rows_per_latent_frame(704, 1504) == 1034
    assert _h3_rows_per_latent_frame(1216, 704) == 836
    # Landscape and portrait HD land on the node's 768-short-edge canvas.
    assert _h3_reference_canvas(1354, 760) == (1344, 768)
    assert _h3_reference_canvas(760, 1354) == (768, 1344)
    # A source smaller than its canvas is never upscaled, only snapped to 32.
    assert _h3_reference_canvas(640, 480) == (640, 480)
    assert _h3_reference_canvas(1014, 1014) == (768, 768)
    # The pre-flight's worst case really is the worst: sweep aspect ratios at the
    # staging cap and nothing costs more than the constant it prices at.
    import math
    worst = 0
    for thousandths in range(125, 8001):
        ratio = thousandths / 1000
        height = math.sqrt(768 * 1344 / ratio)
        width, height = int(height * ratio / 2) * 2, int(height / 2) * 2
        canvas_w, canvas_h = _h3_reference_canvas(width, height)
        worst = max(worst, _h3_rows_per_latent_frame(canvas_w, canvas_h))
    assert worst == _H3_REFERENCE_ROWS_PER_LATENT_FRAME_MAX


def test_h3_packed_rows_prices_the_measured_jobs():
    """The formula reproduces the row counts the registry's measurement note
    quotes, so the budget and the pricing cannot drift apart unnoticed."""
    from hivemind_content_studio.media_studio import _h3_packed_rows

    grid = {"modulus": 17, "offset": 5}
    phone = 1034  # 704x1504 at the node
    # The job that exposed the old budget and ran out of memory twice: 10s at
    # 1216x704, seven pictures, the 13.3s soundtracked phone clip.
    assert _h3_packed_rows(grid, 24, 1216, 704, 240, reference_seconds=13.3, reference_rows_per_latent_frame=phone,
                           pictures=7, voice_seconds=0) == 142_366
    # The same job with the reference trimmed to 4s: it thrashed (73s a step)
    # and died at step 4, so the budget has to keep it out.
    from hivemind_content_studio.media_catalog import _H3_MOTION_REFERENCE_PACKED_ROWS
    trimmed = _h3_packed_rows(grid, 24, 1216, 704, 240, reference_seconds=4, reference_rows_per_latent_frame=phone,
                              pictures=7, voice_seconds=0)
    assert trimmed == 95_092
    assert trimmed > _H3_MOTION_REFERENCE_PACKED_ROWS
