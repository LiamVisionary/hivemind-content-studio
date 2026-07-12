from __future__ import annotations

from pathlib import Path

from hivemind_content_studio.manifest import load_manifest
from hivemind_content_studio.planner import plan
from hivemind_content_studio.provider_execution import ProviderExecutors


def test_higgsfield_consumer_executes_scene_contract_and_records_provenance(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text(
        "id: provider-exec\nlane: first-frame-animation-ad\naspect_ratio: 9:16\nprovider_options:\n  higgsfield-consumer:\n    keyframe_model: gpt_image_2\nscenes:\n  - image_prompt: Product on a clean table\n",
        encoding="utf-8",
    )
    manifest_path = plan(brief)
    calls: list[dict] = []

    def fake_consumer(**kwargs):
        calls.append(kwargs)
        output = Path(kwargs["output"])
        output.write_bytes(b"generated-image")
        return {"provider": "higgsfield-consumer", "model": kwargs["model"], "output": str(output), "job_id": "job-1"}

    executors = ProviderExecutors(higgsfield_consumer=fake_consumer)
    result = executors.generate_keyframes(manifest_path, "higgsfield-consumer")

    assert calls[0]["model"] == "gpt_image_2"
    assert calls[0]["confirm"] == "PAID_GENERATE"
    assert result["artifacts"] == [str(Path(calls[0]["output"]))]
    artifact = next(item for item in load_manifest(manifest_path)["artifacts"] if item["role"] == "keyframe")
    assert artifact["scene"] == 1
    assert artifact["model"] == "gpt_image_2"


def test_muapi_requires_explicit_endpoint_and_payload_contract(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: muapi-contract\nlane: first-frame-animation-ad\nscenes:\n  - image_prompt: Frame\n", encoding="utf-8")
    manifest_path = plan(brief)

    try:
        ProviderExecutors().generate_keyframes(manifest_path, "muapi")
    except ValueError as exc:
        assert "endpoint" in str(exc).lower()
    else:
        raise AssertionError("MUAPI should fail closed without a discovered endpoint contract")


def test_hivemindos_hosted_executor_binds_the_consumed_maximum_to_each_scene(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text(
        """id: hosted-provider
lane: first-frame-animation-ad
provider_options:
  hivemindos-hosted-media:
    agent_id: content-company-agent
    keyframe:
      model: flux-dev
      payload:
        prompt: "{prompt}"
scenes:
  - image_prompt: Product hero frame
""",
        encoding="utf-8",
    )
    manifest_path = plan(brief)
    calls: list[dict] = []

    def fake_hosted(**kwargs):
        calls.append(kwargs)
        output = Path(kwargs["output"])
        output.write_bytes(b"hosted-image")
        return {"provider": "hivemindos-hosted-media", "model": kwargs["model"], "output": str(output), "source_url": "https://cdn.example/frame.png"}

    result = ProviderExecutors(hivemindos_hosted=fake_hosted).generate_keyframes(
        manifest_path,
        "hivemindos-hosted-media",
        authorization={"maximum_debit_usd": 0.75},
    )

    assert result["artifacts"]
    assert calls[0]["maximum_debit_usd"] == 0.75
    assert calls[0]["agent_id"] == "content-company-agent"
    assert calls[0]["idempotency_key"].endswith(":keyframe:1:flux-dev")


def test_openai_and_xai_are_registered_manifest_executors(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text(
        "id: first-party-media\nlane: first-frame-animation-ad\nscenes:\n  - image_prompt: Product hero\n",
        encoding="utf-8",
    )
    openai_manifest = plan(brief)
    calls: list[tuple[str, dict]] = []

    def fake_openai(**kwargs):
        calls.append(("openai", kwargs))
        Path(kwargs["output"]).write_bytes(b"openai")
        return {"provider": "openai-gpt-image", "model": kwargs["model"], "output": str(kwargs["output"])}

    def fake_openai_oauth(**kwargs):
        calls.append(("openai-oauth", kwargs))
        Path(kwargs["output"]).write_bytes(b"openai-oauth")
        return {"provider": "openai-gpt-image-oauth", "model": kwargs["model"], "output": str(kwargs["output"])}

    executors = ProviderExecutors(openai_image=fake_openai, openai_oauth_image=fake_openai_oauth)
    result = executors.generate_keyframes(openai_manifest, "openai-gpt-image")

    assert result["provider"] == "openai-gpt-image"
    assert calls[0][1]["model"] == "gpt-image-2"
    assert calls[0][1]["confirm"] == "PAID_GENERATE"

    oauth_brief = tmp_path / "openai-oauth.yaml"
    oauth_brief.write_text(
        "id: openai-oauth-media\nlane: first-frame-animation-ad\nscenes:\n  - image_prompt: Product hero\n",
        encoding="utf-8",
    )
    oauth_manifest = plan(oauth_brief)
    oauth_result = executors.generate_keyframes(oauth_manifest, "openai-gpt-image-oauth")
    assert oauth_result["provider"] == "openai-gpt-image-oauth"
    assert calls[-1][0] == "openai-oauth"
    oauth_artifact = next(item for item in load_manifest(oauth_manifest)["artifacts"] if item["role"] == "keyframe")
    assert oauth_artifact["provider"] == "openai-gpt-image-oauth"

    xai_brief = tmp_path / "xai.yaml"
    xai_brief.write_text(
        "id: xai-media\nlane: first-frame-animation-ad\nscenes:\n  - image_prompt: Product hero\n",
        encoding="utf-8",
    )
    xai_manifest = plan(xai_brief)

    def fake_xai(**kwargs):
        calls.append(("xai", kwargs))
        Path(kwargs["output"]).write_bytes(b"xai")
        return {"provider": "xai-imagine-oauth", "model": kwargs["model"], "output": str(kwargs["output"])}

    result = ProviderExecutors(xai_imagine=fake_xai).generate_keyframes(xai_manifest, "xai-imagine-oauth")
    assert result["provider"] == "xai-imagine-oauth"
    assert calls[-1][1]["auth_mode"] == "oauth"
