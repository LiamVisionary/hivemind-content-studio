#!/usr/bin/env python3
"""Hold the desktop shell's two version literals to `pyproject.toml`'s.

`docs/RELEASE.md` §4 says the version has exactly one home: `[project] version`
in `pyproject.toml`. Two other files have to repeat it, because cargo and Tauri
each read their own: `desktop/src-tauri/Cargo.toml` and
`desktop/src-tauri/tauri.conf.json` (Tauri's own `version` wins over Cargo's, so
both are load-bearing). Nothing bound them together, so "one home" was a claim
rather than a fact, and a bundle stamped with a version the tag does not carry is
an AGPL source offer pointing at a tag that was never created — the About page
builds that link from the running version.

    python3 scripts/check_version.py                  # the three agree
    python3 scripts/check_version.py --expect 0.2.0   # ...and are that version

`--expect` is the release gate: the build workflow passes the dispatched version,
so a release of 0.2.0 from a tree that still says 0.1.0 fails at preflight,
before anything is built, with the three files and the edit named.

No network, no dependencies, and nothing here reads a credential.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = ROOT / "pyproject.toml"
CARGO_TOML = ROOT / "desktop" / "src-tauri" / "Cargo.toml"
TAURI_CONFIG = ROOT / "desktop" / "src-tauri" / "tauri.conf.json"

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def _relative(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def source_version() -> str:
    """The one home: `[project] version` in pyproject.toml."""
    data = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    return str(data.get("project", {}).get("version") or "")


def mirrors() -> dict[str, str]:
    """The two files that have to repeat it, and what each currently says."""
    cargo = tomllib.loads(CARGO_TOML.read_text(encoding="utf-8"))
    tauri = json.loads(TAURI_CONFIG.read_text(encoding="utf-8"))
    return {
        _relative(CARGO_TOML): str(cargo.get("package", {}).get("version") or ""),
        _relative(TAURI_CONFIG): str(tauri.get("version") or ""),
    }


def check(expect: str | None = None) -> list[str]:
    problems: list[str] = []
    source = source_version()
    if not source:
        return [f"{_relative(PYPROJECT)} has no `[project] version`, so there is no version to check against."]
    if not SEMVER.match(source):
        problems.append(f"{_relative(PYPROJECT)} version is {source!r}, which is not semver like 0.2.0.")

    for path, found in mirrors().items():
        if found != source:
            problems.append(
                f"{path} says {found or '(nothing)'!r} but {_relative(PYPROJECT)} says {source!r}. "
                f"Edit {path} to {source!r} — pyproject is the one home for the version."
            )

    if expect is not None and expect != source:
        problems.append(
            f"This release was dispatched as {expect!r}, but the tree is {source!r}. "
            f"Bump the version in {_relative(PYPROJECT)}, {_relative(CARGO_TOML)} and "
            f"{_relative(TAURI_CONFIG)} on a branch, merge it, and dispatch again — "
            "a bundle stamped with a version its tag does not carry cannot be corrected after it ships."
        )
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--expect", help="the version this release is being built as, e.g. 0.2.0")
    args = parser.parse_args(argv)

    problems = check(args.expect)
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1
    print(f"version {source_version()} in pyproject.toml, {_relative(CARGO_TOML)} and {_relative(TAURI_CONFIG)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
