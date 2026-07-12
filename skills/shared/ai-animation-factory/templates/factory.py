#!/usr/bin/env python3
"""Starter local CLI for an AI animation factory scaffold.

Copy this into `scripts/factory.py` in a project scaffold. It intentionally keeps
external API use optional: `plan` generates deterministic run artifacts from a
YAML brief, while `draft-script` performs a small LLM smoke only when a model
provider key is available.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from pathlib import Path
from string import Template

import yaml

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs"


def slugify(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-") or "untitled"


def load_yaml(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise SystemExit(f"Brief must be a YAML object: {path}")
    return data


def run_slug(brief: dict) -> str:
    base = brief.get("id") or brief.get("series") or brief.get("client") or brief.get("product") or brief.get("type", "run")
    if brief.get("episode") and "episode" not in str(base).lower():
        base = f"{base} episode {brief['episode']}"
    return slugify(str(base))


def render_prompt(template_path: Path, data: dict) -> str:
    text = template_path.read_text(encoding="utf-8")
    text = re.sub(r"{{\s*([a-zA-Z0-9_]+)\s*}}", r"${\1}", text)
    return Template(text).safe_substitute(data)


def scene_rows(brief: dict) -> list[dict]:
    rows = []
    for i, scene in enumerate(brief.get("scenes") or [], start=1):
        slug = scene.get("slug") or scene.get("title") or f"scene-{i:02d}"
        rows.append({
            "scene": slugify(str(slug)),
            "duration_seconds": scene.get("duration_seconds", ""),
            "beat": scene.get("beat", ""),
            "frame_prompt_file": "midjourney_prompts.md",
            "motion_prompt_file": "runway_prompts.md",
        })
    return rows


def build_plan(brief_path: Path) -> Path:
    brief = load_yaml(brief_path)
    out = RUNS / run_slug(brief)
    for sub in ["frames/raw", "frames/selected", "video/clips", "video/final", "audio/voice", "audio/music", "metadata"]:
        (out / sub).mkdir(parents=True, exist_ok=True)

    rows = scene_rows(brief)
    with (out / "scene_manifest.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["scene", "duration_seconds", "beat", "frame_prompt_file", "motion_prompt_file"])
        writer.writeheader()
        writer.writerows(rows)

    image_blocks, motion_blocks, voice_blocks = [], [], []
    for row in rows:
        data = {
            **brief,
            **row,
            "scene_description": row["beat"],
            "character_continuity": brief.get("main_character", brief.get("product", "brand-safe original visuals")),
            "environment": brief.get("tone", "cohesive production environment"),
            "frame_filename": f"{row['scene']}.png",
            "action": row["beat"],
            "camera": "slow push-in or clean motion-graphic transition",
            "tone": brief.get("tone", "controlled"),
            "voice": brief.get("voice", "Rachel" if brief.get("type") == "animated_story_series" else "Daniel"),
            "performance_direction": f"Perform with {brief.get('tone', 'controlled')} energy; keep it clear and not exaggerated.",
            "line": row["beat"],
        }
        image_blocks.append(f"## {row['scene']}\n\n" + render_prompt(ROOT / "prompts" / "midjourney.md", data))
        motion_blocks.append(f"## {row['scene']}\n\n" + render_prompt(ROOT / "prompts" / "runway.md", data))
        voice_blocks.append(f"## {row['scene']}\n\n" + render_prompt(ROOT / "prompts" / "elevenlabs.md", data))

    (out / "midjourney_prompts.md").write_text("\n\n---\n\n".join(image_blocks), encoding="utf-8")
    (out / "runway_prompts.md").write_text("\n\n---\n\n".join(motion_blocks), encoding="utf-8")
    (out / "elevenlabs_lines.md").write_text("\n\n---\n\n".join(voice_blocks), encoding="utf-8")
    (out / "suno_prompts.md").write_text(f"# Music cue\n\nMood: {brief.get('tone', 'cinematic')}\nRuntime: {brief.get('runtime_minutes') or brief.get('runtime_seconds') or 'TBD'}\nAvoid lyrics unless explicitly requested.\n", encoding="utf-8")
    (out / "publish_metadata.md").write_text(f"# Publish Metadata\n\nTitle: {brief.get('title') or brief.get('product') or run_slug(brief)}\n\nSummary:\n{brief.get('logline') or brief.get('goal') or brief.get('product') or 'Generated production draft.'}\n\nChapters: Add final timestamps after assembly.\n", encoding="utf-8")
    (out / "brief.snapshot.json").write_text(json.dumps(brief, indent=2), encoding="utf-8")
    print(out)
    return out


def init_samples() -> None:
    for brief in sorted((ROOT / "briefs").glob("*.yaml")):
        build_plan(brief)


def draft_script(brief_path: Path) -> None:
    """Tiny optional OpenAI draft smoke; provider failures are sanitized."""
    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY is not in the environment. Add a provider key or run through shared env loading.")
    try:
        from openai import OpenAI
        prompt = json.dumps(load_yaml(brief_path), indent=2)
        response = OpenAI().chat.completions.create(
            model=os.environ.get("FACTORY_OPENAI_MODEL", "gpt-4.1-mini"),
            messages=[{"role": "user", "content": "Turn this animation/video brief into a scene-by-scene production script:\n" + prompt}],
            temperature=0.7,
        )
    except Exception as exc:
        raise SystemExit(f"Script draft failed via OpenAI provider ({exc.__class__.__name__}). Check OPENAI_API_KEY / FACTORY_OPENAI_MODEL without printing the key.") from None
    out = build_plan(brief_path)
    (out / "script_draft.md").write_text(response.choices[0].message.content or "", encoding="utf-8")
    print(out / "script_draft.md")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init-samples")
    plan = sub.add_parser("plan")
    plan.add_argument("brief")
    draft = sub.add_parser("draft-script")
    draft.add_argument("brief")
    args = parser.parse_args(argv)

    if args.cmd == "init-samples":
        init_samples()
    elif args.cmd == "plan":
        build_plan(Path(args.brief))
    elif args.cmd == "draft-script":
        draft_script(Path(args.brief))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
