"""The Restore studio's control-API surface.

These routes are a proxy: every decision about a restoration belongs to the
media gateway. What belongs HERE, and is therefore what these tests are about,
is the owner gate, the gateway token never reaching the browser, and the two
places a proxy is allowed an opinion — an unreachable gateway must degrade to
"no machine can restore" rather than an error page, and a gateway refusal must
keep its own words so the studio can put the action beside the sentence.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio import video_restore
from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore


class _FakeGateway:
    """Stands in for the media gateway. Records what the proxy actually sent."""

    def __init__(self, *, answers=None, error=None):
        self.answers = answers or {}
        self.error = error
        self.calls: list[tuple[str, str, dict | None]] = []

    def request(self, path, *, method="GET", body=None, timeout=None):
        self.calls.append((method, path, body))
        if self.error:
            raise self.error
        return self.answers.get(path, {"ok": True})

    def media(self, path, *, timeout=None):
        self.calls.append(("GET", path, None))
        if self.error:
            raise self.error
        return b"\x00\x00\x00\x18ftypisom", "video/mp4"


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        approvals=ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret"),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="test-owner-password", cipher=cipher),
        private_cipher=cipher,
    )
    test_client = TestClient(app)
    assert test_client.post("/api/accounts/unlock", json={"account_id": 1, "password": "test-owner-password"}).status_code == 200
    return test_client


def _install(monkeypatch, gateway):
    monkeypatch.setattr(video_restore, "client", lambda: gateway)
    return gateway


def _client_for(monkeypatch, tmp_path: Path | None = None) -> TestClient:
    """An unlocked owner client, for the tests that cannot use the fixture.

    The `client` fixture takes tmp_path itself, and a test that also needs to
    monkeypatch something the app reads AT BUILD time has to build its own."""
    import tempfile

    root = tmp_path or Path(tempfile.mkdtemp())
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(root / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(root / "state.sqlite3")),
        approvals=ApprovalLedger(
            root / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret"),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="test-owner-password", cipher=cipher),
        private_cipher=cipher,
    )
    test_client = TestClient(app)
    assert test_client.post("/api/accounts/unlock", json={"account_id": 1, "password": "test-owner-password"}).status_code == 200
    return test_client


def test_every_restore_route_is_behind_the_owner_gate(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        approvals=ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret"),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="test-owner-password", cipher=cipher),
        private_cipher=cipher,
    )
    locked = TestClient(app)
    _install(monkeypatch, _FakeGateway())
    for method, path in [
        ("GET", "/api/restore/capabilities"),
        ("GET", "/api/restore/projects"),
        ("GET", "/api/restore/project/p1"),
        ("GET", "/api/restore/source/p1"),
        ("POST", "/api/restore"),
        ("POST", "/api/restore/plan"),
        ("POST", "/api/restore/finish"),
        ("POST", "/api/restore/cancel/p1"),
        ("POST", "/api/restore/delete/p1"),
    ]:
        response = locked.request(method, path, json={} if method == "POST" else None)
        assert response.status_code in (401, 403), f"{method} {path} answered {response.status_code} while locked"


def test_capabilities_reach_the_studio_unchanged(client, monkeypatch) -> None:
    gateway = _install(monkeypatch, _FakeGateway(answers={
        "/api/restore/capabilities": {
            "any": True,
            "lanes": [
                {"lane": "default", "paid": False, "available": True, "assembles_here": True},
                {"lane": "rental7", "paid": True, "available": True, "assembles_here": False},
            ],
        },
    }))
    body = client.get("/api/restore/capabilities").json()
    assert body["ok"] is True
    assert [lane["lane"] for lane in body["lanes"]] == ["default", "rental7"]
    # Which lane costs money is the gateway's answer, not this proxy's opinion.
    assert [lane["paid"] for lane in body["lanes"]] == [False, True]
    assert gateway.calls == [("GET", "/api/restore/capabilities", None)]


def test_an_unreachable_gateway_says_no_machine_rather_than_failing(client, monkeypatch) -> None:
    # The Restore studio OPENS on this call. A 503 here would be an empty screen
    # with a stack trace behind it; "nothing can restore right now" is a screen.
    _install(monkeypatch, _FakeGateway(error=video_restore.RestoreError(
        "The media gateway is not answering.", remedy="start-stack", status_code=503)))
    response = client.get("/api/restore/capabilities")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["any"] is False and body["lanes"] == []
    assert body["remedy"] == "start-stack"

    # The project list degrades the same way, for the same reason.
    listed = client.get("/api/restore/projects")
    assert listed.status_code == 200
    assert listed.json()["projects"] == []


def test_a_gateway_refusal_keeps_its_own_words_and_its_remedy(client, monkeypatch) -> None:
    _install(monkeypatch, _FakeGateway(error=video_restore.RestoreError(
        "the rented machine this job is pinned to (vast:9) is no longer attached",
        remedy="pick-machine", status_code=409)))
    response = client.post("/api/restore", json={"video_base64": "AA=="})
    assert response.status_code == 409
    detail = response.json()["detail"]
    # An action beside the sentence: a message with nothing to press is a dead end.
    assert "no longer attached" in detail["error"]
    assert detail["remedy"] == "pick-machine"


def test_the_start_body_is_passed_through_rather_than_re_modelled(client, monkeypatch) -> None:
    # A second schema here would be a second place for the defaults to drift
    # from the gateway's, and the gateway is the one that renders.
    gateway = _install(monkeypatch, _FakeGateway(answers={
        "/api/restore": {"id": "job1", "project_id": "p9", "status": "queued"},
    }))
    sent = {"video_base64": "AA==", "batch_size": 9, "resolution": "4k", "run_on": "vast:7"}
    body = client.post("/api/restore", json=sent).json()
    assert body["project_id"] == "p9"
    method, path, forwarded = gateway.calls[0]
    assert (method, path) == ("POST", "/api/restore")
    assert forwarded == sent


def test_a_plan_request_with_a_nonsense_frame_count_is_refused_here(client, monkeypatch) -> None:
    # These numbers come from a <video> element, but they decide how many chunks
    # the gateway plans; a zero or a negative is a 422, not a project.
    _install(monkeypatch, _FakeGateway())
    for bad in ({"frames": 0, "width": 640, "height": 360},
                {"frames": 100, "width": 0, "height": 360},
                {"frames": 100, "width": 640, "height": 360, "fps": 0}):
        assert client.post("/api/restore/plan", json=bad).status_code == 422


def test_deleting_a_project_forwards_the_confirmation_rather_than_assuming_it(client, monkeypatch) -> None:
    gateway = _install(monkeypatch, _FakeGateway())
    client.post("/api/restore/delete/p1", json={})
    assert gateway.calls[-1] == ("POST", "/api/restore/delete/p1", {"confirm": False})
    client.post("/api/restore/delete/p1", json={"confirm": True})
    assert gateway.calls[-1] == ("POST", "/api/restore/delete/p1", {"confirm": True})


def test_the_source_clip_comes_back_as_video_not_json(client, monkeypatch) -> None:
    _install(monkeypatch, _FakeGateway())
    response = client.get("/api/restore/source/p1")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("video/mp4")
    # Never cached: it is the owner's footage, and this is a private surface.
    assert "no-store" in response.headers.get("cache-control", "")


def test_a_missing_project_is_a_404_and_not_a_bare_gateway_error(client, monkeypatch) -> None:
    _install(monkeypatch, _FakeGateway(error=video_restore.RestoreError(
        "no such restoration project", status_code=404)))
    response = client.get("/api/restore/project/nope")
    assert response.status_code == 404
    assert "no such restoration project" in response.json()["detail"]["error"]


# --- the hosted lane's one extra responsibility -------------------------------
#
# Everything else on these routes is a pass-through. The hosted lane is not: the
# gateway runs the chunk loop and therefore has to hold the owner's credit token
# while a render is in flight, and this process is the only one that can read it.
# So the proxy grows exactly one opinion, and these are its edges.


def test_the_credit_token_is_attached_only_for_the_hosted_lane(monkeypatch) -> None:
    gateway = _FakeGateway(answers={"/api/restore": {"ok": True, "project_id": "r1"}})
    _install(monkeypatch, gateway)
    monkeypatch.setattr(
        "hivemind_content_studio.hivemindos_models.credit_token", lambda: "hmos_credit_secret")
    client_ = _client_for(monkeypatch)

    client_.post("/api/restore", json={"run_on": "cloud", "model": "m"})
    client_.post("/api/restore", json={"run_on": "default", "model": "m"})
    client_.post("/api/restore", json={"model": "m"})

    bodies = [body for method, path, body in gateway.calls if path == "/api/restore"]
    assert bodies[0]["credit_token"] == "hmos_credit_secret"
    # A local or rented render has nothing to charge, so it is not handed a key
    # to the balance. The gateway keeps this in memory for the render's life;
    # sending it where it is not needed is a copy that did not have to exist.
    assert "credit_token" not in bodies[1]
    assert "credit_token" not in bodies[2]


def test_a_hosted_render_with_no_account_is_refused_before_anything_is_uploaded(monkeypatch) -> None:
    gateway = _FakeGateway()
    _install(monkeypatch, gateway)
    monkeypatch.setattr("hivemind_content_studio.hivemindos_models.credit_token", lambda: "")
    client_ = _client_for(monkeypatch)

    response = client_.post("/api/restore", json={"run_on": "cloud", "video_base64": "AAAA"})
    assert response.status_code == 402
    detail = response.json()["detail"]
    # The action beside the sentence: "payment required" with nothing to press
    # is a dead end, and this one is fixable in Settings.
    assert detail["remedy"] == "connect"
    assert "Connect your HivemindOS account" in detail["error"]
    # And the clip never left: the gateway was not called at all.
    assert gateway.calls == []


def test_the_hosted_lane_is_marked_unavailable_when_no_account_is_connected(monkeypatch) -> None:
    gateway = _FakeGateway(answers={"/api/restore/capabilities": {
        "lanes": [
            {"lane": "default", "paid": False, "available": True},
            {"lane": "cloud", "paid": True, "available": True},
        ],
        "any": True,
    }})
    _install(monkeypatch, gateway)
    monkeypatch.setattr("hivemind_content_studio.hivemindos_models.credit_token", lambda: "")
    client_ = _client_for(monkeypatch)

    lanes = {lane["lane"]: lane for lane in client_.get("/api/restore/capabilities").json()["lanes"]}
    assert lanes["cloud"]["connected"] is False
    # Offered as unavailable WITH the fix, rather than offered as available and
    # failing with a 401 once the first chunk has already been cut.
    assert lanes["cloud"]["available"] is False
    assert lanes["cloud"]["remedy"] == "connect"
    # The free lane is untouched by any of this.
    assert lanes["default"]["available"] is True
    assert "connected" not in lanes["default"]


def test_a_connected_account_leaves_the_hosted_lane_as_the_gateway_reported_it(monkeypatch) -> None:
    gateway = _FakeGateway(answers={"/api/restore/capabilities": {
        "lanes": [{"lane": "cloud", "paid": True, "available": True, "metered": "per-render"}],
        "any": True,
    }})
    _install(monkeypatch, gateway)
    monkeypatch.setattr(
        "hivemind_content_studio.hivemindos_models.credit_token", lambda: "hmos_credit_secret")
    client_ = _client_for(monkeypatch)

    lane = client_.get("/api/restore/capabilities").json()["lanes"][0]
    assert lane["available"] is True
    assert lane["connected"] is True
    assert lane["metered"] == "per-render"
