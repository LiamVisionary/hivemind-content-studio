#!/usr/bin/env python3
"""Freeze the Python the desktop bundle ships, and say how big it is.

`docs/RELEASE.md` §1 says the bundle carries its own interpreter and a frozen
venv built from the `desktop` extra, because a Finder-launched app has no shell
profile and cannot call `uv`. This is the script that builds that tree, and the
one place that decides what is in it.

Three things it exists to guarantee, each of which was a real failure mode:

* **The Streamlit stack never rides along.** `streamlit`, `streamlit-tour`,
  `azure-cognitiveservices-speech`, `dashscope` and `redis` belong to the
  embedded faceless engine and its retired Streamlit UI; no shipped process
  imports one. They live in the `faceless-webui` extra, and this script refuses
  to build if any of them turns up in the desktop export.
* **The build needs no git access.** `passbook` is a `git+https://` dependency.
  A release runner that has to clone at build time is a release that breaks the
  day the network or the token does, so the wheel is vendored first (see
  `--vendor-passbook`) and installed from `vendor/wheels`.
* **ffmpeg is not resolved from `PATH`.** `doctor.py` and the gateway reach for
  `shutil.which("ffmpeg")`. A static ffmpeg/ffprobe is staged into `bin/` and
  the manifest tells the shell to put that directory *first* on every sidecar's
  PATH, so the app never picks up — or fails to find — a Homebrew build.

Usage:

    python3 scripts/build_desktop_python.py                # plan + size report
    python3 scripts/build_desktop_python.py --json         # same, machine readable
    python3 scripts/build_desktop_python.py --vendor-passbook ../passbook
    python3 scripts/build_desktop_python.py --build build/desktop-python \\
        --python /path/to/python-build-standalone/bin/python3.12 \\
        --ffmpeg-dir vendor/ffmpeg/darwin-arm64

The default (plan) mode is offline and read-only: it resolves the two dependency
sets from `uv.lock`, checks the exclusion holds, and measures what each set costs
on disk using an already-installed venv. `--build` is the only mode that writes
an environment, and it is the mode CI runs.

No network in plan mode, no credential is read anywhere, and nothing here signs
or publishes.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tomllib
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# The extra whose packages must never reach the bundle. Read from pyproject so
# there is one list, not two that drift; the names below are only the assertion
# that the extra still means what this script thinks it means.
EXCLUDED_EXTRA = "faceless-webui"
EXPECTED_EXCLUSIONS = (
    "streamlit",
    "streamlit-tour",
    "dashscope",
    "azure-cognitiveservices-speech",
    "redis",
)
DESKTOP_EXTRA = "desktop"

# Vendored wheels the build installs from instead of fetching. `passbook` is the
# one that matters (it is a git dependency); the directory is a normal
# `--find-links` source, so anything else that has to be pinned by file can go
# here too.
VENDOR_WHEELS = ROOT / "vendor" / "wheels"
# Where a static ffmpeg/ffprobe pair is expected when `--ffmpeg-dir` is not given.
DEFAULT_FFMPEG_DIR = ROOT / "vendor" / "ffmpeg" / "darwin-arm64"
FFMPEG_BINARIES = ("ffmpeg", "ffprobe")

MANIFEST_NAME = "desktop-python.json"


class BuildError(RuntimeError):
    """A failure with a fix in the message. Nothing here raises without one."""


# --------------------------------------------------------------------------
# Dependency sets
# --------------------------------------------------------------------------


def _pyproject() -> dict:
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))


def _canonical(name: str) -> str:
    return name.lower().replace("_", "-")


def excluded_packages() -> list[str]:
    """The `faceless-webui` names, canonicalised, straight from pyproject."""
    extras = _pyproject()["project"]["optional-dependencies"]
    if EXCLUDED_EXTRA not in extras:
        raise BuildError(
            f"pyproject.toml has no `{EXCLUDED_EXTRA}` extra. The desktop bundle's "
            "exclusion list lives there; restore it before building."
        )
    names = [_canonical(spec.split("==")[0].split(">=")[0].split("[")[0].strip()) for spec in extras[EXCLUDED_EXTRA]]
    missing = [name for name in EXPECTED_EXCLUSIONS if _canonical(name) not in names]
    if missing:
        raise BuildError(
            f"`{EXCLUDED_EXTRA}` no longer holds {', '.join(missing)}. Either move them back, "
            "or update EXPECTED_EXCLUSIONS in this script with the reason in the commit."
        )
    return names


def export_requirements(extra: str, *, uv: str = "uv") -> str:
    """`uv export` for one extra, resolved from `uv.lock` with no network."""
    command = [
        uv,
        "export",
        "--frozen",
        "--no-dev",
        "--no-emit-project",
        "--no-hashes",
        "--extra",
        extra,
        "--format",
        "requirements-txt",
    ]
    try:
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=False, timeout=300)
    except FileNotFoundError:
        raise BuildError(
            "`uv` is not on PATH. Install it (https://docs.astral.sh/uv/) or pass --uv with its path; "
            "this script reads the pinned set from uv.lock and never resolves versions itself."
        ) from None
    if result.returncode != 0:
        raise BuildError(
            "`uv export` failed, so the pinned dependency set could not be read. "
            "Run `uv lock --check` to see whether uv.lock is stale.\n"
            + result.stderr.strip()[-1200:]
        )
    return result.stdout


def parse_requirements(text: str) -> tuple[list[str], dict[str, str]]:
    """Split an export into (canonical names, name -> full requirement line)."""
    names: list[str] = []
    lines: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        line = line.split(";", 1)[0].strip()
        if not line:
            continue
        for separator in (" @ ", "==", ">=", "<=", "~=", "!=", "["):
            if separator in line:
                name = line.split(separator, 1)[0]
                break
        else:
            name = line
        canonical = _canonical(name.strip())
        names.append(canonical)
        lines[canonical] = raw.strip()
    return sorted(set(names)), lines


def direct_reference_lines(lines: dict[str, str]) -> dict[str, str]:
    """Requirements pinned to a URL or a git ref rather than a version."""
    return {name: line for name, line in lines.items() if " @ " in line}


# --------------------------------------------------------------------------
# Size measurement
# --------------------------------------------------------------------------


def _site_packages(venv: Path) -> Path | None:
    candidates = sorted((venv / "lib").glob("python3.*/site-packages"))
    if candidates:
        return candidates[-1]
    windows = venv / "Lib" / "site-packages"
    return windows if windows.is_dir() else None


def measure_distributions(venv: Path) -> dict[str, int]:
    """Bytes on disk per installed distribution, from each one's RECORD."""
    site_packages = _site_packages(venv)
    if site_packages is None:
        return {}
    sizes: dict[str, int] = {}
    for dist_info in site_packages.glob("*.dist-info"):
        record = dist_info / "RECORD"
        name = _canonical(dist_info.name.split("-")[0])
        total = 0
        if record.is_file():
            for row in record.read_text(encoding="utf-8", errors="replace").splitlines():
                relative = row.split(",", 1)[0].strip()
                if not relative:
                    continue
                path = (site_packages / relative).resolve()
                try:
                    total += path.stat().st_size
                except OSError:
                    continue
        sizes[name] = sizes.get(name, 0) + total
    return sizes


def _human(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{value:.1f} GB"


def directory_size(path: Path) -> int:
    total = 0
    for entry in path.rglob("*"):
        try:
            if entry.is_file() and not entry.is_symlink():
                total += entry.stat().st_size
        except OSError:
            continue
    return total


# --------------------------------------------------------------------------
# Plan
# --------------------------------------------------------------------------


def plan(*, uv: str, measure_venv: Path) -> dict:
    excluded = excluded_packages()
    desktop_text = export_requirements(DESKTOP_EXTRA, uv=uv)
    desktop_names, desktop_lines = parse_requirements(desktop_text)

    leaked = sorted(set(desktop_names) & set(excluded))
    if leaked:
        raise BuildError(
            "The desktop dependency set carries "
            + ", ".join(leaked)
            + ". Those packages belong to the `faceless-webui` extra (docs/RELEASE.md §5): move the "
            "dependency that pulls them behind that extra, or the bundle grows by roughly a third "
            "for a UI it never starts."
        )

    faceless_text = export_requirements(EXCLUDED_EXTRA, uv=uv)
    faceless_names, _ = parse_requirements(faceless_text)
    webui_only = sorted(set(faceless_names) - set(desktop_names))

    sizes = measure_distributions(measure_venv)
    desktop_bytes = sum(sizes.get(name, 0) for name in desktop_names)
    webui_bytes = sum(sizes.get(name, 0) for name in webui_only)
    unmeasured = sorted(name for name in desktop_names if name not in sizes)

    return {
        "schema_version": 1,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "desktop_extra": DESKTOP_EXTRA,
        "excluded_extra": EXCLUDED_EXTRA,
        "excluded": excluded,
        "packages": len(desktop_names),
        "webui_only_packages": webui_only,
        "direct_references": direct_reference_lines(desktop_lines),
        "measured_venv": str(measure_venv),
        "sizes": {
            "desktop_site_packages_bytes": desktop_bytes,
            "webui_only_bytes": webui_bytes,
            "desktop_site_packages": _human(desktop_bytes),
            "webui_only": _human(webui_bytes),
        },
        "unmeasured": unmeasured,
    }


def print_plan(report: dict) -> None:
    print(f"Desktop dependency set: {report['packages']} packages (extra `{report['desktop_extra']}`)")
    print(
        "Excluded (`{extra}`): {names}".format(
            extra=report["excluded_extra"], names=", ".join(report["excluded"])
        )
    )
    webui_only = report["webui_only_packages"]
    print(f"  …which pull {len(webui_only)} distributions the bundle does not install")
    sizes = report["sizes"]
    print()
    print(f"Measured against {report['measured_venv']}")
    print(f"  desktop site-packages : {sizes['desktop_site_packages']}")
    print(f"  left out by the split : {sizes['webui_only']}")
    if report["unmeasured"]:
        print(
            f"  ({len(report['unmeasured'])} of the desktop set are not installed in that venv, "
            "so they are not counted)"
        )
    if report["direct_references"]:
        print()
        print("Vendored before the build (no git access at build time):")
        for name, line in sorted(report["direct_references"].items()):
            wheel = _find_vendored_wheel(name)
            state = f"vendor/wheels/{wheel.name}" if wheel else "MISSING — run --vendor-passbook"
            print(f"  {name}: {state}")
            print(f"    {line}")


# --------------------------------------------------------------------------
# Vendoring
# --------------------------------------------------------------------------


def _find_vendored_wheel(name: str) -> Path | None:
    if not VENDOR_WHEELS.is_dir():
        return None
    prefix = _canonical(name).replace("-", "_")
    for wheel in sorted(VENDOR_WHEELS.glob("*.whl")):
        if _canonical(wheel.name).replace("-", "_").startswith(prefix + "-"):
            return wheel
    return None


def vendor_passbook(source: Path, *, uv: str) -> Path:
    """Build a wheel from a local PassBook checkout into vendor/wheels.

    Deliberately takes a path rather than cloning: a release build must not need
    git, and the checkout the owner already has is the one whose commit they can
    check against `uv.lock`.
    """
    source = source.expanduser().resolve()
    if not (source / "pyproject.toml").is_file():
        raise BuildError(
            f"{source} is not a Python project checkout (no pyproject.toml). Point --vendor-passbook "
            "at a local clone of the passbook repository at the commit uv.lock pins."
        )
    VENDOR_WHEELS.mkdir(parents=True, exist_ok=True)
    command = [uv, "build", "--wheel", "--out-dir", str(VENDOR_WHEELS), str(source)]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=False, timeout=900)
    if result.returncode != 0:
        raise BuildError(
            "Building the PassBook wheel failed, so the bundle would still need git at build time.\n"
            + result.stderr.strip()[-1200:]
        )
    wheel = _find_vendored_wheel("passbook")
    if wheel is None:
        raise BuildError(
            f"`uv build` reported success but no passbook wheel landed in {VENDOR_WHEELS}. "
            "Check the project name in the checkout's pyproject.toml."
        )
    print(f"Vendored {wheel.relative_to(ROOT)} ({_human(wheel.stat().st_size)})")
    return wheel


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------


def _resolve_ffmpeg_dir(explicit: str | None) -> Path:
    candidate = Path(explicit).expanduser() if explicit else None
    if candidate is None:
        env = os.environ.get("DESKTOP_FFMPEG_DIR")
        candidate = Path(env).expanduser() if env else DEFAULT_FFMPEG_DIR
    missing = [name for name in FFMPEG_BINARIES if not (candidate / name).is_file()]
    if missing:
        raise BuildError(
            f"No static {' and '.join(missing)} in {candidate}. The bundle must not resolve ffmpeg "
            "from the user's PATH (docs/RELEASE.md §1), so the build needs a static pair. Put an "
            f"arm64 build in {DEFAULT_FFMPEG_DIR}, pass --ffmpeg-dir, or set DESKTOP_FFMPEG_DIR. "
            "Verify it first: `file ffmpeg` must say Mach-O arm64 and `otool -L ffmpeg` must list "
            "only /usr/lib and /System frameworks."
        )
    return candidate


def _stage_ffmpeg(source: Path, destination: Path) -> list[str]:
    destination.mkdir(parents=True, exist_ok=True)
    staged = []
    for name in FFMPEG_BINARIES:
        target = destination / name
        shutil.copy2(source / name, target)
        target.chmod(0o755)
        staged.append(name)
    return staged


def build(
    destination: Path,
    *,
    uv: str,
    python: str | None,
    ffmpeg_dir: str | None,
) -> dict:
    report = plan(uv=uv, measure_venv=Path(sys.prefix))
    excluded = set(report["excluded"])

    ffmpeg_source = _resolve_ffmpeg_dir(ffmpeg_dir)

    requirements_text = export_requirements(DESKTOP_EXTRA, uv=uv)
    names, lines = parse_requirements(requirements_text)
    direct = direct_reference_lines(lines)

    # Every direct reference is replaced by a vendored wheel, so the install runs
    # with no VCS access at all.
    vendored: dict[str, str] = {}
    for name in direct:
        wheel = _find_vendored_wheel(name)
        if wheel is None:
            raise BuildError(
                f"`{name}` is pinned to a URL/git reference and has no wheel in {VENDOR_WHEELS}. "
                "Run `python3 scripts/build_desktop_python.py --vendor-passbook <checkout>` first; "
                "a release build must not clone at build time."
            )
        vendored[name] = wheel.name

    destination = destination.expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True)
    venv_dir = destination / "venv"
    if venv_dir.exists():
        shutil.rmtree(venv_dir)

    create = [uv, "venv", str(venv_dir)]
    if python:
        create += ["--python", python]
    result = subprocess.run(create, cwd=ROOT, capture_output=True, text=True, check=False, timeout=600)
    if result.returncode != 0:
        raise BuildError(
            "Could not create the frozen venv. Pass --python with the bundled interpreter "
            "(python-build-standalone 3.12 arm64; pyproject pins >=3.11,<3.13).\n"
            + result.stderr.strip()[-1200:]
        )

    filtered = [row for row in requirements_text.splitlines() if _canonical(row.split(" @ ")[0].strip()) not in direct]
    requirements_file = destination / "requirements-desktop.txt"
    requirements_file.write_text("\n".join(filtered) + "\n", encoding="utf-8")

    install = [
        uv,
        "pip",
        "install",
        "--python",
        str(venv_dir),
        "--no-cache",
        "--requirement",
        str(requirements_file),
    ]
    result = subprocess.run(install, cwd=ROOT, capture_output=True, text=True, check=False, timeout=3600)
    if result.returncode != 0:
        raise BuildError("Installing the desktop dependency set failed.\n" + result.stderr.strip()[-2000:])

    if vendored:
        wheels = [str(VENDOR_WHEELS / filename) for filename in vendored.values()]
        result = subprocess.run(
            [uv, "pip", "install", "--python", str(venv_dir), "--no-cache", *wheels],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=900,
        )
        if result.returncode != 0:
            raise BuildError("Installing the vendored wheels failed.\n" + result.stderr.strip()[-2000:])

    installed = measure_distributions(venv_dir)
    leaked = sorted(set(installed) & excluded)
    if leaked:
        raise BuildError(
            "The built environment contains " + ", ".join(leaked) + ", which the desktop bundle "
            "must not ship. Something reached them transitively; find it with "
            "`uv pip tree --python <venv>` before shipping."
        )

    staged = _stage_ffmpeg(ffmpeg_source, destination / "bin")

    size = directory_size(destination)
    manifest = {
        "schema_version": 1,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "venv": "venv",
        "requirements": requirements_file.name,
        # The shell prepends these (relative to this manifest) to every sidecar's
        # PATH, so ffmpeg/ffprobe resolve to the staged static pair and never to
        # whatever the user has installed.
        "path_prepend": ["bin"],
        "binaries": staged,
        "packages": len(installed),
        "declared_packages": len(names),
        "excluded_extra": EXCLUDED_EXTRA,
        "excluded": sorted(excluded),
        "vendored_wheels": vendored,
        "size_bytes": size,
        "size": _human(size),
    }
    (destination / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"Built {destination}")
    print(f"  packages : {manifest['packages']}")
    print(f"  ffmpeg   : bin/{', bin/'.join(staged)}")
    print(f"  size     : {manifest['size']}")
    return manifest


# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--build",
        metavar="DEST",
        help="Build the frozen environment into DEST (the only mode that writes one).",
    )
    parser.add_argument("--python", help="Interpreter for the frozen venv (the bundled 3.12).")
    parser.add_argument("--ffmpeg-dir", help="Directory holding a static ffmpeg and ffprobe.")
    parser.add_argument(
        "--vendor-passbook",
        metavar="CHECKOUT",
        help="Build the PassBook wheel from a local checkout into vendor/wheels and exit.",
    )
    parser.add_argument(
        "--measure-venv",
        default=str(ROOT / ".venv"),
        help="Venv used to size the dependency sets in plan mode (default: ./.venv).",
    )
    parser.add_argument("--uv", default="uv", help="Path to the uv binary.")
    parser.add_argument("--json", action="store_true", help="Print the plan as JSON.")
    args = parser.parse_args(argv)

    try:
        if args.vendor_passbook:
            vendor_passbook(Path(args.vendor_passbook), uv=args.uv)
            return 0
        if args.build:
            build(Path(args.build), uv=args.uv, python=args.python, ffmpeg_dir=args.ffmpeg_dir)
            return 0
        report = plan(uv=args.uv, measure_venv=Path(args.measure_venv))
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            print_plan(report)
        return 0
    except BuildError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
