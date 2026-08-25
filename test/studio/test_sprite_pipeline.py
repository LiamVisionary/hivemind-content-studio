"""The sprite pipeline's server half: the capability matrix route and the
SAM3 matte proxy.

Frame extraction and sheet packing are deliberately absent — they happen in the
browser on a clip it is already playing, so no frame is ever uploaded or
written to disk. The only thing the server does in this pipeline is hold the
SAM3 round-trip, and the only thing it must never do is keep a copy.
"""

from __future__ import annotations

import base64
import io
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

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


def _frame_data_url() -> str:
    buffer = io.BytesIO()
    Image.new("RGB", (16, 16), "white").save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


# ── capability matrix route ─────────────────────────────────────────────────

def test_matrix_route_serves_features_rows_and_the_rules_the_browser_needs(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)

    response = client.get("/api/capabilities/matrix")

    assert response.status_code == 200
    payload = response.json()
    features = {feature["id"]: feature for feature in payload["features"]}
    # Subset, not equality: the same route serves every studio's features, and
    # a new one landing must not fail the sprite test.
    assert {"sprite_source", "sprite_animation"} <= set(features)
    animation = features["sprite_animation"]
    assert {row["model"] for row in animation["rows"]}, "the matrix must rate the catalogued video models"
    # The browser rates its OWN image catalog (sd.cpp checkpoints, Wan2GP) with
    # these same rules rather than keeping a second opinion.
    assert any(rule["match"] == "provider:sdcpp" for rule in features["sprite_source"]["rules"])
    assert payload["unmatched"]["rating"] == "unmeasured"


def test_matrix_route_is_owner_only(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch, unlock=False)

    assert client.get("/api/capabilities/matrix").status_code == 401


# ── SAM3 matte proxy ────────────────────────────────────────────────────────

def test_matte_returns_the_mask_inline_and_never_echoes_the_frame(tmp_path: Path, monkeypatch) -> None:
    captured: dict = {}

    def fake_mask(image_base64, **kwargs):
        captured["image"] = image_base64
        captured.update(kwargs)
        return {"mask_base64": "data:image/png;base64,TUFTSw==", "elapsed_seconds": 19.4}

    monkeypatch.setattr("hivemind_content_studio.control_api.run_smart_mask", fake_mask)
    client = _client(tmp_path, monkeypatch)
    frame = _frame_data_url()

    response = client.post("/api/sprite/matte", json={"image_base64": frame, "subject": "the pink dragon"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["mask_base64"].startswith("data:image/png;base64,")
    assert captured["subject"] == "the pink dragon"
    # The frame goes up, the mask comes back. Echoing the frame would put a
    # decrypted animation frame into a response body for no reason at all.
    assert frame not in response.text


def test_matte_refuses_a_frame_with_nothing_named_to_keep(tmp_path: Path, monkeypatch) -> None:
    """SAM3 needs a subject or a tap. Refusing here saves a ~20s round-trip
    that could only ever fail."""
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/sprite/matte", json={"image_base64": _frame_data_url()})

    assert response.status_code == 400


def test_matte_forwards_taps_with_their_include_flag(tmp_path: Path, monkeypatch) -> None:
    captured: dict = {}
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.run_smart_mask",
        lambda image_base64, **kwargs: captured.update(kwargs) or {"mask_base64": "data:image/png;base64,TUFTSw=="},
    )
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/sprite/matte", json={
        "image_base64": _frame_data_url(),
        "points": [{"x": 0.5, "y": 0.5, "include": True}, {"x": 0.9, "y": 0.1, "include": False}],
    })

    assert response.status_code == 200
    assert captured["points"] == [
        {"x": 0.5, "y": 0.5, "include": True},
        {"x": 0.9, "y": 0.1, "include": False},
    ]


def test_a_dead_mask_service_answers_503_with_a_sanitized_reason(tmp_path: Path, monkeypatch) -> None:
    def fake_mask(image_base64, **kwargs):
        raise RuntimeError("smart-select failed reading /Users/liam/comfy/ComfyUI/temp/mask_00001_.png")

    monkeypatch.setattr("hivemind_content_studio.control_api.run_smart_mask", fake_mask)
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/sprite/matte", json={"image_base64": _frame_data_url(), "subject": "the dragon"})

    assert response.status_code == 503
    assert "/Users/liam" not in response.text


def test_a_slow_first_load_answers_504_rather_than_hanging_the_browser(tmp_path: Path, monkeypatch) -> None:
    """The first mask of a session loads a 3.45 GB checkpoint. That is slow,
    not broken — but it still has to end in an answer."""
    def fake_mask(image_base64, **kwargs):
        raise TimeoutError("Background removal timed out")

    monkeypatch.setattr("hivemind_content_studio.control_api.run_smart_mask", fake_mask)
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/sprite/matte", json={"image_base64": _frame_data_url(), "subject": "the dragon"})

    assert response.status_code == 504


def test_matte_is_owner_only(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch, unlock=False)

    response = client.post("/api/sprite/matte", json={"image_base64": _frame_data_url(), "subject": "x"})

    assert response.status_code == 401
