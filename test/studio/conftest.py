"""Shared studio test setup: private-state cipher without touching the Keychain,
and studio data/runs directories isolated from the real repository state."""

import pytest

from hivemind_content_studio import private_access


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
