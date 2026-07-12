from __future__ import annotations

from hivemind_content_studio.providers import PROVIDER_MATRIX, providers_for
from hivemind_content_studio.providers import readiness


def test_provider_matrix_has_unique_ids_and_complete_core_roles() -> None:
    ids = [provider.id for provider in PROVIDER_MATRIX]
    assert len(ids) == len(set(ids))
    for role in ("script", "image", "motion", "voice", "music", "assembly", "clip", "publish"):
        assert providers_for(role), role


def test_local_studio_and_both_publishers_are_first_class() -> None:
    assert [provider.id for provider in providers_for("timeline")] == ["palmier-pro"]
    assert {provider.id for provider in providers_for("publish")} == {"postiz", "upload-post"}


def test_agent_and_paid_media_providers_are_explicit_capabilities() -> None:
    ids = {provider.id for provider in PROVIDER_MATRIX}

    assert "agent-runtime" in ids
    assert "adaptive-agent" not in ids
    assert {provider.id for provider in providers_for("keyframe")} >= {
        "comfyui",
        "openai-gpt-image",
        "xai-imagine-api",
        "xai-imagine-oauth",
        "hivemindos-hosted-media",
        "muapi",
        "higgsfield-cloud",
        "higgsfield-consumer",
    }
    assert {provider.id for provider in providers_for("voice")} >= {"universal-tts", "elevenlabs"}


def test_openai_and_xai_media_readiness_uses_the_correct_auth_surface(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "openai-secret")
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.setattr(
        "hivemind_content_studio.hivemindos_oauth.oauth_provider_status",
        lambda provider: {"connected": True, "usable": True, "detail": f"{provider} status"},
    )

    reports = {provider.id: readiness(provider) for provider in PROVIDER_MATRIX}

    assert reports["openai-gpt-image"]["available"] is True
    assert reports["openai-gpt-image-oauth"]["available"] is True
    assert reports["xai-imagine-api"]["available"] is False
    assert reports["xai-imagine-oauth"]["available"] is True
    assert reports["openai-gpt-image"]["requirement"] == "OPENAI_API_KEY"
    assert reports["openai-gpt-image-oauth"]["requirement"] == "HivemindOS OpenAI ChatGPT/Codex OAuth (beta)"


def test_clueso_is_an_agent_scoped_remote_workflow_provider() -> None:
    provider = next(item for item in PROVIDER_MATRIX if item.id == "clueso-mcp")

    report = readiness(provider)

    assert set(provider.roles) >= {"video-workflow", "video-editing", "localization", "documentation"}
    assert provider.mode == "manual"
    assert set(provider.side_effects) >= {"network", "external-upload", "project-write", "generation"}
    assert report["available"] is False
    assert "active agent runtime" in report["detail"]


def test_hivemindos_hosted_media_uses_dashboard_readiness_not_a_provider_key(monkeypatch) -> None:
    monkeypatch.setenv("HIVEMINDOS_DASHBOARD_DEVICE_TOKEN", "local-device-token")
    monkeypatch.setattr(
        "hivemind_content_studio.hivemindos_hosted_media.hosted_media_status",
        lambda: {"configured": True, "reachable": True, "detail": "HivemindOS hosted media route answered"},
    )
    provider = next(item for item in PROVIDER_MATRIX if item.id == "hivemindos-hosted-media")

    report = readiness(provider)

    assert report["available"] is True
    assert "HivemindOS hosted media route answered" in report["detail"]


def test_higgsfield_consumer_is_not_ready_when_the_cli_session_is_expired(monkeypatch) -> None:
    import subprocess

    monkeypatch.setattr("hivemind_content_studio.providers.shutil.which", lambda name: "/tmp/higgsfield" if name == "higgsfield" else None)
    monkeypatch.setattr(
        "hivemind_content_studio.providers.subprocess.run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess([], 1, stdout="", stderr="Session expired"),
    )
    provider = next(item for item in PROVIDER_MATRIX if item.id == "higgsfield-consumer")

    report = readiness(provider)

    assert report["available"] is False
    assert report["detail"] == "higgsfield CLI found but its consumer session is not authenticated"
