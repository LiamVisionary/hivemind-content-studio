"""LLM re-rank of rendered clip candidates.

Adapted from zhouxiaoka/autoclip's `backend/pipeline/step3_scoring.py` (MIT):
batch the candidates into one call instead of one call per clip, ask for a score
plus a reviewer-facing reason, and merge both back onto the original rows.

Two deliberate departures from the donor:

1. **It ranks, it never deletes.** The donor drops everything under
   `MIN_SCORE_THRESHOLD` before the next step ever sees it. We keep every
   rendered clip. The score only orders them, because the approval gate is the
   single place anything is filtered out of this pipeline — that gate is what
   keeps public creator material research-only.
2. **Results are matched by id, not by position.** The donor requires
   `len(parsed) == len(clips)` and discards the whole batch on a mismatch, which
   loses good scores because one item came back malformed. We match on the id we
   sent and leave anything unmatched unscored.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from . import db
from .config import Config
from .llm import Caller, LlmUnavailable, resolve_caller
from .llm_json import LlmJsonError, parse_list
from .prompts import RERANK, load_prompt

logger = logging.getLogger(__name__)

# One call per this many candidates. A default render is `--top 5`, so most runs
# are a single call; the batch exists so a large `--top` cannot blow the context.
BATCH_SIZE = 8

# Transcript characters sent per candidate. Enough to judge a 30-90s clip
# without paying for the whole episode in every batch.
EXCERPT_LIMIT = 1200


def _timestamp(seconds: float | None) -> str | None:
    if seconds is None:
        return None
    total = int(seconds)
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def _payload_for(clip: Any) -> dict[str, Any]:
    excerpt = clip["transcript_excerpt"] or clip["rationale"] or ""
    return {
        "id": clip["slug"],
        "start_seconds": clip["start_seconds"],
        "end_time": _timestamp(clip["end_seconds"]),
        "transcript": str(excerpt)[:EXCERPT_LIMIT],
    }


def _coerce_score(value: Any) -> float | None:
    try:
        score = float(value)
    except (TypeError, ValueError):
        return None
    # The prompt asks for 0.0-1.0. A model that answers on a 0-10 or 0-100 scale
    # is answering the right question in the wrong unit, so rescale rather than
    # discard — but only from the unambiguous ranges.
    if 1.0 < score <= 10.0:
        score = score / 10.0
    elif 10.0 < score <= 100.0:
        score = score / 100.0
    return max(0.0, min(1.0, score))


def batches(items: list[Any], size: int) -> list[list[Any]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def rerank_run(
    conn,
    cfg: Config,
    run_id: int,
    *,
    category: str | None = None,
    output_dir: Path | None = None,
    caller: Caller | None = None,
) -> dict[str, Any]:
    """Score every clip on a run. Never raises — a dead LLM costs us nothing.

    Returns a summary dict describing what happened, so the caller can log it
    without re-querying.
    """
    clips = db.list_clips(conn, run_id)
    if not clips:
        db.set_run_semantics(conn, run_id, "skipped", "run has no clips")
        return {"status": "skipped", "scored": 0, "total": 0, "error": "run has no clips"}

    try:
        prompt = load_prompt(cfg, RERANK, category)
    except Exception as exc:
        logger.warning("rerank prompt unavailable for run %s: %s", run_id, exc)
        db.set_run_semantics(conn, run_id, "failed", str(exc))
        return {"status": "failed", "scored": 0, "total": len(clips), "error": str(exc)}

    call = resolve_caller(caller)
    by_slug = {str(clip["slug"]): clip for clip in clips}
    scored = 0
    errors: list[str] = []

    for index, batch in enumerate(batches(list(clips), BATCH_SIZE), start=1):
        payload = [_payload_for(clip) for clip in batch]
        try:
            raw = call(prompt, payload)
        except LlmUnavailable as exc:
            # No model at all: stop early, the next batch will not fare better.
            errors.append(str(exc))
            break
        except Exception as exc:  # pragma: no cover - provider-specific failures
            errors.append(f"batch {index}: {exc}")
            continue

        dump_raw(output_dir, f"rerank-batch-{index:02d}.txt", raw)

        try:
            results = parse_list(raw)
        except LlmJsonError as exc:
            errors.append(f"batch {index}: {exc}")
            continue

        for result in results:
            slug = str(result.get("id") or "").strip()
            clip = by_slug.get(slug)
            if clip is None:
                errors.append(f"batch {index}: unknown id {slug!r}")
                continue
            score = _coerce_score(result.get("score"))
            reason = result.get("reason")
            if score is None:
                errors.append(f"batch {index}: {slug} returned no usable score")
                continue
            db.set_clip_semantics(
                conn,
                int(clip["id"]),
                llm_score=score,
                llm_reason=str(reason) if reason else None,
            )
            scored += 1

    status = "ok" if scored and not errors else ("partial" if scored else "failed")
    error_text = "; ".join(errors)[:2000] or None
    db.set_run_semantics(conn, run_id, status, error_text)
    if errors:
        logger.warning("rerank run %s finished %s: %s", run_id, status, error_text)
    return {"status": status, "scored": scored, "total": len(clips), "error": error_text}


def dump_raw(output_dir: Path | None, name: str, text: str) -> None:
    """Persist the raw response before parsing.

    Adapted from the donor's `step4_llm_raw_output/`. It is the only way to
    debug a bad batch after the fact, and it lands inside the run's output
    directory, which is already within the sealed-media boundary.
    """
    if output_dir is None:
        return
    try:
        target = Path(output_dir) / "llm"
        target.mkdir(parents=True, exist_ok=True)
        (target / name).write_text(text, encoding="utf-8")
    except OSError as exc:  # pragma: no cover - disk failures are not fatal here
        logger.debug("could not write raw LLM response %s: %s", name, exc)


def ranked_clips(conn, run_id: int) -> list[Any]:
    """Clips ordered best-first, with unscored clips last in render order."""
    clips = db.list_clips(conn, run_id)
    return sorted(
        clips,
        key=lambda clip: (
            clip["llm_score"] is None,
            -(clip["llm_score"] or 0.0),
            int(clip["id"]),
        ),
    )
