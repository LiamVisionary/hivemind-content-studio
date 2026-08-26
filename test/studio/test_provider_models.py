"""The producer on the owner's OWN accounts: which one pays, and what it offers.

Every test is named for what reaches the owner when the rule under it is
missing — an OpenRouter pick billed to OpenAI, an expired ChatGPT sign-in shown
as a raw 401, a Google error whose only useful sentence was thrown away on a
bracket, or a tab that says "not connected" about a key that was just saved.
"""

from __future__ import annotations

import io
import json
import urllib.error

import pytest

from hivemind_content_studio import provider_models, story_producer, text_models


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def opener_for(routes: dict[str, object], *, seen: list | None = None):
    """A world in which only the URLs a test declares answer at all."""
    def opener(request, timeout=None):
        if seen is not None:
            seen.append({
                "url": request.full_url,
                "method": request.get_method(),
                "headers": {key.lower(): value for key, value in request.headers.items()},
                "body": json.loads(request.data.decode()) if request.data and request.data[:1] == b"{"
                        else (request.data.decode() if request.data else None),
            })
        for fragment, payload in routes.items():
            if fragment in request.full_url:
                if isinstance(payload, Exception):
                    raise payload
                if isinstance(payload, bytes):
                    return FakeResponse(payload)
                return FakeResponse(json.dumps(payload).encode())
        raise AssertionError(f"the fixture has no answer for {request.full_url}")
    return opener


def http_error(code: int, body: object) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        "https://example.invalid", code, "err", {},
        io.BytesIO(json.dumps(body).encode()),
    )


@pytest.fixture
def connected(monkeypatch):
    """Connect named providers with fake credentials.

    The suite's autouse isolation reports nothing connected and hands out no
    values; this is the explicit opt-in, and it never returns anything real.
    """
    def connect(**values: str) -> None:
        monkeypatch.setattr(provider_models, "stored_names", lambda: set(values))
        monkeypatch.setattr(
            provider_models, "credential",
            lambda name, reason="": values.get(name, ""),
        )
    return connect


# --------------------------------------------------------------------------
# which account pays
# --------------------------------------------------------------------------


def test_a_model_id_with_a_slash_in_it_stays_with_the_account_that_sells_it() -> None:
    """OpenRouter's ids contain slashes. Splitting on the last one, or on all of
    them, sends `anthropic/claude-x` to Anthropic's endpoint under OpenAI's key —
    a charge on the wrong account, invisible until the bill."""
    provider, upstream = provider_models.split_model("account:openrouter/anthropic/claude-4")
    assert provider.id == "openrouter"
    assert upstream == "anthropic/claude-4"


def test_an_unknown_account_is_refused_rather_than_sent_somewhere_plausible() -> None:
    with pytest.raises(provider_models.ProviderModelsError) as failure:
        provider_models.split_model("account:not-a-provider/whatever")
    assert "not-a-provider" in str(failure.value)
    # The refusal lists what IS known, so the next attempt is informed.
    assert "openrouter" in str(failure.value)


def test_an_account_id_reaches_the_accounts_engine_and_not_the_local_one() -> None:
    """A cloud id sent to the local runtime answers "unknown local model" for a
    model that exists — the exact mis-route this table was built to end."""
    assert text_models.source_of("account:openai/gpt-4.1") == text_models.ACCOUNTS
    assert isinstance(text_models.runtime_for("account:openai/gpt-4.1"),
                      provider_models.AccountsRuntime)


# --------------------------------------------------------------------------
# what the picker is told
# --------------------------------------------------------------------------


def test_an_account_that_was_never_connected_is_offered_rather_than_hidden() -> None:
    """The tab is also how someone finds out the ChatGPT plan they already pay
    for can write scenes. A provider list filtered to what is connected can
    never tell them that."""
    state = provider_models.status(opener=opener_for({}))
    assert state["available"] is False
    ids = {account["id"] for account in state["accounts"]}
    assert {"openai", "anthropic", "chatgpt", "openrouter", "grok"} <= ids
    chatgpt = next(a for a in state["accounts"] if a["id"] == "chatgpt")
    assert chatgpt["connected"] is False
    # A sign-in and a key are different repairs and must not share a button.
    assert chatgpt["remedy"] == "oauth:openai"
    assert next(a for a in state["accounts"] if a["id"] == "openrouter")["remedy"] == "key:OPENROUTER_API_KEY"


def test_a_rejected_key_asks_for_a_new_key_and_a_dead_network_asks_for_a_retry(connected) -> None:
    """One "unavailable" flag cannot carry both: 401 is the credential and 503
    is the weather, and offering "Try again" for a revoked key is a loop."""
    connected(OPENROUTER_API_KEY="k")
    refused = provider_models.status(opener=opener_for({"openrouter": http_error(401, {"error": "bad key"})}))
    row = next(a for a in refused["accounts"] if a["id"] == "openrouter")
    assert row["connected"] is True and row["count"] == 0
    assert row["remedy"] == "key:OPENROUTER_API_KEY"
    assert "bad key" in row["detail"]

    provider_models.forget_cache()
    down = provider_models.status(opener=opener_for({"openrouter": urllib.error.URLError("offline")}))
    assert next(a for a in down["accounts"] if a["id"] == "openrouter")["remedy"] == "retry"


def test_a_provider_that_cannot_be_asked_offers_no_models_rather_than_a_guessed_list(connected) -> None:
    """A hand-written fallback catalog passes the picker and 404s on the first
    press, which is a worse failure than an empty tab that explains itself."""
    connected(OPENROUTER_API_KEY="k")
    state = provider_models.status(opener=opener_for({"openrouter": urllib.error.URLError("offline")}))
    assert [row for row in state["models"] if row["provider"] == "openrouter"] == []
    assert next(a for a in state["accounts"] if a["id"] == "openrouter")["live"] is False


def test_the_catalog_drops_the_ids_that_are_in_it_but_are_not_chat_models(connected) -> None:
    """`/models` is one catalog for every endpoint the provider sells. Offering
    an embedding or a realtime session as a producer fails on the first press
    with the provider's own unhelpful 400."""
    connected(OPENAI_API_KEY="k")
    state = provider_models.status(opener=opener_for({"api.openai.com": {"data": [
        {"id": "gpt-4.1"}, {"id": "text-embedding-3-large"}, {"id": "gpt-realtime-2.1"},
        {"id": "whisper-1"}, {"id": "gpt-3.5-turbo-instruct"}, {"id": "dall-e-3"},
    ]}}))
    assert [row["name"] for row in state["models"]] == ["gpt-4.1"]


def test_googles_models_prefix_is_stripped_so_the_name_is_the_one_people_type(connected) -> None:
    connected(GEMINI_API_KEY="k")
    state = provider_models.status(opener=opener_for({"generativelanguage": {"data": [
        {"id": "models/gemini-pro-latest"},
    ]}}))
    assert [row["name"] for row in state["models"]] == ["gemini-pro-latest"]
    assert state["models"][0]["id"] == "account:gemini/gemini-pro-latest"


def test_openrouters_per_token_price_is_shown_per_million(connected) -> None:
    """Nobody reads $0.0000004. The picker's whole job on this tab is to make
    the cost of a press legible before the press."""
    connected(OPENROUTER_API_KEY="k")
    state = provider_models.status(opener=opener_for({"openrouter": {"data": [
        {"id": "x/y", "pricing": {"prompt": "0.0000004", "completion": "0.0000016"}},
    ]}}))
    assert state["models"][0]["subtitle"] == "$0.4 in · $1.6 out /1M"


def test_the_rows_are_ordered_so_the_first_forty_are_the_same_forty_twice_running(connected) -> None:
    """Providers return their catalogs in no order at all and the picker shows
    the first forty of several hundred. Unsorted, that is a different forty on
    every refresh."""
    connected(OPENROUTER_API_KEY="k")
    state = provider_models.status(opener=opener_for({"openrouter": {"data": [
        {"id": "z-model"}, {"id": "a-model"}, {"id": "m-model"},
    ]}}))
    assert [row["name"] for row in state["models"]] == ["a-model", "m-model", "z-model"]


def test_google_reports_its_error_inside_an_array_and_the_sentence_still_survives(connected) -> None:
    """Google answers with `[{"error": …}]`, and reading only the object shape
    turned "no longer available to new users, use models/gemini-3.6-flash" —
    the single most useful sentence in the exchange — into a bare "HTTP 404"."""
    connected(GEMINI_API_KEY="k")
    runtime = provider_models.runtime(opener=opener_for({
        "generativelanguage": http_error(404, [{"error": {"code": 404, "message": "no longer available, use models/gemini-3.6-flash"}}]),
    }))
    with pytest.raises(provider_models.ProviderModelsError) as failure:
        runtime.chat(model_id="account:gemini/gemini-2.5-flash", messages=[{"role": "user", "content": "hi"}])
    assert "use models/gemini-3.6-flash" in str(failure.value)


# --------------------------------------------------------------------------
# the wire shapes
# --------------------------------------------------------------------------


def test_anthropic_gets_anthropics_body_and_not_openais(connected) -> None:
    """A different shape, not a different dialect: the system prompt is a
    top-level field rather than a message, `max_tokens` is required, and the
    path is /messages. OpenAI's body here returns a 400 that names none of it."""
    connected(ANTHROPIC_API_KEY="k")
    seen: list = []
    runtime = provider_models.runtime(opener=opener_for(
        {"api.anthropic.com": {"content": [{"type": "text", "text": "drafted"}]}}, seen=seen,
    ))
    answer = runtime.chat(
        model_id="account:anthropic/claude-sonnet-4",
        messages=[{"role": "system", "content": "be brief"}, {"role": "user", "content": "go"}],
        max_tokens=700,
    )
    assert answer == "drafted"
    call = seen[-1]
    assert call["url"].endswith("/messages")
    assert call["headers"]["x-api-key"] == "k"
    assert call["headers"]["anthropic-version"] == "2023-06-01"
    assert call["body"]["system"] == "be brief"
    assert call["body"]["max_tokens"] == 700
    assert call["body"]["messages"] == [{"role": "user", "content": "go"}]


def test_the_chatgpt_sign_in_streams_and_never_sends_the_parameter_it_rejects(connected) -> None:
    """The Codex backend answers only a stream, wants the Codex client's own
    headers, and refuses `max_output_tokens` outright. Guessing any of the three
    fails every turn on a plan the owner is already paying for."""
    connected(OPENAI_OAUTH_ACCESS_TOKEN="live", OPENAI_OAUTH_EXPIRES_AT=str(10 ** 13),
              OPENAI_OAUTH_ACCOUNT_ID="acct-1")
    seen: list = []
    stream = (
        b'data: {"type":"response.output_text.delta","delta":"one "}\n\n'
        b': keep-alive\n\n'
        b'data: {"type":"response.output_text.delta","delta":"two"}\n\n'
        b'data: [DONE]\n\n'
    )
    runtime = provider_models.runtime(opener=opener_for({"chatgpt.com": stream}, seen=seen))
    answer = runtime.chat(model_id="account:chatgpt/gpt-5.4",
                          messages=[{"role": "system", "content": "s"}, {"role": "user", "content": "u"}],
                          max_tokens=4096)
    assert answer == "one two"
    call = seen[-1]
    assert call["url"].endswith("/responses")
    assert call["headers"]["originator"] == "codex_cli_rs"
    assert call["headers"]["Chatgpt-account-id".lower()] == "acct-1"
    assert call["body"]["stream"] is True
    assert call["body"]["instructions"] == "s"
    assert "max_output_tokens" not in call["body"]


def test_a_stream_that_fails_after_writing_keeps_what_it_wrote() -> None:
    text, failure = provider_models._read_response_stream(io.BytesIO(
        b'data: {"type":"response.output_text.delta","delta":"kept"}\n\n'
        b'data: {"type":"response.failed","response":{"error":{"message":"cut off"}}}\n\n'
    ))
    assert text == "kept"
    assert failure == "cut off"


# --------------------------------------------------------------------------
# grants
# --------------------------------------------------------------------------


def test_an_expired_sign_in_renews_itself_instead_of_sending_the_owner_to_a_browser(connected, monkeypatch) -> None:
    """A grant is only good for about an hour after the app last touched it.
    Without a refresh here, "reconnect your ChatGPT account" every hour is the
    product — which is the same as not having the feature."""
    connected(OPENAI_OAUTH_ACCESS_TOKEN="stale", OPENAI_OAUTH_REFRESH_TOKEN="r1",
              OPENAI_OAUTH_EXPIRES_AT="1")
    written: list = []
    monkeypatch.setattr(provider_models, "_write_back", lambda values: written.append(values))
    token = provider_models.grant_token(
        provider_models.BY_ID["chatgpt"],
        opener=opener_for({"auth.openai.com": {"access_token": "fresh", "refresh_token": "r2", "expires_in": 3600}}),
    )
    assert token == "fresh"
    # The rotated pair goes back to the SHARED store, or the HivemindOS app is
    # left holding a refresh token this process has already spent.
    assert written[-1]["OPENAI_OAUTH_ACCESS_TOKEN"] == "fresh"
    assert written[-1]["OPENAI_OAUTH_REFRESH_TOKEN"] == "r2"


def test_a_renewal_that_fails_leaves_the_stored_grant_alone_and_offers_the_sign_in(connected, monkeypatch) -> None:
    connected(OPENAI_OAUTH_ACCESS_TOKEN="stale", OPENAI_OAUTH_REFRESH_TOKEN="r1",
              OPENAI_OAUTH_EXPIRES_AT="1")
    written: list = []
    monkeypatch.setattr(provider_models, "_write_back", lambda values: written.append(values))
    with pytest.raises(provider_models.ProviderModelsError) as failure:
        provider_models.grant_token(
            provider_models.BY_ID["chatgpt"],
            opener=opener_for({"auth.openai.com": http_error(400, {"error_description": "revoked"})}),
        )
    assert failure.value.remedy == "oauth:openai"
    # Nothing is written on the way out: a half-written grant is worse than a
    # dead one, because the app on this machine reads the same file.
    assert written == []


def test_the_sign_ins_model_list_is_borrowed_from_the_key_and_cut_to_what_it_can_run(connected) -> None:
    """The Codex backend serves no catalog. Offering everything OpenAI sells
    would put deep-research and speech models on a tab whose grant cannot run
    them; offering nothing would hide a plan the owner already pays for."""
    connected(OPENAI_API_KEY="k", OPENAI_OAUTH_ACCESS_TOKEN="live",
              OPENAI_OAUTH_EXPIRES_AT=str(10 ** 13))
    state = provider_models.status(opener=opener_for({"api.openai.com": {"data": [
        {"id": "gpt-5.4"}, {"id": "gpt-4.1"}, {"id": "o3"}, {"id": "text-embedding-3-large"},
    ]}}))
    grant_rows = sorted(row["name"] for row in state["models"] if row["provider"] == "chatgpt")
    assert grant_rows == ["gpt-5.4", "o3"]
    assert next(a for a in state["accounts"] if a["id"] == "chatgpt")["live"] is True


def test_with_no_openai_key_the_sign_in_still_offers_its_default_and_says_it_is_unchecked(connected) -> None:
    connected(OPENAI_OAUTH_ACCESS_TOKEN="live", OPENAI_OAUTH_EXPIRES_AT=str(10 ** 13))
    state = provider_models.status(opener=opener_for({}))
    account = next(a for a in state["accounts"] if a["id"] == "chatgpt")
    assert [row["name"] for row in state["models"] if row["provider"] == "chatgpt"] == ["gpt-5.4"]
    # Said out loud rather than passed off as a discovered list.
    assert account["live"] is False
    assert "publishes no model list" in account["detail"]


# --------------------------------------------------------------------------
# failures that carry their repair
# --------------------------------------------------------------------------


def test_a_refused_credential_arrives_as_the_button_that_fixes_it(connected) -> None:
    connected(OPENAI_API_KEY="k")
    runtime = provider_models.runtime(opener=opener_for(
        {"api.openai.com": http_error(401, {"error": {"message": "Incorrect API key"}})}))
    with pytest.raises(provider_models.ProviderModelsError) as failure:
        runtime.chat(model_id="account:openai/gpt-4.1", messages=[{"role": "user", "content": "hi"}])
    assert failure.value.remedy == "key:OPENAI_API_KEY"
    assert failure.value.provider == "openai"


def test_a_producer_refusal_reaches_the_studio_with_its_remedy_rather_than_as_a_retry() -> None:
    """A refusal with a repair is not a bad answer and must not be retried —
    retrying a revoked key three times is three failures and no button."""
    class Refusing:
        def chat(self, **_: object) -> str:
            raise provider_models.ProviderModelsError(
                "ChatGPT (sign-in) refused this sign-in", remedy="oauth:openai", provider="chatgpt")

    with pytest.raises(provider_models.ProviderModelsError) as failure:
        story_producer.produce(model_id="account:chatgpt/gpt-5.4", task_id="concepts",
                               brief="a pair short", context={}, runtime=Refusing())
    assert failure.value.remedy == "oauth:openai"


# --------------------------------------------------------------------------
# which model a fresh install starts on
# --------------------------------------------------------------------------


def test_a_connected_account_beats_the_capped_free_tier_but_not_paid_hivemindos() -> None:
    """HivemindOS stays the house default when it has credits. Without them what
    answers is the free tier, capped at 1024 output tokens — which drops half a
    section fill on the floor — so an account the owner already pays for goes
    ahead of it rather than behind it."""
    accounts = {"defaultModelId": "account:chatgpt/gpt-5.4", "models": [], "available": True}
    paid = {"available": True, "credits": {"configured": True}, "defaultModelId": "hivemindos/custom:x"}
    free = {"available": True, "credits": {"configured": False}, "defaultModelId": "hivemindos/scout"}

    assert text_models.default_model_id({"models": []}, paid, accounts) == "hivemindos/custom:x"
    assert text_models.default_model_id({"models": []}, free, accounts) == "account:chatgpt/gpt-5.4"
    # And with no accounts at all the free tier is still better than nothing.
    assert text_models.default_model_id({"models": []}, free, {"defaultModelId": ""}) == "hivemindos/scout"


def test_a_model_already_in_ram_still_wins_over_every_account() -> None:
    local = {"models": [{"id": "local.gguf", "fit": "loaded"}]}
    accounts = {"defaultModelId": "account:chatgpt/gpt-5.4"}
    paid = {"available": True, "credits": {"configured": True}, "defaultModelId": "hivemindos/custom:x"}
    assert text_models.default_model_id(local, paid, accounts) == "local.gguf"
