"""Typed production-template catalog shared by the CLI, API routes, and the studio composer.

Templates are frontmatter markdown files under ``templates/catalog/<category>/<id>.md``.
The frontmatter carries safe metadata; the body is the production prompt seeded into the
Simple composer, with ``[SLOT]`` placeholders the user or brain fills in.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path

import yaml

from .lanes import LANE_BY_ID

CATALOG_ROOT = Path(__file__).resolve().parent / "templates" / "catalog"


@dataclass(frozen=True)
class TemplateDefinition:
    id: str
    title: str
    category: str
    description: str
    lane: str
    aspect_ratio: str
    duration_seconds: int
    slots: tuple[str, ...]
    tags: tuple[str, ...]
    source: str
    prompt: str

    def as_dict(self) -> dict:
        value = asdict(self)
        value["slots"] = list(self.slots)
        value["tags"] = list(self.tags)
        return value


def _parse_template(path: Path) -> TemplateDefinition:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise ValueError(f"Template {path.name} is missing YAML frontmatter")
    frontmatter, separator, body = text[4:].partition("\n---\n")
    if not separator:
        raise ValueError(f"Template {path.name} frontmatter is not closed with ---")
    meta = yaml.safe_load(frontmatter)
    if not isinstance(meta, dict):
        raise ValueError(f"Template {path.name} frontmatter is not a mapping")
    prompt = body.strip()
    template = TemplateDefinition(
        id=str(meta.get("id") or "").strip(),
        title=str(meta.get("title") or "").strip(),
        category=path.parent.name,
        description=str(meta.get("description") or "").strip(),
        lane=str(meta.get("lane") or "").strip(),
        aspect_ratio=str(meta.get("aspect_ratio") or "9:16").strip(),
        duration_seconds=int(meta.get("duration_seconds") or 15),
        slots=tuple(str(slot).strip() for slot in meta.get("slots") or ()),
        tags=tuple(str(tag).strip() for tag in meta.get("tags") or ()),
        source=str(meta.get("source") or "").strip(),
        prompt=prompt,
    )
    if not template.id or not template.title or not template.description or not prompt:
        raise ValueError(f"Template {path.name} needs id, title, description, and a prompt body")
    if template.lane not in LANE_BY_ID:
        raise ValueError(f"Template {template.id} names unknown lane {template.lane!r}")
    for slot in template.slots:
        if f"[{slot}" not in prompt:
            raise ValueError(f"Template {template.id} declares slot {slot!r} that never appears in its prompt")
    return template


@lru_cache(maxsize=1)
def template_catalog() -> tuple[TemplateDefinition, ...]:
    entries = tuple(
        sorted(
            (_parse_template(path) for path in sorted(CATALOG_ROOT.rglob("*.md"))),
            key=lambda template: (template.category, template.title),
        )
    )
    seen: set[str] = set()
    for template in entries:
        if template.id in seen:
            raise ValueError(f"Duplicate template id {template.id!r} in {CATALOG_ROOT}")
        seen.add(template.id)
    return entries


def template_by_id(template_id: str) -> TemplateDefinition:
    for template in template_catalog():
        if template.id == template_id:
            return template
    raise KeyError(f"Unknown template {template_id!r}")


def template_report() -> list[dict]:
    return [template.as_dict() for template in template_catalog()]
