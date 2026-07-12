"""Obsidian markdown exports for source and run tracking."""

from __future__ import annotations

import json
import re
from pathlib import Path

from .config import Config
from .db import get_run_bundle


def note_safe(value: str, fallback: str = "untitled") -> str:
    safe = re.sub(r"[/\\:*?\"<>|#^\[\]]+", "-", value).strip(" .-")
    return safe[:100] or fallback


def ensure_obsidian_dirs(cfg: Config) -> None:
    for child in ["Creators", "Sources", "Runs", "Retros"]:
        (cfg.obsidian_output_dir / child).mkdir(parents=True, exist_ok=True)


def write_creator_note(cfg: Config, creator: str) -> Path:
    ensure_obsidian_dirs(cfg)
    path = cfg.obsidian_output_dir / "Creators" / f"{note_safe(creator)}.md"
    if not path.exists():
        path.write_text(
            f"# {creator}\n\n"
            "## Rights\n"
            "- Status: research\n"
            "- Notes: Public creator research only until an explicit approval/campaign note is recorded.\n\n"
            "## Runs\n",
            encoding="utf-8",
        )
    return path


def write_source_note(cfg: Config, source: dict) -> Path:
    ensure_obsidian_dirs(cfg)
    creator = source.get("creator") or "Unknown Creator"
    write_creator_note(cfg, creator)
    title = source.get("title") or f"source-{source['id']}"
    path = cfg.obsidian_output_dir / "Sources" / f"{source['id']:04d}-{note_safe(title)}.md"
    content = [
        f"# {title}",
        "",
        f"- Creator: [[{note_safe(creator)}]]",
        f"- Source ID: {source['id']}",
        f"- Type: {source.get('source_type')}",
        f"- Rights status: {source.get('rights_status')}",
        f"- Source ref: {source.get('source_ref')}",
        f"- Local path: {source.get('local_path') or ''}",
        f"- Duration seconds: {source.get('duration_seconds') or ''}",
        "",
        "## Notes",
        "- Research source. Do not schedule clips until approved.",
        "",
    ]
    path.write_text("\n".join(content), encoding="utf-8")
    return path


def write_run_note(conn, cfg: Config, run_id: int) -> Path:
    ensure_obsidian_dirs(cfg)
    bundle = get_run_bundle(conn, run_id)
    run = bundle["run"]
    source = bundle["source"]
    title = source.get("title") or f"source-{source.get('id')}"
    path = cfg.obsidian_output_dir / "Runs" / f"run-{run_id:04d}-{note_safe(title)}.md"
    approved = _approved_ids(bundle["approvals"])
    content = [
        f"# Run {run_id}: {title}",
        "",
        f"- Source: [[{source.get('id', 0):04d}-{note_safe(title)}]]",
        f"- Creator: [[{note_safe(source.get('creator') or 'Unknown Creator')}]]",
        f"- Run status: {run.get('status')}",
        f"- Rights status: {source.get('rights_status')}",
        f"- Style: {run.get('style')}",
        f"- Top N: {run.get('top_n')}",
        f"- Output dir: {run.get('output_dir') or ''}",
        "",
        "## Approval Gate",
        "- Scheduling allowed: "
        + ("yes" if source.get("rights_status") == "approved" and approved else "no"),
        f"- Approved clip IDs: {', '.join(str(v) for v in approved) if approved else ''}",
        "",
        "## Clips",
    ]
    if bundle["clips"]:
        content.extend(
            [
                "| ID | Slug | Status | Score | Output |",
                "| --- | --- | --- | ---: | --- |",
            ]
        )
        for clip in bundle["clips"]:
            content.append(
                f"| {clip['id']} | {clip['slug']} | {clip['status']} | "
                f"{clip.get('score') or ''} | {clip.get('output_path') or ''} |"
            )
    else:
        content.append("- No clips yet.")

    content.extend(["", "## Scheduled Drafts"])
    if bundle["drafts"]:
        content.extend(
            [
                "| ID | Clip | Platform | Scheduled | Status |",
                "| --- | ---: | --- | --- | --- |",
            ]
        )
        for draft in bundle["drafts"]:
            content.append(
                f"| {draft['id']} | {draft['clip_id']} | {draft['platform']} | "
                f"{draft['scheduled_at']} | {draft['postiz_status']} |"
            )
    else:
        content.append("- No Postiz drafts yet.")

    content.extend(["", "## Raw Approval Records", "```json"])
    content.append(json.dumps(bundle["approvals"], indent=2, sort_keys=True))
    content.extend(["```", ""])
    path.write_text("\n".join(content), encoding="utf-8")
    return path


def _approved_ids(approvals: list[dict]) -> list[int]:
    ids: set[int] = set()
    for approval in approvals:
        try:
            ids.update(int(v) for v in json.loads(approval["clip_ids_json"]))
        except Exception:
            continue
    return sorted(ids)

