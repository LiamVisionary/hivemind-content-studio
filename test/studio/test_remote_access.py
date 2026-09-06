"""Remote access is a switch, not a boot-time fact.

The stack used to publish the studio on the tailnet at every launch — through a
hand-rolled HTTPS proxy carrying a SELF-SIGNED certificate, in front of a Canvas
port that authenticated nothing. These pin the replacement: nothing is published
until someone asks, only the control API's port is published, the certificate is
Tailscale's real one, and every state this can be in names its own fix.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from hivemind_content_studio import remote_access
from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.remote_access import (
    CommandResult,
    RemoteAccessError,
    remote_access_status,
    set_remote_access,
)
from hivemind_content_studio.run_store import RunStore

OWNER_PASSWORD = "test-owner-password"

DNS_NAME = "studio-mac.tail1234.ts.net"


def _status_json(state: str = "Running", dns: str = DNS_NAME) -> str:
    return json.dumps({
        "BackendState": state,
        "Self": {"DNSName": dns + ".", "HostName": "studio-mac"},
        "CurrentTailnet": {"Name": "owner@example.com"},
        "Peer": {"a": {}, "b": {}},
    })


def _serve_json(target: str | None, https_port: int = 8765, dns: str = DNS_NAME) -> str:
    if target is None:
        return json.dumps({})
    return json.dumps({"Web": {f"{dns}:{https_port}": {"Handlers": {"/": {"Proxy": target}}}}})


class FakeTailscale:
    """Records every argv and answers the two read commands from a script."""

    def __init__(self, *, status: str, serve: str) -> None:
        self.status = status
        self.serve = serve
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str]) -> CommandResult:
        self.calls.append(argv)
        if argv[1:3] == ["status", "--json"]:
            return CommandResult(0, self.status, "")
        if argv[1:4] == ["serve", "status", "--json"]:
            return CommandResult(0, self.serve, "")
        # A write. Reflect it into what the next read reports.
        if "off" in argv:
            self.serve = _serve_json(None)
        else:
            self.serve = _serve_json("http://127.0.0.1:8765")
        return CommandResult(0, "", "")


def _installed(monkeypatch) -> None:
    monkeypatch.setattr(remote_access, "tailscale_cli", lambda: "/usr/bin/tailscale")


# ── the switch itself ────────────────────────────────────────────────────────

def test_off_by_default_and_the_reading_names_what_turning_it_on_does(monkeypatch) -> None:
    _installed(monkeypatch)
    run = FakeTailscale(status=_status_json(), serve=_serve_json(None))

    reading = remote_access_status(port=8765, https_port=8765, run=run)

    assert reading["supported"] is True
    assert reading["enabled"] is False
    # Nothing is published, so there is no URL to show and nothing to claim.
    assert reading["url"] == ""
    assert reading["published_ports"] == []
    assert "only reachable on this Mac" in reading["detail"]
    assert "tailnet only" in reading["remedy"]
    # Reading the state must never publish anything.
    assert all(argv[1:2] == ["status"] or argv[1:3] == ["serve", "status"] for argv in run.calls)


def test_turning_it_on_publishes_only_the_control_api_port(monkeypatch) -> None:
    _installed(monkeypatch)
    run = FakeTailscale(status=_status_json(), serve=_serve_json(None))

    reading = set_remote_access(True, port=8765, https_port=8765, run=run)

    write = next(argv for argv in run.calls if argv[1] == "serve" and argv[2] != "status")
    assert write == ["/usr/bin/tailscale", "serve", "--bg", "--yes", "--https=8765", "http://127.0.0.1:8765"]
    # `tailscale serve`, never a proxy of ours and never a generated cert: the
    # certificate is Tailscale's, so the browser shows no warning to explain.
    assert not any("cert" in part or "openssl" in part for argv in run.calls for part in argv)
    # The CANVAS port (8788) is never an argument to any of this.
    assert not any("8788" in part for argv in run.calls for part in argv)

    assert reading["enabled"] is True
    assert reading["url"] == f"https://{DNS_NAME}:8765/"
    assert reading["published_ports"] == [8765]


def test_the_published_reading_says_plainly_who_can_reach_it(monkeypatch) -> None:
    _installed(monkeypatch)
    run = FakeTailscale(status=_status_json(), serve=_serve_json("http://127.0.0.1:8765"))

    audience = remote_access_status(port=8765, https_port=8765, run=run)["audience"]

    assert "owner@example.com" in audience          # which tailnet
    assert "3 devices" in audience                  # how many are on it
    assert "shared into it" in audience             # and the ones you forgot
    assert "not on the public internet" in audience


def test_turning_it_off_stops_publishing(monkeypatch) -> None:
    _installed(monkeypatch)
    run = FakeTailscale(status=_status_json(), serve=_serve_json("http://127.0.0.1:8765"))

    reading = set_remote_access(False, port=8765, https_port=8765, run=run)

    assert ["/usr/bin/tailscale", "serve", "--https=8765", "off"] in run.calls
    assert reading["enabled"] is False and reading["url"] == ""


def test_someone_elses_share_on_the_same_port_is_not_read_as_ours(monkeypatch) -> None:
    """A tailnet share pointing somewhere else is somebody else's; claiming it
    would let the toggle report "published" for a URL that opens another app."""
    _installed(monkeypatch)
    run = FakeTailscale(status=_status_json(), serve=_serve_json("http://127.0.0.1:3010"))

    assert remote_access_status(port=8765, https_port=8765, run=run)["enabled"] is False


# ── every unusable state carries its own fix ─────────────────────────────────

def test_without_tailscale_the_card_says_what_to_install(monkeypatch) -> None:
    monkeypatch.setattr(remote_access, "tailscale_cli", lambda: "")

    reading = remote_access_status(port=8765, https_port=8765, run=lambda argv: CommandResult(1, "", ""))

    assert reading["supported"] is False and reading["enabled"] is False
    assert "not installed" in reading["detail"]
    assert "Install Tailscale" in reading["remedy"]


def test_signed_out_of_the_tailnet_says_where_to_sign_in(monkeypatch) -> None:
    _installed(monkeypatch)
    run = FakeTailscale(status=_status_json(state="Stopped", dns=""), serve=_serve_json(None))

    reading = remote_access_status(port=8765, https_port=8765, run=run)

    assert reading["supported"] is False
    assert "not connected to a tailnet" in reading["detail"]
    assert "Tailscale app" in reading["remedy"]


def test_a_tailnet_without_https_certificates_names_the_admin_setting(monkeypatch) -> None:
    _installed(monkeypatch)

    def run(argv: list[str]) -> CommandResult:
        if argv[1:3] == ["status", "--json"]:
            return CommandResult(0, _status_json(), "")
        if argv[1:4] == ["serve", "status", "--json"]:
            return CommandResult(0, _serve_json(None), "")
        return CommandResult(1, "", "HTTPS is disabled for this tailnet: enable it in the admin console")

    try:
        set_remote_access(True, port=8765, https_port=8765, run=run)
    except RemoteAccessError as exc:
        # Never the CLI's own words: it names flags nobody typed.
        assert "admin console" in exc.remedy
        assert "HTTPS certificates turned off" in exc.message
        assert "--https" not in exc.message
    else:  # pragma: no cover - the failure branch must raise
        raise AssertionError("a failed publish must raise")


# ── the route ────────────────────────────────────────────────────────────────

def _client(tmp_path: Path, monkeypatch, *, unlock: bool = True) -> TestClient:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        approvals=ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret"),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password=OWNER_PASSWORD, cipher=cipher),
        private_cipher=cipher,
    )
    client = TestClient(app)
    if unlock:
        assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD}).status_code == 200
    return client


def test_the_route_is_account_gated_and_reports_the_switch(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(remote_access, "tailscale_cli", lambda: "")

    locked = _client(tmp_path / "locked", monkeypatch, unlock=False)
    assert locked.get("/api/remote-access").status_code == 401
    assert locked.post("/api/remote-access", json={"enabled": True}).status_code == 401

    client = _client(tmp_path / "open", monkeypatch)
    body = client.get("/api/remote-access").json()
    assert body["ok"] is True and body["enabled"] is False and body["supported"] is False


def test_a_refused_publish_reaches_the_ui_as_a_message_and_a_remedy(tmp_path: Path, monkeypatch) -> None:
    def refuse(_enabled: bool) -> dict:
        raise RemoteAccessError("Tailscale could not publish the studio.", "Open the Tailscale app and try again.")

    monkeypatch.setattr("hivemind_content_studio.control_api.set_remote_access", refuse)
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/remote-access", json={"enabled": True})

    assert response.status_code == 503
    detail = response.json()["detail"]
    # The frontend's api() reads exactly these two fields, so a failure here is
    # never a bare "Request failed".
    assert detail["message"] == "Tailscale could not publish the studio."
    assert detail["remedy"] == "Open the Tailscale app and try again."


# ── the boot path ────────────────────────────────────────────────────────────

_STACK = Path(__file__).resolve().parents[2] / "scripts/hivemind-studio-stack"


def test_a_cold_start_spawns_no_proxy_and_generates_no_certificate() -> None:
    """The supervisor is the reference process tree the Tauri shell copies, so
    what it does at boot is the contract. It used to make a self-signed cert and
    bind a Node HTTPS proxy to the tailnet address on every launch."""
    stack = _STACK.read_text(encoding="utf-8")

    assert "openssl req -x509" not in stack, "no certificate is generated at boot any more"
    assert "ensure_tls_cert" not in stack
    # The proxy file is kept (see docs/RELEASE.md), but nothing starts it.
    assert "node \"$TAILSCALE_HTTPS_PROXY\"" not in stack
    assert "tailscale-https-proxy.js" not in stack
    # The only cloudflared left is a `launchctl bootout` for the retired agent.
    cloudflared_lines = [line for line in stack.splitlines() if "cloudflared" in line.lower()]
    assert all("OLD_CF_LABEL" in line for line in cloudflared_lines), cloudflared_lines

    # The one 8788 probe left is the liveness one, and it uses the exempt route.
    probes = [line for line in stack.splitlines() if "127.0.0.1:8788" in line and ("curl" in line or "wait_http" in line)]
    assert probes, "the supervisor still checks the Canvas child is alive"
    assert all("/healthz" in line for line in probes), probes

    # The Canvas port is not published anywhere in the boot path.
    assert "http://$ts_ip:8788" not in stack


def test_headless_publish_does_not_replace_another_service(monkeypatch):
    import pytest
    _installed(monkeypatch)
    # Both ports come from the environment when they are not passed, and a
    # shell that has either exported sends the conflict check at a port the
    # fixture never published -- the test passed or failed by whose machine
    # ran it. Pin them, so the defaults are what this asserts about.
    monkeypatch.delenv("CONTENT_STUDIO_TAILNET_PORT", raising=False)
    monkeypatch.delenv("CONTENT_STUDIO_CONTROL_PORT", raising=False)
    run = FakeTailscale(status=_status_json(), serve=_serve_json("http://127.0.0.1:9999"))
    with pytest.raises(RemoteAccessError, match="Another service"):
        set_remote_access(True, run=run)
    assert all(call[1:3] in (["status", "--json"], ["serve", "status"]) for call in run.calls)


def test_api_headless_flags_publish_at_startup_and_keep_loopback(monkeypatch):
    import sys
    from types import SimpleNamespace
    import uvicorn
    from hivemind_content_studio import control_api
    monkeypatch.setenv("CONTENT_STUDIO_TAILNET_PORT", "8765")
    monkeypatch.setattr(sys, "argv", ["content-studio-api", "--remote-access", "--tailnet-port", "8789"])
    monkeypatch.delenv("CONTENT_STUDIO_CONTROL_HOST", raising=False)
    monkeypatch.setenv("CONTENT_STUDIO_CONTROL_PORT", "8877")
    monkeypatch.setattr(control_api, "configure_logging", lambda: None)
    app = SimpleNamespace(state=SimpleNamespace(startup_hooks=[]))
    monkeypatch.setattr(control_api, "build_control_app", lambda: app)
    calls = []
    def publish(enabled, **kwargs):
        calls.append((enabled, kwargs))
        return {"enabled": True, "url": f"https://{DNS_NAME}:8789/"}
    monkeypatch.setattr(control_api, "set_remote_access", publish)
    def run(application, **kwargs):
        assert calls == []
        assert kwargs["host"] == "127.0.0.1"
        for hook in application.state.startup_hooks:
            hook()
    monkeypatch.setattr(uvicorn, "run", run)
    control_api.main()
    assert calls == [(True, {"port": 8877, "https_port": 8789})]


def test_stack_cli_forwards_headless_flags(monkeypatch):
    from types import SimpleNamespace
    from hivemind_content_studio import cli
    calls = []
    monkeypatch.setattr(cli.subprocess, "run", lambda argv, **kw: calls.append(argv) or SimpleNamespace(returncode=0))
    args = cli.build_parser().parse_args(["stack", "start", "--remote-access", "--tailnet-port", "8789"])
    assert args.func(args) == 0
    assert calls[0][1:] == ["start", "--remote-access", "--tailnet-port", "8789"]


def test_api_plain_launch_does_not_publish(monkeypatch):
    import sys
    from types import SimpleNamespace
    import uvicorn
    from hivemind_content_studio import control_api
    monkeypatch.setenv("CONTENT_STUDIO_TAILNET_PORT", "8765")
    monkeypatch.setattr(sys, "argv", ["content-studio-api"])
    monkeypatch.delenv("CONTENT_STUDIO_REMOTE_ACCESS", raising=False)
    monkeypatch.setattr(control_api, "configure_logging", lambda: None)
    app = SimpleNamespace(state=SimpleNamespace(startup_hooks=[]))
    monkeypatch.setattr(control_api, "build_control_app", lambda: app)
    monkeypatch.setattr(uvicorn, "run", lambda *a, **kw: None)
    control_api.main()
    assert app.state.startup_hooks == []


def test_tailnet_host_and_signin_origin_are_accepted_but_other_hosts_are_not(tmp_path, monkeypatch):
    monkeypatch.setattr("hivemind_content_studio.control_api.tailnet_hostname", lambda: DNS_NAME)
    client = _client(tmp_path, monkeypatch, unlock=False)
    url = f"https://{DNS_NAME}:8789"
    assert client.get(url + "/").status_code == 200
    assert client.get("https://attacker.ts.net:8789/").status_code == 400
    response = client.post(url + "/api/accounts/unlock", headers={"Origin": url},
                           json={"account_id": 1, "password": OWNER_PASSWORD})
    assert response.status_code == 200
    assert "Secure" in response.headers["set-cookie"]
    assert client.post(url + "/api/accounts/unlock", headers={"Origin": "https://attacker.ts.net"},
                       json={"account_id": 1, "password": OWNER_PASSWORD}).status_code == 400
    assert client.post(url + "/api/accounts/unlock", headers={"Origin": f"https://{DNS_NAME}:9999"},
                       json={"account_id": 1, "password": OWNER_PASSWORD}).status_code == 400


def test_a_taken_tailnet_port_does_not_cost_the_local_studio(monkeypatch, capsys):
    """Publishing runs as a startup hook, so raising there aborts the lifespan
    and uvicorn exits. A tailnet port another service already holds used to
    take the whole studio down with it, localhost included."""
    from hivemind_content_studio import control_api

    def refuse(enabled, **kwargs):
        raise RemoteAccessError(
            "Another service is already published on this tailnet port.",
            "Choose a different --tailnet-port; the existing service was left unchanged.",
        )

    monkeypatch.setattr(control_api, "set_remote_access", refuse)

    assert control_api.publish_remote_access(port=8765, https_port=8789) is False

    printed = capsys.readouterr().err
    assert "Remote access is off" in printed
    assert "Another service" in printed      # what happened
    assert "--tailnet-port" in printed       # and what the reader does about it


def test_a_studio_that_cannot_publish_still_finishes_starting(monkeypatch):
    """The same thing through main(): the hook fails and uvicorn is still
    handed a live app on the loopback port."""
    import sys
    from types import SimpleNamespace

    import uvicorn

    from hivemind_content_studio import control_api

    monkeypatch.setattr(sys, "argv", ["content-studio-api", "--remote-access", "--tailnet-port", "8789"])
    monkeypatch.delenv("CONTENT_STUDIO_CONTROL_HOST", raising=False)
    monkeypatch.setenv("CONTENT_STUDIO_CONTROL_PORT", "8877")
    monkeypatch.setattr(control_api, "configure_logging", lambda: None)
    app = SimpleNamespace(state=SimpleNamespace(startup_hooks=[]))
    monkeypatch.setattr(control_api, "build_control_app", lambda: app)

    def refuse(enabled, **kwargs):
        raise RemoteAccessError(
            "Another service is already published on this tailnet port.",
            "Choose a different --tailnet-port; the existing service was left unchanged.",
        )

    monkeypatch.setattr(control_api, "set_remote_access", refuse)

    served: list[int] = []

    def run(application, **kwargs):
        for hook in application.state.startup_hooks:
            hook()          # this used to raise, and the studio never listened
        served.append(kwargs["port"])

    monkeypatch.setattr(uvicorn, "run", run)

    control_api.main()

    assert served == [8877]
