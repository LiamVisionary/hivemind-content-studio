from __future__ import annotations

import json
import urllib.error
from pathlib import Path

import pytest

from hivemind_content_studio.media_studio import (
    MediaStudioDescriptor,
    _private_video_url,
    _reachable,
    _token,
    discover_media_studio,
    generate_video,
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
        def call_tool(self, name, arguments):
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
    monkeypatch.setattr("hivemind_content_studio.media_studio._video_dimensions", lambda _path: (768, 768))

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
        def call_tool(self, name, arguments):
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
    monkeypatch.setattr("hivemind_content_studio.media_studio._video_dimensions", lambda _path: (768, 448))
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
        def call_tool(self, name, arguments):
            captured.update(arguments)
            assert name == descriptor.tool
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
        def call_tool(self, name, arguments):
            captured.update(arguments)
            assert name == descriptor.tool
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
        def call_tool(self, name, arguments):
            captured.update(arguments)
            assert name == descriptor.tool
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
        def call_tool(self, name, arguments):
            captured.update(arguments)
            assert name == descriptor.tool
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
