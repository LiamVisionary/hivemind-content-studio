"""ComfyUI is optional: the studio boots, reports, and sells cloud work without it.

The blocker this covers (`startup-02-comfyui-checkout-is-mandatory-no-degraded-mode`)
was that the supervisor refused to bring anything up until an external ComfyUI
checkout answered on :8188, so a machine without one never saw the app. The
inverted contract is asserted here: the runtime endpoint reports ComfyUI offline
without raising, the media catalog still serves its cloud rows, and connecting
one is an attach — never an edit of somebody else's install.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio import comfy_connect
from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.media_catalog import media_catalog
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore
from hivemind_content_studio.unified_runtime import unified_runtime_snapshot


def _owner_client(tmp_path: Path, monkeypatch) -> TestClient:
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
    assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": "test-owner-password"}).status_code == 200
    return client


def test_the_runtime_endpoint_reports_comfyui_offline_without_raising() -> None:
    """Nothing answers anywhere. That is a report, not an exception."""
    snapshot = unified_runtime_snapshot(environ={}, probe=lambda url: False)

    assert snapshot["ok"] is True
    comfy = next(item for item in snapshot["engines"] if item["id"] == "comfyui")
    assert comfy["status"] == "offline"
    # The studio surface itself stays online: the app is up, one engine is not.
    assert snapshot["surface"]["status"] == "online"
    assert snapshot["summary"]["offline"] >= 1


def test_the_catalog_still_serves_cloud_rows_with_no_local_engine(monkeypatch) -> None:
    """A machine with no ComfyUI still has a shop. `available` is a per-row
    flag, and the cloud rows are the ones that make the studio usable there."""
    monkeypatch.setattr(
        "hivemind_content_studio.media_catalog.provider_report",
        lambda: [
            {"id": "comfyui", "available": False, "detail": "ComfyUI is not connected"},
            {"id": "muapi", "available": True, "detail": "MUAPI key present"},
        ],
    )

    catalog = media_catalog()
    rows = catalog["image"] + catalog["video"]
    by_id = {row["id"]: row for row in rows}

    assert by_id["comfyui"]["available"] is False
    # Not empty: an unreachable engine still lists what it would run, so the
    # picker can show it as "Connect ComfyUI" instead of hiding the feature.
    assert by_id["comfyui"]["models"]
    assert by_id["muapi"]["available"] is True
    assert by_id["muapi"]["models"]


def test_detection_only_reads_and_never_writes(tmp_path, monkeypatch) -> None:
    """The rule the finding was opened for: never modify a checkout the app did
    not create. Detection stats a directory; it does not touch it."""
    checkout = tmp_path / "comfy" / "ComfyUI"
    checkout.mkdir(parents=True)
    (checkout / "main.py").write_text("# somebody else's ComfyUI\n", encoding="utf-8")
    before = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*"))

    monkeypatch.setattr(comfy_connect.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("COMFY_DIR", raising=False)
    monkeypatch.delenv("COMFY", raising=False)

    found = comfy_connect.detect_installs()

    assert [entry["path"] for entry in found] == [str(checkout)]
    assert found[0]["kind"] == "checkout"
    assert sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*")) == before


def test_the_desktop_application_is_detected_but_not_started(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(comfy_connect.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("COMFY_DIR", raising=False)
    monkeypatch.delenv("COMFY", raising=False)
    desktop = tmp_path / "Documents" / "ComfyUI"
    desktop.mkdir(parents=True)
    (desktop / "main.py").write_text("", encoding="utf-8")

    found = comfy_connect.detect_installs()

    assert [entry["source"] for entry in found] == ["desktop"]
    # Every sentence points at the user's own ComfyUI, never at an action this
    # app would take inside it.
    assert "Start it yourself" in found[0]["detail"]


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("127.0.0.1:8188", "http://127.0.0.1:8188"),
        ("http://127.0.0.1:8000/", "http://127.0.0.1:8000"),
        ("  http://box.local:8188  ", "http://box.local:8188"),
    ],
)
def test_a_pasted_address_is_normalized(raw: str, expected: str) -> None:
    assert comfy_connect.normalize_url(raw) == expected


@pytest.mark.parametrize("raw", ["", "   ", "ftp://127.0.0.1:8188"])
def test_an_unusable_address_is_refused_with_the_fix_in_the_sentence(raw: str) -> None:
    with pytest.raises(comfy_connect.ConnectError) as caught:
        comfy_connect.normalize_url(raw)
    assert "8188" in str(caught.value)


def test_attaching_writes_only_this_apps_own_state(tmp_path, monkeypatch) -> None:
    registry = tmp_path / "comfy-attachments.json"
    monkeypatch.setattr(comfy_connect, "attachments_path", lambda: registry)
    monkeypatch.setattr(comfy_connect, "probe_url", lambda url, timeout=3.0: {
        "reachable": True, "detail": "ComfyUI answered", "version": "0.3.60",
    })

    comfy_connect.attach("127.0.0.1:8000")

    written = json.loads(registry.read_text(encoding="utf-8"))
    assert written["default"]["url"] == "http://127.0.0.1:8000"
    assert comfy_connect.lane_urls()["default"] == "http://127.0.0.1:8000"
    # The only path written is inside the app's own state root.
    assert Path(registry).parent == tmp_path


def test_attaching_a_dead_address_is_refused_rather_than_remembered(tmp_path, monkeypatch) -> None:
    """An attachment that silently does not work comes back later as an
    unexplained "Generate failed" — which is the failure this item removes."""
    registry = tmp_path / "comfy-attachments.json"
    monkeypatch.setattr(comfy_connect, "attachments_path", lambda: registry)
    monkeypatch.setattr(comfy_connect, "probe_url", lambda url, timeout=3.0: {
        "reachable": False, "detail": "nothing answered there",
    })

    with pytest.raises(comfy_connect.ConnectError) as caught:
        comfy_connect.attach("http://127.0.0.1:9999")

    assert "Start ComfyUI first" in str(caught.value)
    assert not registry.exists()


def test_detaching_restores_the_configured_lane_and_never_empties_the_map(tmp_path, monkeypatch) -> None:
    registry = tmp_path / "comfy-attachments.json"
    monkeypatch.setattr(comfy_connect, "attachments_path", lambda: registry)
    monkeypatch.setattr(comfy_connect, "probe_url", lambda url, timeout=3.0: {
        "reachable": True, "detail": "ComfyUI answered", "version": None,
    })
    monkeypatch.delenv("COMFY_LANES", raising=False)
    monkeypatch.setenv("COMFY_HTTP_DEFAULT", "http://127.0.0.1:8188")

    comfy_connect.attach("http://127.0.0.1:8000")
    assert comfy_connect.lane_urls()["default"] == "http://127.0.0.1:8000"

    comfy_connect.detach("default")
    assert comfy_connect.lane_urls()["default"] == "http://127.0.0.1:8188"


def test_a_lane_this_studio_does_not_route_is_refused(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(comfy_connect, "attachments_path", lambda: tmp_path / "comfy-attachments.json")
    with pytest.raises(comfy_connect.ConnectError) as caught:
        comfy_connect.attach("http://127.0.0.1:8188", lane="somebody-elses-lane")
    assert "default" in str(caught.value)


def test_the_snapshot_names_the_install_link_when_nothing_is_there(tmp_path, monkeypatch) -> None:
    """No ComfyUI anywhere: not an error state, a card with three doors —
    the ones that are running, an address to paste, and where to get one."""
    monkeypatch.setattr(comfy_connect, "attachments_path", lambda: tmp_path / "comfy-attachments.json")
    monkeypatch.setattr(comfy_connect.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("COMFY_DIR", raising=False)
    monkeypatch.delenv("COMFY", raising=False)
    monkeypatch.delenv("COMFY_LANES", raising=False)
    monkeypatch.setenv("COMFY_HTTP_DEFAULT", "http://127.0.0.1:8188")
    monkeypatch.setattr(comfy_connect, "probe_url", lambda url, timeout=3.0: {
        "reachable": False, "detail": "nothing answered there",
    })

    state = comfy_connect.snapshot()

    assert state["connected"] is False
    assert state["detected"] == []
    assert state["running"] == []
    assert state["readOnly"] is True
    assert state["installUrl"].startswith("https://")
    # The lane is still listed, unreachable — never absent. The gateway's read
    # sites assume a default lane exists.
    assert [lane["id"] for lane in state["lanes"]] == ["default"]
    assert state["lanes"][0]["reachable"] is False


def test_the_connect_endpoints_attach_and_detach_a_lane(tmp_path: Path, monkeypatch) -> None:
    """Attaching is one owner-gated POST. It is the whole of "connect" — no
    installer, no writes inside a ComfyUI, no restart."""
    registry = tmp_path / "comfy-attachments.json"
    monkeypatch.setattr(comfy_connect, "attachments_path", lambda: registry)
    monkeypatch.setattr(comfy_connect, "detect_installs", list)
    monkeypatch.setattr(comfy_connect, "discover_running", lambda timeout=1.0: [])
    monkeypatch.setattr(comfy_connect, "probe_url", lambda url, timeout=3.0: {
        "reachable": url == "http://127.0.0.1:8000",
        "detail": "ComfyUI answered" if url == "http://127.0.0.1:8000" else "nothing answered there",
        "version": None,
    })
    client = _owner_client(tmp_path, monkeypatch)

    before = client.get("/api/comfy/connect")
    assert before.status_code == 200
    assert before.json()["connected"] is False

    attached = client.post("/api/comfy/connect", json={"url": "127.0.0.1:8000"})
    assert attached.status_code == 200
    assert attached.json()["connected"] is True
    assert registry.exists()

    detached = client.post("/api/comfy/disconnect", json={"lane": "default"})
    assert detached.status_code == 200
    assert detached.json()["connected"] is False


def test_a_dead_address_is_refused_with_a_sentence_not_a_bare_status(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(comfy_connect, "attachments_path", lambda: tmp_path / "comfy-attachments.json")
    monkeypatch.setattr(comfy_connect, "probe_url", lambda url, timeout=3.0: {
        "reachable": False, "detail": "nothing answered there",
    })
    client = _owner_client(tmp_path, monkeypatch)

    refused = client.post("/api/comfy/connect", json={"url": "http://127.0.0.1:9999"})

    assert refused.status_code == 400
    assert "Start ComfyUI first" in refused.json()["detail"]


def test_the_connect_endpoints_are_owner_only(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(comfy_connect, "attachments_path", lambda: tmp_path / "comfy-attachments.json")
    client = _owner_client(tmp_path, monkeypatch)
    assert client.post("/api/owner/lock").status_code == 200

    assert client.get("/api/comfy/connect").status_code == 401
    assert client.post("/api/comfy/connect", json={"url": "http://127.0.0.1:8188"}).status_code == 401
