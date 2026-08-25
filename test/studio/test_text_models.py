"""The producer's two engines: which one runs a model, and what the picker offers.

Every test is named after what reaches the owner when the rule below it is
missing — a cloud model sent to the local runtime and reported as unknown, a
"no credits" refusal with nothing to press, or a machine with no weights on it
being told it has no producer at all.
"""

from __future__ import annotations

import io
import json
import urllib.error

import pytest

from hivemind_content_studio import hivemindos_models, story_producer, text_models


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def opener_for(payloads: dict[str, object], *, seen: list | None = None):
    """A HivemindOS that answers the paths a test declares and nothing else."""
    def opener(request, timeout=None):
        path = request.full_url.split("127.0.0.1:5020", 1)[-1]
        if seen is not None:
            body = json.loads(request.data.decode()) if request.data else None
            seen.append({"path": path, "headers": dict(request.headers), "body": body})
        for prefix, payload in payloads.items():
            if path.startswith(prefix):
                if isinstance(payload, Exception):
                    raise payload
                return FakeResponse(json.dumps(payload).encode())
        raise AssertionError(f"the fixture has no answer for {path}")
    return opener


MODEL_LIST = {
    "object": "list",
    "data": [
        {"id": "hivemindos/auto", "display_name": "Auto",
         "metadata": {"group": "HivemindOS", "badge": "SALE", "tier": "paid", "subtitle": "Best available"}},
        {"id": "hivemindos/swarm-sovereign-scout", "display_name": "Swarm Sovereign Scout",
         "metadata": {"group": "HivemindOS", "badge": "Free", "tier": "free", "subtitle": "Free daily allowance"}},
        {"id": "hivemindos/custom:openai/gpt-5.6-luna", "display_name": "OpenAI: GPT-5.6 Luna",
         "metadata": {"group": "Gateway", "badge": "Wallet", "tier": "paid", "subtitle": "$0.52 in · $3.12 out /1M"}},
    ],
}
CREDITS = {"ok": True, "configured": True, "balanceCredits": 1200, "balanceLabel": "1,200 credits"}


@pytest.fixture
def linked(monkeypatch):
    """A HivemindOS app that is installed, running and linked to this studio."""
    monkeypatch.setattr(hivemindos_models, "_dashboard_token", lambda: "device-token")
    monkeypatch.setenv("HIVEMINDOS_URL", "http://127.0.0.1:5020")
    monkeypatch.setattr(hivemindos_models, "app_is_running", lambda **_: True)


@pytest.fixture
def no_app(monkeypatch, tmp_path):
    """A machine with no HivemindOS app — the case that must still work."""
    monkeypatch.setattr(hivemindos_models, "app_is_running", lambda **_: False)
    monkeypatch.setenv("HIVEMINDOS_GATEWAY_URL", "https://gateway.example")
    monkeypatch.setattr(hivemindos_models, "_store_path", lambda: tmp_path / "hivemindos-models.json")


GATEWAY_LIST = {
    "data": [
        {"id": "openai/gpt-5.6-luna", "display_name": "OpenAI: GPT-5.6 Luna",
         "pricing": {"prompt": 5.2e-07, "completion": 3.12e-06}},
        {"id": "anthropic/claude-opus-4.8", "name": "Anthropic: Claude Opus 4.8",
         "pricing": {"prompt": 5e-06, "completion": 2.5e-05}},
    ],
}


def gateway_opener(payloads: dict[str, object], *, seen: list | None = None):
    def opener(request, timeout=None):
        path = request.full_url.split("gateway.example", 1)[-1]
        if seen is not None:
            body = json.loads(request.data.decode()) if request.data else None
            seen.append({"path": path, "headers": dict(request.headers), "body": body})
        for prefix, payload in payloads.items():
            if path.startswith(prefix):
                if isinstance(payload, Exception):
                    raise payload
                return FakeResponse(json.dumps(payload).encode())
        raise AssertionError(f"the fixture has no answer for {path}")
    return opener


def test_the_cloud_producer_works_with_no_hivemindos_app_installed(no_app) -> None:
    """The app is a proxy in front of a public gateway. Requiring it would have
    left every user who has not downloaded it with no cloud producer at all."""
    assert hivemindos_models.resolve_route() == hivemindos_models.ROUTE_DIRECT

    models = hivemindos_models.catalog(opener=gateway_opener({"/api/paid-agents/": GATEWAY_LIST}))
    ids = [model["id"] for model in models]

    # Same ids as the app route, so a model chosen today is still the model
    # chosen after installing the app tomorrow.
    assert hivemindos_models.DEFAULT_MODEL_ID in ids
    assert hivemindos_models.FREE_MODEL_ID in ids
    luna = next(model for model in models if model["id"] == hivemindos_models.DEFAULT_MODEL_ID)
    # Priced exactly as the app prints it: the same model must not appear to
    # cost two different things in two of HivemindOS's own products.
    assert luna["subtitle"] == "$0.52 in · $3.12 out /1M"
    # The house tiers are NOT invented here: their GPU-first routing lives in the
    # app, and offering them without it would promise something this cannot do.
    assert "hivemindos/auto" not in ids


def test_without_the_app_the_free_model_needs_no_account_and_no_credits(no_app) -> None:
    seen: list = []
    engine = hivemindos_models.HivemindosRuntime(opener=gateway_opener({
        "/api/free-models/": {"choices": [{"message": {"content": "OK"}}]},
    }, seen=seen))

    assert engine.chat(model_id=hivemindos_models.FREE_MODEL_ID,
                       messages=[{"role": "user", "content": "hi"}]) == "OK"

    call = seen[0]
    assert call["path"].startswith(f"/api/free-models/{hivemindos_models.FREE_MODEL_UPSTREAM}/chat/completions")
    headers = {key.lower(): value for key, value in call["headers"].items()}
    # Device-scoped, and the device id is STABLE: minting a new one per call
    # would be asking a shared service for a fresh allowance every time.
    assert headers["x-hivemindos-free-device"] == hivemindos_models.device_id()
    assert headers["x-hivemindos-free-device"] == hivemindos_models.device_id()
    # Cloudflare blocks urllib's default agent outright, which reads like an
    # outage rather than a missing header.
    assert "python-urllib" not in headers["user-agent"].lower()


def test_a_hivemindos_install_on_this_machine_is_linked_without_asking(no_app, tmp_path, monkeypatch) -> None:
    """The answer to "can it not just detect the app?" — it can. The app keeps its
    account key in ~/.hivemindos, encrypted with a sibling key file, both owner
    only; this studio already reads its device token and shared env from that
    same directory. Read live rather than copied, so a rotation over there is
    picked up here and there is no second copy to go stale."""
    home = tmp_path / "hivemindos"
    home.mkdir()
    monkeypatch.setenv("HIVEMINDOS_HOME", str(home))
    key_material = "vault-key-material"
    token = "hmos_credit_" + "z" * 30
    (home / hivemindos_models.APP_VAULT_KEY_NAME).write_text(key_material, encoding="utf-8")
    (home / hivemindos_models.APP_VAULT_NAME).write_text(
        json.dumps({"records": {"shared:hivemindos-models::default": _app_vault_record(token, key_material)}}),
        encoding="utf-8",
    )

    assert hivemindos_models.app_credit_token() == token
    assert hivemindos_models.credit_token() == token
    # Said out loud rather than adopted silently: the picker shows where the key
    # came from, and offers to use a different one.
    assert hivemindos_models.credit_source() == "app"

    # A key the owner connected by hand wins — connecting one is a choice, the
    # app's is a convenience.
    hivemindos_models.save_credit_token("hmos_credit_" + "y" * 30)
    assert hivemindos_models.credit_token() == "hmos_credit_" + "y" * 30
    assert hivemindos_models.credit_source() == "connected"


def test_an_unreadable_or_absent_app_vault_just_means_not_linked(no_app, tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HIVEMINDOS_HOME", str(tmp_path / "nothing-here"))
    assert hivemindos_models.app_credit_token() == ""

    home = tmp_path / "broken"
    home.mkdir()
    monkeypatch.setenv("HIVEMINDOS_HOME", str(home))
    (home / hivemindos_models.APP_VAULT_KEY_NAME).write_text("some-key", encoding="utf-8")
    (home / hivemindos_models.APP_VAULT_NAME).write_text("{not json", encoding="utf-8")
    assert hivemindos_models.app_credit_token() == ""

    # A record encrypted under a different key is a failed decrypt, not a crash.
    (home / hivemindos_models.APP_VAULT_NAME).write_text(
        json.dumps({"records": {"shared:hivemindos-models::default": _app_vault_record("t", "other-key")}}),
        encoding="utf-8",
    )
    assert hivemindos_models.app_credit_token() == ""


def _app_vault_record(token: str, key_material: str) -> dict:
    """One record in the HivemindOS app's own vault layout: AES-256-GCM under a
    SHA-256 of the key file's contents, every field base64url."""
    import base64
    import hashlib

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    def b64(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    key = hashlib.sha256(key_material.encode("utf-8")).digest()
    nonce = b"\x01" * 12
    sealed = AESGCM(key).encrypt(nonce, token.encode("utf-8"), None)
    return {
        "walletAgentId": "shared:hivemindos-models", "slug": "default",
        "iv": b64(nonce), "tag": b64(sealed[-16:]), "encryptedToken": b64(sealed[:-16]),
        "updatedAt": "2026-08-26T00:00:00.000Z",
    }


def test_connecting_an_account_verifies_the_key_before_it_is_trusted(no_app) -> None:
    """A key that is stored and only tried later fails in the middle of a
    generation the owner was waiting on."""
    seen: list = []
    result = hivemindos_models.connect_account("hmos_credit_" + "a" * 30, opener=gateway_opener({
        "/api/paid-agents/": {"ok": True, "balanceCredits": 1200},
    }, seen=seen))

    assert result == {"connected": True, "credits": 1200, "label": "1,200 credits"}
    assert seen[0]["path"].startswith("/api/paid-agents/default/credits/balance")
    assert hivemindos_models.credit_token() == "hmos_credit_" + "a" * 30

    # A typo is refused where it was typed, without a round trip.
    with pytest.raises(hivemindos_models.HivemindosModelsError) as excinfo:
        hivemindos_models.connect_account("not-a-key")
    assert excinfo.value.remedy == "connect-account"


def test_a_connected_account_is_topped_up_rather_than_a_second_one_opened(no_app) -> None:
    """The gateway credits whichever account's key is presented. Leaving it out
    mints a new account, which is how an owner ends up with two balances."""
    hivemindos_models.save_credit_token("hmos_credit_" + "b" * 30)
    seen: list = []
    hivemindos_models.start_top_up(amount_usd=5, opener=gateway_opener({
        "/api/paid-agents/": {"ok": True, "checkoutUrl": "https://pay.example/s"},
    }, seen=seen))

    assert seen[0]["headers"]["X-hivemindos-credit-token"] == "hmos_credit_" + "b" * 30


def test_two_balances_can_be_folded_into_one(no_app) -> None:
    """Credits bought here before the owner connected the account they already
    had. Stranding that money in an account nothing can see is the worse answer."""
    seen: list = []
    result = hivemindos_models.merge_accounts(
        ["hmos_credit_" + "a" * 30, "hmos_credit_" + "b" * 30],
        opener=gateway_opener({"/api/paid-agents/": {"ok": True, "creditToken": "hmos_credit_" + "c" * 30, "balanceCredits": 2400}}, seen=seen),
    )

    assert result["credits"] == 2400
    assert seen[0]["path"].startswith("/api/paid-agents/default/credits/consolidate")
    assert len(seen[0]["body"]["creditTokens"]) == 2
    # The surviving account's key becomes the one this studio spends.
    assert hivemindos_models.credit_token() == "hmos_credit_" + "c" * 30


def test_without_the_app_a_paid_model_spends_the_owners_hivemindos_account(no_app) -> None:
    seen: list = []
    engine = hivemindos_models.HivemindosRuntime(opener=gateway_opener({
        "/api/paid-agents/": {"choices": [{"message": {"content": "OK"}}]},
    }, seen=seen))

    # Nothing connected yet: refused with the action that fixes it — connect the
    # account they already have, NOT "buy a second balance here".
    with pytest.raises(hivemindos_models.HivemindosModelsError) as excinfo:
        engine.chat(model_id=hivemindos_models.DEFAULT_MODEL_ID, messages=[{"role": "user", "content": "hi"}])
    assert excinfo.value.remedy == "connect-account"
    assert not seen

    hivemindos_models.save_credit_token("hmos_credit_" + "a" * 30)
    engine.chat(model_id=hivemindos_models.DEFAULT_MODEL_ID, messages=[{"role": "user", "content": "hi"}])

    call = seen[0]
    assert call["path"].startswith("/api/paid-agents/default/chat/completions")
    assert call["headers"]["X-hivemindos-credit-token"] == "hmos_credit_" + "a" * 30
    # The gateway is asked for ITS id, not ours.
    assert call["body"]["model"] == "openai/gpt-5.6-luna"


def test_the_account_key_is_encrypted_on_disk_and_never_stored_in_the_clear(no_app) -> None:
    key = "hmos_credit_" + "a" * 30
    hivemindos_models.save_credit_token(key)

    raw = (hivemindos_models._store_path()).read_text(encoding="utf-8")

    assert key not in raw
    assert hivemindos_models.credit_token() == key
    hivemindos_models.forget_credit_token()
    assert hivemindos_models.credit_token() == ""


def test_the_key_at_rest_does_not_depend_on_a_macos_keychain(no_app) -> None:
    """The studio also runs in a Linux container. Keying this off the Keychain
    took every credit path down there — which is where CI found it."""
    hivemindos_models.save_credit_token("hmos_credit_" + "a" * 30)

    key_file = hivemindos_models._store_key_path()
    assert key_file.exists()
    assert oct(key_file.stat().st_mode)[-3:] == "600"
    # A store without its key file is unreadable rather than a crash.
    key_file.unlink()
    assert hivemindos_models.credit_token() == ''


def test_credits_are_bought_where_the_balance_lives(no_app, monkeypatch) -> None:
    """With the app running the balance is the machine's, so a second one bought
    here would split it. Without the app there is nowhere else to buy."""
    seen: list = []
    result = hivemindos_models.start_top_up(amount_usd=5, opener=gateway_opener({
        "/api/paid-agents/": {"ok": True, "checkoutUrl": "https://pay.example/session", "creditToken": "tok"},
    }, seen=seen))
    # Nothing connected, so this opens an account — the only honest option for
    # someone who has never had HivemindOS credits.
    assert result == {"checkoutUrl": "https://pay.example/session", "stored": True, "openedNewAccount": True}
    assert hivemindos_models.credit_token() == "tok"
    assert seen[0]["body"]["amountUsd"] == 5

    monkeypatch.setattr(hivemindos_models, "app_is_running", lambda **_: True)
    with pytest.raises(hivemindos_models.HivemindosModelsError) as excinfo:
        hivemindos_models.start_top_up()
    assert excinfo.value.remedy == "open-hivemindos"


def test_the_app_is_used_when_it_is_running_so_one_balance_serves_the_machine(monkeypatch) -> None:
    monkeypatch.setattr(hivemindos_models, "_dashboard_token", lambda: "device-token")
    monkeypatch.setattr(hivemindos_models, "_connects", lambda host, port, timeout=1.0: True)
    assert hivemindos_models.resolve_route(connector=lambda host, port: True) == hivemindos_models.ROUTE_APP

    # Installed but closed, and linked but never installed, are both the direct
    # route: a token with nothing listening spends nothing.
    assert hivemindos_models.resolve_route(connector=lambda host, port: False) == hivemindos_models.ROUTE_DIRECT
    monkeypatch.setattr(hivemindos_models, "_dashboard_token", lambda: "")
    assert hivemindos_models.resolve_route(connector=lambda host, port: True) == hivemindos_models.ROUTE_DIRECT


def test_a_hivemindos_id_runs_on_the_cloud_engine_and_everything_else_runs_locally() -> None:
    # The image side learned this the expensive way: dispatching on anything but
    # the provider sent an OpenAI pick to MUAPI. One prefix, one table.
    assert isinstance(text_models.runtime_for("hivemindos/custom:openai/gpt-5.6-luna"),
                      hivemindos_models.HivemindosRuntime)
    assert text_models.source_of("hivemindos/auto") == text_models.HIVEMINDOS
    assert text_models.source_of("qwen3-30b-a3b-instruct") == text_models.LOCAL
    assert not isinstance(text_models.runtime_for("qwen3-30b-a3b-instruct"),
                          hivemindos_models.HivemindosRuntime)


def test_the_catalog_normalizes_cloud_rows_into_picker_rows(linked) -> None:
    models = hivemindos_models.catalog(opener=opener_for({"/api/hivemindos/models/models": MODEL_LIST}))

    assert [model["id"] for model in models] == [row["id"] for row in MODEL_LIST["data"]]
    luna = models[-1]
    assert luna["name"] == "OpenAI: GPT-5.6 Luna"
    assert luna["group"] == "Gateway"
    assert luna["tier"] == "paid"
    # Every row says which source it came from, because that is what decides the
    # engine, the bill and the privacy sentence beside it.
    assert {model["source"] for model in models} == {"hivemindos"}


def test_the_cloud_default_is_gpt_luna_and_never_a_model_the_gateway_does_not_carry(linked) -> None:
    state = hivemindos_models.status(opener=opener_for({
        "/api/hivemindos/models/models": MODEL_LIST,
        "/api/hivemindos/models/credits": CREDITS,
    }))
    assert state["defaultModelId"] == "hivemindos/custom:openai/gpt-5.6-luna"
    assert state["credits"] == {
        "configured": True, "credits": 1200, "label": "1,200 credits", "source": "app",
    }

    # A gateway without it falls back to something present. A default that 404s
    # on the first press is worse than an honest second choice.
    thinner = {"object": "list", "data": [MODEL_LIST["data"][0], MODEL_LIST["data"][1]]}
    fallback = hivemindos_models.status(opener=opener_for({
        "/api/hivemindos/models/models": thinner,
        "/api/hivemindos/models/credits": CREDITS,
    }))
    assert fallback["defaultModelId"] == "hivemindos/auto"


def test_the_completion_goes_out_openai_shaped_with_the_studios_funding_identity(linked) -> None:
    seen: list = []
    engine = hivemindos_models.HivemindosRuntime(opener=opener_for({
        "/api/hivemindos/models/chat/completions": {
            "choices": [{"message": {"content": '{"values": {}}'}}],
        },
    }, seen=seen))

    answer = engine.chat(
        model_id="hivemindos/custom:openai/gpt-5.6-luna",
        messages=[{"role": "user", "content": "hello"}],
        temperature=0.5, max_tokens=64,
    )

    assert answer == '{"values": {}}'
    call = seen[0]
    assert call["path"] == "/api/hivemindos/models/chat/completions"
    assert call["body"]["model"] == "hivemindos/custom:openai/gpt-5.6-luna"
    assert call["body"]["stream"] is False
    assert call["body"]["max_tokens"] == 64
    # The same headers the HivemindOS app sends itself: the device token that
    # authenticates the local call, and a funding identity for the ledger.
    headers = {key.lower(): value for key, value in call["headers"].items()}
    assert headers["x-hivemindos-device-token"] == "device-token"
    assert headers["x-hivemindos-wallet-agent-id"] == hivemindos_models.AGENT_ID


def test_the_free_model_is_billed_as_the_free_tier_rather_than_to_credits(linked) -> None:
    seen: list = []
    engine = hivemindos_models.HivemindosRuntime(opener=opener_for({
        "/api/hivemindos/models/chat/completions": {"choices": [{"message": {"content": "ok"}}]},
    }, seen=seen))

    engine.chat(model_id=hivemindos_models.FREE_MODEL_ID, messages=[{"role": "user", "content": "hi"}])

    headers = {key.lower(): value for key, value in seen[0]["headers"].items()}
    assert headers["x-hivemindos-wallet-agent-id"] == hivemindos_models.FREE_AGENT_ID


def test_the_free_tier_budget_is_clamped_rather_than_refused(linked) -> None:
    """Measured against the live service on 2026-08-25: the free model REFUSES a
    call that asks for more than 1024 output tokens ("Free Scout requests may use
    at most 1024 output tokens."), and the producer's tasks budget 3000-6000. So
    every stage button failed on that model until the budget was clamped. A short
    answer is already survivable — the producer salvages what finished."""
    seen: list = []
    engine = hivemindos_models.HivemindosRuntime(opener=opener_for({
        "/api/hivemindos/models/chat/completions": {"choices": [{"message": {"content": "ok"}}]},
    }, seen=seen))

    engine.chat(model_id=hivemindos_models.FREE_MODEL_ID,
                messages=[{"role": "user", "content": "hi"}], max_tokens=6000)
    engine.chat(model_id="hivemindos/custom:openai/gpt-5.6-luna",
                messages=[{"role": "user", "content": "hi"}], max_tokens=6000)

    assert seen[0]["body"]["max_tokens"] == hivemindos_models.FREE_MODEL_MAX_TOKENS
    # A paid model is left alone: its budget is the task's business.
    assert seen[1]["body"]["max_tokens"] == 6000


def test_a_refusal_arrives_with_the_action_that_repairs_it(linked) -> None:
    """"Add credits before chatting" is a state with a button. Delivered as a
    bare sentence it is the OAuth failure this project already fixed once."""
    def refuse(code: str, message: str):
        return urllib.error.HTTPError(
            "http://127.0.0.1:5020", int(code), "no", {},
            io.BytesIO(json.dumps({"error": message}).encode()),
        )

    engine = hivemindos_models.HivemindosRuntime(opener=opener_for({
        "/api/hivemindos/models/chat/completions": refuse(
            "404", "Add HivemindOS Models credits with card or link a local funding wallet before chatting."),
    }))
    with pytest.raises(hivemindos_models.HivemindosModelsError) as excinfo:
        engine.chat(model_id="hivemindos/auto", messages=[{"role": "user", "content": "hi"}])
    assert excinfo.value.remedy == "top-up"
    # HivemindOS's own sentence is kept — it is already written for a person.
    assert "Add HivemindOS Models credits" in str(excinfo.value)

    unlinked = hivemindos_models.HivemindosRuntime(opener=opener_for({
        "/api/hivemindos/models/chat/completions": refuse("401", "Dashboard authentication is required."),
    }))
    with pytest.raises(hivemindos_models.HivemindosModelsError) as unauthorized:
        unlinked.chat(model_id="hivemindos/auto", messages=[{"role": "user", "content": "hi"}])
    assert unauthorized.value.remedy == "link-hivemindos"


def test_a_hivemindos_that_cannot_be_reached_at_all_is_a_state_the_picker_renders() -> None:
    # No app AND no network. Not an exception that empties the picker: the owner
    # has to be able to see that the source exists and what would make it work.
    state = hivemindos_models.status()
    assert state["reachable"] is False
    assert state["route"] == hivemindos_models.ROUTE_DIRECT
    assert state["remedy"] == "retry"
    assert state["models"] == []
    assert state["defaultModelId"] == hivemindos_models.DEFAULT_MODEL_ID


def test_the_starting_model_prefers_ram_then_the_cloud_then_a_cold_local_load() -> None:
    loaded = {"models": [{"id": "big", "fit": "fits"}, {"id": "warm", "fit": "loaded"}]}
    cloud = {"available": True, "defaultModelId": "hivemindos/custom:openai/gpt-5.6-luna"}

    # Already in RAM: free, private, answers now.
    assert text_models.default_model_id(loaded, cloud) == "warm"
    # No weights on this machine at all — the case the cloud producer exists for.
    assert text_models.default_model_id({"models": []}, cloud) == "hivemindos/custom:openai/gpt-5.6-luna"
    # Nothing loaded and no HivemindOS: a cold load beats no producer.
    assert text_models.default_model_id({"models": [{"id": "big", "fit": "fits"}]}, {"available": False}) == "big"
    assert text_models.default_model_id({"models": []}, {"available": False}) == ""


def test_the_catalog_reports_a_broken_source_instead_of_dropping_it(monkeypatch) -> None:
    monkeypatch.setattr(text_models, "_local_source", lambda: {
        "id": "local", "label": "On this machine", "available": False,
        "detail": "No local models found on this machine.", "remedy": "add-local-model", "models": [],
    })
    catalog = text_models.catalog()

    cloud = catalog["sources"]["hivemindos"]
    assert cloud["available"] is False
    assert cloud["remedy"] == "retry"
    # Both sources are still listed, so the picker can show what is missing.
    assert set(catalog["sources"]) == {"local", "hivemindos"}


def test_a_cloud_failure_keeps_its_repair_instead_of_becoming_a_producer_error(linked) -> None:
    """"You have no credits" has a button behind it. Flattened into the
    producer's own error type it arrives as a sentence with nothing to press —
    the exact failure this project already fixed once for OAuth."""
    class Broke:
        def __init__(self, error):
            self.error = error
            self.calls = 0

        def chat(self, **_):
            self.calls += 1
            raise self.error

    engine = Broke(hivemindos_models.HivemindosModelsError("No credits.", remedy="top-up"))
    with pytest.raises(hivemindos_models.HivemindosModelsError) as excinfo:
        story_producer.produce(model_id="hivemindos/auto", task_id="fill", brief="", runtime=engine)
    assert excinfo.value.remedy == "top-up"
    # Not retried: asking again spends another wait to be told the same thing.
    assert engine.calls == 1

    # A cloud failure with no repair is an answer problem, so it reads as one —
    # the studio toasts it exactly like a local model that would not answer.
    empty = Broke(hivemindos_models.HivemindosModelsError("The cloud model returned an empty answer."))
    with pytest.raises(story_producer.StoryProducerError):
        story_producer.produce(model_id="hivemindos/auto", task_id="fill", brief="", runtime=empty)
    assert empty.calls == 1


# ---------------- the routes ----------------

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



def test_the_catalog_route_answers_with_both_sources_and_a_starting_model(tmp_path, monkeypatch) -> None:
    from hivemind_content_studio import control_api

    monkeypatch.setattr(control_api.text_models, "catalog", lambda: {
        "sources": {"local": {"id": "local", "available": True, "models": [{"id": "warm", "fit": "loaded"}]},
                    "hivemindos": {"id": "hivemindos", "available": False, "remedy": "link-hivemindos", "models": []}},
        "models": [{"id": "warm", "fit": "loaded", "source": "local"}],
        "defaultModelId": "warm",
    })
    client = _client(tmp_path, monkeypatch)

    body = client.get("/api/text-models").json()

    assert body["ok"] is True
    assert body["defaultModelId"] == "warm"
    assert set(body["sources"]) == {"local", "hivemindos"}


def test_the_catalog_route_is_owner_only(tmp_path, monkeypatch) -> None:
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
    # Which models this machine has is the owner's business, and the cloud half
    # of the answer is attached to their credits.
    assert TestClient(app).get("/api/text-models").status_code == 401


def test_the_producer_route_hands_a_cloud_refusal_over_with_its_repair(tmp_path, monkeypatch) -> None:
    """The studio turns `remedy` into a button. Flattened to a string here, the
    owner gets a sentence and no way to act on it."""
    from hivemind_content_studio import control_api

    class Refuses:
        def chat(self, **_):
            raise hivemindos_models.HivemindosModelsError(
                "Add HivemindOS Models credits with card or link a local funding wallet before chatting.",
                remedy="top-up",
            )

    monkeypatch.setattr(control_api.text_models, "runtime_for", lambda model_id: Refuses())
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/story/producer", json={
        "modelId": "hivemindos/custom:openai/gpt-5.6-luna", "task": "concepts", "brief": "two ideas",
    })

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["remedy"] == "top-up"
    assert detail["provider"] == "hivemindos"
    assert "credits" in detail["message"]


# ---------------- the app-mediated link ----------------

def test_the_deep_link_carries_a_one_time_secret_and_the_callback_to_answer(no_app) -> None:
    first = hivemindos_models.start_link("http://127.0.0.1:8765/api/hivemindos/models/link-callback")
    second = hivemindos_models.start_link("http://127.0.0.1:8765/api/hivemindos/models/link-callback")

    assert first["url"].startswith("hivemindos://models/link?")
    assert first["nonce"] != second["nonce"]
    assert len(first["nonce"]) >= 32
    # The app has to be told where to answer, and which app is asking.
    assert "callback=http%3A%2F%2F127.0.0.1%3A8765" in first["url"]
    assert "app=Hivemind+Content+Studio" in first["url"]
    assert hivemindos_models.link_state(first["nonce"]) == "pending"


def test_the_link_completes_once_and_only_for_a_request_this_studio_started(no_app) -> None:
    started = hivemindos_models.start_link("http://127.0.0.1:8765/api/hivemindos/models/link-callback")
    key = "hmos_credit_" + "a" * 30
    opener = gateway_opener({"/api/paid-agents/": {"ok": True, "balanceCredits": 1200}})

    result = hivemindos_models.complete_link(started["nonce"], key, opener=opener)

    assert result["connected"] is True
    assert hivemindos_models.credit_token() == key
    assert hivemindos_models.link_state(started["nonce"]) == "linked"

    # Replay of the same nonce is refused: the callback is not owner-gated, so
    # the nonce being single-use is what stops a second hand-over.
    with pytest.raises(hivemindos_models.HivemindosModelsError):
        hivemindos_models.complete_link(started["nonce"], key, opener=opener)


def test_an_unknown_expired_or_used_nonce_all_answer_the_same_way(no_app, monkeypatch) -> None:
    """Telling an unknown local process WHICH of those it hit is telling it how
    to try again."""
    started = hivemindos_models.start_link("http://127.0.0.1:8765/api/hivemindos/models/link-callback")
    monkeypatch.setattr(hivemindos_models, "LINK_TTL_SECONDS", -1.0)
    assert hivemindos_models.link_state(started["nonce"]) == "expired"

    messages = set()
    for nonce in (started["nonce"], "never-issued"):
        with pytest.raises(hivemindos_models.HivemindosModelsError) as excinfo:
            hivemindos_models.complete_link(nonce, "hmos_credit_" + "a" * 30)
        messages.add(str(excinfo.value))
    assert len(messages) == 1


def test_the_callback_is_open_to_the_app_but_only_from_this_machine(tmp_path, monkeypatch) -> None:
    """The poster is the desktop app, not the owner's browser, so this route
    cannot be owner-gated — which makes "local only" the other half of the
    nonce's job."""
    from fastapi.testclient import TestClient

    from hivemind_content_studio import control_api
    from hivemind_content_studio.approval_ledger import ApprovalLedger
    from hivemind_content_studio.control_api import build_control_app
    from hivemind_content_studio.orchestrator import ContentOrchestrator
    from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
    from hivemind_content_studio.run_store import RunStore

    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setattr(hivemindos_models, "_store_path", lambda: tmp_path / "hivemindos-models.json")
    monkeypatch.setattr(control_api.hivemindos_models, "complete_link",
                        lambda nonce, token: {"connected": True, "credits": 1200, "label": "1,200 credits"})
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        approvals=ApprovalLedger(tmp_path / "a.sqlite3", signing_secret="s" * 64, operator_token="operator-secret"),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="pw", cipher=cipher),
        private_cipher=cipher,
    )

    # Signed out, from this machine: accepted, because the app is the caller.
    local = TestClient(app, client=("127.0.0.1", 51000))
    assert local.post("/api/hivemindos/models/link-callback",
                      json={"nonce": "n", "token": "t"}).status_code == 200

    # From anywhere else: refused before the nonce is even considered.
    remote = TestClient(app, client=("10.0.0.9", 51000))
    assert remote.post("/api/hivemindos/models/link-callback",
                       json={"nonce": "n", "token": "t"}).status_code == 403


def test_linking_through_the_app_is_refused_when_the_studio_is_not_on_this_machine(tmp_path, monkeypatch) -> None:
    """`hivemindos://` resolves on the computer the BROWSER is on. Offered from a
    studio opened over the tailnet it would ask the wrong machine, so it is not
    offered at all."""
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/hivemindos/models/link-request", headers={"host": "studio.tail1234.ts.net"})

    assert response.status_code == 400
    assert "this machine" in response.json()["detail"]["message"]


def test_only_the_link_callback_was_added_to_the_sign_in_gate(tmp_path, monkeypatch) -> None:
    """The gate list is the studio's smallest attack surface. This pins it, so
    widening it again is a decision someone makes on purpose."""
    from pathlib import Path

    from hivemind_content_studio import control_api

    source = Path(control_api.__file__).read_text(encoding="utf-8")
    gate = source.split("_GATE_ROUTES = frozenset({", 1)[1].split("})", 1)[0]
    routes = {line.strip().strip('",') for line in gate.splitlines() if line.strip().startswith('"')}

    assert routes == {
        "/api/accounts",
        "/api/accounts/unlock",
        "/api/accounts/webauthn/authenticate/options",
        "/api/accounts/webauthn/authenticate",
        "/api/hivemindos/models/link-callback",
    }
