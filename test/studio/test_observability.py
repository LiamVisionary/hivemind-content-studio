"""What the studio records, and what it is willing to say out loud.

Before this the package imported ``logging`` nowhere: a crash left a generic
toast, no incident anyone could quote, and a trace only in a hidden file the
supervisor emptied on the restart it performs automatically. These pin the
three halves of the repair — a 500 that mints an id and writes it, an access
line that carries a route rather than a URL, and a bundle an owner can attach
without handing over their home directory or their prompts.
"""

from __future__ import annotations

import io
import json
import logging
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio import observability
from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore

OWNER_PASSWORD = "test-owner-password"


@pytest.fixture
def studio_log(tmp_path: Path, monkeypatch) -> Path:
    """A rotating log of this test's own, torn down so the root logger is left
    exactly as it was found."""
    monkeypatch.setenv("CONTENT_STUDIO_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("CONTENT_STUDIO_LOG_LEVEL", "INFO")
    root = logging.getLogger()
    before = list(root.handlers), root.level
    chatty = {name: logging.getLogger(name).level for name in ("httpx", "httpcore", "urllib3")}
    target = observability.configure_logging(force=True)
    assert target is not None
    yield target
    for handler in list(root.handlers):
        if handler not in before[0]:
            root.removeHandler(handler)
            handler.close()
    root.setLevel(before[1])
    for name, level in chatty.items():
        logging.getLogger(name).setLevel(level)


def _client(tmp_path: Path, monkeypatch, **overrides) -> TestClient:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        approvals=ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret"),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password=OWNER_PASSWORD, cipher=cipher),
        private_cipher=cipher,
        **overrides,
    )
    client = TestClient(app, raise_server_exceptions=False)
    assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD}).status_code == 200
    return client


def test_a_forced_500_answers_with_an_incident_that_is_in_the_log(tmp_path: Path, monkeypatch, studio_log: Path) -> None:
    def explode():
        raise RuntimeError("boom while reading /Users/liam/prompts/secret.txt")

    monkeypatch.setattr("hivemind_content_studio.control_api.unified_runtime_snapshot", explode)
    client = _client(tmp_path, monkeypatch)

    response = client.get("/api/runtime")

    assert response.status_code == 500
    payload = response.json()
    assert payload["detail"] == "Something went wrong. Copy the details and send them with your report."
    incident = payload["incident"]
    assert incident and len(incident) == 6
    # Nothing developer-facing survived into the sentence a person is shown.
    assert "control API log" not in response.text and "/Users/" not in response.text

    logging.getLogger().handlers[-1].flush()
    written = studio_log.read_text(encoding="utf-8")
    assert f"incident={incident}" in written
    # A frame list, by basename, with no source lines and no locals.
    assert "control_api.py:" in written and "test_observability.py:" in written
    # The exception's own text is sanitised the way a toast would be.
    assert "/Users/liam" not in written and "secret.txt" in written


def test_the_access_line_carries_a_route_not_a_url(tmp_path: Path, monkeypatch, studio_log: Path) -> None:
    client = _client(tmp_path, monkeypatch)

    assert client.get("/healthz?token=super-secret-value&q=cat").status_code == 200

    logging.getLogger().handlers[-1].flush()
    lines = [line for line in studio_log.read_text(encoding="utf-8").splitlines() if "studio.access" in line]
    assert any(line.endswith("GET /healthz 200") for line in lines), lines
    assert "super-secret-value" not in studio_log.read_text(encoding="utf-8")
    assert "?" not in " ".join(line.split("studio.access")[-1] for line in lines)


def test_a_media_filename_never_reaches_the_access_line() -> None:
    # The route template, from the path params the router matched.
    assert observability.access_route(
        "/api/media-studio/generated/holiday-clip.mp4", {"filename": "holiday-clip.mp4"}
    ) == "/api/media-studio/generated/{filename}"
    # And a path nothing matched — a 404, a probe — still loses its leaf.
    assert observability.access_route("/api/media-studio/generated/holiday-clip.mp4") == "/api/media-studio/generated/…"
    assert observability.access_route("/api/runtime") == "/api/runtime"


def test_the_diagnostics_bundle_is_owner_gated_and_names_no_home(tmp_path: Path, monkeypatch, studio_log: Path) -> None:
    client = _client(tmp_path, monkeypatch)
    logging.getLogger("hivemind.studio").error(
        "incident=abc123 lane failed reading /Users/liam/Movies/private-take-3.mp4"
    )
    logging.getLogger().handlers[-1].flush()

    response = client.get("/api/diagnostics/bundle")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"

    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert sorted(archive.namelist()) == ["control-api.log", "healthz.json", "runtime.json"]
    everything = b"".join(archive.read(name) for name in archive.namelist()).decode("utf-8")
    assert "/Users/" not in everything
    assert "private-take-3.mp4" in everything and "incident=abc123" in everything
    assert json.loads(archive.read("healthz.json"))["service"] == "hivemind-content-studio"

    assert client.post("/api/owner/lock").status_code == 200
    assert client.get("/api/diagnostics/bundle").status_code == 401


def test_the_developer_sentence_stays_behind_the_dev_flag(monkeypatch) -> None:
    monkeypatch.delenv("CONTENT_STUDIO_DEV", raising=False)
    for key in ("dist-missing", "unexpected", "passbook-seal", "passbook-write"):
        consumer = observability.remedy_text(key)
        assert "npm" not in consumer
        assert "HIVE_HOME" not in consumer and "HIVE_ENV_KEY" not in consumer
        assert "control API log" not in consumer
    assert observability.remedy_text("dist-missing") == "This copy of the studio is incomplete. Reinstall the app."

    monkeypatch.setenv("CONTENT_STUDIO_DEV", "1")
    assert "npm --prefix" in observability.remedy_text("dist-missing")


def test_the_missing_frontend_page_tells_a_person_what_to_do(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("CONTENT_STUDIO_DEV", raising=False)
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.Path.is_file", lambda self: False, raising=False
    )
    client = _client(tmp_path, monkeypatch)
    response = client.get("/")
    assert response.status_code == 503
    assert "Reinstall the app." in response.text
    assert "npm" not in response.text


def test_the_log_directory_follows_the_state_root_off_macos(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("CONTENT_STUDIO_LOG_DIR", raising=False)
    monkeypatch.setenv("HIVEMIND_MEDIA_STATE_DIR", str(tmp_path / "state"))
    assert observability.log_dir() == tmp_path / "state" / "logs"
    monkeypatch.setenv("CONTENT_STUDIO_LOG_DIR", str(tmp_path / "elsewhere"))
    assert observability.log_path() == tmp_path / "elsewhere" / "control-api.log"
