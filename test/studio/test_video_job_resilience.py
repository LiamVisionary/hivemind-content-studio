"""A render outlives the process that started it, and a dead backend says so.

Two failures the studio used to show as one shrug. Restarting the control API
mid-render lost the in-memory job registry, so the next poll answered 404 and
the studio reported a failure for a clip that was still rendering — and never
downloaded, QA'd, sealed or claimed the one that finished. And when the backend
died instead, every poll kept answering "running", so the smoothed bar climbed
to its 98% cap and sat there until the client's own wall clock gave up.
"""

from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from pathlib import Path

import pytest

from hivemind_content_studio import comfy_lanes, control_api

RUNNING = {"status": "running", "failed": False, "error": "", "video_url": "", "progress": None}


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    from test_control_api import _client  # the shared owner-unlocked test client

    made, _, _ = _client(tmp_path, monkeypatch)
    # No lane probe reaches the network in tests: a local ComfyUI that happens
    # to be up on this machine must not decide a test's outcome.
    monkeypatch.setattr(comfy_lanes, "_is_busy", lambda *_args, **_kwargs: None)
    return made


@contextmanager
def _finisher_parked(monkeypatch):
    """Hold the background finisher inside its thread for the test's duration.

    Re-adoption arms the finisher, which is the point of it — but a test about
    what the POLL says must not race a finisher landing the same job.
    """
    release = threading.Event()

    def parked(_job_id, **_kwargs):
        release.wait(2)
        raise RuntimeError("released at end of test")

    monkeypatch.setattr(control_api, "run_media_studio_video_finish", parked)
    try:
        yield
    finally:
        release.set()


def _unresponsive_at_once(monkeypatch) -> None:
    monkeypatch.setattr(control_api, "_VIDEO_UNRESPONSIVE_CHECKS", 1)
    monkeypatch.setattr(control_api, "_VIDEO_UNRESPONSIVE_SECONDS", 0.0)
    monkeypatch.setattr(control_api, "_VIDEO_RECORD_PROBE_SECONDS", 0.0)


def _polled_until_landed(client, job_id: str, timeout: float = 20.0) -> dict:
    """Poll until the job reports its clip, the way the studio's own poller does.

    One request is not a promise: the finalize runs partly on worker threads, so
    which poll carries the finished clip back is a scheduling question and not a
    behavioural one. Asking again is what the studio does too.
    """
    deadline = time.monotonic() + timeout
    while True:
        body = client.get(f"/api/media-studio/video/job/{job_id}").json()
        if body.get("url") or body.get("ok") is False or time.monotonic() >= deadline:
            return body
        time.sleep(0.05)


def test_a_poll_after_a_restart_readopts_the_job_and_lands_the_clip(client, monkeypatch) -> None:
    state = dict(RUNNING)
    monkeypatch.setattr(control_api, "run_media_studio_video_record",
                        lambda _job_id, **_kwargs: {"id": "job-live", "status": "running"})
    monkeypatch.setattr(control_api, "run_media_studio_video_check", lambda _job_id, **_kwargs: dict(state))

    # No registry entry: this process did not start the job. The gateway still
    # has it, so the poll re-adopts rather than reporting a failure.
    #
    # The finisher is parked for this poll and only this poll. Re-adoption arms
    # it, and an unparked finisher that returns a clip races the answer it was
    # armed by: on an idle machine the route wins and the poll says "running",
    # on a loaded one the finisher can land the job first and the same correct
    # behaviour reads as a broken re-adoption. What this asserts is the poll's
    # answer, so the finisher is held still rather than out-run.
    with _finisher_parked(monkeypatch):
        first = client.get("/api/media-studio/video/job/job-live").json()
    assert first["ok"] is True and first["status"] == "running"

    # ...and the re-armed finisher still does the work the dead process owed:
    # the finished clip comes back with its URL instead of being abandoned.
    state["video_url"] = "http://gateway.invalid/output/clip.mp4"
    monkeypatch.setattr(
        control_api, "run_media_studio_video_finish",
        lambda job_id, **_kwargs: {"job_id": job_id, "gateway_output": "clip.mp4", "qa": {"ok": True}},
    )
    landed = _polled_until_landed(client, "job-live")
    assert landed["ok"] is True
    assert landed["url"] == "/api/media-studio/gateway/clip.mp4"


def test_a_job_the_gateway_lost_to_a_restart_is_a_retryable_error_not_a_404(
    client, monkeypatch,
) -> None:
    monkeypatch.setattr(
        control_api, "run_media_studio_video_record",
        lambda _job_id, **_kwargs: {"id": "job-dead", "status": "interrupted",
                                    "error": "The studio restarted before this finished."},
    )

    body = client.get("/api/media-studio/video/job/job-dead").json()

    assert body == {
        "ok": False,
        "status": "error",
        "detail": "The studio restarted before this finished. Try again.",
        "retryable": True,
    }


def test_a_job_no_one_has_ever_heard_of_is_still_a_404(client, monkeypatch) -> None:
    monkeypatch.setattr(control_api, "run_media_studio_video_record", lambda _job_id, **_kwargs: None)

    response = client.get("/api/media-studio/video/job/job-unknown")

    assert response.status_code == 404
    assert "History" in response.json()["detail"]


def test_a_backend_that_stops_answering_ends_the_job_instead_of_parking_the_bar(
    client, monkeypatch,
) -> None:
    """The 98% bar was the whole bug: check_video defaults an unreadable status
    to 'running', so a crashed ComfyUI, an OOM-killed lane and a gateway that
    went away all looked exactly like a slow render — for as long as the client
    was willing to wait."""
    _unresponsive_at_once(monkeypatch)
    alive = {"value": True}

    def record(_job_id, **_kwargs):
        return {"id": "job-flip", "status": "running"} if alive["value"] else None

    def check(_job_id, **_kwargs):
        if alive["value"]:
            return {**RUNNING, "progress": 0.3}
        raise RuntimeError("Media Studio status check failed: connection refused")

    monkeypatch.setattr(control_api, "run_media_studio_video_record", record)
    monkeypatch.setattr(control_api, "run_media_studio_video_check", check)

    with _finisher_parked(monkeypatch):
        assert client.get("/api/media-studio/video/job/job-flip").json()["status"] == "running"

        alive["value"] = False
        # One dead poll raises the counter and asks the gateway whether anything
        # still has the job; the next one acts on the answer.
        client.get("/api/media-studio/video/job/job-flip")
        body = client.get("/api/media-studio/video/job/job-flip").json()

    assert body["ok"] is False and body["status"] == "error"
    assert body["detail"] == control_api._VIDEO_BACKEND_GONE
    assert body["retryable"] is True


def test_a_busy_local_lane_vetoes_the_flip(client, monkeypatch) -> None:
    """A lane with work in flight is a render in progress whatever the gateway
    is doing — ending the job there would throw away a clip that lands."""
    _unresponsive_at_once(monkeypatch)
    monkeypatch.setattr(comfy_lanes, "_is_busy", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(control_api, "run_media_studio_video_record",
                        lambda _job_id, **_kwargs: {"id": "job-busy", "status": "running"})
    monkeypatch.setattr(control_api, "run_media_studio_video_check", lambda _job_id, **_kwargs: dict(RUNNING))

    with _finisher_parked(monkeypatch):
        assert client.get("/api/media-studio/video/job/job-busy").json()["status"] == "running"

        def dead_check(_job_id, **_kwargs):
            raise RuntimeError("gateway unreachable")

        monkeypatch.setattr(control_api, "run_media_studio_video_check", dead_check)
        monkeypatch.setattr(control_api, "run_media_studio_video_record", lambda _job_id, **_kwargs: None)
        for _ in range(3):
            body = client.get("/api/media-studio/video/job/job-busy").json()

    assert body["ok"] is True and body["status"] == "running"
