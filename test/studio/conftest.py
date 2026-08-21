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


@pytest.fixture(autouse=True)
def _no_marketplace_calls_from_tests(monkeypatch, request):
    """The test suite may never reach a GPU marketplace over the network.

    This is not hygiene, it is a bill. On 2026-08-14 a gap in one file's
    isolation let the suite call RunPod's live API during an offer search; the
    real catalog ranked into the assertions, and a create path went all the way
    through and RENTED EIGHT PODS at $0.69/hr. They were found and destroyed,
    but only because a later run happened to print a burn rate.

    Per-file fixtures could not have prevented that — the leak was a file that
    thought it had disabled the second provider and had not. So the block lives
    here, applies to every test, and is enforced at the transport functions
    themselves: a test that wants a marketplace fakes it explicitly (see
    _fake_vast, or the graphql/request patches in test_rental_providers.py),
    and anything that does not is an error rather than a purchase.
    """
    # The transport functions are themselves under test in a couple of places
    # (the rate-limit retry, the GraphQL error path). Those stub the HTTP
    # session underneath and never reach the network either, so they opt out by
    # name rather than being forced to route around the guard.
    if request.node.get_closest_marker("marketplace_transport"):
        return

    from hivemind_content_studio.rental_providers import runpod, vast

    def blocked(*_args, **_kwargs):
        raise AssertionError(
            "a test tried to call a GPU marketplace over the network — fake the "
            "provider's transport instead (see _fake_vast). This guard exists "
            "because an unfaked call once rented eight real machines."
        )

    monkeypatch.setattr(vast, "request", blocked)
    monkeypatch.setattr(runpod, "request", blocked)
    monkeypatch.setattr(runpod, "graphql", blocked)


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "marketplace_transport: test drives a provider's HTTP transport directly "
        "(stubs the session; exempt from the no-network guard)",
    )
