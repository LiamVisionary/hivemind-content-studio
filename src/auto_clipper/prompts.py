"""Prompt resolution with per-category overlays.

The overlay shape is adapted from zhouxiaoka/autoclip's
`backend/core/shared_config.py::get_prompt_files` (MIT): a category directory may
override any prompt file, and each file falls back to the default independently.
That per-file fallback is the point — a category that only wants a different
scoring rubric drops in one file instead of forking the whole set.
"""

from __future__ import annotations

from pathlib import Path

from .config import Config

RERANK = "clip-rerank.txt"
TITLE = "clip-title.txt"

PROMPT_NAMES = (RERANK, TITLE)


class PromptError(RuntimeError):
    """Raised when a required prompt file is missing."""


def available_categories(cfg: Config) -> list[str]:
    root = cfg.prompts_dir
    if not root.is_dir():
        return []
    return sorted(
        path.name
        for path in root.iterdir()
        if path.is_dir() and any((path / name).is_file() for name in PROMPT_NAMES)
    )


def resolve_prompt_path(cfg: Config, name: str, category: str | None = None) -> Path:
    """Return the overlay file for `name` if the category ships one, else the default."""
    if category:
        override = cfg.prompts_dir / category / name
        if override.is_file():
            return override
    default = cfg.prompts_dir / name
    if not default.is_file():
        raise PromptError(
            f"Prompt {name!r} not found at {default}. Expected it under {cfg.prompts_dir}."
        )
    return default


def load_prompt(cfg: Config, name: str, category: str | None = None) -> str:
    return resolve_prompt_path(cfg, name, category).read_text(encoding="utf-8")
