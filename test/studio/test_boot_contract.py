"""What a first boot must do, as an executable spec.

The rest of the suite builds the app with a prepared cipher and a prepared data
directory, so it never observes what happens on a machine that has neither. This
file is the boot contract a packaged sidecar has to keep: a health shape with a
version, a readiness flag that only flips when the app really is ready, a
frontend served from wherever the shell says it is, a consumer-readable page
when that build is missing, and a boot that survives having no keychain.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio import __version__, private_access
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore


SHELL_MARKER = '<div id="app"></div>'


def _fake_dist(root: Path) -> Path:
    """A minimal Vite build: an index.html and one hashed asset."""
    dist = root / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(
        f'<!doctype html><html><head><title>Studio</title></head><body>{SHELL_MARKER}'
        '<script type="module" src="/assets/index-abc123.js"></script></body></html>',
        encoding="utf-8",
    )
    (dist / "assets" / "index-abc123.js").write_text("export default 0;\n", encoding="utf-8")
    return dist


def _app(tmp_path: Path, monkeypatch, *, dist: Path | None):
    """build_control_app() the way a sidecar gets it: env in, nothing else."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setenv("CONTENT_STUDIO_DATA_DIR", str(data_dir))
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(data_dir / "runs"))
    if dist is None:
        monkeypatch.setenv("CONTENT_STUDIO_FRONTEND_DIST", str(tmp_path / "no-such-dist"))
    else:
        monkeypatch.setenv("CONTENT_STUDIO_FRONTEND_DIST", str(dist))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    return build_control_app(
        orchestrator=ContentOrchestrator(RunStore(data_dir / "state.sqlite3")),
        owner_access=OwnerAccess.for_testing(password="boot-contract", cipher=cipher),
        private_cipher=cipher,
    )


def _unlock(client: TestClient) -> None:
    """Sign in to the owner workspace. `/` is the standalone account gate until
    somebody has, so a shell assertion without this tests the gate instead."""
    response = client.post("/api/accounts/unlock", json={"account_id": 1, "password": "boot-contract"})
    assert response.status_code == 200


def test_a_fresh_boot_reports_its_version_and_serves_the_shell(tmp_path: Path, monkeypatch) -> None:
    app = _app(tmp_path, monkeypatch, dist=_fake_dist(tmp_path))
    with TestClient(app) as client:
        # Health and readiness answer before anyone signs in: the shell that
        # spawned this process has no session and never will.
        health = client.get("/healthz").json()
        assert health["ok"] is True
        assert health["ready"] is True
        assert health["version"] == __version__

        _unlock(client)
        page = client.get("/")
        assert page.status_code == 200
        assert SHELL_MARKER in page.text
        # The studio marker the frontend reads instead of a URL parameter.
        assert "__HIVEMIND_STUDIO__" in page.text

        # The data dir it was handed is stamped with the format it wrote.
        assert (tmp_path / "data" / "FORMAT").read_text(encoding="utf-8").strip() == "1"


def test_readyz_is_false_until_the_startup_hooks_have_run(tmp_path: Path, monkeypatch) -> None:
    app = _app(tmp_path, monkeypatch, dist=_fake_dist(tmp_path))
    # Before the lifespan runs (no `with`), nothing has bootstrapped.
    unstarted = TestClient(app)
    assert unstarted.get("/readyz").status_code == 503
    assert unstarted.get("/readyz").json()["ready"] is False
    assert unstarted.get("/healthz").json()["ready"] is False

    with TestClient(app) as client:
        ready = client.get("/readyz")
        assert ready.status_code == 200
        assert ready.json() == {"ok": True, "ready": True, "version": __version__}


def test_a_missing_frontend_build_says_what_to_do_without_a_build_command(tmp_path: Path, monkeypatch) -> None:
    app = _app(tmp_path, monkeypatch, dist=None)
    with TestClient(app) as client:
        _unlock(client)
        page = client.get("/")
        assert page.status_code == 503
        body = page.text
        # Consumer copy: whoever sees this installed an app, not a checkout.
        assert "Reinstall" in body
        assert "npm" not in body
        assert "vite" not in body.lower()
        # The problem never arrives without its fix.
        assert "Try again" in body


def test_the_studio_boots_on_a_key_file_when_the_keychain_refuses(tmp_path: Path, monkeypatch) -> None:
    """No CONTENT_STUDIO_PRIVATE_SECRET and a `security` binary that fails.

    That is every Linux and Windows machine, and a macOS one whose keychain is
    locked. It used to be a RuntimeError before uvicorn ever bound a port.
    """
    monkeypatch.delenv(private_access.PRIVATE_SECRET_ENV, raising=False)
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setenv("CONTENT_STUDIO_DATA_DIR", str(data_dir))
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(data_dir / "runs"))
    monkeypatch.setattr(private_access, "_cipher_cache", {})
    private_access.configure_private_cipher(None)

    def _security_is_broken(*args, **kwargs):
        raise OSError("no such binary: /usr/bin/security")

    monkeypatch.setattr(private_access.subprocess, "run", _security_is_broken)

    cipher = private_access.resolve_private_cipher()
    key_file = private_access.private_key_file()
    assert key_file.is_file()
    assert key_file.stat().st_mode & 0o777 == 0o600
    # Same key on the next boot, or every field written under it is lost.
    monkeypatch.setattr(private_access, "_cipher_cache", {})
    assert private_access.resolve_private_cipher().encrypt("x") != ""
    assert cipher.decrypt(private_access.resolve_private_cipher().encrypt("hello")) == "hello"


def test_a_newer_data_format_is_refused_with_a_sentence(tmp_path: Path) -> None:
    from hivemind_content_studio.config import DataFormatTooNew, ensure_data_format

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "FORMAT").write_text("99\n", encoding="utf-8")
    with pytest.raises(DataFormatTooNew) as raised:
        ensure_data_format(data_dir)
    message = str(raised.value)
    assert "newer version of the app" in message
    assert "CONTENT_STUDIO_DATA_DIR" in message


def test_the_shipped_workflow_registry_names_no_developer_machine() -> None:
    """A registry entry that only resolves on one Mac is a model the studio
    offers and cannot run."""
    registry = Path(__file__).resolve().parents[2] / "packages" / "media-gateway" / "workflow-registry.json"
    raw = registry.read_text(encoding="utf-8")
    assert "/Users/" not in raw
    payload = json.loads(raw)
    entries = payload if isinstance(payload, list) else payload.get("workflows") or []
    if isinstance(entries, dict):
        entries = list(entries.values())
    for entry in entries:
        for key in ("api_workflow", "mobile_workflow", "workflow", "workflow_file"):
            value = entry.get(key)
            if not value:
                continue
            # Either relative to the ComfyUI install, or to the gateway package.
            assert not value.startswith("/"), f"{entry.get('id')}.{key} is an absolute path"
