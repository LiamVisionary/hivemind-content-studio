"""The MUAPI key lives on this machine, not in the browser.

Every other cloud provider is authenticated server-side from the shared Hive
environment — the same file HivemindOS keeps its keys in. MUAPI was the
exception, so a machine that had already been given the key still prompted for
one. This is the shim that closed that, and these are the things that make it a
credential shim rather than an open relay.
"""

from __future__ import annotations

import io
import json

import pytest

from hivemind_content_studio import muapi_proxy


class FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, status: int = 200, headers: dict | None = None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {"Content-Type": "application/json"}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def test_only_the_muapi_api_prefix_may_be_reached() -> None:
    assert muapi_proxy.safe_path("/api/v1/predictions/abc/result") == "api/v1/predictions/abc/result"
    for bad in ("v1/anything", "api/v2/x", "", "/"):
        with pytest.raises(muapi_proxy.MuapiProxyError):
            muapi_proxy.safe_path(bad)


def test_traversal_and_absolute_urls_are_refused_not_normalised() -> None:
    """A proxy that quietly rewrites where it is pointed is one bug from
    pointing somewhere else."""
    for bad in ("api/v1/../../etc/passwd", "api/v1/x://evil.example", "api/v1//double", "api/v1/a\\b"):
        with pytest.raises(muapi_proxy.MuapiProxyError):
            muapi_proxy.safe_path(bad)


def test_nothing_is_forwarded_without_a_key_on_this_machine(monkeypatch) -> None:
    monkeypatch.delenv("MUAPI_API_KEY", raising=False)

    with pytest.raises(muapi_proxy.MuapiProxyError) as excinfo:
        muapi_proxy.forward(method="POST", path="api/v1/flux", opener=lambda *a, **k: None)

    # And it says how to put it there, rather than "not configured". It used to
    # name the store file, which stopped being good advice once the store could
    # be sealed: a hand-added line for a key that is already there, sealed,
    # leaves two entries for one name. What matters is that a repair is named,
    # so that is what is asserted — not the sentence carrying it.
    message = str(excinfo.value)
    assert "MUAPI_API_KEY" in message, message
    assert "passbook add MUAPI_API_KEY" in message, message


def test_this_machines_key_is_attached_and_the_callers_is_not(monkeypatch) -> None:
    monkeypatch.setenv("MUAPI_API_KEY", "server-key")
    seen = {}

    def opener(request, timeout=None):
        seen["url"] = request.full_url
        seen["headers"] = {k.lower(): v for k, v in request.headers.items()}
        seen["body"] = request.data
        return FakeResponse(b'{"request_id": "abc"}')

    muapi_proxy.forward(
        method="POST", path="api/v1/flux-2-pro", body=b'{"prompt":"a pier"}',
        # A browser that sends its own key must not be able to spend through
        # this route, and a cookie must never reach a third party.
        headers={"x-api-key": "someone-elses-key", "Cookie": "session=1", "Content-Type": "application/json"},
        opener=opener,
    )

    assert seen["url"] == "https://api.muapi.ai/api/v1/flux-2-pro"
    assert seen["headers"]["x-api-key"] == "server-key"
    assert "cookie" not in seen["headers"]
    assert seen["body"] == b'{"prompt":"a pier"}'


def test_the_query_string_survives(monkeypatch) -> None:
    monkeypatch.setenv("MUAPI_API_KEY", "server-key")
    seen = {}

    def opener(request, timeout=None):
        seen["url"] = request.full_url
        return FakeResponse(b"{}")

    muapi_proxy.forward(method="GET", path="api/v1/predictions/x/result", query="verbose=1", opener=opener)

    assert seen["url"].endswith("/api/v1/predictions/x/result?verbose=1")


def test_an_upstream_failure_comes_back_verbatim(monkeypatch) -> None:
    """MUAPI puts the reason in the body, and returns a FAILED prediction under a
    `detail` envelope at HTTP 200. The browser client already reads both; a proxy
    that reshaped errors would break that reading."""
    import urllib.error

    monkeypatch.setenv("MUAPI_API_KEY", "server-key")

    def opener(request, timeout=None):
        raise urllib.error.HTTPError(
            request.full_url, 422, "Unprocessable", {"Content-Type": "application/json"},
            io.BytesIO(b'{"detail":"prompt too long"}'),
        )

    status, body, _ = muapi_proxy.forward(method="POST", path="api/v1/flux", opener=opener)

    assert status == 422
    assert json.loads(body)["detail"] == "prompt too long"


def test_a_transport_failure_is_not_mistaken_for_an_answer(monkeypatch) -> None:
    import urllib.error

    monkeypatch.setenv("MUAPI_API_KEY", "server-key")

    def opener(request, timeout=None):
        raise urllib.error.URLError("connection refused")

    with pytest.raises(muapi_proxy.MuapiProxyError) as excinfo:
        muapi_proxy.forward(method="POST", path="api/v1/flux", opener=opener)

    assert "did not answer" in str(excinfo.value)


def test_hop_by_hop_response_headers_are_not_replayed(monkeypatch) -> None:
    monkeypatch.setenv("MUAPI_API_KEY", "server-key")

    def opener(request, timeout=None):
        return FakeResponse(b"{}", headers={
            "Content-Type": "application/json", "Set-Cookie": "a=1",
            "Content-Encoding": "gzip", "X-Request-Id": "keep-me",
        })

    _, _, headers = muapi_proxy.forward(method="GET", path="api/v1/x", opener=opener)

    assert "Set-Cookie" not in headers
    assert "Content-Encoding" not in headers
    assert headers["X-Request-Id"] == "keep-me"


# ── The routes ──────────────────────────────────────────────────────────────


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
    assert client.post("/api/owner/unlock", json={"password": "pw"}).status_code == 200
    return client


def test_status_reports_presence_and_never_the_key(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MUAPI_API_KEY", "super-secret-value")
    client = _client(tmp_path, monkeypatch)

    body = client.get("/api/muapi/status").json()

    assert body["server_key"] is True
    assert "super-secret-value" not in json.dumps(body)


def test_status_says_no_when_this_machine_has_no_key(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("MUAPI_API_KEY", raising=False)
    client = _client(tmp_path, monkeypatch)

    assert client.get("/api/muapi/status").json()["server_key"] is False


def test_the_proxy_is_owner_only(tmp_path, monkeypatch) -> None:
    """It spends money. It is not reachable without the owner session."""
    monkeypatch.setenv("MUAPI_API_KEY", "server-key")
    client = _client(tmp_path, monkeypatch)
    client.cookies.clear()

    assert client.post("/api/muapi/api/v1/flux", json={"prompt": "x"}).status_code in (401, 403)
    assert client.get("/api/muapi/status").status_code in (401, 403)


def test_the_route_forwards_and_returns_the_upstream_status(tmp_path, monkeypatch) -> None:
    from hivemind_content_studio import control_api

    monkeypatch.setenv("MUAPI_API_KEY", "server-key")
    seen = {}

    def fake_forward(*, method, path, query, body, headers, **_):
        seen.update({"method": method, "path": path, "body": body})
        return 200, b'{"request_id":"abc"}', {"Content-Type": "application/json"}

    monkeypatch.setattr(control_api.muapi_proxy, "forward", fake_forward)
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/muapi/api/v1/flux-2-pro", json={"prompt": "a pier"})

    assert response.status_code == 200
    assert response.json()["request_id"] == "abc"
    assert seen["method"] == "POST"
    assert seen["path"] == "api/v1/flux-2-pro"
    assert json.loads(seen["body"])["prompt"] == "a pier"


def test_a_refused_path_is_a_400_the_owner_can_act_on(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MUAPI_API_KEY", "server-key")
    client = _client(tmp_path, monkeypatch)

    response = client.get("/api/muapi/v1/not-the-api")

    assert response.status_code == 400
    assert "api/v1" in response.json()["detail"]
