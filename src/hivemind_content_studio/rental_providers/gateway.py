"""The hosted marketplace: every provider call, through the HivemindOS worker.

Until 2026-09-07 the studio held VAST_API_KEY / RUNPOD_API_KEY itself and spoke
to each marketplace directly. Now those keys live ONLY as secrets on the
`hivemindos-gpu-rentals-gateway` worker; the studio presents the owner's
HivemindOS credit token, the worker injects the platform key, scopes instances
to the calling account, marks the price up, and bills HivemindOS credits in
ten-minute prepaid blocks. The studio never learns a marketplace key exists.

This module is the TRANSPORT only. Everything above it — tier ladder, ranking,
provisioning scripts, tunnels, the reaper — is unchanged and does not know
which way a call went. The seam is `vast.request` / `runpod.request` /
`runpod.graphql`: each asks `routes()` and, when the answer is yes, hands the
provider-relative call to `call()` here. Routing INSIDE those functions rather
than beside them is deliberate: the test suite's no-network guard patches
those three names, and a gateway path that bypassed them would be a new hole
of exactly the shape that once rented eight real machines.

Two rules the providers already follow apply here too:

  * Nothing is decided at import or cached across requests. `transport()` is
    read every call, so a HivemindOS account connected after the stack booted
    works on the next request rather than after a restart — the same reason a
    provider reads its env key at call time.
  * Cloudflare 403s Python's default User-Agent outright ("blocked access
    based on your browser's signature"), a refusal that reads like an outage.
    Every request identifies the product, as `hivemindos_models` does.
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
from typing import Any

import requests

from . import ProviderError, response_error_text

DEFAULT_GATEWAY_URL = "https://hivemindos-gpu-rentals-gateway.hivemindos.workers.dev"
URL_ENV = "HIVEMIND_GPU_RENTALS_GATEWAY_URL"
TRANSPORT_ENV = "HIVEMIND_GPU_RENTALS_TRANSPORT"
TRANSPORT_GATEWAY = "gateway"
TRANSPORT_DIRECT = "direct"
TRANSPORT_AUTO = "auto"
TOKEN_HEADER = "X-HivemindOS-Credit-Token"
REQUEST_TIMEOUT = 30
# How long one GET /v1/market answers for. Every Machines poll asks whether a
# provider is configured and what the balance is; sixty seconds keeps that to
# one round trip a minute, and a refusal is remembered for as long — a studio
# with no account must not ask the worker every six seconds to be told so.
MARKET_CACHE_SECONDS = 60

# The one purse. The worker bills HivemindOS credits whichever marketplace the
# box came from, so on this transport there is no per-provider balance and no
# marketplace to top up at.
PURSE_KEY = "hivemindos"
PURSE_LABEL = "HivemindOS"
CREDIT_URL = "your HivemindOS account (Add credits)"
# The refusal every studio without an account meets, and its repair. The
# navigation half ("Models → HivemindOS → Connect") is the Machines view's
# button; the sentence still names the route for an agent reading the API.
CONNECT_MESSAGE = (
    "Connect your HivemindOS account to rent GPUs — Models → HivemindOS → Connect. "
    "Hosted rentals bill your HivemindOS credits; no marketplace keys are needed "
    "on this machine."
)
# Warm volumes are platform resources the worker does not lend out (yet).
# A refusal that says what to do instead: rent cold, the box downloads.
WARM_VOLUMES_UNAVAILABLE = (
    "warm volumes are not available on hosted rentals yet — rent a cold box; "
    "the weights download onto it"
)

# Same pooled session as the direct providers, for the same reason: a fresh
# TLS handshake per call was the Machines page load on a slow link.
_session = requests.Session()


def user_agent() -> str:
    from .. import hivemindos_models

    return hivemindos_models.USER_AGENT


def url() -> str:
    """Where the worker is. The env override predates this module — it already
    named the bad-machines list — so the default now applies there too."""
    return (os.environ.get(URL_ENV, "").strip() or DEFAULT_GATEWAY_URL).rstrip("/")


def _token() -> str:
    """The owner's HivemindOS credit token, or "" — never an exception. A vault
    that cannot be read means "not connected", which is a state, not a fault."""
    try:
        from .. import hivemindos_models

        return str(hivemindos_models.credit_token() or "").strip()
    except Exception:  # noqa: BLE001 — an unreadable store is "no account"
        return ""


def transport() -> str:
    """"gateway" or "direct", decided now, from the environment and the vault.

    `auto` (the default) follows the owner's account: a connected HivemindOS
    token routes every marketplace call through the worker; none falls back to
    the machine's own keys. `gateway` and `direct` force it either way — the
    former is how a machine that also holds direct keys stays on the hosted
    rail, the latter is what the test suite pins so its fakes of the direct
    transport keep meaning what they say.
    """
    mode = os.environ.get(TRANSPORT_ENV, "").strip().lower() or TRANSPORT_AUTO
    if mode == TRANSPORT_GATEWAY:
        return TRANSPORT_GATEWAY
    if mode == TRANSPORT_DIRECT:
        return TRANSPORT_DIRECT
    return TRANSPORT_GATEWAY if _token() else TRANSPORT_DIRECT


def routes(provider_key: str) -> bool:
    """Whether this provider's calls go through the worker right now."""
    return transport() == TRANSPORT_GATEWAY


# --- GET /v1/market -----------------------------------------------------------
# (when, token fingerprint, url, payload-or-None, refusal-or-None). Keyed on
# the token as well as the clock so a refusal cached for "no account" does
# not outlive the moment an account is connected: the next request carries a
# different token and misses the cache.
_market_cache: dict[str, Any] = {"at": 0.0, "key": None, "value": None, "error": None}
_market_lock = threading.Lock()


def forget_market() -> None:
    with _market_lock:
        _market_cache.update(at=0.0, key=None, value=None, error=None)


def _market_key(token: str) -> tuple[str, str]:
    return (url(), hashlib.sha256(token.encode("utf-8")).hexdigest()[:16] if token else "")


def market() -> dict:
    """What the worker offers this account: configured providers, markup, and
    the HivemindOS balance. Cached for MARKET_CACHE_SECONDS, refusals included."""
    token = _token()
    key = _market_key(token)
    with _market_lock:
        fresh = time.time() - _market_cache["at"] < MARKET_CACHE_SECONDS and _market_cache["key"] == key
        if fresh and _market_cache["value"] is not None:
            return _market_cache["value"]
        if fresh and _market_cache["error"] is not None:
            raise _market_cache["error"]
    try:
        payload = _request("GET", "/v1/market", token=token)
    except ProviderError as exc:
        with _market_lock:
            _market_cache.update(at=time.time(), key=key, value=None, error=exc)
        raise
    with _market_lock:
        _market_cache.update(at=time.time(), key=key, value=payload, error=None)
    return payload


def configured(provider_key: str) -> bool:
    """True when the worker holds this marketplace's key. A worker that cannot
    be asked (no account, offline) is not configured — the notice that says WHY
    comes from `market()` itself, via gpu_rentals._require_a_marketplace."""
    try:
        providers = market().get("providers") or []
    except ProviderError:
        return False
    return any(
        isinstance(entry, dict) and entry.get("key") == provider_key and bool(entry.get("configured"))
        for entry in providers
    )


def balance_usd() -> float:
    """The HivemindOS balance in USD — the only credit a hosted rental spends."""
    return round(float(market().get("balanceUsd") or 0.0), 4)


# --- POST /v1/market/{provider}/call ------------------------------------------

def call(
    provider_key: str,
    method: str,
    path: str,
    payload: dict | None = None,
    *,
    quoted_usd_per_hour: float | None = None,
) -> Any:
    """One provider-relative call, made by the worker on this account's behalf.

    Returns the provider's body verbatim (price-rewritten by the worker), so the
    provider adapters parse exactly what they parsed on the direct transport.
    `quoted_usd_per_hour` rides along on a create: it is the consumer price the
    studio showed, and the worker refuses (409) rather than rent a box whose
    live rate moved past it — the same tolerance gpu_rentals.rent_price_cap
    applies studio-side.
    """
    body: dict[str, Any] = {"method": method.upper(), "path": path}
    if payload is not None:
        body["body"] = payload
    if quoted_usd_per_hour is not None:
        body["quotedUsdPerHour"] = float(quoted_usd_per_hour)
    answer = _request("POST", f"/v1/market/{provider_key}/call", token=_token(), body=body)
    if method.upper() != "GET":
        # A create, destroy, pause or resume moved the balance and possibly the
        # provider's configured state; the next Machines poll should see it
        # rather than the minute-old figure.
        forget_market()
    status = answer.get("status")
    if isinstance(status, int) and status >= 400:
        detail = response_error_text(str(answer.get("body") or ""), status)
        raise ProviderError(f"{provider_key} answered HTTP {status} through the hosted marketplace: {detail}",
                            status_code=502)
    return answer.get("body")


def _request(method: str, path: str, *, token: str, body: dict | None = None) -> dict:
    """The HTTP round trip, with the worker's refusals turned into ProviderErrors
    the routes already know how to pass through.

    A requests-level failure (DNS, TLS, timeout) is left to propagate: the
    route guard maps it to the same 503 "unreachable" the direct providers get,
    and `market()` is the one caller that wants it as a ProviderError.
    """
    headers = {
        "Accept": "application/json",
        "User-Agent": user_agent(),
    }
    if token:
        headers[TOKEN_HEADER] = token
    try:
        response = _session.request(
            method, f"{url()}{path}", json=body, headers=headers, timeout=REQUEST_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise ProviderError(
            "The HivemindOS GPU marketplace could not be reached — check this machine's "
            f"internet connection and try again ({exc.__class__.__name__}).",
            status_code=503,
        ) from exc
    try:
        answer = response.json()
    except ValueError:
        answer = {}
    if not isinstance(answer, dict):
        answer = {}
    if response.status_code < 400 and answer.get("ok", True):
        return answer
    raise _refusal(response.status_code, answer, response.text)


def _refusal(status: int, answer: dict, text: str) -> ProviderError:
    """The worker's error, as the status the route should answer with.

    401 is "no account", whatever words the worker used: the repair is to
    connect one, and the message says so. 402 and 409 are the worker's own
    sentences — it knows the balance and the price it refused at, we do not.
    400, 403 and 503 keep their status too: "not allowed", "not yours" and
    "market closed" are refusals of the ASK, and a 502 would send the owner to
    wait out a marketplace outage that is not happening. Everything else is a
    provider failure the worker relayed, with what the provider said attached —
    that is where `no_such_ask` lives, and vast.ask_evaporated reads it.
    """
    error = str(answer.get("error") or "").strip()
    if status == 401:
        return ProviderError(CONNECT_MESSAGE, status_code=401)
    if status == 402:
        return ProviderError(error or "Not enough HivemindOS credit for this rental — add credits "
                             "in your HivemindOS account and rent again.", status_code=402)
    if status == 409:
        return ProviderError(error or "the market moved past the quoted price; re-quote and rent again",
                             status_code=409)
    if status in (400, 403, 503):
        return ProviderError(error or response_error_text(text, status), status_code=status)
    provider_status = answer.get("providerStatus")
    provider_body = str(answer.get("providerBody") or "").strip()
    detail = error or response_error_text(text, status)
    if provider_status is not None:
        detail = f"{detail} (HTTP {provider_status})"
    if provider_body:
        detail = f"{detail}: {provider_body[:300]}"
    return ProviderError(f"the hosted marketplace could not complete the call: {detail}", status_code=502)
