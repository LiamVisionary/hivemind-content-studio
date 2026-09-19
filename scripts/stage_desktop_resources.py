#!/usr/bin/env python3
"""Assemble everything the packaged app runs into `desktop/src-tauri/resources/`.

Tauri bundles only what `bundle.resources` names. Before this script existed the
block named nothing, so `cargo tauri build` produced an .app containing the Rust
shell, the boot screen and nothing else: no interpreter, no Node, no ffmpeg, no
studio, no frontend. `Layout::resolve` then fell back to `<cwd>/.venv/bin/python`
— and a Finder launch has cwd `/` — so every sidecar failed to spawn and the boot
screen was all anyone ever saw.

Four parts go into the bundle, plus the file that tells the shell where they are:

    resources/
      runtime.json      <- written here; the shell reads it from its resource dir
      desktop-python/   <- scripts/build_desktop_python.py --build (venv + ffmpeg)
      node/             <- the Node binary the three Node surfaces run on
      studio/           <- the application itself, including the built frontends
      legal/            <- LICENSE, notices, changelog (the AGPL offer travels)

Two modes, because both a release runner and a bare `cargo test` have to work:

    python3 scripts/stage_desktop_resources.py --skeleton
        Placeholders only. `tauri-build` refuses to compile when a declared
        resource path is missing, so the tree must exist even in a checkout that
        has never built a frontend. A skeleton `runtime.json` names no paths at
        all, which leaves the shell on its development defaults.

    python3 scripts/stage_desktop_resources.py --node "$(command -v node)"
        The real thing. Copies the sources, writes a runtime.json of paths
        relative to the app's resource directory, and refuses rather than
        staging a bundle with a hole in it.

    python3 scripts/stage_desktop_resources.py --verify
        Fails if any part is still a placeholder. The release workflow runs this
        after staging, because a build that silently shipped the skeleton is the
        exact failure this file exists to end.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TAURI_DIR = ROOT / "desktop" / "src-tauri"
RESOURCES = TAURI_DIR / "resources"
RUNTIME_NAME = "runtime.json"
PLACEHOLDER_NAME = "PLACEHOLDER.md"

# Never copied into the bundle, wherever they appear.
PRUNED = {
    "__pycache__",
    ".git",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    ".DS_Store",
    "node_modules/.cache",
}


class StagingError(RuntimeError):
    """Something the bundle needs is not there. Refusing beats shipping a hole."""


@dataclass(frozen=True)
class Part:
    """One entry of `bundle.resources`, and what fills it."""

    #: Path under `resources/`, and the key tauri.conf.json declares.
    name: str
    #: One line for the placeholder and for the error when it is missing.
    purpose: str
    #: (source relative to the repo, destination relative to the part) pairs.
    sources: tuple[tuple[str, str], ...] = ()
    #: Paths inside the staged part that must exist afterwards. These are the
    #: build outputs — a stale checkout stages happily and ships an empty dist.
    required: tuple[str, ...] = ()
    #: True when another script produces this part and staging only checks it.
    produced_elsewhere: str | None = None
    #: Directories pruned from this part's copy, on top of PRUNED.
    prune: frozenset[str] = field(default_factory=frozenset)


PARTS: tuple[Part, ...] = (
    Part(
        name="desktop-python",
        purpose="The frozen interpreter, the desktop dependency set and the static ffmpeg/ffprobe pair.",
        required=("desktop-python.json", "venv/bin/python", "bin/ffmpeg", "bin/ffprobe"),
        produced_elsewhere=(
            "scripts/build_desktop_python.py --build desktop/src-tauri/resources/desktop-python "
            "--ffmpeg-dir vendor/ffmpeg/darwin-arm64"
        ),
    ),
    Part(
        name="node",
        purpose="The Node binary. Three shipped surfaces are Node, and a Finder launch has no PATH to find one on.",
        required=("node",),
    ),
    Part(
        name="studio",
        purpose="The application: the Python package, the two Node services and the three built frontends.",
        sources=(
            ("src", "src"),
            ("pyproject.toml", "pyproject.toml"),
            ("packages/media-gateway", "packages/media-gateway"),
            ("packages/open-generative-ai", "packages/open-generative-ai"),
            ("packages/comfyui-mobile/dist", "packages/comfyui-mobile/dist"),
        ),
        required=(
            "src/hivemind_content_studio/control_api.py",
            "packages/media-gateway/app.py",
            "packages/media-gateway/node-services.mjs",
            # The three frontends `npm run build:embedded` produces. Named one
            # by one: a bundle that carries the servers and no pages is the same
            # boot screen with extra steps.
            "packages/open-generative-ai/dist/index.html",
            "packages/comfyui-mobile/dist/index.html",
            "packages/media-gateway/.next/BUILD_ID",
        ),
        # `target` is the Rust build directory; `.next/cache` is a build cache
        # that is regenerated on demand. Nothing else is pruned by name: a
        # `tests/` rule would also strip directories that packages inside
        # node_modules resolve at runtime.
        prune=frozenset({"target", ".next/cache"}),
    ),
    Part(
        name="legal",
        purpose="The AGPL offer and the third-party notices travel inside the app, not just in the repository.",
        sources=(
            ("LICENSE", "LICENSE"),
            ("THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"),
            ("CHANGELOG.md", "CHANGELOG.md"),
            ("docs/notices.json", "notices.json"),
        ),
        required=("LICENSE", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md", "notices.json"),
    ),
)

#: What `runtime.json` tells the shell, as paths relative to the resource dir.
#: Every key is a `ShellConfig` field in desktop/src-tauri/src/services.rs.
RUNTIME_PATHS = {
    "studioRoot": "studio",
    "python": "desktop-python/venv/bin/python",
    "node": "node/node",
    "frontendDist": "studio/packages/open-generative-ai/dist",
    # Prepended to every sidecar's PATH, so ffmpeg resolves to the staged static
    # pair and never to whatever the user happens to have installed.
    "pathPrepend": ["desktop-python/bin"],
}

#: `ShellConfig` fields runtime.json deliberately leaves out, and why. A new
#: field must land in one list or the other; test_desktop_bundle.py holds that.
DELIBERATELY_UNSET = {
    "mediaStateDir": (
        "The private state root is adopted wherever the user already has it "
        "(~/.hivemindos/media-studio). The app is not its owner and never "
        "relocates it into a per-app container."
    ),
    "comfyLanes": (
        "ComfyUI is attach-only. The shell's own default names the documented "
        "lane ports; overriding them here would pin a user's checkout."
    ),
}


# ---------------------------------------------------------------------------


def part(name: str) -> Part:
    for candidate in PARTS:
        if candidate.name == name:
            return candidate
    raise KeyError(name)


def declared_resources() -> dict[str, str]:
    config = json.loads((TAURI_DIR / "tauri.conf.json").read_text(encoding="utf-8"))
    return dict((config.get("bundle") or {}).get("resources") or {})


def _prune(part_: Part) -> set[str]:
    return PRUNED | set(part_.prune)


def _ignore(part_: Part):
    pruned = _prune(part_)

    def ignore(directory: str, names: list[str]) -> set[str]:
        here = Path(directory)
        skipped = set()
        for name in names:
            if name in pruned:
                skipped.add(name)
                continue
            # Two-segment prunes like `.next/cache` and `node_modules/.cache`.
            if f"{here.name}/{name}" in pruned:
                skipped.add(name)
        return skipped

    return ignore


def _copy(source: Path, destination: Path, part_: Part) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, destination, ignore=_ignore(part_), dirs_exist_ok=True, symlinks=False)
    else:
        shutil.copy2(source, destination)


def is_placeholder(name: str) -> bool:
    """True when the part is the committed skeleton rather than a staged tree."""
    return (RESOURCES / name / PLACEHOLDER_NAME).is_file()


def _write_placeholder(part_: Part) -> None:
    directory = RESOURCES / part_.name
    directory.mkdir(parents=True, exist_ok=True)
    how = part_.produced_elsewhere or "python3 scripts/stage_desktop_resources.py"
    (directory / PLACEHOLDER_NAME).write_text(
        f"# `{part_.name}` is not staged in this checkout\n\n"
        f"{part_.purpose}\n\n"
        "`tauri.conf.json` declares this directory in `bundle.resources`, and\n"
        "`tauri-build` refuses to compile when a declared resource path does not\n"
        "exist — which is the gate that stops the app being packaged without its\n"
        "runtimes. This placeholder is what lets a bare `cargo test` run in a\n"
        "checkout that has never built anything.\n\n"
        "The release build replaces this whole directory:\n\n"
        f"    {how}\n\n"
        "`python3 scripts/stage_desktop_resources.py --verify` fails while this\n"
        "file is still here, so a build cannot ship the placeholder by accident.\n",
        encoding="utf-8",
    )


def skeleton() -> list[str]:
    """Placeholders for every part, and a runtime.json that names no paths."""
    written = []
    for part_ in PARTS:
        _write_placeholder(part_)
        written.append(part_.name)
    (RESOURCES / RUNTIME_NAME).write_text(
        json.dumps(
            {
                "$comment": [
                    "A PLACEHOLDER runtime.json. It names no runtimes on purpose:",
                    "with every key absent the shell keeps its development defaults",
                    "(this checkout's .venv, node on PATH, packages/*/dist), which is",
                    "what `cargo tauri dev` needs. The release build overwrites this",
                    "file with paths relative to the app's own resource directory.",
                ],
                "schema_version": 1,
                "staged": False,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return written


def stage(*, node_binary: Path | None) -> dict:
    """Copy every part into place and write the real runtime.json."""
    missing_sources: list[str] = []
    for part_ in PARTS:
        for source, _ in part_.sources:
            if not (ROOT / source).exists():
                missing_sources.append(source)
    if missing_sources:
        raise StagingError(
            "These sources are not in the checkout, so the bundle would ship without them: "
            + ", ".join(sorted(missing_sources))
            + ". Run `npm run build:embedded` first — the built frontends are among them."
        )

    for part_ in PARTS:
        if part_.produced_elsewhere:
            continue
        directory = RESOURCES / part_.name
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir(parents=True, exist_ok=True)
        for source, destination in part_.sources:
            _copy(ROOT / source, directory / destination, part_)

    if node_binary is not None:
        target = RESOURCES / "node" / "node"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(node_binary, target)
        target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    (RESOURCES / RUNTIME_NAME).write_text(
        json.dumps(
            {
                "$comment": [
                    "Where the packaged app's runtimes are, relative to the app's",
                    "resource directory. The shell resolves every relative path here",
                    "against that directory, so the bundle can be installed anywhere.",
                    "Environment variables still win over this file, which is what",
                    "makes `cargo tauri dev` against a checkout possible.",
                    "Written by scripts/stage_desktop_resources.py; do not hand-edit.",
                ],
                "schema_version": 1,
                "staged": True,
                "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                **RUNTIME_PATHS,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return verify()


def verify() -> dict:
    """Every declared resource is staged, complete, and not a placeholder."""
    problems: list[str] = []
    declared = declared_resources()
    expected = {f"resources/{part_.name}": part_.name for part_ in PARTS}
    expected[f"resources/{RUNTIME_NAME}"] = RUNTIME_NAME
    for source, target in expected.items():
        if declared.get(source) != target:
            problems.append(
                f"tauri.conf.json's bundle.resources does not map {source} -> {target}, so it would not "
                "be in the .app at all."
            )
    for source in sorted(set(declared) - set(expected)):
        problems.append(
            f"tauri.conf.json declares the resource {source}, which no part of this script stages. Either "
            "add it to PARTS so something fills it, or stop declaring it."
        )

    for part_ in PARTS:
        directory = RESOURCES / part_.name
        if not directory.is_dir():
            problems.append(f"{part_.name} was never staged. {part_.purpose}")
            continue
        if is_placeholder(part_.name):
            how = part_.produced_elsewhere or "python3 scripts/stage_desktop_resources.py --node <node>"
            problems.append(
                f"{part_.name} is still the placeholder, so the app would ship without it. {part_.purpose} "
                f"Produce it with: {how}"
            )
            continue
        for required in part_.required:
            if not (directory / required).exists():
                problems.append(f"{part_.name}/{required} is missing. {part_.purpose}")

    runtime_path = RESOURCES / RUNTIME_NAME
    if not runtime_path.is_file():
        problems.append(f"{RUNTIME_NAME} was never written, so the shell would look for its runtimes in the cwd.")
    else:
        runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
        if not runtime.get("staged"):
            problems.append(
                f"{RUNTIME_NAME} is the placeholder. The shell would fall back to this checkout's paths, "
                "which do not exist on a user's machine."
            )
        else:
            for key in RUNTIME_PATHS:
                if key not in runtime:
                    problems.append(f"{RUNTIME_NAME} does not name {key}.")

    if problems:
        raise StagingError("\n".join(problems))
    return {
        "resources": os.path.relpath(RESOURCES, ROOT),
        "parts": [part_.name for part_ in PARTS],
        "size_bytes": sum(f.stat().st_size for f in RESOURCES.rglob("*") if f.is_file()),
    }


# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--skeleton",
        action="store_true",
        help="Write placeholders only, so a checkout that has built nothing still compiles.",
    )
    mode.add_argument(
        "--verify",
        action="store_true",
        help="Fail when any declared resource is missing or still a placeholder.",
    )
    parser.add_argument(
        "--node",
        help="The Node binary to bundle. Defaults to the one running this build (`command -v node`).",
    )
    args = parser.parse_args(argv)

    try:
        if args.skeleton:
            for name in skeleton():
                print(f"placeholder: resources/{name}")
            print(f"placeholder: resources/{RUNTIME_NAME}")
            return 0
        if args.verify:
            report = verify()
            print(f"Staged {len(report['parts'])} resource parts, {report['size_bytes'] / 1e6:.0f} MB.")
            return 0

        node_binary = Path(args.node).expanduser() if args.node else _node_on_path()
        if node_binary is None or not node_binary.is_file():
            raise StagingError(
                "No Node binary to bundle. Pass --node with the path to an arm64 Node LTS; a desktop app "
                "launched from Finder cannot borrow the user's."
            )
        report = stage(node_binary=node_binary)
        print(f"Staged {', '.join(report['parts'])} into {report['resources']} ({report['size_bytes'] / 1e6:.0f} MB).")
        return 0
    except StagingError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


def _node_on_path() -> Path | None:
    found = shutil.which("node", path=os.environ.get("PATH", ""))
    return Path(found) if found else None


if __name__ == "__main__":
    raise SystemExit(main())
