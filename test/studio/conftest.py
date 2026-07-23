"""Shared studio test setup: private-state cipher without touching the Keychain,
and studio data/runs directories isolated from the real repository state."""

import pytest

from hivemind_content_studio import private_access


@pytest.fixture(autouse=True)
def _test_private_cipher(monkeypatch, tmp_path_factory):
    monkeypatch.setenv("CONTENT_STUDIO_PRIVATE_SECRET", "test-private-state-secret")
    isolated = tmp_path_factory.mktemp("studio-data")
    monkeypatch.setenv("CONTENT_STUDIO_DATA_DIR", str(isolated))
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(isolated / "runs"))
    private_access.configure_private_cipher(None)
    yield
    private_access.configure_private_cipher(None)
