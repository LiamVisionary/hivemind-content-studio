from __future__ import annotations

import json
from pathlib import Path

from hivemind_content_studio.cli import build_parser


ROOT = Path(__file__).resolve().parents[2]


def test_component_manifest_matches_embedded_source_roots() -> None:
    manifest = json.loads((ROOT / "components.json").read_text(encoding="utf-8"))

    assert manifest["schema_version"] == 1
    destinations = {item["id"]: item["destination"] for item in manifest["components"]}
    assert destinations == {
        "unified-image-studio-template": "packages/unified-studio-launcher",
        "Open-Generative-AI": "packages/open-generative-ai",
        "comfyui-mobile-frontend": "packages/comfyui-mobile",
        "hive-image-stack": "packages/media-gateway",
        "flux-2-swift-mlx": "engines/flux-2-swift-mlx",
        "Z-Image.swift": "engines/z-image-swift",
    }
    for destination in destinations.values():
        assert (ROOT / destination).is_dir()


def test_active_runtime_paths_do_not_depend_on_retired_checkouts() -> None:
    active_files = [
        ROOT / "scripts/hivemind-studio-stack",
        ROOT / "packages/media-gateway/app.py",
        ROOT / "packages/media-gateway/server.js",
        ROOT / "packages/media-gateway/bin/image-gen-studio.mjs",
        ROOT / "packages/open-generative-ai/hosted-server.js",
        ROOT / "packages/open-generative-ai/electron/lib/localInference.js",
    ]
    retired_paths = (
        "/comfy/z-image-api",
        "/comfy/integrations/comfyui-mobile-frontend",
        "/comfy/flux-2-swift-mlx",
        "/comfy/Z-Image.swift",
        "/.openclaw/companions/Open-Generative-AI",
    )
    combined = "\n".join(path.read_text(encoding="utf-8") for path in active_files)
    assert not any(path in combined for path in retired_paths)


def test_stack_command_is_part_of_the_canonical_cli() -> None:
    args = build_parser().parse_args(["stack", "status"])

    assert args.command == "stack"
    assert args.action == "status"
