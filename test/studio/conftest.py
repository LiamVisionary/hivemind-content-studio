"""Shared studio test setup: private-state cipher without touching the Keychain,
and studio data/runs directories isolated from the real repository state."""

import os
import re
from dataclasses import dataclass
from pathlib import Path

import passbook
import pytest

from hivemind_content_studio import (
    gpu_rentals, hivemindos_models, mtplx_server, private_access, provider_models,
    shared_env,
)


OPEN_GEN_DIST = Path(__file__).resolve().parents[2] / "packages" / "open-generative-ai" / "dist"
_ENTRY_SCRIPT = re.compile(r'<script[^>]+type="module"[^>]+src="\.?/?(assets/[^"]+\.js)"')
_STYLESHEET = re.compile(r'<link[^>]+rel="stylesheet"[^>]+href="\.?/?(assets/[^"]+\.css)"')
# Probe path for an unbuilt checkout. Only usable while locked, where the owner
# gate 401s it before the /assets mount is reached: with dist/ absent, Starlette
# raises on the first request that gets through instead of returning 404.
_UNBUILT_SCRIPT = "/assets/index-not-built.js"


@pytest.fixture(autouse=True)
def _restore_process_env():
    """Undo direct writes to os.environ that monkeypatch cannot see.

    `apply_shared_hive_env()` sets variables straight into `os.environ` — that is
    its entire job — and monkeypatch only restores what monkeypatch itself
    changed. So any test that triggers it leaves those variables set for every
    test that runs afterwards, and an assertion that a key is ABSENT then passes
    or fails depending on the order pytest happened to pick.

    That is not hypothetical: test_broker_integration.py passed on its own and
    failed four ways in the full suite, and the first reading of it was a product
    bug rather than a leaked variable. Restoring here makes the order stop
    mattering. Declared first so it wraps the other autouse fixtures and returns
    the environment to its true baseline last.
    """
    snapshot = dict(os.environ)
    yield
    for key in set(os.environ) - set(snapshot):
        del os.environ[key]
    for key, value in snapshot.items():
        if os.environ.get(key) != value:
            os.environ[key] = value


@pytest.fixture(autouse=True)
def _no_test_stamps_the_machines_access_ledger():
    """Keep the suite out of the machine's real credential record.

    `passbook.set_recorder()` is process-global, so monkeypatch cannot undo it.
    `build_control_app()` arms it through `enable_access_stamps()`, and
    test_gpu_rentals_api's `test_account_state_reports_burn_and_runway` calls
    `monkeypatch.undo()` — which drops every patch it has, the autouse redirect
    that keeps this suite off the real store included — and then builds an app.
    From that test onwards the machine's REAL hash-chained ledger was armed for
    the rest of the run, and since the redirect points every later read at a
    store that does not exist, each one came back empty and was stamped as a
    DENIED read by this app: 45 rows per run, 37 of them for the same key.

    In `passbook access` that is indistinguishable from the studio polling for
    a credential it has no grant for, in bursts, as pytest walks the files —
    and it was diagnosed as exactly that. Cleared before and after each test,
    so none inherits an armed recorder and none leaves one behind; a test that
    wants stamping arms it itself. Same reason `_restore_process_env` exists:
    process-global state that monkeypatch does not know it changed.
    """
    passbook.set_recorder(None)
    yield
    passbook.set_recorder(None)


@pytest.fixture(autouse=True)
def _forget_credential_refusals(monkeypatch) -> None:
    """Each test starts with `request_credential`'s refusal memory empty.

    The backoff is process state on purpose — in the studio a refusal answered
    from memory is the fix for a status poll hammering the machine's access
    ledger. Across tests it is ordering poison: the sealed-store test feeds the
    memory for HIVEMINDOS_DASHBOARD_DEVICE_TOKEN, and the unsealed-store test
    that runs seconds later gets the remembered refusal instead of its own
    store's value.
    """
    monkeypatch.setattr(shared_env, "_refused", {})


@pytest.fixture(autouse=True)
def _isolate_shared_hive_env(monkeypatch) -> None:
    """Keep the developer's real ~/.hivemindos/.env out of the suite.

    `apply_shared_hive_env()` fills any variable the process does not already
    have, and `load_config()` calls it — so a test that does
    `monkeypatch.delenv("XAI_API_KEY")` and then asks a provider whether it is
    ready gets the key put straight back from the real shared env, and the
    assertion passes or fails depending on whose machine it runs on. That is
    exactly what happened to
    test_providers::test_openai_and_xai_media_readiness_uses_the_correct_auth_surface,
    which failed only for owners who have XAI_API_KEY in the shared file.

    HIVE_ENV_FILES is the loader's own override, so pointing it at a path that
    does not exist neutralises the fallback for the whole suite without
    reaching into the module.
    """
    monkeypatch.setenv("HIVE_ENV_FILES", str(Path(__file__).parent / "no-such-shared.env"))


@pytest.fixture(autouse=True)
def _private_cipher_needs_no_keychain(monkeypatch) -> None:
    """Give private state a test secret so nothing reaches the macOS Keychain.

    `PrivateFieldCipher.from_keychain()` shells out to /usr/bin/security and,
    when there is no entry, CREATES one. On Linux that raises; under a sandboxed
    HOME it hangs until the 10s timeout. Either way a test that merely builds
    the app without handing it a cipher took the suite down for reasons that
    have nothing to do with what it was testing.
    """
    monkeypatch.setenv(private_access.PRIVATE_SECRET_ENV, "test-private-state-secret")


@pytest.fixture(autouse=True)
def _rental_key_is_a_test_key(monkeypatch, tmp_path_factory) -> None:
    """Give the rentals API a throwaway SSH identity instead of the developer's.

    `RENTAL_SSH_KEY` points at ~/.hivemindos/gpu-rentals-ssh/vast_ed25519, which
    exists on a machine that has rented before and nowhere else — so 52 rental
    tests passed locally and 503'd on CI with "rental SSH key missing". The
    suite must not depend on a key the developer happens to have, and must never
    read the real one: a test that signs with the live identity is one bad mock
    away from touching a real host.
    """
    directory = tmp_path_factory.mktemp("rental-ssh")
    public = directory / "test_ed25519.pub"
    public.write_text("ssh-ed25519 AAAATESTKEYFORTHESUITE test@studio\n", encoding="utf-8")
    monkeypatch.setattr(gpu_rentals, "RENTAL_SSH_KEY", directory / "test_ed25519")
    monkeypatch.setattr(gpu_rentals, "RENTAL_SSH_PUBKEY", public)


@pytest.fixture(autouse=True)
def _isolate_hivemindos_models(monkeypatch) -> None:
    """No test may reach the HivemindOS app running on this machine.

    Clearing HIVEMINDOS_DASHBOARD_DEVICE_TOKEN does NOT do it — the reader falls
    back to ~/.hivemindos/.env, which exists on a developer's machine and holds a
    live token. That is the same shape of trap that once let the suite rent real
    GPUs: the isolation has to block the transport, not the variable. So the
    reader itself is replaced and the base URL is pointed at a port nothing
    serves; a test that wants a reachable HivemindOS patches both back
    explicitly, and a call that spends real credits cannot happen by accident.
    """
    monkeypatch.setattr(hivemindos_models, "_dashboard_token", lambda: "")
    monkeypatch.setenv("HIVEMINDOS_URL", "http://127.0.0.1:9")
    # And the hosted gateway behind it. Blocking only the local app would have
    # left every test free to reach the real service over the internet — which
    # is where the paid models and the metered free tier are.
    monkeypatch.setenv("HIVEMINDOS_GATEWAY_URL", "https://127.0.0.1:9")
    # And the app's own credit vault in ~/.hivemindos, which the studio can read
    # to link a balance without being asked. A developer's real vault would make
    # "is an account connected?" answer differently on their machine than in CI.
    monkeypatch.setenv("HIVEMINDOS_HOME", str(Path(__file__).parent / "no-such-hivemindos"))


@pytest.fixture(autouse=True)
def _isolate_provider_accounts(monkeypatch) -> None:
    """No test may spend the developer's own OpenAI, ChatGPT or OpenRouter account.

    The producer can now run on the owner's provider accounts, and those
    credentials are read from the machine's shared store AND from the process
    environment — so on a developer's machine `status()` finds six live accounts
    and asks each one for its catalog with a real key. That is the same shape as
    the leak that once rented eight GPUs: the variable is not the boundary, the
    CREDENTIAL READ is.

    So both seams are blocked. `stored_names()` reports nothing connected, which
    stops discovery before it starts, and `credential()` returns nothing, which
    stops any call that got past it from carrying a key. A test that wants a
    connected provider patches these back with fake values, and one that forgets
    gets "not connected" rather than a live request on someone's bill.

    The catalog cache is cleared around every test as well: it is module state
    with a ten-minute TTL, so one test's fake OpenRouter would otherwise still
    be the answer several tests later.
    """
    provider_models.forget_cache()
    monkeypatch.setattr(provider_models, "stored_names", lambda: set())
    monkeypatch.setattr(provider_models, "credential", lambda name, reason="": "")
    # And the popularity sweep, which is a background thread over 400+ live URLs.
    # A test must neither start one nor be ranked by whatever the developer's
    # machine happens to have cached — a test that passes because of a file in
    # ~/data is a test that fails in CI.
    monkeypatch.setattr(provider_models, "popularity", lambda **_: {})
    yield
    provider_models.forget_cache()


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


@pytest.fixture(autouse=True)
def _no_ssh_probes_from_tests(monkeypatch, request):
    """No test may open a real SSH connection while probing a rental's door.

    The studio reads an endpoint's SSH banner before it will call a machine
    reachable — an accepted TCP connection proved nothing, which is how a box
    fronted by Vast's Jupyter HTTPS port passed for ready on 2026-08-24. That
    probe runs on the ordinary Machines poll, so without this guard every DTO
    test dials the addresses its fixtures invent: 1.2.3.4 and friends, a
    3-second timeout apiece at best and a stranger's machine at worst.

    The default is a door that answers, because that is the uninteresting case
    every other test is built on. A test that wants a shut door, or a port
    serving something that is not SSH, patches _ssh_banner_fault itself.
    """
    if request.node.get_closest_marker("ssh_probe_transport"):
        return

    from hivemind_content_studio import gpu_rentals

    gpu_rentals._ssh_probe_cache.clear()
    monkeypatch.setattr(gpu_rentals, "_ssh_banner_fault",
                        lambda host, port, timeout=3.0, cache=False: None)
    # Reading a mute box's beacon shells out to ssh, which is the same network
    # by another route. Default: the door is there and has nothing to say, so a
    # test that wants a beacon fetches it over HTTP like every other one.
    monkeypatch.setattr(gpu_rentals, "_beacon_over_ssh",
                        lambda endpoint, timeout=5.0: None)


@pytest.fixture(autouse=True)
def _no_r2_publishes_from_tests(monkeypatch):
    """Generating a rental onstart PUTs to the private bucket. No test may.

    Every boot-time payload — the weights manifest, the TensorRT node pack —
    goes through `_publish_rental_object`, so blocking it there covers all of
    them, including the next one. Recorded rather than refused: a dozen tests
    legitimately generate an onstart and none of them care where the payload
    went, so making them all opt in would be ceremony. What matters is that the
    bytes stop here.

    Before this existed the onstart-size tests wrote a real manifest to R2 on
    every CI run, because the opt-in `rental_manifest` fixture only covered the
    tests that asked for it.
    """
    from hivemind_content_studio import gpu_rentals

    recorded = {"objects": [], "real_publish": gpu_rentals._publish_rental_object}

    def fake_publish(data, *, suffix, content_type, label):
        recorded["objects"].append({"data": data, "suffix": suffix, "label": label})
        return f"https://r2.example/rental-manifests/test{suffix}?X-Amz-Signature=m"

    monkeypatch.setattr(gpu_rentals, "_publish_rental_object", fake_publish)
    return recorded


@pytest.fixture
def rental_manifest(_no_r2_publishes_from_tests):
    """What the onstart would have published for the weights manifest.

    `rental_manifest["text"]` is the tab-separated manifest and `["url"]` the
    presigned GET the onstart carries. A view over the autouse recorder above,
    so requesting it changes nothing about isolation — it only reads."""
    recorded = _no_r2_publishes_from_tests

    class _Manifest:
        url = "https://r2.example/rental-manifests/test.tsv?X-Amz-Signature=m"

        def _rows(self):
            return [item for item in recorded["objects"] if item["suffix"] == ".tsv"]

        def __getitem__(self, key):
            if key == "text":
                rows = self._rows()
                return rows[-1]["data"].decode("utf-8") if rows else None
            if key == "url":
                return self.url
            if key == "calls":
                return len(self._rows())
            if key == "real_publish":
                # The real MANIFEST publisher, for the tests that exercise the
                # transport itself: it goes through the real object publisher
                # (which those tests fake at requests.put), not the recorder.
                def publish(text):
                    return recorded["real_publish"](
                        text.encode("utf-8"),
                        suffix=".tsv",
                        content_type="text/tab-separated-values",
                        label="weights manifest",
                    )
                return publish
            raise KeyError(key)

    return _Manifest()


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "marketplace_transport: test drives a provider's HTTP transport directly "
        "(stubs the session; exempt from the no-network guard)",
    )
    config.addinivalue_line(
        "markers",
        "ssh_probe_transport: test drives the SSH banner probe directly against a "
        "loopback socket (exempt from the no-ssh-probe guard)",
    )


@pytest.fixture(autouse=True)
def _isolate_mtplx(monkeypatch):
    """Keep the suite hermetic on a machine with a live MTPLX server.

    The prompt helper adopts the shared ~/.hivemindos MTPLX slot (state file,
    :8001 probe, HF-cache candidate scan). Real-machine state must not leak
    into assertions — and a first candidate sweep runs `mtplx inspect`, which
    is far too slow for a test. The MTPLX-specific tests re-patch these seams
    on top with their own fakes.
    """
    monkeypatch.setattr(mtplx_server, "mtplx_available", lambda: False)
    monkeypatch.setattr(mtplx_server, "read_mtplx_state", lambda: None)
    monkeypatch.setattr(mtplx_server, "probe_served_model", lambda port, timeout=1.5: None)
    monkeypatch.setattr(mtplx_server, "list_mtplx_candidates", lambda: [])
    monkeypatch.setattr(mtplx_server, "mtplx_owns_model", lambda model: False)
