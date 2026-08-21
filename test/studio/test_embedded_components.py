from __future__ import annotations

import json
from pathlib import Path

from hivemind_content_studio.cli import build_parser


ROOT = Path(__file__).resolve().parents[2]
OPEN_GEN_ROOT = ROOT / "packages" / "open-generative-ai"


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


def test_embedded_creative_surfaces_keep_prompts_and_outputs_out_of_persistent_browser_storage() -> None:
    # Anchor on the shell's real module entry: src/components/*.js is the retired
    # vanilla build, so a test that greps it would pass while checking dead code.
    shell = (OPEN_GEN_ROOT / "index.html").read_text(encoding="utf-8")
    assert 'src="/src/main.jsx"' in shell
    assert "from './app/App.jsx'" in (OPEN_GEN_ROOT / "src" / "main.jsx").read_text(encoding="utf-8")

    source = OPEN_GEN_ROOT / "src"
    image_studio = (source / "studios" / "ImageStudio.jsx").read_text(encoding="utf-8")
    video_studio = (source / "studios" / "VideoStudio.jsx").read_text(encoding="utf-8")
    private_bridge = (source / "lib" / "hivemindStudio.js").read_text(encoding="utf-8")
    pending_jobs = (source / "lib" / "pendingJobs.js").read_text(encoding="utf-8")

    # Generation history goes through the bridge, which keeps it in memory only
    # while the studio is embedded instead of writing it to localStorage.
    assert "loadStudioGenerationHistory" in image_studio
    assert "saveStudioGenerationHistory" in image_studio
    assert "loadStudioGenerationHistory" in video_studio
    assert "saveStudioGenerationHistory" in video_studio
    assert "hivemind-owner-lock" in private_bridge
    assert "clearHivemindStudioPrivateState" in private_bridge
    assert "localStorage.removeItem('muapi_history')" in private_bridge
    assert "localStorage.removeItem('video_history')" in private_bridge
    assert "sessionStorage" in pending_jobs
    assert "isHivemindStudioEnabled" in pending_jobs
    # Prompts and provider payloads must never reach the browser console.
    assert "[ImageStudio] Full response:" not in image_studio
    assert "[VideoStudio] Hivemind local response:" not in video_studio


def test_media_playback_proxies_never_cache_decrypted_images_or_videos() -> None:
    gateway_root = ROOT / "packages" / "media-gateway"
    python_gateway = (gateway_root / "app.py").read_text(encoding="utf-8")
    next_proxy = (gateway_root / "app" / "comfy" / "[[...path]]" / "route.js").read_text(encoding="utf-8")

    assert '"Cache-Control", "private, no-store, max-age=0"' in python_gateway
    assert "max-age=10800" not in next_proxy
    assert "private, no-store, max-age=0" in next_proxy


def test_stack_command_is_part_of_the_canonical_cli() -> None:
    args = build_parser().parse_args(["stack", "status"])

    assert args.command == "stack"
    assert args.action == "status"
