"""Privacy contracts on the SHIPPED creative surfaces.

These two survive from the old test_studio_ui_contract.py. That file tested the
vanilla studio (src/hivemind_content_studio/ui/*, packages/open-generative-ai/
src/main.js, src/components/) which was retired in 2026-08; its other nineteen
tests read files that no longer exist and were deleted with it. These had
already been migrated to read the React studios and the media gateway, and they
assert something worth keeping: that prompts and outputs never reach persistent
browser storage, and that no proxy caches decrypted media.
"""
from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OPEN_GEN_ROOT = ROOT / "packages" / "open-generative-ai" / "src"


def test_embedded_creative_surfaces_keep_prompts_and_outputs_out_of_persistent_browser_storage() -> None:
    # The shipped React studios; the vanilla ones these used to read were
    # retired in 2026-08 (git history: src/components/).
    image_studio = (OPEN_GEN_ROOT / "studios" / "ImageStudio.jsx").read_text(encoding="utf-8")
    video_studio = (OPEN_GEN_ROOT / "studios" / "VideoStudio.jsx").read_text(encoding="utf-8")
    private_bridge = (OPEN_GEN_ROOT / "lib" / "hivemindStudio.js").read_text(encoding="utf-8")
    pending_jobs = (OPEN_GEN_ROOT / "lib" / "pendingJobs.js").read_text(encoding="utf-8")

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
    assert "[ImageStudio] Full response:" not in image_studio
    assert "[VideoStudio] Hivemind local response:" not in video_studio


def test_media_playback_proxies_never_cache_decrypted_images_or_videos() -> None:
    gateway_root = ROOT / "packages" / "media-gateway"
    # The gateway is app.py plus the modules under gateway/; reading only the
    # entry point would keep passing after the header it asserts on moved.
    python_gateway = "\n".join(
        path.read_text(encoding="utf-8")
        for path in [gateway_root / "app.py", *sorted((gateway_root / "gateway").glob("*.py"))]
    )
    next_proxy = (gateway_root / "app" / "comfy" / "[[...path]]" / "route.js").read_text(encoding="utf-8")

    assert '"Cache-Control", "private, no-store, max-age=0"' in python_gateway
    assert "max-age=10800" not in next_proxy
    assert "private, no-store, max-age=0" in next_proxy
