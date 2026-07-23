from __future__ import annotations

import base64
import io
import json
import time
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import _write_inline_video, build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import ENCRYPTED_PREFIX, OwnerAccess, PrivateFieldCipher, read_private_text
from hivemind_content_studio.run_store import RunStore


def _client(tmp_path: Path, monkeypatch) -> tuple[TestClient, ContentOrchestrator, ApprovalLedger]:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    approvals = ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret")
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    owner_access = OwnerAccess.for_testing(password="test-owner-password", cipher=cipher)
    app = build_control_app(
        orchestrator=orchestrator,
        approvals=approvals,
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=owner_access,
        private_cipher=cipher,
    )
    client = TestClient(app)
    response = client.post("/api/owner/unlock", json={"password": "test-owner-password"})
    assert response.status_code == 200
    return client, orchestrator, approvals


def test_inline_video_data_url_is_staged_with_video_suffix(tmp_path: Path) -> None:
    source = b"\x00\x00\x00\x18ftypisomvideo-data"
    encoded = base64.b64encode(source).decode("ascii")

    staged = _write_inline_video(f"data:video/mp4;base64,{encoded}", tmp_path)

    assert staged.suffix == ".mp4"
    assert staged.read_bytes() == source


def test_control_api_is_a_thin_run_viewer_with_owner_or_operator_mutations(tmp_path: Path, monkeypatch) -> None:
    client, orchestrator, _ = _client(tmp_path, monkeypatch)
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: api\nlane: static-text-ad\nscenes:\n  - overlay: Test\n", encoding="utf-8")
    run = orchestrator.execute_content_run(brief)

    assert client.get("/").status_code == 200
    response = client.get("/api/runs")
    assert response.status_code == 200
    assert response.json()["runs"][0]["run_id"] == run["run_id"]
    assert client.post("/api/owner/lock").status_code == 200
    assert client.post(f"/api/runs/{run['run_id']}/cancel", json={"reason": "stop"}).status_code == 401
    assert client.post("/api/owner/unlock", json={"password": "test-owner-password"}).status_code == 200
    owner_cancelled = client.post(f"/api/runs/{run['run_id']}/cancel", json={"reason": "stop"})
    assert owner_cancelled.status_code == 200
    assert owner_cancelled.json()["status"] == "cancelled"

    operator_run = orchestrator.execute_content_run(brief)
    assert client.post("/api/owner/lock").status_code == 200
    cancelled = client.post(
        f"/api/runs/{operator_run['run_id']}/cancel",
        json={"reason": "stop"},
        headers={"Authorization": "Bearer control-secret"},
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"


def test_generation_telemetry_endpoint_is_read_only_and_agent_safe(tmp_path: Path, monkeypatch) -> None:
    client, orchestrator, _ = _client(tmp_path, monkeypatch)
    brief = tmp_path / "telemetry.yaml"
    brief.write_text("id: api-telemetry\nlane: static-text-ad\nscenes:\n  - overlay: One\n", encoding="utf-8")
    run = orchestrator.execute_content_run(brief)
    orchestrator.store.append_event(run["run_id"], "generation.completed", {
        "telemetry_id": "gen-api",
        "intent": "generate_keyframes",
        "kind": "image",
        "provider": "static-text-renderer",
        "model": "automatic",
        "status": "completed",
        "duration_ms": 800,
        "artifact_count": 1,
        "estimated_cost_usd": 0,
        "charged_usd": 0,
    })

    response = client.get("/api/telemetry/generations")

    assert response.status_code == 200
    assert response.json()["summary"]["completed"] == 1
    assert response.json()["recent_attempts"][0]["run_id"] == run["run_id"]


def test_unified_runtime_endpoint_is_read_only_and_uses_the_canonical_snapshot(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.unified_runtime_snapshot",
        lambda: {
            "ok": True,
            "canonical_app": "hivemind-content-studio",
            "summary": {"online": 1, "offline": 0, "managed": 0, "misconfigured": 0, "total": 1},
            "surface": {"id": "studio", "status": "online"},
            "engines": [],
            "repositories": [],
        },
    )
    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.get("/api/runtime")

    assert response.status_code == 200
    assert response.json()["canonical_app"] == "hivemind-content-studio"
    assert response.json()["surface"]["status"] == "online"


def test_operator_can_decide_approvals_but_receipt_is_returned_only_after_auth(tmp_path: Path, monkeypatch) -> None:
    client, _, approvals = _client(tmp_path, monkeypatch)
    request = approvals.request(run_id="run-1", kind="paid-generation", provider="muapi", amount_usd=1, target="run-1:keyframe", reason="test")

    assert client.post(f"/api/approvals/{request['id']}/approve", json={"decided_by": "owner"}).status_code == 401
    approved = client.post(
        f"/api/approvals/{request['id']}/approve",
        json={"decided_by": "owner"},
        headers={"Authorization": "Bearer control-secret"},
    )
    assert approved.status_code == 200
    assert approved.json()["approval"]["token"].startswith("appr_")


def test_studio_shell_and_static_assets_are_served(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)

    page = client.get("/")

    assert page.status_code == 200
    assert 'id="studio-shell"' in page.text
    assert '/assets/studio.css' in page.text
    assert '/assets/studio.js' in page.text
    assert client.get("/assets/studio.css").headers["content-type"].startswith("text/css")
    assert "javascript" in client.get("/assets/studio.js").headers["content-type"]


def test_catalog_drives_lanes_and_provider_choices(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.get("/api/catalog")

    assert response.status_code == 200
    catalog = response.json()
    assert [lane["id"] for lane in catalog["lanes"]] == [
        "first-frame-animation-ad",
        "stickman-performance-ad",
        "static-text-ad",
        "animation",
        "faceless",
        "clip",
        "social-post",
    ]
    assert catalog["lanes"][0]["default_aspect_ratio"] == "9:16"
    assert catalog["lanes"][0]["supports"]["scenes"] is True
    assert {provider["id"] for provider in catalog["providers_by_role"]["image"]} >= {
        "comfyui",
        "hivemindos-hosted-media",
        "muapi",
    }
    assert catalog["platforms"] == ["instagram", "tiktok", "youtube", "facebook", "x", "linkedin"]


def test_simple_catalog_combines_safe_hivemind_brains_and_media_capabilities(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.brain_catalog",
        lambda: {"ok": True, "providers": [{"slug": "openai-codex", "name": "OpenAI", "models": [{"id": "gpt-5.4", "auth": "oauth"}]}]},
    )
    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.get("/api/simple/catalog")

    assert response.status_code == 200
    catalog = response.json()
    assert catalog["brains"][0]["models"][0]["id"] == "gpt-5.4"
    assert catalog["attachment_intake_limit"] == 30
    gpt_image = next(item for item in catalog["media"]["image"] if item["id"] == "openai-gpt-image")
    assert next(model for model in gpt_image["models"] if model["id"] == "gpt-image-1.5")["max_reference_images"] == 16
    media_studio = next(item for item in catalog["media"]["video"] if item["id"] == "media-studio-mcp")
    assert {model["id"] for model in media_studio["models"]} >= {"ltx23-eros-fast", "ltx23-eros-exact"}
    assert next(model for model in media_studio["models"] if model["id"] == "ltx23-eros-fast")["label"] == "LTX 2.3 Eros Fast"
    seedance = next(item for item in catalog["media"]["video"] if item["id"] == "muapi")
    assert next(model for model in seedance["models"] if model["id"] == "seedance-v2.0-t2v")["max_reference_images"] is None
    assert any(template["id"] == "ugc-product-ad-15s" for template in catalog["templates"])


def test_unified_tool_surfaces_are_discoverable_without_checkout_paths(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.get("/api/surfaces")

    assert response.status_code == 200
    surfaces = response.json()["surfaces"]
    assert surfaces["explore"]["path"].startswith("/open-gen/?build=")
    assert surfaces["canvas"]["gateway_path"] == "/mobile/"
    assert surfaces["models"]["gateway_path"] == "/models"
    assert isinstance(surfaces["explore"]["available"], bool)
    assert "/Users/" not in response.text


def test_media_studio_video_is_owner_visible_but_machine_callers_receive_only_a_receipt(tmp_path: Path, monkeypatch) -> None:
    captured: dict = {}
    output_path = tmp_path / "generated" / "media-studio" / "mock-ltx.mp4"

    def fake_generate(**kwargs):
        captured.update(kwargs)
        image_path = Path(kwargs["image_path"])
        assert image_path.is_file()
        output_dir = Path(kwargs["output_dir"])
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"mock-video")
        qa_frame = output_dir / "qa" / "mock.jpg"
        qa_frame.parent.mkdir(parents=True, exist_ok=True)
        qa_frame.write_bytes(b"private-qa-frame")
        return {
            "job_id": "job-123",
            "provider": "Media Studio",
            "output": str(output_path),
            "prompt": "secret prompt echo",
            "qa": {"ok": True, "video": str(output_path), "representative_frame": str(qa_frame)},
        }

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video", fake_generate)
    client, _, _ = _client(tmp_path, monkeypatch)
    image = Image.new("RGB", (16, 16), "white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    request_body = {
        "prompt": "slow push in",
        "workflow_id": "ltx23-regular-fp8",
        "image_base64": f"data:image/png;base64,{encoded}",
        "duration_seconds": 2,
        "loras": [{"id": "ltx/style.safetensors", "strength": 0.8}],
    }

    response = client.post(
        "/api/media-studio/video",
        json=request_body,
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["url"] == "/api/media-studio/generated/mock-ltx.mp4"
    assert payload["output"] == "mock-ltx.mp4"
    assert payload["encrypted_at_rest"] is True
    assert "video" not in payload["qa"]
    assert "representative_frame" not in payload["qa"]
    assert "prompt" not in payload
    assert "slow push in" not in response.text
    assert "secret prompt echo" not in response.text
    assert str(output_path) not in response.text
    assert captured["workflow_id"] == "ltx23-regular-fp8"
    assert captured["duration_seconds"] == 2
    assert captured["loras"] == [{"id": "ltx/style.safetensors", "strength": 0.8}]
    assert not Path(captured["image_path"]).exists()
    assert not (output_path.parent / "qa" / "mock.jpg").exists()
    assert not output_path.exists()
    assert output_path.with_name("mock-ltx.mp4.zenc").is_file()
    assert b"mock-video" not in output_path.with_name("mock-ltx.mp4.zenc").read_bytes()
    media = client.get(payload["url"])
    assert media.status_code == 200
    assert media.content == b"mock-video"
    assert media.headers["cache-control"] == "private, no-store"
    partial = client.get(payload["url"], headers={"Range": "bytes=0-3"})
    assert partial.status_code == 206
    assert partial.content == b"mock"
    assert client.post("/api/owner/lock").status_code == 200
    machine = client.post(
        "/api/media-studio/video",
        json=request_body,
        headers={"Authorization": "Bearer control-secret"},
    )

    assert machine.status_code == 200
    machine_payload = machine.json()
    assert machine_payload["job_id"] == "job-123"
    assert machine_payload["privacy"] == "machine-redacted"
    assert machine_payload["prompts_redacted"] is True
    assert machine_payload["media_redacted"] is True
    for forbidden in ("url", "media_url", "output", "qa", "encrypted_at_rest", "slow push in", "secret prompt echo", "mock-ltx.mp4"):
        assert forbidden not in machine.text

    failed_input: dict = {}

    def fail_generate(**kwargs):
        failed_input.update(kwargs)
        raise RuntimeError(f"private prompt failed near {output_path}")

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video", fail_generate)
    failed = client.post(
        "/api/media-studio/video",
        json=request_body,
        headers={"Authorization": "Bearer control-secret"},
    )
    assert failed.status_code == 503
    assert failed.json()["detail"] == "Media generation failed"
    assert "private prompt" not in failed.text
    assert str(output_path) not in failed.text
    assert not Path(failed_input["image_path"]).exists()

    guessed_url = "/api/media-studio/generated/mock-ltx.mp4"
    assert client.get(guessed_url, headers={"Authorization": "Bearer control-secret"}).status_code == 401
    assert client.post("/api/owner/unlock", json={"password": "test-owner-password"}).status_code == 200
    assert client.get(guessed_url).content == b"mock-video"


def test_media_studio_video_job_flow_survives_long_generations(tmp_path: Path, monkeypatch) -> None:
    output_path = tmp_path / "generated" / "media-studio" / "mock-eros.mp4"
    started: dict = {}
    finish_calls: dict = {}

    def fake_start(**kwargs):
        started.update(kwargs)
        assert Path(kwargs["image_path"]).is_file()
        return {"job_id": "job-eros-1", "uploaded_names": ["input-1.png"], "provider": "Media Studio"}

    def fake_finish(job_id, *, uploaded_names=None, output_dir=None, **_):
        finish_calls.update({"job_id": job_id, "uploaded_names": uploaded_names})
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"mock-video")
        return {"job_id": job_id, "provider": "Media Studio", "output": str(output_path), "qa": {"ok": True}}

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video_start", fake_start)
    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video_finish", fake_finish)
    check_calls = {"count": 0}

    def fake_check(job_id):
        check_calls["count"] += 1
        if check_calls["count"] <= 2:
            return {"status": "running", "failed": False, "error": "", "video_url": "", "progress": 0.4}
        return {"status": "completed", "failed": False, "error": "", "video_url": "http://gateway/video.mp4", "progress": 1.0}

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video_check", fake_check)
    client, _, _ = _client(tmp_path, monkeypatch)
    image = Image.new("RGB", (16, 16), "white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")

    queued = client.post(
        "/api/media-studio/video/start",
        json={
            "prompt": "slow push in",
            "workflow_id": "ltx23-eros-fast",
            "image_base64": f"data:image/png;base64,{encoded}",
            "duration_seconds": 2,
            "resolution": "high",
        },
    )
    assert queued.status_code == 200
    assert queued.json() == {"ok": True, "job_id": "job-eros-1", "status": "running"}
    # The staged control-api input copy is removed as soon as the job is queued.
    assert not Path(started["image_path"]).exists()

    payload: dict = {}
    for _ in range(100):
        poll = client.get("/api/media-studio/video/job/job-eros-1")
        assert poll.status_code == 200
        payload = poll.json()
        if payload.get("status") != "running":
            break
        time.sleep(0.05)
    assert payload["ok"] is True
    assert payload["url"] == "/api/media-studio/generated/mock-eros.mp4"
    assert payload["output"] == "mock-eros.mp4"
    assert payload["encrypted_at_rest"] is True
    assert finish_calls == {"job_id": "job-eros-1", "uploaded_names": ["input-1.png"]}
    assert "slow push in" not in poll.text
    # The sealed result stays retrievable on later polls (browser may re-ask).
    assert client.get("/api/media-studio/video/job/job-eros-1").json()["output"] == "mock-eros.mp4"
    assert client.get("/api/media-studio/video/job/unknown-job").status_code == 404
    media = client.get(payload["url"])
    assert media.status_code == 200
    assert media.content == b"mock-video"


def test_simple_catalog_serves_cached_payload_instead_of_reprobing(tmp_path: Path, monkeypatch) -> None:
    calls = {"count": 0}

    def fake_brain_catalog(**_):
        calls["count"] += 1
        return {"ok": True, "providers": [{"slug": "probe", "name": "Probe", "models": []}]}

    monkeypatch.setattr("hivemind_content_studio.control_api.brain_catalog", fake_brain_catalog)
    client, _, _ = _client(tmp_path, monkeypatch)

    first = client.get("/api/simple/catalog")
    assert first.status_code == 200
    assert first.json()["brains"][0]["slug"] == "probe"
    probes_after_first = calls["count"]
    assert probes_after_first >= 1
    # Within the TTL, repeat opens are served from the cache — the studio's
    # model UI must not wait on live provider probes every page load.
    second = client.get("/api/simple/catalog")
    assert second.status_code == 200
    assert calls["count"] == probes_after_first


def test_media_studio_detects_e2e_envelope_downloads(tmp_path: Path) -> None:
    from hivemind_content_studio.media_studio import _looks_like_e2e_envelope

    envelope = tmp_path / "clip.mp4"
    envelope.write_text(json.dumps({"v": 1, "wrapped_dek": "aa", "ciphertext": "bb", "media_type": "video/mp4"}))
    assert _looks_like_e2e_envelope(envelope) is True
    real = tmp_path / "real.mp4"
    real.write_bytes(b"\x00\x00\x00\x18ftypisom-not-json")
    assert _looks_like_e2e_envelope(real) is False
    other_json = tmp_path / "meta.mp4"
    other_json.write_text(json.dumps({"anything": "else"}))
    assert _looks_like_e2e_envelope(other_json) is False


def test_media_studio_video_job_flow_returns_gateway_proxy_for_e2e_sealed_outputs(tmp_path: Path, monkeypatch) -> None:
    def fake_start(**kwargs):
        return {"job_id": "job-e2e-1", "uploaded_names": [], "provider": "Media Studio"}

    def fake_finish(job_id, **_):
        # finish_video detected the sealed envelope: no local copy, no QA — it
        # hands back the gateway output name for browser-side decryption.
        return {
            "job_id": job_id,
            "provider": "Media Studio",
            "gateway_output": "mlx_ltx23_eros_job_121f.mp4",
            "qa": {"ok": True, "visual_inspection_required": True},
        }

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video_start", fake_start)
    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video_finish", fake_finish)
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.run_media_studio_video_check",
        lambda job_id: {"status": "completed", "failed": False, "error": "", "video_url": "http://gw/x.mp4", "progress": 1.0},
    )
    monkeypatch.setattr(
        "hivemind_content_studio.canvas_history.CanvasGatewayClient.media",
        lambda self, name: (b'{"ciphertext":"sealed","wrapped_dek":"sealed"}', "application/vnd.hivemind.e2e+json"),
    )
    client, _, _ = _client(tmp_path, monkeypatch)
    image = Image.new("RGB", (16, 16), "white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")

    queued = client.post(
        "/api/media-studio/video/start",
        json={"prompt": "high res", "workflow_id": "ltx23-eros-fast", "image_base64": f"data:image/png;base64,{encoded}", "resolution": "high"},
    )
    assert queued.status_code == 200

    payload: dict = {}
    for _ in range(100):
        poll = client.get("/api/media-studio/video/job/job-e2e-1")
        assert poll.status_code == 200
        payload = poll.json()
        if payload.get("status") != "running":
            break
        time.sleep(0.05)
    assert payload["ok"] is True
    assert payload["url"] == "/api/media-studio/gateway/mlx_ltx23_eros_job_121f.mp4"
    assert payload["encrypted_at_rest"] is True
    assert payload["output"] == "mlx_ltx23_eros_job_121f.mp4"

    media = client.get(payload["url"])
    assert media.status_code == 200
    assert media.headers["content-type"].startswith("application/vnd.hivemind.e2e+json")
    assert media.content.startswith(b'{"ciphertext"')
    assert media.headers["cache-control"] == "private, no-store"


def test_media_studio_ingredients_rehydrates_encrypted_reference_views_without_timeline_input(tmp_path: Path, monkeypatch) -> None:
    captured: dict = {}
    output_path = tmp_path / "generated" / "media-studio" / "ingredients.mp4"

    def fake_generate(**kwargs):
        captured.update(kwargs)
        assert kwargs["image_path"] is None
        assert kwargs["video_path"] is None
        assert len(kwargs["ingredient_images"]) == 2
        assert all(Path(item["image_path"]).is_file() for item in kwargs["ingredient_images"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"ingredients-video")
        return {"job_id": "ingredients-job", "output": str(output_path), "qa": {"ok": True}}

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video", fake_generate)
    client, _, _ = _client(tmp_path, monkeypatch)

    references = []
    for filename, color in (("front.png", "red"), ("profile.png", "blue")):
        buffer = io.BytesIO()
        Image.new("RGB", (32, 32), color).save(buffer, format="PNG")
        upload = client.post(
            "/api/media-studio/references",
            files={"file": (filename, buffer.getvalue(), "image/png")},
        )
        assert upload.status_code == 200
        assert upload.json()["encrypted_at_rest"] is True
        references.append(upload.json()["url"])

    response = client.post(
        "/api/media-studio/video",
        json={
            "workflow_id": "ltx23-ic-ingredients-lora",
            "prompt": "The same character turns toward camera.",
            "ingredient_images": [
                {"image_reference": references[0], "description": "front view"},
                {"image_reference": references[1], "description": "right profile"},
            ],
        },
    )

    assert response.status_code == 200, response.text
    assert captured["workflow_id"] == "ltx23-ic-ingredients-lora"
    assert [item["description"] for item in captured["ingredient_images"]] == ["front view", "right profile"]
    assert all(not Path(item["image_path"]).exists() for item in captured["ingredient_images"])


def test_media_studio_ingredients_rehydrates_start_frame_and_views_together(tmp_path: Path, monkeypatch) -> None:
    captured: dict = {}
    output_path = tmp_path / "generated" / "media-studio" / "ingredients-start.mp4"

    def fake_generate(**kwargs):
        captured.update(kwargs)
        assert Path(kwargs["image_path"]).is_file()
        assert len(kwargs["ingredient_images"]) == 2
        assert all(Path(item["image_path"]).is_file() for item in kwargs["ingredient_images"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"ingredients-start-video")
        return {"job_id": "ingredients-start-job", "output": str(output_path), "qa": {"ok": True}}

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video", fake_generate)
    client, _, _ = _client(tmp_path, monkeypatch)

    references = []
    for filename, color in (("start.png", "green"), ("front.png", "red"), ("profile.png", "blue")):
        buffer = io.BytesIO()
        Image.new("RGB", (32, 32), color).save(buffer, format="PNG")
        upload = client.post(
            "/api/media-studio/references",
            files={"file": (filename, buffer.getvalue(), "image/png")},
        )
        assert upload.status_code == 200
        references.append(upload.json()["url"])

    response = client.post(
        "/api/media-studio/video",
        json={
            "workflow_id": "ltx23-ic-ingredients-lora",
            "prompt": "The same character turns toward camera.",
            "image_reference": references[0],
            "ingredient_images": [
                {"image_reference": references[1], "description": "front view"},
                {"image_reference": references[2], "description": "right profile"},
            ],
        },
    )

    assert response.status_code == 200, response.text
    assert captured["workflow_id"] == "ltx23-ic-ingredients-lora"
    assert not Path(captured["image_path"]).exists()
    assert all(not Path(item["image_path"]).exists() for item in captured["ingredient_images"])
    for reference in references:
        encrypted = tmp_path / "uploads" / "media-studio-references" / f"{Path(reference).name}.zenc"
        assert encrypted.is_file()


def test_media_studio_ingredients_preview_uses_encrypted_views_and_the_generation_compositor(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)
    references = []
    for filename, color in (("front.png", "red"), ("profile.png", "blue")):
        buffer = io.BytesIO()
        Image.new("RGB", (32, 32), color).save(buffer, format="PNG")
        upload = client.post(
            "/api/media-studio/references",
            files={"file": (filename, buffer.getvalue(), "image/png")},
        )
        assert upload.status_code == 200
        references.append(upload.json()["url"])

    response = client.post(
        "/api/media-studio/ingredients/preview",
        json={
            "ingredient_images": [
                {"image_reference": references[0]},
                {"image_reference": references[1]},
            ],
        },
    )

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-ingredients-columns"] == "2"
    assert response.headers["x-ingredients-rows"] == "1"
    assert response.headers["x-ingredients-width"] == "768"
    assert response.headers["x-ingredients-height"] == "448"
    with Image.open(io.BytesIO(response.content)) as sheet:
        assert sheet.size == (768, 448)
        assert sheet.getpixel((198, 224)) == (255, 0, 0)
        assert sheet.getpixel((570, 224)) == (0, 0, 255)
        assert sheet.getpixel((384, 224)) == (0, 0, 0)
    staged_root = tmp_path / "uploads" / "media-studio"
    assert list(staged_root.glob("*")) == []

    assert client.post("/api/owner/lock").status_code == 200
    assert client.post(
        "/api/media-studio/ingredients/preview",
        json={"ingredient_images": [{"image_reference": references[0]}]},
    ).status_code == 401


def test_encrypted_media_reference_survives_reload_and_is_staged_only_for_generation(tmp_path: Path, monkeypatch) -> None:
    captured: dict = {}
    output_path = tmp_path / "generated" / "media-studio" / "reference-video.mp4"

    def fake_generate(**kwargs):
        captured.update(kwargs)
        image_path = Path(kwargs["image_path"])
        captured["image_bytes"] = image_path.read_bytes()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"reference-video")
        return {
            "job_id": "reference-job",
            "provider": "Media Studio",
            "output": str(output_path),
            "qa": {"ok": True},
        }

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video", fake_generate)
    client, _, _ = _client(tmp_path, monkeypatch)
    image = Image.new("RGB", (16, 16), "pink")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    source = buffer.getvalue()

    uploaded = client.post(
        "/api/media-studio/references",
        files={"file": ("start.png", source, "image/png")},
    )

    assert uploaded.status_code == 200
    upload_payload = uploaded.json()
    assert upload_payload["encrypted_at_rest"] is True
    reference_url = upload_payload["url"]
    assert reference_url.startswith("/api/media-studio/references/reference-")
    reference_path = tmp_path / "uploads" / "media-studio-references" / Path(reference_url).name
    encrypted_path = reference_path.with_name(f"{reference_path.name}.zenc")
    assert not reference_path.exists()
    assert encrypted_path.is_file()
    assert source not in encrypted_path.read_bytes()

    restored = client.get(reference_url)
    assert restored.status_code == 200
    assert restored.content == source
    assert restored.headers["cache-control"] == "private, no-store"
    assert restored.headers["x-content-type-options"] == "nosniff"

    generated = client.post(
        "/api/media-studio/video",
        json={
            "prompt": "subtle motion",
            "workflow_id": "ltx23-regular-fast",
            "image_reference": reference_url,
            "duration_seconds": 2,
        },
    )

    assert generated.status_code == 200
    assert generated.json()["url"] == "/api/media-studio/generated/reference-video.mp4"
    assert captured["image_bytes"] == source
    assert not Path(captured["image_path"]).exists()
    assert not reference_path.exists()
    assert encrypted_path.is_file()

    assert client.post("/api/owner/lock").status_code == 200
    assert client.get(reference_url).status_code == 401
    machine = client.post(
        "/api/media-studio/video",
        json={
            "prompt": "subtle motion",
            "workflow_id": "ltx23-regular-fast",
            "image_reference": reference_url,
            "duration_seconds": 2,
        },
        headers={"Authorization": "Bearer control-secret"},
    )
    assert machine.status_code == 403

    assert client.post("/api/owner/unlock", json={"password": "test-owner-password"}).status_code == 200
    assert client.delete(reference_url).status_code == 200
    assert not encrypted_path.exists()
    assert client.get(reference_url).status_code == 404


def test_encrypted_video_reference_flows_directly_into_extension_generation(tmp_path: Path, monkeypatch) -> None:
    captured: dict = {}
    output_path = tmp_path / "generated" / "media-studio" / "extension.mp4"

    def fake_generate(**kwargs):
        captured.update(kwargs)
        captured["video_bytes"] = Path(kwargs["video_path"]).read_bytes()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"extended-video")
        return {"job_id": "extension-job", "output": str(output_path), "qa": {"ok": True}}

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video", fake_generate)
    client, _, _ = _client(tmp_path, monkeypatch)
    source = b"\x00\x00\x00\x18ftypisomvideo-reference"
    uploaded = client.post(
        "/api/media-studio/references",
        files={"file": ("source.mp4", source, "video/mp4")},
    )
    assert uploaded.status_code == 200
    reference_url = uploaded.json()["url"]

    generated = client.post(
        "/api/media-studio/video",
        json={
            "prompt": "continue naturally",
            "workflow_id": "ltx23-regular-fast",
            "video_reference": reference_url,
            "video_mode": "extend",
            "duration_seconds": 3,
        },
    )

    assert generated.status_code == 200
    assert captured["video_bytes"] == source
    assert captured["image_path"] is None
    assert captured["video_mode"] == "extend"
    assert not Path(captured["video_path"]).exists()
    encrypted_path = tmp_path / "uploads" / "media-studio-references" / f"{Path(reference_url).name}.zenc"
    assert encrypted_path.is_file()


def test_simple_catalog_falls_back_to_the_builtin_local_planner(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.brain_catalog",
        lambda: (_ for _ in ()).throw(RuntimeError("HivemindOS unavailable")),
    )
    client, _, _ = _client(tmp_path, monkeypatch)

    catalog = client.get("/api/simple/catalog").json()

    assert catalog["brains"][0]["slug"] == "local-planner"
    assert catalog["brains"][0]["models"][0]["auth"] == "local"
    assert catalog["brain_error"] == "HivemindOS unavailable"


def test_builtin_local_planner_creates_a_confirmable_draft_and_keeps_media_routes(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.post(
        "/api/simple/plan",
        json={
            "prompt": "Animate a product reveal with a slow push-in",
            "provider": "local-planner",
            "model": "deterministic-v1",
            "auth": "local",
            "studioMode": "animate",
            "imageSelection": {"provider": "comfyui", "model": "automatic"},
            "videoSelection": {"provider": "xai-imagine-api", "model": "grok-imagine-video"},
        },
    )

    assert response.status_code == 200
    plan = response.json()["plan"]
    assert plan["mode"] == "confirmation"
    assert plan["planner"] == "local-planner:deterministic-v1"
    assert plan["draft"]["lane"] == "animation"
    assert plan["draft"]["providers"] == {"keyframe": "comfyui", "motion": "xai-imagine-api"}
    assert plan["draft"]["provider_options"]["xai-imagine-api"]["motion"]["model"] == "grok-imagine-video"


def test_template_catalog_endpoint_serves_composer_ready_templates(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.get("/api/templates")

    assert response.status_code == 200
    templates = response.json()["templates"]
    assert len(templates) >= 11
    reference = next(template for template in templates if template["id"] == "ugc-character-reference")
    assert reference["category"] == "ugc"
    assert "no AI-aesthetic styling" in reference["prompt"]
    assert all(template["lane"] and template["prompt"] for template in templates)


def test_simple_brain_plan_is_proxied_without_browser_credentials(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.plan_with_brain",
        lambda payload: {"mode": "confirmation", "message": "Review this plan", "draft": {"lane": "static-text-ad", "title": payload["prompt"]}},
    )
    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.post(
        "/api/simple/plan",
        json={
            "prompt": "A direct launch ad",
            "provider": "openai-codex",
            "model": "gpt-5.4",
            "auth": "oauth",
            "promptHelper": False,
            "walkthrough": True,
            "imageSelection": {"provider": "openai-gpt-image-oauth", "model": "gpt-image-2"},
            "videoSelection": {"provider": "automatic", "model": "automatic"},
        },
    )

    assert response.status_code == 200
    plan = response.json()["plan"]
    assert plan["mode"] == "confirmation"
    assert plan["selections"]["image"]["model"] == "gpt-image-2"
    assert plan["composer"] == {
        "studioMode": "create",
        "brain": {"provider": "openai-codex", "model": "gpt-5.4", "auth": "oauth"},
        "imageSelection": {"provider": "openai-gpt-image-oauth", "model": "gpt-image-2"},
        "videoSelection": {"provider": "automatic", "model": "automatic"},
        "promptHelper": False,
        "walkthrough": True,
    }
    assert "token" not in response.text.lower()


def test_simple_plan_preserves_the_native_studio_mode_and_rejects_unknown_modes(tmp_path: Path, monkeypatch) -> None:
    seen: dict = {}

    def fake_plan(payload: dict) -> dict:
        seen.update(payload)
        return {"mode": "questions", "message": "Describe the edit", "questions": ["What should change?"]}

    monkeypatch.setattr("hivemind_content_studio.control_api.plan_with_brain", fake_plan)
    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.post(
        "/api/simple/plan",
        json={
            "prompt": "Replace the background with a studio set",
            "provider": "openai-codex",
            "model": "gpt-5.4",
            "studioMode": "edit",
        },
    )

    assert response.status_code == 200
    assert seen["studioMode"] == "edit"
    assert response.json()["plan"]["composer"]["studioMode"] == "edit"
    invalid = client.post(
        "/api/simple/plan",
        json={"prompt": "test", "provider": "openai-codex", "model": "gpt-5.4", "studioMode": "separate-app"},
    )
    assert invalid.status_code == 422


def test_simple_plan_preserves_seed_value_and_mode_in_composer_and_provider_options(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.plan_with_brain",
        lambda payload: {
            "mode": "confirmation",
            "message": "Review",
            "draft": {"lane": "static-text-ad", "title": payload["prompt"]},
        },
    )
    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.post(
        "/api/simple/plan",
        json={
            "prompt": "Recreate this setup",
            "provider": "openai-codex",
            "model": "gpt-5.4",
            "seed": 8675309,
            "seedMode": "randomize",
        },
    )

    assert response.status_code == 200
    plan = response.json()["plan"]
    assert plan["composer"]["seed"] == 8675309
    assert plan["composer"]["seedMode"] == "randomize"
    assert plan["draft"]["provider_options"]["_studio_generation"] == {
        "seed": 8675309,
        "seed_mode": "randomize",
    }


def test_simple_run_retains_ordered_reference_images_in_the_canonical_manifest(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)
    first = tmp_path / "first.png"
    last = tmp_path / "last.png"
    Image.new("RGB", (32, 32), "red").save(first)
    Image.new("RGB", (32, 32), "blue").save(last)
    plan = {
        "mode": "brief",
        "brain": {"provider": "openai-codex", "model": "gpt-5.4", "auth": "oauth"},
        "draft": {
            "lane": "first-frame-animation-ad",
            "title": "Ordered references",
            "concept": "Animate from the first image toward the final image.",
            "providers": {"image": "openai-gpt-image-oauth", "motion": "media-studio-mcp"},
            "provider_options": {"openai-gpt-image-oauth": {"model": "gpt-image-2"}},
            "scenes": [{"title": "Transition", "beat": "Move between references", "duration_seconds": 4}],
        },
    }

    response = client.post(
        "/api/simple/runs",
        data={"plan_json": __import__("json").dumps(plan)},
        files=[
            ("images", ("first.png", first.read_bytes(), "image/png")),
            ("images", ("last.png", last.read_bytes(), "image/png")),
        ],
    )

    assert response.status_code == 201, response.text
    run = response.json()
    references = [item for item in run["artifact_records"] if item["role"].startswith("reference-")]
    assert [(item["role"], item["scene"]) for item in references] == [
        ("reference-start-frame", 1),
        ("reference-end-frame", 2),
    ]
    assert run["brief"]["provider_options"]["openai-gpt-image-oauth"]["model"] == "gpt-image-2"


def test_simple_run_can_reuse_scoped_reference_artifacts_without_browser_reupload(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)
    first = tmp_path / "first.png"
    last = tmp_path / "last.png"
    Image.new("RGB", (32, 32), "red").save(first)
    Image.new("RGB", (32, 32), "blue").save(last)
    plan = {
        "mode": "brief",
        "brain": {"provider": "openai-codex", "model": "gpt-5.4", "auth": "oauth"},
        "draft": {
            "lane": "static-text-ad",
            "title": "Reusable references",
            "concept": "Retain the supplied references for another variant.",
            "scenes": [{"title": "One", "beat": "Use both references", "duration_seconds": 4}],
        },
    }
    first_response = client.post(
        "/api/simple/runs",
        data={"plan_json": __import__("json").dumps(plan)},
        files=[
            ("images", ("first.png", first.read_bytes(), "image/png")),
            ("images", ("last.png", last.read_bytes(), "image/png")),
        ],
    )
    assert first_response.status_code == 201, first_response.text
    first_run = first_response.json()
    original_references = [item for item in first_run["artifact_records"] if item["role"].startswith("reference-")]

    reused_plan = {
        **plan,
        "reference_artifacts": [
            {"run_id": first_run["run_id"], "artifact_id": item["id"]}
            for item in original_references
        ],
    }
    second_response = client.post(
        "/api/simple/runs",
        data={"plan_json": __import__("json").dumps(reused_plan)},
    )

    assert second_response.status_code == 201, second_response.text
    reused_references = [
        item for item in second_response.json()["artifact_records"]
        if item["role"].startswith("reference-")
    ]
    assert [item["role"] for item in reused_references] == ["reference-start-frame", "reference-end-frame"]
    assert [item["sha256"] for item in reused_references] == [item["sha256"] for item in original_references]
    assert [item["path"] for item in reused_references] != [item["path"] for item in original_references]


def test_simple_run_rejects_reuse_of_a_non_reference_artifact(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)
    plan = {
        "mode": "brief",
        "draft": {
            "lane": "static-text-ad",
            "title": "Scoped artifact reuse",
            "concept": "Only prior reference images may be reused.",
            "scenes": [{"title": "One", "beat": "Keep scope narrow", "duration_seconds": 4}],
        },
    }
    first_response = client.post(
        "/api/simple/runs",
        data={"plan_json": __import__("json").dumps(plan)},
    )
    assert first_response.status_code == 201, first_response.text
    first_run = first_response.json()
    brief = next(item for item in first_run["artifact_records"] if item["role"] == "brief")
    plan["reference_artifacts"] = [{"run_id": first_run["run_id"], "artifact_id": brief["id"]}]

    response = client.post(
        "/api/simple/runs",
        data={"plan_json": __import__("json").dumps(plan)},
    )

    assert response.status_code == 400
    assert "reference image" in response.text.lower()


def test_simple_studio_draft_creates_a_durable_run(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.post(
        "/api/runs",
        json={
            "lane": "static-text-ad",
            "title": "One idea people remember",
            "concept": "A plain text ad contrasting polish with clarity.",
            "audience": "DTC founders",
            "goal": "Test message clarity",
            "scenes": [
                {
                    "title": "Hook",
                    "beat": "Make the simple version impossible to miss.",
                    "overlay": "Your ad does not need to look expensive.",
                    "duration_seconds": 4,
                }
            ],
        },
    )

    assert response.status_code == 201
    run = response.json()
    assert run["lane"] == "static-text-ad"
    assert run["brief"]["title"] == "One idea people remember"
    assert run["brief"]["concept"].startswith("A plain text ad")
    assert run["policy"]["privacy"] == "local-first"
    assert run["cost"]["max_cost_usd"] == 0
    assert run["status"] == "awaiting_agent"
    assert run["next_actions"][0]["intent"] == "attach_script"


def test_simple_brain_run_attaches_its_runtime_neutral_script_and_advances(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)
    plan = {
        "mode": "brief",
        "brain": {"provider": "openai-codex", "model": "gpt-5.4", "auth": "oauth"},
        "draft": {
            "lane": "static-text-ad",
            "title": "One idea people remember",
            "concept": "A plain text ad contrasting polish with clarity.",
            "audience": "DTC founders",
            "goal": "Test message clarity",
            "scenes": [
                {
                    "title": "Hook",
                    "beat": "Make the simple version impossible to miss.",
                    "voice": "Clarity wins.",
                    "overlay": "Your ad does not need to look expensive.",
                    "duration_seconds": 4,
                }
            ],
        },
    }

    response = client.post("/api/simple/runs", data={"plan_json": __import__("json").dumps(plan)})

    assert response.status_code == 201, response.text
    run = response.json()
    assert run["current_step"] != "script"
    assert all(action["intent"] != "attach_script" for action in run["next_actions"])
    assert next(step for step in run["steps"] if step["step_id"] == "script")["status"] == "completed"
    script = next(item for item in run["artifact_records"] if item["role"] == "script")
    script_text = read_private_text(Path(script["path"]))
    assert "# One idea people remember" in script_text
    assert "Clarity wins." in script_text
    assert "Your ad does not need to look expensive." in script_text
    assert Path(script["path"]).read_text(encoding="utf-8").startswith(ENCRYPTED_PREFIX)


def test_advanced_draft_options_reach_the_canonical_manifest(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.post(
        "/api/runs",
        json={
            "lane": "first-frame-animation-ad",
            "title": "Unified content engine",
            "concept": "Show one brief becoming a finished campaign.",
            "audience": "Software founders",
            "goal": "Explain the workflow",
            "tone": "Calm and exact",
            "aspect_ratio": "4:5",
            "runtime_seconds": 18,
            "privacy": "cloud-allowed",
            "max_cost_usd": 12.5,
            "voice": {"enabled": False, "provider": "universal-tts", "delivery": "Warm"},
            "subtitles": {"enabled": True, "position": "bottom", "font_size": 58},
            "providers": {"image": "hivemindos-hosted-media", "motion": "media-studio-mcp"},
            "publish": {"platforms": ["instagram", "tiktok"], "caption": "One system."},
            "scenes": [{"title": "Hook", "beat": "Ten tabs collapse into one studio.", "duration_seconds": 5}],
        },
    )

    assert response.status_code == 201
    run = response.json()
    assert run["brief"]["aspect_ratio"] == "4:5"
    assert run["brief"]["voice"]["enabled"] is False
    assert run["brief"]["subtitles"]["font_size"] == 58
    assert run["providers"]["image"] == "hivemindos-hosted-media"
    assert run["providers"]["motion"] == "media-studio-mcp"
    assert run["policy"]["privacy"] == "cloud-allowed"
    assert run["cost"]["max_cost_usd"] == 12.5


def test_faceless_controls_reach_moneyprinter_compatibility_artifact(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.post(
        "/api/runs",
        json={
            "lane": "faceless",
            "title": "Why simple content wins",
            "concept": "Explain why clarity beats production value.",
            "voice": {"enabled": True, "provider": "universal-tts", "voice_id": "calm-founder"},
            "subtitles": {"enabled": False, "position": "center", "font_size": 44},
            "faceless": {
                "script": "Start with the strongest counterintuitive claim.",
                "search_terms": ["founder recording", "simple advertisement"],
                "media_source": "local",
                "count": 3,
                "clip_duration_seconds": 5,
            },
        },
    )

    assert response.status_code == 201
    run = response.json()
    assert run["brief"]["media_source"] == "local"
    assert run["brief"]["count"] == 3
    params_artifact = next(item for item in run["artifact_records"] if item["role"] == "faceless-params")
    params_response = client.get(f"/api/runs/{run['run_id']}/artifacts/{params_artifact['id']}")
    params = params_response.json()
    assert params["video_script"].startswith("Start with")
    assert params["video_terms"] == ["founder recording", "simple advertisement"]
    assert params["video_source"] == "local"
    assert params["voice_name"] == "calm-founder"
    assert params["subtitle_enabled"] is False
    assert params["video_count"] == 3


def test_clip_draft_requires_a_source(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.post("/api/runs", json={"lane": "clip", "title": "Clip this interview"})

    assert response.status_code == 422
    assert "source" in response.text.lower()


def test_run_artifact_endpoint_serves_only_manifest_artifacts(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)
    response = client.post(
        "/api/runs",
        json={
            "lane": "static-text-ad",
            "title": "Artifact preview",
            "scenes": [{"overlay": "Preview me", "duration_seconds": 3}],
        },
    )
    run = response.json()
    artifact = next(item for item in run["artifact_records"] if item["role"] == "brief")

    download = client.get(f"/api/runs/{run['run_id']}/artifacts/{artifact['id']}")

    assert download.status_code == 200
    assert b"Artifact preview" in download.content
    assert client.get(f"/api/runs/{run['run_id']}/artifacts/not-real").status_code == 404

    assert client.post("/api/owner/lock").status_code == 200
    protected = client.get(
        f"/api/runs/{run['run_id']}/artifacts/{artifact['id']}",
        headers={"Authorization": "Bearer control-secret"},
    )
    assert protected.status_code == 401


def test_oauth_routes_proxy_safe_hivemindos_status_and_start(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.oauth_provider_status",
        lambda provider: {"provider": provider, "connected": provider == "openai", "usable": provider == "openai", "needs_reconnect": provider == "xai"},
    )
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.start_oauth_login",
        lambda provider: {"provider": provider, "authorize_url": f"https://auth.example/{provider}"},
    )
    client, _, _ = _client(tmp_path, monkeypatch)

    status = client.get("/api/oauth").json()
    started = client.post("/api/oauth/xai/start").json()

    assert status["providers"]["openai"]["connected"] is True
    assert status["providers"]["xai"]["needs_reconnect"] is True
    assert started["authorize_url"] == "https://auth.example/xai"


def test_prompt_history_records_run_prompts_with_favorites(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)
    draft = {
        "lane": "static-text-ad",
        "title": "Simple wins",
        "concept": "Why simple content wins attention.",
        "scenes": [{"overlay": "Simple"}],
    }
    assert client.post("/api/runs", json=draft).status_code == 201

    listing = client.get("/api/simple/prompts").json()["prompts"]
    assert [entry["prompt"] for entry in listing] == ["Why simple content wins attention."]
    entry = listing[0]
    assert entry["source"] == "advanced"
    assert entry["lane"] == "static-text-ad"
    assert entry["favorite"] is False

    favorite = client.post(f"/api/simple/prompts/{entry['prompt_id']}/favorite", json={"favorite": True})
    assert favorite.status_code == 200
    assert favorite.json()["prompt"]["favorite"] is True
    favorites = client.get("/api/simple/prompts", params={"favorites": True}).json()["prompts"]
    assert [item["prompt_id"] for item in favorites] == [entry["prompt_id"]]

    # The same prompt generated again dedupes into one entry and keeps its favorite.
    assert client.post("/api/runs", json=draft).status_code == 201
    deduped = client.get("/api/simple/prompts").json()["prompts"]
    assert len(deduped) == 1
    assert deduped[0]["use_count"] == 2
    assert deduped[0]["favorite"] is True

    assert client.delete(f"/api/simple/prompts/{entry['prompt_id']}").status_code == 200
    assert client.get("/api/simple/prompts").json()["prompts"] == []
    assert client.post(f"/api/simple/prompts/{entry['prompt_id']}/favorite", json={"favorite": True}).status_code == 404


def test_simple_run_records_the_post_edit_prompt_with_user_wording(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)
    plan = {
        "mode": "brief",
        "user_prompt": "make a fun ad",
        "composer": {
            "studioMode": "create",
            "brain": {"provider": "openai-codex", "model": "gpt-5.4", "auth": "oauth"},
            "imageSelection": {"provider": "openai-gpt-image-oauth", "model": "gpt-image-2"},
            "videoSelection": {"provider": "muapi", "model": "seedance-v2.0-t2v"},
            "promptHelper": False,
            "walkthrough": True,
        },
        "draft": {
            "lane": "static-text-ad",
            "title": "Fun ad",
            "concept": "An expanded, production-ready ad concept.",
            "scenes": [{"overlay": "Fun"}],
        },
    }

    response = client.post("/api/simple/runs", data={"plan_json": __import__("json").dumps(plan)})

    assert response.status_code == 201, response.text
    entry = client.get("/api/simple/prompts").json()["prompts"][0]
    assert entry["prompt"] == "An expanded, production-ready ad concept."
    assert entry["user_prompt"] == "make a fun ad"
    assert entry["source"] == "simple"
    assert entry["run_id"] == response.json()["run_id"]
    assert entry["composer"] == plan["composer"]


def test_simple_run_accepts_avif_reference_images(tmp_path: Path, monkeypatch) -> None:
    client, _, _ = _client(tmp_path, monkeypatch)
    avif = tmp_path / "reference.avif"
    Image.new("RGB", (32, 32), "green").save(avif, format="AVIF")
    plan = {
        "mode": "brief",
        "draft": {
            "lane": "static-text-ad",
            "title": "Modern format",
            "concept": "Reference in a modern container format.",
            "scenes": [{"overlay": "AVIF"}],
        },
    }

    response = client.post(
        "/api/simple/runs",
        data={"plan_json": __import__("json").dumps(plan)},
        files=[("images", ("reference.avif", avif.read_bytes(), "image/avif"))],
    )

    assert response.status_code == 201, response.text
    roles = [item["role"] for item in response.json()["artifact_records"]]
    assert "reference-image" in roles


def test_simple_plan_forwards_attachment_image_data_to_the_brain(tmp_path: Path, monkeypatch) -> None:
    seen: dict = {}

    def fake_plan(payload: dict) -> dict:
        seen.update(payload)
        return {"mode": "questions", "message": "What tone?", "questions": ["Tone?"]}

    monkeypatch.setattr("hivemind_content_studio.control_api.plan_with_brain", fake_plan)
    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.post(
        "/api/simple/plan",
        json={
            "prompt": "Use a task from the attached checklist",
            "provider": "openrouter",
            "model": "deepseek/deepseek-v4-flash",
            "attachments": [
                {"name": "checklist.png", "type": "image/png", "size": 12, "order": 1, "data": "data:image/jpeg;base64,aGk="},
            ],
        },
    )

    assert response.status_code == 200
    assert seen["attachments"][0]["data"] == "data:image/jpeg;base64,aGk="
