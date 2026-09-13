"""Zero-provider-key media generation on the official HivemindOS media rail.

The rail is a PUBLIC service, not a feature of the desktop app: every call
here goes to ``<gateway>/api/media/managed`` on the same Cloudflare Worker
that serves HivemindOS Models, and the HivemindOS app is a client of it
exactly as this studio is. That is worth stating because this module used to
believe otherwise — it posted to ``http://127.0.0.1:5020/api/hivemindos/media``
and so was dead whenever the app was closed, which on a machine that only runs
the studio is always. Nothing about the rail ever required the app; it
required the app's *token*, and a credit token is something this studio can
resolve on its own (:func:`hivemindos_models.credit_token`).

What each route costs to call:

* ``GET  /api/media/managed``           the catalogue. Public, no credential.
* ``POST /api/media/managed/quote``     the exact price of one request. Public.
* ``POST /api/media/managed/inputs``    store a starting picture/clip so a
  provider can fetch it. Credit token; see the note on :func:`upload_input`.
* ``POST /api/media/managed/generate``  reserve credits and submit. Credit
  token + an idempotency key.
* ``GET  /api/media/managed/jobs/<id>`` poll one owned job. Credit token.

So the catalogue and every price in it are readable with no account at all,
which is what lets the model picker show the hosted rail — priced — to someone
who has not connected anything yet.
"""

from __future__ import annotations

import json
import os
import re
import threading
import shlex
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

from .generation import _download


# Kept because three other modules import it for the app's own routes
# (hivemindos_models' app lane, oauth, brain). The media rail no longer uses
# it.
DEFAULT_HIVEMINDOS_URL = "http://127.0.0.1:5020"
MANAGED_MEDIA_PATH = "/api/media/managed"
OFFICIAL_MARKUP_BPS = 2500
TERMINAL_FAILURES = {"failed", "error", "cancelled", "canceled"}
# What a provider can be handed, and the extension the gateway stores it under.
# Mirrors MEDIA_INPUT_TYPES in the Worker: an upload of anything else is
# refused there, and refusing it here too means the refusal names the file
# rather than arriving as an HTTP 415.
INPUT_CONTENT_TYPES = {
    "image/png", "image/jpeg", "image/webp", "image/gif",
    "video/mp4", "video/webm", "video/quicktime",
    "audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4",
}
INPUT_MAX_BYTES = 64 * 1024 * 1024


# The catalogue, remembered.
#
# Two callers want it on the same request — the readiness sweep
# (providers.provider_report) and the model list (media_catalog) — and both
# run on every /api/simple/catalog. One live read serves them for a while, and
# the LAST LIVE answer outlives a miss: a model list is not something to
# approximate, and a service that blinks must not empty the picker. Same rule
# as `_last_live_media_studio_models`.
_CATALOG_TTL_SECONDS = 300
_catalog_cache: dict[str, Any] = {"at": 0.0, "value": None}
_last_live_catalog: dict[str, Any] | None = None


def cached_hosted_media_catalog(*, force: bool = False, timeout: float = 15) -> tuple[dict[str, Any] | None, bool]:
    """``(catalogue, live)``. ``live`` is False when this is a remembered copy
    (or None, when nothing has ever answered here or in any earlier run).

    The timeout is the caller's because the two callers are not alike: the
    readiness sweep runs inside a page load and must give up quickly, while
    the background warm has all the time it needs. A cold process asking the
    gateway — which fans out to MUAPI to build the list — measured over 15s,
    so the short path misses on exactly the boot where nothing is remembered
    yet. That is what the FILE below is for.
    """
    global _last_live_catalog
    now = time.monotonic()
    if not force and _catalog_cache["value"] is not None and now - _catalog_cache["at"] < _CATALOG_TTL_SECONDS:
        return _catalog_cache["value"], True
    try:
        value = hosted_media_catalog(timeout=timeout)
    except RuntimeError:
        return _last_live_catalog or _remembered_catalog(), False
    _catalog_cache.update({"at": now, "value": value})
    _last_live_catalog = value
    _save_price_cache()
    return value, True


def forget_hosted_media_catalog() -> None:
    """Test seam, and the hook a manual refresh would use."""
    global _last_live_catalog
    _catalog_cache.update({"at": 0.0, "value": None})
    _last_live_catalog = None


def hosted_media_catalog(*, timeout: float = 15, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """The live hosted catalogue: what runs, in what category, at what price.

    Public — no credential, and deliberately so. A picker that could only
    price the rail after the owner connected an account would have nothing to
    show the person deciding whether to.
    """
    request = urllib.request.Request(_endpoint(), method="GET", headers=_headers())
    payload = _request_json(request, timeout=timeout, opener=opener)
    models = payload.get("models")
    return {
        "configured": payload.get("configured") is True,
        "markup_bps": payload.get("markupBps"),
        "max_debit_usd": payload.get("maxDebitUsd"),
        "credit_slug": str(payload.get("creditSlug") or ""),
        "models": [model for model in models if isinstance(model, dict)] if isinstance(models, list) else [],
    }


# ── one model, several endpoints ─────────────────────────────────────────────
#
# The gateway lists an ENDPOINT per row: `flux-3` appears four times as
# flux-3-text-to-image, -image-to-image, -text-to-video and -image-to-video.
# Those are four prices and one model, and a picker that lists them as four
# models asks the reader to know which suffix means "start from a picture".
# So the studio shows one row per model with its capabilities as badges, and
# picks the endpoint from what the composer actually has attached.
#
# The capability is read off the CATEGORY, never off the suffix — a rule with
# a counter-example in the live catalogue: `infinitetalk-image-to-video` is
# filed under "Audio to Video".
HOSTED_CAPABILITIES: dict[str, tuple[str, str]] = {
    # category (normalised) -> (studio kind, capability)
    "text to image": ("image", "text-to-image"),
    "image to image": ("image", "image-to-image"),
    "text to video": ("video", "text-to-video"),
    "image to video": ("video", "image-to-video"),
    "video to video": ("video", "video-to-video"),
    "audio to video": ("video", "audio-to-video"),
}
# What each capability needs beside the prompt. `None` = nothing.
CAPABILITY_INPUT: dict[str, str | None] = {
    "text-to-image": None,
    "text-to-video": None,
    "image-to-image": "image",
    "image-to-video": "image",
    "video-to-video": "video",
    "audio-to-video": "audio",
}
# Endpoint suffixes that name a capability rather than a model. Longest first,
# so `-image-to-video` is not read as `-video`.
_CAPABILITY_SUFFIXES = (
    "-text-to-image", "-image-to-image", "-text-to-video", "-image-to-video",
    "-video-to-video", "-audio-to-video", "-text2image", "-text2video", "-image2video",
    "-t2i", "-i2i", "-t2v", "-i2v", "-v2v",
)
# Tokens that are versions, acronyms or format shorthand, not words. Without
# this the derived labels read "Gpt Image 2" and "Ai Captions".
_SHOUTED = re.compile(
    r"^(?:v?\d[\w.]*|\d+[a-z]{1,2}"
    r"|i2i|t2i|i2v|t2v|v2v|gpt|ai|xl|hd|sd|uhd|hq|3d|api|fps|nsfw|tts|stt|ocr|vfx|cgi|ugc|hdr)$",
    re.I,
)


def hosted_category_capability(category: str) -> tuple[str, str] | None:
    text = " ".join(str(category or "").strip().lower().replace("_", " ").replace("-", " ").split())
    return HOSTED_CAPABILITIES.get(text)


def hosted_model_base(model_id: str) -> str:
    """The model behind an endpoint id: `flux-3-image-to-video` -> `flux-3`."""
    text = str(model_id or "").strip().lower()
    for suffix in _CAPABILITY_SUFFIXES:
        if text.endswith(suffix) and len(text) > len(suffix):
            return text[: -len(suffix)]
    return text


def hosted_model_label(model_id: str) -> str:
    """A readable name for an id the gateway does not label.

    It labels none of them: every row on the live catalogue is
    ``{id, category, dynamicPricing, priceUsd, available, automaticFallback}``.
    """
    tokens = [token for token in str(model_id or "").replace("_", "-").split("-") if token]
    return " ".join(
        token.upper() if _SHOUTED.match(token) else token[:1].upper() + token[1:]
        for token in tokens
    ) or str(model_id or "")


def consolidate_hosted_models(entries: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """The gateway's endpoint rows, as one row per model per studio kind.

    Returns ``{"image": [...], "video": [...]}``; each row carries the
    capabilities it has in THAT kind and the endpoint id behind each one, so
    the studio can price and run the capability the composer is actually set
    up for.
    """
    # Grouped across both kinds first, so a model that appears in each keeps
    # one name in both pickers.
    spread: dict[str, int] = {}
    for entry in entries:
        if hosted_category_capability(str(entry.get("category") or "")):
            base = hosted_model_base(str(entry.get("id") or ""))
            spread[base] = spread.get(base, 0) + 1

    rows: dict[str, dict[str, dict[str, Any]]] = {"image": {}, "video": {}}
    for entry in entries:
        model_id = str(entry.get("id") or "").strip().lower()
        verdict = hosted_category_capability(str(entry.get("category") or ""))
        if not model_id or not verdict:
            continue
        kind, capability = verdict
        base = hosted_model_base(model_id)
        # A base nothing else shares is not a consolidation — keep the id the
        # gateway actually published rather than inventing a shorter one.
        row_id = base if spread.get(base, 0) > 1 else model_id
        row = rows[kind].setdefault(row_id, {
            "id": row_id,
            "label": hosted_model_label(row_id),
            # capability -> {model: the gateway's endpoint id, usd: a fixed
            # price or None}. 528 of the 538 endpoints price dynamically and
            # the ten that do not still move with duration and resolution, so
            # `usd` is a hint for the row and never the number on the button
            # — that one comes from a live quote of the actual request.
            "routes": {},
            "available": False,
            "default": False,
        })
        price = entry.get("priceUsd")
        fixed = float(price) if isinstance(price, (int, float)) and price > 0 and not entry.get("dynamicPricing") else None
        row["routes"][capability] = {"model": model_id, "usd": fixed}
        row["available"] = row["available"] or entry.get("available") is not False
        row["default"] = row["default"] or entry.get("automaticFallback") is True
    return {kind: sorted(found.values(), key=lambda row: row["label"].lower()) for kind, found in rows.items()}


# What the studio asks for, in the order a capability is preferred once the
# composer's attachments are known. A still attached to an image model means
# "edit this"; attached to a video model it means "start here".
_WANTED: dict[tuple[str, str], tuple[str, ...]] = {
    ("image", "none"): ("text-to-image",),
    ("image", "image"): ("image-to-image", "text-to-image"),
    ("video", "none"): ("text-to-video",),
    ("video", "image"): ("image-to-video", "text-to-video"),
    ("video", "video"): ("video-to-video", "image-to-video", "text-to-video"),
    ("video", "audio"): ("audio-to-video", "text-to-video"),
}


def hosted_route_for(model_id: str, *, kind: str, attached: str = "none") -> tuple[str, str]:
    """``(endpoint id, capability)`` for a consolidated row and what is attached.

    The picker's row is a MODEL (`flux-3`); the gateway wants an endpoint
    (`flux-3-image-to-video`). Which one depends on the composer, not on the
    row, which is the whole reason a row can carry several.

    Falls through to the row id itself when the catalogue cannot be read, so a
    momentarily unreachable service degrades to "send what the user picked"
    rather than to a refusal.
    """
    catalog, _live = cached_hosted_media_catalog()
    wanted = _WANTED.get((kind, attached), ("text-to-image",))
    if catalog is None:
        return str(model_id or "").strip().lower(), wanted[0]
    rows = consolidate_hosted_models(catalog["models"]).get(kind, [])
    row = next((item for item in rows if item["id"] == str(model_id or "").strip().lower()), None)
    if row is None:
        # Not a consolidated row: an endpoint id the caller already resolved
        # (an agent, a saved preset), which is a legitimate way to ask.
        return str(model_id or "").strip().lower(), ""
    for capability in wanted:
        if capability in row["routes"]:
            return str(row["routes"][capability]["model"]), capability
    # Nothing matches what is attached. Say which model and what it does
    # rather than letting the gateway answer with an unknown-model error.
    offered = ", ".join(sorted(row["routes"]))
    raise ValueError(f"{row['label']} cannot start from that input. It does: {offered}.")


# ── every price, known before anyone opens the picker ────────────────────────
#
# A price is a round trip and the gateway pays for it upstream (MUAPI is asked
# to estimate that exact request), so the picker cannot ask per row as you
# scroll — the numbers arrive one at a time and the list twitches for half a
# minute. They are warmed instead: all 135 image rows, sixteen at a time,
# which measured 17.9s on the live rail, once, into a file that survives a
# restart. The picker then reads them off the catalogue with the models.
#
# The warm also tells us something no other read can: 7 of the 135 CANNOT be
# priced, and a model the rail cannot price is one it cannot run either —
# `generate` goes through the same quoteForInput. They are free local tools
# (MUAPI `cost: 0.0`, and the gateway only routes a candidate whose upstream
# cost is above zero). Listing them is offering a press that can only fail, so
# media_catalog drops them.
#
# Image prices do not move with aspect ratio (measured: flux-3, nano-banana-2
# and ai-anime-generator all quote the same at 1:1, 16:9 and 9:16), so one
# warmed figure per endpoint is exact rather than indicative. Video prices DO
# move with duration and resolution — when that lane lands, its rows want the
# tilde.
_PRICE_TTL_SECONDS = 3600
_PRICE_WORKERS = 16
_PRICE_PAYLOAD = {"prompt": "a photograph", "aspect_ratio": "1:1"}
# The placeholder an image-to-* endpoint is priced with. The quote route never
# fetches it — it prices the endpoint, not the picture.
_PRICE_PLACEHOLDER = {"image": "image_url", "video": "video_url", "audio": "audio_url"}

_prices: dict[str, Any] = {"at": 0.0, "usd": {}, "refused": set()}
_price_lock = threading.Lock()
_warming = False


def price_cache_path() -> Path:
    """This install's cache folder — `app_dirs()`, not `load_config()`.

    `load_config()` returns a StudioConfig, which has no `cache_dir`; the
    first cut asked it for one inside a `try`, so every machine silently fell
    through to ~/.cache and CONTENT_STUDIO_CACHE_DIR did nothing. Worse, the
    test isolation that points CONTENT_STUDIO_DATA_DIR at a tmp folder was
    isolating nothing: the suite read the developer's own warmed prices off
    disk, which is precisely the machine-dependence it was written to stop.
    """
    from .config import app_dirs

    return Path(app_dirs().cache_dir) / "hosted-media-prices.json"


def _read_price_file() -> dict[str, Any]:
    try:
        held = json.loads(price_cache_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return held if isinstance(held, dict) else {}


def _load_price_cache() -> None:
    if _prices["usd"] or _prices["refused"]:
        return
    held = _read_price_file()
    _prices["usd"] = {str(k): float(v) for k, v in (held.get("usd") or {}).items() if isinstance(v, (int, float))}
    _prices["refused"] = {str(value) for value in (held.get("refused") or [])}
    _prices["at"] = float(held.get("at") or 0)


def _remembered_catalog() -> dict[str, Any] | None:
    """The last catalogue that answered, from a PREVIOUS run.

    Without it a boot whose first read is slow shows an empty Hivemind tab —
    the models are not a thing to approximate, and the studio knowing 135 of
    them yesterday is better evidence than a timeout today. Same rule as
    `_last_live_media_studio_models`, kept across restarts because this one
    is a network read rather than a file on this machine.
    """
    global _last_live_catalog
    if _last_live_catalog is not None:
        return _last_live_catalog
    held = _read_price_file().get("catalog")
    if not isinstance(held, dict) or not isinstance(held.get("models"), list):
        return None
    _last_live_catalog = held
    return held


def _save_price_cache() -> None:
    # Read before write, always. Two things share this file and they are
    # filled at different moments: the catalogue lands the instant the
    # gateway answers, the prices a minute later. Saving the catalogue from a
    # process whose prices had not been loaded yet wrote `usd: {}` over a good
    # file, and every row went back to having no number.
    _load_price_cache()
    path = price_cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "at": _prices["at"], "usd": _prices["usd"], "refused": sorted(_prices["refused"]),
            # The model list too, so a slow boot is not an empty picker.
            **({"catalog": _last_live_catalog} if _last_live_catalog else {}),
        }), encoding="utf-8")
    except OSError:
        # A cache file that cannot be written costs a warm on the next boot,
        # not a working studio.
        pass


def hosted_price_usd(endpoint: str) -> float | None:
    """The warmed price of one gateway endpoint, or None if unknown."""
    _load_price_cache()
    return _prices["usd"].get(str(endpoint or "").strip().lower())


def hosted_endpoint_refused(endpoint: str) -> bool:
    """Whether the rail answered "temporarily unavailable" for this endpoint —
    which means it cannot be generated either, not merely not priced."""
    _load_price_cache()
    return str(endpoint or "").strip().lower() in _prices["refused"]


def hosted_prices_are_fresh() -> bool:
    _load_price_cache()
    return bool(_prices["usd"]) and time.time() - _prices["at"] < _PRICE_TTL_SECONDS


def warm_hosted_media_prices(*, force: bool = False, kinds: tuple[str, ...] = ("image",)) -> dict[str, Any]:
    """Quote every consolidated row once, concurrently, and keep the answers.

    Safe to call from anywhere: one warm at a time, and a second caller gets
    the running one's result rather than a second sweep of the rail.
    """
    global _warming
    if not force and hosted_prices_are_fresh():
        return {"warmed": 0, "skipped": True, "priced": len(_prices["usd"]), "refused": len(_prices["refused"])}
    with _price_lock:
        if _warming:
            return {"warmed": 0, "running": True}
        _warming = True
    try:
        catalog, _live = cached_hosted_media_catalog(timeout=60)
        if catalog is None:
            return {"warmed": 0, "error": "the hosted media service did not answer"}
        rows = consolidate_hosted_models(catalog["models"])
        wanted: list[tuple[str, str]] = []
        for kind in kinds:
            for row in rows.get(kind, []):
                for capability, route in row["routes"].items():
                    wanted.append((str(route["model"]), CAPABILITY_INPUT.get(capability) or ""))
        usd: dict[str, float] = {}
        refused: set[str] = set()

        def ask(job: tuple[str, str]) -> None:
            endpoint, needs = job
            payload = dict(_PRICE_PAYLOAD)
            if needs and needs in _PRICE_PLACEHOLDER:
                payload[_PRICE_PLACEHOLDER[needs]] = "https://hivemindos.app/placeholder"
            try:
                quote = hosted_media_quote(model=endpoint, payload=payload, timeout=30)
            except RuntimeError as exc:
                # "temporarily unavailable" is the rail saying it has no route
                # for this model at all; anything else is a bad moment.
                if "unavailable" in str(exc).lower():
                    refused.add(endpoint)
                return
            price = _number(quote.get("priceUsd")) or _number(quote.get("retailUsd"))
            if price > 0:
                usd[endpoint] = price
            else:
                refused.add(endpoint)

        with ThreadPoolExecutor(max_workers=_PRICE_WORKERS) as pool:
            list(pool.map(ask, wanted))
        _prices["usd"] = {**_prices["usd"], **usd}
        _prices["refused"] = (_prices["refused"] - set(usd)) | refused
        _prices["at"] = time.time()
        _save_price_cache()
        return {"warmed": len(wanted), "priced": len(usd), "refused": len(refused)}
    finally:
        _warming = False


def warm_hosted_media_prices_in_background() -> None:
    """The startup hook. Never blocks a boot and never raises into one."""
    def run() -> None:
        try:
            warm_hosted_media_prices()
        except Exception:  # noqa: BLE001 - a cold price cache is not an outage
            pass
    threading.Thread(target=run, name="hosted-media-price-warm", daemon=True).start()


def hosted_media_status() -> dict[str, Any]:
    """Whether the rail can run something, and why not when it cannot.

    Three states, not two, because they have different repairs: the service
    itself being down, the service being up with no provider behind it, and
    the service being fine while this machine holds no credit token. The last
    one used to be reported as the first, so a studio with the app closed was
    told the route "did not answer" — and the picker, seeing an unavailable
    row, invented a missing-key sentence about a token that was present.
    """
    catalog, live = cached_hosted_media_catalog()
    if catalog is None:
        # Nothing known, here or in any earlier run. That is the only state
        # that is honestly "unreachable".
        return {"configured": True, "reachable": False, "detail": "The HivemindOS media service did not answer"}
    if not live:
        # A read that did not land is NOT an outage, and treating it as one
        # greyed out 128 working models over one slow second. The catalogue
        # read is the studio's most expensive call — the gateway fans out to
        # the upstream to build it — and on a cold boot it races the price
        # warm and loses, so the very first /api/simple/catalog after a
        # restart got `unreachable` and the browser kept that answer until
        # the page was reloaded.
        #
        # What is actually known: this list ran before, the prices are real,
        # and a press quotes the exact request before it spends — so a
        # service that IS down surfaces its own error, with its own remedy,
        # at the moment it matters. Offering the models is the truthful
        # reading; `registry_live` below already tells a client the list is
        # remembered rather than fresh.
        return {
            "configured": True, "reachable": True, "models": catalog["models"],
            "markup_bps": catalog["markup_bps"],
            "detail": "HivemindOS hosted media is ready (from the list it last published)",
        }
    if not catalog["configured"]:
        return {"configured": True, "reachable": False, "detail": "The HivemindOS media service has no provider connected right now"}
    if not _credit_token():
        return {
            "configured": False,
            "reachable": True,
            "detail": "Connect HivemindOS credits to run hosted models",
            "markup_bps": catalog["markup_bps"],
            "models": catalog["models"],
        }
    return {
        "configured": True,
        "reachable": True,
        "markup_bps": catalog["markup_bps"],
        "models": catalog["models"],
        "detail": "HivemindOS hosted media is ready",
    }


def hosted_media_quote(
    *, model: str, payload: dict[str, Any], timeout: float = 20,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    """The exact price of ONE request, from the provider's own live price.

    Public, and the only honest source of a number: 528 of the rail's 538
    models price dynamically, and the ten that do not still change with
    duration and resolution. A studio that printed a catalogue figure would be
    quoting the cheapest possible run of a model for a press that is not it.
    """
    answer = _post("quote", {"model": _model_id(model), "input": payload}, timeout=timeout, opener=opener)
    quote = answer.get("quote")
    if not isinstance(quote, dict):
        raise RuntimeError("The HivemindOS media service returned no quote")
    return quote


def upload_input(
    data: bytes, *, content_type: str, timeout: float = 120,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> str:
    """Put one starting picture, clip or voice line where a provider can fetch it.

    Every image-to-*, video-to-* and audio-to-video model upstream takes its
    starting media as a URL it fetches itself, and nothing on this machine has
    one: a provider's network cannot reach 127.0.0.1, and the studio's own
    media gateway is localhost by design. Without somewhere to put the file
    the hosted rail is text-to-* only, which is 176 of its 538 models.

    The bytes leave this machine in the clear, to our own Worker, which holds
    them under an unguessable name for a day. That is a real disclosure and
    the caller is expected to have asked — the same rule the MUAPI reference
    upload follows (``cloudReferenceUpload.js``).
    """
    kind = str(content_type or "").split(";")[0].strip().lower()
    if kind not in INPUT_CONTENT_TYPES:
        raise ValueError(f"{kind or 'that file type'} cannot be sent to a hosted model")
    if not data:
        raise ValueError("The reference file is empty")
    if len(data) > INPUT_MAX_BYTES:
        raise ValueError(f"A hosted reference must be {INPUT_MAX_BYTES // (1024 * 1024)} MB or smaller")
    token = _credit_token()
    if not token:
        raise RuntimeError("Connect HivemindOS credits before sending a reference to a hosted model")
    request = urllib.request.Request(
        _endpoint("/inputs"),
        data=data,
        method="POST",
        headers={**_headers(), "Content-Type": kind, "x-hivemindos-credit-token": token},
    )
    answer = _request_json(request, timeout=timeout, opener=opener)
    stored = answer.get("input") if isinstance(answer.get("input"), dict) else {}
    url = str(stored.get("url") or "")
    if not url.startswith("https://"):
        raise RuntimeError("The HivemindOS media service stored no reference URL")
    return url


def generate_hosted_media_asset(
    *,
    model: str,
    payload: dict[str, Any],
    output: str | Path,
    agent_id: str,
    maximum_debit_usd: float,
    idempotency_key: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
    sleeper: Callable[[float], None] = time.sleep,
    downloader: Callable[[str, Path], None] = _download,
    poll_interval_seconds: float = 5,
    max_polls: int = 180,
) -> dict[str, Any]:
    token = _credit_token()
    if not token:
        raise RuntimeError("Connect HivemindOS credits before running a hosted model")
    model_id = _model_id(model)
    bounded_agent_id = agent_id.strip()
    bounded_key = idempotency_key.strip()
    maximum = round(float(maximum_debit_usd), 6)
    if not model_id or not bounded_agent_id or not bounded_key:
        raise ValueError("Hosted media requires model, agent_id, and idempotency_key")
    if maximum <= 0 or maximum > 25:
        raise ValueError("Hosted media maximum_debit_usd must be greater than 0 and no more than 25")
    if not isinstance(payload, dict) or not payload:
        raise ValueError("Hosted media payload must be a non-empty object")

    quote = _post("quote", {"model": model_id, "input": payload}, opener=opener).get("quote")
    if not isinstance(quote, dict):
        raise RuntimeError("HivemindOS hosted media returned no quote")
    # The gateway names the customer price `priceUsd` on the quote route and
    # `retailUsd` on the job's billing block. Same number, two spellings, and
    # reading only one of them is how a priced model looked unpriced.
    retail_usd = _number(quote.get("retailUsd")) or _number(quote.get("priceUsd"))
    if retail_usd <= 0:
        raise RuntimeError("HivemindOS hosted media returned an invalid retail quote")
    if retail_usd > maximum + 1e-9:
        raise ValueError(f"Hosted media quote ${retail_usd:.6f} exceeds the approved maximum ${maximum:.6f}")

    submitted = _post(
        "generate",
        {"model": model_id, "input": payload, "maximumDebitUsd": maximum},
        headers={"idempotency-key": bounded_key, "x-hivemindos-credit-token": token},
        opener=opener,
    )
    job = submitted.get("job")
    if not isinstance(job, dict) or not str(job.get("id") or "").strip():
        raise RuntimeError("HivemindOS hosted media returned no job id")
    job_id = str(job["id"]).strip()

    terminal = submitted
    for _ in range(max_polls):
        current = terminal.get("job") if isinstance(terminal.get("job"), dict) else {}
        status = str(current.get("status") or "").lower()
        if status == "finalized":
            break
        if status in TERMINAL_FAILURES:
            raise RuntimeError(f"HivemindOS hosted media job failed with status {status}")
        sleeper(max(0.1, poll_interval_seconds))
        terminal = _job(job_id, token=token, opener=opener)
    else:
        raise TimeoutError("HivemindOS hosted media job did not finish before the poll limit")

    finished_job = terminal.get("job") if isinstance(terminal.get("job"), dict) else {}
    outputs = finished_job.get("outputs") if isinstance(finished_job.get("outputs"), list) else []
    source_url = next((str(value) for value in outputs if isinstance(value, str) and value.startswith("https://")), "")
    if not source_url:
        raise RuntimeError("HivemindOS hosted media job returned no public output URL")
    destination = Path(output).expanduser().resolve()
    downloader(source_url, destination)
    if not destination.is_file() or destination.stat().st_size == 0:
        raise RuntimeError("HivemindOS hosted media download was empty")
    billing = finished_job.get("billing") if isinstance(finished_job.get("billing"), dict) else submitted.get("billing")
    return {
        "provider": "hivemindos-hosted-media",
        "model": model_id,
        "job_id": job_id,
        "output": str(destination),
        "source_url": source_url,
        "billing": billing if isinstance(billing, dict) else {},
    }


def _post(
    path: str, payload: dict[str, Any], *,
    headers: dict[str, str] | None = None,
    timeout: float = 120,
    opener: Callable[..., Any],
) -> dict[str, Any]:
    request = urllib.request.Request(
        _endpoint(f"/{path}"),
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={**_headers(), "Content-Type": "application/json", **(headers or {})},
    )
    return _request_json(request, timeout=timeout, opener=opener)


def _job(job_id: str, *, token: str, opener: Callable[..., Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        _endpoint(f"/jobs/{urllib.parse.quote(job_id, safe='')}"),
        method="GET",
        headers={**_headers(), "x-hivemindos-credit-token": token},
    )
    return _request_json(request, timeout=60, opener=opener)


def _request_json(request: urllib.request.Request, *, timeout: int, opener: Callable[..., Any]) -> dict[str, Any]:
    try:
        with opener(request, timeout=timeout) as response:
            value = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("error")
        except (json.JSONDecodeError, AttributeError):
            detail = None
        raise RuntimeError(str(detail or f"HivemindOS hosted media returned HTTP {exc.code}")) from None
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        raise RuntimeError("HivemindOS hosted media request failed") from exc
    if not isinstance(value, dict):
        raise RuntimeError("HivemindOS hosted media returned an invalid JSON response")
    if value.get("ok") is not True:
        raise RuntimeError(str(value.get("error") or "HivemindOS hosted media request failed"))
    return value


def _endpoint(suffix: str = "") -> str:
    # Deferred: hivemindos_models imports THIS module for the device token, so
    # naming it at import time would close the cycle.
    from .hivemindos_models import gateway_url

    return f"{gateway_url()}{MANAGED_MEDIA_PATH}{suffix}"


def _headers() -> dict[str, str]:
    # Cloudflare 403s urllib's default agent with "blocked access based on your
    # browser's signature", which reads like an outage. Same constant the text
    # rail sends.
    from .hivemindos_models import USER_AGENT

    return {"Accept": "application/json", "User-Agent": USER_AGENT}


def _credit_token() -> str:
    """The HivemindOS credit key this machine spends, app or no app."""
    from .hivemindos_models import credit_token

    try:
        return credit_token()
    except Exception:  # noqa: BLE001 - a vault this studio cannot read is not a crash
        return ""


def _model_id(model: str) -> str:
    return str(model or "").strip().lower()


def _dashboard_token() -> str:
    """The device token, from the process, then HivemindOS's own file, then PassBook.

    The last step used to hand-parse `~/.hivemindos/.env` with `_env_file_value`,
    which is the machine's PassBook store — and reading it that way is wrong in a
    specific, silent way. PassBook writes an encrypted value as the literal text
    `hive-sealed:<ciphertext>`, so on a sealed store a line-splitting reader does
    not come back empty: it comes back with the ciphertext, which is a non-empty
    string, so it wins the loop and is sent as the device token. The dashboard
    then answers "unauthorised" and nothing anywhere names the real cause.

    Asking PassBook instead gets the value decrypted by the broker, scoped to the
    workspace that is asking, and recorded. The files above it stay hand-read on
    purpose: they belong to the HivemindOS project, not to this machine's store.
    """
    direct = os.environ.get("HIVEMINDOS_DASHBOARD_DEVICE_TOKEN", "").strip()
    if direct:
        return direct
    root = Path(__file__).resolve().parents[2]
    configured_root = os.environ.get("HIVEMINDOS_PROJECT_ROOT", "").strip()
    candidates = [
        Path(os.environ["HIVEMINDOS_ENV_FILE"]).expanduser() if os.environ.get("HIVEMINDOS_ENV_FILE") else None,
        Path(configured_root).expanduser() / ".env.local" if configured_root else None,
        root.parent / "hivemind-os" / ".env.local",
    ]
    for candidate in candidates:
        if candidate is None:
            continue
        value = _env_file_value(candidate, "HIVEMINDOS_DASHBOARD_DEVICE_TOKEN")
        if value:
            return value

    from .shared_env import request_credential

    return request_credential(
        "HIVEMINDOS_DASHBOARD_DEVICE_TOKEN", reason="HivemindOS hosted media"
    ).strip()


def _env_file_value(path: Path, key: str) -> str:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    prefix = f"{key}="
    for line in lines:
        if not line.startswith(prefix):
            continue
        raw = line[len(prefix) :].strip()
        if not raw:
            return ""
        try:
            values = shlex.split(raw, comments=True, posix=True)
        except ValueError:
            return ""
        return values[0].strip() if len(values) == 1 else ""
    return ""


def _number(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number
