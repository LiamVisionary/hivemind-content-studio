from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.run_store import RunStore


def _client(tmp_path: Path, monkeypatch) -> tuple[TestClient, ContentOrchestrator, ApprovalLedger]:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    approvals = ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret")
    app = build_control_app(orchestrator=orchestrator, approvals=approvals, control_token="control-secret", operator_token="operator-secret")
    return TestClient(app), orchestrator, approvals


def test_control_api_is_a_thin_run_viewer_with_authenticated_mutations(tmp_path: Path, monkeypatch) -> None:
    client, orchestrator, _ = _client(tmp_path, monkeypatch)
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: api\nlane: static-text-ad\nscenes:\n  - overlay: Test\n", encoding="utf-8")
    run = orchestrator.execute_content_run(brief)

    assert client.get("/").status_code == 200
    response = client.get("/api/runs")
    assert response.status_code == 200
    assert response.json()["runs"][0]["run_id"] == run["run_id"]
    assert client.post(f"/api/runs/{run['run_id']}/cancel", json={"reason": "stop"}).status_code == 401
    cancelled = client.post(
        f"/api/runs/{run['run_id']}/cancel",
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
    seedance = next(item for item in catalog["media"]["video"] if item["id"] == "muapi")
    assert next(model for model in seedance["models"] if model["id"] == "seedance-v2.0-t2v")["max_reference_images"] is None
    assert any(template["id"] == "ugc-product-ad-15s" for template in catalog["templates"])


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
        "brain": {"provider": "openai-codex", "model": "gpt-5.4", "auth": "oauth"},
        "imageSelection": {"provider": "openai-gpt-image-oauth", "model": "gpt-image-2"},
        "videoSelection": {"provider": "automatic", "model": "automatic"},
        "promptHelper": False,
        "walkthrough": True,
    }
    assert "token" not in response.text.lower()


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
    script_text = Path(script["path"]).read_text(encoding="utf-8")
    assert "# One idea people remember" in script_text
    assert "Clarity wins." in script_text
    assert "Your ad does not need to look expensive." in script_text


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
