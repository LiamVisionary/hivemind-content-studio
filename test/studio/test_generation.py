from __future__ import annotations

from pathlib import Path
import base64
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from hivemind_content_studio.generation import (
    build_higgsfield_consumer_command,
    build_muapi_submit_command,
    generate_higgsfield_cloud_asset,
    generate_higgsfield_consumer_asset,
    generate_muapi_asset,
    generate_openai_image_asset,
    generate_openai_oauth_image_asset,
    generate_xai_imagine_asset,
    record_generated_asset,
    require_paid_generation,
)


class _JsonResponse:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


def test_openai_gpt_image_uses_api_key_and_writes_base64_output(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "openai-secret")
    requests = []

    def opener(request, **_kwargs):
        requests.append(request)
        return _JsonResponse({"data": [{"b64_json": base64.b64encode(b"generated-image").decode("ascii")}], "created": 1})

    output = tmp_path / "gpt-image.png"
    result = generate_openai_image_asset(
        prompt="Product hero",
        model="gpt-image-2",
        aspect_ratio="9:16",
        output=output,
        confirm="PAID_GENERATE",
        opener=opener,
    )

    assert output.read_bytes() == b"generated-image"
    assert requests[0].full_url == "https://api.openai.com/v1/images/generations"
    assert requests[0].headers["Authorization"] == "Bearer openai-secret"
    assert result["provider"] == "openai-gpt-image"
    assert result["model"] == "gpt-image-2"


def test_openai_gpt_image_oauth_uses_hivemindos_bridge_and_writes_output(tmp_path: Path) -> None:
    calls: list[dict] = []

    def oauth_request(payload):
        calls.append(payload)
        return {"data": [{"b64_json": base64.b64encode(b"oauth-image").decode("ascii")}]}

    output = tmp_path / "gpt-image-oauth.png"
    result = generate_openai_oauth_image_asset(
        prompt="Product hero",
        model="gpt-image-2",
        aspect_ratio="9:16",
        quality="high",
        output=output,
        confirm="PAID_GENERATE",
        oauth_request=oauth_request,
    )

    assert calls == [{"action": "image-generate", "model": "gpt-image-2", "prompt": "Product hero", "aspectRatio": "9:16", "quality": "high"}]
    assert output.read_bytes() == b"oauth-image"
    assert result["provider"] == "openai-gpt-image-oauth"


def test_xai_imagine_api_supports_image_generation(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("XAI_API_KEY", "xai-secret")
    requests = []

    def opener(request, **_kwargs):
        requests.append(request)
        return _JsonResponse({"data": [{"b64_json": base64.b64encode(b"xai-image").decode("ascii")}], "usage": {"cost_in_usd_ticks": 200000000}})

    output = tmp_path / "xai.png"
    result = generate_xai_imagine_asset(
        kind="keyframe",
        auth_mode="api-key",
        prompt="Product hero",
        aspect_ratio="16:9",
        output=output,
        confirm="PAID_GENERATE",
        opener=opener,
    )

    assert output.read_bytes() == b"xai-image"
    assert requests[0].full_url == "https://api.x.ai/v1/images/generations"
    assert requests[0].headers["Authorization"] == "Bearer xai-secret"
    assert result["provider"] == "xai-imagine-api"
    assert result["model"] == "grok-imagine-image-quality"


def test_xai_oauth_video_uses_hivemindos_broker_and_polls_to_completion(tmp_path: Path) -> None:
    calls: list[dict] = []

    def oauth_request(payload):
        calls.append(payload)
        if payload["action"] == "video-generate":
            return {"request_id": "video-1"}
        return {"status": "done", "video": {"url": "https://cdn.example/video.mp4"}, "usage": {"cost_in_usd_ticks": 500000000}}

    def downloader(_url, destination):
        destination.write_bytes(b"generated-video")

    output = tmp_path / "xai.mp4"
    result = generate_xai_imagine_asset(
        kind="motion",
        auth_mode="oauth",
        prompt="Camera pushes into the product",
        aspect_ratio="9:16",
        output=output,
        confirm="PAID_GENERATE",
        duration_seconds=5,
        oauth_request=oauth_request,
        downloader=downloader,
        sleeper=lambda _seconds: None,
    )

    assert [call["action"] for call in calls] == ["video-generate", "video-status"]
    assert calls[1]["requestId"] == "video-1"
    assert result["provider"] == "xai-imagine-oauth"
    assert result["request_id"] == "video-1"
    assert output.read_bytes() == b"generated-video"


def test_higgsfield_consumer_commands_keep_image_and_motion_models_explicit(tmp_path: Path) -> None:
    image = build_higgsfield_consumer_command(
        kind="keyframe",
        model="gpt_image_2",
        prompt="Black-line character on white",
        aspect_ratio="9:16",
    )
    motion = build_higgsfield_consumer_command(
        kind="motion",
        model="kling3_0",
        prompt="Character points to the product",
        aspect_ratio="9:16",
        source=tmp_path / "first.png",
        duration_seconds=5,
    )

    assert image[:4] == ["higgsfield", "generate", "create", "gpt_image_2"]
    assert "--start-image" not in image
    assert motion[:4] == ["higgsfield", "generate", "create", "kling3_0"]
    assert motion[motion.index("--start-image") + 1] == str((tmp_path / "first.png").resolve())
    assert motion[motion.index("--duration") + 1] == "5"


def test_muapi_command_uses_the_bundled_helper_and_versioned_payload(tmp_path: Path) -> None:
    payload = tmp_path / "payload.json"
    payload.write_text("{}\n", encoding="utf-8")
    output = tmp_path / "out.mp4"

    command = build_muapi_submit_command(endpoint="kling-v2.6-pro-i2v", payload=payload, output=output, state=tmp_path / "state.json")

    assert command[0].endswith("python") or "python" in Path(command[0]).name
    assert "muapi_general.py" in command[1]
    assert command[command.index("--endpoint") + 1] == "kling-v2.6-pro-i2v"
    assert command[command.index("--download") + 1] == str(output.resolve())


def test_paid_generation_gate_is_shared_by_muapi_higgsfield_and_elevenlabs() -> None:
    with pytest.raises(ValueError, match="PAID_GENERATE"):
        require_paid_generation("")
    require_paid_generation("PAID_GENERATE")


def test_higgsfield_consumer_adapter_downloads_the_finished_asset(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_ALLOW_PRIVATE_GENERATION_DOWNLOADS", "true")
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.end_headers()
            self.wfile.write(b"\x89PNG\r\n\x1a\n" + b"frame" * 20)

        def log_message(self, _format: str, *_args) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    commands: list[list[str]] = []

    def runner(command, **_kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, stdout='[{"url":"http://127.0.0.1:%d/output.png"}]' % server.server_port, stderr="")

    try:
        output = tmp_path / "frame.png"
        result = generate_higgsfield_consumer_asset(
            kind="keyframe",
            model="gpt_image_2",
            prompt="A frame",
            aspect_ratio="9:16",
            output=output,
            confirm="PAID_GENERATE",
            runner=runner,
        )
    finally:
        server.shutdown()
        thread.join(timeout=5)

    assert commands[0][:4] == ["higgsfield", "generate", "create", "gpt_image_2"]
    assert Path(result["output"]).read_bytes().startswith(b"\x89PNG")


def test_muapi_adapter_runs_bundled_helper_and_requires_a_real_output(tmp_path: Path) -> None:
    payload = tmp_path / "payload.json"
    payload.write_text('{"prompt":"test"}\n', encoding="utf-8")
    output = tmp_path / "result.mp4"

    def runner(command, **_kwargs):
        output.write_bytes(b"media")
        return subprocess.CompletedProcess(command, 0, stdout='{"request_id":"req-1"}', stderr="")

    result = generate_muapi_asset(
        endpoint="kling-v2.6-pro-i2v",
        payload=payload,
        output=output,
        state=tmp_path / "state.json",
        confirm="PAID_GENERATE",
        runner=runner,
    )

    assert result["request_id"] == "req-1"
    assert result["output"] == str(output.resolve())


def test_higgsfield_cloud_adapter_uses_the_explicit_cloud_surface(tmp_path: Path, monkeypatch) -> None:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            assert self.headers["Authorization"] == "Key key-id:key-secret"
            self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"request_id":"cloud-1"}')

        def do_GET(self) -> None:  # noqa: N802
            if self.path.endswith("/status"):
                payload = '{"status":"completed","url":"http://127.0.0.1:%d/cloud.png"}' % self.server.server_port
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(payload.encode())
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.end_headers()
            self.wfile.write(b"\x89PNG\r\n\x1a\n" + b"cloud" * 20)

        def log_message(self, _format: str, *_args) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv("HIGGSFIELD_API_KEY_ID", "key-id")
        monkeypatch.setenv("HIGGSFIELD_API_KEY_SECRET", "key-secret")
        monkeypatch.setenv("HIGGSFIELD_CLOUD_BASE_URL", f"http://127.0.0.1:{server.server_port}")
        monkeypatch.setenv("CONTENT_STUDIO_ALLOW_PRIVATE_GENERATION_DOWNLOADS", "true")
        payload = tmp_path / "payload.json"
        payload.write_text('{"prompt":"cloud frame"}\n', encoding="utf-8")
        output = tmp_path / "cloud.png"

        result = generate_higgsfield_cloud_asset(
            model_id="higgsfield-ai/soul/standard",
            payload=payload,
            output=output,
            confirm="PAID_GENERATE",
            poll_interval_seconds=0.01,
        )
    finally:
        server.shutdown()
        thread.join(timeout=5)

    assert result["request_id"] == "cloud-1"
    assert output.read_bytes().startswith(b"\x89PNG")


def test_generation_download_rejects_private_provider_urls_by_default(tmp_path: Path) -> None:
    def runner(command, **_kwargs):
        return subprocess.CompletedProcess(command, 0, stdout='[{"url":"http://127.0.0.1:9/private.png"}]', stderr="")

    with pytest.raises(ValueError, match="public"):
        generate_higgsfield_consumer_asset(
            kind="keyframe",
            model="gpt_image_2",
            prompt="A frame",
            aspect_ratio="9:16",
            output=tmp_path / "frame.png",
            confirm="PAID_GENERATE",
            runner=runner,
        )


def test_generated_assets_are_attached_to_the_canonical_manifest(tmp_path: Path, monkeypatch) -> None:
    from hivemind_content_studio.manifest import load_manifest
    from hivemind_content_studio.planner import plan

    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: generated\nlane: first-frame-animation-ad\nscenes:\n  - beat: Hook\n", encoding="utf-8")
    manifest_path = plan(brief)
    output = tmp_path / "frame.png"
    output.write_bytes(b"generated")

    record_generated_asset(
        manifest_path,
        {"provider": "higgsfield-cloud", "model": "model-1", "request_id": "job-1", "output": str(output), "source_url": "https://example.com/frame.png"},
        role="keyframe",
        scene=1,
    )

    artifact = next(item for item in load_manifest(manifest_path)["artifacts"] if item["role"] == "keyframe")
    assert artifact["provider"] == "higgsfield-cloud"
    assert artifact["scene"] == 1
    assert artifact["job_id"] == "job-1"
    assert artifact["source_url"] == "https://example.com/frame.png"
