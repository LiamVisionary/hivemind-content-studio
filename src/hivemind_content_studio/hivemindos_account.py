"""The person behind the studio: who they are, what they have, and how to keep it.

The account row in the sidebar asks three questions this module answers in one
read: what to call this person, how much credit they hold, and how much of
today's free Swarm Scout allowance is left.

**The credits were never machine-local.** A HivemindOS balance is an account on
the hosted gateway; what lives on this machine is the bearer key that addresses
it (``hmos_credit_…``, encrypted, see ``hivemindos_models``). So "back up your
credits" is not a sync problem — it is a question of whether this install is the
ONLY thing that knows the key. Two doors close that gap, and both already exist
on the gateway:

  ``email``     link an address to the account, then sign in on any device with
                a six-digit code. The recoverable door: nothing to lose.
  ``key``       reveal the account key itself as a recovery code, to be written
                down and pasted into another install. The door for someone who
                will not hand over an email — and unrecoverable if lost, which
                is said where it is offered rather than in a footnote.

Neither needs a HivemindOS desktop account, and both land on the SAME account
the desktop and mobile apps use, so credits bought here spend there.

The name is derived, not stored on the gateway: the same account produces the
same handle on every device because the seed is the account id. Before there is
an account it is seeded from this install's device id instead — so a fresh
studio still has a name — and the handle changes once when an account first
appears, which is the one moment it is honest for it to change. A person who
renames it keeps their choice from then on.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import time
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable

from . import hivemindos_models as models
from .hivemindos_models import (
    FREE_MODEL_NAME,
    FREE_MODEL_UPSTREAM,
    HivemindosModelsError,
    ROUTE_APP,
)

CREDIT_TOKEN_HEADER = "X-HivemindOS-Credit-Token"

# What one HivemindOS credit costs, so a sheet can quote both. Mirrored from
# `models.CREDITS_PER_USD` rather than re-guessed.
CREDITS_PER_USD = models.CREDITS_PER_USD

# The amounts the credits sheet offers, matching the HivemindOS app's own row so
# the same product does not present two different price ladders.
TOP_UP_AMOUNTS_USD = (5, 10, 25, 50, 100)


# ------------------------------------------------------------------- the name
#
# Reddit's trick, and it is a good one: a name nobody chose is still a name, and
# it beats "Account" or a truncated key. Derived rather than random so it
# survives a reinstall that restores the same account, and so the person is
# called the same thing on their laptop and their desktop.

_ADJECTIVES = (
    "Amber", "Ancient", "Autumn", "Bold", "Brass", "Bright", "Calm", "Cedar",
    "Clever", "Copper", "Coral", "Crimson", "Crystal", "Dapper", "Dawn", "Deep",
    "Distant", "Drifting", "Dusty", "Eager", "Ember", "Fabled", "Feral", "Fleet",
    "Frosted", "Gentle", "Gilded", "Glass", "Golden", "Granite", "Hidden", "Honey",
    "Humble", "Indigo", "Ivory", "Jade", "Keen", "Lucid", "Lunar", "Marble",
    "Midnight", "Mellow", "Nimble", "Noble", "Northern", "Onyx", "Opal", "Patient",
    "Quiet", "Rapid", "Restless", "Rusted", "Sable", "Scarlet", "Silent", "Silver",
    "Solar", "Steady", "Stormy", "Tidal", "Umber", "Velvet", "Wandering", "Wild",
)

_NOUNS = (
    "Albatross", "Anvil", "Aurora", "Badger", "Basalt", "Beacon", "Bison", "Cedar",
    "Circuit", "Comet", "Compass", "Condor", "Coyote", "Crane", "Current", "Cypress",
    "Delta", "Dolphin", "Ember", "Falcon", "Fathom", "Fern", "Foundry", "Fox",
    "Gannet", "Glacier", "Harbor", "Harrier", "Heron", "Ibis", "Junco", "Kestrel",
    "Lantern", "Lynx", "Magpie", "Marten", "Meridian", "Monsoon", "Orbit", "Osprey",
    "Otter", "Pangolin", "Pelican", "Prairie", "Quarry", "Quill", "Raven", "Reef",
    "Ridge", "Sable", "Sequoia", "Shrike", "Sparrow", "Summit", "Tanager", "Thicket",
    "Tundra", "Vireo", "Walrus", "Warbler", "Willow", "Wolf", "Wren", "Zephyr",
)

# What a person may rename themselves to. Deliberately narrow: this string is
# rendered raw in the sidebar, so nothing that could pass for markup or a
# control character gets in.
_HANDLE_SHAPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,23}$")

HANDLE_KEY = "handle"


def _seed_digest(seed: str) -> bytes:
    return hashlib.sha256(f"hivemind-content-studio-handle:{seed}".encode("utf-8")).digest()


def derive_handle(seed: str) -> str:
    """The name this seed always produces. 64 × 64 × 1000 ≈ 4M of them."""
    digest = _seed_digest(seed)
    adjective = _ADJECTIVES[digest[0] % len(_ADJECTIVES)]
    noun = _NOUNS[digest[1] % len(_NOUNS)]
    return f"{adjective}{noun}{int.from_bytes(digest[2:4], 'big') % 1000:03d}"


def derive_avatar(seed: str) -> dict[str, Any]:
    """A face with no picture in it: two hues and a monogram, drawn by the
    browser. No network, no upload, nothing to leak — and the same account is
    the same colour on every machine, which is what makes it recognisable."""
    digest = _seed_digest(seed)
    hue = digest[4] * 360 // 256
    handle = derive_handle(seed)
    letters = re.findall(r"[A-Z]", handle) or [handle[:1].upper() or "H"]
    return {
        "hue": hue,
        # A second hue a fixed distance away: far enough to read as a gradient,
        # near enough that it never turns into a clashing pair.
        "hue2": (hue + 38 + digest[5] % 34) % 360,
        "monogram": "".join(letters[:2]),
    }


def set_handle(name: str) -> dict[str, Any]:
    """Rename this account, on this machine. Cosmetic by design: the gateway has
    no display name, and inventing one there would make the studio the authority
    on an identity the other HivemindOS apps could not see."""
    cleaned = " ".join(str(name or "").split())
    if not cleaned:
        models.set_store_value(HANDLE_KEY, None)
        return identity()
    if not _HANDLE_SHAPE.match(cleaned):
        raise HivemindosModelsError(
            "A name can be up to 24 letters, numbers, spaces, dashes or underscores.",
        )
    models.set_store_value(HANDLE_KEY, cleaned)
    return identity()


# --------------------------------------------------------------- who they are

def account_status(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """What the gateway knows about the account this key addresses.

    Never raises: the account row renders on a plane, and an unreachable gateway
    means "we cannot say yet", not an empty sidebar.
    """
    token = models.credit_token()
    if not token:
        return {"authenticated": False, "reachable": True}
    try:
        payload = models._gateway_request(
            "/api/mini-app-account",
            headers={CREDIT_TOKEN_HEADER: token},
            opener=opener,
        )
    except HivemindosModelsError:
        return {"authenticated": False, "reachable": False}
    if not isinstance(payload, dict):
        return {"authenticated": False, "reachable": False}
    return {
        "authenticated": bool(payload.get("authenticated")),
        "reachable": True,
        "emailLinked": bool(payload.get("emailLinked")),
        "emailMasked": str(payload.get("emailMasked") or ""),
        "passkeyCount": int(payload.get("passkeyCount") or 0),
        "walletLinked": bool(payload.get("walletLinked")),
    }


def account_id(*, opener: Callable[..., Any] = urllib.request.urlopen) -> str:
    """The gateway's id for this balance — the handle's seed once one exists."""
    token = models.credit_token()
    if not token:
        return ""
    try:
        payload = models._gateway_request(
            f"/api/paid-agents/{models.gateway_slug()}/credits/balance",
            headers={CREDIT_TOKEN_HEADER: token},
            opener=opener,
        )
    except HivemindosModelsError:
        return ""
    return str((payload or {}).get("accountId") or "") if isinstance(payload, dict) else ""


def identity(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """The account row's left half: a face, a name, and how safe it is."""
    account = account_id(opener=opener)
    status = account_status(opener=opener)
    seed = account or models.device_id()
    stored = str(models.store_value(HANDLE_KEY) or "").strip()
    return {
        "accountId": account,
        "handle": stored or derive_handle(seed),
        "handleIsCustom": bool(stored),
        "avatar": derive_avatar(seed),
        "emailLinked": bool(status.get("emailLinked")),
        "emailMasked": str(status.get("emailMasked") or ""),
        "passkeyCount": int(status.get("passkeyCount") or 0),
        "connected": bool(account),
        "source": models.credit_source(),
        # The one fact the disclaimer turns on: is this key the only thing in
        # the world that can reach these credits?
        "backedUp": bool(status.get("emailLinked")),
        "reachable": bool(status.get("reachable", True)),
    }


# ------------------------------------------------------------ the free meter
#
# The gateway meters the free model per device per UTC day and — since the
# `usage` block landed on its status route — will say how much of that is left
# without spending any of it. That is the whole meter: no local high-water
# bookkeeping, no probe that costs a request, and it stays right when the same
# account burns allowance from another app on this machine.

def free_device_id() -> str:
    """The device identity this studio's free calls actually carry.

    Through the app it is the app's, direct it is this studio's own — and the
    meter has to ask about the one that is being spent, or it would read a
    stranger's allowance.
    """
    if models.resolve_route() == ROUTE_APP:
        try:
            existing = (models.app_home() / "device-id").read_text(encoding="utf-8").strip()
        except OSError:
            existing = ""
        if re.fullmatch(r"[a-f0-9]{32}", existing):
            return existing
    return models.device_id()


def allowance(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Today's free Swarm Scout allowance, as the gateway counts it right now.

    Never raises, for the same reason `status` does not: this is a meter beside
    a name, and an unreachable gateway makes it unknown rather than zero. Zero
    and unknown look nothing alike to a person about to press Generate.
    """
    empty = {
        "model": FREE_MODEL_NAME,
        "known": False,
        "remainingRequests": None,
        "remainingTokens": None,
        "requestLimit": None,
        "tokenLimit": None,
        "resetAt": "",
        "tierLabel": "",
    }
    try:
        payload = models._gateway_request(
            f"/api/free-models/{FREE_MODEL_UPSTREAM}/chat/completions",
            headers={
                "X-HivemindOS-Free-Device": free_device_id(),
                "X-HivemindOS-Free-Workspace": "hivemind-content-studio",
            },
            opener=opener,
        )
    except HivemindosModelsError:
        return empty
    model = (payload or {}).get("model") if isinstance(payload, dict) else None
    usage = (model or {}).get("usage") if isinstance(model, dict) else None
    if not isinstance(usage, dict):
        # An older gateway answers the status route without a `usage` block.
        # The daily ceilings are still there, and a meter that can only say
        # "400 a day" is worth more than no meter.
        limits = (model or {}).get("allowance") if isinstance(model, dict) else None
        if not isinstance(limits, dict):
            return empty
        return {
            **empty,
            "known": True,
            "requestLimit": _count(limits.get("dailyRequests")),
            "tokenLimit": _count(limits.get("dailyTokens")),
            "tierLabel": _tier_label(model),
        }
    return {
        "model": FREE_MODEL_NAME,
        "known": True,
        "remainingRequests": _count(usage.get("remainingRequests")),
        "remainingTokens": _count(usage.get("remainingTokens")),
        "requestLimit": _count(usage.get("requestLimit")),
        "tokenLimit": _count(usage.get("tokenLimit")),
        "resetAt": str(usage.get("resetAt") or ""),
        "tierLabel": _tier_label(model),
    }


def _count(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _tier_label(model: dict[str, Any]) -> str:
    """"Builder" and friends — a staked tier that raised this allowance. Said
    out loud, because an allowance that is bigger than the neighbour's is the
    one thing about a free tier worth bragging about."""
    benefit = model.get("quotaBenefit") if isinstance(model, dict) else None
    if not isinstance(benefit, dict):
        return ""
    return str(benefit.get("tierLabel") or "").strip()


# --------------------------------------------------------------- one read

def overview(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Everything the account row shows, in one request from the browser.

    Three gateway calls behind one door rather than three polls from the
    sidebar: the row is on screen on every page, and a row that polls three
    endpoints is three times the noise in the log for the same one line of UI.
    """
    try:
        credits = models.credits(opener=opener)
    except HivemindosModelsError:
        credits = {"configured": False, "credits": None, "label": "Unknown", "source": ""}
    return {
        "identity": identity(opener=opener),
        "credits": credits,
        "allowance": allowance(opener=opener),
        "route": models.resolve_route(),
    }


# ------------------------------------------------------- backing the account up
#
# Two doors, and the difference between them is the whole point:
#
#   an email is RECOVERABLE. Lose the machine, lose the key, lose the install —
#   a six-digit code still returns the account.
#   a recovery key is a BEARER credential. Whoever holds it holds the credits,
#   and nothing can reissue it. Written down it is a backup; lost it is the end
#   of that balance.
#
# Both are offered. Neither is implied to be the other.

_EMAIL_SHAPE = re.compile(r"^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$")
_CHALLENGE_SHAPE = re.compile(r"^[A-Za-z0-9_-]{8,80}$")
_CODE_SHAPE = re.compile(r"^\d{6}$")


def _email(raw: str) -> str:
    address = str(raw or "").strip().lower()
    if not _EMAIL_SHAPE.match(address):
        raise HivemindosModelsError("Enter an email address.")
    return address


def _challenge(raw: str) -> str:
    value = str(raw or "").strip()
    if not _CHALLENGE_SHAPE.match(value):
        raise HivemindosModelsError("That sign-in has expired. Ask for a new code.")
    return value


def _code(raw: str) -> str:
    value = str(raw or "").strip()
    if not _CODE_SHAPE.match(value):
        raise HivemindosModelsError("Enter the six-digit code from your email.")
    return value


def email_link_start(email: str, *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Send a code to attach this address to the account this studio holds."""
    token = models.credit_token()
    if not token:
        raise HivemindosModelsError(
            "There is no account to back up yet. Add credits or sign in first.",
            remedy="connect-account",
        )
    payload = models._gateway_request(
        "/api/mini-app-account/email/link/start",
        method="POST", body={"email": _email(email)},
        headers={CREDIT_TOKEN_HEADER: token}, timeout=30.0, opener=opener,
    )
    return {"challengeId": str((payload or {}).get("challengeId") or "")}


def email_link_verify(challenge_id: str, code: str, *,
                      opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Finish attaching the address. From here the account is recoverable."""
    token = models.credit_token()
    if not token:
        raise HivemindosModelsError("There is no account to back up yet.", remedy="connect-account")
    models._gateway_request(
        "/api/mini-app-account/email/link/verify",
        method="POST", body={"challengeId": _challenge(challenge_id), "code": _code(code)},
        headers={CREDIT_TOKEN_HEADER: token}, timeout=30.0, opener=opener,
    )
    return {"linked": True, "identity": identity(opener=opener)}


def email_signin_start(email: str, *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Send a code to the address on an account that already exists.

    The gateway answers the same either way — a code is sent only if that
    address is on an account — and so does this: telling an unauthenticated
    caller which addresses have accounts is a list nobody should be able to
    build.
    """
    payload = models._gateway_request(
        "/api/mini-app-account/email/signin/start",
        method="POST", body={"email": _email(email)}, timeout=30.0, opener=opener,
    )
    return {"challengeId": str((payload or {}).get("challengeId") or "")}


def email_signin_verify(challenge_id: str, code: str, *,
                        opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Take the account back on this machine, keeping whatever was already here.

    The order is deliberate. The signed-in account is named FIRST in the merge,
    so it is the one that survives and the credits bought on this install before
    signing in fold into it — rather than the account the person just proved
    they own being folded into an anonymous local one.
    """
    previous = models.credit_token()
    payload = models._gateway_request(
        "/api/mini-app-account/email/signin/verify",
        method="POST", body={"challengeId": _challenge(challenge_id), "code": _code(code)},
        timeout=30.0, opener=opener,
    )
    minted = str((payload or {}).get("creditToken") or "").strip()
    if not minted:
        raise HivemindosModelsError("That sign-in did not complete. Ask for a new code.")
    merged = False
    if previous and previous != minted:
        try:
            models.merge_accounts([minted, previous], opener=opener)
            merged = True
        except HivemindosModelsError:
            # The sign-in itself worked; only the fold-in of a second balance
            # did not. Keep the account they proved they own and say so, rather
            # than refusing a sign-in over credits that are still there to merge
            # later.
            models.save_credit_token(minted)
    else:
        models.save_credit_token(minted)
    return {
        "signedIn": True,
        "mergedPreviousBalance": merged,
        "identity": identity(opener=opener),
        "credits": models.credits(opener=opener),
    }


def recovery_key() -> dict[str, Any]:
    """The account key itself, for someone who wants no email on file.

    Shown once, on an explicit press, with what it is said plainly: this string
    IS the balance. It is the same credential the studio stores encrypted and
    the same one another install accepts on its connect field, which is why
    there is nothing to generate — a second secret would be a second thing to
    lose.
    """
    token = models.credit_token()
    if not token:
        raise HivemindosModelsError(
            "There is no account yet. Add credits or sign in first.",
            remedy="connect-account",
        )
    return {"key": token, "accountId": account_id()}


# ------------------------------------------------------------- subscriptions

SUBSCRIPTION_TIERS = ("plus", "pro", "max")


def subscription(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """The monthly plans, and which one is running.

    Never raises: this rides in the same sheet as the one-off amounts, and a
    plans list that cannot be read should cost the sheet its subscription
    section, not the top-up that was working.
    """
    try:
        plans_payload = models._gateway_request(
            f"/api/paid-agents/{models.gateway_slug()}/credits/subscription/plans", opener=opener,
        )
    except HivemindosModelsError as exc:
        return {"available": False, "plans": [], "current": None, "detail": str(exc)}
    plans = [
        {
            "tier": str(plan.get("tier") or ""),
            "priceUsdMonthly": plan.get("priceUsdMonthly"),
            "monthlyCredits": plan.get("monthlyCredits"),
        }
        for plan in ((plans_payload or {}).get("plans") or [])
        if isinstance(plan, dict) and plan.get("tier") in SUBSCRIPTION_TIERS
    ]
    token = models.credit_token()
    current = None
    if token:
        try:
            state = models._gateway_request(
                f"/api/paid-agents/{models.gateway_slug()}/credits/subscription",
                headers={CREDIT_TOKEN_HEADER: token}, opener=opener,
            )
            found = (state or {}).get("subscription")
            if isinstance(found, dict) and found.get("status") in {"active", "trialing"}:
                current = {
                    "tier": str(found.get("tier") or ""),
                    "status": str(found.get("status") or ""),
                    "currentPeriodEnd": str(found.get("currentPeriodEnd") or ""),
                }
        except HivemindosModelsError:
            current = None
    return {"available": bool(plans), "plans": plans, "current": current, "detail": ""}


def _tier(raw: str) -> str:
    tier = str(raw or "").strip().lower()
    if tier not in SUBSCRIPTION_TIERS:
        raise HivemindosModelsError("Choose a plan.")
    return tier


def subscription_checkout(tier: str, *, return_url: str = "",
                          opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Start a monthly plan. The card is entered on the gateway's page, by them."""
    token = models.credit_token()
    payload = models._gateway_request(
        f"/api/paid-agents/{models.gateway_slug()}/credits/subscription/checkout",
        method="POST",
        body={"tier": _tier(tier), **({"successUrl": return_url, "cancelUrl": return_url} if return_url else {})},
        headers={
            "Idempotency-Key": f"content-studio-subscription-{uuid.uuid4()}",
            **({CREDIT_TOKEN_HEADER: token} if token else {}),
        },
        timeout=30.0, opener=opener,
    )
    minted = str((payload or {}).get("creditToken") or "").strip()
    if minted and not token:
        models.save_credit_token(minted)
    return {
        "checkoutUrl": str((payload or {}).get("checkoutUrl") or ""),
        "openedNewAccount": bool(minted and not token),
    }


CANCEL_CONFIRMATION = "CANCEL_HIVEMINDOS_CREDIT_SUBSCRIPTION"


def subscription_cancel(confirmation: str, *,
                        opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Stop the monthly plan. Credits already granted are not clawed back."""
    if confirmation != CANCEL_CONFIRMATION:
        raise HivemindosModelsError("Confirm the cancellation first. Nothing has changed.")
    token = models.credit_token()
    if not token:
        raise HivemindosModelsError("No account is connected.", remedy="connect-account")
    models._gateway_request(
        f"/api/paid-agents/{models.gateway_slug()}/credits/subscription/cancel",
        method="POST", body={}, headers={CREDIT_TOKEN_HEADER: token}, timeout=30.0, opener=opener,
    )
    return {"cancelled": True, "subscription": subscription(opener=opener)}


# ------------------------------------------------------ USDC, sent from anywhere
#
# The rail for money that is not on a card and not in a wallet this machine can
# sign for: an exchange, a phone, a hardware key. The gateway quotes an address
# and an exact amount, they send it from wherever it lives, and the transfer is
# matched by its hash.
#
# Two of its constraints are the gateway's and both bite in practice, so both
# are surfaced rather than discovered: the sending address is declared BEFORE
# the transfer (it is what the payment is matched against), and the quote
# expires.

_ADDRESS_SHAPE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_TX_SHAPE = re.compile(r"^0x[0-9a-fA-F]{64}$")


def deposit_config(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Which chain and which token, straight from the gateway."""
    try:
        payload = models._gateway_request("/api/payments/base-usdc", opener=opener)
    except HivemindosModelsError as exc:
        return {"available": False, "detail": str(exc)}
    return {
        "available": True,
        "chainId": (payload or {}).get("chainId"),
        "network": str((payload or {}).get("network") or ""),
        "asset": str((payload or {}).get("asset") or "USDC"),
        "detail": "",
    }


def deposit_quote(payer: str, amount_usd: float, *,
                  opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Reserve an address and an amount for one transfer."""
    address = str(payer or "").strip()
    if not _ADDRESS_SHAPE.match(address):
        raise HivemindosModelsError(
            "Enter the Base address you will send from, so the transfer can be matched to you.",
        )
    token = models.credit_token()
    payload = models._gateway_request(
        "/api/payments/base-usdc/quote",
        method="POST", body={"payer": address, "amountUsd": round(float(amount_usd), 2)},
        headers={CREDIT_TOKEN_HEADER: token} if token else None,
        timeout=30.0, opener=opener,
    )
    minted = str((payload or {}).get("creditToken") or "").strip()
    if minted and not token:
        # The quote opened the account. Store it now: a person who sends the
        # USDC and only then finds the studio forgot which account to credit has
        # lost real money.
        models.save_credit_token(minted)
    return {
        "paymentId": str((payload or {}).get("paymentId") or ""),
        "recipient": str((payload or {}).get("recipient") or ""),
        "amountUsd": (payload or {}).get("amountUsd"),
        "expiresAt": str((payload or {}).get("expiresAt") or ""),
        "openedNewAccount": bool(minted and not token),
    }


def deposit_settle(payment_id: str, transaction_hash: str, *,
                   opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Claim a transfer that has landed, by its hash."""
    identifier = str(payment_id or "").strip()
    tx_hash = str(transaction_hash or "").strip().lower()
    if not identifier:
        raise HivemindosModelsError("Start a deposit before confirming one.")
    if not _TX_SHAPE.match(tx_hash):
        raise HivemindosModelsError("Paste the transaction hash of the transfer you sent.")
    token = models.credit_token()
    payload = models._gateway_request(
        "/api/payments/base-usdc/settle",
        method="POST", body={"paymentId": identifier, "transactionHash": tx_hash},
        headers={CREDIT_TOKEN_HEADER: token} if token else None,
        timeout=60.0, opener=opener,
    )
    minted = str((payload or {}).get("creditToken") or "").strip()
    if minted and not token:
        models.save_credit_token(minted)
    return {
        "settled": True,
        "creditedUsd": (payload or {}).get("creditedUsd"),
        "credits": models.credits(opener=opener),
    }


# ------------------------------------------ paying from the HivemindOS wallet
#
# The fourth rail, and the only one whose money this studio cannot touch: the
# owner's wallet lives in the HivemindOS desktop app and only that app can sign
# for it.
#
# So this asks. `hivemindos://models/pay` reaches the app on THIS machine and no
# other, the app puts the amount in front of the owner behind its own unlock,
# and only then does it spend. The studio never sees the wallet, the key or the
# approval — it sees a nonce come back settled.
#
# The nonce is the authorisation, exactly as it is for the account link above:
# minted here moments ago, single use, five minutes, memory only. What is new is
# the claim step. The app has to credit the account this studio SPENDS, which is
# not always the app's own pool — so the app presents the nonce and receives the
# target. When the two already share one account (the studio adopted the app's
# key) nothing is handed over at all, because there is nothing to tell it.

PAY_TTL_SECONDS = 300.0
_pay_requests: dict[str, dict[str, Any]] = {}


def start_wallet_payment(amount_usd: float, callback_url: str) -> dict[str, Any]:
    """Mint a payment request and the deep link that carries it to the app."""
    _expire_payments()
    amount = round(float(amount_usd), 2)
    if not 1 <= amount <= 500:
        raise HivemindosModelsError("Choose an amount between $1 and $500.")
    nonce = secrets.token_urlsafe(32)
    _pay_requests[nonce] = {"started": time.monotonic(), "amountUsd": amount, "state": "pending", "detail": ""}
    query = urllib.parse.urlencode({
        "nonce": nonce,
        "callback": callback_url,
        "app": "Hivemind Content Studio",
        "amountUsd": f"{amount:.2f}",
    })
    return {"nonce": nonce, "url": f"hivemindos://models/pay?{query}", "expiresIn": int(PAY_TTL_SECONDS)}


def claim_wallet_payment(nonce: str) -> dict[str, Any]:
    """What the app asks for once the owner has approved: where to send them.

    Returns the account key ONLY when this studio spends an account the app does
    not already hold — that is, when the studio signed in on its own. An adopted
    app key means one balance and nothing to hand over.
    """
    _expire_payments()
    request = _pay_requests.get(nonce)
    if not request or request["state"] not in {"pending", "claimed"}:
        # Same answer for expired, spent and never-issued: the caller is a local
        # process, not the owner's browser, and the difference is a hint.
        raise HivemindosModelsError("That payment request is not open.")
    request["state"] = "claimed"
    own_key = "" if models.credit_source() == "app" else models.credit_token()
    return {
        "amountUsd": request["amountUsd"],
        # Empty means "your own pool is the right account".
        "creditToken": own_key,
    }


def complete_wallet_payment(nonce: str, *, settled: bool, detail: str = "") -> dict[str, Any]:
    """The app's verdict on a payment the owner approved (or refused)."""
    _expire_payments()
    request = _pay_requests.get(nonce)
    if not request:
        raise HivemindosModelsError("That payment request is not open.")
    request["state"] = "settled" if settled else "refused"
    request["detail"] = str(detail or "")[:400]
    return {"state": request["state"]}


def wallet_payment_state(nonce: str) -> dict[str, Any]:
    """What the browser polls while the owner is over in the app."""
    _expire_payments()
    request = _pay_requests.get(nonce)
    if not request:
        return {"state": "expired", "detail": ""}
    return {"state": request["state"], "detail": request["detail"]}


def _expire_payments() -> None:
    now = time.monotonic()
    for nonce, request in list(_pay_requests.items()):
        settled = request["state"] in {"settled", "refused"}
        # A settled result is kept only long enough for the browser's next poll.
        if now - request["started"] > (30.0 if settled else PAY_TTL_SECONDS):
            _pay_requests.pop(nonce, None)
