from __future__ import annotations

import json
import subprocess
from pathlib import Path

from hivemind_content_studio.provider_jobs import MuapiJobClient


def test_muapi_job_client_exposes_upload_status_wait_and_cancel_without_leaking_keys(tmp_path: Path) -> None:
    calls: list[list[str]] = []

    def runner(command, **_kwargs):
        calls.append(command)
        if "upload" in command:
            return subprocess.CompletedProcess(command, 0, stdout='[{"url":"https://cdn.example/ref.png"}]', stderr="")
        return subprocess.CompletedProcess(command, 0, stdout='{"status":"completed","output_urls":["https://cdn.example/out.mp4"]}', stderr="")

    source = tmp_path / "ref.png"
    source.write_bytes(b"image")
    client = MuapiJobClient(state_path=tmp_path / "state.json", runner=runner)

    uploaded = client.upload(source)
    status = client.status("request-1")
    waited = client.wait("request-1")
    cancelled = client.cancel("request-1")

    assert uploaded["url"] == "https://cdn.example/ref.png"
    assert status["status"] == "completed"
    assert waited["status"] == "completed"
    assert cancelled["status"] == "cancellation-requested"
    assert cancelled["provider_cancel_supported"] is False
    assert all("MUAPI_API_KEY" not in " ".join(command) for command in calls)
