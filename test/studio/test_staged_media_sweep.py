"""Staged plaintext a crash left behind does not stay on disk.

The owner's browser decrypts a reference or a keyframe and posts it inline;
the studio writes it to data/uploads/media-studio because the gateway and
ComfyUI can only take a file. Each request unlinks its own in a `finally` — but
only on the paths that reach one. A comment claimed a sweeper removed the rest,
and no sweeper existed: six plaintext JPEGs from 2026-08-12 were still there on
2026-09-07, twenty-six days later.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from fastapi.testclient import TestClient

from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore


def _app(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    return build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="pw", cipher=cipher),
        private_cipher=cipher,
    )


def _staging_root(tmp_path: Path) -> Path:
    return tmp_path / "uploads" / "media-studio"


def test_boot_clears_staged_plaintext_a_crash_left_behind(tmp_path: Path, monkeypatch) -> None:
    app = _app(tmp_path, monkeypatch)
    root = _staging_root(tmp_path)
    root.mkdir(parents=True, exist_ok=True)
    # Exactly the shape found on disk: mkstemp names, weeks old.
    leftovers = [root / f"media-studio-input-{name}.jpg" for name in ("ebcv8wns", "gnjr_rsq")]
    for path in leftovers:
        path.write_bytes(b"decrypted-owner-media")
        old = time.time() - 26 * 86400
        os.utime(path, (old, old))

    with TestClient(app):  # entering the client runs the startup hooks
        pass

    for path in leftovers:
        assert not path.exists(), "a crash leftover must not outlive the next boot"


def test_a_file_the_current_request_is_still_using_is_left_alone(tmp_path: Path, monkeypatch) -> None:
    app = _app(tmp_path, monkeypatch)
    root = _staging_root(tmp_path)
    root.mkdir(parents=True, exist_ok=True)
    with TestClient(app):
        fresh = root / "media-studio-input-inflight.jpg"
        fresh.write_bytes(b"a reference being staged right now")
        # The periodic sweep only takes what is past the age ceiling; the boot
        # sweep has already run by here, which is the point — a request that
        # starts after boot must not have its input taken away.
        assert fresh.exists()


def test_the_periodic_sweep_takes_only_what_is_past_its_hour(tmp_path: Path, monkeypatch) -> None:
    """Boot clears everything; the hourly pass must not, or it would delete a
    reference a request staged moments ago."""
    from hivemind_content_studio.api.context import build_context

    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    ctx = build_context(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="pw", cipher=cipher),
        private_cipher=cipher,
    )
    root = ctx.media_studio_input_root
    root.mkdir(parents=True, exist_ok=True)
    stale = root / "media-studio-input-stale.jpg"
    fresh = root / "media-studio-input-fresh.jpg"
    for path in (stale, fresh):
        path.write_bytes(b"pixels")
    old = time.time() - 7200
    os.utime(stale, (old, old))

    assert ctx.sweep_media_studio_staging() == 1
    assert not stale.exists(), "an hour-old leftover goes"
    assert fresh.exists(), "a reference staged moments ago must survive"

    assert ctx.sweep_media_studio_staging(everything=True) == 1
    assert not fresh.exists(), "boot takes everything, because nothing is in flight then"
