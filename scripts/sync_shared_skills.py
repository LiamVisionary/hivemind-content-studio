#!/usr/bin/env python3
"""Refresh the allowlisted Shared Brain skill snapshots."""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path


SKILLS = (
    "ai-animation-factory",
    "auto-clipper",
    "social-video-publishing",
    "script-to-short",
    "short-video-assembly",
    "video-render-qa",
    "media-cache-hygiene",
    "subtitle-timing",
    "pexels-media",
    "pixabay-media",
    "localtts",
    "comfyui-image-generation",
    "muapi-generative-media",
    "muapi-seedance-video",
    "higgsfield-generate",
    "higgsfield-api-quirks",
    "ai-ugc-production-pipeline",
    "video-shot-transcript",
    "video-lipsync-tts",
)


def main() -> int:
    parser = argparse.ArgumentParser()
    default_vault = Path(os.environ.get("OBSIDIAN_VAULT_PATH", Path.home() / "Documents" / "Obsidian" / "hivemindos-vault"))
    parser.add_argument("--vault", type=Path, default=default_vault)
    parser.add_argument("--target", type=Path, default=Path(__file__).resolve().parents[1] / "skills" / "shared")
    args = parser.parse_args()
    source_root = args.vault.expanduser().resolve() / "Skills"
    target_root = args.target.expanduser().resolve()
    missing = [skill for skill in SKILLS if not (source_root / skill / "SKILL.md").is_file()]
    if missing:
        raise SystemExit("Missing Shared Brain skills: " + ", ".join(missing))
    target_root.mkdir(parents=True, exist_ok=True)
    for skill in SKILLS:
        destination = target_root / skill
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(source_root / skill, destination, ignore=shutil.ignore_patterns(".DS_Store", "__pycache__", "*.pyc"))
        print(f"synced {skill}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
