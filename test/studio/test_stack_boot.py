"""The boot contract the desktop shell depends on.

`desktop/src-tauri` reserves a port, spawns this app as a sidecar, polls
`/readyz` and only then loads `http://127.0.0.1:<port>` into the window. Every
test above this one drives the app in-process through `TestClient`, which never
runs the lifespan and never binds a socket — so nothing proved that the three
steps the shell actually performs work as one path.

This does: a real uvicorn server, on a free port, in a thread, waited on through
`/readyz` exactly as the Rust supervisor waits, then `/` fetched over HTTP and
checked for the studio bundle, then shut down with nothing left running.
"""

from __future__ import annotations

import http.cookiejar
import json
import os
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from contextlib import closing

import pytest
import uvicorn

from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher

# The shell's own ceiling (desktop/src-tauri/src/backoff.rs READY_TIMEOUT is
# 90s). Kept shorter here: a boot this test cannot complete in 60 seconds is a
# regression whatever the shell would tolerate.
READY_TIMEOUT_SECONDS = 60.0
POLL_INTERVAL_SECONDS = 0.2


def _free_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _browser() -> urllib.request.OpenerDirector:
    """One opener that keeps its cookies, because the owner session is one."""
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )


def _fetch(
    opener: urllib.request.OpenerDirector,
    url: str,
    payload: dict | None = None,
    timeout: float = 10.0,
) -> tuple[int, str]:
    """Status and body, with a refused connection reported rather than raised."""
    request = urllib.request.Request(url)  # noqa: S310 - loopback only
    if payload is not None:
        request.data = json.dumps(payload).encode("utf-8")
        request.add_header("Content-Type", "application/json")
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, TimeoutError):
        return 0, ""


def _child_pids() -> set[str]:
    """Direct children of this process, or an empty set where pgrep is absent."""
    try:
        found = subprocess.run(
            ["/usr/bin/pgrep", "-P", str(os.getpid())],
            check=False,
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return set()
    return {line for line in found.stdout.decode().split() if line}


@pytest.fixture
def studio_server(monkeypatch, tmp_path):
    """`build_control_app()` under uvicorn on a free port, in a thread."""
    # The catalog warm that gates /readyz probes the ComfyUI lanes. Pointed at a
    # port nothing serves so this test says the same thing on a machine with a
    # live ComfyUI as on one without.
    monkeypatch.setenv("COMFY_LANES", "default=http://127.0.0.1:9")
    monkeypatch.setenv("COMFY_HTTP_DEFAULT", "http://127.0.0.1:9")
    monkeypatch.setenv("CONTENT_STUDIO_LOG_DIR", str(tmp_path / "logs"))

    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="test-owner-password", cipher=cipher),
        private_cipher=cipher,
    )
    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
    )
    thread = threading.Thread(target=server.run, name="studio-boot-test", daemon=True)
    thread.start()
    try:
        yield port, server, thread
    finally:
        server.should_exit = True
        thread.join(timeout=30)


def test_the_shell_can_wait_on_readyz_and_then_load_the_studio(studio_server, unified_frontend) -> None:
    # `packages/open-generative-ai/dist` is gitignored, so the bundle half of
    # this runs only in a checkout that has been built — the same contract every
    # other test that touches the served shell keeps (see the `unified_frontend`
    # fixture). The boot path itself is asserted either way.
    port, server, thread = studio_server
    before = _child_pids()
    base = f"http://127.0.0.1:{port}"
    browser = _browser()

    # 1. What the supervisor polls. /healthz answers as soon as the socket is
    #    open; /readyz stays 503 until the accounts bootstrap and the catalog
    #    warm have both run, which is why the shell waits on this one.
    deadline = time.monotonic() + READY_TIMEOUT_SECONDS
    ready = False
    while time.monotonic() < deadline:
        status, _ = _fetch(browser, f"{base}/readyz")
        if status == 200:
            ready = True
            break
        time.sleep(POLL_INTERVAL_SECONDS)
    assert ready, "/readyz never turned true; the shell would show its boot failure"

    # 2. /healthz names the product. The shell uses exactly this to tell its own
    #    control API from a stranger holding port 8765, so it must keep saying it.
    status, body = _fetch(browser, f"{base}/healthz")
    assert status == 200
    assert "hivemind-content-studio" in body

    # 3. What the window loads first: the sign-in gate, served from the control
    #    API's own origin. The shell must never see a blank page here.
    status, gate = _fetch(browser, f"{base}/")
    assert status == 200
    assert "Hivemind Content Studio" in gate
    assert 'id="picker"' in gate, "a locked studio serves its gate, not an empty page"

    # 4. And after signing in, the studio bundle — from that same origin, which
    #    is why the window loads http://127.0.0.1:<port> and not tauri://.
    status, _ = _fetch(
        browser,
        f"{base}/api/accounts/unlock",
        {"account_id": 1, "password": "test-owner-password"},
    )
    assert status == 200, "the shell's origin must be able to hold an owner session"
    if unified_frontend.built:
        status, page = _fetch(browser, f"{base}/")
        assert status == 200
        assert 'id="app"' in page, "the unlocked studio serves the Vite shell"
        script_status, _ = _fetch(browser, f"{base}{unified_frontend.script_path}")
        assert script_status == 200, "the hashed module bundle must be served from /assets"

    # 5. Teardown leaves nothing behind. The shell reaps by pid; a server that
    #    forked something the shell does not hold a handle to would be orphaned.
    server.should_exit = True
    thread.join(timeout=30)
    assert not thread.is_alive(), "the server thread outlived its shutdown"
    assert _child_pids() <= before, "boot left a child process behind"

    # And the port is released, so a relaunch can take it back. SO_REUSEADDR
    # because that is what uvicorn itself binds with: sockets the just-closed
    # server accepted sit in TIME_WAIT for a couple of minutes, and a relaunch
    # must not have to wait them out.
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("127.0.0.1", port))


def test_readyz_refuses_before_the_app_has_booted(monkeypatch, tmp_path) -> None:
    """A shell that polled /healthz alone would open onto an unbuilt catalog.

    Built without running the lifespan — the state the app is in for the first
    moments of every launch — /readyz must say 503, not 200.
    """
    from fastapi.testclient import TestClient

    monkeypatch.setenv("COMFY_LANES", "default=http://127.0.0.1:9")
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        owner_access=OwnerAccess.for_testing(password="test-owner-password", cipher=cipher),
        private_cipher=cipher,
    )
    client = TestClient(app)

    assert client.get("/readyz").status_code == 503
    assert client.get("/healthz").status_code == 200


def test_the_shell_can_place_data_cache_and_logs_in_three_different_trees(monkeypatch, tmp_path) -> None:
    """macOS gives an app three homes, and logs belong in ~/Library/Logs.

    The shell passes Tauri's app_data_dir / app_cache_dir / app_log_dir, so the
    resolver has to accept them separately rather than deriving cache and logs
    from the data folder.
    """
    from hivemind_content_studio.config import app_dirs

    monkeypatch.setenv("CONTENT_STUDIO_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CONTENT_STUDIO_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("CONTENT_STUDIO_LOG_DIR", str(tmp_path / "logs"))

    dirs = app_dirs()

    assert dirs.data_dir == (tmp_path / "data").resolve()
    assert dirs.cache_dir == (tmp_path / "cache").resolve()
    assert dirs.logs_dir == (tmp_path / "logs").resolve()

    # Unset, the two derived folders stay where every existing machine has them.
    monkeypatch.delenv("CONTENT_STUDIO_CACHE_DIR")
    monkeypatch.delenv("CONTENT_STUDIO_LOG_DIR")
    derived = app_dirs()
    assert derived.cache_dir == derived.data_dir / "cache"
    assert derived.logs_dir == derived.data_dir / "logs"
