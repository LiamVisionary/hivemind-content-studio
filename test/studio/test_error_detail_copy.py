"""What the control API is allowed to say when something goes wrong.

The owner rule is two sentences long: never present a problem without its fix,
and never show a person raw provider or OS text. On the server that reduces to
one checkable property — no `detail` a browser can receive contains a
filesystem path or a traceback — plus one behaviour: a refusal that HAS a
repair names it, so the studio can render a button rather than a sentence.

These are the routes an audit found still forwarding `str(exc)`: the
ingredients preview (an OSError names the owner's home directory), the restore
proxy (the gateway's runner stderr), and the planner (another product's error
body).
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio import video_restore
from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore

# What must never reach a person: the owner's home directory, a Python
# traceback, or a raw JSON body pasted in as prose.
FORBIDDEN = ("/Users/", "/home/", "Traceback", 'File "')


def _leaks(detail: object) -> list[str]:
    text = detail if isinstance(detail, str) else json.dumps(detail)
    return [needle for needle in FORBIDDEN if needle in text]


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        approvals=ApprovalLedger(
            tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret"),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="test-owner-password", cipher=cipher),
        private_cipher=cipher,
    )
    test_client = TestClient(app)
    assert test_client.post(
        "/api/accounts/unlock", json={"account_id": 1, "password": "test-owner-password"},
    ).status_code == 200
    return test_client


def test_the_ingredients_preview_never_answers_with_a_staged_path(client, monkeypatch) -> None:
    """An OSError's text is '[Errno 2] … /Users/<name>/…' — the owner's home."""
    from hivemind_content_studio import control_api

    def explode(*_args, **_kwargs):
        raise OSError(2, "No such file or directory", "/Users/someone/Library/staged/ref-1.png")

    monkeypatch.setattr(control_api.subprocess, "run", explode)
    response = client.post(
        "/api/media-studio/ingredients/preview",
        json={"ingredient_images": [{"image_base64": "data:image/png;base64,aGk="}], "aspect_ratio": "1:1"},
    )
    assert response.status_code in {400, 503}
    detail = response.json().get("detail")
    assert _leaks(detail) == [], detail


def test_a_restore_failure_says_it_in_words_and_keeps_its_remedy(client, monkeypatch) -> None:
    """The gateway's RestoreError carries the runner's stderr, path and all."""
    raw = (
        "Traceback (most recent call last):\n"
        '  File "/Users/someone/comfy/nodes.py", line 41, in run\n'
        "RuntimeError: the SeedVR2 loader could not open /Users/someone/models/seedvr2.safetensors"
    )

    class _Gateway:
        def request(self, path, *, method="GET", body=None, timeout=None):
            raise video_restore.RestoreError(raw, remedy="pick-machine", status_code=409)

    monkeypatch.setattr(video_restore, "client", lambda: _Gateway())
    response = client.post("/api/restore", json={"lane": "default", "source": {"path": "clip.mp4"}})
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert _leaks(detail) == [], detail
    # Never a problem without its fix: the repair the gateway named survives.
    assert detail["remedy"] == "pick-machine"
    assert detail["error"] and detail["error"] == detail["message"]


def test_the_planner_answers_a_sentence_with_a_repair_not_hivemindos_prose(client, monkeypatch) -> None:
    """HivemindOS's own error body is another product's words, not ours."""
    from hivemind_content_studio import control_api

    def explode(_payload):
        raise RuntimeError('HivemindOS returned HTTP 502: {"error": "upstream model pool exhausted"}')

    monkeypatch.setattr(control_api, "plan_with_brain", explode)
    response = client.post(
        "/api/simple/plan",
        json={"prompt": "a cat", "provider": "hivemindos", "model": "automatic"},
    )
    assert response.status_code == 502
    detail = response.json()["detail"]
    assert detail["message"] == "The planner could not reach HivemindOS."
    # A 502 with no button is a dead end; this one opens the account flow.
    assert detail["remedy"] == "connect-account"
    assert "upstream model pool exhausted" not in json.dumps(detail)
    assert _leaks(detail) == []


def test_the_local_ai_passthrough_translates_the_gateway_before_the_browser(client, monkeypatch) -> None:
    """The last hop: an upstream refusal is the gateway's words until here."""
    from hivemind_content_studio import control_api

    body = json.dumps({
        "error": (
            "Traceback (most recent call last):\n"
            '  File "/Users/someone/gateway/app.py", line 900, in run\n'
            "RuntimeError: workflow node 7 could not load /Users/someone/models/x.safetensors"
        ),
    }).encode()

    def urlopen(request, timeout=None):
        # What urllib raises for a 4xx/5xx: the body is read off the exception,
        # which is exactly the shape the proxy forwards.
        raise control_api.urllib.error.HTTPError(
            request.full_url, 500, "Server Error",
            {"content-type": "application/json"}, io.BytesIO(body),
        )

    monkeypatch.setattr(control_api.urllib.request, "urlopen", urlopen)
    response = client.post("/local-ai/generate", json={"prompt": "x"})
    assert response.status_code == 500
    payload = response.json()
    assert _leaks(payload) == [], payload
    assert payload["error"] == payload["detail"] == payload["message"]
