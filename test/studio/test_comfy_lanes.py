"""Lane memory reporting: what earns a word in the studio, and what must never
be freed out from under a running job."""

from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from hivemind_content_studio import comfy_lanes
from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore


def _client(tmp_path: Path, monkeypatch, *, unlock: bool = True) -> TestClient:
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
    client = TestClient(app)
    if unlock:
        assert client.post("/api/owner/unlock", json={"password": "test-owner-password"}).status_code == 200
    return client


def test_lane_env_parses_the_same_shape_the_gateway_reads():
    lanes = comfy_lanes.parse_lane_env(
        "anima=http://127.0.0.1:8198,ltx=http://127.0.0.1:8199/",
        default_url="http://127.0.0.1:8188",
    )
    assert lanes == {
        "default": "http://127.0.0.1:8188",
        "anima": "http://127.0.0.1:8198",
        "ltx": "http://127.0.0.1:8199",
    }


def test_lane_env_ignores_junk_without_dropping_the_rest():
    lanes = comfy_lanes.parse_lane_env("ltx=http://127.0.0.1:8199,,garbage,=http://x,name=")
    assert lanes == {"ltx": "http://127.0.0.1:8199"}


def test_an_idle_lane_is_running_but_not_holding():
    # Measured idle ComfyUI: ~0.9 GB. That must not raise a panel.
    with patch.object(comfy_lanes, "_rss_bytes_for_port", return_value=int(0.9 * 1024**3)), \
         patch.object(comfy_lanes, "_is_busy", return_value=False):
        lane = comfy_lanes.lane_state("ltx", "http://127.0.0.1:8199")
    assert lane["running"] is True
    assert lane["holding"] is False
    assert lane["reclaimable"] is False


def test_a_finished_lane_still_holding_models_is_reclaimable():
    with patch.object(comfy_lanes, "_rss_bytes_for_port", return_value=14 * 1024**3), \
         patch.object(comfy_lanes, "_is_busy", return_value=False):
        lane = comfy_lanes.lane_state("ltx", "http://127.0.0.1:8199")
    assert lane["holding"] is True
    assert lane["reclaimable"] is True


def test_a_busy_lane_is_never_offered_up_even_while_holding():
    # Memory crosses the threshold DURING a generation too (measured 16 GB
    # mid-job); offering to unload then would break the running prompt.
    with patch.object(comfy_lanes, "_rss_bytes_for_port", return_value=16 * 1024**3), \
         patch.object(comfy_lanes, "_is_busy", return_value=True):
        lane = comfy_lanes.lane_state("ltx", "http://127.0.0.1:8199")
    assert lane["holding"] is True
    assert lane["reclaimable"] is False


def test_an_unreachable_queue_counts_as_busy():
    with patch.object(comfy_lanes, "_rss_bytes_for_port", return_value=16 * 1024**3), \
         patch.object(comfy_lanes, "_is_busy", return_value=None):
        lane = comfy_lanes.lane_state("ltx", "http://127.0.0.1:8199")
    assert lane["reclaimable"] is False


def test_a_stopped_lane_reports_not_running_without_asking_its_queue():
    with patch.object(comfy_lanes, "_rss_bytes_for_port", return_value=None), \
         patch.object(comfy_lanes, "_is_busy", side_effect=AssertionError("must not probe")):
        lane = comfy_lanes.lane_state("ltx", "http://127.0.0.1:8199")
    assert lane["running"] is False
    assert lane["reclaimable"] is False


def test_freeing_a_busy_lane_is_refused_server_side():
    # The panel checks too, but the lane can pick up a job between poll and
    # click — the request itself has to be the guard.
    with patch.object(comfy_lanes, "configured_lanes", return_value={"ltx": "http://127.0.0.1:8199"}), \
         patch.object(comfy_lanes, "_is_busy", return_value=True):
        try:
            comfy_lanes.free_lane("ltx")
        except comfy_lanes.LaneError as exc:
            assert "working" in str(exc)
        else:
            raise AssertionError("a busy lane must not be freed")


def test_freeing_an_unknown_lane_is_refused():
    with patch.object(comfy_lanes, "configured_lanes", return_value={}):
        try:
            comfy_lanes.free_lane("ltx")
        except comfy_lanes.LaneError as exc:
            assert "unknown lane" in str(exc)
        else:
            raise AssertionError("an unknown lane must not be freed")


def test_a_remote_lane_is_not_weighed_or_freed():
    # A rental lane's memory belongs to someone else's box.
    with patch.object(comfy_lanes, "_rss_bytes_for_port", side_effect=AssertionError("must not probe")):
        lane = comfy_lanes.lane_state("rental", "http://100.64.0.5:8188")
    assert lane["local"] is False
    assert lane["running"] is False

    with patch.object(comfy_lanes, "configured_lanes", return_value={"rental": "http://100.64.0.5:8188"}):
        try:
            comfy_lanes.free_lane("rental")
        except comfy_lanes.LaneError as exc:
            assert "remote" in str(exc)
        else:
            raise AssertionError("a remote lane must not be freed")


def test_lane_routes_require_owner(tmp_path: Path, monkeypatch) -> None:
    # These reach into the machine's running services; the studio gate is the
    # only thing standing between them and anyone who can reach the port.
    client = _client(tmp_path, monkeypatch, unlock=False)
    assert client.get("/api/lanes/memory").status_code == 401
    assert client.post("/api/lanes/free", json={"lane": "ltx"}).status_code == 401


def test_memory_route_returns_the_snapshot(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    snapshot = {"lanes": [{"id": "ltx", "reclaimable": True}], "availableBytes": 1, "kleinAdmissionBytes": 2}
    with patch.object(comfy_lanes, "snapshot", return_value=snapshot):
        response = client.get("/api/lanes/memory")
    assert response.status_code == 200
    assert response.json() == snapshot


def test_free_route_reports_what_it_freed(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    with patch.object(comfy_lanes, "free_lane", return_value={"lane": "ltx", "freedBytes": 14 * 1024**3}) as freed:
        response = client.post("/api/lanes/free", json={"lane": "ltx"})
    assert response.status_code == 200
    assert response.json()["freedBytes"] == 14 * 1024**3
    freed.assert_called_once_with("ltx")


def test_free_route_surfaces_a_refusal_as_400_not_500(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    with patch.object(comfy_lanes, "free_lane", side_effect=comfy_lanes.LaneError("the LTX video lane is working")):
        response = client.post("/api/lanes/free", json={"lane": "ltx"})
    assert response.status_code == 400
    assert "working" in response.json()["detail"]
