"""Cancelling reports what happened, not what was asked for.

Accepting a cancel and completing one are different events, and on a rented
machine they can be minutes apart: Comfy honours an interrupt at node and
sampler-step boundaries, so a prompt part-way through loading a video model
holds the GPU until it reaches one. During that window the next generation
queues behind a job the studio has already called "cancelled".

These pin the two facts apart at the studio hops.
"""

from __future__ import annotations

import json

import pytest

from hivemind_content_studio import media_studio


def _descriptor():
    return media_studio.MediaStudioDescriptor(
        app_id="test:media-studio",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8787",
        auth_env_key=None,
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id=None,
    )


def _gateway_replying(monkeypatch, payload, *, status=200):
    class Response:
        def __init__(self):
            self.status = status

        def read(self):
            return json.dumps(payload).encode("utf-8") if payload is not None else b""

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    monkeypatch.setattr(media_studio, "discover_media_studio", lambda: _descriptor())
    monkeypatch.setattr(media_studio, "_token", lambda _descriptor: "gateway-token")
    monkeypatch.setattr(media_studio.urllib.request, "urlopen", lambda *_a, **_k: Response())


def test_a_backend_that_let_go_reports_stopped(monkeypatch) -> None:
    _gateway_replying(monkeypatch, {"ok": True, "interrupted": True, "stopped": True})
    assert media_studio.cancel_video("job-1") == {
        "interrupted": True, "stopped": True, "backend_state": None,
    }


def test_a_backend_still_winding_down_is_not_reported_as_cancelled(monkeypatch) -> None:
    # The whole point: the caller must be able to say "still stopping".
    _gateway_replying(
        monkeypatch,
        {"ok": True, "interrupted": True, "stopped": False, "backend_state": "running"},
    )
    outcome = media_studio.cancel_video("job-1")
    assert outcome["interrupted"] is True
    assert outcome["stopped"] is False
    assert outcome["backend_state"] == "running"


def test_an_older_gateway_without_the_stopped_field_behaves_as_before(monkeypatch) -> None:
    # Backwards compatibility: `stopped` follows `interrupted` when unstated, so
    # a gateway that has not been restarted yet keeps its old semantics instead
    # of every cancel suddenly reading as "still stopping".
    _gateway_replying(monkeypatch, {"ok": True, "interrupted": True})
    assert media_studio.cancel_video("job-1")["stopped"] is True

    _gateway_replying(monkeypatch, {"ok": True, "interrupted": False})
    assert media_studio.cancel_video("job-2")["stopped"] is False


def test_an_unreachable_backend_claims_nothing(monkeypatch) -> None:
    monkeypatch.setattr(media_studio, "discover_media_studio", lambda: None)
    assert media_studio.cancel_video("job-1") == {
        "interrupted": False, "stopped": False, "backend_state": None,
    }


@pytest.mark.parametrize(
    ("gateway", "expect_detail"),
    [
        ({"ok": True, "interrupted": True, "stopped": True}, False),
        ({"ok": True, "interrupted": True, "stopped": False, "backend_state": "running"}, True),
    ],
)
def test_the_cancel_route_tells_the_studio_when_the_machine_is_still_busy(
    tmp_path, monkeypatch, gateway, expect_detail,
) -> None:
    from test_control_api import _client  # the shared owner-unlocked test client

    client, _, _ = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.run_media_studio_video_cancel",
        lambda _job_id, **_kwargs: dict(gateway),
    )

    response = client.post("/api/media-studio/video/job/job-1/cancel")

    assert response.status_code == 200
    body = response.json()
    # The UI unblocks either way — that part was never in question.
    assert body["ok"] is True and body["status"] == "cancelled"
    assert body["stopped"] is bool(gateway["stopped"])
    # ...but a still-busy backend has to be said out loud, because the next
    # generation will queue behind it.
    assert ("detail" in body) is expect_detail
    if expect_detail:
        assert "queue behind it" in body["detail"]


def test_the_cancel_route_survives_an_older_bool_returning_cancel(tmp_path, monkeypatch) -> None:
    from test_control_api import _client

    client, _, _ = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.run_media_studio_video_cancel",
        lambda _job_id, **_kwargs: True,
    )

    body = client.post("/api/media-studio/video/job/job-1/cancel").json()
    assert body["interrupted"] is True and body["stopped"] is True
