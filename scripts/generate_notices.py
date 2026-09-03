#!/usr/bin/env python3
"""Collect the licences of everything the build carries into docs/notices.json.

The About panel has to be able to answer "what is in this app, and under what
terms" without a network call, and the AGPL's source offer has to name a version.
Doing that by hand is how notices files go stale, so this walks the two places
that already know: the installed Python distributions, and each npm package's
lockfile.

    python3 scripts/generate_notices.py            # writes docs/notices.json
    python3 scripts/generate_notices.py --check    # fails if it is out of date

Python side: `pip-licenses --format=json` when it is installed, otherwise
`importlib.metadata` over the distributions the interpreter can see — the
fallback is the normal path, since pip-licenses is not a dependency of this
project and is not going to be added for one script.

npm side: `package-lock.json`. npm records a `license` field for most packages it
resolves; the ones it does not are listed with `"license": null` rather than
guessed at, because a wrong licence in a notices file is worse than a missing one.

No network, no new dependencies, and nothing here reads a credential.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "notices.json"
NPM_PACKAGES = (
    "packages/open-generative-ai",
    "packages/comfyui-mobile",
    "packages/media-gateway",
)
UNKNOWN = "UNKNOWN"


def _python_via_pip_licenses() -> list[dict[str, str | None]] | None:
    try:
        result = subprocess.run(
            [sys.executable, "-m", "piplicenses", "--format=json", "--with-urls"],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    try:
        rows = json.loads(result.stdout)
    except ValueError:
        return None
    return [
        {
            "name": str(row.get("Name", "")),
            "version": str(row.get("Version", "")),
            "license": str(row.get("License") or UNKNOWN),
            "url": row.get("URL") or None,
        }
        for row in rows
        if isinstance(row, dict)
    ]


def _license_from_metadata(dist: metadata.Distribution) -> str:
    meta = dist.metadata
    # Modern wheels put an SPDX string in License-Expression; older ones put a
    # whole licence text in License, so prefer the classifiers in between.
    expression = meta.get("License-Expression")
    if expression:
        return str(expression).strip()
    classifiers = [value for value in meta.get_all("Classifier") or [] if value.startswith("License ::")]
    if classifiers:
        return ", ".join(item.rsplit(" :: ", 1)[-1] for item in classifiers)
    declared = (meta.get("License") or "").strip()
    if declared and "\n" not in declared and len(declared) <= 80:
        return declared
    return UNKNOWN


def _python_via_metadata() -> list[dict[str, str | None]]:
    rows: dict[str, dict[str, str | None]] = {}
    for dist in metadata.distributions():
        name = dist.metadata.get("Name")
        if not name:
            continue
        rows[str(name)] = {
            "name": str(name),
            "version": dist.version or "",
            "license": _license_from_metadata(dist),
            "url": dist.metadata.get("Home-page") or None,
        }
    return [rows[key] for key in sorted(rows, key=str.lower)]


def python_packages() -> tuple[str, list[dict[str, str | None]]]:
    rows = _python_via_pip_licenses()
    if rows is not None:
        return "pip-licenses", sorted(rows, key=lambda row: str(row["name"]).lower())
    return "importlib.metadata", _python_via_metadata()


def npm_packages(relative: str) -> list[dict[str, str | None]]:
    lock_path = ROOT / relative / "package-lock.json"
    if not lock_path.is_file():
        return []
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except ValueError:
        return []
    rows: dict[str, dict[str, str | None]] = {}
    for key, entry in (lock.get("packages") or {}).items():
        if not key or not isinstance(entry, dict):
            continue  # "" is the package itself
        # Build-time-only packages (vite, eslint, the test runner) are not
        # distributed, so they do not belong in a notices file. `devOptional`
        # means "reachable from a runtime dependency too" and is kept.
        if entry.get("dev") is True:
            continue
        name = entry.get("name") or key.split("node_modules/")[-1]
        if not name:
            continue
        rows[str(name)] = {
            "name": str(name),
            "version": str(entry.get("version") or ""),
            # npm omits `license` for a package whose manifest omits it. Say so
            # rather than guessing: a wrong licence is worse than a missing one.
            "license": str(entry["license"]) if entry.get("license") else None,
            "url": (entry.get("resolved") or None),
        }
    return [rows[key] for key in sorted(rows, key=str.lower)]


def build_notices() -> dict:
    source, python_rows = python_packages()
    npm = {relative: npm_packages(relative) for relative in NPM_PACKAGES}
    unresolved = sorted(
        {row["name"] for row in python_rows if row["license"] == UNKNOWN}
        | {row["name"] for bundle in npm.values() for row in bundle if not row["license"]}
    )
    return {
        "schema_version": 1,
        "generated_by": "scripts/generate_notices.py",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "project": {
            "license": "AGPL-3.0-or-later",
            "notices": "THIRD_PARTY_NOTICES.md",
            "source_url": "https://github.com/LiamVisionary/hivemind-content-studio",
        },
        # Runtime only: build-time-only npm packages are skipped, and the Python
        # list is whatever the interpreter that ran this has installed — run it
        # inside the bundled venv to describe the bundle rather than a dev box.
        "scope": "runtime",
        "python": {"source": source, "packages": python_rows},
        "npm": npm,
        # Named, not hidden: the About panel shows this list so a missing licence
        # is a visible task rather than a silent gap in the notices.
        "unresolved": unresolved,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail if docs/notices.json is missing or stale")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args(argv)

    notices = build_notices()
    rendered = json.dumps(notices, indent=2, ensure_ascii=False, sort_keys=False) + "\n"

    if args.check:
        if not args.output.is_file():
            print(f"missing {args.output}; run scripts/generate_notices.py", file=sys.stderr)
            return 1
        existing = json.loads(args.output.read_text(encoding="utf-8"))
        # generated_at moves every day and is not a staleness signal on its own.
        stale = {key: value for key, value in existing.items() if key != "generated_at"} != {
            key: value for key, value in notices.items() if key != "generated_at"
        }
        if stale:
            print(f"{args.output} is out of date; run scripts/generate_notices.py", file=sys.stderr)
            return 1
        print(f"{args.output} is current")
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered, encoding="utf-8")
    counts = ", ".join(f"{relative.rsplit('/', 1)[-1]}={len(rows)}" for relative, rows in notices["npm"].items())
    print(
        f"wrote {args.output}: python={len(notices['python']['packages'])} ({notices['python']['source']}), "
        f"{counts}, unresolved={len(notices['unresolved'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
