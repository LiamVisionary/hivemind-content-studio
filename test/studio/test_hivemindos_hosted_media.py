from __future__ import annotations

import json
from pathlib import Path

import pytest

from hivemind_content_studio.hivemindos_hosted_media import _dashboard_token, generate_hosted_media_asset


class FakeResponse:
    def __init__(self, payload: dict):
        self.payload = payload
        self.status = 200
        self.headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


def test_dashboard_token_can_be_discovered_from_the_local_hivemind_env_file(tmp_path: Path, monkeypatch) -> None:
    env_file = tmp_path / ".env.local"
    env_file.write_text('HIVEMINDOS_DASHBOARD_DEVICE_TOKEN="local-token"\n', encoding="utf-8")
    monkeypatch.delenv("HIVEMINDOS_DASHBOARD_DEVICE_TOKEN", raising=False)
    monkeypatch.setenv("HIVEMINDOS_ENV_FILE", str(env_file))

    assert _dashboard_token() == "local-token"


def test_hosted_media_quotes_then_generates_and_polls_with_no_provider_key(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HIVEMINDOS_URL", "http://127.0.0.1:5020")
    monkeypatch.setenv("HIVEMINDOS_DASHBOARD_DEVICE_TOKEN", "device-token")
    calls: list[dict] = []

    def opener(request, timeout):
        body = json.loads(request.data) if request.data else None
        calls.append({"url": request.full_url, "headers": dict(request.header_items()), "body": body, "timeout": timeout})
        if body["action"] == "quote":
            return FakeResponse({"ok": True, "quote": {"retailUsd": 0.5, "markupBps": 2500}})
        if body["action"] == "generate":
            return FakeResponse({"ok": True, "job": {"id": "media_job12345678", "status": "processing"}, "billing": {"reservedUsd": 0.5}})
        return FakeResponse({"ok": True, "job": {"id": "media_job12345678", "status": "finalized", "outputs": ["https://cdn.example/output.png"], "billing": {"debitedUsd": 0.5, "markupBps": 2500}}})

    downloaded: list[tuple[str, Path]] = []
    result = generate_hosted_media_asset(
        model="flux-dev",
        payload={"prompt": "Clean product frame"},
        output=tmp_path / "frame.png",
        agent_id="content-company-agent",
        maximum_debit_usd=0.5,
        idempotency_key="run-1:keyframe:1",
        opener=opener,
        sleeper=lambda _seconds: None,
        downloader=lambda url, path: downloaded.append((url, path)) or path.write_bytes(b"image"),
    )

    assert [call["body"]["action"] for call in calls] == ["quote", "generate", "job"]
    assert calls[1]["body"]["maximumDebitUsd"] == 0.5
    assert calls[1]["body"]["agentId"] == "content-company-agent"
    assert "confirmation" not in calls[1]["body"]
    assert calls[1]["headers"]["X-hivemindos-device-token"] == "device-token"
    assert all("MUAPI" not in json.dumps(call) for call in calls)
    assert downloaded == [("https://cdn.example/output.png", tmp_path / "frame.png")]
    assert result["provider"] == "hivemindos-hosted-media"
    assert result["source_url"] == "https://cdn.example/output.png"
    assert result["billing"]["markupBps"] == 2500


def test_hosted_media_refuses_to_exceed_the_consumed_approval_maximum(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HIVEMINDOS_DASHBOARD_DEVICE_TOKEN", "device-token")

    def opener(_request, timeout):
        assert timeout == 120
        return FakeResponse({"ok": True, "quote": {"retailUsd": 0.500001, "markupBps": 2500}})

    with pytest.raises(ValueError, match="approved maximum"):
        generate_hosted_media_asset(
            model="flux-dev",
            payload={"prompt": "x"},
            output=tmp_path / "frame.png",
            agent_id="agent",
            maximum_debit_usd=0.5,
            idempotency_key="run-1:keyframe:1",
            opener=opener,
        )
