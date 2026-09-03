"""Production-polish contracts of the control API (2026-08-23 sweep).

What a demanding owner hits at the edges: error TEXT that reached the toast
verbatim (paths, runner dumps, tokens), a sign-in contract that differed by
route, a 24 h session that never slid, validation errors rendered as
``[object Object]``, and a money route with no double-submit guard. Each
test here pins one of those behaviours through the same HTTP path the
studio uses.
"""

from __future__ import annotations

import base64
import threading
import time
import urllib.error
from pathlib import Path

import requests
from fastapi.testclient import TestClient

from hivemind_content_studio import gpu_rentals
from hivemind_content_studio.accounts import ACCOUNT_COOKIE, AccountAccess, SESSION_SECONDS
from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import (
    PROXY_SECRET_ENV,
    PROXY_SECRET_HEADER,
    build_control_app,
)
from hivemind_content_studio.media_studio import sanitize_error_detail
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.rental_providers import response_error_text
from hivemind_content_studio.rental_providers import runpod as runpod_provider
from hivemind_content_studio.rental_providers import vast as vast_provider
from hivemind_content_studio.run_store import RunStore

OWNER_PASSWORD = "test-owner-password"
_CIPHER_SECRET = b"test-private-state-secret"


def _app(tmp_path: Path, monkeypatch, **overrides):
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    approvals = ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret")
    cipher = PrivateFieldCipher.from_secret(_CIPHER_SECRET)
    owner_access = OwnerAccess.for_testing(password=OWNER_PASSWORD, cipher=cipher)
    return build_control_app(
        orchestrator=orchestrator,
        approvals=approvals,
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=owner_access,
        private_cipher=cipher,
        **overrides,
    )


def _client(tmp_path: Path, monkeypatch, *, unlock: bool = True, raise_server_exceptions: bool = True, **overrides) -> TestClient:
    client = TestClient(_app(tmp_path, monkeypatch, **overrides), raise_server_exceptions=raise_server_exceptions)
    if unlock:
        assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD}).status_code == 200
    return client


def _png_data_url() -> str:
    return "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 32).decode("ascii")


# ── error text that reaches the toast ────────────────────────────────────────

def test_sanitize_error_detail_keeps_the_point_and_drops_the_dump() -> None:
    """The first informative line, the last stderr line, basenames for private
    paths, tokens redacted, capped — and the OOM translation left first."""
    dump = (
        "ltx-2-mlx exited 1\nSTDOUT:\nloading…\nSTDERR:\nTraceback (most recent call last):\n"
        '  File "/Users/liam/comfy/x.py", line 3\n'
        "ValueError: cannot open /Users/liam/.lmstudio/models/q/m.gguf\n"
    )
    assert sanitize_error_detail(dump) == "ltx-2-mlx exited 1 — ValueError: cannot open m.gguf"
    assert sanitize_error_detail(
        "MLX LTX model not found: /Users/liam/Library/Application Support/open-generative-ai/local-ai/models/ltx.safetensors"
    ) == "MLX LTX model not found: ltx.safetensors"
    # A traceback's informative line is its LAST one.
    assert sanitize_error_detail("Traceback (most recent call last):\n  File x\nRuntimeError: boom /private/tmp/abc/def.mp4") \
        == "RuntimeError: boom def.mp4"
    assert sanitize_error_detail("download failed for http://127.0.0.1:8787/image/x.mp4?token=secret123") \
        == "download failed for http://127.0.0.1:8787/image/x.mp4?token=[redacted]"
    # A bare home directory would name the user as its basename: it says nothing.
    assert sanitize_error_detail("state under /Users/liam") == "state under …"
    # Routes are not private paths; they keep reading as routes.
    assert sanitize_error_detail("Media Studio upload failed with HTTP 404 at /api/job/x") \
        == "Media Studio upload failed with HTTP 404 at /api/job/x"
    assert len(sanitize_error_detail("x" * 2000)) == 300
    assert sanitize_error_detail("x" * 2000, limit=40).endswith("…")
    oom = sanitize_error_detail("CUDA out of memory. Tried to allocate 2 GiB. Requested : 2.00 GiB /Users/liam/x")
    assert oom.startswith("The GPU ran out of memory") and "/Users" not in oom
    assert sanitize_error_detail("") == "" and sanitize_error_detail(None) == ""


def test_a_failed_job_reports_a_sanitized_detail_to_the_owner(tmp_path: Path, monkeypatch) -> None:
    """What the poll route hands the toast after a lane failure: one line,
    no paths, no 4 KB of runner output."""
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.run_media_studio_video_start",
        lambda **_: {"job_id": "job-fail-1", "uploaded_names": [], "provider": "Media Studio"},
    )

    def fake_finish(job_id, **_):
        raise RuntimeError(
            "ltx-2-mlx exited 1\nSTDOUT:\n" + "progress\n" * 50
            + "STDERR:\nFileNotFoundError: /Users/liam/Library/Application Support/open-generative-ai/local-ai/models/ltx.safetensors"
        )

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video_finish", fake_finish)
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.run_media_studio_video_check",
        lambda job_id, **_: {"status": "error", "failed": True, "error": "x", "video_url": "", "progress": 0.1},
    )
    client = _client(tmp_path, monkeypatch)
    queued = client.post("/api/media-studio/video/start", json={"prompt": "a shot", "duration_seconds": 2})
    assert queued.status_code == 200, queued.text
    payload: dict = {}
    for _ in range(100):
        payload = client.get("/api/media-studio/video/job/job-fail-1").json()
        if payload.get("status") != "running":
            break
        time.sleep(0.05)
    assert payload["ok"] is False and payload["status"] == "error"
    assert payload["detail"] == "ltx-2-mlx exited 1 — FileNotFoundError: ltx.safetensors"
    assert "/Users" not in payload["detail"] and "progress" not in payload["detail"]


def test_start_failures_separate_client_mistakes_from_an_unavailable_lane(tmp_path: Path, monkeypatch) -> None:
    """A ValueError/FileNotFoundError out of start is the caller's input → 400
    (a 5xx used to make backoff logic retry something that can never succeed);
    a RuntimeError/TimeoutError stays 503. Both sanitized."""
    client = _client(tmp_path, monkeypatch)

    def mistake(**_):
        raise FileNotFoundError("Reference image 2 could not be read")

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video_start", mistake)
    response = client.post("/api/media-studio/video/start", json={"prompt": "x", "duration_seconds": 2})
    assert response.status_code == 400
    assert response.json()["detail"] == "Reference image 2 could not be read"

    def down(**_):
        raise RuntimeError("Media Studio private input cleanup failed at /Users/liam/comfy/tmp/in.png")

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video_start", down)
    response = client.post("/api/media-studio/video/start", json={"prompt": "x", "duration_seconds": 2})
    assert response.status_code == 503
    assert response.json()["detail"] == "Media Studio private input cleanup failed at in.png"


def test_inline_media_errors_name_the_slot_not_the_wire_field(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    body = {
        "prompt": "x", "duration_seconds": 2,
        "reference_images": [{"image_base64": _png_data_url()}, {"image_base64": "data:image/png;base64,@@not-base64@@"}],
    }
    response = client.post("/api/media-studio/video/start", json=body)
    assert response.status_code == 400
    assert response.json()["detail"] == "Picture 2 is not valid base64"

    monkeypatch.setattr("hivemind_content_studio.control_api._MAX_PRIVATE_VIDEO_BYTES", 16)
    clip = "data:video/mp4;base64," + base64.b64encode(b"\x00\x00\x00\x18ftypisom" + b"v" * 64).decode("ascii")
    response = client.post("/api/media-studio/video/start", json={
        "prompt": "x", "duration_seconds": 2, "reference_videos": [{"video_base64": clip}],
    })
    assert response.status_code == 400
    assert response.json()["detail"].startswith("Motion clip 1 is too large; max ")
    voice = "data:audio/wav;base64," + base64.b64encode(b"RIFF" + b"\x00" * 40).decode("ascii")
    monkeypatch.setattr("hivemind_content_studio.control_api._MAX_PRIVATE_AUDIO_BYTES", 8)
    response = client.post("/api/media-studio/video/start", json={
        "prompt": "x", "duration_seconds": 2, "reference_audios": [{"audio_base64": voice}],
    })
    assert response.status_code == 400
    assert response.json()["detail"].startswith("Voice clip 1 is too large; max ")


def test_validation_errors_are_one_sentence_not_an_array(tmp_path: Path, monkeypatch) -> None:
    """Every studio wrapper does ``payload.detail || …``; FastAPI's default
    array rendered as ``[object Object]``. The structured list stays under
    ``errors`` and never echoes the input (it can be a prompt or a picture)."""
    client = _client(tmp_path, monkeypatch)
    response = client.post("/api/media-studio/video/start", json={"prompt": "secret words", "steps": 101, "duration_seconds": 99})
    assert response.status_code == 422
    payload = response.json()
    assert isinstance(payload["detail"], str)
    assert "steps:" in payload["detail"] and "duration_seconds:" in payload["detail"] and " · " in payload["detail"]
    assert isinstance(payload["errors"], list) and payload["errors"]
    assert "secret words" not in response.text
    assert all("input" not in error for error in payload["errors"])


def test_an_unexpected_exception_is_json_without_the_exception_text(tmp_path: Path, monkeypatch) -> None:
    def explode():
        raise RuntimeError("boom at /Users/liam/private.txt")

    monkeypatch.setattr("hivemind_content_studio.control_api.unified_runtime_snapshot", explode)
    client = _client(tmp_path, monkeypatch, raise_server_exceptions=False)
    response = client.get("/api/runtime")
    assert response.status_code == 500
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"detail": "The studio server hit an unexpected error. Check the control API log."}
    assert "private.txt" not in response.text


def test_run_retry_and_create_map_store_errors_to_4xx(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: api\nlane: static-text-ad\nscenes:\n  - overlay: Test\n", encoding="utf-8")
    # A step id the run does not have used to be a plain-text 500.
    run = client.post("/api/runs", json={"title": "t", "lane": "static-text-ad", "concept": "c", "scenes": [{"overlay": "x"}]})
    if run.status_code == 201:
        retry = client.post(f"/api/runs/{run.json()['run_id']}/retry", json={"step_id": "nope"})
        assert retry.status_code in {400, 404}, retry.text
        assert isinstance(retry.json()["detail"], str)


def test_the_opengen_bridge_proxy_names_a_timeout_and_answers_both_keys(tmp_path: Path, monkeypatch) -> None:
    """The bridge shim reads ``error``, the studio wrappers read ``detail``;
    a 190 s timeout used to be a bare "unavailable"."""
    client = _client(tmp_path, monkeypatch)

    def timed_out(request, timeout=None):
        raise urllib.error.URLError(TimeoutError("timed out"))

    monkeypatch.setattr("hivemind_content_studio.control_api.urllib.request.urlopen", timed_out)
    response = client.get("/local-ai/models")
    assert response.status_code == 503
    payload = response.json()
    assert payload["detail"] == payload["error"] == "The local inference bridge did not answer within 190 s"

    def refused(request, timeout=None):
        raise urllib.error.URLError(ConnectionRefusedError(61, "refused"))

    monkeypatch.setattr("hivemind_content_studio.control_api.urllib.request.urlopen", refused)
    payload = client.get("/local-ai/models").json()
    assert payload["detail"] == payload["error"] == "The local inference bridge is unavailable"


# ── the sign-in contract ─────────────────────────────────────────────────────

def test_machine_routes_answer_a_missing_session_in_the_gate_shape(tmp_path: Path, monkeypatch) -> None:
    """An expired browser session on generate/poll used to get "Valid operator
    bearer token required" (or a 503 about an unconfigured token) with no
    ``privacy`` key. Now it is the same 401 the middleware gives everywhere."""
    client = _client(tmp_path, monkeypatch, unlock=False)
    locked = {"detail": "Sign in to a workspace", "privacy": "account-locked"}
    start = client.post("/api/media-studio/video/start", json={"prompt": "x"})
    assert start.status_code == 401 and start.json() == locked
    poll = client.get("/api/media-studio/video/job/some-job")
    assert poll.status_code == 401 and poll.json() == locked
    # A bearer that IS presented but wrong still gets the operator answer.
    wrong = client.post("/api/media-studio/video/start", json={"prompt": "x"}, headers={"Authorization": "Bearer nope"})
    assert wrong.status_code == 401 and wrong.json()["detail"] == "Valid operator bearer token required"


def test_the_session_slides_once_past_half_its_life(tmp_path: Path, monkeypatch) -> None:
    """A fixed 24 h cookie written only at sign-in broke a day-old tab
    mid-generation. Any authenticated request older than 12 h re-issues it,
    and /api/accounts reports the REAL remaining seconds."""
    client = _client(tmp_path, monkeypatch, unlock=False)
    access = AccountAccess(signing_secret=PrivateFieldCipher.from_secret(_CIPHER_SECRET).derive("account-session-v1"))
    thirteen_hours_ago = int(time.time()) - 13 * 3600
    client.cookies.set(ACCOUNT_COOKIE, access.issue(1, now=thirteen_hours_ago))

    listing = client.get("/api/accounts")
    assert listing.status_code == 200 and listing.json()["signed_in_as"] == 1
    remaining = listing.json()["expires_in_seconds"]
    assert 10 * 3600 < remaining <= 11 * 3600 + 5
    assert ACCOUNT_COOKIE in listing.headers.get("set-cookie", ""), "an old session must be re-issued"
    assert "SameSite=lax" in listing.headers["set-cookie"]

    # The fresh cookie is a full session again and is NOT re-issued yet.
    again = client.get("/api/accounts")
    assert again.json()["expires_in_seconds"] > SESSION_SECONDS - 60
    assert "set-cookie" not in again.headers
    # And a young session reports its real remaining time at /api/owner/session too.
    assert client.get("/api/owner/session").json()["expires_in_seconds"] > SESSION_SECONDS - 60


def test_a_signed_out_rename_is_401_like_its_sibling_delete(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch, unlock=False)
    response = client.post("/api/accounts/1/rename", json={"name": "x"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Sign in to a workspace"


def test_the_throttle_keys_on_the_forwarded_browser_and_speaks_in_minutes(tmp_path: Path, monkeypatch) -> None:
    """Behind the tailnet proxy every browser shares one socket address: five
    wrong passwords from ANY device locked the owner tile for everyone.

    The forwarded address is believed only from the proxy that carries the
    stack's shared secret — otherwise the caller chooses its own bucket, which
    is the same thing as having no throttle at all.
    """
    monkeypatch.setenv(PROXY_SECRET_ENV, "test-proxy-secret")
    client = _client(tmp_path, monkeypatch, unlock=False)
    proxy = {PROXY_SECRET_HEADER: "test-proxy-secret"}
    for _ in range(5):
        assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": "wrong"},
                           headers={"x-forwarded-for": "100.64.0.7, 10.0.0.1", **proxy}).status_code == 401
    blocked = client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD},
                          headers={"x-forwarded-for": "100.64.0.7, 10.0.0.1", **proxy})
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == "Too many attempts. Try again in 10 minutes."
    # A different browser behind the same proxy is not locked out.
    other = client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD},
                        headers={"x-forwarded-for": "100.64.0.8", **proxy})
    assert other.status_code == 200


def test_a_forwarded_address_from_an_unproven_caller_is_not_believed(tmp_path: Path, monkeypatch) -> None:
    """Without the proxy secret the header is just something anyone can write,
    and the five-attempt lock must key on the socket address instead."""
    monkeypatch.setenv(PROXY_SECRET_ENV, "test-proxy-secret")
    client = _client(tmp_path, monkeypatch, unlock=False)
    for attempt in range(5):
        assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": "wrong"},
                           headers={"x-forwarded-for": f"100.64.0.{attempt}"}).status_code == 401
    rotated = client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD},
                          headers={"x-forwarded-for": "100.64.0.99"})
    assert rotated.status_code == 429


def test_rotating_the_forwarded_address_still_locks_the_workspace(tmp_path: Path, monkeypatch) -> None:
    """The per-address key can be moved by whoever is asking; the per-workspace
    one cannot. Twenty wrong passwords from twenty invented addresses — the
    shape a rebinding page brute-forces with — and the workspace stops
    answering."""
    monkeypatch.setenv(PROXY_SECRET_ENV, "test-proxy-secret")
    client = _client(tmp_path, monkeypatch, unlock=False)
    proxy = {PROXY_SECRET_HEADER: "test-proxy-secret"}
    for attempt in range(20):
        assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": "wrong"},
                           headers={"x-forwarded-for": f"100.64.1.{attempt}", **proxy}).status_code == 401
    for attempt in range(20, 25):
        refused = client.post("/api/accounts/unlock", json={"account_id": 1, "password": "wrong"},
                              headers={"x-forwarded-for": f"100.64.1.{attempt}", **proxy})
        assert refused.status_code == 429
    # Even with the right password, and even from an address that never failed.
    assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD},
                       headers={"x-forwarded-for": "100.64.2.1", **proxy}).status_code == 429


def test_a_page_on_another_site_cannot_reach_the_studio(tmp_path: Path, monkeypatch) -> None:
    """Two doors, both shut. A name this studio does not answer to is refused
    before the sign-in routes see it (that is DNS rebinding), and an unsafe
    method whose Origin belongs to another site is refused whatever the cookie
    says (that is a cross-site POST)."""
    client = _client(tmp_path, monkeypatch, unlock=False)
    rebound = client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD},
                          headers={"host": "evil.example"})
    assert rebound.status_code == 400
    cross_site = client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD},
                             headers={"origin": "https://evil.example"})
    assert cross_site.status_code == 400
    assert "another site" in cross_site.json()["detail"]
    # The studio's own page, on the address it is served from, is untouched.
    assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD},
                       headers={"origin": "http://127.0.0.1:8765"}).status_code == 200


def test_the_tailnet_origin_is_recognised_through_the_proxy(tmp_path: Path, monkeypatch) -> None:
    """Over the tailnet the browser's Origin is the ts.net name while Host has
    already been rewritten to 127.0.0.1, so the only thing that can vouch for
    it is the proxy — and only the proxy."""
    monkeypatch.setenv(PROXY_SECRET_ENV, "test-proxy-secret")
    client = _client(tmp_path, monkeypatch, unlock=False)
    tailnet = {"origin": "https://studio.tailnet.example:8789",
               "x-forwarded-host": "studio.tailnet.example:8789"}
    assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD},
                       headers={**tailnet, PROXY_SECRET_HEADER: "test-proxy-secret"}).status_code == 200
    assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD},
                       headers=tailnet).status_code == 400


def test_hashed_assets_are_cacheable_and_everything_else_is_not(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    asset = client.get("/assets/index-not-built.js")
    assert asset.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert client.get("/api/accounts").headers["cache-control"] == "no-store"


# ── history ──────────────────────────────────────────────────────────────────

def test_canvas_history_reindexes_at_most_every_few_seconds_unless_refreshed(tmp_path: Path, monkeypatch) -> None:
    calls = {"n": 0}

    def fetch():
        calls["n"] += 1
        return []

    client = _client(tmp_path, monkeypatch, canvas_history_fetcher=fetch)
    assert client.get("/api/canvas/history").status_code == 200
    assert client.get("/api/canvas/history").status_code == 200
    assert calls["n"] == 1, "a poll inside the TTL must not walk the gateway again"
    assert client.get("/api/canvas/history?refresh=1").status_code == 200
    assert calls["n"] == 2
    # Page 2 never re-indexes.
    assert client.get("/api/canvas/history?page=2").status_code == 200
    assert calls["n"] == 2


def test_deleting_an_output_that_is_already_gone_is_a_404_and_clears_the_row(tmp_path: Path, monkeypatch) -> None:
    piece = tmp_path / "gone-later.png"
    piece.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    records = [{"id": "job-1", "status": "success", "created_at": "2026-08-21T00:00:00+00:00",
                "finished_at": "2026-08-21T00:00:00+00:00", "outputs": [str(piece)]}]
    client = _client(
        tmp_path, monkeypatch,
        canvas_history_fetcher=lambda: [dict(record) for record in records],
        canvas_delete_fetcher=lambda name: {"ok": True, "deleted_files": 0, "history_records": 0},
    )
    listing = client.get("/api/canvas/history").json()
    history_id = listing["history"][0]["history_id"]
    gone = client.request("DELETE", f"/api/canvas/history/{history_id}", json={"confirm": True})
    assert gone.status_code == 404
    assert "already gone" in gone.json()["detail"]
    records.clear()
    assert client.get("/api/canvas/history?refresh=1").json()["history"] == []


# ── request bounds and warnings ──────────────────────────────────────────────

def test_a_shortened_ingredient_note_is_reported_not_silently_cut(tmp_path: Path, monkeypatch) -> None:
    captured: dict = {}

    def fake_start(**kwargs):
        captured.update(kwargs)
        return {"job_id": "job-warn-1", "uploaded_names": [], "provider": "Media Studio"}

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video_start", fake_start)
    # The background finisher must land, or the test client waits on it forever.
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.run_media_studio_video_finish",
        lambda job_id, **_: {"job_id": job_id, "provider": "Media Studio", "gateway_output": "warn.mp4.e2e"},
    )
    client = _client(tmp_path, monkeypatch)
    response = client.post("/api/media-studio/video/start", json={
        "prompt": "x", "duration_seconds": 2,
        "ingredient_images": [{"image_base64": _png_data_url(), "description": "d" * 1200}],
    })
    assert response.status_code == 200, response.text
    assert response.json()["warnings"] == ["Ingredient 1's note was shortened to 1000 characters."]
    assert len(captured["ingredient_images"][0]["description"]) == 1000


def test_audio_uploads_share_the_inline_voice_clip_limit(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("hivemind_content_studio.control_api._MAX_PRIVATE_AUDIO_BYTES", 64)
    client = _client(tmp_path, monkeypatch)
    response = client.post(
        "/api/media-studio/references",
        files={"file": ("voice.wav", b"RIFF" + b"\x00" * 200, "audio/wav")},
    )
    assert response.status_code == 413
    assert "too large" in response.json()["detail"]


def test_prompt_helper_and_lane_snapshots_carry_ok(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("hivemind_content_studio.control_api.comfy_lanes.snapshot", lambda: {"lanes": []})

    class _Runtime:
        def snapshot(self):
            return {"available": False, "models": [], "loaded": []}

    monkeypatch.setattr("hivemind_content_studio.control_api.local_llm.runtime", lambda: _Runtime())
    client = _client(tmp_path, monkeypatch)
    assert client.get("/api/lanes/memory").json() == {"ok": True, "lanes": []}
    assert client.get("/api/prompt-helper/runtime").json()["ok"] is True


# ── rentals: money ───────────────────────────────────────────────────────────

def _fake_vast(monkeypatch, handler):
    monkeypatch.setattr(runpod_provider.RunPodProvider, "configured", lambda self: False)
    monkeypatch.setattr(vast_provider, "request", handler)
    monkeypatch.setenv("VAST_API_KEY", "test-vast-key")
    monkeypatch.setattr(gpu_rentals, "account_state", lambda *_a, **_k: {
        "credit": 500.0, "usd_per_hour_running": 0.0, "hours_remaining": None, "machines_running": 0,
        "providers": [{"provider": "vast", "label": "Vast.ai", "credit_url": "vast.ai", "credit": 500.0,
                       "usd_per_hour_running": 0.0, "hours_remaining": None, "machines_running": 0}],
    })
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}?sig=x")
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", Path("/nonexistent-media-state"))
    gpu_rentals._offer_cache.clear()
    gpu_rentals._rental_requests.clear()
    gpu_rentals._rentals_in_flight.clear()


def test_a_rental_request_id_is_replayed_not_re_rented(tmp_path: Path, monkeypatch, rental_manifest) -> None:
    rents = {"n": 0}

    def handler(method, path, payload=None):
        if path == "/v0/bundles/":
            return {"offers": [{"id": 77, "dph_total": 0.4}]}
        rents["n"] += 1
        return {"new_contract": 4242, "success": True}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    first = client.post("/api/gpu-rentals", json={"tier": "image", "request_id": "click-1"})
    assert first.status_code == 201, first.text
    second = client.post("/api/gpu-rentals", json={"tier": "image", "request_id": "click-1"})
    assert second.status_code == 201
    assert second.json()["rental_id"] == first.json()["rental_id"]
    assert rents["n"] == 1, "the replay must not reach the marketplace"
    # A different click rents again.
    assert client.post("/api/gpu-rentals", json={"tier": "image", "request_id": "click-2"}).status_code == 201
    assert rents["n"] == 2


def test_one_rental_in_flight_per_tier(tmp_path: Path, monkeypatch, rental_manifest) -> None:
    gate = threading.Event()
    entered = threading.Event()

    def handler(method, path, payload=None):
        if path == "/v0/bundles/":
            return {"offers": [{"id": 77, "dph_total": 0.4}]}
        entered.set()
        gate.wait(timeout=10)
        return {"new_contract": 4242, "success": True}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    outcome: dict = {}

    def slow_rent():
        outcome["first"] = client.post("/api/gpu-rentals", json={"tier": "image"})

    worker = threading.Thread(target=slow_rent)
    worker.start()
    assert entered.wait(timeout=10)
    duplicate = client.post("/api/gpu-rentals", json={"tier": "image"})
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == "A rental is already being placed for this tier — wait for it to appear in the list"
    gate.set()
    worker.join(timeout=10)
    assert outcome["first"].status_code == 201
    # The lock is released once the rent lands.
    assert client.post("/api/gpu-rentals", json={"tier": "image"}).status_code == 201


def test_rental_count_and_marketplace_outages_are_not_500s(tmp_path: Path, monkeypatch) -> None:
    def offline(method, path, payload=None):
        raise requests.ConnectionError("no route to host")

    _fake_vast(monkeypatch, offline)
    client = _client(tmp_path, monkeypatch)
    bad_count = client.post("/api/gpu-rentals", json={"tier": "image", "count": "two"})
    assert bad_count.status_code == 400
    assert bad_count.json()["detail"] == "count must be a whole number"
    offers = client.get("/api/gpu-rentals/offers?tier=image")
    assert offers.status_code == 503
    assert offers.json()["detail"] == "The GPU marketplace is unreachable"


def test_a_marketplace_error_page_is_named_not_pasted() -> None:
    html = '<!DOCTYPE html><html lang="en"><head><title>Cloudflare</title>…'
    assert response_error_text(html, 503) == "the marketplace returned an error page (HTTP 503)"
    assert response_error_text("rate limited", 429) == "rate limited"
    assert response_error_text("", 502) == "HTTP 502"


def test_the_bridge_proxy_exposes_the_image_job_cancel_route(tmp_path: Path, monkeypatch) -> None:
    """The Image studio's Cancel reaches the gateway through the bridge's
    ``POST /local-ai/job/<id>/cancel`` — same-origin via control_api, so the
    allowlist has to grant the two-segment path (and only for POST)."""
    client = _client(tmp_path, monkeypatch)
    seen: dict[str, str] = {}

    class _Upstream:
        status = 200
        headers = {"content-type": "application/json"}

        def read(self) -> bytes:
            return b'{"ok": true, "status": "cancelled", "id": "zimg-1", "known": true, "interrupted": true, "stopped": false}'

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    def fake_urlopen(request, timeout=0):  # noqa: ARG001
        seen["url"] = request.full_url
        seen["method"] = request.method
        return _Upstream()

    monkeypatch.setattr("hivemind_content_studio.control_api.urllib.request.urlopen", fake_urlopen)
    cancelled = client.post("/local-ai/job/zimg-1/cancel")
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"
    assert seen == {"url": "http://127.0.0.1:8794/local-ai/job/zimg-1/cancel", "method": "POST"}
    # Neither a GET on it nor a deeper path is granted.
    assert client.get("/local-ai/job/zimg-1/cancel").status_code == 404
    assert client.post("/local-ai/job/zimg-1/cancel/extra").status_code == 404
