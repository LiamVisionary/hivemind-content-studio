#!/usr/bin/env python3
"""Validate or install the reversible links used by the unified local stack."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HOME = Path.home()
STATE_ROOT = Path(os.environ.get("HIVEMIND_MEDIA_STATE_DIR", HOME / ".hivemindos/media-studio")).expanduser()
STACK_SCRIPT = ROOT / "scripts/hivemind-studio-stack"
STACK_LINK = HOME / ".local/bin/zimage-stack"
COMFY_ROOT = Path(os.environ.get("COMFY_DIR", HOME / "comfy/ComfyUI")).expanduser()
MOBILE_LINK = COMFY_ROOT / "custom_nodes/comfyui-mobile-frontend"
MOBILE_ROOT = ROOT / "packages/comfyui-mobile"
KREA2_IDENTITY_LINK = COMFY_ROOT / "custom_nodes/hivemind-krea2-identity"
KREA2_IDENTITY_ROOT = ROOT / "packages/comfyui-custom-nodes/hivemind-krea2-identity"


def check() -> list[dict[str, object]]:
    paths = {
        "studio source": ROOT / "src/hivemind_content_studio/control_api.py",
        "stack supervisor": STACK_SCRIPT,
        "OpenGen source": ROOT / "packages/open-generative-ai/package.json",
        "OpenGen build": ROOT / "packages/open-generative-ai/dist/index.html",
        "mobile source": MOBILE_ROOT / "package.json",
        "mobile build": MOBILE_ROOT / "dist/index.html",
        "Krea2 identity adapter": KREA2_IDENTITY_ROOT / "__init__.py",
        "gateway source": ROOT / "packages/media-gateway/app.py",
        "gateway build": ROOT / "packages/media-gateway/.next/BUILD_ID",
        "Flux engine": ROOT / "engines/flux-2-swift-mlx/Package.swift",
        "Z-Image engine": ROOT / "engines/z-image-swift/Package.swift",
        "ComfyUI": COMFY_ROOT / "main.py",
        "gateway token": STATE_ROOT / "secure/zimg-token",
    }
    return [{"name": name, "path": str(path), "ready": path.exists()} for name, path in paths.items()]


def run_build() -> None:
    for package in ("packages/open-generative-ai", "packages/comfyui-mobile", "packages/media-gateway"):
        subprocess.run(["npm", "ci"], cwd=ROOT / package, check=True)
    subprocess.run(["npm", "run", "build:embedded"], cwd=ROOT, check=True)


def install_links() -> dict[str, object]:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive = STATE_ROOT / "archive/launchers"
    archive.mkdir(parents=True, exist_ok=True)
    STACK_LINK.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if STACK_LINK.exists() or STACK_LINK.is_symlink():
        try:
            current = STACK_LINK.resolve(strict=True)
        except FileNotFoundError:
            current = None
        if current != STACK_SCRIPT:
            backup = archive / f"zimage-stack.pre-unified.{stamp}"
            if current and current.is_file():
                shutil.copy2(current, backup)
            STACK_LINK.unlink()
    if not STACK_LINK.exists():
        STACK_LINK.symlink_to(STACK_SCRIPT)

    MOBILE_LINK.parent.mkdir(parents=True, exist_ok=True)
    if MOBILE_LINK.exists() and not MOBILE_LINK.is_symlink():
        raise RuntimeError(f"Refusing to replace non-symlink ComfyUI node directory: {MOBILE_LINK}")
    MOBILE_LINK.unlink(missing_ok=True)
    MOBILE_LINK.symlink_to(MOBILE_ROOT)
    if KREA2_IDENTITY_LINK.exists() and not KREA2_IDENTITY_LINK.is_symlink():
        raise RuntimeError(f"Refusing to replace non-symlink ComfyUI node directory: {KREA2_IDENTITY_LINK}")
    KREA2_IDENTITY_LINK.unlink(missing_ok=True)
    KREA2_IDENTITY_LINK.symlink_to(KREA2_IDENTITY_ROOT)
    return {
        "stack_link": str(STACK_LINK),
        "mobile_link": str(MOBILE_LINK),
        "krea2_identity_link": str(KREA2_IDENTITY_LINK),
        "launcher_backup": str(backup) if backup else None,
        "rollback": f"Restore {backup} to {STACK_LINK}" if backup else "Remove the two links to return to an uninstalled state.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", action="store_true", help="Install package dependencies and build all embedded browser apps")
    parser.add_argument("--install-links", action="store_true", help="Back up the old launcher and point stable local links at this repo")
    args = parser.parse_args()
    if args.build:
        run_build()
    installed = install_links() if args.install_links else None
    report = check()
    print(json.dumps({"ok": all(item["ready"] for item in report), "checks": report, "installed": installed}, indent=2))
    return 0 if all(item["ready"] for item in report) else 1


if __name__ == "__main__":
    raise SystemExit(main())
