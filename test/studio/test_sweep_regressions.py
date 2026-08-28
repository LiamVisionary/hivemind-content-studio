"""The defects a full end-to-end sweep found on 2026-08-25, pinned.

Every test here failed before its fix and names what broke, because each one
had already shipped: the studio reported itself healthy while a lane could not
run, a provider advertised Ready while every call failed on its own argument,
and a safety gate answered "ok" for a brief it had just failed.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hivemind_content_studio import generation, image_router, providers
from hivemind_content_studio.evaluation import semantic_preflight
from hivemind_content_studio.local_voice import resolve_local_voice
from hivemind_content_studio.planner import _faceless_voice_name, load_brief, normalize_aspect_ratio


# ── the blocker: no local image provider could ever be selected ─────────────


def test_comfyui_reports_ready_when_the_local_media_route_answers(monkeypatch) -> None:
    """`readiness()` had a branch for every provider except comfyui, so it fell
    through to the manual-mode default and reported unavailable on every
    machine forever. The capability router refuses an unready provider even
    against an explicit override, which left the animation lanes with no way to
    draw a frame while ComfyUI was running and generating."""
    monkeypatch.setattr(
        "hivemind_content_studio.media_studio.media_studio_status",
        lambda: {"configured": True, "auth_present": True, "reachable": True, "detail": "reachable"},
    )
    comfyui = next(item for item in providers.PROVIDER_MATRIX if item.id == "comfyui")

    report = providers.readiness(comfyui)

    assert report["available"] is True
    assert "ComfyUI" in report["detail"]


def test_comfyui_reports_unavailable_when_the_local_media_route_is_down(monkeypatch) -> None:
    monkeypatch.setattr(
        "hivemind_content_studio.media_studio.media_studio_status",
        lambda: {"configured": True, "auth_present": True, "reachable": False, "detail": "did not answer"},
    )
    comfyui = next(item for item in providers.PROVIDER_MATRIX if item.id == "comfyui")

    assert providers.readiness(comfyui)["available"] is False


def test_an_unavailable_media_studio_says_what_is_missing(monkeypatch) -> None:
    """The detail only ever reported reachability, so a provider whose TOKEN was
    missing rendered as unavailable next to the words "is reachable" — the
    opposite of its own status, naming nothing to fix."""
    from hivemind_content_studio import media_studio

    monkeypatch.setattr(media_studio, "discover_media_studio", lambda: media_studio.MediaStudioDescriptor(
        app_id="test", app_name="Test", mcp_url="http://127.0.0.1:1/mcp", upload_base="http://127.0.0.1:1",
        auth_env_key="MEDIA_STUDIO_TOKEN", tool="media_generate_video", job_tool="media_get_job",
        workflow_id=None,
    ))
    monkeypatch.setattr(media_studio, "_token", lambda descriptor: "")
    monkeypatch.setattr(media_studio, "_reachable", lambda url, token: True)

    status = media_studio.media_studio_status()

    assert status["auth_present"] is False
    assert "MEDIA_STUDIO_TOKEN" in status["detail"]
    assert status["detail"] != "Media Studio MCP is reachable."


# ── xAI: one credential lane failed on its own argument ────────────────────


def test_every_xai_route_is_built_with_an_auth_mode_the_generator_accepts() -> None:
    """image_router passed "api" where the generator required "api-key", so
    every xAI API-key render raised before reaching the network — while the
    provider advertised itself Ready in doctor, the catalog and the UI."""
    for provider_id in ("xai-imagine-api", "xai-imagine-oauth"):
        assert provider_id in image_router.ROUTES

    with pytest.raises(ValueError, match="auth mode"):
        image_router._xai("api")

    assert image_router.ROUTES["xai-imagine-api"].run is not None
    assert image_router.ROUTES["xai-imagine-oauth"].oauth == "xai"


def test_xai_and_openai_resolve_their_keys_from_the_same_shared_env(monkeypatch, tmp_path) -> None:
    """Both credentials come from the shared hive env, with the process
    environment winning — one rule for every provider key in the studio."""
    shared = tmp_path / "shared.env"
    shared.write_text("XAI_API_KEY=from-shared\nOPENAI_API_KEY=from-shared\n", encoding="utf-8")
    monkeypatch.setenv("HIVE_ENV_FILES", str(shared))
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "from-process")

    assert generation.provider_credential("XAI_API_KEY") == "from-shared"
    assert generation.provider_credential("OPENAI_API_KEY") == "from-process"


def test_a_missing_xai_key_names_how_to_add_it_and_the_other_lane(monkeypatch, tmp_path) -> None:
    """The message has to be actionable, and it used to name a file to edit.

    Pointing at `~/.hivemindos/.env` was fine advice for a plaintext store and
    bad advice for a sealed one: a hand-added line for a key that is already
    there, sealed, leaves the store with two entries for one name. Naming the
    command instead is the whole difference, so what is asserted here is that a
    command appears — not the sentence it appears in.
    """
    monkeypatch.setenv("HIVE_ENV_FILES", str(tmp_path / "absent.env"))
    monkeypatch.delenv("XAI_API_KEY", raising=False)

    with pytest.raises(RuntimeError) as failure:
        generation.generate_xai_imagine_asset(
            kind="keyframe", auth_mode=generation.AUTH_MODE_API_KEY, prompt="x",
            aspect_ratio="1:1", output=tmp_path / "out.png",
            confirm=generation.PAID_GENERATION_CONFIRMATION,
        )

    message = str(failure.value)
    assert "passbook add XAI_API_KEY" in message, message
    assert "OAuth" in message, message


# ── generated media that named itself wrongly ─────────────────────────────


def test_a_jpeg_written_to_a_png_name_is_renamed_to_match_its_bytes(tmp_path: Path) -> None:
    """Callers name the destination before the provider answers. xAI returns
    JPEG, so the file landed as "…png" and was then served as image/png beside
    `nosniff`, which makes a browser refuse to render it."""
    jpeg = tmp_path / "studio-abc.png"
    jpeg.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 32)

    landed = generation.correct_media_suffix(jpeg)

    assert landed.name == "studio-abc.jpg"
    assert landed.is_file() and not jpeg.exists()


def test_a_png_that_is_really_a_png_is_left_alone(tmp_path: Path) -> None:
    png = tmp_path / "studio-abc.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)

    assert generation.correct_media_suffix(png) == png


def test_generated_media_downloads_identify_the_client() -> None:
    """urllib's default agent string is filtered at one provider's media CDN,
    which surfaced as a download failure AFTER the image had been paid for."""
    assert generation.DOWNLOAD_USER_AGENT.startswith("hivemind-content-studio")


# ── the safety gate that answered "ok" for a brief it had failed ───────────


def test_the_mcp_preflight_reports_the_findings_it_just_made(tmp_path: Path, monkeypatch) -> None:
    """`preflight_content_semantics` ran the claim and legibility check, threw
    the result away, and returned a hard-coded success — so an agent's only
    pre-evaluation gate could not see a failure."""
    import asyncio

    from hivemind_content_studio.mcp_server import build_mcp_server

    brief = tmp_path / "brief.yaml"
    brief.write_text(
        "id: canary\nlane: static-text-ad\nscenes:\n"
        "  - overlay: This guaranteed risk-free system will absolutely double your revenue in thirty days\n"
        "    duration_seconds: 4\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))

    from hivemind_content_studio.orchestrator import ContentOrchestrator
    from hivemind_content_studio.run_store import RunStore

    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    run = orchestrator.execute_content_run(brief)
    direct = semantic_preflight(run["manifest_path"])
    assert direct["passed"] is False, "the fixture must be a brief that fails preflight"

    monkeypatch.setattr("hivemind_content_studio.mcp_server._orchestrator", lambda: orchestrator)
    server = build_mcp_server()
    result = asyncio.run(server.call_tool("preflight_content_semantics", {"run_id": run["run_id"]}))
    # FastMCP answers (content, structuredContent); either carries the payload.
    if isinstance(result, tuple) and len(result) > 1 and isinstance(result[1], dict):
        payload = result[1]
    else:
        parts = result[0] if isinstance(result, tuple) else result
        payload = json.loads(next(part.text for part in parts if getattr(part, "text", None)))

    assert payload["preflight_passed"] is False
    assert payload["score"] == direct["score"]
    assert len(payload["scene_failures"]) == len(direct["scene_failures"])
    assert payload["regeneration_instructions"]


# ── YAML ate the aspect ratio ─────────────────────────────────────────────


@pytest.mark.parametrize(
    ("packed", "expected"),
    [(556, "9:16"), (969, "16:9"), (245, "4:5"), (61, "1:1")],
)
def test_a_sexagesimal_aspect_ratio_is_read_back_as_a_ratio(packed: int, expected: str) -> None:
    """An unquoted `9:16` is a YAML 1.1 base-60 integer, so safe_load hands back
    556. It failed the faceless render outright (pydantic refused
    video_aspect=556) and was silently ignored everywhere else."""
    assert normalize_aspect_ratio(packed) == expected


def test_a_quoted_aspect_ratio_survives_untouched() -> None:
    assert normalize_aspect_ratio("9:16") == "9:16"


def test_a_number_that_is_not_a_ratio_is_refused_with_the_fix() -> None:
    with pytest.raises(ValueError, match="Quote it in the brief"):
        normalize_aspect_ratio(4000)


def test_the_brief_loader_normalises_what_yaml_packed(tmp_path: Path) -> None:
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: x\nlane: faceless\naspect_ratio: 9:16\n", encoding="utf-8")

    assert load_brief(brief)["aspect_ratio"] == "9:16"


def test_every_shipped_example_brief_declares_a_real_ratio() -> None:
    """All three shipped briefs were written unquoted, so anyone copying one
    inherited the bug."""
    examples = Path(__file__).resolve().parents[2] / "examples" / "briefs"
    for brief in sorted(examples.glob("*.yaml")):
        ratio = load_brief(brief).get("aspect_ratio")
        if ratio is None:
            continue
        assert isinstance(ratio, str) and ":" in ratio, f"{brief.name} carries {ratio!r}"


# ── voices: two sentinels the server rejects, and a dropped provider ──────


def test_a_brief_with_no_voice_named_resolves_a_real_model_and_voice(monkeypatch) -> None:
    """"default" is not an id the TTS server knows: as the model it answered
    404 ("unknown model/provider: default") and as the voice it answered 500, so
    a brief that did not name both by hand could not produce a single line."""
    monkeypatch.setattr(
        "hivemind_content_studio.local_voice.list_local_voice_models",
        lambda: [
            {"id": "cold-model", "provider": "cold", "loaded": False},
            {"id": "kitten-tts-nano", "provider": "kitten", "loaded": True},
        ],
    )
    monkeypatch.setattr(
        "hivemind_content_studio.local_voice.list_provider_voices",
        lambda provider: [{"id": "Bella"}] if provider == "kitten" else [{"id": "wrong-engine-voice"}],
    )

    model_id, voice_id = resolve_local_voice({})

    # A resident model answers immediately; a cold one pays a load nobody asked for.
    assert model_id == "kitten-tts-nano"
    # Voices belong to a provider, so the voice must come from the chosen model's.
    assert voice_id == "Bella"
    assert "default" not in {model_id, voice_id}


def test_a_named_model_keeps_its_own_engine_s_voices(monkeypatch) -> None:
    monkeypatch.setattr(
        "hivemind_content_studio.local_voice.list_local_voice_models",
        lambda: [{"id": "kitten-tts-nano", "provider": "kitten", "loaded": True}],
    )
    monkeypatch.setattr(
        "hivemind_content_studio.local_voice.list_provider_voices",
        lambda provider: [{"id": "Bella"}, {"id": "Luna"}],
    )

    assert resolve_local_voice({"model_id": "kitten-tts-nano"}) == ("kitten-tts-nano", "Bella")


def test_an_explicit_local_pair_is_never_second_guessed() -> None:
    assert resolve_local_voice({"provider": "universal-tts", "model_id": "m", "voice_id": "v"}) == ("m", "v")
    assert resolve_local_voice({"model_id": "m", "voice_id": "v"}) == ("m", "v")


def test_another_providers_ids_never_reach_the_local_server(monkeypatch) -> None:
    """A brief writes ONE voice block and the router may not pick the provider
    it was written for. The shipped stickman brief names ElevenLabs, so on the
    default local-first, zero-budget policy the router chose universal-tts and
    handed it "eleven_v3" — which the local server refused with a 404."""
    monkeypatch.setattr(
        "hivemind_content_studio.local_voice.list_local_voice_models",
        lambda: [{"id": "kitten-tts-nano", "provider": "kitten", "loaded": True}],
    )
    monkeypatch.setattr(
        "hivemind_content_studio.local_voice.list_provider_voices",
        lambda provider: [{"id": "Bella"}],
    )

    model_id, voice_id = resolve_local_voice(
        {"provider": "elevenlabs", "model_id": "eleven_v3", "voice_id": "<set-per-run-voice-id>"}
    )

    assert model_id == "kitten-tts-nano"
    assert voice_id == "Bella"


def test_an_unfilled_template_slot_is_not_treated_as_an_id(monkeypatch) -> None:
    monkeypatch.setattr(
        "hivemind_content_studio.local_voice.list_local_voice_models",
        lambda: [{"id": "kitten-tts-nano", "provider": "kitten", "loaded": True}],
    )
    monkeypatch.setattr(
        "hivemind_content_studio.local_voice.list_provider_voices",
        lambda provider: [{"id": "Bella"}],
    )

    assert resolve_local_voice(
        {"provider": "universal-tts", "model_id": "<model>", "voice_id": "<voice>"}
    ) == ("kitten-tts-nano", "Bella")


def test_the_faceless_lane_carries_the_briefs_voice_provider(monkeypatch) -> None:
    """The lane mapped only `voice.voice_id` onto the engine's `voice_name`, so
    a brief asking for universal-tts was answered by the engine's azure router,
    which rejected the local voice by name and failed the whole render."""
    monkeypatch.setattr(
        "hivemind_content_studio.local_voice.resolve_local_voice",
        lambda voice: ("kitten-tts-nano", "Bella"),
    )

    assert _faceless_voice_name({"provider": "universal-tts"}) == "localtts:kitten-tts-nano:Bella-Local"
    # A cloud voice keeps the engine's own naming, untouched.
    assert _faceless_voice_name({"provider": "elevenlabs", "voice_id": "en-US-AriaNeural-Female"}) == "en-US-AriaNeural-Female"
    # An already-qualified local name is not wrapped twice.
    assert _faceless_voice_name({"provider": "localtts", "voice_id": "localtts:m:v-Local"}) == "localtts:m:v-Local"


# ── a motion request with no workflow ─────────────────────────────────────


def test_a_motion_request_without_a_workflow_falls_back_to_the_registrys_default(monkeypatch) -> None:
    """Sending no workflow made the backend answer "unknown video workflow_id: "
    — an EMPTY id — which machine-private redaction then flattened to
    "MediaStudioError", stalling the animation lane with no way to tell why."""
    from hivemind_content_studio import media_studio

    monkeypatch.setattr(media_studio, "list_media_studio_workflows", lambda media_type: [
        {"id": "ltx23-something-else", "default": False},
        {"id": "ltx23-regular-fp8", "default": True},
    ])

    assert media_studio.default_video_workflow_id() == "ltx23-regular-fp8"


def test_the_registry_marks_a_default_video_workflow() -> None:
    """The registry marked a default for image and none for video, which is why
    the image lane worked and the motion lane did not."""
    registry = Path(__file__).resolve().parents[2] / "packages" / "media-gateway" / "workflow-registry.json"
    workflows = json.loads(registry.read_text(encoding="utf-8"))["workflows"]
    for media_type in ("image", "video"):
        defaults = [
            item["id"] for item in workflows
            if (item.get("media_type") or item.get("mediaType")) == media_type and item.get("default")
        ]
        assert len(defaults) == 1, f"{media_type} needs exactly one default, found {defaults}"


# ── the clip export that refused its own profile ─────────────────────────


def test_the_clip_cutter_pins_a_pixel_format_beside_its_profile() -> None:
    """`-profile:v high` with no `-pix_fmt` let ffmpeg keep a 4:4:4 source's
    chroma, and `high` has no 4:4:4 mode — so every clip export from a screen
    recording, a ProRes export, or video built from stills failed to open the
    encoder and the run exported nothing while still reporting success."""
    root = Path(__file__).resolve().parents[2] / "vendor" / "podcli" / "backend" / "services"
    if not root.is_dir():
        # vendor/ is gitignored, so a fresh clone has no podcli to check. The
        # fix still has to be re-applied there — see the note in the sweep
        # report — but this suite cannot assert on a tree that is not present.
        pytest.skip("vendor/podcli is not checked out here")
    for name in ("video_cut.py", "encoder.py", "media_probe.py"):
        lines = (root / name).read_text(encoding="utf-8").splitlines()
        for index, line in enumerate(lines):
            # Only the software encoder negotiates chroma from the source;
            # the hardware encoders take their own pixel format.
            if '"libx264"' not in line:
                continue
            window = "\n".join(lines[index : index + 10])
            if '"-profile:v", "high"' not in window:
                continue
            assert "pix_fmt" in window, f"{name}:{index + 1} sets a libx264 profile with no pixel format"


# ── stdout is the CLI's contract ─────────────────────────────────────────


def test_the_cli_and_mcp_claim_stdout_before_the_engine_can_log_to_it() -> None:
    """The embedded engine logs to stdout, which interleaved ANSI-coloured
    loguru lines with the JSON an agent parses — a successful render whose
    output would not load."""
    root = Path(__file__).resolve().parents[2] / "src" / "hivemind_content_studio"
    for name in ("cli.py", "mcp_server.py"):
        source = (root / name).read_text(encoding="utf-8")
        assert 'os.environ.setdefault("MPT_LOG_SINK", "stderr")' in source, name
