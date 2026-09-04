#!/usr/bin/env python3
"""Retroactively scrub prompt text from the gateway's durable job history.

Records written before the workflow scrubber landed embed the generation prompt
inside `comfy_prompt`'s workflow graph (and, historically, other free-text
fields). This rewrites history.jsonl in place with those fields blanked,
keeping every other field — status, timings, outputs, model settings — intact.

Usage:
    python purge_history_prompts.py --dry-run
    python purge_history_prompts.py            # rewrites, keeps a .bak
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path


def _load_gateway():
    spec = importlib.util.spec_from_file_location("gwapp", str(Path(__file__).with_name("app.py")))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def default_history_path() -> Path:
    state_root = Path(os.environ.get("HIVEMIND_MEDIA_STATE_DIR", Path.home() / ".hivemindos/media-studio"))
    return state_root / "state/media-gateway/history.jsonl"


def scrub_line(gw, raw: str):
    """Return (scrubbed_json, changed) for one history line."""
    try:
        record = json.loads(raw)
    except json.JSONDecodeError:
        return raw, False
    if not isinstance(record, dict):
        return raw, False
    before = json.dumps(record, ensure_ascii=False, sort_keys=True)
    cleaned = gw.history.private_rec(record)
    after = json.dumps(cleaned, ensure_ascii=False, sort_keys=True)
    return json.dumps(cleaned, ensure_ascii=False), before != after


def main() -> int:
    parser = argparse.ArgumentParser(description="Scrub prompt text from gateway job history")
    parser.add_argument("--history", default=str(default_history_path()))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    history = Path(args.history).expanduser()
    if not history.is_file():
        print(f"no history file at {history}")
        return 0

    gw = _load_gateway()
    lines = history.read_text(encoding="utf-8").splitlines()
    out_lines, changed = [], 0
    for raw in lines:
        if not raw.strip():
            continue
        scrubbed, was_changed = scrub_line(gw, raw)
        out_lines.append(scrubbed)
        changed += bool(was_changed)

    print(json.dumps({"records": len(out_lines), "records_scrubbed": changed, "dry_run": args.dry_run}, indent=2))
    if args.dry_run or not changed:
        return 0

    backup = history.with_suffix(history.suffix + ".bak")
    shutil.copy2(history, backup)
    tmp = history.with_suffix(history.suffix + ".tmp")
    tmp.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    os.replace(tmp, history)
    print(f"rewrote {history} (backup at {backup.name} — delete it once verified)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
