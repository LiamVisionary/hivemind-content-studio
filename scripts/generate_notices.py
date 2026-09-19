#!/usr/bin/env python3
"""Collect the licences of everything the build carries into docs/notices.json.

The About panel has to be able to answer "what is in this app, and under what
terms" without a network call, and the AGPL's source offer has to name a version.
Doing that by hand is how notices files go stale, so this walks the places that
already know what ships.

    python3 scripts/generate_notices.py            # writes docs/notices.json
    python3 scripts/generate_notices.py --check    # fails if it is out of date
    python3 scripts/generate_notices.py --check-ffmpeg vendor/ffmpeg/darwin-arm64/ffmpeg

**The set comes from lockfiles, never from the machine.** That is the whole
design. It used to enumerate whatever distributions the running interpreter could
import, which made the file a property of the developer's venv: 128 packages
locally against the ~95 the bundle installs, so the same command was green on one
machine and red in CI and the About page over-reported the bundle by a third.
Now:

* Python — `uv export --frozen --no-dev --extra desktop`, the same pinned set
  `scripts/build_desktop_python.py` freezes into the bundle.
* npm — each `package-lock.json`, runtime entries only.
* Rust — `desktop/src-tauri/Cargo.lock`. Those crates are statically linked into
  the shipped binary, and MIT and Apache-2.0 both ask for their notices to travel
  with a binary distribution. The lock is per-workspace rather than per-target,
  so this over-lists slightly (a Windows-only crate the macOS build never links).
  Attributing more than is required is safe; attributing less is not.
* Bundled binaries — `BUNDLED_BINARIES` below, written by hand because no
  lockfile knows about them. They are the part of the DMG that is not in this
  repository at all.

**Licences are carried forward from the committed file**, keyed on name and
version, and only resolved afresh for an entry that is not already recorded — so
the output is identical on any machine, and a version bump is what forces a new
lookup. Fresh lookups read installed package metadata (Python) and the local
cargo registry cache (Rust); when neither can answer, the entry is listed in
`unresolved` rather than guessed at, because a wrong licence is worse than a
missing one, and the About panel shows that list.

No network, no new dependencies, and nothing here reads a credential.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tomllib
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
CARGO_LOCK = ROOT / "desktop" / "src-tauri" / "Cargo.lock"
DESKTOP_EXTRA = "desktop"
UNKNOWN = "UNKNOWN"
# Enough of a licence name to trust a one-line heading over guessing.
_LICENSE_NAMES = r"\b(MIT|BSD|Apache|GPL|LGPL|AGPL|MPL|ISC|Zlib|Unlicense|PSF|Python|CC0|Artistic|EPL)\b"

# The three binaries the DMG carries that are in no lockfile: they are downloaded
# or built by the release workflow, not resolved by a package manager. Each one
# is redistributed, so each one needs its own notice travelling with it.
#
# `status` is honest about the difference between what the bundle specifies and
# what the release workflow stages today (docs/RELEASE.md §8: the runtimes are
# not bundled yet).
BUNDLED_BINARIES: tuple[dict[str, str | None], ...] = (
    {
        "name": "python-build-standalone (CPython)",
        "version": "3.12",
        "license": "PSF-2.0",
        "url": "https://github.com/astral-sh/python-build-standalone",
        "status": "planned",
        "notice": (
            "The redistributable interpreter the bundle runs. CPython is PSF-2.0; the distribution also "
            "carries OpenSSL, libffi, ncurses, readline, sqlite, xz and zlib, whose licences ship inside it "
            "as python/licenses/. Copy that directory into the bundle next to the interpreter."
        ),
    },
    {
        "name": "Node.js",
        "version": "22",
        "license": "MIT",
        "url": "https://nodejs.org/",
        "status": "planned",
        "notice": (
            "Runs node-services.mjs (Canvas host, local-inference bridge, agent MCP). Node itself is MIT; "
            "its own LICENSE file carries the notices for V8, ICU (Unicode-3.0), OpenSSL, zlib and libuv, "
            "and that file ships with the binary."
        ),
    },
    {
        "name": "ffmpeg / ffprobe (static arm64)",
        "version": None,
        "license": None,
        "url": None,
        "status": "planned",
        "notice": (
            "Staged into the bundle from the DESKTOP_FFMPEG_ARCHIVE_URL repository variable. Which build it "
            "is decides the licence of the whole download — a --enable-gpl build makes the DMG a GPL "
            "distribution with its own source obligation — so pin a named build and record its version, "
            "licence and source URL in BUNDLED_BINARIES in scripts/generate_notices.py. "
            "`generate_notices.py --check-ffmpeg <path>` is the gate: the release build refuses to stage a "
            "pair this file does not describe."
        ),
    },
)


# --------------------------------------------------------------------------
# Carry-forward: the committed file is the licence authority
# --------------------------------------------------------------------------


def _recorded(output: Path) -> dict[tuple[str, str, str], dict]:
    """Every licence already committed, keyed (section, name, version)."""
    try:
        existing = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(existing, dict):
        return {}
    known: dict[tuple[str, str, str], dict] = {}
    sections: list[tuple[str, list]] = [
        ("python", (existing.get("python") or {}).get("packages") or []),
        ("rust", (existing.get("rust") or {}).get("packages") or []),
        ("bundled", existing.get("bundled") or []),
    ]
    for relative, rows in (existing.get("npm") or {}).items():
        sections.append((f"npm:{relative}", rows or []))
    for section, rows in sections:
        for row in rows:
            if isinstance(row, dict) and row.get("name"):
                known[(section, str(row["name"]), str(row.get("version") or ""))] = row
    return known


def _carry(known: dict, section: str, name: str, version: str) -> dict | None:
    """The committed row for this exact version, if it settled a licence.

    A row that is already in `unresolved` is looked up again every run: carrying
    an unknown forward would freeze it, and the point of the list is that it
    shrinks.
    """
    row = known.get((section, name, version))
    if row is None:
        return None
    recorded = str(row.get("license") or "").strip()
    if not recorded or recorded == UNKNOWN:
        return None
    return row


# --------------------------------------------------------------------------
# Python: the pinned desktop set out of uv.lock
# --------------------------------------------------------------------------


class NoticesError(RuntimeError):
    """Something the caller has to fix, phrased as the edit that fixes it."""


def _uv_export(uv: str = "uv") -> str:
    command = [
        uv,
        "export",
        "--frozen",
        "--no-dev",
        "--no-emit-project",
        "--no-hashes",
        "--extra",
        DESKTOP_EXTRA,
        "--format",
        "requirements-txt",
    ]
    try:
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=False, timeout=300)
    except FileNotFoundError:
        raise NoticesError(
            "`uv` is not on PATH, and the notices file describes the pinned set from uv.lock rather than "
            "whatever this machine happens to have installed. Install uv (https://docs.astral.sh/uv/) and "
            "run this again."
        ) from None
    if result.returncode != 0:
        raise NoticesError(
            "`uv export` failed, so the shipped dependency set could not be read. "
            "Run `uv lock --check` to see whether uv.lock is stale.\n" + result.stderr.strip()[-1200:]
        )
    return result.stdout


def _canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _lock_versions() -> dict[str, str]:
    """Every version uv.lock pins, canonical name -> version."""
    lock = ROOT / "uv.lock"
    try:
        data = tomllib.loads(lock.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return {}
    return {
        _canonical(str(entry.get("name") or "")): str(entry.get("version") or "")
        for entry in data.get("package") or []
        if entry.get("name")
    }


def _locked_python() -> list[tuple[str, str]]:
    """(name, version) for everything the desktop extra pins, sorted.

    Membership comes from the export, the version from uv.lock: a direct
    reference (the PassBook git pin) has no `==` in the export line, and reading
    its version off the installed distribution instead would make this file a
    property of the machine again.
    """
    versions = _lock_versions()
    found: dict[str, str] = {}
    for raw in _uv_export().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        line = line.split(";", 1)[0].strip()
        for separator in (" @ ", "==", ">=", "<=", "~=", "!="):
            if separator in line:
                name, _, rest = line.partition(separator)
                version = rest.strip() if separator == "==" else ""
                break
        else:
            name, version = line, ""
        canonical = _canonical(name.split("[", 1)[0].strip())
        found[canonical] = version or versions.get(canonical, "")
    return sorted(found.items())


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
    # Some wheels put the whole licence text in that field. Its first line is
    # usually the name ("MIT License"), which is worth having — but only when it
    # actually names a licence, never a stray "Copyright (c) …" opening.
    first = declared.splitlines()[0].strip() if declared else ""
    if first and len(first) <= 60 and re.search(_LICENSE_NAMES, first, re.IGNORECASE):
        return first
    return UNKNOWN


def _installed_python() -> dict[str, metadata.Distribution]:
    installed: dict[str, metadata.Distribution] = {}
    for dist in metadata.distributions():
        name = dist.metadata.get("Name")
        if name:
            installed[_canonical(str(name))] = dist
    return installed


def python_packages(known: dict) -> list[dict[str, str | None]]:
    installed = _installed_python()
    rows: list[dict[str, str | None]] = []
    for name, version in _locked_python():
        carried = _carry(known, "python", name, version)
        if carried:
            rows.append(dict(carried))
            continue
        dist = installed.get(name)
        rows.append(
            {
                "name": name,
                "version": version,
                "license": _license_from_metadata(dist) if dist else UNKNOWN,
                "url": (dist.metadata.get("Home-page") if dist else None) or None,
            }
        )
    return rows


# --------------------------------------------------------------------------
# npm: each package-lock.json, runtime entries only
# --------------------------------------------------------------------------


def npm_packages(relative: str, known: dict) -> list[dict[str, str | None]]:
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
        version = str(entry.get("version") or "")
        carried = _carry(known, f"npm:{relative}", str(name), version)
        if carried:
            rows[str(name)] = dict(carried)
            continue
        rows[str(name)] = {
            "name": str(name),
            "version": version,
            # npm omits `license` for a package whose manifest omits it. Say so
            # rather than guessing: a wrong licence is worse than a missing one.
            "license": str(entry["license"]) if entry.get("license") else None,
            "url": (entry.get("resolved") or None),
        }
    return [rows[key] for key in sorted(rows, key=str.lower)]


# --------------------------------------------------------------------------
# Rust: Cargo.lock, with licences out of the local registry cache
# --------------------------------------------------------------------------


def _cargo_registry_roots() -> list[Path]:
    home = Path(os.environ.get("CARGO_HOME") or (Path.home() / ".cargo"))
    source = home / "registry" / "src"
    if not source.is_dir():
        return []
    return sorted(path for path in source.iterdir() if path.is_dir())


def _license_from_crate(name: str, version: str, roots: list[Path]) -> str | None:
    for root in roots:
        manifest = root / f"{name}-{version}" / "Cargo.toml"
        if not manifest.is_file():
            continue
        try:
            package = tomllib.loads(manifest.read_text(encoding="utf-8", errors="replace")).get("package", {})
        except (OSError, tomllib.TOMLDecodeError):
            return None
        declared = package.get("license")
        if isinstance(declared, str) and declared.strip():
            return declared.strip()
        if package.get("license-file"):
            # The crate ships its own text rather than an SPDX id. Name the file
            # rather than inventing an identifier for it.
            return f"see {package['license-file']}"
        return None
    return None


def rust_packages(known: dict) -> list[dict[str, str | None]]:
    if not CARGO_LOCK.is_file():
        return []
    try:
        lock = tomllib.loads(CARGO_LOCK.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise NoticesError(f"{CARGO_LOCK} could not be read: {error}") from error
    roots = _cargo_registry_roots()
    rows: list[dict[str, str | None]] = []
    for package in lock.get("package") or []:
        name = str(package.get("name") or "")
        version = str(package.get("version") or "")
        if not name or not package.get("source"):
            continue  # the workspace's own crate: this repository, AGPL
        carried = _carry(known, "rust", name, version)
        if carried:
            rows.append(dict(carried))
            continue
        rows.append(
            {
                "name": name,
                "version": version,
                "license": _license_from_crate(name, version, roots),
                "url": f"https://crates.io/crates/{name}/{version}",
            }
        )
    return sorted(rows, key=lambda row: (str(row["name"]).lower(), str(row["version"])))


def bundled_binaries(known: dict) -> list[dict[str, str | None]]:
    rows: list[dict[str, str | None]] = []
    for entry in BUNDLED_BINARIES:
        carried = _carry(known, "bundled", str(entry["name"]), str(entry.get("version") or ""))
        # The hand-written block is the authority for these; carry-forward only
        # fills a licence somebody recorded in the file and not in the block.
        row = dict(entry)
        if carried and not row.get("license"):
            row["license"] = carried.get("license")
            row["url"] = row.get("url") or carried.get("url")
        rows.append(row)
    return rows


# --------------------------------------------------------------------------


def build_notices(output: Path = OUTPUT) -> dict:
    known = _recorded(output)
    python_rows = python_packages(known)
    npm = {relative: npm_packages(relative, known) for relative in NPM_PACKAGES}
    rust_rows = rust_packages(known)
    bundled = bundled_binaries(known)
    unresolved = sorted(
        {row["name"] for row in python_rows if not row["license"] or row["license"] == UNKNOWN}
        | {row["name"] for bundle in npm.values() for row in bundle if not row["license"]}
        | {f"{row['name']} (rust)" for row in rust_rows if not row["license"]}
        | {f"{row['name']} (bundled binary)" for row in bundled if not row["license"]}
    )
    return {
        "schema_version": 2,
        "generated_by": "scripts/generate_notices.py",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "project": {
            "license": "AGPL-3.0-or-later",
            "notices": "THIRD_PARTY_NOTICES.md",
            "source_url": "https://github.com/LiamVisionary/hivemind-content-studio",
        },
        # Runtime only, and lockfile-derived: build-time-only npm packages and
        # the dev dependency group are skipped, and every set here comes from a
        # committed lockfile rather than from this machine.
        "scope": "runtime",
        "python": {"source": f"uv.lock (--extra {DESKTOP_EXTRA})", "packages": python_rows},
        "npm": npm,
        "rust": {"source": "desktop/src-tauri/Cargo.lock", "packages": rust_rows},
        "bundled": bundled,
        # Named, not hidden: the About panel shows this list so a missing licence
        # is a visible task rather than a silent gap in the notices.
        "unresolved": unresolved,
    }


def check_ffmpeg(binary: Path, output: Path = OUTPUT) -> list[str]:
    """Refuse to stage an ffmpeg the notices file does not describe.

    The archive URL is a repository variable, so the licence of the binary a
    release downloads is decided outside this tree — and a --enable-gpl build
    puts a source obligation on the whole DMG. This is the gate that stops that
    being somebody's job to remember.
    """
    try:
        notices = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return [f"{output} is missing or unreadable; run scripts/generate_notices.py."]
    entry = next(
        (row for row in notices.get("bundled") or [] if "ffmpeg" in str(row.get("name", "")).lower()),
        None,
    )
    if entry is None:
        return ["docs/notices.json records no ffmpeg entry. Add one to BUNDLED_BINARIES in scripts/generate_notices.py."]

    problems: list[str] = []
    recorded = str(entry.get("license") or "").strip()
    if not recorded:
        problems.append(
            "docs/notices.json records no licence for the bundled ffmpeg. Pin DESKTOP_FFMPEG_ARCHIVE_URL to a "
            "named build, then record its version, licence and source URL in BUNDLED_BINARIES in "
            "scripts/generate_notices.py and regenerate. Redistributing it unattributed is the one thing this "
            "build must not do."
        )

    try:
        result = subprocess.run(
            [str(binary), "-version"], capture_output=True, text=True, timeout=60, check=False
        )
    except (OSError, subprocess.SubprocessError) as error:
        return problems + [f"Could not run {binary}: {error}"]
    if result.returncode != 0:
        return problems + [f"{binary} -version exited {result.returncode}: {result.stderr.strip()[-400:]}"]

    banner = result.stdout + result.stderr
    gpl = "--enable-gpl" in banner
    nonfree = "--enable-nonfree" in banner
    if nonfree:
        problems.append(
            f"{binary} was configured with --enable-nonfree, which cannot be redistributed at all. "
            "Point DESKTOP_FFMPEG_ARCHIVE_URL at a build without it."
        )
    if recorded:
        # "LGPL" contains "gpl" and means the opposite thing here, so the L has
        # to be excluded explicitly; AGPL is deliberately not.
        recorded_gpl = bool(re.search(r"(?<!l)gpl", recorded, re.IGNORECASE))
        if gpl and not recorded_gpl:
            problems.append(
                f"{binary} was configured with --enable-gpl, but docs/notices.json records {recorded!r}. "
                "Record the GPL terms (and the source offer that comes with them), or use an LGPL build."
            )
        if recorded_gpl and not gpl:
            problems.append(
                f"docs/notices.json records {recorded!r}, but {binary} is not a GPL build. "
                "Record what was actually staged."
            )
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail if docs/notices.json is missing or stale")
    parser.add_argument(
        "--check-ffmpeg",
        type=Path,
        metavar="PATH",
        help="fail unless docs/notices.json describes this staged ffmpeg binary",
    )
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args(argv)

    if args.check_ffmpeg is not None:
        problems = check_ffmpeg(args.check_ffmpeg, args.output)
        for problem in problems:
            print(problem, file=sys.stderr)
        if problems:
            return 1
        print(f"{args.check_ffmpeg} matches the licence docs/notices.json records for it")
        return 0

    try:
        notices = build_notices(args.output)
    except NoticesError as error:
        print(str(error), file=sys.stderr)
        return 1
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
        f"{counts}, rust={len(notices['rust']['packages'])}, bundled={len(notices['bundled'])}, "
        f"unresolved={len(notices['unresolved'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
