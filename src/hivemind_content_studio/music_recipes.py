"""Music recipes: how tracks in a style are conventionally built, and which one fits.

Two halves, and only one of them ever leaves the machine.

THE LIBRARY is static data (`catalog/music_recipes.json`): per style, the order
of its sections, a typical tempo, its time signature and whether it leans major
or minor. It was compiled ONCE, offline, from the arrangement craft in
jtydhr88/music-composition-skills (MIT) plus general musical knowledge, because
that craft takes a frontier model twenty minutes a song to apply and the
composer has about half a second. Browsing it and applying a recipe by hand is
entirely local.

THE PICK is a typed decision: a decision model (TypeSafe's Jev) reads the style
line and answers one closed question — which of these recipes is this? — with a
probability per recipe rather than text. It cannot write a lyric or an
arrangement and is not asked to; it chooses among ours. Measured 2026-09-18
through `suggest()` itself, 45 recipes to choose from: 25 of 25 labelled style
lines matched first, 24 applied and all 24 right, ~1.0 s median, ~$0.0001 a call.

WHY THE PICK IS OPT-IN AND NEVER AUTOMATIC. The decision model is hosted-only —
its weights are not published — and everything else in the Music studio runs on
this machine, with the style line treated as privately as a prompt. So the pick
runs only on an explicit press, sends the style line and nothing else (never
lyrics, never a seed or a model id), and goes out on the owner's OWN OpenRouter
account from the shared credential store. The browser states all of that before
the first press; this module is what makes the statement true.

WHAT CONFIDENCE IS FOR. The model's confidence carries information (measured in
HivemindOS: >= 0.90 covered 80% of a labelled set at 97.6%), so a confident pick
is applied with a one-line receipt and an undo, and a spread is handed back as
the top few options for the person to choose between. A Choice cannot say "none
of these", which is exactly why a low-confidence answer is never applied.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

from . import provider_models

LIBRARY_PATH = Path(__file__).with_name("catalog") / "music_recipes.json"

# The six names the instrumental YuE2 lane's LoRA was trained on. A recipe may
# use no other: the composer sends a section plan built from these verbatim.
SECTION_TAGS = ("intro", "verse", "pre-chorus", "chorus", "bridge", "outro")

# Pinned, never the `-latest` alias: the threshold below was read off THIS
# version's confidence, and an alias that moves would move it silently.
DECISION_MODEL = "typesafe/jev-1.13"
# OpenRouter serves decision models on an alpha path outside /api/v1 and outside
# its public model list (verified live 2026-09-18). If it moves, change it here.
DECISION_URL = "https://openrouter.ai/api/alpha/decisions"
DECISION_KEY = "OPENROUTER_API_KEY"
# One-question calls measured 0.4-1.2 s from this machine. Past this the person
# is better served by the list than by a longer wait for a pick.
DECISION_TIMEOUT_S = 6.0
# At or above this the pick is applied; below it the top options are offered.
# Read off the live run of 2026-09-18 (28 style lines through this function, 45
# recipes): all 24 applied matches scored 1.00, while the one-word line "heavy"
# came back `metal` at 0.85 and a deliberately mixed line at 0.78 — so 0.8 would
# have applied a guess and 0.9 applies none. It is also the band HivemindOS
# measured as most reliable for this model version. In-sample on a small set;
# an undo sits beside every applied pick for exactly that reason.
CONFIDENT = 0.9
# How many options a spread hands back. Three is what fits as buttons.
ALTERNATIVES = 3
# A style line is a tag list. Anything longer is somebody pasting a document
# into the wrong box, and the decision model gets less accurate as state grows.
MAX_STYLE_CHARS = 600

# What the browser shows before the first press, served from here so the
# sentence and the behaviour cannot drift apart.
DISCLOSURE = {
    "sends": "your style line",
    "never_sends": "your lyrics, your settings, or anything you have made",
    "to": "TypeSafe's Jev decision model, through your own OpenRouter account",
    "model": DECISION_MODEL,
}


class MusicRecipeError(RuntimeError):
    """A refusal a person can act on: `remedy` names the repair."""

    def __init__(self, message: str, *, remedy: str = "", status: int = 400) -> None:
        super().__init__(message)
        self.remedy = remedy
        self.status = status


@lru_cache(maxsize=1)
def library() -> dict[str, Any]:
    """The recipe library, validated once at first read.

    Validation is strict on purpose: a recipe with a section name the LoRA was
    never shown would reach the model as exactly the untrained input the section
    builder exists to keep out, and it would do so silently.
    """
    data = json.loads(LIBRARY_PATH.read_text(encoding="utf-8"))
    recipes = data.get("recipes")
    if not isinstance(recipes, list) or not recipes:
        raise ValueError("music_recipes.json holds no recipes")
    seen: set[str] = set()
    for recipe in recipes:
        rid = str(recipe.get("id") or "")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", rid) or rid in seen:
            raise ValueError(f"bad or duplicate recipe id: {rid!r}")
        seen.add(rid)
        if not str(recipe.get("label") or "").strip() or not str(recipe.get("describes") or "").strip():
            raise ValueError(f"{rid}: a recipe needs a label and a `describes` line")
        sections = recipe.get("sections")
        if not isinstance(sections, list) or any(tag not in SECTION_TAGS for tag in sections):
            raise ValueError(f"{rid}: sections may only use {', '.join(SECTION_TAGS)}")
        bpm = recipe.get("bpm")
        if bpm is not None and not (30 <= int(bpm) <= 240):
            raise ValueError(f"{rid}: bpm {bpm} is outside 30-240")
    return data


def recipes() -> list[dict[str, Any]]:
    return list(library()["recipes"])


def recipe_by_id(recipe_id: str) -> dict[str, Any] | None:
    return next((row for row in recipes() if row["id"] == recipe_id), None)


def suggest_available() -> bool:
    """Is the owner's OpenRouter account connected? By NAME, never by value."""
    return DECISION_KEY in provider_models.stored_names()


def catalog_payload() -> dict[str, Any]:
    """What the composer needs to render the library and the Suggest door."""
    data = library()
    return {
        "ok": True,
        "recipes": recipes(),
        "families": list(data.get("families") or []),
        "provenance": data.get("provenance") or {},
        "suggest": {
            "available": suggest_available(),
            "needs": DECISION_KEY,
            "confident": CONFIDENT,
            "disclosure": DISCLOSURE,
        },
    }


_EXPLICIT_BPM = re.compile(r"(?<![\d.])(\d{2,3})\s*bpm\b", re.IGNORECASE)


def explicit_bpm(style: str) -> int | None:
    """A tempo the person TYPED outranks any recipe's typical one.

    Read with a regex rather than asked of the model: a decision model cannot
    count or compare numbers, and this is a number sitting in plain sight.
    """
    match = _EXPLICIT_BPM.search(style or "")
    if not match:
        return None
    bpm = int(match.group(1))
    return bpm if 30 <= bpm <= 240 else None


def _question() -> dict[str, Any]:
    return {
        "recipe": {
            "type": "choice",
            "instructions": (
                "Which of these musical styles is the closest match for the track this "
                "style description asks for?"
            ),
            "criteria": {row["id"]: row["describes"] for row in recipes()},
        }
    }


def _error_detail(exc: urllib.error.HTTPError) -> str:
    try:
        body = json.loads(exc.read().decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001 — an unreadable body is just a status code
        return f"HTTP {exc.code}"
    error = body.get("error") if isinstance(body, dict) else None
    message = error.get("message") if isinstance(error, dict) else error
    return f"HTTP {exc.code}: {message}" if message else f"HTTP {exc.code}"


def suggest(style: str, *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Ask the decision model which recipe fits `style`. One call, no retry.

    A failed call is a refusal with a reason, never a guess: the library is
    still on screen, and a recipe picked by a fallback heuristic would arrive
    looking exactly like one the model was confident about.
    """
    style = " ".join(str(style or "").split())
    if not style:
        raise MusicRecipeError("Describe the sound first — the style line is what gets matched.")
    if len(style) > MAX_STYLE_CHARS:
        raise MusicRecipeError(
            f"That style line is {len(style)} characters; the match reads up to {MAX_STYLE_CHARS}. "
            "Trim it to the genre, instruments and mood.")
    if not suggest_available():
        raise MusicRecipeError(
            "Suggest uses your own OpenRouter account, and this machine has none connected. "
            "You can still pick a recipe from the list.",
            remedy="connect-openrouter", status=409)
    key = provider_models.credential(DECISION_KEY, reason="music structure suggestion")
    if not key:
        raise MusicRecipeError(
            "Your OpenRouter key is in the shared store but could not be opened — if the vault is "
            "locked, sign in to PassBook. You can still pick a recipe from the list.",
            remedy="passbook-signin", status=409)

    body = json.dumps({
        "model": DECISION_MODEL,
        # The style line and nothing else. No lyrics, no seed, no model id.
        "state": {"style_description": style},
        "questions": _question(),
    }).encode("utf-8")
    request = urllib.request.Request(
        DECISION_URL, data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    started = time.monotonic()
    try:
        with opener(request, timeout=DECISION_TIMEOUT_S) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise MusicRecipeError(
            f"The decision model refused the request ({_error_detail(exc)}). "
            "You can still pick a recipe from the list.", status=502) from exc
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise MusicRecipeError(
            "The decision model did not answer in time. You can still pick a recipe from the list.",
            status=504) from exc
    latency_ms = round((time.monotonic() - started) * 1000)

    answer = ((payload or {}).get("answers") or {}).get("recipe") or {}
    chosen = recipe_by_id(str(answer.get("choice") or ""))
    try:
        confidence = float(answer.get("confidence"))
    except (TypeError, ValueError):
        confidence = -1.0
    if chosen is None or not 0.0 <= confidence <= 1.0:
        raise MusicRecipeError(
            "The decision model answered in a shape this studio does not recognise. "
            "You can still pick a recipe from the list.", status=502)

    probabilities = answer.get("probabilities") if isinstance(answer.get("probabilities"), dict) else {}
    ranked = sorted(
        ((rid, float(p)) for rid, p in probabilities.items()
         if recipe_by_id(rid) is not None and isinstance(p, (int, float))),
        key=lambda item: item[1], reverse=True,
    )
    alternatives = [{"id": rid, "probability": round(p, 4)} for rid, p in ranked[:ALTERNATIVES]]
    if chosen["id"] not in {row["id"] for row in alternatives}:
        alternatives = [{"id": chosen["id"], "probability": round(confidence, 4)}] + alternatives[:ALTERNATIVES - 1]

    usage = (payload or {}).get("usage") or {}
    cost = usage.get("cost")
    return {
        "ok": True,
        "recipe": chosen["id"],
        "confidence": round(confidence, 4),
        "confident": confidence >= CONFIDENT,
        "alternatives": alternatives,
        "explicit_bpm": explicit_bpm(style),
        "model": str((payload or {}).get("model") or DECISION_MODEL),
        "latency_ms": latency_ms,
        "cost_usd": float(cost) if isinstance(cost, (int, float)) else None,
    }
