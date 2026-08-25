"""HivemindOS Models: the same cloud text models the HivemindOS app itself uses.

The studio's producer used to be local-only — a ``llama-server`` this app spawns.
That is the right default when the machine has weights on it and the wrong one
when it does not: a new install had no producer at all, and the whole Story
studio is a producer with a UI around it.

**The HivemindOS desktop app is not required.** It is a proxy in front of a
public gateway, and this module talks to whichever of the two is there:

  ``app``     the HivemindOS app on this machine, at ``/api/hivemindos/models/*``
  ``direct``  the hosted gateway it proxies to, at ``/api/paid-agents/<slug>/*``

The app is PREFERRED when it is running, and only because of what it saves the
owner: it already holds the machine's credit token, so nothing has to be
connected by hand. Without it the catalog, the free tier and paid inference all
still work.

**It is the same balance either way.** A HivemindOS balance is a credit account
on the gateway, and any client holding a token for that account spends it —
the desktop app's own token, or a passkey-minted session token
(``hmos_credit_…``) from the HivemindOS account page. The studio holds the
latter, so "no desktop app" means "connect your account once", not "start a
second balance". Where two balances do end up existing (someone topped up here
before connecting), ``merge_accounts`` folds them into one rather than leaving
money stranded.

Model ids are identical on both routes, so a model chosen today is still the
model chosen after installing the app tomorrow. Prices, routing and the credit
ledger are the gateway's, exactly as they are for the desktop app.

Privacy: this is the one producer path where the text leaves the machine. The
studio says so on the picker, beside the models it applies to.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable

from .config import load_config
from .hivemindos_hosted_media import DEFAULT_HIVEMINDOS_URL, _dashboard_token

MODELS_PATH = "/api/hivemindos/models"
PROVIDER = "hivemindos"

ROUTE_APP = "app"
ROUTE_DIRECT = "direct"

# The gateway the desktop app proxies to. Public, and the same one its own
# `paid-agent-cloud-client` defaults to — kept in step by env override rather
# than by a second guess at the address.
DEFAULT_GATEWAY_URL = "https://hivemindos-paid-agent-gateway.hivemindos.workers.dev"
GATEWAY_URL_ENV = "HIVEMINDOS_GATEWAY_URL"
GATEWAY_SLUG_ENV = "HIVEMINDOS_GATEWAY_SLUG"
DEFAULT_SLUG = "default"

# The id prefix HivemindOS gives every model it can route, both its own tiers
# ("hivemindos/auto") and the gateway's catalog ("hivemindos/custom:<upstream>").
# One prefix is all the studio needs to know which engine runs a model id.
ID_PREFIX = "hivemindos/"
CUSTOM_PREFIX = "hivemindos/custom:"

# The default cloud producer. GPT-5.6 Luna is the house default across HivemindOS
# work, and the gateway carries it.
DEFAULT_MODEL_ID = "hivemindos/custom:openai/gpt-5.6-luna"

# What a caller sends as its funding identity to the APP route. The credit pool
# is shared per install and resolved before this is looked at, so it is an
# identity for the ledger rather than a separate account.
AGENT_ID = "hivemind-content-studio"
FREE_AGENT_ID = "free-tier"

# The one model that rides the free daily allowance instead of credits.
FREE_MODEL_ID = "hivemindos/swarm-sovereign-scout"
FREE_MODEL_UPSTREAM = "swarm-sovereign-scout-12b"
FREE_MODEL_NAME = "Swarm Sovereign Scout"

# The free tier caps its own answers, and the cap is well under what several
# producer tasks ask for ("concepts" budgets 6000). Sending a bigger number is
# not merely ignored — the free service REFUSES the call outright ("Free Scout
# requests may use at most 1024 output tokens."), so every stage button failed on
# that model until this clamp existed. Clamping instead of refusing is right
# because a short answer is already handled: the producer salvages what finished.
FREE_MODEL_MAX_TOKENS = 1024

# How long a "is the app running?" probe is trusted. Long enough that a page of
# picker interactions does not re-probe on every row, short enough that starting
# the app is noticed without a restart of this studio.
_APP_PROBE_TTL_SECONDS = 30.0
_app_probe: tuple[float, bool] = (0.0, False)


class HivemindosModelsError(RuntimeError):
    """A cloud producer call that failed in a way the owner can act on.

    ``remedy`` names the action the studio should offer beside the message —
    never a bare sentence with nothing to press.
    """

    def __init__(self, message: str, *, remedy: str = "", detail: str = "") -> None:
        super().__init__(message)
        self.remedy = remedy
        self.detail = detail


def base_url() -> str:
    """Where the HivemindOS app would be, if it is running."""
    base = os.environ.get("HIVEMINDOS_URL", DEFAULT_HIVEMINDOS_URL).strip().rstrip("/")
    if not base.startswith(("http://127.0.0.1:", "http://localhost:", "https://")):
        raise ValueError("HIVEMINDOS_URL must use local HTTP or HTTPS")
    return base


def gateway_url() -> str:
    base = (os.environ.get(GATEWAY_URL_ENV, "") or DEFAULT_GATEWAY_URL).strip().rstrip("/")
    if not base.startswith("https://") and not base.startswith("http://127.0.0.1:"):
        raise ValueError(f"{GATEWAY_URL_ENV} must use HTTPS")
    return base


def gateway_slug() -> str:
    slug = (os.environ.get(GATEWAY_SLUG_ENV, "") or DEFAULT_SLUG).strip().lower()
    return slug if slug.replace("-", "").isalnum() else DEFAULT_SLUG


def is_hivemindos_model(model_id: str) -> bool:
    return str(model_id or "").startswith(ID_PREFIX)


def upstream_model(model_id: str) -> str:
    """The gateway's own id for one of ours."""
    if model_id == FREE_MODEL_ID:
        return FREE_MODEL_UPSTREAM
    if model_id.startswith(CUSTOM_PREFIX):
        return model_id[len(CUSTOM_PREFIX):]
    return model_id


def app_is_running(*, connector: Callable[[str, int], bool] | None = None) -> bool:
    """Is the HivemindOS app on this machine, linked and answering?

    Both halves matter. A token with nothing listening is an app that is
    installed but closed; a listener with no token is an app this studio has not
    been linked to. Either way the direct route is the one that works.
    """
    global _app_probe
    if not _dashboard_token():
        return False
    now = time.monotonic()
    stamped, answered = _app_probe
    if connector is None and now - stamped < _APP_PROBE_TTL_SECONDS:
        return answered
    try:
        parsed = urllib.parse.urlparse(base_url())
    except ValueError:
        return False
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    probe = connector or _connects
    answered = probe(host, port)
    if connector is None:
        _app_probe = (now, answered)
    return answered


def _connects(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def resolve_route(*, connector: Callable[[str, int], bool] | None = None) -> str:
    return ROUTE_APP if app_is_running(connector=connector) else ROUTE_DIRECT


# ---------------------------------------------------------------- credentials

def _store_path() -> Path:
    return load_config().data_dir / "hivemindos-models.json"


def _read_store() -> dict[str, Any]:
    try:
        return json.loads(_store_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_store(values: dict[str, Any]) -> None:
    path = _store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(values, indent=1), encoding="utf-8")
    # A bearer token for money lives in here. Owner-only on disk, on top of the
    # encryption, so a stray backup or a shared machine cannot read it.
    os.chmod(path, 0o600)


def device_id() -> str:
    """This install's free-tier identity.

    The free allowance is counted per device. On the app route HivemindOS owns
    that identity; direct, the studio needs its own stable one — regenerating it
    per call would be asking a shared service for a fresh allowance every time,
    which is not a bug in their meter, it is abuse of it.
    """
    store = _read_store()
    existing = str(store.get("deviceId") or "").strip()
    if existing:
        return existing
    minted = f"content-studio-{uuid.uuid4()}"
    store["deviceId"] = minted
    _write_store(store)
    return minted


def _cipher():
    from . import private_access

    return private_access.PrivateFieldCipher.from_keychain()


# Where the HivemindOS app keeps its own credit key, and the sibling file whose
# contents key it. Same user, same `~/.hivemindos` directory this studio already
# reads its device token and shared env from — so an install on this machine can
# be linked without asking the owner to copy anything.
APP_HOME_ENV = "HIVEMINDOS_HOME"
APP_VAULT_NAME = "hivemindos-model-credit-vault.json"
APP_VAULT_KEY_NAME = "hivemindos-model-credit-vault.key"


def app_home() -> Path:
    """The HivemindOS directory on this machine. Overridable so a test can point
    at a vault it wrote itself rather than at the developer's real one."""
    configured = os.environ.get(APP_HOME_ENV, "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".hivemindos"
# The app's own pooled account id, and the record key layout it stores under.
APP_POOL_ACCOUNT = "shared:hivemindos-models"


def app_credit_token() -> str:
    """The HivemindOS app's own account key, read from its vault on this machine.

    Read live rather than copied into this studio's store: a copy would go stale
    the moment the app rotates its key, and duplicating a bearer credential to
    keep two files in step is how one of them ends up wrong. Returns '' when
    there is no app, no vault, or nothing decryptable in it — every one of which
    just means "not linked from the app".

    This grants no capability the studio does not already have: with the app
    running it proxies through it and spends the same balance anyway. What it
    adds is that the link SURVIVES the app being closed.
    """
    home = app_home()
    try:
        key_material = (home / APP_VAULT_KEY_NAME).read_text(encoding="utf-8").strip()
        vault = json.loads((home / APP_VAULT_NAME).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return ""
    records = vault.get("records") if isinstance(vault, dict) else None
    if not isinstance(records, dict) or not key_material:
        return ""
    slug = gateway_slug()
    ordered = [f"{APP_POOL_ACCOUNT}::{slug}", *sorted(records)]
    key = hashlib.sha256(key_material.encode("utf-8")).digest()
    for record_key in ordered:
        record = records.get(record_key)
        if not isinstance(record, dict):
            continue
        token = _decrypt_app_record(record, key)
        if token:
            return token
    return ""


def _decrypt_app_record(record: dict[str, Any], key: bytes) -> str:
    """One AES-256-GCM record, in the app's own layout (base64url iv/tag/body)."""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        nonce = _b64url(record["iv"])
        payload = _b64url(record["encryptedToken"]) + _b64url(record["tag"])
        return AESGCM(key).decrypt(nonce, payload, None).decode("utf-8")
    except Exception:
        return ""


def _b64url(value: str) -> bytes:
    raw = str(value or "")
    return base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))


def credit_source() -> str:
    """Which key the direct route would spend: the owner's pasted one, the app's,
    or none. The picker says this out loud — a credential adopted silently from
    another app is exactly the kind of thing that should be visible."""
    if _stored_credit_token():
        return "connected"
    if app_credit_token():
        return "app"
    return ""


def _stored_credit_token() -> str:
    """The key this studio was given by hand, if any.

    Any token the gateway accepts works — the account's own, or a passkey-minted
    session token from the HivemindOS account page — because both resolve to the
    same credit account, which is the whole point.
    """
    sealed = str(_read_store().get("creditToken") or "").strip()
    if not sealed:
        return ""
    try:
        return _cipher().decrypt(sealed)
    except Exception:
        return ""


def credit_token() -> str:
    """The key the direct route spends, from wherever it is.

    A key the owner connected by hand wins over the app's, because connecting one
    deliberately is a choice and the app's is a convenience.
    """
    return _stored_credit_token() or app_credit_token()


def save_credit_token(token: str) -> None:
    store = _read_store()
    store["creditToken"] = _cipher().encrypt(token.strip())
    _write_store(store)


def forget_credit_token() -> None:
    store = _read_store()
    store.pop("creditToken", None)
    _write_store(store)


# What a HivemindOS account token looks like. Checked here so a typo is refused
# with "that does not look like one" instead of spending a round trip to be told
# the account does not exist.
_TOKEN_SHAPE = re.compile(r"^hmos_(?:credit|account)_[A-Za-z0-9_-]{20,}$")


def connect_account(token: str, *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Point this studio at the owner's HivemindOS account.

    Verified before it is stored, by asking the gateway what the balance is: a
    token that is saved and only tried later fails at the worst moment, in the
    middle of a generation the owner was waiting on.
    """
    candidate = str(token or "").strip()
    if not _TOKEN_SHAPE.match(candidate):
        raise HivemindosModelsError(
            "That does not look like a HivemindOS account key. Copy it from the account "
            "page in HivemindOS — it starts with hmos_.",
            remedy="connect-account",
        )
    payload = _gateway_request(
        f"/api/paid-agents/{gateway_slug()}/credits/balance",
        headers={"X-HivemindOS-Credit-Token": candidate}, opener=opener,
    )
    save_credit_token(candidate)
    balance = payload.get("balanceCredits") if isinstance(payload, dict) else None
    return {"connected": True, "credits": balance, "label": _credit_label(balance)}


def merge_accounts(tokens: list[str], *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Fold several HivemindOS balances into one.

    For the case this design tries to avoid and cannot always prevent: credits
    bought here before the owner connected the account they already had. The
    gateway merges them; stranding money in an account nobody can see would be
    the worse answer.
    """
    candidates = [str(token or "").strip() for token in tokens]
    candidates = [token for token in candidates if _TOKEN_SHAPE.match(token)]
    if len(candidates) < 2:
        raise HivemindosModelsError("Two account keys are needed to merge balances.", remedy="connect-account")
    payload = _gateway_request(
        f"/api/paid-agents/{gateway_slug()}/credits/consolidate",
        method="POST", body={"creditTokens": candidates}, timeout=30.0, opener=opener,
    )
    kept = str((payload or {}).get("creditToken") or "").strip()
    if kept:
        save_credit_token(kept)
    return {"merged": True, "credits": (payload or {}).get("balanceCredits")}


def _credit_label(balance: Any) -> str:
    if isinstance(balance, (int, float)):
        return f"{balance:,} credits"
    return "Unknown"


# ------------------------------------------------------------------ transport

def _app_request(
    path: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float = 20.0,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> Any:
    token = _dashboard_token()
    if not token:
        raise HivemindosModelsError(
            "HivemindOS is not linked to this studio yet.",
            remedy="link-hivemindos",
            detail="HIVEMINDOS_DASHBOARD_DEVICE_TOKEN is not set on this machine.",
        )
    headers = {"x-hivemindos-device-token": token, "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["x-hivemindos-wallet-agent-id"] = (
            FREE_AGENT_ID if body.get("model") == FREE_MODEL_ID else AGENT_ID
        )
    request = urllib.request.Request(f"{base_url()}{path}", data=data, method=method, headers=headers)
    return _send(request, timeout=timeout, opener=opener, where="app")


# The gateway sits behind Cloudflare, which blocks urllib's default
# "Python-urllib/3.x" outright ("The site owner has blocked access based on your
# browser's signature") — a 403 that reads like an outage rather than a missing
# header. Identify the product honestly instead of impersonating a browser.
USER_AGENT = "HivemindContentStudio/1.0 (+https://hivemindos.com)"


def _gateway_request(
    path: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 20.0,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> Any:
    sent = {"Accept": "application/json", "User-Agent": USER_AGENT, **(headers or {})}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        sent["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{gateway_url()}{path}", data=data, method=method, headers=sent)
    return _send(request, timeout=timeout, opener=opener, where="gateway")


def _send(request: urllib.request.Request, *, timeout: float, opener: Callable[..., Any], where: str) -> Any:
    try:
        with opener(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise _http_error(exc, where=where) from None
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        if where == "app":
            raise HivemindosModelsError(
                "The HivemindOS app is not running on this machine.",
                remedy="open-hivemindos", detail=str(exc),
            ) from None
        raise HivemindosModelsError(
            "HivemindOS could not be reached. Check this machine's internet connection.",
            remedy="retry", detail=str(exc),
        ) from None
    except json.JSONDecodeError as exc:
        raise HivemindosModelsError("HivemindOS returned something that was not JSON.", detail=str(exc)) from None


def _http_error(exc: urllib.error.HTTPError, *, where: str) -> HivemindosModelsError:
    """HivemindOS's own sentence, with the action it implies attached.

    Its messages are already written for a person ("Add HivemindOS Models credits
    with card or link a local funding wallet before chatting."), so they are kept
    rather than replaced — what is added is which button repairs them.
    """
    try:
        payload = json.loads(exc.read().decode("utf-8"))
    except (json.JSONDecodeError, AttributeError, OSError, UnicodeDecodeError):
        payload = {}
    message = str(payload.get("error") or payload.get("detail") or "").strip()
    if exc.code == 402:
        # The gateway's own words for this are "Payment required." — true, and
        # not something anyone can act on. Say what it means here.
        return HivemindosModelsError(
            "This model is paid, and no HivemindOS account is connected to this studio.",
            remedy="connect-account", detail=message,
        )
    if exc.code == 401:
        if where == "gateway":
            return HivemindosModelsError(
                message or "These credits were not accepted.", remedy="top-up",
            )
        return HivemindosModelsError(
            message or "This studio is not authorised to reach HivemindOS on this machine.",
            remedy="link-hivemindos",
        )
    if exc.code in (403, 404) and ("credit" in message.lower() or "wallet" in message.lower()):
        return HivemindosModelsError(message, remedy="top-up")
    if exc.code == 429:
        return HivemindosModelsError(
            message or "The free allowance for today is used up.", remedy="top-up",
        )
    return HivemindosModelsError(
        message or f"HivemindOS returned HTTP {exc.code}.",
        remedy="open-hivemindos" if (exc.code >= 500 and where == "app") else "",
    )


# -------------------------------------------------------------------- catalog

def _price_line(prompt_usd: Any, completion_usd: Any) -> str:
    """Prices exactly as the HivemindOS app prints them, so the same model does
    not appear to cost two different things in two of its own products."""
    def per_million(value: Any) -> str:
        try:
            usd = float(value) * 1_000_000
        except (TypeError, ValueError):
            return ""
        if usd == 0:
            return "$0"
        if usd >= 100:
            return f"${round(usd)}"
        return "$" + f"{usd:.2f}".rstrip("0").rstrip(".")

    prompt = per_million(prompt_usd)
    completion = per_million(completion_usd)
    if not prompt or not completion:
        return ""
    return f"{prompt} in · {completion} out /1M"


def _row(model_id: str, name: str, subtitle: str, group: str, badge: str, tier: str) -> dict[str, Any]:
    return {
        "id": model_id, "name": name, "subtitle": subtitle, "group": group,
        "badge": badge, "tier": tier, "provider": PROVIDER, "source": PROVIDER,
    }


def _app_catalog(*, opener: Callable[..., Any] = urllib.request.urlopen) -> list[dict[str, Any]]:
    payload = _app_request(f"{MODELS_PATH}/models", opener=opener)
    rows = payload.get("data") if isinstance(payload, dict) else None
    models: list[dict[str, Any]] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        model_id = str(row.get("id") or "").strip()
        if not model_id:
            continue
        meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        models.append(_row(
            model_id, str(row.get("display_name") or model_id), str(meta.get("subtitle") or ""),
            str(meta.get("group") or "HivemindOS"), str(meta.get("badge") or ""), str(meta.get("tier") or "paid"),
        ))
    return models


def _gateway_catalog(*, opener: Callable[..., Any] = urllib.request.urlopen) -> list[dict[str, Any]]:
    """The gateway's own catalog, without the app.

    The house tiers (Auto/Fast/Deep) are deliberately NOT synthesized here: their
    GPU-first routing lives in the app, so offering them without it would be a
    row that promises something this route cannot do. The free model IS offered,
    because the free rail is the gateway's and works either way.
    """
    payload = _gateway_request(
        f"/api/paid-agents/{gateway_slug()}/models",
        headers={"X-HivemindOS-Official-Paid-Agent-Client": "models"},
        opener=opener,
    )
    rows = (payload.get("data") or payload.get("models")) if isinstance(payload, dict) else None
    models = [_row(
        FREE_MODEL_ID, FREE_MODEL_NAME, "Free daily allowance · Scout 12B",
        "HivemindOS", "Free", "free",
    )]
    pricing_key = ("prompt", "completion")
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        upstream = str(row.get("id") or row.get("model") or "").strip()
        if not upstream:
            continue
        pricing = row.get("pricing") if isinstance(row.get("pricing"), dict) else {}
        models.append(_row(
            f"{CUSTOM_PREFIX}{upstream}",
            str(row.get("display_name") or row.get("name") or upstream),
            _price_line(pricing.get(pricing_key[0]), pricing.get(pricing_key[1])) or "HivemindOS credits",
            "Gateway", "Wallet", "paid",
        ))
    return models


def catalog(*, route: str = "", opener: Callable[..., Any] = urllib.request.urlopen) -> list[dict[str, Any]]:
    """Every model HivemindOS can route, as picker rows.

    The shape is deliberately the studio's, not the gateway's: the browser reads
    `id`, `name`, `subtitle`, `group`, `badge` and `tier` for every source it can
    offer, so a cloud row and a local row render through the same component.
    """
    if (route or resolve_route()) == ROUTE_APP:
        return _app_catalog(opener=opener)
    return _gateway_catalog(opener=opener)


def credits(*, route: str = "", opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """The credit balance, as whichever side holds the account reports it."""
    if (route or resolve_route()) == ROUTE_APP:
        query = urllib.parse.urlencode({"creditAccountId": AGENT_ID})
        payload = _app_request(f"{MODELS_PATH}/credits?{query}", opener=opener)
        if not isinstance(payload, dict):
            return {"configured": False, "label": "Unknown", "source": "app"}
        return {
            "configured": bool(payload.get("configured")),
            "credits": payload.get("balanceCredits"),
            "label": str(payload.get("balanceLabel") or "Unknown"),
            "source": "app",
        }
    token = credit_token()
    if not token:
        return {"configured": False, "credits": None, "label": "Account not connected", "source": ""}
    payload = _gateway_request(
        f"/api/paid-agents/{gateway_slug()}/credits/balance",
        headers={"X-HivemindOS-Credit-Token": token}, opener=opener,
    )
    balance = payload.get("balanceCredits") if isinstance(payload, dict) else None
    # `source` is shown, not hidden: a key adopted from the app on this machine
    # should be visible as that, with a way to change it.
    return {"configured": True, "credits": balance, "label": _credit_label(balance), "source": credit_source()}


def status(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Whether the cloud producer can be used at all, and on what terms.

    Answered BEFORE anything is generated, because a picker that learns this from
    a failed request has already spent the press. Never raises: a source that
    cannot answer is a state the picker renders, not an error that empties it.
    """
    route = resolve_route()
    try:
        models = catalog(route=route, opener=opener)
    except HivemindosModelsError as exc:
        return {
            "reachable": False, "route": route, "models": [], "detail": str(exc),
            "remedy": exc.remedy, "defaultModelId": DEFAULT_MODEL_ID,
        }
    try:
        balance = credits(route=route, opener=opener)
    except HivemindosModelsError:
        balance = {"configured": False, "label": "Unknown"}
    known = {model["id"] for model in models}
    # Never point the default at a model this gateway does not carry: a default
    # that 404s on first press is worse than an honest second choice.
    default_id = DEFAULT_MODEL_ID if DEFAULT_MODEL_ID in known else _first_present(
        models, ("hivemindos/auto", FREE_MODEL_ID),
    )
    return {
        "reachable": True,
        "route": route,
        "models": models,
        "detail": "",
        "remedy": "",
        "credits": balance,
        "defaultModelId": default_id,
    }


def _first_present(models: list[dict[str, Any]], preferred: tuple[str, ...]) -> str:
    known = {model["id"] for model in models}
    for candidate in preferred:
        if candidate in known:
            return candidate
    return models[0]["id"] if models else DEFAULT_MODEL_ID


def output_budget(model_id: str, requested: int) -> int:
    """The answer budget this model will actually accept."""
    if model_id == FREE_MODEL_ID:
        return min(int(requested), FREE_MODEL_MAX_TOKENS)
    return int(requested)


def start_top_up(*, amount_usd: float = 5.0, return_url: str = "",
                 opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Begin a card checkout for HivemindOS credits, on the direct route.

    Tops up the CONNECTED account when there is one — the gateway credits the
    account whose token is presented, so this is the owner's usual balance and
    not a new one. With nothing connected it opens an account, which is the only
    honest option for someone who has never had HivemindOS credits; the studio
    then says to secure it with a passkey so their other apps can reach it.

    Nothing is charged by this call: the card is entered on the gateway's own
    page, by the owner.
    """
    if resolve_route() == ROUTE_APP:
        raise HivemindosModelsError(
            "Add credits in the HivemindOS app, so this studio and the app keep sharing one balance.",
            remedy="open-hivemindos",
        )
    existing = credit_token()
    payload = _gateway_request(
        f"/api/paid-agents/{gateway_slug()}/credits/checkout",
        method="POST",
        body={
            "creditAccountId": AGENT_ID,
            "amountUsd": round(float(amount_usd), 2),
            **({"successUrl": return_url, "cancelUrl": return_url} if return_url else {}),
        },
        headers={
            "Idempotency-Key": f"content-studio-credits-{uuid.uuid4()}",
            # Presenting the connected account tops IT up. Without this the
            # gateway mints a new account and the owner ends up with two
            # balances, which is the thing this whole path exists to avoid.
            **({"X-HivemindOS-Credit-Token": existing} if existing else {}),
        },
        timeout=30.0, opener=opener,
    )
    token = str((payload or {}).get("creditToken") or "").strip()
    if token and not existing:
        save_credit_token(token)
    return {
        "checkoutUrl": str((payload or {}).get("checkoutUrl") or ""),
        "stored": bool(token and not existing),
        "openedNewAccount": bool(token and not existing),
    }


# ---------------------------------------------------- the app-mediated link
#
# `hivemindos://` is a scheme the desktop app registers, so this handshake is
# same-machine by construction — it reaches the app on THIS computer and no
# other. It therefore adds no reach over reading the app's vault directly; what
# it adds is that the owner is ASKED, in the app, with the app's own unlock in
# front of it, and that the handover keeps working if HivemindOS ever moves that
# vault somewhere this studio cannot read (an OS keychain, another user).
#
# The nonce is the authorisation. The callback cannot be owner-gated — the
# poster is the desktop app, not the browser — so what proves the exchange is
# legitimate is that it carries a secret this studio minted moments ago for a
# link the owner started here. Single use, five minutes, memory only: a studio
# restart cancels every pending link rather than leaving one openable later.

LINK_TTL_SECONDS = 300.0
_link_requests: dict[str, float] = {}
_link_results: dict[str, str] = {}


def start_link(callback_url: str) -> dict[str, str]:
    """Mint a one-time link request and the deep link that carries it."""
    _expire_links()
    nonce = secrets.token_urlsafe(32)
    _link_requests[nonce] = time.monotonic()
    query = urllib.parse.urlencode({
        "nonce": nonce,
        "callback": callback_url,
        "app": "Hivemind Content Studio",
    })
    return {"nonce": nonce, "url": f"hivemindos://models/link?{query}", "expiresIn": int(LINK_TTL_SECONDS)}


def complete_link(nonce: str, token: str, *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Accept the key the app handed back, for a link this studio started."""
    _expire_links()
    if nonce not in _link_requests:
        # Deliberately the same answer for expired, already-used and never-issued:
        # the caller is not the owner's browser, and telling an unknown local
        # process which of those it hit is telling it how to try again.
        raise HivemindosModelsError("That link request is not open.", remedy="connect-account")
    result = connect_account(token, opener=opener)
    _link_requests.pop(nonce, None)
    _link_results[nonce] = "linked"
    return result


def link_state(nonce: str) -> str:
    """What the browser polls: linked, pending, or expired."""
    _expire_links()
    if _link_results.get(nonce) == "linked":
        return "linked"
    return "pending" if nonce in _link_requests else "expired"


def _expire_links() -> None:
    now = time.monotonic()
    for nonce, started in list(_link_requests.items()):
        if now - started > LINK_TTL_SECONDS:
            _link_requests.pop(nonce, None)
    # Results are kept only long enough for the browser's next poll.
    if len(_link_results) > 32:
        _link_results.clear()


class HivemindosRuntime:
    """A producer engine with the same ``chat`` shape as ``local_llm``'s.

    Same signature on purpose: the tasks in ``story_producer`` are written
    against an engine, not against a provider, so which one runs is a lookup and
    not a branch inside every task.
    """

    def __init__(self, *, opener: Callable[..., Any] = urllib.request.urlopen, route: str = "") -> None:
        self._opener = opener
        self._route = route

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
        attached = [url for url in ([image] if image else []) + list(images or []) if url]
        body: dict[str, Any] = {
            "model": model_id,
            "messages": _with_images(messages, attached) if attached else messages,
            "temperature": temperature,
            "max_tokens": output_budget(model_id, max_tokens),
            "stream": False,
        }
        route = self._route or resolve_route()
        if route == ROUTE_APP:
            payload = _app_request(
                f"{MODELS_PATH}/chat/completions", method="POST", body=body,
                timeout=timeout, opener=self._opener,
            )
        elif model_id == FREE_MODEL_ID:
            # The free rail is device-scoped and never touches credits.
            payload = _gateway_request(
                f"/api/free-models/{FREE_MODEL_UPSTREAM}/chat/completions",
                method="POST", body={**body, "model": FREE_MODEL_UPSTREAM},
                headers={
                    "X-HivemindOS-Free-Device": device_id(),
                    "X-HivemindOS-Free-Workspace": "hivemind-content-studio",
                },
                timeout=timeout, opener=self._opener,
            )
        else:
            token = credit_token()
            if not token:
                raise HivemindosModelsError(
                    "Connect your HivemindOS account to spend its credits on this model.",
                    remedy="connect-account",
                )
            payload = _gateway_request(
                f"/api/paid-agents/{gateway_slug()}/chat/completions",
                method="POST", body={**body, "model": upstream_model(model_id)},
                headers={"X-HivemindOS-Credit-Token": token},
                timeout=timeout, opener=self._opener,
            )
        choices = payload.get("choices") if isinstance(payload, dict) else None
        if not choices:
            error = str((payload or {}).get("error") or "").strip()
            raise HivemindosModelsError(error or "The cloud model returned no completion.")
        content = str((choices[0].get("message") or {}).get("content") or "").strip()
        if not content:
            raise HivemindosModelsError("The cloud model returned an empty answer.")
        return content


def _with_images(messages: list[dict[str, Any]], attached: list[str]) -> list[dict[str, Any]]:
    """Pictures ride the LAST user turn, matching the local runtime's rule so a
    vision ask behaves the same on either engine."""
    copied = [dict(message) for message in messages]
    for message in reversed(copied):
        if message.get("role") == "user":
            message["content"] = [
                {"type": "text", "text": message.get("content") or ""},
                *({"type": "image_url", "image_url": {"url": url}} for url in attached),
            ]
            break
    return copied


def runtime(*, opener: Callable[..., Any] = urllib.request.urlopen) -> HivemindosRuntime:
    return HivemindosRuntime(opener=opener)
