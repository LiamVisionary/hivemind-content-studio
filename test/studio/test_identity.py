"""The product's name and bundle id are written down once, or not at all.

Before `identity.py` the donor's name leaked into four places at once — the
desktop bundle id, the window title, two crash dialogs and the local-AI support
folder — and they disagreed with each other. These tests are what stops that
happening again.
"""

from __future__ import annotations

import json
from pathlib import Path

from hivemind_content_studio import identity


ROOT = Path(__file__).resolve().parents[2]
IDENTITY_JSON = ROOT / "packages" / "open-generative-ai" / "identity.json"

# Files that name the product for macOS, the packager or the user. Everything
# here must read the generated JSON rather than typing the bundle id.
JS_CONSUMERS = ("packages/open-generative-ai/hosted-server.js",)


def test_generated_identity_json_matches_the_module() -> None:
    assert IDENTITY_JSON.is_file(), "run: python -m hivemind_content_studio.identity --write"
    assert IDENTITY_JSON.read_text(encoding="utf-8") == identity.render_identity_json()
    payload = json.loads(IDENTITY_JSON.read_text(encoding="utf-8"))
    assert payload["bundleId"] == "ai.hivemindos.content-studio"
    assert payload["productName"] == "Hivemind Content Studio"


def test_the_bundle_id_is_typed_in_exactly_one_source_file() -> None:
    # The generated JSON is the module's own output, and this test file names the
    # id to assert it; every other hit would be a second copy waiting to drift.
    allowed = {
        "src/hivemind_content_studio/identity.py",
        "packages/open-generative-ai/identity.json",
        "desktop/src-tauri/tauri.conf.json",
        "test/studio/test_identity.py",
        "docs/RELEASE.md",
    }
    searched = ("src", "app", "packages", "scripts", "test", "docs", "desktop")
    offenders = []
    for root in searched:
        for path in (ROOT / root).rglob("*"):
            if not path.is_file() or "node_modules" in path.parts or "dist" in path.parts:
                continue
            if path.suffix not in {".py", ".js", ".cjs", ".mjs", ".jsx", ".json", ".md", ".toml", ".sh"}:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            if identity.BUNDLE_ID in text and str(path.relative_to(ROOT)) not in allowed:
                offenders.append(str(path.relative_to(ROOT)))
    assert offenders == [], f"read it from identity.json instead: {offenders}"


def test_no_donor_product_name_in_the_desktop_shell_or_the_bridge() -> None:
    for relative in JS_CONSUMERS:
        text = (ROOT / relative).read_text(encoding="utf-8")
        assert "Open Generative AI" not in text, relative
        assert "ai.generative.open" not in text, relative
        assert "identity" in text, f"{relative} should read the generated identity"


def test_the_desktop_shell_is_the_tauri_one_and_electron_is_gone() -> None:
    """One shell, and it reads the same identity as everything else.

    The Electron shell was a webview pointed at a launchd job: it started
    nothing, watched nothing and showed an empty window when the backend was
    absent. `desktop/src-tauri` replaces it, so nothing may reintroduce the
    Electron packaging alongside it.
    """
    open_gen = ROOT / "packages" / "open-generative-ai"
    package = json.loads((open_gen / "package.json").read_text(encoding="utf-8"))
    assert "build" not in package
    assert "main" not in package, "no Electron entry point"
    assert not any(name.startswith("electron") for name in package.get("devDependencies", {}))
    assert not any(name.startswith("electron:") for name in package.get("scripts", {}))
    for gone in ("electron", "electron-builder.config.cjs", "afterPack.js"):
        assert not (open_gen / gone).exists(), f"{gone} belongs to the retired Electron shell"

    config = json.loads((ROOT / "desktop" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    assert config["identifier"] == identity.BUNDLE_ID
    assert config["productName"] == identity.PRODUCT_NAME


def test_version_payload_names_the_product_its_licence_and_its_source() -> None:
    payload = identity.version_payload()
    assert payload["product"] == identity.PRODUCT_NAME
    assert payload["license"] == "AGPL-3.0-or-later"
    assert payload["source_url"].startswith("https://github.com/")
    assert set(payload) == {"product", "version", "commit", "license", "source_url", "build_date"}
    # No machine names, no paths, no tokens: this route is unauthenticated.
    assert "/Users/" not in json.dumps(payload)
