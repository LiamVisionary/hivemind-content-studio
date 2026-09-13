"""The account row's facts: a name, a meter, and the ways credits get on.

What these hold, in order of how much they would cost to get wrong:

  * the free meter reads the LIVE remaining allowance rather than a ceiling, and
    says "unknown" instead of "zero" when it cannot ask. A meter that reads
    empty on a network blip sends someone to a checkout they did not need.
  * signing in with an email KEEPS the balance that was already here. The merge
    names the signed-in account first, so that is the one that survives.
  * the deposit and subscription rails store a minted account key. A person who
    sends USDC to a quote whose key was dropped has lost real money.
  * the wallet rail only offers itself when the app's pooled balance IS the one
    this studio spends, and the amount the owner is shown comes from a nonce
    this studio minted rather than from the deep-link URL any local process
    could have fired.
"""

import io
import json
import urllib.error
from datetime import datetime, timedelta, timezone

import pytest

from hivemind_content_studio import hivemindos_account, hivemindos_models


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def gateway_opener(payloads: dict[str, object], *, seen: list | None = None):
    """A gateway that answers the paths a test declares and nothing else."""
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


@pytest.fixture(autouse=True)
def _no_cached_overview():
    """`overview` memoises for 12s. Without this a test would be free to pass on
    the answer the previous one produced."""
    hivemindos_account.invalidate_overview()
    yield
    hivemindos_account.invalidate_overview()


@pytest.fixture
def no_app(monkeypatch, tmp_path):
    """A machine with no HivemindOS app — the case that must still work."""
    monkeypatch.setattr(hivemindos_models, "app_is_running", lambda **_: False)
    monkeypatch.setenv("HIVEMINDOS_GATEWAY_URL", "https://gateway.example")
    monkeypatch.setattr(hivemindos_models, "_store_path", lambda: tmp_path / "hivemindos-models.json")


TOKEN = "hmos_credit_" + "a" * 30
OTHER_TOKEN = "hmos_credit_" + "b" * 30

CEILINGS_ONLY = {
    "ok": True,
    "model": {
        "id": "swarm-sovereign-scout-12b",
        "allowance": {"dailyRequests": 400, "dailyTokens": 1_000_000},
    },
}


def _tomorrow() -> str:
    return (datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
            + timedelta(days=1)).isoformat().replace("+00:00", "Z")


class _HeaderResponse(FakeResponse):
    def __init__(self, body: bytes, headers: dict) -> None:
        super().__init__(body)
        self.headers = headers


def header_opener(payload: dict, headers: dict, *, status: int = 200):
    """A gateway that answers with headers as well as a body — the free tier's
    remaining allowance is only ever stated in those."""
    def opener(request, timeout=None):
        body = json.dumps(payload).encode()
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, "", headers, io.BytesIO(body))
        return _HeaderResponse(body, headers)
    return opener


FREE_STATUS = {
    "ok": True,
    "model": {
        "id": "swarm-sovereign-scout-12b",
        "usage": {
            "remainingRequests": 137,
            "remainingTokens": 412_000,
            "requestLimit": 400,
            "tokenLimit": 1_000_000,
            "resetAt": "2026-09-11T00:00:00.000Z",
        },
        "quotaBenefit": {"tierLabel": "Builder"},
        "allowance": {"dailyRequests": 400, "dailyTokens": 1_000_000},
    },
}


# ------------------------------------------------------------------- the name

def test_the_same_account_is_the_same_name_on_every_machine() -> None:
    """The seed is the account id, so a reinstall that restores the account
    restores the person's name with it. A random name stored locally would make
    the same balance a different stranger on every device."""
    assert hivemindos_account.derive_handle("acct-1") == hivemindos_account.derive_handle("acct-1")
    assert hivemindos_account.derive_handle("acct-1") != hivemindos_account.derive_handle("acct-2")


def test_a_derived_name_reads_like_a_name() -> None:
    handle = hivemindos_account.derive_handle("acct-1")
    assert handle[0].isupper() and handle[-3:].isdigit()
    avatar = hivemindos_account.derive_avatar("acct-1")
    assert 0 <= avatar["hue"] < 360 and 0 <= avatar["hue2"] < 360
    assert len(avatar["monogram"]) == 2


def test_a_chosen_name_survives_and_an_empty_one_restores_the_derived_one(no_app, monkeypatch) -> None:
    monkeypatch.setattr(hivemindos_account, "account_id", lambda **_: "acct-7")
    monkeypatch.setattr(hivemindos_account, "account_status", lambda **_: {"reachable": True})

    assert hivemindos_account.set_handle("Studio Bee")["handle"] == "Studio Bee"
    assert hivemindos_account.identity()["handleIsCustom"] is True
    assert hivemindos_account.set_handle("")["handle"] == hivemindos_account.derive_handle("acct-7")


def test_a_name_that_could_pass_for_markup_is_refused(no_app) -> None:
    """The handle is rendered raw in the sidebar."""
    with pytest.raises(hivemindos_models.HivemindosModelsError):
        hivemindos_account.set_handle("<img src=x onerror=alert(1)>")


# ------------------------------------------------------------ the free meter

def test_the_meter_reads_what_is_left_rather_than_the_daily_ceiling(no_app) -> None:
    allowance = hivemindos_account.allowance(opener=gateway_opener({"/api/free-models/": FREE_STATUS}))
    assert allowance["known"] is True
    assert allowance["remainingRequests"] == 137
    assert allowance["requestLimit"] == 400
    assert allowance["tierLabel"] == "Builder"
    assert allowance["source"] == "live"


def test_a_window_that_has_rolled_over_is_a_FULL_allowance_not_an_unknown_one(no_app) -> None:
    """The bug this whole meter was rewritten for. The gateway's status route
    carried a live `usage` block for part of one day and had lost it again by
    the evening, so the only remaining counts around were from a snapshot whose
    reset moment had passed — and the row printed "Free allowance unknown" over
    a tank that was demonstrably full. An expired window is not an unknown one:
    it means the allowance reset and nothing has spent from the new one."""
    hivemindos_models.set_store_value(hivemindos_models.FREE_ALLOWANCE_KEY, {
        "resetAt": "2000-01-01T00:00:00.000Z", "remainingRequests": 3, "remainingTokens": 900,
    })
    allowance = hivemindos_account.allowance(opener=gateway_opener({"/api/free-models/": CEILINGS_ONLY}))
    assert allowance["known"] is True
    assert allowance["remainingRequests"] == 400
    assert allowance["remainingTokens"] == 1_000_000
    assert allowance["source"] == "full"
    # And it still says when the allowance comes back, derived from the UTC day
    # rather than left blank.
    assert allowance["resetAt"].endswith("T00:00:00Z")


def test_a_snapshot_inside_the_current_window_is_what_the_meter_shows(no_app) -> None:
    hivemindos_models.set_store_value(hivemindos_models.FREE_ALLOWANCE_KEY, {
        "resetAt": _tomorrow(), "remainingRequests": 41, "remainingTokens": 120_000,
    })
    allowance = hivemindos_account.allowance(opener=gateway_opener({"/api/free-models/": CEILINGS_ONLY}))
    assert allowance["remainingRequests"] == 41
    assert allowance["requestLimit"] == 400
    assert allowance["source"] == "observed"


def test_two_snapshots_of_one_counter_are_merged_by_taking_the_lowest(no_app, monkeypatch, tmp_path) -> None:
    """The studio and the HivemindOS app spend the SAME per-device allowance
    when the studio proxies through the app, so reading only our own record
    would show a full meter over a tank the app had emptied."""
    monkeypatch.setattr(hivemindos_models, "resolve_route", lambda **_: hivemindos_models.ROUTE_APP)
    monkeypatch.setenv("HIVEMINDOS_HOME", str(tmp_path))
    (tmp_path / "cache").mkdir(parents=True)
    (tmp_path / "cache" / "hivemindos-free-allowance.json").write_text(
        json.dumps({"resetAt": _tomorrow(), "remainingRequests": 12, "remainingTokens": 30_000}),
        encoding="utf-8",
    )
    hivemindos_models.set_store_value(hivemindos_models.FREE_ALLOWANCE_KEY, {
        "resetAt": _tomorrow(), "remainingRequests": 300, "remainingTokens": 800_000,
    })
    allowance = hivemindos_account.allowance(opener=gateway_opener({"/api/free-models/": CEILINGS_ONLY}))
    assert allowance["remainingRequests"] == 12
    assert allowance["remainingTokens"] == 30_000


def test_a_free_call_records_what_the_gateway_said_was_left(no_app) -> None:
    """The headers on a free response are the only reliable statement of the
    remaining allowance, so they are kept on the way past."""
    engine = hivemindos_models.HivemindosRuntime(opener=header_opener(
        {"choices": [{"message": {"content": "hi"}}]},
        {
            "X-HivemindOS-Free-Remaining-Requests": "377",
            "X-HivemindOS-Free-Remaining-Tokens": "941000",
            "X-HivemindOS-Free-Reset-At": _tomorrow(),
        },
    ))
    engine.chat(model_id=hivemindos_models.FREE_MODEL_ID, messages=[{"role": "user", "content": "hi"}])
    assert hivemindos_models.free_allowance_record()["remainingRequests"] == 377


def test_the_call_that_runs_the_allowance_out_records_that_too(no_app) -> None:
    """A 429 carries the headers as well, and it is the single most useful
    moment to keep them: the meter should read empty immediately after, not on
    the next successful call there will not be."""
    engine = hivemindos_models.HivemindosRuntime(opener=header_opener(
        {"ok": False, "error": "Today's free Swarm Sovereign Scout allowance is used up."},
        {
            "X-HivemindOS-Free-Remaining-Requests": "0",
            "X-HivemindOS-Free-Remaining-Tokens": "0",
            "X-HivemindOS-Free-Reset-At": _tomorrow(),
        },
        status=429,
    ))
    with pytest.raises(hivemindos_models.HivemindosModelsError):
        engine.chat(model_id=hivemindos_models.FREE_MODEL_ID, messages=[{"role": "user", "content": "hi"}])
    assert hivemindos_models.free_allowance_record()["remainingRequests"] == 0


def test_asking_for_the_meter_carries_the_device_the_free_calls_spend(no_app) -> None:
    """The allowance is metered per device. Asking without the header would read
    a stranger's meter — or, worse, this machine's IP-scoped one."""
    seen: list = []
    hivemindos_account.allowance(opener=gateway_opener({"/api/free-models/": FREE_STATUS}, seen=seen))
    assert seen[0]["headers"]["X-hivemindos-free-device"] == hivemindos_models.device_id()


def test_an_unreachable_gateway_is_unknown_and_never_empty(no_app) -> None:
    """Zero and unknown look nothing alike to someone about to press Generate."""
    def broken(request, timeout=None):
        raise OSError("no route to host")

    allowance = hivemindos_account.allowance(opener=broken)
    assert allowance["known"] is False
    assert allowance["remainingRequests"] is None


def test_a_remembered_ceiling_keeps_the_meter_alive_when_the_gateway_will_not_answer(no_app) -> None:
    """The ceiling moves when a stake tier does and not otherwise, so holding
    on to it means a slow or unreachable status route costs the meter its
    freshness rather than its existence."""
    hivemindos_account.allowance(opener=gateway_opener({"/api/free-models/": CEILINGS_ONLY}))

    def broken(request, timeout=None):
        raise OSError("no route to host")

    allowance = hivemindos_account.allowance(opener=broken)
    assert allowance["known"] is True
    assert allowance["requestLimit"] == 400
    # And the window rule still applies on top of the remembered ceiling.
    assert allowance["remainingRequests"] == 400


def test_the_status_route_cannot_hold_the_row_for_the_default_timeout(no_app) -> None:
    """It probes Modal for a container state this meter does not want, and the
    row it feeds renders on every page."""
    seen: list = []

    def timing(request, timeout=None):
        seen.append(timeout)
        raise OSError("too slow")

    hivemindos_account.allowance(opener=timing)
    assert seen and seen[0] <= 8.0


def test_the_overview_survives_a_gateway_that_answers_nothing(no_app) -> None:
    """This is the row on screen on every page. It renders or the sidebar does
    not, so nothing in it may raise."""
    def broken(request, timeout=None):
        raise OSError("no route to host")

    overview = hivemindos_account.overview(opener=broken)
    assert overview["identity"]["handle"]
    assert overview["credits"]["configured"] is False


# ------------------------------------------------------------- backing it up

def test_signing_in_keeps_the_balance_that_was_already_here(no_app) -> None:
    hivemindos_models.save_credit_token(OTHER_TOKEN)
    seen: list = []
    result = hivemindos_account.email_signin_verify("challenge-1234", "123456", opener=gateway_opener({
        "/api/mini-app-account/email/signin/verify": {"ok": True, "creditToken": TOKEN, "accountId": "acct-9"},
        "/api/paid-agents/": {"ok": True, "creditToken": TOKEN, "balanceCredits": 900, "accountId": "acct-9"},
        "/api/mini-app-account": {"ok": True, "authenticated": True, "emailLinked": True, "emailMasked": "a…@b.com"},
    }, seen=seen))

    assert result["mergedPreviousBalance"] is True
    merge = next(entry for entry in seen if entry["path"].endswith("/credits/consolidate"))
    # The signed-in account is named FIRST, so it is the one that survives.
    assert merge["body"]["creditTokens"][0] == TOKEN


def test_a_sign_in_still_lands_when_the_merge_cannot(no_app) -> None:
    """The sign-in itself worked. Refusing it over a second balance that is
    still there to fold in later would lose the account they just proved."""
    hivemindos_models.save_credit_token(OTHER_TOKEN)
    calls = {"n": 0}

    def opener(request, timeout=None):
        path = request.full_url.split("gateway.example", 1)[-1]
        if path.endswith("/credits/consolidate"):
            raise OSError("gateway blinked")
        calls["n"] += 1
        if path.endswith("/email/signin/verify"):
            return FakeResponse(json.dumps({"ok": True, "creditToken": TOKEN, "accountId": "acct-9"}).encode())
        return FakeResponse(json.dumps({"ok": True, "balanceCredits": 12, "authenticated": True}).encode())

    result = hivemindos_account.email_signin_verify("challenge-1234", "123456", opener=opener)
    assert result["signedIn"] is True
    assert result["mergedPreviousBalance"] is False
    assert hivemindos_models.credit_token() == TOKEN


def test_a_six_digit_code_is_required_before_anything_is_sent(no_app) -> None:
    def never(request, timeout=None):
        raise AssertionError("a malformed code must not reach the gateway")

    with pytest.raises(hivemindos_models.HivemindosModelsError):
        hivemindos_account.email_signin_verify("challenge-1234", "12", opener=never)
    with pytest.raises(hivemindos_models.HivemindosModelsError):
        hivemindos_account.email_signin_start("not-an-email", opener=never)


def test_there_is_no_recovery_key_before_there_is_an_account(no_app) -> None:
    with pytest.raises(hivemindos_models.HivemindosModelsError) as raised:
        hivemindos_account.recovery_key()
    assert raised.value.remedy == "connect-account"


def test_the_recovery_key_is_the_account_key_itself(no_app) -> None:
    """Not a second secret. A second one would be a second thing to lose, and
    the studio's connect field already accepts this one."""
    hivemindos_models.save_credit_token(TOKEN)
    assert hivemindos_account.recovery_key()["key"] == TOKEN


# ------------------------------------------------------------------ the rails

def test_a_deposit_quote_keeps_the_account_it_opened(no_app) -> None:
    """The gateway mints an account when none is presented. Dropping that key
    would leave the USDC credited to an account nothing on this machine can
    reach."""
    hivemindos_account.deposit_quote("0x" + "a" * 40, 25, opener=gateway_opener({
        "/api/payments/base-usdc/quote": {
            "ok": True, "paymentId": "base_usdc_1", "recipient": "0x" + "b" * 40,
            "amountUsd": 25, "expiresAt": "2026-09-11T00:00:00.000Z", "creditToken": TOKEN,
        },
    }))
    assert hivemindos_models.credit_token() == TOKEN


def test_a_deposit_needs_the_address_it_will_arrive_from(no_app) -> None:
    """The transfer is matched against it, so a bad one silently fails to
    credit — which is why it is refused here rather than at the gateway."""
    def never(request, timeout=None):
        raise AssertionError("a malformed payer must not reach the gateway")

    with pytest.raises(hivemindos_models.HivemindosModelsError):
        hivemindos_account.deposit_quote("my wallet", 25, opener=never)
    with pytest.raises(hivemindos_models.HivemindosModelsError):
        hivemindos_account.deposit_settle("base_usdc_1", "not-a-hash", opener=never)


def test_the_plans_survive_a_gateway_that_will_not_list_them(no_app) -> None:
    """A plans list that cannot be read costs the sheet its subscription
    section, not the top-up that was working."""
    def broken(request, timeout=None):
        raise OSError("no route to host")

    state = hivemindos_account.subscription(opener=broken)
    assert state["available"] is False
    assert state["plans"] == []


def test_cancelling_a_plan_takes_the_confirmation(no_app) -> None:
    hivemindos_models.save_credit_token(TOKEN)

    def never(request, timeout=None):
        raise AssertionError("an unconfirmed cancel must not reach the gateway")

    with pytest.raises(hivemindos_models.HivemindosModelsError):
        hivemindos_account.subscription_cancel("yes", opener=never)


# ------------------------------------------------- the wallet-pay handshake

@pytest.fixture
def shared_with_the_app(monkeypatch):
    """The one configuration the wallet rail is offered in: the app is running
    and this studio spends the very balance the app pools."""
    monkeypatch.setattr(hivemindos_models, "resolve_route", lambda **_: hivemindos_models.ROUTE_APP)
    monkeypatch.setattr(hivemindos_models, "credit_source", lambda: "app")


def test_a_wallet_payment_is_claimed_once_against_the_nonce_it_names(no_app, shared_with_the_app) -> None:
    request = hivemindos_account.start_wallet_payment(25, "http://127.0.0.1:8765/cb")
    assert request["url"].startswith("hivemindos://models/pay?")

    # The amount comes from the request this studio made, never from the URL:
    # any local process can fire a deep link with any number in it.
    claim = hivemindos_account.claim_wallet_payment(request["nonce"])
    assert claim["amountUsd"] == 25
    assert "creditToken" not in claim

    hivemindos_account.complete_wallet_payment(request["nonce"], settled=True)
    assert hivemindos_account.wallet_payment_state(request["nonce"])["state"] == "settled"
    # A settled request is spent: it cannot be claimed a second time.
    with pytest.raises(hivemindos_models.HivemindosModelsError):
        hivemindos_account.claim_wallet_payment(request["nonce"])


def test_an_unknown_nonce_is_refused_without_saying_why(no_app) -> None:
    """Expired, spent and never-issued get the same answer: the caller is a
    local process rather than the owner's browser, and the difference is a hint
    about how to try again."""
    with pytest.raises(hivemindos_models.HivemindosModelsError):
        hivemindos_account.claim_wallet_payment("never-minted")
    assert hivemindos_account.wallet_payment_state("never-minted")["state"] == "expired"


def test_a_studio_on_its_own_account_is_told_rather_than_charged(no_app, monkeypatch) -> None:
    """The app pays into the account IT pools. If that is not the balance this
    studio spends, the owner would be paying into the wrong one — so the rail
    refuses with the two rails that do work named in the sentence."""
    monkeypatch.setattr(hivemindos_models, "resolve_route", lambda **_: hivemindos_models.ROUTE_APP)
    monkeypatch.setattr(hivemindos_models, "credit_source", lambda: "connected")
    assert hivemindos_account.wallet_pay_blocked_reason() == "different-account"
    with pytest.raises(hivemindos_models.HivemindosModelsError) as raised:
        hivemindos_account.start_wallet_payment(10, "http://127.0.0.1:8765/cb")
    assert "different balance" in str(raised.value)


def test_with_no_app_there_is_no_wallet_to_ask(no_app) -> None:
    assert hivemindos_account.wallet_pay_blocked_reason() == "no-app"
    with pytest.raises(hivemindos_models.HivemindosModelsError) as raised:
        hivemindos_account.start_wallet_payment(10, "http://127.0.0.1:8765/cb")
    assert raised.value.remedy == "open-hivemindos"


def test_a_wallet_payment_is_bounded_before_it_is_asked_for(no_app, shared_with_the_app) -> None:
    with pytest.raises(hivemindos_models.HivemindosModelsError):
        hivemindos_account.start_wallet_payment(5000, "http://127.0.0.1:8765/cb")
