"""The persona autopilot: one recurring character, a day of posts at a time.

A day is: read what is working (trend notes and the persona's own measured
posts), write N hooks with a caption and one consistent shot each, and open a
``persona-series`` run per post. Each run then moves through the ordinary
pipeline — keyframe, motion, assembly, evaluation — and stops where every run
stops: at a person's review. Nothing here publishes, and nothing here can.

What this module deliberately does not do is fetch trends or charge for the
day. Trend notes are an input: an agent gathers them with whatever it has
(HivemindOS X discovery, ``reddit-voc``, a research run), which are already
metered where they are hosted, or a person types them. That keeps the studio
usable standalone, with a local text model, for free.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import yaml

from . import story_producer
from .config import StudioConfig, load_config
from .manifest import load_manifest, utc_now
from .metrics import summarize_metrics
from .private_access import read_private_text, write_private_text

_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
MAX_POSTS_PER_DAY = 6
DEFAULT_CLIP_SECONDS = 10


class PersonaError(ValueError):
    """A persona problem in words the owner can act on."""


# ---------------------------------------------------------------------------
# The persona store
# ---------------------------------------------------------------------------

def personas_dir(cfg: StudioConfig | None = None) -> Path:
    return (cfg or load_config()).data_dir / "personas"


def _persona_path(persona_id: str, cfg: StudioConfig | None = None) -> Path:
    if not _ID.match(persona_id or ""):
        raise PersonaError("A persona id is lowercase letters, digits, - or _, up to 64 characters.")
    return personas_dir(cfg) / f"{persona_id}.json"


def save_persona(persona: dict[str, Any], *, cfg: StudioConfig | None = None) -> dict[str, Any]:
    """Validate and store one persona. Stored private, like every brief."""
    persona_id = str(persona.get("id") or "").strip().lower()
    path = _persona_path(persona_id, cfg)
    name = str(persona.get("name") or "").strip()
    appearance = str(persona.get("appearance") or "").strip()
    references = [str(item).strip() for item in persona.get("references") or [] if str(item).strip()]
    if not name:
        raise PersonaError("A persona needs a name.")
    if not appearance and not references:
        raise PersonaError("A persona needs an appearance or reference pictures; a name alone cannot keep a character consistent.")
    platforms = sorted({str(item).strip().lower() for item in persona.get("platforms") or [] if str(item).strip()})
    if not platforms:
        raise PersonaError("Name at least one platform this persona posts to.")
    posts_per_day = int(persona.get("posts_per_day") or 3)
    if not 1 <= posts_per_day <= MAX_POSTS_PER_DAY:
        raise PersonaError(f"posts_per_day must be between 1 and {MAX_POSTS_PER_DAY}.")
    review_in = str(persona.get("review_in") or "studio").strip().lower()
    if review_in not in {"studio", "hivemindos"}:
        raise PersonaError("review_in must be studio or hivemindos.")
    record = {
        "id": persona_id,
        "name": name,
        "appearance": appearance,
        "references": references,
        "niche": str(persona.get("niche") or "").strip(),
        "voice": str(persona.get("voice") or "").strip(),
        "platforms": platforms,
        "accounts": {str(key).strip().lower(): str(value).strip() for key, value in (persona.get("accounts") or {}).items() if str(value).strip()},
        "posts_per_day": posts_per_day,
        # Where a finished clip is reviewed. "hivemindos" is the owner's standing
        # instruction that this persona's renders may be exported, unencrypted,
        # to the HivemindOS Socials queue for review (posting_rails.export_for_handoff).
        "review_in": review_in,
        # A synthetic person presented as real gets accounts restricted; labelled is the default.
        "disclosed_as_ai": persona.get("disclosed_as_ai") is not False,
        "aspect_ratio": str(persona.get("aspect_ratio") or "9:16"),
        "clip_seconds": int(persona.get("clip_seconds") or DEFAULT_CLIP_SECONDS),
        "runs": [str(item) for item in persona.get("runs") or []][-200:],
        "updated_at": utc_now(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    write_private_text(path, json.dumps(record, indent=2, sort_keys=True) + "\n")
    return record


def load_persona(persona_id: str, *, cfg: StudioConfig | None = None) -> dict[str, Any]:
    path = _persona_path(persona_id.strip().lower(), cfg)
    try:
        return json.loads(read_private_text(path))
    except FileNotFoundError:
        raise PersonaError(f"No persona named {persona_id}. Create it with `persona save` first.") from None


def list_personas(*, cfg: StudioConfig | None = None) -> list[dict[str, Any]]:
    root = personas_dir(cfg)
    if not root.is_dir():
        return []
    found = []
    for path in sorted(root.glob("*.json")):
        if _ID.match(path.stem):
            found.append(load_persona(path.stem, cfg=cfg))
    return found


# ---------------------------------------------------------------------------
# What has worked so far
# ---------------------------------------------------------------------------

def persona_scoreboard(persona: dict[str, Any], *, limit: int = 12) -> list[dict[str, Any]]:
    """The persona's measured posts, best first, as evidence for the next day's hooks."""
    rows = []
    for manifest_path in persona.get("runs") or []:
        try:
            manifest = load_manifest(manifest_path)
            totals = summarize_metrics(manifest_path)["totals"]
        except Exception:  # noqa: BLE001 - a run deleted since is not a reason to stop planning
            continue
        if not totals["views"]:
            continue
        hook = str((manifest.get("brief") or {}).get("hook") or (manifest.get("brief") or {}).get("title") or "")
        rows.append({"hook": hook, "views": totals["views"], "click_through_rate": round(totals["click_through_rate"], 4)})
    return sorted(rows, key=lambda row: row["views"], reverse=True)[:limit]


# ---------------------------------------------------------------------------
# The day plan
# ---------------------------------------------------------------------------

def _check_day(payload: Any) -> None:
    rows = story_producer._require_list(payload, "posts", minimum=1)
    story_producer._require_fields(rows, ("hook", "caption", "image_prompt", "motion_prompt"), label="post")


DAY_TASK = story_producer.Task(
    id="persona_day",
    instruction=(
        "Plan one day of short vertical clips for a recurring character. Every clip is ONE "
        "continuous shot of the same character, so describe what they are doing and where, never "
        "who they are — their appearance is fixed elsewhere and must not be restated or changed. For each "
        "post write: a hook (the first line a viewer reads, under 12 words, no clickbait "
        "superlatives), a caption in the persona's voice, an image_prompt for the still first "
        "frame (setting, action, framing, light), and a motion_prompt for what happens over the "
        "clip. Lean on what the evidence says has worked; vary setting and action between posts."
    ),
    schema='{"posts": [{"hook": "", "caption": "", "image_prompt": "", "motion_prompt": "", "hashtags": [""], "why": ""}]}',
    check=_check_day,
    max_tokens=3000,
    list_key="posts",
)
story_producer.TASKS.setdefault(DAY_TASK.id, DAY_TASK)


def plan_persona_day(
    persona_id: str,
    *,
    trend_notes: str = "",
    count: int | None = None,
    model_id: str = "",
    runtime: Any | None = None,
    cfg: StudioConfig | None = None,
) -> dict[str, Any]:
    """Ask the text model for the day's posts. Returns them; starts nothing."""
    persona = load_persona(persona_id, cfg=cfg)
    wanted = max(1, min(MAX_POSTS_PER_DAY, int(count or persona["posts_per_day"])))
    if not model_id:
        from . import text_models

        model_id = str(text_models.catalog().get("defaultModelId") or "")
        if not model_id:
            raise PersonaError("No text model is available to write hooks. Load a local model in the studio, or sign in to a HivemindOS account.")
    if runtime is None:
        from . import text_models

        runtime = text_models.runtime_for(model_id)
    answer = story_producer.produce(
        model_id=model_id,
        task_id=DAY_TASK.id,
        brief=f"Write exactly {wanted} posts for {persona['name']}. Niche: {persona['niche'] or 'lifestyle'}. Voice: {persona['voice'] or 'warm, plain, first person'}.",
        context={
            "platforms": persona["platforms"],
            "clip_seconds": persona["clip_seconds"],
            "trend_notes": trend_notes.strip() or "none supplied",
            "what_has_worked": persona_scoreboard(persona) or "no measured posts yet",
        },
        runtime=runtime,
    )
    return {"persona": persona["id"], "model": model_id, "posts": answer.payload["posts"][:wanted], "notes": list(answer.notes)}


def persona_brief(persona: dict[str, Any], post: dict[str, Any], *, index: int, day: str) -> dict[str, Any]:
    """One post as a ``persona-series`` brief the planner accepts."""
    hashtags = [str(tag).strip().lstrip("#") for tag in post.get("hashtags") or [] if str(tag).strip()]
    caption = str(post["caption"]).strip()
    if persona["disclosed_as_ai"] and "ai" not in {tag.lower() for tag in hashtags}:
        hashtags.append("AI")
    return {
        "id": f"{persona['id']}-{day}-{index}",
        "lane": "persona-series",
        "title": str(post["hook"]).strip(),
        "hook": str(post["hook"]).strip(),
        "aspect_ratio": persona["aspect_ratio"],
        "persona": {key: persona[key] for key in ("id", "name", "appearance", "references", "disclosed_as_ai")},
        "scenes": [{
            "title": str(post["hook"]).strip(),
            "beat": str(post["image_prompt"]).strip(),
            "image_prompt": str(post["image_prompt"]).strip(),
            "motion_prompt": str(post["motion_prompt"]).strip(),
            "duration_seconds": persona["clip_seconds"],
            "overlay": str(post["hook"]).strip(),
        }],
        "publish": {
            "platforms": persona["platforms"],
            "accounts": persona["accounts"],
            "caption": caption,
            "hashtags": hashtags,
            **({"review_in": "hivemindos"} if persona["review_in"] == "hivemindos" else {}),
        },
    }


def start_persona_day(
    persona_id: str,
    posts: list[dict[str, Any]],
    *,
    orchestrator: Any | None = None,
    cfg: StudioConfig | None = None,
) -> dict[str, Any]:
    """Open one run per post and drive each as far as it goes without a person or a generator."""
    from .agent_runtime import attach_script
    from .orchestrator import ContentOrchestrator

    cfg = cfg or load_config()
    persona = load_persona(persona_id, cfg=cfg)
    if not posts:
        raise PersonaError("There are no posts to start.")
    engine = orchestrator or ContentOrchestrator()
    day = utc_now()[:10]
    started = []
    for index, post in enumerate(posts[:MAX_POSTS_PER_DAY], start=1):
        _check_day({"posts": [post]})
        brief = persona_brief(persona, post, index=index, day=day)
        brief_dir = personas_dir(cfg) / persona["id"] / "briefs"
        brief_dir.mkdir(parents=True, exist_ok=True)
        brief_path = brief_dir / f"{brief['id']}.yaml"
        write_private_text(brief_path, yaml.safe_dump(brief, sort_keys=False))
        envelope = engine.execute_content_run(brief_path)
        manifest_path = str(envelope.get("manifest_path") or "")
        # The day plan IS the script: the hook, the shot and the caption were the
        # creative decision, so the run does not wait for an agent to write one.
        script = brief_dir / f"{brief['id']}.script.md"
        write_private_text(script, f"# {brief['hook']}\n\n{brief['scenes'][0]['image_prompt']}\n\n{brief['scenes'][0]['motion_prompt']}\n\n{brief['publish']['caption']}\n")
        attach_script(manifest_path, script, runtime="persona-autopilot")
        envelope = engine.resume_run(str(envelope["run_id"]))
        started.append({"run_id": envelope["run_id"], "manifest_path": manifest_path, "hook": brief["hook"], "status": envelope.get("status"), "next": envelope.get("next_actions") or envelope.get("actions") or []})
    persona["runs"] = [*persona.get("runs", []), *[item["manifest_path"] for item in started]]
    save_persona(persona, cfg=cfg)
    return {"persona": persona["id"], "day": day, "started": started}
