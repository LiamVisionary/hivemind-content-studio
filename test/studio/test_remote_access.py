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
    assert write == ["/usr/bin/tailscale", "serve", "--bg", "--https=8765", "http://127.0.0.1:8765"]
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
