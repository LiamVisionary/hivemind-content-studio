"""Models the owner already pays for, under their own provider accounts.

The producer could think with a model on this machine, or with HivemindOS's on
HivemindOS credits. What was missing was the third thing most owners already
have: an OpenAI key, a ChatGPT sign-in, an OpenRouter account, a Grok grant. The
HivemindOS app has offered those for a long time. The studio's producer did not,
so someone paying for ChatGPT was told to buy HivemindOS credits to write a
scene — with the credential for the model they wanted sitting in the shared
store the whole time.

These ARE the HivemindOS app's credentials. There is one credential store per
machine (`shared_env`/PassBook, `~/.hivemindos/.env`), so an account connected
in either app is connected in both, and nothing here keeps a second copy or a
second bill.

Two kinds of credential, deliberately kept apart:

  a key    the owner's own API key. The studio calls the provider directly, so
           this needs no HivemindOS app installed at all.
  a grant  an OAuth sign-in (ChatGPT, Grok). The sign-in itself belongs to
           HivemindOS — it owns the registered callback ports — but the tokens
           it writes land in the SHARED store, so spending and refreshing one
           works here whether or not the app is running. Refusing to refresh
           would have made every grant dead an hour after the app was last used.

Everything is keyed by PROVIDER, for the reason `image_router.py` records at
length: the image side once dispatched on "is it local?" and sent an OpenAI OAuth
pick to MUAPI's billing. A model id here carries its provider —
`account:openai/gpt-4.1` — so the engine, the credential and the endpoint are one
lookup rather than three guesses.

What this module will NOT do:

  * invent a model list. A provider that cannot be asked for its models offers
    none, and says why. A curated fallback list is a list of ids that 404 later.
  * read a credential it is not about to spend. Presence comes from the store's
    key NAMES; the value is requested at the moment of the call, so the access
    ledger records real uses rather than a sweep every time a picker opens.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import shared_env

SOURCE = "accounts"
PREFIX = "account:"

# Long enough that opening the picker twice does not re-ask every provider,
# short enough that a key added in the HivemindOS app shows up without a
# restart. Discovery failures are cached for much less (`_MISS_TTL`), because
# the fix for those is usually seconds away — a network that came back.
_HIT_TTL = 600.0
_MISS_TTL = 45.0

# One provider must not be able to hold up the whole picker.
_DISCOVER_TIMEOUT = 6.0
_DISCOVER_WORKERS = 8

USER_AGENT = "HivemindContentStudio/1.0 (+https://hivemindos.com)"


class ProviderModelsError(RuntimeError):
    """A refusal that carries what to do about it.

    `remedy` is an action id the picker turns into a button; `provider` is the
    account that button acts on. The studio never shows a provider's raw
    sentence on its own — "Invalid refresh token." is not an instruction.
    """

    def __init__(self, message: str, *, remedy: str = "", provider: str = "") -> None:
        super().__init__(message)
        self.remedy = remedy
        self.provider = provider


# --------------------------------------------------------------------------
# the table
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Provider:
    """One account the owner may already have.

    `env` is a TUPLE because the same account is named differently by different
    tools — this machine holds `GOOGLE_AI_STUDIO_API_KEY` while HivemindOS's own
    catalog names `GEMINI_API_KEY`, and a single-name lookup would have reported
    a connected Google account as missing. First name present wins.

    `api` picks the wire format, not the vendor: three providers speak OpenAI's
    chat shape, Anthropic speaks its own, and the ChatGPT grant speaks the Codex
    Responses stream. `models_path` empty means the provider serves no catalog,
    which is a fact about the provider rather than a failure to report.
    """

    id: str
    label: str
    kind: str  # "key" | "oauth"
    env: tuple[str, ...]
    base_url: str
    api: str  # "openai" | "anthropic" | "responses"
    models_path: str = "/models"
    auth: str = "bearer"  # "bearer" | "x-api-key"
    headers: dict[str, str] = field(default_factory=dict)
    # Which of the ids a catalog returns this credential may actually run. The
    # ChatGPT grant reaches one family of models, not everything OpenAI sells.
    model_pattern: str = ""
    # Ids to lead with WHEN THE PROVIDER LISTS THEM. Never offered on their own
    # — an id that is only a preference and not in the discovered catalog is an
    # id that 404s — so an unknown or renamed model here costs nothing.
    preferred: tuple[str, ...] = ()
    # A grant's companion names, so expiry and refresh can be read and written.
    refresh_env: str = ""
    expires_env: str = ""
    account_env: str = ""
    base_url_env: str = ""
    token_url: str = ""
    client_id: str = ""
    scope: str = ""
    # Where the owner goes to connect this. `oauth:<id>` is a sign-in this studio
    # can start itself; `key:<NAME>` is a key it can be given.
    connect: str = ""
    home: str = ""


# The ChatGPT grant publishes no catalog of its own, so its list is borrowed
# from the OpenAI key's and filtered to what the grant can run. Without a key
# there is nothing to borrow, and this is the one id HivemindOS itself falls
# back to (`OPENAI_OAUTH_CHAT_CAPABILITIES.defaultModel`).
CHATGPT_FALLBACK_MODEL = "gpt-5.4"

PROVIDERS: tuple[Provider, ...] = (
    Provider(
        id="openai", label="OpenAI", preferred=("gpt-5.4", "gpt-5", "gpt-4.1", "gpt-4o"), kind="key", env=("OPENAI_API_KEY",),
        base_url="https://api.openai.com/v1", api="openai",
        connect="key:OPENAI_API_KEY", home="https://platform.openai.com/api-keys",
    ),
    Provider(
        id="anthropic", label="Anthropic", preferred=("claude-sonnet", "claude-opus"), kind="key", env=("ANTHROPIC_API_KEY",),
        base_url="https://api.anthropic.com/v1", api="anthropic",
        auth="x-api-key", headers={"anthropic-version": "2023-06-01"},
        connect="key:ANTHROPIC_API_KEY", home="https://console.anthropic.com/settings/keys",
    ),
    Provider(
        id="openrouter", label="OpenRouter", preferred=("openai/gpt-5.4", "anthropic/claude-sonnet"), kind="key", env=("OPENROUTER_API_KEY",),
        base_url="https://openrouter.ai/api/v1", api="openai",
        headers={"HTTP-Referer": "https://hivemindos.com", "X-Title": "Hivemind Content Studio"},
        connect="key:OPENROUTER_API_KEY", home="https://openrouter.ai/keys",
    ),
    Provider(
        # HivemindOS's catalog names GEMINI_API_KEY; the Google console hands out
        # a key most people file under one of the other two names.
        id="gemini", label="Google Gemini", preferred=("gemini-pro-latest", "gemini-flash-latest", "gemini-3"), kind="key",
        env=("GEMINI_API_KEY", "GOOGLE_AI_STUDIO_API_KEY", "GOOGLE_API_KEY"),
        base_url="https://generativelanguage.googleapis.com/v1beta/openai", api="openai",
        connect="key:GEMINI_API_KEY", home="https://aistudio.google.com/apikey",
    ),
    Provider(
        id="xai", label="Grok (xAI)", preferred=("grok-4", "grok-3"), kind="key", env=("XAI_API_KEY",),
        base_url="https://api.x.ai/v1", api="openai",
        connect="key:XAI_API_KEY", home="https://console.x.ai",
    ),
    Provider(
        id="groq", label="Groq", preferred=("llama-3.3", "llama-3.1"), kind="key", env=("GROQ_API_KEY",),
        base_url="https://api.groq.com/openai/v1", api="openai",
        connect="key:GROQ_API_KEY", home="https://console.groq.com/keys",
    ),
    Provider(
        id="venice", label="Venice AI", preferred=("venice-uncensored", "llama-3.3"), kind="key", env=("VENICE_API_KEY",),
        base_url="https://api.venice.ai/api/v1", api="openai",
        connect="key:VENICE_API_KEY", home="https://venice.ai/settings/api",
    ),
    Provider(
        # The ChatGPT plan the owner already pays for, spoken to through the
        # Codex backend rather than the API — a different endpoint AND a
        # different bill from `openai` above, which is why they are two rows.
        id="chatgpt", label="ChatGPT (sign-in)", kind="oauth",
        env=("OPENAI_OAUTH_ACCESS_TOKEN",),
        base_url="https://chatgpt.com/backend-api/codex", api="responses",
        models_path="",  # the Codex backend serves no catalog
        model_pattern=r"^(gpt-5|o\d|codex)",
        # HivemindOS's own fallback for this grant; keeping the two in step
        # means both apps lead with the same model on the same account.
        preferred=(CHATGPT_FALLBACK_MODEL,),
        refresh_env="OPENAI_OAUTH_REFRESH_TOKEN", expires_env="OPENAI_OAUTH_EXPIRES_AT",
        account_env="OPENAI_OAUTH_ACCOUNT_ID",
        token_url="https://auth.openai.com/oauth/token",
        client_id="app_EMoamEEZ73f0CkXaXp7hrann",
        scope="openid profile email offline_access",
        connect="oauth:openai",
    ),
    Provider(
        id="grok", label="Grok (sign-in)", kind="oauth", preferred=("grok-4", "grok-3"),
        env=("XAI_OAUTH_ACCESS_TOKEN",),
        base_url="https://api.x.ai/v1", api="openai",
        refresh_env="XAI_OAUTH_REFRESH_TOKEN", expires_env="XAI_OAUTH_EXPIRES_AT",
        base_url_env="XAI_OAUTH_BASE_URL",
        token_url="https://auth.x.ai/oauth2/token",
        client_id="b1a00492-073a-47ea-816f-4c329264a828",
        scope="openid profile email offline_access grok-cli:access api:access",
        connect="oauth:xai",
    ),
)

BY_ID: dict[str, Provider] = {provider.id: provider for provider in PROVIDERS}

# Ids a chat catalog returns that are not chat models. Left in, they fill the
# picker with embedding and speech endpoints that fail on first press.
_NOT_CHAT = re.compile(
    r"(embedding|embed-|whisper|tts|audio|speech|transcrib|moderation|rerank|"
    r"dall-e|image|sora|veo|video|imagen|guard|davinci|babbage|ada-|curie|"
    # Not chat models even though they sit in the same catalog: realtime is a
    # websocket session, `-instruct` is the legacy completions shape, and
    # deep-research and computer-use answer on their own endpoints. Offering
    # them fails on the first press with the provider's own unhelpful 400.
    r"realtime|-instruct|deep-research|computer-use)",
    re.IGNORECASE,
)


def is_account_model(model_id: str) -> bool:
    return str(model_id or "").startswith(PREFIX)


def split_model(model_id: str) -> tuple[Provider, str]:
    """`account:openrouter/anthropic/claude-4` → (openrouter, anthropic/claude-4).

    The upstream id may itself contain slashes, so only the FIRST one separates
    the provider. Getting this wrong sends an OpenRouter pick to OpenAI's
    endpoint under OpenAI's key, which is the mis-billing this whole module is
    shaped to prevent.
    """
    if not is_account_model(model_id):
        raise ProviderModelsError(f"{model_id!r} is not one of your accounts' models.")
    body = str(model_id)[len(PREFIX):]
    provider_id, _, upstream = body.partition("/")
    provider = BY_ID.get(provider_id)
    if provider is None:
        raise ProviderModelsError(
            f"This studio has no route for the account '{provider_id}'. "
            f"Known accounts: {', '.join(sorted(BY_ID))}."
        )
    if not upstream:
        raise ProviderModelsError(f"{model_id!r} names an account but no model.")
    return provider, upstream


def model_id_for(provider: Provider, upstream: str) -> str:
    return f"{PREFIX}{provider.id}/{upstream}"


# --------------------------------------------------------------------------
# credentials
# --------------------------------------------------------------------------


def stored_names() -> set[str]:
    """Every credential NAME the machine's shared store holds.

    Names, never values, and never through the broker: this answers "is the
    account connected", which the picker asks on every open. Reading each value
    to answer it would put a sweep of the owner's whole credential set in the
    access ledger every time a menu is opened, and teach them to ignore it.
    """
    try:
        state = shared_env.hive_env_status()
    except Exception:  # a store this build cannot reach is "nothing connected"
        return set()
    names = set(state.get("keys") or ())
    # A value exported into this process counts too — the shared env is a
    # DEFAULT, and a project that sets its own key must be able to win.
    names.update(key for key, value in os.environ.items() if value)
    return names


def credential_name(provider: Provider, present: set[str] | None = None) -> str:
    held = stored_names() if present is None else present
    for name in provider.env:
        if name in held:
            return name
    return ""


def credential(name: str, *, reason: str = "") -> str:
    """One value, at the moment it is about to be spent.

    Process environment first, then the shared store — the precedence the whole
    fleet uses, so a project can override a fleet-wide default by exporting it.
    """
    direct = os.environ.get(name, "").strip()
    if direct:
        return direct
    try:
        return shared_env.request_credential(name, reason=reason or "producer model call").strip()
    except Exception:
        return ""


def _write_back(values: dict[str, str]) -> None:
    """Persist refreshed grant tokens into the shared store.

    Written where HivemindOS reads them, on purpose: a refresh the studio keeps
    to itself would leave the app holding a token this process has already
    rotated away. Only values the token endpoint actually returned are written —
    nothing is ever cleared here.
    """
    clean = {key: value for key, value in values.items() if str(value or "").strip()}
    if not clean:
        return
    try:
        shared_env.set_hive_env_values(clean, overwrite=True)
    except Exception:
        # A store that cannot be written still leaves a usable token in this
        # process for the rest of its life. Losing the write is a slower
        # refresh next time, not a failed generation now.
        pass
    os.environ.update(clean)


# --------------------------------------------------------------------------
# OAuth grants
# --------------------------------------------------------------------------

_REFRESH_LOCK = threading.Lock()
# Refreshing early, matching HivemindOS, so a turn never rides an expiring token.
_EXPIRY_SLACK_MS = 60_000


def _expires_at(provider: Provider) -> int:
    raw = credential(provider.expires_env, reason="grant expiry") if provider.expires_env else ""
    try:
        return int(float(raw))
    except (TypeError, ValueError):
        return 0


def grant_token(provider: Provider, *, opener: Callable[..., Any] = urllib.request.urlopen) -> str:
    """A live access token for a grant, refreshing it if that is what it takes.

    The studio refreshes rather than sending the owner back to a browser,
    because a grant is only useful for an hour after the app last touched it and
    "reconnect your ChatGPT account" every hour is not a product. The exchange
    is the provider's ordinary public refresh grant — the same one HivemindOS
    runs — and the rotated pair is written back to the store they share.

    On a lost race (both apps refreshing at once) the store is re-read first, so
    the usual outcome is picking up the other one's fresh token rather than
    burning a second exchange.
    """
    access = credential(provider.env[0], reason="producer model call")
    expires = _expires_at(provider)
    if access and (not expires or time.time() * 1000 < expires - _EXPIRY_SLACK_MS):
        return access

    refresh = credential(provider.refresh_env, reason="grant refresh") if provider.refresh_env else ""
    if not refresh:
        raise ProviderModelsError(
            f"{provider.label} is not connected yet.",
            remedy=provider.connect, provider=provider.id,
        )

    with _REFRESH_LOCK:
        # Someone else may have refreshed while this call waited for the lock.
        current = credential(provider.env[0], reason="producer model call")
        current_expires = _expires_at(provider)
        if current and current != access and (
            not current_expires or time.time() * 1000 < current_expires - _EXPIRY_SLACK_MS
        ):
            return current
        return _exchange_refresh(provider, refresh, opener=opener)


def _exchange_refresh(provider: Provider, refresh: str, *,
                      opener: Callable[..., Any] = urllib.request.urlopen) -> str:
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": provider.client_id,
        "scope": provider.scope,
    }).encode("utf-8")
    request = urllib.request.Request(
        provider.token_url, data=body, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "Accept": "application/json", "User-Agent": USER_AGENT},
    )
    try:
        with opener(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = _error_detail(exc)
        raise ProviderModelsError(
            f"Your {provider.label} sign-in could not be renewed{f': {detail}' if detail else ''}. "
            f"Signing in again restores it.",
            remedy=provider.connect, provider=provider.id,
        ) from exc
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        raise ProviderModelsError(
            f"Could not reach {provider.label} to renew your sign-in.",
            remedy="retry", provider=provider.id,
        ) from exc

    access = str(payload.get("access_token") or "").strip()
    if not access:
        raise ProviderModelsError(
            f"Your {provider.label} sign-in could not be renewed. Signing in again restores it.",
            remedy=provider.connect, provider=provider.id,
        )
    expires_in = max(60, int(payload.get("expires_in") or 3600))
    written = {provider.env[0]: access,
               provider.expires_env: str(int(time.time() * 1000 + expires_in * 1000))}
    rotated = str(payload.get("refresh_token") or "").strip()
    if rotated:
        written[provider.refresh_env] = rotated
    _write_back(written)
    return access


def bearer(provider: Provider, present: set[str] | None = None, *,
           opener: Callable[..., Any] = urllib.request.urlopen) -> tuple[str, str]:
    """(header value, credential name) for one provider, or a refusal."""
    if provider.kind == "oauth":
        return grant_token(provider, opener=opener), provider.env[0]
    name = credential_name(provider, present)
    if not name:
        raise ProviderModelsError(
            f"{provider.label} is not connected yet.",
            remedy=provider.connect, provider=provider.id,
        )
    value = credential(name, reason=f"{provider.label} producer call")
    if not value:
        raise ProviderModelsError(
            f"{provider.label}'s key could not be read from the shared store.",
            remedy=provider.connect, provider=provider.id,
        )
    return value, name


def _base_url(provider: Provider) -> str:
    if provider.base_url_env:
        configured = credential(provider.base_url_env, reason="grant endpoint")
        if configured:
            return configured.rstrip("/")
    return provider.base_url.rstrip("/")


# --------------------------------------------------------------------------
# discovery
# --------------------------------------------------------------------------

_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_cache_lock = threading.Lock()


def _cached(key: str) -> dict[str, Any] | None:
    with _cache_lock:
        entry = _cache.get(key)
    if not entry:
        return None
    expires, value = entry
    if time.time() > expires:
        return None
    return value


def _remember(key: str, value: dict[str, Any]) -> None:
    ttl = _HIT_TTL if value.get("models") else _MISS_TTL
    with _cache_lock:
        _cache[key] = (time.time() + ttl, value)


def forget_cache() -> None:
    """Drop every cached catalog. Called after a key is added, so the account
    the owner just connected appears without waiting out the TTL."""
    with _cache_lock:
        _cache.clear()


def _http_json(url: str, *, headers: dict[str, str], timeout: float,
               opener: Callable[..., Any], body: bytes | None = None) -> Any:
    request = urllib.request.Request(
        url, data=body, method="POST" if body is not None else "GET",
        headers={"Accept": "application/json", "User-Agent": USER_AGENT, **headers},
    )
    with opener(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _error_detail(exc: urllib.error.HTTPError) -> str:
    """The provider's own explanation, when it gave one.

    Google answers with a JSON ARRAY holding one error object, and reading only
    the object shape turned "this model is no longer available to new users,
    use models/gemini-3.6-flash" into a bare "HTTP 404" — the single most useful
    sentence in the whole exchange, discarded on a bracket.
    """
    try:
        payload = json.loads(exc.read().decode("utf-8"))
    except Exception:
        return f"HTTP {exc.code}"
    if isinstance(payload, list) and payload:
        payload = payload[0]
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or f"HTTP {exc.code}")
        if isinstance(error, str) and error:
            return error
        for key in ("message", "detail"):
            if payload.get(key):
                return str(payload[key])
    return f"HTTP {exc.code}"


def _price_line(pricing: Any) -> str:
    """OpenRouter quotes per-token dollars; owners read per-million."""
    if not isinstance(pricing, dict):
        return ""
    def per_million(value: Any) -> str:
        try:
            usd = float(value) * 1_000_000
        except (TypeError, ValueError):
            return ""
        if usd <= 0:
            return "$0"
        return "$" + (f"{usd:.2f}".rstrip("0").rstrip(".") if usd < 100 else str(round(usd)))
    prompt, completion = per_million(pricing.get("prompt")), per_million(pricing.get("completion"))
    return f"{prompt} in · {completion} out /1M" if prompt and completion else ""


# A model id that is one dated snapshot of another: `gpt-5-2025-08-07` beside
# `gpt-5`, `claude-sonnet-4-20250514` beside `claude-sonnet-4`. Purely
# structural — no model name appears here, so it keeps working for models that
# do not exist yet.
_SNAPSHOT = re.compile(r"^(?P<base>.+?)[-@](?P<stamp>\d{4}-\d{2}-\d{2}|\d{8}|\d{6}|\d{4})$")


def _retired(row: dict[str, Any], today: str) -> bool:
    """Has the provider already switched this model off?

    OpenAI ships a `shutdown_date` and goes on listing the model past it —
    nineteen of its hundred-and-thirty-two rows on this machine were already
    dead. Offering those is offering a press that cannot work.
    """
    for key in ("shutdown_date", "expiration_date"):
        value = str(row.get(key) or "").strip()[:10]
        if value and value < today:
            return True
    return False


def _chat_ids(rows: list[dict[str, Any]], pattern: str = "") -> list[dict[str, Any]]:
    """The rows that are chat models, deduplicated and dated.

    Three passes, because a catalog is not a menu. `/models` is one list for
    every endpoint a provider sells, it keeps listing models it has already
    retired, and it lists every dated snapshot of a model beside the model —
    on this machine that was 49 duplicates and 19 dead rows out of 132, and
    what reached the picker was ten near-identical `gpt-5-*` tiles.
    """
    keep = re.compile(pattern) if pattern else None
    today = datetime.date.today().isoformat()
    live: list[dict[str, Any]] = []
    for row in rows:
        model_id = str(row.get("id") or "").strip()
        # Gemini's OpenAI-compatible catalog prefixes every id with `models/`;
        # its chat endpoint accepts either, but the bare id is what a person
        # searching for "gemini-2.5-pro" will type.
        if model_id.startswith("models/"):
            model_id = model_id[len("models/"):]
        if not model_id or _NOT_CHAT.search(model_id):
            continue
        if keep and not keep.search(model_id):
            continue
        if _retired(row, today):
            continue
        live.append({**row, "id": model_id})

    # A snapshot is only a snapshot when the model it pins is here too.
    # Otherwise it is the only way to reach that model and must stay a
    # first-class row.
    present = {row["id"] for row in live}
    snapshots: dict[str, int] = {}
    for row in live:
        # Two shapes of the same duplication: a date stapled on
        # (`gpt-5-2025-08-07`) and a routing variant after a colon
        # (`z-ai/glm-5.2:batch`, `:free`). Both tripled their base model in the
        # list while being the same model to choose.
        model_id = row["id"]
        base = model_id.split(":", 1)[0] if ":" in model_id else ""
        if not base or base not in present:
            match = _SNAPSHOT.match(model_id)
            base = match.group("base") if match else ""
        if base and base in present:
            row["pinned"] = base
            snapshots[base] = snapshots.get(base, 0) + 1
    for row in live:
        if snapshots.get(row["id"]):
            row["snapshots"] = snapshots[row["id"]]
    return live


def discover(provider: Provider, *, opener: Callable[..., Any] = urllib.request.urlopen,
             present: set[str] | None = None) -> dict[str, Any]:
    """This account's models, live from the provider. Never raises.

    A provider that cannot be asked returns no models WITH the reason, rather
    than a hand-written list: a curated fallback is a set of ids that pass the
    picker and 404 on the first press, which is a worse failure than an empty
    tab that explains itself.
    """
    cached = _cached(provider.id)
    if cached is not None:
        return cached
    result = _discover_now(provider, opener=opener, present=present)
    _remember(provider.id, result)
    return result


def _discover_now(provider: Provider, *, opener: Callable[..., Any],
                  present: set[str] | None) -> dict[str, Any]:
    if provider.id == "chatgpt":
        return _chatgpt_models(opener=opener, present=present)
    try:
        token, _name = bearer(provider, present, opener=opener)
    except ProviderModelsError as exc:
        return {"models": [], "detail": str(exc), "remedy": exc.remedy, "live": False}
    if not provider.models_path:
        return {"models": [], "detail": f"{provider.label} does not publish a model list.",
                "remedy": "", "live": False}

    headers = dict(provider.headers)
    if provider.auth == "x-api-key":
        headers["x-api-key"] = token
    else:
        headers["Authorization"] = f"Bearer {token}"
    try:
        payload = _http_json(f"{_base_url(provider)}{provider.models_path}",
                             headers=headers, timeout=_DISCOVER_TIMEOUT, opener=opener)
    except urllib.error.HTTPError as exc:
        detail = _error_detail(exc)
        # 401/403 is the credential, not the network — and the fix is a
        # different button, so it must not be reported as "try again".
        expired = exc.code in (401, 403)
        return {
            "models": [],
            "detail": f"{provider.label} refused this credential: {detail}" if expired
                      else f"{provider.label} could not list your models: {detail}",
            "remedy": provider.connect if expired else "retry",
            "live": False,
        }
    except (OSError, urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        return {"models": [], "detail": f"Could not reach {provider.label} to list your models.",
                "remedy": "retry", "live": False}

    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        rows = payload if isinstance(payload, list) else []
    return {"models": _chat_ids([row for row in rows if isinstance(row, dict)], provider.model_pattern),
            "detail": "", "remedy": "", "live": True}


def _chatgpt_models(*, opener: Callable[..., Any], present: set[str] | None) -> dict[str, Any]:
    """What the ChatGPT sign-in can run.

    The Codex backend serves no catalog, so the ids are borrowed from the OpenAI
    key's catalog when there is one and filtered to the family the grant
    actually reaches. With no key there is nothing to borrow, and the single id
    offered is the one HivemindOS itself falls back to — stated as an
    unverified default rather than passed off as a discovered list.
    """
    grant = BY_ID["chatgpt"]
    try:
        grant_token(grant, opener=opener)
    except ProviderModelsError as exc:
        return {"models": [], "detail": str(exc), "remedy": exc.remedy, "live": False}

    key_side = BY_ID["openai"]
    if credential_name(key_side, present):
        borrowed = _discover_now(key_side, opener=opener, present=present)
        rows = _chat_ids(borrowed.get("models") or [], grant.model_pattern)
        if rows:
            return {"models": rows, "detail": "", "remedy": "", "live": True}
    return {
        "models": [{"id": CHATGPT_FALLBACK_MODEL}],
        "detail": "ChatGPT publishes no model list, so this is the default rather than a checked one.",
        "remedy": "", "live": False,
    }


# --------------------------------------------------------------------------
# how popular a model is
# --------------------------------------------------------------------------
#
# OpenRouter does NOT expose usage rankings. `?order=top-weekly` answers 200 and
# is silently ignored — byte-identical to `?order=newest` and to no parameter at
# all — and /activity, /models/rankings and the frontend routes are 403 or 404.
# Its default ordering is newest-first (verified: `created` descending).
#
# What it does expose is how many independent providers host each model, one
# model at a time: `/models/{slug}/endpoints`. That is a real demand signal —
# hosts do not carry a model nobody asks for. Measured on this machine:
# qwen3.8-27b 10, gemini-2.5-pro 8, gpt-5.4 7, claude-sonnet-4 5, and 1 apiece
# for the long tail of models that were filling the picker.
#
# Because OpenRouter carries almost everything, one sweep of its catalog is a
# GLOBAL popularity table: an OpenAI or Gemini row is scored by looking its name
# up in the same table. It costs one request per model, so it is swept in the
# background and kept on disk for a day — the picker is never made to wait for
# it, and ranks by recency until it lands.

# Above this many hosts a model is simply "widely carried", and more hosts stop
# meaning more demand: an open-weights model is resold by everyone (GLM 5.2 sits
# at 38) while a proprietary one has a single origin plus a few routers
# (gpt-5.4 at 7, claude-sonnet-4 at 5). Left uncapped, the tab ranked resale
# breadth and buried every model the owner actually came for. Capped, "widely
# carried" is one bucket and recency orders inside it.
POPULARITY_CAP = 8

POPULARITY_TTL = 86_400.0
_POPULARITY_WORKERS = 12
# A sweep of 400+ models takes seconds, so it must never run twice at once.
_sweep_lock = threading.Lock()
_sweeping = False


def _popularity_path() -> Path:
    from .config import load_config

    return load_config().data_dir / "provider-model-popularity.json"


def _read_popularity() -> dict[str, Any]:
    try:
        value = json.loads(_popularity_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def popularity_key(model_name: str) -> str:
    """The name a model is known by across every provider that carries it.

    `openai/gpt-5.4`, `gpt-5.4` and `gpt-5.4-2025-08-07` are one model with one
    audience, and they have to collapse to one key or the table only scores the
    provider it was swept from.
    """
    base = str(model_name or "").strip().lower().split("/")[-1]
    base = base.split(":")[0]
    match = _SNAPSHOT.match(base)
    if match:
        base = match.group("base")
    return base


def popularity(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, int]:
    """How many providers carry each model, by name. Never blocks, never raises.

    A cold or stale table starts a background sweep and returns whatever it
    has — including nothing, on the first ever open. Ranking degrades to
    recency in that case, which is what OpenRouter itself defaults to.
    """
    stored = _read_popularity()
    scores = stored.get("scores") if isinstance(stored.get("scores"), dict) else {}
    fresh = float(stored.get("fetchedAt") or 0) + POPULARITY_TTL > time.time()
    if not fresh:
        _start_sweep(opener=opener)
    return {str(key): int(value) for key, value in scores.items() if isinstance(value, int)}


def _start_sweep(*, opener: Callable[..., Any]) -> None:
    global _sweeping
    with _sweep_lock:
        if _sweeping:
            return
        _sweeping = True
    thread = threading.Thread(target=_sweep, kwargs={"opener": opener},
                              name="provider-popularity", daemon=True)
    thread.start()


def _sweep(*, opener: Callable[..., Any]) -> None:
    global _sweeping
    try:
        provider = BY_ID["openrouter"]
        if not credential_name(provider):
            return
        try:
            token, _name = bearer(provider, opener=opener)
        except ProviderModelsError:
            return
        headers = {"Authorization": f"Bearer {token}", **provider.headers}
        try:
            payload = _http_json(f"{_base_url(provider)}/models", headers=headers,
                                 timeout=_DISCOVER_TIMEOUT, opener=opener)
        except Exception:  # noqa: BLE001 — a sweep that cannot start is not an error
            return
        slugs = [str(row.get("id") or "") for row in (payload.get("data") or [])
                 if isinstance(row, dict) and row.get("id")]

        def count(slug: str) -> tuple[str, int]:
            try:
                data = _http_json(
                    f"{_base_url(provider)}/models/{slug}/endpoints",
                    headers=headers, timeout=10, opener=opener,
                )
                endpoints = ((data or {}).get("data") or {}).get("endpoints") or []
                return slug, len(endpoints)
            except Exception:  # noqa: BLE001 — one model failing must not end the sweep
                return slug, 0

        scores: dict[str, int] = {}
        with ThreadPoolExecutor(max_workers=_POPULARITY_WORKERS) as pool:
            for slug, hosts in pool.map(count, slugs):
                if hosts:
                    key = popularity_key(slug)
                    scores[key] = max(scores.get(key, 0), hosts)
        if not scores:
            return
        path = _popularity_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"fetchedAt": time.time(), "scores": scores}),
                            encoding="utf-8")
        except OSError:
            pass
    finally:
        with _sweep_lock:
            _sweeping = False


# --------------------------------------------------------------------------
# the catalog the picker renders
# --------------------------------------------------------------------------


def _context_line(value: Any) -> str:
    try:
        tokens = int(value)
    except (TypeError, ValueError):
        return ""
    if tokens < 1000:
        return ""
    return f"{round(tokens / 1_000_000, 1)}M context" if tokens >= 1_000_000 else f"{round(tokens / 1000)}K context"


def _row(provider: Provider, source: dict[str, Any], popular: dict[str, int]) -> dict[str, Any]:
    """One model, as the picker shows it.

    `name` is the provider's own display name when it gives one — "Anthropic:
    Claude Sonnet 4" reads, `anthropic/claude-sonnet-4` is a slug — and the slug
    stays on the row so searching for either finds it.

    `subtitle` carries something that DIFFERS between rows. It used to be
    "Billed to your own account" on all of them, which is stated once on the tab
    and is noise forty times underneath it.
    """
    upstream = str(source["id"])
    display = str(source.get("name") or source.get("display_name") or "").strip()
    price = _price_line(source.get("pricing")) or _price_line(_venice_pricing(source))
    context = _context_line(source.get("context_length")
                            or (source.get("top_provider") or {}).get("context_length"))
    return {
        "id": model_id_for(provider, upstream),
        "name": display or upstream,
        "modelId": upstream,
        "subtitle": " · ".join(part for part in (price, context) if part),
        "group": provider.label,
        "badge": "Sign-in" if provider.kind == "oauth" else "Your key",
        "tier": "account",
        "provider": provider.id,
        "source": SOURCE,
        # How many providers carry this model, and when it appeared. The picker
        # ranks on these; they are on the row so it does not have to ask again.
        "hosts": min(popular.get(popularity_key(upstream), 0), POPULARITY_CAP),
        "created": int(source.get("created") or 0),
        # A dated pin of another row here (`gpt-5-2025-08-07` under `gpt-5`).
        # Kept, because it may be exactly what someone needs, but not shown
        # until they search for it.
        "pinned": str(source.get("pinned") or ""),
        "snapshots": int(source.get("snapshots") or 0),
    }


def _venice_pricing(source: dict[str, Any]) -> dict[str, Any] | None:
    """Venice quotes per MILLION already, nested under model_spec."""
    spec = source.get("model_spec")
    pricing = (spec or {}).get("pricing") if isinstance(spec, dict) else None
    if not isinstance(pricing, dict):
        return None
    given, out = pricing.get("input"), pricing.get("output")
    if not isinstance(given, dict) or not isinstance(out, dict):
        return None
    try:  # back to per-token, so one formatter serves every provider
        return {"prompt": float(given["usd"]) / 1_000_000, "completion": float(out["usd"]) / 1_000_000}
    except (KeyError, TypeError, ValueError):
        return None


def status(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Every account, whether it is connected, and what it can run.

    Never raises, and never drops a provider: an account the owner has not
    connected is listed as one they could, which is how they find out the
    producer can use the ChatGPT plan they are already paying for.
    """
    present = stored_names()
    connected = [provider for provider in PROVIDERS if credential_name(provider, present)]
    popular = popularity(opener=opener)

    found: dict[str, dict[str, Any]] = {}
    if connected:
        # Concurrently, or one unreachable provider adds its whole timeout to
        # every picker open.
        with ThreadPoolExecutor(max_workers=min(_DISCOVER_WORKERS, len(connected))) as pool:
            futures = {
                provider.id: pool.submit(discover, provider, opener=opener, present=present)
                for provider in connected
            }
            for provider_id, future in futures.items():
                try:
                    found[provider_id] = future.result()
                except Exception as exc:  # noqa: BLE001 — a provider is never fatal
                    found[provider_id] = {"models": [], "detail": str(exc), "remedy": "retry", "live": False}

    accounts: list[dict[str, Any]] = []
    models: list[dict[str, Any]] = []
    for provider in PROVIDERS:
        name = credential_name(provider, present)
        result = found.get(provider.id) or {}
        rows = sorted(
            (_row(provider, row, popular) for row in (result.get("models") or []) if row.get("id")),
            # Most-carried first, then newest, then by name. A catalog's own
            # order is either meaningless or newest-first, and alphabetical put
            # `gpt-4-0613` above every model anyone would actually choose.
            key=lambda entry: (-entry["hosts"], -entry["created"], entry["name"].lower()),
        )
        models.extend(rows)
        accounts.append({
            "id": provider.id,
            "label": provider.label,
            "kind": provider.kind,
            # The NAME of the credential in play, never its value — so an owner
            # can see which of three Google key names this machine is using.
            "credential": name,
            "connect": provider.connect,
            "home": provider.home,
            "connected": bool(name),
            "live": bool(result.get("live")),
            "count": len(rows),
            "detail": str(result.get("detail") or "") if name else "",
            "remedy": str(result.get("remedy") or "") if name else provider.connect,
        })

    usable = [account for account in accounts if account["connected"] and account["count"]]
    if usable:
        detail, remedy = "", ""
    elif any(account["connected"] for account in accounts):
        broken = next(account for account in accounts if account["connected"])
        detail = broken["detail"] or "None of your connected accounts could list a model just now."
        remedy = broken["remedy"] or "retry"
    else:
        detail = "No provider accounts are connected on this machine yet."
        remedy = "connect-provider"

    return {
        "available": bool(usable),
        "accounts": accounts,
        "models": models,
        "detail": detail,
        "remedy": remedy,
        "defaultModelId": _default_model(accounts, models),
    }


# Preference order when the accounts source is the one to start on: the grant
# the owner is already paying a flat fee for, then the general-purpose gateway,
# then whatever is connected. Never a model — always an ACCOUNT — because the
# ids inside an account come from the provider and change under us.
_PREFERRED = ("chatgpt", "openai", "anthropic", "openrouter", "gemini", "grok", "xai", "groq", "venice")


def _default_model(accounts: list[dict[str, Any]], models: list[dict[str, Any]]) -> str:
    by_provider: dict[str, list[dict[str, Any]]] = {}
    for row in models:
        by_provider.setdefault(str(row["provider"]), []).append(row)
    for provider_id in _PREFERRED:
        rows = by_provider.get(provider_id)
        if not rows:
            continue
        provider = BY_ID[provider_id]
        for wanted in provider.preferred:
            # Prefix, so a dated variant of the same model still counts and a
            # preference does not have to be re-pinned every release.
            match = next((row for row in rows if str(row["modelId"]).startswith(wanted)), None)
            if match:
                return str(match["id"])
        return str(rows[0]["id"])
    return str(models[0]["id"]) if models else ""


# --------------------------------------------------------------------------
# the engine
# --------------------------------------------------------------------------


class AccountsRuntime:
    """A producer engine with the same ``chat`` shape as the other two.

    Same signature on purpose: `story_producer`'s tasks are written against an
    engine rather than a provider, so which one runs is a lookup in
    `text_models` and not a branch inside every task.
    """

    def __init__(self, *, opener: Callable[..., Any] = urllib.request.urlopen) -> None:
        self._opener = opener

    def chat(
        self,
        *,
        model_id: str,
        messages: list[dict[str, str]],
        temperature: float = 0.8,
        max_tokens: int = 2048,
        timeout: float = 180.0,
        image: str | None = None,
        images: list[str] | None = None,
    ) -> str:
        provider, upstream = split_model(model_id)
        attached = [url for url in ([image] if image else []) + list(images or []) if url]
        token, _name = bearer(provider, opener=self._opener)
        if provider.api == "anthropic":
            return _chat_anthropic(provider, token, upstream, messages, attached,
                                   temperature, max_tokens, timeout, self._opener)
        if provider.api == "responses":
            return _chat_responses(provider, token, upstream, messages, attached, timeout, self._opener)
        return _chat_openai(provider, token, upstream, messages, attached,
                            temperature, max_tokens, timeout, self._opener)


def runtime(*, opener: Callable[..., Any] = urllib.request.urlopen) -> AccountsRuntime:
    return AccountsRuntime(opener=opener)


def _with_images(messages: list[dict[str, Any]], attached: list[str]) -> list[dict[str, Any]]:
    """Pictures ride the LAST user turn, matching both other engines so a vision
    ask behaves the same whichever one is chosen."""
    copied = [dict(message) for message in messages]
    for message in reversed(copied):
        if message.get("role") == "user":
            message["content"] = [
                {"type": "text", "text": message.get("content") or ""},
                *({"type": "image_url", "image_url": {"url": url}} for url in attached),
            ]
            break
    return copied


def _call(provider: Provider, url: str, headers: dict[str, str], body: dict[str, Any],
          timeout: float, opener: Callable[..., Any]) -> dict[str, Any]:
    try:
        payload = _http_json(url, headers=headers, timeout=timeout, opener=opener,
                             body=json.dumps(body).encode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = _error_detail(exc)
        if exc.code in (401, 403):
            raise ProviderModelsError(
                f"{provider.label} refused this credential: {detail}",
                remedy=provider.connect, provider=provider.id,
            ) from exc
        if exc.code == 429:
            raise ProviderModelsError(
                f"{provider.label} is rate limiting this account: {detail}",
                remedy="retry", provider=provider.id,
            ) from exc
        raise ProviderModelsError(f"{provider.label}: {detail}", provider=provider.id) from exc
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        raise ProviderModelsError(
            f"Could not reach {provider.label}.", remedy="retry", provider=provider.id,
        ) from exc
    except json.JSONDecodeError as exc:
        raise ProviderModelsError(f"{provider.label} returned an answer this studio could not read.",
                                  provider=provider.id) from exc
    if not isinstance(payload, dict):
        raise ProviderModelsError(f"{provider.label} returned an unexpected answer.", provider=provider.id)
    return payload


def _chat_openai(provider: Provider, token: str, model: str, messages: list[dict[str, str]],
                 attached: list[str], temperature: float, max_tokens: int,
                 timeout: float, opener: Callable[..., Any]) -> str:
    headers = {**provider.headers, "Content-Type": "application/json", "Authorization": f"Bearer {token}"}
    payload = _call(provider, f"{_base_url(provider)}/chat/completions", headers, {
        "model": model,
        "messages": _with_images(messages, attached) if attached else messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }, timeout, opener)
    choices = payload.get("choices")
    if not choices:
        raise ProviderModelsError(
            str((payload.get("error") or {}).get("message") if isinstance(payload.get("error"), dict)
                else payload.get("error") or f"{provider.label} returned no completion."),
            provider=provider.id,
        )
    content = str((choices[0].get("message") or {}).get("content") or "").strip()
    if not content:
        raise ProviderModelsError(f"{provider.label} returned an empty answer.", provider=provider.id)
    return content


def _chat_anthropic(provider: Provider, token: str, model: str, messages: list[dict[str, str]],
                    attached: list[str], temperature: float, max_tokens: int,
                    timeout: float, opener: Callable[..., Any]) -> str:
    """Anthropic's Messages API — a different shape, not a different dialect.

    The system prompt is a top-level field rather than a message, `max_tokens`
    is required rather than optional, and images are typed blocks with their
    media type spelled out. Sending OpenAI's body here returns a 400 that names
    none of that.
    """
    system = "\n".join(str(message.get("content") or "") for message in messages
                       if message.get("role") == "system").strip()
    turns: list[dict[str, Any]] = [
        {"role": message["role"], "content": str(message.get("content") or "")}
        for message in messages if message.get("role") in ("user", "assistant")
    ]
    if attached and turns:
        for turn in reversed(turns):
            if turn["role"] == "user":
                turn["content"] = [
                    *(_anthropic_image(url) for url in attached),
                    {"type": "text", "text": turn["content"]},
                ]
                break
    body: dict[str, Any] = {"model": model, "messages": turns or [{"role": "user", "content": ""}],
                            "max_tokens": max(1, int(max_tokens)), "temperature": temperature}
    if system:
        body["system"] = system
    headers = {**provider.headers, "Content-Type": "application/json", "x-api-key": token}
    payload = _call(provider, f"{_base_url(provider)}/messages", headers, body, timeout, opener)
    blocks = payload.get("content")
    text = "".join(str(block.get("text") or "") for block in (blocks or [])
                   if isinstance(block, dict) and block.get("type") == "text").strip()
    if not text:
        raise ProviderModelsError(f"{provider.label} returned an empty answer.", provider=provider.id)
    return text


def _anthropic_image(url: str) -> dict[str, Any]:
    if url.startswith("data:"):
        header, _, encoded = url.partition(",")
        media_type = header[5:].split(";")[0] or "image/png"
        return {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": encoded}}
    return {"type": "image", "source": {"type": "url", "url": url}}


def _chat_responses(provider: Provider, token: str, model: str, messages: list[dict[str, str]],
                    attached: list[str], timeout: float,
                    opener: Callable[..., Any] = urllib.request.urlopen) -> str:
    """One turn over the ChatGPT backend's Responses stream.

    Three things about this endpoint are not negotiable and are not guessable:
    it only answers a STREAM, it wants the Codex client's own headers, and it
    REJECTS `max_output_tokens` outright ("Unsupported parameter") — length is
    governed by the prompt. Every one of those is mirrored from HivemindOS's
    transport rather than re-derived, so the two clients cannot drift into
    disagreeing about the same account.
    """
    import uuid

    account = credential(provider.account_env, reason="grant account") if provider.account_env else ""
    instructions = "\n".join(str(message.get("content") or "") for message in messages
                             if message.get("role") == "system").strip()
    turns = [message for message in messages if message.get("role") != "system"]
    last_user = max((index for index, message in enumerate(turns)
                     if message.get("role") == "user"), default=-1)
    body = {
        "model": model,
        "instructions": instructions or None,
        "input": [
            {
                "type": "message",
                "role": message.get("role"),
                "content": [
                    {"type": "output_text" if message.get("role") == "assistant" else "input_text",
                     "text": str(message.get("content") or "")},
                    *([{"type": "input_image", "image_url": url, "detail": "auto"} for url in attached]
                      if index == last_user else []),
                ],
            }
            for index, message in enumerate(turns)
        ],
        "stream": True,
        "store": False,
        "reasoning": {"effort": "low"},
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "Accept": "text/event-stream",
        "OpenAI-Beta": "responses=experimental",
        "originator": "codex_cli_rs",
        "session_id": str(uuid.uuid4()),
        "User-Agent": USER_AGENT,
    }
    if account:
        headers["chatgpt-account-id"] = account

    request = urllib.request.Request(
        f"{_base_url(provider)}/responses",
        data=json.dumps({key: value for key, value in body.items() if value is not None}).encode("utf-8"),
        method="POST", headers=headers,
    )
    try:
        with opener(request, timeout=timeout) as response:
            text, failure = _read_response_stream(response)
    except urllib.error.HTTPError as exc:
        detail = _error_detail(exc)
        raise ProviderModelsError(
            f"{provider.label} refused this sign-in: {detail}" if exc.code in (401, 403)
            else f"{provider.label}: {detail}",
            remedy=provider.connect if exc.code in (401, 403) else "",
            provider=provider.id,
        ) from exc
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        raise ProviderModelsError(f"Could not reach {provider.label}.",
                                  remedy="retry", provider=provider.id) from exc
    if not text:
        raise ProviderModelsError(failure or f"{provider.label} returned an empty answer.",
                                  provider=provider.id)
    return text


def _read_response_stream(response: Any) -> tuple[str, str]:
    """Accumulate the text deltas out of a Responses SSE stream.

    Frames are separated by a blank line and a frame may carry several `data:`
    lines; anything that is not JSON is a keep-alive. A `response.failed` event
    is remembered rather than raised, because a stream that failed AFTER writing
    usable text should return the text.
    """
    text: list[str] = []
    failure = ""
    buffer = ""
    while True:
        chunk = response.read(4096)
        if not chunk:
            break
        buffer += chunk.decode("utf-8", errors="replace")
        while "\n\n" in buffer:
            frame, buffer = buffer.split("\n\n", 1)
            data = "\n".join(line[6:] for line in frame.split("\n") if line.startswith("data: "))
            if not data or data == "[DONE]":
                continue
            try:
                event = json.loads(data)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "response.output_text.delta" and isinstance(event.get("delta"), str):
                text.append(event["delta"])
            elif event.get("type") == "response.failed":
                failure = str(((event.get("response") or {}).get("error") or {}).get("message")
                              or "The ChatGPT backend reported a failed response.")
    return "".join(text).strip(), failure
