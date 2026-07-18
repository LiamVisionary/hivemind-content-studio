#!/usr/bin/env python3
"""Install the pinned Krea 2 identity-edit nodes, model, and workflows."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
ADAPTER_SOURCE = ROOT / "packages/comfyui-custom-nodes/hivemind-krea2-identity"
OFFICIAL_NODE_REPO = "https://github.com/lbouaraba/comfyui-krea2edit.git"
OFFICIAL_NODE_COMMIT = "b5d3c2f3485ea9990ca8190b930a209c9f6d5e39"
MODEL_REPO_REVISION = "29f4b0b96bf01bf3de7c9f1313ca3337538ca247"
MODEL_NAME = "krea2_identity_edit_v1_2.safetensors"
MODEL_SIZE = 1_828_256_432
MODEL_SHA256 = "6adf9a69cc9502d286db7b69964d37da7e9cfe4b05b4d004bc275f087d3fd3cf"
MODEL_URL = (
    "https://huggingface.co/conradlocke/krea2-identity-edit/resolve/"
    f"{MODEL_REPO_REVISION}/{MODEL_NAME}"
)


def install_adapter(comfy_dir: Path) -> Path:
    target = comfy_dir / "custom_nodes/hivemind-krea2-identity"
    target.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        target.mkdir(parents=True, exist_ok=True)
        shutil.copytree(ADAPTER_SOURCE, target, dirs_exist_ok=True)
        return target
    if target.is_symlink() and target.resolve() == ADAPTER_SOURCE.resolve():
        return target
    if target.exists() or target.is_symlink():
        raise RuntimeError(f"Refusing to replace unmanaged adapter path: {target}")
    target.symlink_to(ADAPTER_SOURCE, target_is_directory=True)
    return target


def install_official_nodes(comfy_dir: Path) -> Path:
    target = comfy_dir / "custom_nodes/comfyui-krea2edit"
    if not target.exists():
        subprocess.run(["git", "clone", OFFICIAL_NODE_REPO, str(target)], check=True)
    if not (target / ".git").exists():
        raise RuntimeError(f"Official node target is not a Git checkout: {target}")
    subprocess.run(["git", "fetch", "origin", OFFICIAL_NODE_COMMIT], cwd=target, check=True)
    subprocess.run(["git", "checkout", "--detach", OFFICIAL_NODE_COMMIT], cwd=target, check=True)
    return target


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def install_model(comfy_dir: Path, verify: bool = False) -> Path:
    target = comfy_dir / "models/loras" / MODEL_NAME
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size == MODEL_SIZE:
        if not verify or sha256(target) == MODEL_SHA256:
            return target
    partial = target.with_suffix(target.suffix + ".partial")
    headers = {"User-Agent": "Hivemind-Content-Studio/1.0"}
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_READ_WRITE_KEY")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(MODEL_URL, headers=headers)
    with urlopen(request, timeout=60) as response, partial.open("wb") as output:
        shutil.copyfileobj(response, output, length=8 * 1024 * 1024)
    if partial.stat().st_size != MODEL_SIZE or sha256(partial) != MODEL_SHA256:
        partial.unlink(missing_ok=True)
        raise RuntimeError("Downloaded Krea 2 identity model failed size or SHA-256 verification")
    partial.replace(target)
    return target


def install_api_workflows(comfy_dir: Path) -> list[Path]:
    gateway_dir = ROOT / "packages/media-gateway"
    sys.path.insert(0, str(gateway_dir))
    from krea2_identity_workflow import build_krea2_turbo_identity_prompt

    workflow_dir = comfy_dir / "workflows"
    workflow_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for profile, suffix in (("apple-silicon", "apple"), ("cuda", "portable")):
        target = workflow_dir / f"krea2_turbo_identity_optional_{suffix}_api.json"
        graph = build_krea2_turbo_identity_prompt(
            "Restage the same adult person in a cinematic portrait while preserving exact facial identity.",
            image_name="None",
            options={"width": 1024, "height": 1024, "steps": 10, "cfg": 1, "seed": 42},
            profile=profile,
            filename_prefix=f"krea2_identity_{suffix}",
        )
        target.write_text(json.dumps(graph, indent=2) + "\n", encoding="utf-8")
        written.append(target)
    editor_source = ROOT / "workflows/Krea2 Turbo Identity Optional Apple Silicon.json"
    if editor_source.exists():
        editor_target = comfy_dir / "user/default/workflows" / editor_source.name
        editor_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(editor_source, editor_target)
        written.append(editor_target)
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfy-dir", type=Path, default=Path.home() / "comfy/ComfyUI")
    parser.add_argument("--skip-model", action="store_true")
    parser.add_argument("--verify-model", action="store_true")
    args = parser.parse_args()
    comfy_dir = args.comfy_dir.expanduser().resolve()
    if not (comfy_dir / "main.py").exists():
        parser.error(f"ComfyUI was not found at {comfy_dir}")

    result = {
        "adapter": str(install_adapter(comfy_dir)),
        "official_nodes": str(install_official_nodes(comfy_dir)),
        "model": None if args.skip_model else str(install_model(comfy_dir, verify=args.verify_model)),
        "workflows": [str(path) for path in install_api_workflows(comfy_dir)],
        "restart_required": True,
    }
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
