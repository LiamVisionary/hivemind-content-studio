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

**All of this is per workspace.** Each workspace on this machine holds its own
account (``hivemindos_models.account_scope``): its own key, its own name, its
own backup. Nothing here reads a sibling's — except by a share, which is the
one thing a workspace may hand another: the right to SPEND its credits
(``sharing_state``, ``set_share``). A workspace spending shared credits keeps
its own name and its own (empty) account; the row says whose credits they are.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import re
import secrets
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
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


# The colours an avatar is allowed to be, as PAIRS rather than as a hue and an
# offset. Two reasons, both learned by looking at the result: a free 0-359 spin
# lands in the 55-100 band often enough to matter, and olive on this app's warm
# graphite reads as a stain rather than as a person; and an offset applied to a
# safe first hue can still slide the second stop into that band. Naming both
# ends removes the arithmetic that kept producing mustard. Each pair is a short
# walk around the wheel, so the gradient reads as depth rather than as two
# colours fighting.
_AVATAR_PAIRS = (
    (2, 22), (12, 340), (24, 4), (38, 18),
    (172, 192), (186, 166), (198, 176), (208, 188),
    (220, 244), (232, 206), (248, 224), (262, 286),
    (276, 250), (292, 268), (312, 290), (334, 310),
)


def derive_avatar(seed: str) -> dict[str, Any]:
    """A face with no picture in it: two hues and a monogram, drawn by the
    browser. No network, no upload, nothing to leak — and the same account is
    the same colour on every machine, which is what makes it recognisable."""
    digest = _seed_digest(seed)
    hue, hue2 = _AVATAR_PAIRS[digest[4] % len(_AVATAR_PAIRS)]
    handle = derive_handle(seed)
    letters = re.findall(r"[A-Z]", handle) or [handle[:1].upper() or "H"]
    return {"hue": hue, "hue2": hue2, "monogram": "".join(letters[:2])}


def set_handle(name: str) -> dict[str, Any]:
    """Rename this account, on this machine. Cosmetic by design: the gateway has
    no display name, and inventing one there would make the studio the authority
    on an identity the other HivemindOS apps could not see."""
    cleaned = " ".join(str(name or "").split())
    if not cleaned:
        models.set_account_store_value(HANDLE_KEY, None)
        invalidate_overview()
        return identity()
    if not _HANDLE_SHAPE.match(cleaned):
        raise HivemindosModelsError(
            "A name can be up to 24 letters, numbers, spaces, dashes or underscores.",
        )
    models.set_account_store_value(HANDLE_KEY, cleaned)
    invalidate_overview()
    return identity()


# --------------------------------------------------------------- who they are

def account_status(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """What the gateway knows about the account this key addresses.

    Never raises: the account row renders on a plane, and an unreachable gateway
    means "we cannot say yet", not an empty sidebar.

    The workspace's OWN key, here and in `account_id`: the row names the person
    at this workspace, and a workspace spending a sibling's shared credits is
    still not that sibling.
    """
    token = models.own_credit_token()
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
    token = models.own_credit_token()
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


def identity(
    *,
    opener: Callable[..., Any] = urllib.request.urlopen,
    account: str | None = None,
    status: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The account row's left half: a face, a name, and how safe it is.

    `account` and `status` are injectable so `overview` can fetch them
    alongside the other two reads instead of after them — see the note there.
    """
    account = account_id(opener=opener) if account is None else account
    status = account_status(opener=opener) if status is None else status
    seed = account or _local_seed()
    stored = str(models.account_store_value(HANDLE_KEY) or "").strip()
    return {
        "accountId": account,
        "handle": stored or derive_handle(seed),
        "handleIsCustom": bool(stored),
        "avatar": derive_avatar(seed),
        "emailLinked": bool(status.get("emailLinked")),
        "emailMasked": str(status.get("emailMasked") or ""),
        "passkeyCount": int(status.get("passkeyCount") or 0),
        "connected": bool(account),
        "source": models.own_credit_source(),
        # The one fact the disclaimer turns on: is this key the only thing in
        # the world that can reach these credits?
        "backedUp": bool(status.get("emailLinked")),
        "reachable": bool(status.get("reachable", True)),
    }


def _local_seed() -> str:
    """What names a workspace before it has an account.

    The owner keeps the install's device id — the seed this studio always had,
    so an upgrade renames nobody. Every other workspace gets the device id with
    its own id folded in: two people with no account yet should not share a
    name, which is the complaint that led here.
    """
    scope = models.account_scope()
    if scope is None or scope.is_owner:
        return models.device_id()
    return f"{models.device_id()}/workspace/{scope.account_id}"


# ------------------------------------------------------------ the free meter
#
# THE RULE THIS IS BUILT ON, because getting it wrong is what made the meter say
# "unknown" while the numbers were sitting right there: **an expired window is
# not an unknown one.** The free tier resets at UTC midnight. If the newest
# thing anyone recorded is from a window that has already rolled over, then
# nothing has been spent in the current one and what is left is the whole daily
# allowance — which the gateway states outright, for free, on its status route.
# "Unknown" is only honest when the gateway itself cannot be reached.
#
# Three places know something, and none of them knows everything:
#
#   the gateway's status route  the daily CEILING, always, free to ask. It also
#                               carried a live `usage` block for part of
#                               2026-09-10 and did not the same evening, so that
#                               is read when present and never depended on.
#   this studio's own record    headers from the free calls THIS studio made
#                               (`hivemindos_models.record_free_allowance`).
#   the HivemindOS app's cache  the same headers from the calls the APP made, in
#                               ~/.hivemindos/cache/. Read because the app and
#                               the studio spend the SAME per-device allowance
#                               when the studio proxies through it, so ignoring
#                               it would show a full meter over an empty tank.
#
# Whichever snapshots belong to the current window are merged by taking the
# lowest remaining count: they are views of one counter, and the lowest is the
# most recently true.

APP_ALLOWANCE_CACHE = ("cache", "hivemindos-free-allowance.json")


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


def _app_allowance_record() -> dict[str, Any]:
    """What the HivemindOS app last saw of the allowance, or {}."""
    if models.resolve_route() != ROUTE_APP:
        # A different device identity is being metered; the app's numbers are
        # about somebody else's counter.
        return {}
    try:
        raw = (models.app_home().joinpath(*APP_ALLOWANCE_CACHE)).read_text(encoding="utf-8")
        record = json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return {}
    return record if isinstance(record, dict) else {}


def _in_current_window(record: dict[str, Any]) -> bool:
    """Is this snapshot about the allowance that is running RIGHT NOW?

    A snapshot whose reset moment has passed describes a window that is over.
    Its numbers are not stale-but-indicative, they are simply about a different
    day — which is why they are dropped rather than shown with a caveat.
    """
    reset_at = str(record.get("resetAt") or "").strip()
    if not reset_at:
        return False
    try:
        moment = datetime.fromisoformat(reset_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment > datetime.now(timezone.utc)


def allowance(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Today's free Swarm Scout allowance: the ceiling, and what is left of it.

    Never raises, for the same reason `status` does not: this is a meter beside
    a name, and a gateway that cannot answer makes it unknown rather than zero.
    Zero and unknown look nothing alike to a person about to press Generate.
    """
    unknown = {
        "model": FREE_MODEL_NAME,
        "known": False,
        "remainingRequests": None,
        "remainingTokens": None,
        "requestLimit": None,
        "tokenLimit": None,
        "resetAt": "",
        "tierLabel": "",
        "source": "",
    }
    try:
        payload = models._gateway_request(
            f"/api/free-models/{FREE_MODEL_UPSTREAM}/chat/completions",
            headers={
                "X-HivemindOS-Free-Device": free_device_id(),
                "X-HivemindOS-Free-Workspace": "hivemind-content-studio",
            },
            # Tighter than the default 20s because this sits on the critical
            # path of a row that renders on every page, and the route probes
            # Modal for its container state — slow when it is cold, and nothing
            # to do with the number we came for.
            timeout=8.0,
            opener=opener,
        )
    except HivemindosModelsError:
        payload = None
    model = (payload or {}).get("model") if isinstance(payload, dict) else None
    model = model if isinstance(model, dict) else {}

    limits = model.get("allowance") if isinstance(model.get("allowance"), dict) else {}
    live = model.get("usage") if isinstance(model.get("usage"), dict) else {}
    # `or` would be wrong here: a limit of 0 is a real (if absurd) answer and
    # must not fall through to the other source.
    request_limit = _first_count(live.get("requestLimit"), limits.get("dailyRequests"))
    token_limit = _first_count(live.get("tokenLimit"), limits.get("dailyTokens"))
    tier = _tier_label(model)
    if request_limit is None and token_limit is None:
        # The gateway did not answer, or answered without its ceilings. The
        # ceiling is the most STABLE thing about this tier — it moves when a
        # stake tier does and not otherwise — so a remembered one beats going
        # blank, and the reset rule below still says what is left of it.
        remembered = models.free_ceiling_record()
        request_limit = _count(remembered.get("requestLimit"))
        token_limit = _count(remembered.get("tokenLimit"))
        tier = tier or str(remembered.get("tierLabel") or "")
        if request_limit is None and token_limit is None:
            return unknown
    else:
        models.remember_free_ceiling(request_limit, token_limit, tier)

    # Every snapshot that is about the window running now. `live` is the
    # gateway's own, when it offers one, and it needs no window check.
    current: list[dict[str, Any]] = []
    if _count(live.get("remainingRequests")) is not None or _count(live.get("remainingTokens")) is not None:
        current.append(live)
    for record in (models.free_allowance_record(), _app_allowance_record()):
        if record and _in_current_window(record):
            current.append(record)

    def lowest(field: str, ceiling: int | None) -> int | None:
        seen = [value for value in (_count(record.get(field)) for record in current) if value is not None]
        # Nothing recorded in this window means nothing has been spent in it:
        # the allowance reset and the whole of it is there. This is the line
        # that used to read "unknown" over a full tank.
        return min(seen) if seen else ceiling

    reset_at = str(live.get("resetAt") or "").strip()
    if not reset_at:
        for record in current:
            reset_at = str(record.get("resetAt") or "").strip()
            if reset_at:
                break
    return {
        "model": FREE_MODEL_NAME,
        "known": True,
        "remainingRequests": lowest("remainingRequests", request_limit),
        "remainingTokens": lowest("remainingTokens", token_limit),
        "requestLimit": request_limit,
        "tokenLimit": token_limit,
        "resetAt": reset_at or _next_utc_midnight(),
        "tierLabel": tier,
        # Named so the row can be honest about how fresh this is: "live" is the
        # gateway's own count, "observed" was learned from calls we made, "full"
        # is a window nothing has spent from yet.
        "source": "live" if live.get("remainingRequests") is not None
        else "observed" if current else "full",
    }


def _first_count(*values: Any) -> int | None:
    """The first of these that is a count at all."""
    for value in values:
        counted = _count(value)
        if counted is not None:
            return counted
    return None


def _next_utc_midnight() -> str:
    """When the allowance comes back, when nothing told us directly. The free
    tier's window is the UTC day, so this is derived rather than guessed."""
    now = datetime.now(timezone.utc)
    return (now.replace(hour=0, minute=0, second=0, microsecond=0)
            + timedelta(days=1)).isoformat().replace("+00:00", "Z")


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

# How long one read of all this is reused. The row is on screen on every page
# and both sheets mount their own copy of the hook, so opening the credits sheet
# used to mean three full round-trips of four calls each. Short enough that a
# balance never looks wrong for long; every mutation clears it outright.
_OVERVIEW_TTL_SECONDS = 12.0
# Keyed by workspace: one cache would hand the second person to sign in the
# first person's row for up to twelve seconds.
_overview_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _scope_key() -> str:
    scope = models.account_scope()
    return str(scope.account_id) if scope is not None else "machine"


def invalidate_overview() -> None:
    """Forget the cached reads. Called by everything that changes the answer —
    a rename, a sign-in, a settled deposit, a cancelled plan, a share — so the
    row never shows a person the state they just left. All of them, because a
    share changes a SIBLING's answer too."""
    _overview_cache.clear()


def overview(
    *, opener: Callable[..., Any] = urllib.request.urlopen, fresh: bool = False,
) -> dict[str, Any]:
    """Everything the account row shows, in one request from the browser.

    **Concurrently**, which is the whole point of the rewrite. This is four
    network calls — the balance, the account, the free meter, and the account
    id — and run one after another they took 15 seconds on this machine, most
    of it inside the gateway's free-model status route (it probes Modal for the
    container state, and a cold one is slow). Run together the total is the
    slowest single call instead of the sum of all four.

    Sequential was never justified: not one of the four depends on another's
    answer. They were written in the order the sentence reads.
    """
    key = _scope_key()
    if not fresh and key in _overview_cache:
        cached_at, cached = _overview_cache[key]
        if time.monotonic() - cached_at < _OVERVIEW_TTL_SECONDS:
            return cached

    def safely(call: Callable[[], Any], fallback: Any) -> Any:
        # Each of the four already refuses to raise for its own reasons; this is
        # the belt to that pair of braces, because ONE of them throwing inside a
        # pool would otherwise take the whole row down.
        try:
            return call()
        except Exception:  # noqa: BLE001 - a meter beside a name, never a crash
            return fallback

    no_credits = {"configured": False, "credits": None, "label": "Unknown", "source": ""}

    def in_scope(call: Callable[[], Any], fallback: Any):
        # A pool thread starts with an EMPTY context: it does not know which
        # workspace asked, and every one of these four reads resolves the
        # account from that. Without the copy each read fell back to the
        # owner, and a second workspace's row — its key just connected — came
        # back "not connected". One copy per call: a Context can be entered
        # by one thread at a time.
        return pool.submit(contextvars.copy_context().run, safely, call, fallback)

    with ThreadPoolExecutor(max_workers=4) as pool:
        credits_call = in_scope(lambda: models.credits(opener=opener), no_credits)
        account_call = in_scope(lambda: account_id(opener=opener), "")
        status_call = in_scope(lambda: account_status(opener=opener), {"reachable": False})
        allowance_call = in_scope(lambda: allowance(opener=opener), None)
        credits = credits_call.result()
        account = account_call.result()
        status = status_call.result()
        free = allowance_call.result()

    answer = {
        "identity": identity(opener=opener, account=account, status=status),
        "credits": credits,
        "allowance": free if free is not None else allowance(opener=opener),
        "route": models.resolve_route(),
        # Why the HivemindOS-wallet rail cannot be used, or '' when it can. Sent
        # with the row's own read so the credits sheet opens already knowing,
        # rather than learning it from a refused press.
        "walletPayBlocked": wallet_pay_blocked_reason(),
        # Whose credits this workspace spends, and who it lends its own to.
        "sharing": sharing_state(),
    }
    _overview_cache[key] = (time.monotonic(), answer)
    return answer


# ----------------------------------------------------- sharing with siblings
#
# The one thing a workspace may hand another: the right to spend its credits.
# The policy is the sharer's (hivemindos_models.credit_share) and a beneficiary
# reads it at spend time, so ending a share ends it at once. What it does not
# hand over is the account — a beneficiary's row keeps its own name, its own
# (empty) account and its own doors, and every route that backs up, renames,
# reveals or subscribes reads the workspace's OWN key.

def sharing_state() -> dict[str, Any]:
    """Who these credits are shared with, and whose this workspace spends.

    `workspaces` is every sibling with whether the current policy reaches it,
    which is what the share sheet's cards are drawn from; `sharedFrom` names
    the sibling whose credits this workspace is spending, or None.
    """
    scope = models.account_scope()
    share = models.credit_share()
    grant = models.credit_grant()
    siblings = [
        entry for entry in models.workspace_directory()
        if scope is None or entry.account_id != scope.account_id
    ]
    return {
        "workspaces": [
            {
                "id": entry.account_id,
                "name": entry.name,
                "colour": entry.colour,
                "isOwner": entry.is_owner,
                "shared": share["all"] or entry.account_id in share["with"],
            }
            for entry in siblings
        ],
        "all": share["all"],
        "with": share["with"],
        # A share needs something to share. The owner with the app's key has
        # it; a workspace with no account of its own does not, and offering
        # the sheet would end in a refusal.
        "canShare": bool(models.own_credit_token()),
        "sharedFrom": (
            {"id": grant.sharer.account_id, "name": grant.sharer.name, "isOwner": grant.sharer.is_owner}
            if grant is not None and grant.sharer is not None else None
        ),
    }


def set_share(*, everyone: bool, workspaces: list[int]) -> dict[str, Any]:
    """Let these siblings (or all of them) spend this workspace's credits."""
    if (everyone or workspaces) and not models.own_credit_token():
        raise HivemindosModelsError(
            "Connect an account or add credits before sharing them.",
            remedy="connect-account",
        )
    models.set_credit_share(everyone=everyone, workspaces=workspaces)
    invalidate_overview()
    return sharing_state()


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
    token = models.own_credit_token()
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
    token = models.own_credit_token()
    if not token:
        raise HivemindosModelsError("There is no account to back up yet.", remedy="connect-account")
    models._gateway_request(
        "/api/mini-app-account/email/link/verify",
        method="POST", body={"challengeId": _challenge(challenge_id), "code": _code(code)},
        headers={CREDIT_TOKEN_HEADER: token}, timeout=30.0, opener=opener,
    )
    invalidate_overview()
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
    previous = models.own_credit_token()
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
    invalidate_overview()
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
    token = models.own_credit_token()
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
    token = models.own_credit_token()
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
    token = models.own_credit_token()
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
    token = models.own_credit_token()
    if not token:
        raise HivemindosModelsError("No account is connected.", remedy="connect-account")
    models._gateway_request(
        f"/api/paid-agents/{models.gateway_slug()}/credits/subscription/cancel",
        method="POST", body={}, headers={CREDIT_TOKEN_HEADER: token}, timeout=30.0, opener=opener,
    )
    invalidate_overview()
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
    token = models.own_credit_token()
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
    token = models.own_credit_token()
    payload = models._gateway_request(
        "/api/payments/base-usdc/settle",
        method="POST", body={"paymentId": identifier, "transactionHash": tx_hash},
        headers={CREDIT_TOKEN_HEADER: token} if token else None,
        timeout=60.0, opener=opener,
    )
    minted = str((payload or {}).get("creditToken") or "").strip()
    if minted and not token:
        models.save_credit_token(minted)
    invalidate_overview()
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
# minted here moments ago, single use, five minutes, memory only. The app claims
# it to learn the AMOUNT — the figure in the deep-link URL is whatever fired the
# link, and any local process can fire one, so the number the owner is shown has
# to come from the request this studio actually made.
#
# What this rail deliberately does NOT do is redirect where the credits land.
# The app tops up the account it already pools, so this only offers itself when
# that account is the one this studio spends. A studio signed into its own
# account would be asking the owner to pay into a different balance, and the
# only honest thing to do about that is to say so and point at the two rails
# that do work — which is what `wallet_pay_blocked_reason` is for.

PAY_TTL_SECONDS = 300.0
_pay_requests: dict[str, dict[str, Any]] = {}


def wallet_pay_blocked_reason() -> str:
    """Why the wallet rail cannot be used here, or '' when it can.

    Answered BEFORE the button is pressed, because all three reasons are
    knowable in advance and none is repaired by trying: this is not the owner's
    workspace, there is no app to ask, or the app's balance is not the one this
    studio spends.
    """
    scope = models.account_scope()
    if scope is not None and not scope.is_owner:
        # The wallet lives in the owner's app, behind the owner's unlock. A
        # sibling pressing this would put the owner's money in front of the
        # owner for a balance that is not theirs to fund.
        return "other-workspace"
    if models.resolve_route() != ROUTE_APP:
        return "no-app"
    if models.credit_source() != "app":
        return "different-account"
    return ""


def start_wallet_payment(amount_usd: float, callback_url: str) -> dict[str, Any]:
    """Mint a payment request and the deep link that carries it to the app."""
    _expire_payments()
    blocked = wallet_pay_blocked_reason()
    if blocked == "no-app":
        raise HivemindosModelsError(
            "The HivemindOS app is not running on this machine, so there is no wallet to ask.",
            remedy="open-hivemindos",
        )
    if blocked == "different-account":
        raise HivemindosModelsError(
            "This studio is signed in to its own HivemindOS account, so the app's wallet would "
            "top up a different balance. Pay by card or USDC here, or sign in to the same account.",
            remedy="connect-account",
        )
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
    """What the app asks for once the owner has approved: how much was asked for.

    No credential crosses here, and none needs to: the app credits the account
    it already pools, which `start_wallet_payment` has established is the one
    this studio spends. What the app cannot trust on its own is the amount, so
    that is what this answers.
    """
    _expire_payments()
    request = _pay_requests.get(nonce)
    if not request or request["state"] not in {"pending", "claimed"}:
        # Same answer for expired, spent and never-issued: the caller is a local
        # process, not the owner's browser, and the difference is a hint.
        raise HivemindosModelsError("That payment request is not open.")
    request["state"] = "claimed"
    return {"amountUsd": request["amountUsd"], "app": "Hivemind Content Studio"}


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
