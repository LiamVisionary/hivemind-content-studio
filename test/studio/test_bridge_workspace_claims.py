"""A workspace's image renders are that workspace's — through the bridge.

Video jobs are claimed for the workspace that starts them. Image jobs took
another road — browser, /local-ai/generate, node bridge, gateway — and the
studio's proxy forwarded a body and a token and nothing else. The gateway never
learned whose vault to seal to, and no claim was ever written, so a non-owner
workspace's renders were sealed with the machine key and listed under nobody:
the owner saw them as unclaimed, the workspace that made them saw nothing.

These run the real proxy against a stand-in for the node bridge: the request
it receives is what the gateway receives, and the History listing afterwards
is what the person sees.
"""

from __future__ import annotations

import io
import json
import urllib.request
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore

OWNER_PASSWORD = "owner-passphrase"
EDITOR_PASSWORD = "editor-pass"
# Shaped like a real SPKI (base64url, long enough to pass both normalizers);
# the value itself is never parsed by anything under test.
EDITOR_PUB = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA" + "x" * 90
JOB_ID = "krea2job01"
OUTPUT_NAME = f"krea2_identity_{JOB_ID}_00001_.png"


class _Bridge:
    """The node bridge as the proxy sees it: records every request, answers
    a job id on submit and a finished record on poll."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def __call__(self, request, timeout=None):
        headers = {key.lower(): value for key, value in request.header_items()}
        self.calls.append({"url": request.full_url, "method": request.get_method(), "headers": headers})
        if request.full_url.endswith("/local-ai/generate"):
            return _Answer(202, {"id": JOB_ID, "status": "queued"})
        if request.full_url.endswith(f"/local-ai/job/{JOB_ID}"):
            return _Answer(200, {"status": "success", "image_urls": [f"/image/{OUTPUT_NAME}"], "seed": 7})
        return _Answer(404, {"error": "not found"})

    @property
    def submit(self) -> dict:
        return next(call for call in self.calls if call["url"].endswith("/local-ai/generate"))


class _Answer:
    def __init__(self, status: int, payload: dict) -> None:
        self.status = status
        self._body = io.BytesIO(json.dumps(payload).encode("utf-8"))
        self.headers = {"content-type": "application/json"}

    def read(self) -> bytes:
        return self._body.read()

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> None:
        return None


@pytest.fixture()
def bridge(monkeypatch) -> _Bridge:
    stand_in = _Bridge()
    monkeypatch.setattr(urllib.request, "urlopen", stand_in)
    return stand_in


@pytest.fixture()
def gateway_records() -> list[dict]:
    return []


@pytest.fixture()
def client(tmp_path: Path, monkeypatch, gateway_records: list[dict]) -> TestClient:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password=OWNER_PASSWORD, cipher=cipher),
        private_cipher=cipher,
        canvas_history_fetcher=lambda: [dict(record) for record in gateway_records],
    )
    return TestClient(app)


def _sign_in(client: TestClient, account_id: int, password: str) -> None:
    response = client.post("/api/accounts/unlock", json={"account_id": account_id, "password": password})
    assert response.status_code == 200, response.text


def _add_workspace(client: TestClient, name: str, password: str) -> int:
    _sign_in(client, 1, OWNER_PASSWORD)
    created = client.post("/api/accounts", json={"name": name, "password": password})
    assert created.status_code == 201, created.text
    client.post("/api/accounts/sign-out")
    return int(created.json()["account"]["id"])


def _give_vault(client: TestClient, public_key: str) -> None:
    identity = {
        "kdf": "PBKDF2-SHA256-600000",
        "salt": "c2FsdA",
        "wrapped_mk_pass": "aXY.Y2lwaGVy",
        "wrapped_mk_recovery": "aXY.cmVjb3Zlcg",
        "public_key": public_key,
        "wrapped_private_key": "aXY.cHJpdmF0ZQ",
    }
    assert client.put("/api/vault/identity", json={"identity": identity}).status_code == 200


def _finished_record(tmp_path: Path) -> dict:
    output = tmp_path / "outputs" / OUTPUT_NAME
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 64)
    return {
        "id": JOB_ID,
        "status": "success",
        "created_at": "2026-09-07T05:00:00+00:00",
        "finished_at": "2026-09-07T05:01:00+00:00",
        "outputs": [str(output)],
        "timestamp_source": "gateway-history",
    }


def _listed_names(client: TestClient) -> list[str]:
    response = client.get("/api/canvas/history", params={"refresh": "1"})
    assert response.status_code == 200, response.text
    return [item.get("output_basename", "") for item in response.json()["history"]]


def test_a_render_started_in_a_workspace_is_sealed_to_it_and_listed_only_there(
    client: TestClient, bridge: _Bridge, gateway_records: list[dict], tmp_path: Path,
) -> None:
    editor = _add_workspace(client, "Editor", EDITOR_PASSWORD)
    _sign_in(client, editor, EDITOR_PASSWORD)
    _give_vault(client, EDITOR_PUB)

    started = client.post("/local-ai/generate", json={"prompt": "a portrait", "model": "krea2"})
    assert started.status_code == 202, started.text
    assert started.json()["id"] == JOB_ID
    # The gateway seals to the key it is handed on the 202; this is that key.
    assert bridge.submit["headers"].get("x-e2e-owner-pub") == EDITOR_PUB

    finished = client.get(f"/local-ai/job/{JOB_ID}")
    assert finished.status_code == 200 and finished.json()["status"] == "success"

    # The gateway lists it machine-wide, with no idea whose it is.
    gateway_records.append(_finished_record(tmp_path))
    assert _listed_names(client) == [OUTPUT_NAME]

    client.post("/api/accounts/sign-out")
    _sign_in(client, 1, OWNER_PASSWORD)
    assert _listed_names(client) == []


def test_watching_another_workspaces_job_does_not_take_it(
    client: TestClient, bridge: _Bridge, gateway_records: list[dict], tmp_path: Path,
) -> None:
    editor = _add_workspace(client, "Editor", EDITOR_PASSWORD)
    _sign_in(client, editor, EDITOR_PASSWORD)
    assert client.post("/local-ai/generate", json={"prompt": "x", "model": "krea2"}).status_code == 202
    client.post("/api/accounts/sign-out")

    # The owner polls the editor's job to its finish.
    _sign_in(client, 1, OWNER_PASSWORD)
    assert client.get(f"/local-ai/job/{JOB_ID}").json()["status"] == "success"
    gateway_records.append(_finished_record(tmp_path))
    assert _listed_names(client) == []

    client.post("/api/accounts/sign-out")
    _sign_in(client, editor, EDITOR_PASSWORD)
    assert _listed_names(client) == [OUTPUT_NAME]


def test_a_job_nobody_claimed_belongs_to_the_workspace_that_watched_it_finish(
    client: TestClient, bridge: _Bridge, gateway_records: list[dict], tmp_path: Path,
) -> None:
    """A job started before claims existed, or by a studio since restarted:
    the poll is the first moment anyone can say whose it is."""
    editor = _add_workspace(client, "Editor", EDITOR_PASSWORD)
    _sign_in(client, editor, EDITOR_PASSWORD)
    assert client.get(f"/local-ai/job/{JOB_ID}").json()["status"] == "success"
    gateway_records.append(_finished_record(tmp_path))
    assert _listed_names(client) == [OUTPUT_NAME]


def test_a_workspace_without_a_vault_still_renders_and_still_owns_the_result(
    client: TestClient, bridge: _Bridge, gateway_records: list[dict], tmp_path: Path,
) -> None:
    editor = _add_workspace(client, "Editor", EDITOR_PASSWORD)
    _sign_in(client, editor, EDITOR_PASSWORD)
    started = client.post("/local-ai/generate", json={"prompt": "x", "model": "krea2"})
    assert started.status_code == 202
    # No vault yet: nothing to seal to, and no invented header either.
    assert "x-e2e-owner-pub" not in bridge.submit["headers"]
    gateway_records.append(_finished_record(tmp_path))
    assert _listed_names(client) == [OUTPUT_NAME]


def test_a_read_that_starts_nothing_carries_no_key_and_claims_nothing(
    client: TestClient, bridge: _Bridge,
) -> None:
    editor = _add_workspace(client, "Editor", EDITOR_PASSWORD)
    _sign_in(client, editor, EDITOR_PASSWORD)
    _give_vault(client, EDITOR_PUB)
    client.get("/local-ai/models")
    assert all("x-e2e-owner-pub" not in call["headers"] for call in bridge.calls)
