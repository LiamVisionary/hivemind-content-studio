"""Shared studio test setup: private-state cipher without touching the Keychain,
and studio data/runs directories isolated from the real repository state."""

import re
from dataclasses import dataclass
from pathlib import Path

import pytest

from hivemind_content_studio import private_access


OPEN_GEN_DIST = Path(__file__).resolve().parents[2] / "packages" / "open-generative-ai" / "dist"
_ENTRY_SCRIPT = re.compile(r'<script[^>]+type="module"[^>]+src="\.?/?(assets/[^"]+\.js)"')
_STYLESHEET = re.compile(r'<link[^>]+rel="stylesheet"[^>]+href="\.?/?(assets/[^"]+\.css)"')
# Probe path for an unbuilt checkout. Only usable while locked, where the owner
# gate 401s it before the /assets mount is reached: with dist/ absent, Starlette
# raises on the first request that gets through instead of returning 404.
_UNBUILT_SCRIPT = "/assets/index-not-built.js"


@dataclass(frozen=True)
class UnifiedFrontend:
    """The Vite build that control_api serves at "/" and mounts on /assets.

    packages/open-generative-ai/dist is gitignored, so it only exists after
    `npm --prefix packages/open-generative-ai run vite:build`. Tests assert the
    served contract for whichever state the checkout is in rather than assuming
    a build artifact is present.
    """

    built: bool
    script_path: str
    stylesheet_path: str = ""


@pytest.fixture
def unified_frontend() -> UnifiedFrontend:
    index = OPEN_GEN_DIST / "index.html"
    if not index.is_file():
        return UnifiedFrontend(built=False, script_path=_UNBUILT_SCRIPT)
    html = index.read_text(encoding="utf-8")
    script = _ENTRY_SCRIPT.search(html)
    stylesheet = _STYLESHEET.search(html)
    assert script, "the built shell must load its hashed module bundle from /assets"
    return UnifiedFrontend(
        built=True,
        script_path=f"/{script.group(1)}",
        stylesheet_path=f"/{stylesheet.group(1)}" if stylesheet else "",
    )


@pytest.fixture(autouse=True)
def _test_private_cipher(monkeypatch, tmp_path_factory):
    monkeypatch.setenv("CONTENT_STUDIO_PRIVATE_SECRET", "test-private-state-secret")
    isolated = tmp_path_factory.mktemp("studio-data")
    monkeypatch.setenv("CONTENT_STUDIO_DATA_DIR", str(isolated))
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(isolated / "runs"))
    private_access.configure_private_cipher(None)
    yield
    private_access.configure_private_cipher(None)
