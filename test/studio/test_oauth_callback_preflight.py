"""A sign-in must not be started if it cannot come back.

Reported 2026-08-24: pressing Reconnect opened the authorization page, the user
approved it, and the callback landed on ERR_CONNECTION_REFUSED at
localhost:1455. The listener was up the whole time — bound to 127.0.0.1 only,
while macOS resolves `localhost` to ::1 first. A refused connection is immediate
and definitive, so nothing fell back to IPv4.

The redirect_uri is registered with the provider and must not be rewritten, so
this reports rather than repairs — but it reports BEFORE the approval is spent.
"""

from __future__ import annotations

import socket
import urllib.parse


from hivemind_content_studio import hivemindos_oauth as oauth


def authorize_url(redirect: str) -> str:
    return "https://auth.openai.com/authorize?" + urllib.parse.urlencode({"redirect_uri": redirect})


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def test_a_callback_nothing_listens_on_is_refused_before_the_browser_opens() -> None:
    result = oauth.callback_reachability(authorize_url(f"http://localhost:{_free_port()}/auth/callback"))

    assert result["checked"] is True
    assert result["reachable"] is False
    assert "nowhere to come back to" in result["detail"]
    assert result["remedy"]


def test_an_ipv4_only_listener_behind_a_localhost_redirect_is_caught(monkeypatch) -> None:
    """The exact failure. Modelled rather than bound, because whether ::1 is
    reachable is a property of the machine running the test."""
    port = 1455

    def only_ipv4(host, port_, family=0, socktype=0, *_a, **_k):
        if family == socket.AF_INET6:
            return [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", port_, 0, 0))]
        if family == socket.AF_INET:
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port_))]
        # macOS orders IPv6 first for `localhost` regardless of /etc/hosts.
        return [
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", port_, 0, 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port_)),
        ]

    class FakeSocket:
        def __init__(self, family, *_a):
            self.family = family

        def settimeout(self, _):
            pass

        def connect(self, _address):
            if self.family == socket.AF_INET6:
                raise ConnectionRefusedError("refused")

        def close(self):
            pass

    monkeypatch.setattr(oauth.socket, "getaddrinfo", only_ipv4)
    monkeypatch.setattr(oauth.socket, "socket", FakeSocket)

    result = oauth.callback_reachability(authorize_url(f"http://localhost:{port}/auth/callback"))

    assert result["reachable"] is False
    # The message has to name the mechanism, or "connection refused" is all
    # anyone ever learns.
    assert "::1" in result["detail"]
    assert "127.0.0.1" in result["detail"]
    # And the remedy is the actual fix, on the app that owns the listener.
    assert "both address families" in result["remedy"]


def test_a_reachable_callback_is_not_blocked(monkeypatch) -> None:
    monkeypatch.setattr(oauth, "_connects", lambda *a, **k: True)

    result = oauth.callback_reachability(authorize_url("http://localhost:1455/auth/callback"))

    assert result["reachable"] is True
    assert result["detail"] == ""


def test_a_hosted_redirect_is_not_probed() -> None:
    """Somebody else's server. Probing it says nothing useful and a false
    negative there would block a working sign-in."""
    result = oauth.callback_reachability(authorize_url("https://hivemindos.app/auth/callback"))

    assert result["checked"] is False
    assert result["reachable"] is True


def test_the_browser_model_does_not_fall_back_the_way_a_library_would(monkeypatch) -> None:
    """Python's own loop tries every address and succeeds if any answers, which
    reported localhost:1455 as fine while Chrome could not reach it."""
    tried: list = []

    def two_families(host, port, family=0, socktype=0, *_a, **_k):
        return [
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", port, 0, 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port)),
        ]

    class FakeSocket:
        def __init__(self, family, *_a):
            self.family = family

        def settimeout(self, _):
            pass

        def connect(self, address):
            tried.append(address[0])
            if self.family == socket.AF_INET6:
                raise ConnectionRefusedError("refused")

        def close(self):
            pass

    monkeypatch.setattr(oauth.socket, "getaddrinfo", two_families)
    monkeypatch.setattr(oauth.socket, "socket", FakeSocket)

    assert oauth._connects("localhost", 1455, first_only=True) is False
    assert tried == ["::1"], "a browser does not get a second chance after a refusal"

    tried.clear()
    assert oauth._connects("localhost", 1455) is True
    assert tried == ["::1", "127.0.0.1"]


# ── The route ───────────────────────────────────────────────────────────────


def _client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from hivemind_content_studio.approval_ledger import ApprovalLedger
    from hivemind_content_studio.control_api import build_control_app
    from hivemind_content_studio.orchestrator import ContentOrchestrator
    from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
    from hivemind_content_studio.run_store import RunStore

    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        approvals=ApprovalLedger(tmp_path / "a.sqlite3", signing_secret="s" * 64, operator_token="operator-secret"),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="pw", cipher=cipher),
        private_cipher=cipher,
    )
    client = TestClient(app)
    assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": "pw"}).status_code == 200
    return client


def test_the_route_refuses_to_open_a_sign_in_that_cannot_return(tmp_path, monkeypatch) -> None:
    from hivemind_content_studio import control_api

    monkeypatch.setattr(control_api, "start_oauth_login", lambda provider: {
        "provider": provider,
        "authorize_url": "https://auth.openai.com/authorize?redirect_uri=x",
        "callback": {
            "checked": True, "reachable": False, "target": "localhost:1455",
            "detail": "resolves to ::1 here and the listener is bound to 127.0.0.1 only",
            "remedy": "bind :: rather than 127.0.0.1",
        },
    })
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/oauth/openai/start")

    # 409, not 500: nothing is broken — the round trip just cannot complete yet.
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["remedy"] == "fix-callback"
    assert "::1" in detail["message"]
    assert detail["instruction"] == "bind :: rather than 127.0.0.1"
    assert detail["target"] == "localhost:1455"


def test_a_reachable_callback_still_hands_over_the_url(tmp_path, monkeypatch) -> None:
    from hivemind_content_studio import control_api

    monkeypatch.setattr(control_api, "start_oauth_login", lambda provider: {
        "provider": provider,
        "authorize_url": "https://auth.openai.com/authorize?redirect_uri=x",
        "callback": {"checked": True, "reachable": True, "target": "localhost:1455", "detail": "", "remedy": ""},
    })
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/oauth/openai/start").json()

    assert body["ok"] is True
    assert body["authorize_url"].startswith("https://auth.openai.com/")


def test_an_unprobed_callback_is_never_blocked(tmp_path, monkeypatch) -> None:
    """A false negative here would stop a sign-in that would have worked."""
    from hivemind_content_studio import control_api

    monkeypatch.setattr(control_api, "start_oauth_login", lambda provider: {
        "provider": provider,
        "authorize_url": "https://auth.openai.com/authorize?redirect_uri=x",
        "callback": {"checked": False, "reachable": True, "target": "", "detail": "", "remedy": ""},
    })
    client = _client(tmp_path, monkeypatch)

    assert client.post("/api/oauth/openai/start").json()["ok"] is True
