"""The hosted transport: every marketplace call through the HivemindOS worker.

Nothing here reaches a network. The HTTP boundary is `gateway._session`, faked
per test the way test_rental_providers fakes RunPod's session, and the
studio-level tests fake `gateway.call` the way the direct suites fake
`vast.request`. conftest pins every other file to the direct transport; this
file sets the transport itself, because the transport is what it is about.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio import gpu_rentals, hivemindos_models
from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.rental_providers import (
    Instance,
    LaunchSpec,
    OfferQuery,
    ProviderError,
    gateway,
)
from hivemind_content_studio import rental_providers
from hivemind_content_studio.rental_providers import runpod as runpod_provider
from hivemind_content_studio.rental_providers import vast as vast_provider
from hivemind_content_studio.run_store import RunStore

TOKEN = "hmos_credit_" + "t" * 24
WORKER = "https://worker.example"
MARKET = {
    "ok": True, "enabled": True,
    "providers": [{"key": "vast", "configured": True, "label": "Vast.ai"},
                  {"key": "runpod", "configured": False, "label": "RunPod"}],
    "markupBps": 2500, "blockMinutes": 10, "graceMinutes": 5, "minStartMinutes": 60,
    "balanceCredits": 6150, "balanceUsd": 12.3, "topUp": {},
}


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path: Path):
    """No local marketplace key, no cached market, and the worker at a fake
    address — the only way to it is the faked session below."""
    gateway.forget_market()
    gpu_rentals._offer_cache.clear()
    gpu_rentals._balance_cache.clear()
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "media-state")
    monkeypatch.setenv("HIVEMIND_GPU_RENTALS_GATEWAY_URL", WORKER)
    for key in ("VAST_API_KEY", "RUNPOD_API_KEY", "RUNPOD_MANAGEMENT_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    yield
    gateway.forget_market()


def _connected(monkeypatch, token: str = TOKEN) -> None:
    monkeypatch.setattr(hivemindos_models, "credit_token", lambda: token)


def _transport(monkeypatch, mode: str | None) -> None:
    if mode is None:
        monkeypatch.delenv("HIVEMIND_GPU_RENTALS_TRANSPORT", raising=False)
    else:
        monkeypatch.setenv("HIVEMIND_GPU_RENTALS_TRANSPORT", mode)


class _Response:
    def __init__(self, status: int, body) -> None:
        self.status_code = status
        self._body = body
        self.text = json.dumps(body) if not isinstance(body, str) else body

    def json(self):
        if isinstance(self._body, str):
            raise ValueError("not json")
        return self._body


def _worker(monkeypatch, handler) -> list[dict]:
    """Fake the worker at the requests boundary.

    `handler(method, path, json, headers)` answers `(status, body)`; every
    call is recorded with the URL, body and headers it went out with.
    """
    calls: list[dict] = []

    class Session:
        def request(self, method, url, json=None, headers=None, timeout=None):
            assert url.startswith(WORKER), url
            path = url[len(WORKER):]
            calls.append({"method": method, "path": path, "json": json, "headers": dict(headers or {})})
            status, body = handler(method, path, json, dict(headers or {}))
            return _Response(status, body)

    monkeypatch.setattr(gateway, "_session", Session())
    return calls


def _ok(provider_body, status: int = 200):
    return 200, {"ok": True, "status": status, "body": provider_body}


def _market_and(call_handler):
    """A worker that answers GET /v1/market and hands the rest to `call_handler`."""
    def handler(method, path, body, headers):
        if path == "/v1/market":
            return 200, MARKET
        return call_handler(method, path, body, headers)
    return handler


def _client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    approvals = ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret")
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    owner_access = OwnerAccess.for_testing(password="test-owner-password", cipher=cipher)
    app = build_control_app(
        orchestrator=orchestrator, approvals=approvals, control_token="control-secret",
        operator_token="operator-secret", owner_access=owner_access, private_cipher=cipher,
    )
    client = TestClient(app)
    response = client.post("/api/accounts/unlock", json={"account_id": 1, "password": "test-owner-password"})
    assert response.status_code == 200
    return client


# --- which way a call goes ---------------------------------------------------


def test_auto_follows_the_owners_account(monkeypatch) -> None:
    """A connected HivemindOS account routes through the worker; none falls
    back to the machine's own keys, whether or not it has any."""
    _transport(monkeypatch, None)
    _connected(monkeypatch, "")
    assert gateway.transport() == "direct"
    monkeypatch.setenv("VAST_API_KEY", "local-key")
    assert gateway.transport() == "direct"
    _connected(monkeypatch)
    assert gateway.transport() == "gateway"


def test_the_transport_can_be_forced_either_way(monkeypatch) -> None:
    _connected(monkeypatch, "")
    _transport(monkeypatch, "gateway")
    assert gateway.transport() == "gateway"
    _connected(monkeypatch)
    _transport(monkeypatch, "direct")
    assert gateway.transport() == "direct"
    assert gateway.routes("vast") is False and gateway.routes("runpod") is False


def test_the_transport_is_read_at_call_time_not_at_boot(monkeypatch) -> None:
    """The rule the providers already follow for their env keys: an account
    connected after the stack started works on the next request."""
    _transport(monkeypatch, None)
    _connected(monkeypatch, "")
    assert vast_provider.VastProvider().configured() is False
    _connected(monkeypatch)
    _worker(monkeypatch, _market_and(lambda *_: (400, {"ok": False, "error": "unexpected"})))
    assert vast_provider.VastProvider().configured() is True


# --- GET /v1/market ------------------------------------------------------------


def test_configured_is_what_the_worker_says_and_is_asked_once(monkeypatch) -> None:
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)
    calls = _worker(monkeypatch, _market_and(lambda *_: pytest.fail("no /call expected")))
    assert vast_provider.VastProvider().configured() is True
    assert runpod_provider.RunPodProvider().configured() is False
    assert [p.key for p in rental_providers.configured_providers()] == ["vast"]
    # One round trip for all of that, carrying the token and a real User-Agent
    # (Cloudflare 403s Python's default one).
    assert len(calls) == 1
    assert calls[0]["headers"]["X-HivemindOS-Credit-Token"] == TOKEN
    assert calls[0]["headers"]["User-Agent"] == hivemindos_models.USER_AGENT


def test_a_refusal_is_remembered_until_a_different_account_asks(monkeypatch) -> None:
    """A studio with no account must not ask the worker every poll to be told
    so — but the moment an account IS connected, the cached refusal must not
    be the answer for another minute."""
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch, "")
    calls = _worker(monkeypatch, lambda m, p, b, h: (
        (401, {"ok": False, "error": "no account", "topUp": {}})
        if "X-HivemindOS-Credit-Token" not in h else (200, MARKET)
    ))
    assert vast_provider.VastProvider().configured() is False
    assert vast_provider.VastProvider().configured() is False
    assert len(calls) == 1
    _connected(monkeypatch)
    assert vast_provider.VastProvider().configured() is True
    assert len(calls) == 2


def test_credit_is_the_hivemindos_balance_in_usd(monkeypatch) -> None:
    """Neither marketplace balance is this account's — the worker refuses
    both queries — so credit() answers the one purse that pays."""
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)
    calls = _worker(monkeypatch, _market_and(lambda *_: pytest.fail("balance must not reach /call")))
    assert vast_provider.VastProvider().credit() == 12.3
    assert runpod_provider.RunPodProvider().credit() == 12.3
    assert vast_provider.VastProvider().credit_url == gateway.CREDIT_URL
    assert runpod_provider.RunPodProvider().credit_url == gateway.CREDIT_URL
    assert [c["path"] for c in calls] == ["/v1/market"]


# --- POST /v1/market/{provider}/call ---------------------------------------------


@pytest.mark.marketplace_transport
def test_vast_calls_go_through_the_worker_verbatim(monkeypatch) -> None:
    """The provider-relative call the studio already makes, wrapped; the
    provider body, unwrapped — so the adapter parses what it always parsed."""
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)

    def handler(method, path, body, headers):
        assert method == "POST" and path == "/v1/market/vast/call"
        assert headers["X-HivemindOS-Credit-Token"] == TOKEN
        inner = (body["method"], body["path"])
        if inner == ("POST", "/v0/bundles/"):
            assert body["body"]["gpu_name"] == {"eq": "RTX 5090"}
            return _ok({"offers": [{"id": 41, "gpu_name": "RTX 5090", "dph_total": 0.745, "machine_id": 9}]})
        if inner == ("GET", "/v1/instances/"):
            return _ok({"instances": [{"id": 7, "label": "x", "actual_status": "running", "dph_total": 0.745}]})
        if inner == ("DELETE", "/v0/instances/7/"):
            return _ok({"success": True})
        if inner == ("PUT", "/v0/instances/7/"):
            return _ok({"success": True, "state": body["body"]["state"]})
        pytest.fail(f"unexpected call {inner}")

    calls = _worker(monkeypatch, _market_and(handler))
    vast = vast_provider.VastProvider()
    offers = vast.search_offers(OfferQuery(gpu_names=["RTX 5090"], min_disk_gb=120))
    assert [(o.offer_id, o.usd_per_hour) for o in offers] == [("41", 0.745)]
    assert [i.native_id for i in vast.list_instances()] == ["7"]
    vast.destroy("7")
    vast.pause("7")
    vast.resume("7")
    inner = [(c["json"]["method"], c["json"]["path"], (c["json"].get("body") or {}).get("state"))
             for c in calls if c["path"].endswith("/call")]
    assert inner == [
        ("POST", "/v0/bundles/", None), ("GET", "/v1/instances/", None),
        ("DELETE", "/v0/instances/7/", None),
        ("PUT", "/v0/instances/7/", "stopped"), ("PUT", "/v0/instances/7/", "running"),
    ]


@pytest.mark.marketplace_transport
def test_a_create_carries_the_quote_and_drops_the_cached_balance(monkeypatch) -> None:
    """quotedUsdPerHour is what the worker holds the live rate to; and once
    money moved the minute-old balance is not the balance any more."""
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)

    def handler(method, path, body, headers):
        assert (body["method"], body["path"]) == ("PUT", "/v0/asks/41/")
        assert body["quotedUsdPerHour"] == 0.745
        assert body["body"]["label"] == "hivemind-studio-gpur-test"
        assert body["body"]["onstart"] == "echo hi"
        return _ok({"success": True, "new_contract": 4242})

    calls = _worker(monkeypatch, _market_and(handler))
    assert gateway.balance_usd() == 12.3
    native = vast_provider.VastProvider().create(LaunchSpec(
        image="img", disk_gb=120, label="hivemind-studio-gpur-test", onstart="echo hi",
        expose_ports=[18189], offer_id="41", quoted_usd_per_hour=0.745,
    ))
    assert native == "4242"
    gateway.balance_usd()
    assert [c["path"] for c in calls] == ["/v1/market", "/v1/market/vast/call", "/v1/market"]


@pytest.mark.marketplace_transport
def test_runpod_calls_go_through_the_worker_too(monkeypatch) -> None:
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)

    def handler(method, path, body, headers):
        assert path == "/v1/market/runpod/call"
        inner = (body["method"], body["path"])
        if inner == ("POST", "/graphql"):
            assert "query" in body["body"]
            return _ok({"data": {"myself": {"pods": []}}})
        if inner == ("GET", "/pods"):
            return _ok([{"id": "abc", "name": "x", "desiredStatus": "RUNNING", "costPerHr": 0.86}])
        if inner == ("POST", "/pods"):
            assert body["quotedUsdPerHour"] == 0.86
            assert "networkVolumeId" not in body["body"]
            return _ok({"id": "abc"})
        if inner in {("DELETE", "/pods/abc"), ("POST", "/pods/abc/stop"), ("POST", "/pods/abc/start")}:
            return _ok({})
        pytest.fail(f"unexpected call {inner}")

    calls = _worker(monkeypatch, _market_and(handler))
    runpod = runpod_provider.RunPodProvider()
    assert runpod.create(LaunchSpec(image="img", disk_gb=80, label="l", onstart="echo",
                                    gpu_names=["RTX 5090"], quoted_usd_per_hour=0.86)) == "abc"
    assert [i.native_id for i in runpod.list_instances()] == ["abc"]
    runpod.destroy("abc")
    runpod.pause("abc")
    runpod.resume("abc")
    inner = [(c["json"]["method"], c["json"]["path"]) for c in calls if c["path"].endswith("/call")]
    assert inner == [("POST", "/pods"), ("GET", "/pods"), ("POST", "/graphql"),
                     ("DELETE", "/pods/abc"), ("POST", "/pods/abc/stop"), ("POST", "/pods/abc/start")]
    # And no RunPod key was needed for any of it.
    assert "RUNPOD_API_KEY" not in dict(__import__("os").environ)


@pytest.mark.marketplace_transport
def test_warm_volumes_are_refused_on_the_hosted_transport(monkeypatch) -> None:
    """A volume is the platform's resource. Refused before any round trip,
    with what to do instead; the list is what the worker would answer."""
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)
    calls = _worker(monkeypatch, _market_and(lambda *_: pytest.fail("no call may go out")))
    runpod = runpod_provider.RunPodProvider()
    for attempt in (lambda: runpod.create_network_volume("n", 100, "US-KS-2"),
                    lambda: runpod.delete_network_volume("vol1"),
                    lambda: runpod.create(LaunchSpec(image="i", disk_gb=80, label="l", onstart="e",
                                                     gpu_names=["RTX 5090"], network_volume_id="vol1"))):
        with pytest.raises(ProviderError) as raised:
            attempt()
        assert raised.value.status_code == 400
        assert "warm volumes are not available on hosted rentals yet" in str(raised.value)
        assert "rent a cold box" in str(raised.value)
    assert runpod.list_network_volumes() == []
    assert [c["path"] for c in calls if c["path"].endswith("/call")] == []


# --- the worker's refusals, as statuses the routes pass through --------------


@pytest.mark.marketplace_transport
@pytest.mark.parametrize("status, body, expect_status, expect_text", [
    (401, {"ok": False, "error": "unknown token", "topUp": {}}, 401, "Connect your HivemindOS account to rent GPUs"),
    (402, {"ok": False, "error": "Not enough credits: 0.12 USD short. Add credits.", "requiredCredits": 60}, 402,
     "0.12 USD short"),
    (409, {"ok": False, "error": "the market moved past the quoted price; re-quote and rent again"}, 409,
     "re-quote and rent again"),
    (400, {"ok": False, "error": "GET /v0/users/current/ is not allowed through the hosted marketplace"}, 400,
     "not allowed through the hosted marketplace"),
    (503, {"ok": False, "error": "vast is not configured on the hosted marketplace"}, 503, "not configured"),
    (502, {"ok": False, "error": "Vast.ai failed", "providerStatus": 404,
           "providerBody": '{"error":"no_such_ask","msg":"ask 41 not available"}'}, 502, "no_such_ask"),
    (500, "<html>cloudflare</html>", 502, "error page (HTTP 500)"),
])
def test_worker_errors_keep_their_meaning(monkeypatch, status, body, expect_status, expect_text) -> None:
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)
    _worker(monkeypatch, _market_and(lambda *_: (status, body)))
    with pytest.raises(ProviderError) as raised:
        vast_provider.VastProvider().search_offers(OfferQuery(gpu_names=["RTX 5090"], min_disk_gb=120))
    assert raised.value.status_code == expect_status
    assert expect_text in str(raised.value)


@pytest.mark.marketplace_transport
def test_an_evaporated_ask_still_reads_as_one_through_the_worker(monkeypatch) -> None:
    """create_rental moves to the next candidate on `no_such_ask`. The worker
    relays the provider's words, so that path must keep working hosted."""
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)
    _worker(monkeypatch, _market_and(lambda *_: (502, {
        "ok": False, "error": "Vast.ai failed", "providerStatus": 404,
        "providerBody": '{"error":"no_such_ask"}'})))
    with pytest.raises(ProviderError) as raised:
        vast_provider.VastProvider().create(LaunchSpec(image="i", disk_gb=120, label="l", onstart="e",
                                                       offer_id="41", quoted_usd_per_hour=0.7))
    assert vast_provider.VastProvider.ask_evaporated(raised.value)


@pytest.mark.marketplace_transport
def test_a_worker_that_cannot_be_reached_is_a_503_with_the_repair(monkeypatch) -> None:
    import requests

    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)

    class Session:
        def request(self, *_a, **_k):
            raise requests.ConnectionError("dns")

    monkeypatch.setattr(gateway, "_session", Session())
    with pytest.raises(ProviderError) as raised:
        gateway.market()
    assert raised.value.status_code == 503
    assert "internet connection" in str(raised.value)
    assert vast_provider.VastProvider().configured() is False


# --- what the Machines view is told ---------------------------------------------


def test_no_account_and_no_keys_says_connect_not_buy_keys(monkeypatch) -> None:
    """Transport auto, nothing connected, nothing in the environment: the
    repair is an account. The sentence names the route and the button."""
    _transport(monkeypatch, None)
    _connected(monkeypatch, "")
    state = gpu_rentals.marketplace_setup()
    assert state["configured"] is False and state["remedy"] == "connect-account"
    assert state["detail"] == gateway.CONNECT_MESSAGE
    assert "Models → HivemindOS → Connect" in state["detail"]
    assert "VAST_API_KEY" not in state["detail"] and "passbook" not in state["detail"].lower()


def test_a_sealed_store_is_only_diagnosed_on_the_direct_transport(tmp_path: Path, monkeypatch) -> None:
    """The PassBook sentence sends an owner to unlock keys this rail never
    uses. It stays for the machine that has FORCED direct — there the sealed
    key really is what is in the way."""
    _connected(monkeypatch, "")
    store = tmp_path / "store.env"
    store.write_text('VAST_API_KEY="hive-sealed:v2:notarealciphertext"\n', encoding="utf-8")
    monkeypatch.setenv("HIVE_ENV_FILES", str(store))
    _transport(monkeypatch, None)
    assert gpu_rentals.marketplace_setup()["remedy"] == "connect-account"
    _transport(monkeypatch, "direct")
    state = gpu_rentals.marketplace_setup()
    assert state["remedy"] == "passbook"
    assert "passbook signin" in state["detail"] and "VAST_API_KEY" in state["detail"]


def test_a_forced_gateway_with_no_account_says_connect_with_a_401(monkeypatch) -> None:
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch, "")
    _worker(monkeypatch, lambda *_: (401, {"ok": False, "error": "no account", "topUp": {}}))
    state = gpu_rentals.marketplace_setup()
    assert state["remedy"] == "connect-account" and state["detail"] == gateway.CONNECT_MESSAGE
    with pytest.raises(gpu_rentals.GpuRentalError) as raised:
        gpu_rentals.rental_plan("minimax")
    assert raised.value.status_code == 401


def test_a_worker_with_no_provider_key_is_not_this_machines_problem(monkeypatch) -> None:
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)
    _worker(monkeypatch, lambda *_: (200, {**MARKET, "providers": [
        {"key": "vast", "configured": False, "label": "Vast.ai"},
        {"key": "runpod", "configured": False, "label": "RunPod"}]}))
    state = gpu_rentals.marketplace_setup()
    assert state["remedy"] == ""
    assert "nothing on this machine to fix" in state["detail"]
    assert "Vast.ai" in state["detail"] and "RunPod" in state["detail"]


def test_the_machine_list_carries_the_remedy(tmp_path: Path, monkeypatch) -> None:
    """The button is keyed off `remedy`, not off matching the sentence."""
    client = _client(tmp_path, monkeypatch)
    # build_control_app re-applies the shared hive env; clear AFTER the build.
    _transport(monkeypatch, None)
    _connected(monkeypatch, "")
    for key in ("VAST_API_KEY", "RUNPOD_API_KEY", "RUNPOD_MANAGEMENT_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    body = client.get("/api/gpu-rentals").json()
    assert body["marketplace"] == {"configured": False, "detail": gateway.CONNECT_MESSAGE,
                                   "remedy": "connect-account"}
    assert client.get("/api/gpu-rentals/offers?tier=image").status_code == 503


# --- one purse ---------------------------------------------------------------------


def _instances() -> list[Instance]:
    return [
        Instance(provider="vast", native_id="7", label="hivemind-studio-gpur-a", state="running", usd_per_hour=0.5),
        Instance(provider="runpod", native_id="x", label="hivemind-studio-gpur-b", state="stopped", usd_per_hour=0.86),
    ]


def test_account_state_is_one_hivemindos_purse(monkeypatch) -> None:
    """Whichever marketplace a box came from, the worker billed HivemindOS
    credit — so there is one balance, one burn and one runway."""
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)
    _worker(monkeypatch, _market_and(lambda *_: pytest.fail("no call expected")))
    state = gpu_rentals.account_state(_instances())
    assert state["providers"] == [{
        "provider": "hivemindos", "label": "HivemindOS", "credit_url": gateway.CREDIT_URL,
        "credit": 12.3, "usd_per_hour_running": 0.5, "hours_remaining": 24.6, "machines_running": 1,
    }]
    assert (state["credit"], state["usd_per_hour_running"], state["hours_remaining"], state["machines_running"]) \
        == (12.3, 0.5, 24.6, 1)


def test_affordability_reads_the_one_purse_whatever_the_rung(monkeypatch) -> None:
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)
    monkeypatch.setattr(gpu_rentals, "_all_instances", _instances)
    _worker(monkeypatch, _market_and(lambda *_: pytest.fail("no call expected")))
    # $12.30 funds a RunPod rung and a Vast rung alike.
    gpu_rentals._assert_affordable("runpod", 1, 0.86)
    gpu_rentals._assert_affordable("vast", 8, 0.745)
    # $0.90 does not fund another hour alongside the $0.50 already burning —
    # and the refusal names the purse that pays, not a marketplace.
    gateway.forget_market()
    _worker(monkeypatch, lambda *_: (200, {**MARKET, "balanceUsd": 0.9}))
    with pytest.raises(gpu_rentals.GpuRentalError) as raised:
        gpu_rentals._assert_affordable("runpod", 1, 0.86)
    assert raised.value.status_code == 402
    assert "HivemindOS credit" in str(raised.value)
    assert gateway.CREDIT_URL in str(raised.value)
    assert "RunPod credit" not in str(raised.value)


@pytest.mark.marketplace_transport
def test_renting_threads_the_offers_own_quote_to_the_worker(tmp_path: Path, monkeypatch) -> None:
    """The studio-level path: create_rental hands each ask ITS price — the
    fallback within tolerance is quoted at its own figure, not the button's."""
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")
    monkeypatch.setattr(gpu_rentals, "account_state", lambda *_a, **_k: {
        "credit": 50.0, "usd_per_hour_running": 0.0, "hours_remaining": None, "machines_running": 0,
        "providers": [{"provider": "hivemindos", "label": "HivemindOS", "credit_url": gateway.CREDIT_URL,
                       "credit": 50.0, "usd_per_hour_running": 0.0, "machines_running": 0}]})
    monkeypatch.setattr(gpu_rentals, "recent_bad_machine_ids", lambda *_a, **_k: set())
    quoted: list[tuple[str, float | None]] = []

    def handler(method, path, body, headers):
        inner = (body["method"], body["path"])
        if inner == ("POST", "/v0/bundles/"):
            return _ok({"offers": [{"id": 41, "gpu_name": "RTX 5090", "dph_total": 0.596, "machine_id": 1},
                                   {"id": 42, "gpu_name": "RTX 5090", "dph_total": 0.610, "machine_id": 2}]})
        if inner[0] == "PUT":
            quoted.append((body["path"], body.get("quotedUsdPerHour")))
            if body["path"] == "/v0/asks/41/":
                return 502, {"ok": False, "error": "Vast.ai failed", "providerStatus": 404,
                             "providerBody": '{"error":"no_such_ask"}'}
            return _ok({"success": True, "new_contract": 4242})
        pytest.fail(f"unexpected {inner}")

    _worker(monkeypatch, _market_and(handler))
    result = gpu_rentals.create_rental("minimax", offer_id=41, gpu_class="rtx5090", max_usd_per_hour=0.596)
    assert result["rental_id"] == "vast:4242" and result["usd_per_hour"] == 0.61
    assert quoted == [("/v0/asks/41/", 0.596), ("/v0/asks/42/", 0.61)]


# --- the meter must be fed ------------------------------------------------------------


class _Clock(threading.Event):
    """A shutdown event that records every wait and stops after N sweeps."""

    def __init__(self, sweeps: int) -> None:
        super().__init__()
        self.delays: list[float] = []
        self._left = sweeps

    def wait(self, timeout=None):  # noqa: D102
        self.delays.append(timeout)
        if self._left <= 0:
            return True
        self._left -= 1
        return False


def test_the_sweep_lists_every_few_minutes_while_a_hosted_rental_exists(monkeypatch) -> None:
    """The worker can only reserve the next block while it holds this
    account's token — which is exactly when this studio lists. A reservation
    left unsettled past the authority's 15-minute TTL is released, and a
    rental unfed past its grace is destroyed as abandoned. Paused boxes count:
    their disk still meters."""
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)
    listed = {"n": 0}

    def all_instances():
        listed["n"] += 1
        return [Instance(provider="vast", native_id="7", label="hivemind-studio-gpur-a", state="stopped")]

    monkeypatch.setattr(gpu_rentals, "_all_instances", all_instances)
    monkeypatch.setattr(gpu_rentals, "_instance_dto", lambda i, probe=False: {
        "rental_id": str(i.ref), "managed": True, "phase": "stopped"})
    monkeypatch.setattr(gpu_rentals, "reap_failed_rentals", lambda dtos: [])
    clock = _Clock(sweeps=3)
    gpu_rentals._reaper_loop(clock)
    assert listed["n"] == 3
    # The first wait is the boot delay; every wait after a sweep that found a
    # hosted rental is inside three minutes.
    assert all(delay <= 180 for delay in clock.delays[1:])
    assert clock.delays[1:] == [gpu_rentals.GATEWAY_KEEPALIVE_SECONDS] * 3


def test_the_sweep_idles_when_nothing_is_rented_and_keeps_its_old_cadence_direct(monkeypatch) -> None:
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)
    monkeypatch.setattr(gpu_rentals, "_all_instances", lambda: [])
    clock = _Clock(sweeps=1)
    gpu_rentals._reaper_loop(clock)
    assert clock.delays[1:] == [gpu_rentals.REAPER_IDLE_INTERVAL_SECONDS]
    # Direct transport, a managed box: the 3-minute reaper cadence as before.
    _transport(monkeypatch, "direct")
    monkeypatch.setattr(gpu_rentals, "_all_instances", lambda: [
        Instance(provider="vast", native_id="7", label="hivemind-studio-gpur-a", state="running")])
    monkeypatch.setattr(gpu_rentals, "_instance_dto", lambda i, probe=False: {
        "rental_id": str(i.ref), "managed": True, "phase": "running"})
    monkeypatch.setattr(gpu_rentals, "reap_failed_rentals", lambda dtos: [])
    clock = _Clock(sweeps=1)
    gpu_rentals._reaper_loop(clock)
    assert clock.delays[1:] == [gpu_rentals.REAPER_INTERVAL_SECONDS]


def test_the_keepalive_does_not_depend_on_the_autoreap_switch(monkeypatch) -> None:
    """HIVEMIND_RENTAL_AUTOREAP=0 keeps a failed box alive for a hand recovery.
    It must not also let the meter lapse: the list still happens, nothing is
    probed or destroyed."""
    _transport(monkeypatch, "gateway")
    _connected(monkeypatch)
    monkeypatch.setattr(gpu_rentals, "RENTAL_AUTOREAP", False)
    listed = {"n": 0}
    monkeypatch.setattr(gpu_rentals, "_all_instances", lambda: listed.__setitem__("n", listed["n"] + 1) or [
        Instance(provider="vast", native_id="7", label="hivemind-studio-gpur-a", state="running")])
    monkeypatch.setattr(gpu_rentals, "_instance_dto", lambda *_a, **_k: pytest.fail("must not probe"))
    monkeypatch.setattr(gpu_rentals, "reap_failed_rentals", lambda dtos: pytest.fail("must not reap"))
    clock = _Clock(sweeps=2)
    gpu_rentals._reaper_loop(clock)
    assert listed["n"] == 2
    assert clock.delays[1:] == [gpu_rentals.GATEWAY_KEEPALIVE_SECONDS] * 2


# --- the shared blocklist ----------------------------------------------------------


def test_the_shared_blocklist_uses_the_same_resolver(monkeypatch) -> None:
    asked: list[str] = []

    class Response:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"ok": True, "machines": [{"machineId": 5150}]}

    def record(url, **_kwargs):
        asked.append(url)
        return Response()

    monkeypatch.setattr(gpu_rentals.requests, "get", record)
    assert gpu_rentals._shared_bad_machine_ids() == {5150}
    monkeypatch.delenv("HIVEMIND_GPU_RENTALS_GATEWAY_URL")
    assert gpu_rentals._shared_bad_machine_ids() == {5150}
    assert asked == [f"{WORKER}/v1/bad-machines", f"{gateway.DEFAULT_GATEWAY_URL}/v1/bad-machines"]
