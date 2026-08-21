"""Hook and caption generation for rendered clips.

Adapted from zhouxiaoka/autoclip's `backend/pipeline/step4_title.py` (MIT): one
batched call keyed by clip id, the raw response persisted before parsing, and a
fail-open path that keeps every clip when the model returns something unusable.

The donor returns `{id: "title"}`. We ask for `{id: {hook, caption}}` in the same
call, because the caption is the thing this repo actually publishes — before this
module existed, every Postiz post went out with a raw transcript fragment as its
body.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from . import db
from .config import Config
from .llm import Caller, LlmUnavailable, resolve_caller
from .llm_json import LlmJsonError, parse_object
from .prompts import TITLE, load_prompt
from .rerank import BATCH_SIZE, EXCERPT_LIMIT, batches, dump_raw

logger = logging.getLogger(__name__)

HOOK_LIMIT = 90
CAPTION_LIMIT = 280


def _payload_for(clip: Any) -> dict[str, Any]:
    """Transcript only.

    The donor also feeds its `recommend_reason` into this step, because it is
    writing titles from an outline and needs the extra signal. We send the
    transcript itself, so the critique adds nothing — and it actively harms the
    output: on a real run against a local 4B, passing the reviewer-facing reason
    made the model write a *review* of a weak clip ("No specific numbers, no
    decision point") into the caption field, which would have shipped as the post
    body. The score leaks the same way. Neither is sent.
    """
    excerpt = clip["transcript_excerpt"] or clip["rationale"] or ""
    return {
        "id": clip["slug"],
        "transcript": str(excerpt)[:EXCERPT_LIMIT],
    }


def _clean(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split()).strip().strip('"')
    if not text:
        return None
    return text[:limit]


def generate_titles(
    conn,
    cfg: Config,
    run_id: int,
    *,
    category: str | None = None,
    output_dir: Path | None = None,
    caller: Caller | None = None,
) -> dict[str, Any]:
    """Write a hook and caption onto every clip on a run. Never raises."""
    clips = db.list_clips(conn, run_id)
    if not clips:
        return {"status": "skipped", "written": 0, "total": 0, "error": "run has no clips"}

    try:
        prompt = load_prompt(cfg, TITLE, category)
    except Exception as exc:
        logger.warning("title prompt unavailable for run %s: %s", run_id, exc)
        return {"status": "failed", "written": 0, "total": len(clips), "error": str(exc)}

    call = resolve_caller(caller)
    by_slug = {str(clip["slug"]): clip for clip in clips}
    written = 0
    errors: list[str] = []

    for index, batch in enumerate(batches(list(clips), BATCH_SIZE), start=1):
        payload = [_payload_for(clip) for clip in batch]
        try:
            raw = call(prompt, payload)
        except LlmUnavailable as exc:
            errors.append(str(exc))
            break
        except Exception as exc:  # pragma: no cover - provider-specific failures
            errors.append(f"batch {index}: {exc}")
            continue

        dump_raw(output_dir, f"title-batch-{index:02d}.txt", raw)

        try:
            results = parse_object(raw)
        except LlmJsonError as exc:
            errors.append(f"batch {index}: {exc}")
            continue

        for slug, value in results.items():
            clip = by_slug.get(str(slug).strip())
            if clip is None:
                errors.append(f"batch {index}: unknown id {slug!r}")
                continue
            # A model that ignores the object contract and returns a bare string
            # has still done the useful half of the job.
            if isinstance(value, str):
                hook, caption = _clean(value, HOOK_LIMIT), None
            elif isinstance(value, dict):
                hook = _clean(value.get("hook") or value.get("title"), HOOK_LIMIT)
                caption = _clean(value.get("caption"), CAPTION_LIMIT)
            else:
                errors.append(f"batch {index}: {slug} returned {type(value).__name__}")
                continue
            if hook is None and caption is None:
                errors.append(f"batch {index}: {slug} returned no usable text")
                continue
            db.set_clip_semantics(conn, int(clip["id"]), hook_title=hook, caption=caption)
            written += 1

    status = "ok" if written and not errors else ("partial" if written else "failed")
    error_text = "; ".join(errors)[:2000] or None
    if errors:
        logger.warning("titles run %s finished %s: %s", run_id, status, error_text)
    return {"status": status, "written": written, "total": len(clips), "error": error_text}


def caption_for_clip(clip: Any) -> str:
    """The text a post ships with.

    Precedence is generated caption, then generated hook, then the pre-LLM
    behaviour. The tail of this chain is what shipped before this module existed,
    so a run with no LLM produces exactly what it always did.
    """
    for key in ("caption", "hook_title", "transcript_excerpt", "rationale"):
        try:
            value = clip[key]
        except (IndexError, KeyError):
            continue
        if value:
            return str(value)
    return "Approved clip"
