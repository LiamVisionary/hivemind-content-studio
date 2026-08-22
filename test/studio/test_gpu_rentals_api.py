from __future__ import annotations

import contextlib
import hashlib
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio import gpu_rentals
from hivemind_content_studio.rental_providers import RentalRef
from hivemind_content_studio.rental_providers import runpod as runpod_provider
from hivemind_content_studio.rental_providers import vast as vast_provider
from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore

@pytest.fixture(autouse=True)
def _isolate_offer_cache():
    """The offer and balance caches are module-level (real behaviour: the
    Machines view asks for every tier at once and Vast rate-limits). Tests must
    not inherit them."""
    gpu_rentals._offer_cache.clear()
    gpu_rentals._balance_cache.update(at=0.0, value=None)
    yield
    gpu_rentals._offer_cache.clear()
    gpu_rentals._balance_cache.update(at=0.0, value=None)


@pytest.fixture(autouse=True)
def _isolated_media_state(tmp_path: Path, monkeypatch):
    """_onstart_script and tier_download_gb read the rental-LoRA registry under
    MEDIA_STATE_ROOT; no test may see the developer machine's real one (or
    another test's). Tests that care about the path still override it."""
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "media-state-default")
    gpu_rentals._rental_lora_progress.clear()
    yield
    gpu_rentals._rental_lora_progress.clear()


@pytest.fixture(autouse=True)
def _vast_is_the_only_marketplace(monkeypatch):
    """This file drives Vast. Nothing here may reach a second marketplace.

    Not an env var, because clearing one does not hold: build_control_app
    re-applies the shared hive env, so a RUNPOD key deleted before _client()
    is back by the time an offer search runs — which is exactly what happened,
    and the suite quietly made live RunPod API calls and ranked their real
    prices into these assertions. Disabling the provider is the seam that
    cannot be undone from underneath. test_rental_providers.py is where two
    marketplaces at once is covered.
    """
    monkeypatch.setattr(runpod_provider.RunPodProvider, "configured", lambda self: False)


@pytest.fixture(autouse=True)
def _funded_account(monkeypatch):
    """Renting checks the credit first. That is its own seam so the tests
    about renting do not all have to fake a bank balance; the tests about the
    credit gate override this."""
    funded = {
        "credit": 500.0, "usd_per_hour_running": 0.0,
        "hours_remaining": None, "machines_running": 0,
        # Per marketplace, because that is what the affordability gate checks:
        # Vast credit cannot pay a RunPod bill, so the aggregate above is not
        # what authorizes a rental.
        "providers": [{
            "provider": "vast", "label": "Vast.ai", "credit_url": "vast.ai",
            "credit": 500.0, "usd_per_hour_running": 0.0,
            "hours_remaining": None, "machines_running": 0,
        }],
    }
    monkeypatch.setattr(gpu_rentals, "account_state", lambda *_args, **_kw: funded)


STUDIO_LABEL = f"{gpu_rentals.STUDIO_LABEL_PREFIX}image-abc123"
FOREIGN_LABEL = "hivemind-rental-gpur_7645876459824d0f8b89"


def _client(tmp_path: Path, monkeypatch, *, unlock: bool = True) -> TestClient:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    approvals = ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret")
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    owner_access = OwnerAccess.for_testing(password="test-owner-password", cipher=cipher)
    app = build_control_app(
        orchestrator=orchestrator,
        approvals=approvals,
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=owner_access,
        private_cipher=cipher,
    )
    client = TestClient(app)
    if unlock:
        response = client.post("/api/owner/unlock", json={"password": "test-owner-password"})
        assert response.status_code == 200
    return client


def _vast_instance(raw: dict):
    """A raw Vast listing as the studio now sees it.

    The provider normalizes API shapes into an Instance before anything in
    gpu_rentals touches them, so a DTO test that hand-built a dict would be
    testing a shape that no longer reaches the code under test. Going through
    the real normalizer keeps these tests honest about Vast's own field names.
    """
    return vast_provider.VastProvider()._instance(raw)


def _fake_vast(monkeypatch, handler) -> list[tuple[str, str, dict | None]]:
    """Fake the Vast marketplace at its HTTP boundary.

    Patched on the provider module rather than on gpu_rentals: the transport
    moved there when a second marketplace arrived, and this is still the right
    seam — everything above it (tier filters, ranking, provisioning, attach) is
    the code under test, and everything below it is Vast's server.
    """
    calls: list[tuple[str, str, dict | None]] = []

    def fake(method: str, path: str, payload: dict | None = None) -> dict:
        calls.append((method, path, payload))
        return handler(method, path, payload)

    monkeypatch.setattr(vast_provider, "request", fake)
    # A key has to LOOK present or the provider reports itself unconfigured and
    # is skipped before the fake is ever reached. RunPod is held off by the
    # _vast_is_the_only_marketplace fixture, not by an env var.
    monkeypatch.setenv("VAST_API_KEY", "test-vast-key")
    return calls


def test_gpu_rental_routes_require_owner(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch, unlock=False)
    assert client.get("/api/gpu-rentals").status_code == 401
    assert client.get("/api/gpu-rentals/offers").status_code == 401
    assert client.post("/api/gpu-rentals", json={}).status_code == 401
    assert client.delete("/api/gpu-rentals/123").status_code == 401
    assert client.delete("/api/gpu-rentals/failures").status_code == 401
    assert client.delete("/api/gpu-rentals/failures/vast:123").status_code == 401


def test_offers_filters_and_shape(tmp_path: Path, monkeypatch) -> None:
    def handler(method, path, payload):
        assert (method, path) == ("POST", "/v0/bundles/")
        # Verified, but NOT datacenter-only — that key closed the H3 rung
        # against a market with dozens of boxes in it. See _offer_query.
        assert "datacenter" not in payload
        assert payload["verified"] == {"eq": True}
        # One query covers the tier's whole GPU ladder — three per-class
        # queries per tier would triple the calls behind a polling view.
        assert payload["gpu_name"]["in"] == [
            "RTX 4090", "RTX 5090", "RTX PRO 6000 WS", "RTX PRO 6000 S"]
        # The disk we filter on is the disk we price on is the disk we rent:
        # dph_total is quoted from allocated_storage, and leaving it at Vast's
        # 8GB default under-quoted every H3 box by the cost of 112GB.
        assert payload["allocated_storage"] == payload["disk_space"]["gt"] == gpu_rentals.tier_disk_gb("image")
        return {"offers": [{"id": 1, "gpu_name": "RTX 5090", "dph_total": 0.402, "gpu_ram": 32607,
                            "inet_down": 755.0, "reliability2": 0.9942, "geolocation": "South Korea, KR"}]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.get("/api/gpu-rentals/offers?tier=image").json()
    assert body["tier"] == "image"
    assert body["offers"][0] == {
        "offer_id": "1", "provider": "vast", "provider_label": "Vast.ai",
        "gpu": "RTX 5090", "gpu_class": "rtx5090", "vram_mb": 32607,
        "usd_per_hour": 0.402, "down_mbps": 755.0, "reliability": 0.9942,
        "geolocation": "South Korea, KR", "dlperf": None,
        # Time to first generation on THIS host, from the tier's download volume.
        "setup_minutes": 4.6, "warm": False,
        # A listing with no cpu_ram says nothing about the box; None, not 0.
        "ram_gb": None,
        # Reported so the view can label hosting type, not filtered on.
        "datacenter": False,
    }


def test_offer_ram_is_the_containers_share_not_the_machines(tmp_path: Path, monkeypatch) -> None:
    """A headline 145GB host sold in eighths hands the container ~18GB.

    On a search offer cpu_ram is the whole machine and gpu_frac is the slice
    this rental buys. Reporting the headline is how a box with 17.7GiB of
    usable RAM read as a 141GB machine."""
    # The eighth of a 141GB machine that started all this. It no longer reaches
    # the DTO — every tier now has a RAM floor and 17.7GiB clears none of them —
    # so the arithmetic is pinned on the function itself.
    assert round(vast_provider._offer_ram_gb({"cpu_ram": 145088, "gpu_frac": 0.125}), 1) == 17.7

    def handler(method, path, payload):
        # A 503GB machine, also sold in eighths: ~63GiB, not 503.
        return {"offers": [{"id": 1, "gpu_name": "RTX 5090", "dph_total": 0.62, "inet_down": 9000,
                            "cpu_ram": 515815, "gpu_frac": 0.125}]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    offer = client.get("/api/gpu-rentals/offers?tier=image").json()["offers"][0]
    assert offer["ram_gb"] == 63.0


def test_offers_drop_boxes_that_cannot_hold_the_weights_in_system_ram(
    tmp_path: Path, monkeypatch
) -> None:
    """MiniMax H3 stages a 20GB DiT and a 15GB encoder through system RAM.

    Measured 2026-08-13 on a rented 5090 whose container had 29.2GiB: a 5s
    reference clip rendered (21.05GiB VRAM peak), and a 10s one KILLED the
    ComfyUI process outright, system RAM peaking at 27.12GiB. The job did not
    fail — the server died — so this is a hard drop, not a ranking preference.
    Tiers without a min_ram_gb are unaffected."""
    def handler(method, path, payload):
        return {"offers": [
            # 141GB machine sold in eighths: 17.7GiB, nowhere near enough.
            {"id": 20, "gpu_name": "RTX 5090", "dph_total": 0.62, "inet_down": 9000,
             "cpu_ram": 145088, "gpu_frac": 0.125},
            # Whole 30.5GiB machine — the exact size that died.
            {"id": 21, "gpu_name": "RTX 5090", "dph_total": 0.70, "inet_down": 9000,
             "cpu_ram": 31196, "gpu_frac": 1.0},
            {"id": 22, "gpu_name": "RTX 5090", "dph_total": 0.95, "inet_down": 9000,
             "cpu_ram": 515815, "gpu_frac": 0.125},
        ]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    minimax = client.get("/api/gpu-rentals/offers?tier=minimax").json()["offers"]
    assert [o["offer_id"] for o in minimax] == ["22"], "only the 62.9GiB box can hold H3"
    # The image tier states no measured floor, so it falls back to its VRAM
    # floor (24GB): the 17.7GiB eighth still cannot stage the weights, but the
    # 30.5GiB box that was too small for H3 is fine for Krea2.
    image = client.get("/api/gpu-rentals/offers?tier=image").json()["offers"]
    assert {o["offer_id"] for o in image} == {"21", "22"}


def test_hosting_type_is_reported_not_required(tmp_path: Path, monkeypatch) -> None:
    """Datacenter is a label on an offer, not a condition of seeing one.

    Requiring it cut the verified single-GPU 5090 market from 45 offers to 9
    (measured live 2026-08-14), and those 9 are datacenter *because* they are
    big machines sold in fractions — so on the H3 tier the RAM guard then
    dropped every one of them and the rung read as sold out."""
    def handler(method, path, payload):
        assert "datacenter" not in payload
        return {"offers": [
            {"id": 50, "gpu_name": "RTX 5090", "dph_total": 0.44, "inet_down": 9000,
             "cpu_ram": 63800, "gpu_frac": 1.0, "hosting_type": 0},
            {"id": 51, "gpu_name": "RTX 5090", "dph_total": 0.67, "inet_down": 9000,
             "cpu_ram": 63800, "gpu_frac": 1.0, "hosting_type": 1},
        ]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    offers = client.get("/api/gpu-rentals/offers?tier=minimax").json()["offers"]
    # Both survive, and cheapest-first still leads with the non-datacenter box.
    assert [(o["offer_id"], o["datacenter"]) for o in offers] == [("50", False), ("51", True)]


def test_a_rung_the_post_filters_empty_relaxes_instead_of_reporting_none(
    tmp_path: Path, monkeypatch
) -> None:
    """A non-empty RESPONSE is not a rentable rung.

    The search used to stop at the first floor Vast answered at all. On the H3
    tier that answer was five fractional boxes too small to hold the weights,
    min_ram_gb emptied the rung afterwards, and the lower floors — where the
    whole machines are — were never asked."""
    floor = gpu_rentals.tier_min_down_mbps("minimax")
    asked: list[int] = []

    def handler(method, path, payload):
        want = payload["inet_down"]["gt"]
        asked.append(want)
        if want == floor:
            # Fast links, but eighths of a 141GB machine: 17.7GiB each.
            return {"offers": [
                {"id": 30 + i, "gpu_name": "RTX 5090", "dph_total": 0.62,
                 "inet_down": 9000, "cpu_ram": 145088, "gpu_frac": 0.125}
                for i in range(5)
            ]}
        # Slower link, whole machine — the one that can actually be rented.
        return {"offers": [{"id": 40, "gpu_name": "RTX 5090", "dph_total": 0.44,
                            "inet_down": 1929, "cpu_ram": 63800, "gpu_frac": 1.0}]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.get("/api/gpu-rentals/offers?tier=minimax").json()
    assert asked[0] == floor, "the strict floor is still tried first"
    assert len(asked) > 1, "a rung emptied by the post-filters must try a lower floor"
    assert [o["offer_id"] for o in body["offers"]] == ["40"]
    # And the floor it reports is the one that actually produced the offers.
    assert body["min_down_mbps"] == floor // 2


def test_offers_drop_half_power_skus_sold_under_the_same_name(tmp_path: Path, monkeypatch) -> None:
    """A 300W Max-Q and a 600W workstation card both list as RTX PRO 6000 WS.

    Ranking is by price and the Max-Q is always the cheapest of the two, so
    without this filter the top rung of the slider hands out a card that
    generates slower than the rung below it (measured 2026-08-10: 47.9s vs
    40.0s on the 5090) for 2.3x the hourly price."""
    def handler(method, path, payload):
        return {"offers": [
            {"id": 10, "gpu_name": "RTX PRO 6000 WS", "dph_total": 1.42, "inet_down": 9000,
             "dlperf": 142.9},   # Max-Q: 0.51 of the class median
            {"id": 11, "gpu_name": "RTX PRO 6000 S", "dph_total": 1.74, "inet_down": 9000,
             "dlperf": 278.9},   # server edition, on the median
            {"id": 12, "gpu_name": "RTX 5090", "dph_total": 0.72, "inet_down": 9000,
             "dlperf": 160.3},   # an unremarkable 5090 host, 0.81 of ITS median — keep
            {"id": 13, "gpu_name": "RTX 5090", "dph_total": 0.68, "inet_down": 9000},
        ]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    offers = client.get("/api/gpu-rentals/offers?tier=minimax").json()["offers"]
    ids = [offer["offer_id"] for offer in offers]
    assert "10" not in ids, "half-power Max-Q must not be offered as a PRO 6000"
    assert "11" in ids
    # A merely slower-than-median host of the right SKU still qualifies, and an
    # unbenchmarked one is not evidence of anything.
    assert "12" in ids and "13" in ids
    assert next(o for o in offers if o["offer_id"] == "11")["dlperf"] == 278.9


def test_offers_skip_a_host_that_just_failed_us(tmp_path: Path, monkeypatch) -> None:
    """Cheapest-first ranking walks straight back onto a bad host.

    Nothing about a machine's listing changes when it wedges — it keeps the
    reliability score that let it through in the first place (2026-08-11: the
    host that never started a container was above the 0.99 filter). Only our
    own experience of it is evidence, so a recorded failure has to take that
    machine out of the running for a while."""
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "media-state")
    (tmp_path / "media-state").mkdir(parents=True, exist_ok=True)
    gpu_rentals._write_failure_state({
        "seen": {},
        "log": [{"rental_id": 1, "machine_id": 144917, "destroyed_at": time.time()}],
    })

    def handler(method, path, payload):
        return {"offers": [
            {"id": 20, "gpu_name": "RTX 5090", "dph_total": 0.056, "inet_down": 9000, "machine_id": 144917},
            {"id": 21, "gpu_name": "RTX 5090", "dph_total": 0.39, "inet_down": 9000, "machine_id": 999},
        ]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    offers = client.get("/api/gpu-rentals/offers?tier=minimax").json()["offers"]
    ids = [offer["offer_id"] for offer in offers]
    assert "20" not in ids, "the machine that just failed must not be the top pick again"
    assert ids == ["21"]

    # The cooldown expires: a host with one bad day is not blacklisted forever.
    gpu_rentals._write_failure_state({
        "seen": {},
        "log": [{"rental_id": 1, "machine_id": 144917,
                 "destroyed_at": time.time() - gpu_rentals.BAD_MACHINE_COOLDOWN_SECONDS - 60}],
    })
    gpu_rentals._offer_cache.clear()
    ids = [o["offer_id"] for o in client.get("/api/gpu-rentals/offers?tier=minimax").json()["offers"]]
    assert "20" in ids


def test_the_shared_blocklist_is_merged_but_never_blocks_renting(tmp_path: Path, monkeypatch) -> None:
    """The hosted gateway rents from the SAME Vast account, so a machine that
    wedged a customer is hardware we will meet too. Merging its list is worth
    one request — but only if it can never be the reason a rental fails, so a
    slow or dead gateway fails open to the local list alone."""
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    gpu_rentals._write_failure_state({"seen": {}, "log": []})
    monkeypatch.setenv("HIVEMIND_GPU_RENTALS_GATEWAY_URL", "https://rentals.example/")

    class Response:
        status_code = 200
        def raise_for_status(self): return None
        def json(self):
            return {"ok": True, "machines": [
                {"machineId": 5150, "hostId": 77},
                {"machineId": 5151, "hostId": None},
            ]}

    monkeypatch.setattr(gpu_rentals.requests, "get", lambda *_a, **_k: Response())
    # Machines AND their hosts come across: one bad host, several bad machines.
    assert gpu_rentals.recent_bad_machine_ids() == {5150, 77, 5151}

    # A gateway that is down, slow, or serving nonsense leaves renting working.
    def explode(*_args, **_kwargs):
        raise OSError("gateway unreachable")

    monkeypatch.setattr(gpu_rentals.requests, "get", explode)
    assert gpu_rentals.recent_bad_machine_ids() == set()

    # And with no gateway configured nothing is fetched at all.
    monkeypatch.delenv("HIVEMIND_GPU_RENTALS_GATEWAY_URL")
    monkeypatch.setattr(gpu_rentals.requests, "get",
                        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("must not call out")))
    assert gpu_rentals.recent_bad_machine_ids() == set()


def test_a_box_that_never_boots_its_container_is_called_out(tmp_path: Path, monkeypatch) -> None:
    """"Booting host" has no natural end, and that is the whole problem.

    Vast reports the INSTANCE running from the moment the host takes the
    contract — long before the image is unpacked and a container exists. With
    no container there is no beacon, so nothing can report a failure, and the
    studio sits on a hopeful progress step while the meter runs (measured
    2026-08-11: 43 minutes, SSH port never opened, instance "loading"
    throughout). The port answering is the honest signal."""
    booting = {"id": 7, "label": f"{gpu_rentals.STUDIO_LABEL_PREFIX}minimax-rtx5090-x",
               "actual_status": "loading", "public_ipaddr": "9.9.9.9", "machine_id": 144917,
               "ssh_host": "ssh4.vast.ai", "ssh_port": "36124"}

    # Freshly booting: slow is not stalled, whatever the port says.
    monkeypatch.setattr(gpu_rentals, "_container_ssh_open", lambda *_a, **_k: False)
    dto = gpu_rentals._instance_dto(_vast_instance({**booting, "start_date": time.time() - 60}), probe=True)
    assert dto["phase"] == "booting"

    # Past the deadline with the port still shut: terminal, and it says why.
    dto = gpu_rentals._instance_dto(_vast_instance({**booting, "start_date": time.time() - gpu_rentals.BOOT_STALL_SECONDS - 60}), probe=True)
    assert dto["phase"] == "error", "a container that never came up is not still booting"
    assert "never started this container" in dto["provision"]["detail"]
    assert "destroy it and rent again" in dto["provision"]["detail"]
    # Carried so the reaper can remember the HOST, not just the rental.
    assert dto["machine_id"] == 144917

    # Same age, but the container did come up — it is provisioning, not wedged.
    monkeypatch.setattr(gpu_rentals, "_container_ssh_open", lambda *_a, **_k: True)
    dto = gpu_rentals._instance_dto(_vast_instance({**booting, "start_date": time.time() - gpu_rentals.BOOT_STALL_SECONDS - 60}), probe=True)
    assert dto["phase"] == "booting"


def test_offers_can_be_narrowed_to_one_gpu_class(tmp_path: Path, monkeypatch) -> None:
    """Renting a specific rung must not fall back to a cheaper card."""
    def handler(method, path, payload):
        assert payload["gpu_name"] == {"eq": "RTX 4090"}
        return {"offers": [{"id": 3, "gpu_name": "RTX 4090", "dph_total": 0.70, "inet_down": 900}]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.get("/api/gpu-rentals/offers?tier=image&gpu_class=rtx4090").json()
    assert body["offers"][0]["gpu_class"] == "rtx4090"


def test_a_class_that_cannot_run_the_workload_is_refused(tmp_path: Path, monkeypatch) -> None:
    """The floor is a real constraint, not a suggestion: a 24GB card cannot
    hold LTX's 27GB checkpoint, and H3's encoder needs Blackwell's nvfp4."""
    _fake_vast(monkeypatch, lambda *a: {"offers": []})
    client = _client(tmp_path, monkeypatch)
    assert client.get("/api/gpu-rentals/offers?tier=video&gpu_class=rtx4090").status_code == 400
    assert client.post("/api/gpu-rentals", json={"tier": "minimax", "gpu_class": "rtx4090"}).status_code == 400


def test_each_workload_ladder_starts_at_its_floor(tmp_path: Path, monkeypatch) -> None:
    assert gpu_rentals.tier_gpu_classes("image") == ["rtx4090", "rtx5090", "rtxpro6000"]
    # 27GB checkpoint: 24GB is out.
    assert gpu_rentals.tier_gpu_classes("video") == ["rtx5090", "rtxpro6000"]
    # nvfp4 text encoder: Blackwell (sm_120) only, so no Ada rung at all.
    assert gpu_rentals.tier_gpu_classes("minimax") == ["rtx5090", "rtxpro6000"]
    for tier in gpu_rentals.TIERS:
        spec = gpu_rentals.TIERS[tier]
        classes = gpu_rentals.tier_gpu_classes(tier)
        assert all(gpu_rentals.GPU_CLASSES[c]["vram_gb"] >= spec["min_vram_gb"] for c in classes)


def test_the_ladder_is_cheapest_first_and_labels_its_own_tradeoffs(
    tmp_path: Path, monkeypatch,
) -> None:
    """Price is the axis, because price is what the user is spending.

    The three axes disagree: on MiniMax H3 the PRO 6000 costs 2.3x the 5090's
    hourly rate AND generates 88% slower (measured 2026-08-10). Ordering by any
    performance proxy therefore put the most expensive, slowest card at the
    head of the ladder. Position now means price, and everything else is said
    outright with a flag."""
    _fake_vast(monkeypatch, lambda m, p, b: {"offers": [
        {"id": 1, "gpu_name": "RTX 5090", "dph_total": 0.72, "inet_down": 9000,
         "gpu_ram": 32607, "dlperf": 197.0},
        {"id": 2, "gpu_name": "RTX PRO 6000 S", "dph_total": 1.74, "inet_down": 9000,
         "gpu_ram": 97893, "dlperf": 278.9},
    ]})
    client = _client(tmp_path, monkeypatch)
    body = client.get("/api/gpu-rentals/plan?tier=minimax").json()
    rungs = body["classes"]

    prices = [r["usd_per_hour"] for r in rungs]
    assert prices == sorted(prices), f"cheapest must come first, got {prices}"
    assert rungs[0]["gpu_class"] == "rtx5090"
    assert rungs[0]["cheapest"] is True

    cheap, dear = rungs[0], rungs[1]
    # Same rung is cheapest AND fastest here, which is exactly the case the old
    # ordering hid by putting the pricey card first.
    assert cheap["fastest"] is True and cheap["best_value"] is True
    assert dear["fastest"] is False
    # ...and the pricier rung says plainly that it buys nothing.
    assert dear["costs_more_no_faster"] is True
    assert cheap["costs_more_no_faster"] is False

    # The VRAM floor is still named, and is NOT just the first rung.
    assert body["floor_class"] == "rtx5090"


def test_a_pricier_rung_that_is_genuinely_faster_is_not_flagged(
    tmp_path: Path, monkeypatch,
) -> None:
    """The warning has to mean something, so it must not fire on a fair trade."""
    _fake_vast(monkeypatch, lambda m, p, b: {"offers": [
        {"id": 1, "gpu_name": "RTX 4090", "dph_total": 0.40, "inet_down": 9000,
         "gpu_ram": 24576, "dlperf": 97.0},
        {"id": 2, "gpu_name": "RTX 5090", "dph_total": 0.72, "inet_down": 9000,
         "gpu_ram": 32607, "dlperf": 197.0},
    ]})
    client = _client(tmp_path, monkeypatch)
    rungs = client.get("/api/gpu-rentals/plan?tier=image").json()["classes"]
    by_class = {r["gpu_class"]: r for r in rungs}
    # The 5090 costs more per hour and earns it (2.8s against an estimated 5.7s).
    assert by_class["rtx5090"]["costs_more_no_faster"] is False
    assert by_class["rtx5090"]["fastest"] is True
    assert by_class["rtx4090"]["cheapest"] is True


def test_plan_prices_every_rung_from_one_query(tmp_path: Path, monkeypatch) -> None:
    calls = _fake_vast(monkeypatch, lambda m, p, b: {"offers": [
        {"id": 1, "gpu_name": "RTX 5090", "dph_total": 0.40, "inet_down": 3000, "gpu_ram": 32607},
        {"id": 2, "gpu_name": "RTX 4090", "dph_total": 0.70, "inet_down": 3000, "gpu_ram": 24576},
        {"id": 3, "gpu_name": "RTX PRO 6000 WS", "dph_total": 1.47, "inet_down": 3000, "gpu_ram": 97893},
    ]})
    client = _client(tmp_path, monkeypatch)
    body = client.get("/api/gpu-rentals/plan?tier=image").json()

    assert [c[1] for c in calls] == ["/v0/bundles/"], "one query for the whole ladder"
    assert body["floor_class"] == "rtx4090"
    rungs = {r["gpu_class"]: r for r in body["classes"]}
    # Cheapest first — and this market is not intuitive, so that is NOT the
    # capability order: the 4090 is listing above the 5090 here (a real spread,
    # measured 2026-08-08). floor_class still names the smallest card.
    assert [r["gpu_class"] for r in body["classes"]] == ["rtx5090", "rtx4090", "rtxpro6000"]
    assert rungs["rtx5090"]["cheapest"] is True
    # The 4090 costs more per hour AND is slower, which is the whole point of
    # saying it out loud instead of implying it by position.
    assert rungs["rtx4090"]["costs_more_no_faster"] is True
    # The reference class quotes a stopwatch reading; the others are scaled.
    assert (rungs["rtx5090"]["seconds_per_generation"], rungs["rtx5090"]["estimate_basis"]) == (2.8, "measured")
    assert rungs["rtx4090"]["estimate_basis"] == "estimated"
    assert rungs["rtx4090"]["seconds_per_generation"] > rungs["rtx5090"]["seconds_per_generation"]
    assert rungs["rtxpro6000"]["seconds_per_generation"] < rungs["rtx5090"]["seconds_per_generation"]
    # Cost per generation is the number that actually decides a rung: today the
    # 4090 is both slower AND pricier per hour, and this makes that visible.
    assert rungs["rtx4090"]["usd_per_generation"] > rungs["rtx5090"]["usd_per_generation"]
    assert all(r["vram_gb"] >= body["min_vram_gb"] for r in body["classes"])


def test_offers_rejects_unknown_tier(tmp_path: Path, monkeypatch) -> None:
    _fake_vast(monkeypatch, lambda *a: {"offers": []})
    client = _client(tmp_path, monkeypatch)
    response = client.get("/api/gpu-rentals/offers?tier=quantum")
    assert response.status_code == 400


def test_create_uses_cheapest_offer_and_provisioning_onstart(tmp_path: Path, monkeypatch, rental_manifest) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}?sig=x")

    def handler(method, path, payload):
        if path == "/v0/bundles/":
            return {"offers": [{"id": 77, "dph_total": 0.4}, {"id": 88, "dph_total": 0.5}]}
        assert (method, path) == ("PUT", "/v0/asks/77/")
        assert payload["image"] == gpu_rentals.COMFY_IMAGE
        assert payload["label"].startswith(gpu_rentals.STUDIO_LABEL_PREFIX)
        onstart = payload["onstart"]
        assert "ComfyUI-INT8-Fast" in onstart
        assert "--highvram" not in onstart
        # The weights are named by the manifest the onstart fetches, not inline.
        assert rental_manifest["url"] in onstart
        assert "Krea2_Turbo_convrot_int8mixed.safetensors" in rental_manifest["text"]
        assert "https://r2.example/" in rental_manifest["text"]
        assert "Krea2_Turbo_convrot_int8mixed.safetensors" not in onstart
        return {"new_contract": 4242, "success": True}

    calls = _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    response = client.post("/api/gpu-rentals", json={"tier": "image"})
    assert response.status_code == 201
    assert response.json()["rental_id"] == "vast:4242"
    assert [c[1] for c in calls] == ["/v0/bundles/", "/v0/asks/77/"]


def test_an_h3_box_installs_every_node_its_own_graphs_require(tmp_path: Path, monkeypatch) -> None:
    """A node the registered graphs USE is not optional on the lane.

    Sol-Attn became the default accelerator (tau 1.3) in every H3 graph on
    2026-08-11 and was pinned into the standalone provisioning script — but not
    into this onstart, which is the one API-rented boxes actually run. Every
    freshly rented H3 machine then rejected every job, acceleration or not,
    because ComfyUI validates the whole prompt: "Node 'Sol-Attn (tau 0 = off)'
    not found", HTTP 400, surfaced to the studio as a bare MediaStudioError.

    So this asserts the onstart against the graphs themselves rather than
    against a list someone has to remember to update.
    """
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")
    captured = {}

    def handler(method, path, payload):
        if path == "/v0/bundles/":
            return {"offers": [{"id": 77, "dph_total": 0.4}]}
        captured["onstart"] = payload["onstart"]
        return {"new_contract": 4242, "success": True}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    assert client.post("/api/gpu-rentals", json={"tier": "minimax"}).status_code == 201
    onstart = captured["onstart"]

    # Every custom class the H3 graphs reference must come from somewhere the
    # onstart installs. The repo names are how the class packs are identified.
    for repo in ("ComfyUI-Spectrum-MiniMax-H3", "comfyui-kjnodes",
                 "ComfyUI-MiniMax-H3-Turbo", "ComfyUI-SolAttn_triton"):
        assert repo in onstart, f"an H3 lane without {repo} rejects its own graphs"

    # Pinned, not floating: sampling on whatever upstream shipped today is how
    # this class of failure gets discovered in production instead of here.
    assert gpu_rentals._H3_SOLATTN_COMMIT in onstart


def test_renting_a_batch_takes_a_distinct_offer_for_each_machine(tmp_path: Path, monkeypatch) -> None:
    """A Vast ask is one slot. Renting three machines against the cheapest ask
    three times asks for three and gets one."""
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")
    rented = []

    def handler(method, path, payload):
        if path == "/v0/bundles/":
            return {"offers": [{"id": i, "dph_total": 0.4 + i / 100, "gpu_name": "RTX 5090"} for i in (1, 2, 3, 4)]}
        rented.append(path)
        return {"new_contract": 1000 + len(rented), "success": True}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/gpu-rentals", json={"tier": "image", "count": 3}).json()

    assert rented == ["/v0/asks/1/", "/v0/asks/2/", "/v0/asks/3/"]
    assert [r["rental_id"] for r in body["rentals"]] == ["vast:1001", "vast:1002", "vast:1003"]
    assert body["requested"] == 3
    # Single-machine callers keep the flat shape they have always had.
    assert body["rental_id"] == "vast:1001"
    # Each machine carries its own label, or the studio cannot tell them apart.
    assert len({r["label"] for r in body["rentals"]}) == 3


def test_a_short_market_rents_what_it_can_and_says_so(tmp_path: Path, monkeypatch) -> None:
    """Machines already rented are already billing — reporting a partial batch
    beats raising and leaving the user to discover them in the list."""
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")

    def handler(method, path, payload):
        if path == "/v0/bundles/":
            return {"offers": [{"id": 1, "dph_total": 0.4}, {"id": 2, "dph_total": 0.5}]}
        return {"new_contract": int(path.split("/")[3]) + 500, "success": True}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/gpu-rentals", json={"tier": "image", "count": 4}).json()

    assert len(body["rentals"]) == 2
    assert "rented 2 of 4" in body["partial"]


def test_renting_is_refused_when_the_credit_cannot_fund_an_hour(tmp_path: Path, monkeypatch) -> None:
    """Vast stops instances once the balance runs out, so overspending does not
    fail loudly — it provisions (billed) and dies mid-session."""
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")
    monkeypatch.setattr(gpu_rentals, "account_state", lambda *_a, **_k: {
        "credit": 1.20, "usd_per_hour_running": 0.40, "hours_remaining": 3.0, "machines_running": 1,
        # The gate reads the marketplace the offer belongs to, not the total.
        "providers": [{"provider": "vast", "label": "Vast.ai", "credit_url": "vast.ai",
                       "credit": 1.20, "usd_per_hour_running": 0.40,
                       "hours_remaining": 3.0, "machines_running": 1}]})
    calls = _fake_vast(monkeypatch, lambda m, p, b: {"offers": [
        {"id": 1, "dph_total": 1.47, "gpu_name": "RTX PRO 6000 WS"}]})
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/gpu-rentals", json={"tier": "image", "gpu_class": "rtxpro6000", "count": 2})

    assert response.status_code == 402
    detail = response.json()["detail"]
    # Names the marketplace: with two accounts in play, "$1.20 credit" alone
    # does not say which one is short.
    assert "$1.20 Vast.ai credit" in detail and "2 more machines" in detail
    assert "already running" in detail, "the burn already on the account is what makes it unaffordable"
    # Refused BEFORE any money moved.
    assert [c[1] for c in calls] == ["/v0/bundles/"]


def test_the_credit_check_never_blocks_a_rental_on_its_own_failure(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")

    def broken_account():
        raise gpu_rentals.GpuRentalError("users/current unavailable", status_code=502)

    monkeypatch.setattr(gpu_rentals, "account_state", broken_account)
    _fake_vast(monkeypatch, lambda m, p, b: (
        {"offers": [{"id": 1, "dph_total": 0.4}]} if p == "/v0/bundles/" else {"new_contract": 5, "success": True}))
    client = _client(tmp_path, monkeypatch)
    assert client.post("/api/gpu-rentals", json={"tier": "image"}).status_code == 201


def test_account_state_reports_burn_and_runway(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.undo()  # the funded-account fixture stubs the very thing under test
    # undo() drops EVERY patch this test has, including the autouse fixture
    # that holds the second marketplace off — without this line the balance
    # under test is summed with a live RunPod account over the network.
    monkeypatch.setattr(runpod_provider.RunPodProvider, "configured", lambda self: False)

    def handler(method, path, payload):
        if path == "/v0/users/current/":
            return {"credit": 9.87}
        return {"instances": [
            {"id": 1, "dph_total": 0.40, "cur_state": "running"},
            {"id": 2, "dph_total": 1.47, "cur_state": "running"},
            {"id": 3, "dph_total": 0.30, "cur_state": "stopped"},  # paused: GPU not billing
        ]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.get("/api/gpu-rentals/account").json()
    assert body["credit"] == 9.87
    assert body["usd_per_hour_running"] == 1.87
    assert body["machines_running"] == 2
    assert body["hours_remaining"] == 5.3
    # Broken out per marketplace as well, because the totals cannot authorize a
    # rental: credit is only spendable where it sits.
    assert body["providers"] == [{
        "provider": "vast", "label": "Vast.ai", "credit_url": "vast.ai",
        "credit": 9.87, "usd_per_hour_running": 1.87,
        "hours_remaining": 5.3, "machines_running": 2,
    }]


def test_labels_carry_the_gpu_class_and_older_ones_still_parse(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")
    captured = {}

    def handler(method, path, payload):
        if path == "/v0/bundles/":
            return {"offers": [{"id": 1, "dph_total": 0.4}]}
        captured["label"] = payload["label"]
        return {"new_contract": 1, "success": True}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    client.post("/api/gpu-rentals", json={"tier": "minimax", "gpu_class": "rtxpro6000"})

    assert gpu_rentals._tier_from_label(captured["label"]) == "minimax"
    assert gpu_rentals._gpu_class_from_label(captured["label"]) == "rtxpro6000"
    # Machines rented before the ladder existed carry no class in their label.
    assert gpu_rentals._gpu_class_from_label(f"{gpu_rentals.STUDIO_LABEL_PREFIX}image-abc123") is None
    assert gpu_rentals._tier_from_label(f"{gpu_rentals.STUDIO_LABEL_PREFIX}image-abc123") == "image"


def test_video_tier_provisions_ltx_set(tmp_path: Path, monkeypatch, rental_manifest) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}?sig=x")
    gpu_rentals._onstart_script("video")
    manifest = rental_manifest["text"]
    assert "ltx-2.3-22b-dev-fp8.safetensors" in manifest
    assert "ltx2310eros_v14_dmd_lora.safetensors" in manifest
    assert "gemma_3_12B_it_fp8_scaled.safetensors" in manifest


def test_minimax_tier_provisions_h3_stack(tmp_path: Path, monkeypatch, rental_manifest) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}?sig=x")
    script = gpu_rentals._onstart_script("minimax")
    manifest = rental_manifest["text"]
    # The full manifest minimax-h3-video serving set (DiT + TE + both VAEs).
    assert "minimax_h3_fl2va_pruned_int8_convrot.safetensors" in manifest
    assert "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" in manifest
    assert "minimax_h3_video_vae_fp16.safetensors" in manifest
    assert "minimax_h3_audio_vae_fp32.safetensors" in manifest
    # The turbo LoRA and its loader come from upstream, not R2: the loader is
    # REQUIRED to apply the LoRA to our pruned base, and both are pinned.
    assert "minimax_h3_turbo_v4_step600_ema.safetensors" in manifest
    assert "ComfyUI-MiniMax-H3-Turbo" in script
    assert gpu_rentals._H3_TURBO_NODE_COMMIT in script
    # The stripped-AdaLN conversion is gone.
    assert "ckpt500" not in script
    # H3 stack: pinned ComfyUI, Spectrum forecaster, KJNodes + SageAttention.
    assert gpu_rentals._H3_COMFY_COMMIT in script
    assert "ComfyUI-Spectrum-MiniMax-H3" in script
    assert "comfyui-kjnodes" in script
    assert "pip install -q sageattention" in script
    # Scene chaining ("Continue scene"): the studio grafts MiniMaxH3MotionContext
    # + Trim into chained graphs, so the box must ship the pinned node pack.
    assert "ComfyUI-H3-Motion-Context" in script
    assert gpu_rentals._H3_MOTION_CONTEXT_COMMIT in script
    # RAM-conditional smart-memory flag reaches the launch line via EXTRA_ARGS.
    assert "--disable-smart-memory" in script
    assert "$EXTRA_ARGS" in script.split("nohup python main.py", 1)[1]
    # convrot loads natively on the pinned commit — no INT8-Fast loader.
    assert "ComfyUI-INT8-Fast" not in script


@pytest.mark.parametrize("tier", ["image", "video", "minimax"])
def test_a_degraded_download_gives_up_instead_of_crawling(tier: str, monkeypatch) -> None:
    """Both ways a stuck download used to burn a billed box indefinitely.

    Measured 2026-08-10: a route that collapsed to 59 KB/s sat just ABOVE the
    old 50 KB/s floor, so curl never aborted and never retried — 8.3GB at that
    rate is ~39 hours, and the box held at 10/11 the whole time. Verified with
    curl directly: at 59 KB/s the old floor completes (exit 0), the new one
    aborts in 5s with exit 28, which is what --retry acts on.
    """
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}?sig=x")
    monkeypatch.setattr(gpu_rentals, "rental_public_key", lambda: "ssh-ed25519 AAAATESTKEY x")
    script = gpu_rentals._onstart_script(tier)

    assert "--speed-limit 51200" not in script, "the floor no degraded transfer ever trips"
    assert f"--speed-limit {gpu_rentals.DOWNLOAD_MIN_BYTES_PER_SEC}" in script
    assert f"--speed-time {gpu_rentals.DOWNLOAD_STALL_SECONDS}" in script
    # Resume is the library's, not curl's: --retry re-sends a bare GET with no
    # Range and truncates the output to zero, and never fires on a connection
    # reset or early close (measured 2026-08-22). test_rental_downloads.py runs
    # the library itself; here, only that the onstart carries it and not --retry.
    assert "--retry" not in script
    assert 'again "$p" $rc $hc $a "${o#*|}"' in script
    # The phase deadline is set BEFORE the fetchers fork so every stream
    # inherits it; a stream that keeps failing stops at the deadline too.
    assert script.index("DL_DEADLINE=$((") < script.index('dlstart "$MF"')
    # No HEAD on a GET presign: R2 answers 403, the length came back empty and
    # every R2 weight silently took the single-stream path.
    assert "-sfI" not in script and "curl -I" not in script
    assert "c -r 0-0" in script

    # A job that is still RUNNING never trips the "all jobs exited" escape, so
    # the watcher needs its own deadline or a hung connection bills forever.
    assert f"DL_DEADLINE=$(( $(date +%s) + {gpu_rentals.DOWNLOAD_DEADLINE_SECONDS} ))" in script
    assert 'dlwait "$DL_DEADLINE" "${FILES[@]}"' in script
    assert f'dlfail "stalled {gpu_rentals.DOWNLOAD_DEADLINE_SECONDS // 60}min"' in script
    assert 'dlfail "failed"' in script
    # Both exits say what to do: the presigned URLs expire, so there is no
    # repair path for a half-provisioned box.
    assert "destroy this machine and rent another" in script


# The exact shape _presign_r2 emits (SigV4 query auth, signature last), with
# components of the real lengths: a 32-hex token id, a 64-hex signature. A real
# one measured 405 chars for a 40-char key on 2026-08-22; this lands within a
# few chars of that, so the size check below is about the script Vast actually
# receives, not about placeholder URLs that would pass anything.
_REAL_QUERY = (
    "X-Amz-Algorithm=AWS4-HMAC-SHA256"
    "&X-Amz-Credential=0123456789abcdef0123456789abcdef%2F20260822%2Fauto%2Fs3%2Faws4_request"
    "&X-Amz-Date=20260822T050000Z&X-Amz-Expires=10800&X-Amz-SignedHeaders=host"
)


def _realistic_presign(key: str, now=None) -> str:
    sig = hashlib.sha256(key.encode()).hexdigest()
    return f"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/hivemind-rental-models/{key}?{_REAL_QUERY}&X-Amz-Signature={sig}"


def test_the_realistic_presign_is_the_real_length() -> None:
    assert abs(len(_realistic_presign("vae/minimax_h3_video_vae_fp16.safetensors")) - 405) <= 12


@pytest.mark.parametrize("tier", ["image", "video", "minimax"])
def test_every_tier_onstart_keeps_headroom_under_vasts_limit(tier: str, monkeypatch) -> None:
    """Vast rejects an onstart over 16KB with an error that names nothing, and
    the generator raises first — at RENT time, for the user. Pin the headroom
    here instead, so growth in provisioning fails in CI. Since the weight
    list moved into the manifest (2026-08-22) the size does not depend on
    what a tier serves; what remains is node installs and the inlined
    privacy node. Measured: image ~5.9KB, video ~5.9KB, minimax ~2.8KB."""
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", _realistic_presign)
    monkeypatch.setattr(gpu_rentals, "rental_public_key", lambda: "ssh-ed25519 AAAATESTKEY x")
    script = gpu_rentals._onstart_script(tier)
    headroom = gpu_rentals.VAST_ONSTART_LIMIT - len(script)
    assert headroom >= 2000, f"{tier}: only {headroom} chars left under Vast's onstart limit"


@pytest.mark.parametrize("tier", ["image", "video", "minimax"])
def test_the_onstart_carries_one_manifest_url_and_no_weight_urls(tier: str, monkeypatch, rental_manifest) -> None:
    """The weight list lives in a manifest the box fetches, not in the onstart.
    Vast caps the onstart at 16KB and a presigned URL is ~400 chars, which
    used to cap the MiniMax tier at about two registered user LoRAs."""
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", _realistic_presign)
    monkeypatch.setattr(gpu_rentals, "rental_public_key", lambda: "ssh-ed25519 AAAATESTKEY x")
    script = gpu_rentals._onstart_script(tier)
    assert rental_manifest["calls"] == 1
    assert script.count(rental_manifest["url"]) == 1
    assert "X-Amz-Signature" not in script.replace(rental_manifest["url"], "")
    assert "huggingface.co" not in script
    manifest, total = gpu_rentals._rental_manifest(tier)
    assert manifest == rental_manifest["text"]
    rows = [line.split("\t") for line in manifest.splitlines()]
    assert len(rows) == total and f'"total":{total},' in script
    for url, dest in rows:
        assert url.startswith("https://") and "/" in dest and not dest.startswith("/")
    assert 'dlstart "$MF" "$M"' in script and 'dlwait "$DL_DEADLINE" "${FILES[@]}"' in script
    # A rerun after the presigns expire reads the cached copy.
    assert "MF=/workspace/.hivemind-manifest" in script and '[ -s "$MF" ] ||' in script


def test_registered_loras_do_not_change_the_onstart_size(monkeypatch, rental_manifest) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", _realistic_presign)
    monkeypatch.setattr(gpu_rentals, "rental_public_key", lambda: "ssh-ed25519 AAAATESTKEY x")
    bare = gpu_rentals._onstart_script("minimax")
    rows_before = rental_manifest["text"].count("\n")
    monkeypatch.setattr(
        gpu_rentals, "_rental_lora_downloads",
        lambda tier: [(f"user-loras/h3/lora{i:02d}.safetensors", "loras/h3") for i in range(40)],
    )
    loaded = gpu_rentals._onstart_script("minimax")
    assert rental_manifest["text"].count("\n") == rows_before + 40
    # Only the beacon's total changes (8 -> 48, three mentions): forty LoRAs, same onstart.
    assert abs(len(loaded) - len(bare)) <= 8


def test_publishing_the_manifest_puts_it_to_r2_and_remembers_the_key(tmp_path: Path, monkeypatch, rental_manifest) -> None:
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    monkeypatch.setattr(gpu_rentals, "_presign_r2", lambda method, key, **_kw: f"https://r2.example/{method}/{key}")
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/GET/{key}?sig=x")
    puts = []

    class _Resp:
        status_code = 200
        text = ""

    monkeypatch.setattr(gpu_rentals.requests, "put",
                        lambda url, data=None, headers=None, timeout=None: puts.append((url, data, headers)) or _Resp())
    url = rental_manifest["real_publish"]("https://a\tloras/a.safetensors\n")
    assert len(puts) == 1
    put_url, body, headers = puts[0]
    assert put_url.startswith(f"https://r2.example/PUT/{gpu_rentals.RENTAL_MANIFEST_PREFIX}")
    assert body == b"https://a\tloras/a.safetensors\n"
    key = put_url.split("/PUT/", 1)[1]
    assert url == f"https://r2.example/GET/{key}?sig=x"
    state = json.loads((tmp_path / "state" / "rental-manifests.json").read_text())
    assert key in state["keys"]


def test_a_refused_manifest_put_stops_the_rental_before_it_bills(tmp_path: Path, monkeypatch, rental_manifest) -> None:
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    monkeypatch.setattr(gpu_rentals, "_presign_r2", lambda method, key, **_kw: f"https://r2.example/{method}/{key}")

    class _Resp:
        status_code = 403
        text = "denied"

    monkeypatch.setattr(gpu_rentals.requests, "put", lambda *a, **k: _Resp())
    with pytest.raises(gpu_rentals.GpuRentalError, match="manifest"):
        rental_manifest["real_publish"]("x\ty\n")


def test_stale_manifests_are_swept_on_the_next_rent(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    (tmp_path / "state").mkdir()
    now = 1_800_000_000.0
    (tmp_path / "state" / "rental-manifests.json").write_text(json.dumps({"keys": {
        "rental-manifests/old.tsv": now - 2 * 86400,
        "rental-manifests/fresh.tsv": now - 600,
    }}))
    monkeypatch.setattr(gpu_rentals, "_presign_r2", lambda method, key, **_kw: f"https://r2.example/{method}/{key}")
    deleted = []

    class _Resp:
        status_code = 204
        text = ""

    monkeypatch.setattr(gpu_rentals.requests, "delete", lambda url, timeout=None: deleted.append(url) or _Resp())
    removed = gpu_rentals._prune_rental_manifests(now=now)
    assert removed == ["rental-manifests/old.tsv"]
    assert deleted == ["https://r2.example/DELETE/rental-manifests/old.tsv"]
    state = json.loads((tmp_path / "state" / "rental-manifests.json").read_text())
    assert list(state["keys"]) == ["rental-manifests/fresh.tsv"]


@pytest.mark.parametrize("tier", ["image", "video", "minimax"])
def test_every_box_authorizes_our_key_itself(tier: str, monkeypatch) -> None:
    # ROOT CAUSE of an unusable rental, 2026-08-08: we trusted Vast to push an
    # account key to each new instance. One box provisioned perfectly and then
    # refused every SSH attempt — with ComfyUI on loopback, only the beacon
    # port published, and Vast's execute API rejecting running instances, there
    # was no way in and no way to fix it. The box must authorize us itself.
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}?sig=x")
    monkeypatch.setattr(gpu_rentals, "rental_public_key", lambda: "ssh-ed25519 AAAATESTKEY hivemind-studio-rentals")
    script = gpu_rentals._onstart_script(tier)
    assert "echo 'ssh-ed25519 AAAATESTKEY hivemind-studio-rentals' >> /root/.ssh/authorized_keys" in script
    # The confirmed failure: Vast wrote the file as a HOST user, and OpenSSH
    # StrictModes ignores an authorized_keys the login user does not own.
    assert "chown -R root:root /root/.ssh" in script
    assert "chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys" in script
    # Idempotent: onstart re-runs on every instance start.
    assert "grep -qxF" in script
    # Before the slow work — a box we cannot reach should not spend 3 minutes
    # pulling weights first.
    assert script.index("/root/.ssh/authorized_keys") < script.index("beacon downloading")


def test_renting_refuses_before_billing_when_the_key_is_missing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "RENTAL_SSH_KEY", tmp_path / "absent")
    monkeypatch.setattr(gpu_rentals, "RENTAL_SSH_PUBKEY", tmp_path / "absent.pub")
    calls = _fake_vast(monkeypatch, lambda m, p, b: {"offers": [{"id": 1, "dph_total": 0.4}]})
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/gpu-rentals", json={"tier": "image"})

    assert response.status_code == 503
    assert "SSH key missing" in response.json()["detail"]
    # Nothing was rented: the failure must precede the money.
    assert calls == []


def test_public_key_is_derived_when_only_the_private_half_is_present(tmp_path: Path, monkeypatch) -> None:
    import subprocess as sp

    key = tmp_path / "vast_ed25519"
    sp.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "derived-test", "-f", str(key)],
           check=True, capture_output=True)
    expected = (tmp_path / "vast_ed25519.pub").read_text(encoding="utf-8").strip()
    (tmp_path / "vast_ed25519.pub").unlink()
    monkeypatch.setattr(gpu_rentals, "RENTAL_SSH_KEY", key)
    monkeypatch.setattr(gpu_rentals, "RENTAL_SSH_PUBKEY", tmp_path / "vast_ed25519.pub")

    # Same key material, minus the trailing comment ssh-keygen -y omits.
    assert gpu_rentals.rental_public_key().split()[:2] == expected.split()[:2]


# A realistic presigned R2 URL: ~600 chars, and every model in a tier carries
# one. Tests that measure the script MUST use this, not a short stub, or they
# pass while the real rental is rejected.
_REALISTIC_PRESIGNED = (
    "https://hivemind-rental-models." + "a" * 32 + ".r2.cloudflarestorage.com/{key}"
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=" + "c" * 32 +
    "%2F20260808%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260808T000000Z"
    "&X-Amz-Expires=10800&X-Amz-SignedHeaders=host&X-Amz-Signature=" + "s" * 64
)


@pytest.mark.parametrize("tier", ["image", "video", "minimax"])
def test_onstart_fits_vast_arg_limit(tier: str, monkeypatch) -> None:
    # Vast rejects an oversized onstart with a generic "Invalid args" 400 that
    # names three possible fields and no sizes. Inlining the 9KB privacy node
    # pushed the video tier 3.6KB over and killed every rental until it was
    # compressed. Budget is real: presigned URLs alone are ~6.6KB there.
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get",
                        lambda key: _REALISTIC_PRESIGNED.format(key=key))
    script = gpu_rentals._onstart_script(tier)
    assert len(script) <= gpu_rentals.VAST_ONSTART_LIMIT, (
        f"{tier} onstart is {len(script)} chars, over Vast's limit"
    )


def test_oversized_onstart_is_refused_before_vast_sees_it(monkeypatch) -> None:
    # The weight list no longer lives in the onstart, so presigned URLs cannot
    # overflow it; the authorized key is the remaining per-rental string.
    monkeypatch.setattr(gpu_rentals, "rental_public_key", lambda: "ssh-ed25519 " + "A" * 8000)
    with pytest.raises(gpu_rentals.GpuRentalError) as excinfo:
        gpu_rentals._onstart_script("video")
    # The message must carry the numbers Vast's own error withholds.
    assert "over Vast's" in str(excinfo.value)
    assert "chars" in str(excinfo.value)


def test_privacy_node_survives_the_round_trip(monkeypatch) -> None:
    # The node ships gzipped to fit the budget; a mangled payload would mean a
    # box with no prompt redaction and no scrub route.
    import base64 as _b64, gzip as _gz, re as _re

    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")
    script = gpu_rentals._onstart_script("image")
    packed = _re.search(r"printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d", script).group(1)
    restored = _gz.decompress(_b64.b64decode(packed)).decode("utf-8")
    assert restored == gpu_rentals.PRIVACY_NODE_SOURCE.read_text(encoding="utf-8")
    # And provisioning refuses to continue if it lands corrupt.
    assert "privacy node failed to unpack" in script


@pytest.mark.parametrize("tier", ["image", "video", "minimax"])
def test_every_tier_provisions_the_privacy_layer(tier: str, monkeypatch) -> None:
    # Measured 2026-08-07: without this node every remote job recorded
    # files_scrubbed=false — the customer's reference image and the generated
    # output sat on the rented box until teardown, and /queue served the
    # prompt in plaintext for the whole generation.
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}?sig=x")
    script = gpu_rentals._onstart_script(tier)
    assert "custom_nodes/hivemind_privacy/__init__.py" in script
    assert "export COMFY_PRIVATE_HISTORY_PROMPTS=1" in script
    # The node body must arrive intact and self-contained (it ships gzipped to
    # fit Vast's arg budget) — never as a path or URL the box cannot resolve.
    import base64 as _b64, gzip as _gz, re as _re
    packed = _re.search(r"printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d", script).group(1)
    node = _gz.decompress(_b64.b64decode(packed)).decode("utf-8")
    assert "/hivemind/scrub-files" in node
    assert "get_current_queue" in node
    # A box that cannot delete customer media must never be handed out.
    probe = script.split("system_stats", 1)[1]
    assert "/hivemind/scrub-files" in probe
    assert "privacy layer failed to load" in probe
    assert probe.index("privacy layer failed to load") < probe.index("beacon ready")


@pytest.mark.parametrize("tier", ["image", "video"])
def test_every_krea2_tier_installs_its_text_encoder_node(tier: str, monkeypatch) -> None:
    """TextEncodeKrea2 is a separate custom node, not ComfyUI core and not part
    of INT8-Fast. Without it ComfyUI comes up perfectly and then rejects the
    whole prompt with "Node 'TextEncodeKrea2' not found" — so the box looks
    healthy right up to the first generation.

    Found 2026-08-15 by rendering on a freshly rented box; it had been missing
    on every provider. Pinned by SHA for the same reason the H3 nodes are.
    """
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")
    script = gpu_rentals._onstart_script(tier)
    assert "ComfyUI-Krea2TextEncoder" in script
    assert gpu_rentals._KREA2_TEXT_ENCODER_COMMIT in script, "an unpinned node build is the H3 trap"
    # And it fails provisioning loudly rather than serving a box that cannot
    # run the one workflow the tier exists for.
    assert "Krea2 text encoder node unavailable" in script


def test_the_h3_tier_does_not_carry_krea2_nodes(monkeypatch) -> None:
    """H3 serves no Krea2 graph, and the onstart has a hard size ceiling."""
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")
    assert "ComfyUI-Krea2TextEncoder" not in gpu_rentals._onstart_script("minimax")


def test_h3_custom_nodes_are_pinned_not_cloned_at_head(tmp_path: Path, monkeypatch) -> None:
    # Cloning custom nodes at HEAD broke every H3 job on 2026-08-07: upstream
    # Spectrum dc6e1b3 changed a default the registered graph is tuned against.
    # Both node trees must land on an exact commit, and a missing one must fail
    # the beacon loudly rather than sample on whatever HEAD happens to be.
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}?sig=x")
    script = gpu_rentals._onstart_script("minimax")
    for directory, commit in (
        ("ComfyUI-Spectrum-MiniMax-H3", gpu_rentals._H3_SPECTRUM_COMMIT),
        ("comfyui-kjnodes", gpu_rentals._H3_KJNODES_COMMIT),
    ):
        assert len(commit) == 40, "pin a full sha — abbreviations are not fetchable by name"
        assert f"pin /workspace/ComfyUI/custom_nodes/{directory} {commit}" in script
    assert 'checkout -q "$2" || { beacon error 0 "custom node pin $2 unavailable"; exit 1; }' in script


def test_destroy_refuses_foreign_labels(tmp_path: Path, monkeypatch) -> None:
    def handler(method, path, payload):
        assert method == "GET"
        return {"instances": [{"id": 9, "label": FOREIGN_LABEL}]}

    calls = _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    response = client.delete("/api/gpu-rentals/9")
    assert response.status_code == 409
    assert "refusing" in response.json()["detail"]
    assert all(method != "DELETE" for method, _, _ in calls)


def test_destroy_managed_instance(tmp_path: Path, monkeypatch) -> None:
    def handler(method, path, payload):
        if method == "GET":
            return {"instances": [{"id": 5, "label": STUDIO_LABEL}]}
        assert (method, path) == ("DELETE", "/v0/instances/5/")
        return {"success": True}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    # A bare id from an older client still routes to Vast; the response speaks
    # the provider-scoped form from here on.
    assert client.delete("/api/gpu-rentals/5").json() == {
        "rental_id": "vast:5", "destroyed": True, "restarting_stack": False,
    }


def test_list_marks_managed_vs_foreign(tmp_path: Path, monkeypatch) -> None:
    def handler(method, path, payload):
        return {"instances": [
            {"id": 1, "label": STUDIO_LABEL, "actual_status": "running", "gpu_name": "RTX 5090",
             "dph_total": 0.469, "start_date": 1_785_500_000.0, "public_ipaddr": "1.2.3.4",
             "ports": {"22/tcp": [{"HostPort": "1111"}]}},
            {"id": 2, "label": FOREIGN_LABEL, "actual_status": "running"},
        ]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.get("/api/gpu-rentals").json()
    assert body["tiers"] == ["image", "video", "minimax"]
    rentals = body["rentals"]
    assert rentals[0]["managed"] is True
    assert "ssh -p 1111 root@1.2.3.4" in rentals[0]["ssh_command"]
    assert rentals[1]["managed"] is False
    assert rentals[1]["ssh_command"] is None


def test_presign_r2_get_is_deterministic_sigv4(monkeypatch) -> None:
    monkeypatch.setitem(gpu_rentals._s3_creds_cache, "access_key", "AKID")
    monkeypatch.setitem(gpu_rentals._s3_creds_cache, "secret", "deadbeef")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "token")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct42")
    url = gpu_rentals._presign_r2_get(
        "vae/taeltx2_3.safetensors", now=datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc)
    )
    assert url.startswith("https://acct42.r2.cloudflarestorage.com/hivemind-rental-models/vae/taeltx2_3.safetensors?")
    assert "X-Amz-Algorithm=AWS4-HMAC-SHA256" in url
    assert "X-Amz-Credential=AKID%2F20260731%2Fauto%2Fs3%2Faws4_request" in url
    assert "X-Amz-Signature=" in url


def test_no_marketplace_configured_maps_to_503(tmp_path: Path, monkeypatch) -> None:
    """"Nothing is set up" and "everything is sold out" must not look alike.

    Both render as an empty machine list, and they need opposite responses
    from the user — one is a missing API key, the other is a market to wait
    out. Now that a provider with no key is skipped rather than raising, the
    total-absence case has to say so explicitly or it degrades into silence.
    """
    client = _client(tmp_path, monkeypatch)
    # build_control_app re-applies the shared hive env, so clear the keys AFTER
    # the app is built to simulate an unconfigured machine.
    for key in ("VAST_API_KEY", "RUNPOD_API_KEY", "RUNPOD_MANAGEMENT_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    response = client.get("/api/gpu-rentals")
    assert response.status_code == 503
    detail = response.json()["detail"]
    # Names every marketplace it could have used, not just the first.
    assert "VAST_API_KEY" in detail and "RUNPOD_API_KEY" in detail


def test_one_configured_marketplace_is_enough(tmp_path: Path, monkeypatch) -> None:
    """A missing RunPod key must not take Vast's machines off the screen."""
    def handler(method, path, payload):
        return {"instances": []}

    _fake_vast(monkeypatch, handler)  # sets VAST_API_KEY, clears the RunPod ones
    client = _client(tmp_path, monkeypatch)
    assert client.get("/api/gpu-rentals").status_code == 200


def test_phase_booting_not_running_while_loading(tmp_path: Path, monkeypatch) -> None:
    def handler(method, path, payload):
        return {"instances": [{"id": 3, "label": STUDIO_LABEL, "actual_status": "loading",
                               "intended_status": "running"}]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    rental = client.get("/api/gpu-rentals").json()["rentals"][0]
    assert rental["phase"] == "booting"


def test_phase_provisioning_with_beacon_progress(tmp_path: Path, monkeypatch) -> None:
    def handler(method, path, payload):
        return {"instances": [{"id": 3, "label": STUDIO_LABEL, "actual_status": "running",
                               "public_ipaddr": "1.2.3.4",
                               "ports": {"22/tcp": [{"HostPort": "11"}],
                                         "18189/tcp": [{"HostPort": "28189"}]}}]}

    _fake_vast(monkeypatch, handler)
    seen = {}

    def fake_beacon(url):
        seen["url"] = url
        return {"step": "downloading", "done": 3, "total": 6, "detail": "gemma_3_12B_it_fp8_scaled.safetensors"}

    monkeypatch.setattr(gpu_rentals, "_fetch_beacon", fake_beacon)
    client = _client(tmp_path, monkeypatch)
    rental = client.get("/api/gpu-rentals").json()["rentals"][0]
    assert seen["url"] == "http://1.2.3.4:28189/progress.json"
    assert rental["phase"] == "provisioning"
    # stale_seconds 0: this reading came off the box just now, not out of the
    # last-good cache that keeps a missed poll from rewinding the ladder.
    assert rental["provision"] == {"step": "downloading", "done": 3, "total": 6,
                                   "detail": "gemma_3_12B_it_fp8_scaled.safetensors",
                                   "stale_seconds": 0}


def test_phase_ready_from_beacon(tmp_path: Path, monkeypatch) -> None:
    def handler(method, path, payload):
        return {"instances": [{"id": 3, "label": STUDIO_LABEL, "actual_status": "running",
                               "public_ipaddr": "1.2.3.4",
                               "ports": {"18189/tcp": [{"HostPort": "28189"}]}}]}

    _fake_vast(monkeypatch, handler)
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon",
                        lambda url: {"step": "ready", "done": 6, "total": 6, "detail": "ComfyUI is up"})
    client = _client(tmp_path, monkeypatch)
    rental = client.get("/api/gpu-rentals").json()["rentals"][0]
    assert rental["phase"] == "ready"


def test_onstart_has_beacon_and_atomic_downloads(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}?sig=x")
    script = gpu_rentals._onstart_script("image")
    assert "http.server 18189" in script
    assert 'beacon ready' in script
    assert ".dl" in script and "&& mv" in script
    assert "--listen 127.0.0.1" in script


def test_create_publishes_beacon_port_only(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")

    def handler(method, path, payload):
        if path == "/v0/bundles/":
            return {"offers": [{"id": 77}]}
        assert payload["env"] == {"-p 18189:18189": "1"}
        return {"new_contract": 1, "success": True}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    assert client.post("/api/gpu-rentals", json={"tier": "image"}).status_code == 201


def _ready_instance(rid=7):
    return {"id": rid, "label": f"{gpu_rentals.STUDIO_LABEL_PREFIX}image-xyz", "actual_status": "running",
            "public_ipaddr": "9.9.9.9",
            "ports": {"22/tcp": [{"HostPort": "41000"}], "18189/tcp": [{"HostPort": "28189"}]}}


def _attach_env(monkeypatch, tmp_path):
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "media-state")
    spawned = {}
    monkeypatch.setattr(gpu_rentals, "_spawn_tunnel", lambda rid, ip, port, lport: spawned.update(
        {"rid": rid, "ip": ip, "port": port, "lport": lport}) or 4321)
    monkeypatch.setattr(gpu_rentals, "_tunnel_pid", lambda rid: spawned.get("rid") == rid and 4321 or None)
    restarts = []
    monkeypatch.setattr(gpu_rentals, "_schedule_stack_restart", lambda: restarts.append(1))
    # The faked tunnel answers no /system_stats; stand in a box launched the way
    # the provisioning launches it, so attach records a known headroom.
    monkeypatch.setattr(gpu_rentals, "_lane_comfy_launch_args",
                        lambda port, timeout=3.0: ["main.py", "--disable-metadata", "--vram-headroom", "12"])
    return spawned, restarts


def test_attach_requires_ready(tmp_path: Path, monkeypatch) -> None:
    _fake_vast(monkeypatch, lambda m, p, b: {"instances": [
        {**_ready_instance(), "actual_status": "loading"}]})
    _attach_env(monkeypatch, tmp_path)
    client = _client(tmp_path, monkeypatch)
    response = client.post("/api/gpu-rentals/7/attach")
    assert response.status_code == 409
    assert "not ready" in response.json()["detail"]


def test_attach_writes_overlay_and_spawns_tunnel(tmp_path: Path, monkeypatch) -> None:
    _fake_vast(monkeypatch, lambda m, p, b: {"instances": [_ready_instance()]})
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon",
                        lambda url: {"step": "ready", "done": 6, "total": 6, "detail": ""})
    spawned, restarts = _attach_env(monkeypatch, tmp_path)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/gpu-rentals/7/attach").json()
    # Attaching must NOT restart the stack: the gateway re-reads the attachment
    # registry per request, and restarting to add a routing rule killed
    # in-flight generations and made "use this machine" a 30-second wait.
    assert body["attached"] is True and body["restarting_stack"] is False
    assert spawned == {"rid": RentalRef("vast", "7"), "ip": "9.9.9.9", "port": "41000",
                       # Numeric ids keep `int % 500`, so a machine attached
                       # before rental refs existed stays on its own port.
                       "lport": gpu_rentals.TUNNEL_BASE_PORT + 7}
    assert restarts == []
    env = (tmp_path / "media-state/rental-lanes.env").read_text()
    assert 'RENTAL_COMFY_LANES="rental7=http://127.0.0.1:18307"' in env
    assert 'RENTAL_COMFY_LANE_RULES="rental7=krea2_turbo_convrot,waianima"' in env
    assert 'RENTAL_COMFY_REMOTE_LANES="rental7"' in env
    # list now reports attached + tunnel_alive + studio pages. The tunnel here
    # is faked, so its liveness is faked too — tunnel_alive is a real connect to
    # the forwarded port now, not a pid check (see the test below for why).
    monkeypatch.setattr(gpu_rentals, "_tunnel_carrying_traffic", lambda *_a, **_k: True)
    rentals = client.get("/api/gpu-rentals").json()["rentals"]
    assert rentals[0]["attached"] is True and rentals[0]["tunnel_alive"] is True
    assert rentals[0]["studio_pages"] == ["image"]


def _ready_minimax_instance(rid=7):
    return {"id": rid, "label": f"{gpu_rentals.STUDIO_LABEL_PREFIX}minimax-rtx5090-{rid}",
            "actual_status": "running", "public_ipaddr": "9.9.9.9", "gpu_name": "RTX 5090",
            "ports": {"22/tcp": [{"HostPort": "41000"}], "18189/tcp": [{"HostPort": "28189"}]}}


def test_attach_records_the_lanes_vram_headroom_and_says_when_the_flag_is_missing(
    tmp_path: Path, monkeypatch,
) -> None:
    """The H3 motion-reference budget (workflow-registry.json) was measured
    with --vram-headroom 12 — Comfy's planner cannot see reference rows, and
    without the flag a job the budget allows OOMs in block 0 (2026-08-21, job
    34a722c2). This tier's onstart passes the flag, but a box provisioned any
    other way, or whose ComfyUI was relaunched by hand, may not run it. Attach
    reads what the box ACTUALLY runs from its /system_stats argv, records it,
    and says so — the gateway still asks the lane per job, because the
    registry is a snapshot."""
    _fake_vast(monkeypatch, lambda m, p, b: {"instances": [_ready_minimax_instance()]})
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon",
                        lambda url: {"step": "ready", "done": 4, "total": 4, "detail": ""})
    _attach_env(monkeypatch, tmp_path)
    client = _client(tmp_path, monkeypatch)
    registry = tmp_path / "media-state/rental-lanes.json"

    # Launched as provisioned: recorded, and nothing to warn about.
    body = client.post("/api/gpu-rentals/7/attach").json()
    assert body["vram_headroom_gb"] == 12.0 and body["warnings"] == []
    record = json.loads(registry.read_text())["vast:7"]
    assert record["vram_headroom_gb"] == 12.0
    assert record["comfy_launch_args"] == ["main.py", "--disable-metadata", "--vram-headroom", "12"]

    # Launched WITHOUT the flag: recorded as 0 (a fact, not an unknown), and
    # the attach names the flag, the value the budget needs, and the fix.
    monkeypatch.setattr(gpu_rentals, "_lane_comfy_launch_args",
                        lambda port, timeout=3.0: ["main.py", "--disable-auto-launch", "--disable-metadata"])
    body = client.post("/api/gpu-rentals/7/attach").json()
    assert body["attached"] is True and body["vram_headroom_gb"] == 0.0
    assert len(body["warnings"]) == 1
    assert "without --vram-headroom" in body["warnings"][0]
    assert "--vram-headroom 12" in body["warnings"][0]
    assert "re-provision" in body["warnings"][0]
    assert json.loads(registry.read_text())["vast:7"]["vram_headroom_gb"] == 0.0
    # Machines reads it off the attachment.
    monkeypatch.setattr(gpu_rentals, "_tunnel_carrying_traffic", lambda *_a, **_k: True)
    rentals = client.get("/api/gpu-rentals").json()["rentals"]
    assert rentals[0]["attached"] is True and rentals[0]["vram_headroom_gb"] == 0.0

    # Less than the budget needs is called out the same way, with the value.
    monkeypatch.setattr(gpu_rentals, "_lane_comfy_launch_args",
                        lambda port, timeout=3.0: ["main.py", "--vram-headroom", "4"])
    body = client.post("/api/gpu-rentals/7/attach").json()
    assert body["vram_headroom_gb"] == 4.0
    assert "with --vram-headroom 4;" in body["warnings"][0]

    # A lane that could not be read is UNKNOWN — never "without" — and the
    # attach says the gateway will ask again rather than pretending to know.
    monkeypatch.setattr(gpu_rentals, "_lane_comfy_launch_args", lambda port, timeout=3.0: None)
    body = client.post("/api/gpu-rentals/7/attach").json()
    assert body["vram_headroom_gb"] is None
    assert "could not read" in body["warnings"][0] and "--vram-headroom 12" in body["warnings"][0]
    assert json.loads(registry.read_text())["vast:7"]["comfy_launch_args"] is None

    # The parser keeps the two apart and reads both spellings argparse takes.
    assert gpu_rentals.vram_headroom_gb_from_argv(["main.py", "--vram-headroom=12"]) == 12.0
    assert gpu_rentals.vram_headroom_gb_from_argv(["main.py"]) == 0.0
    assert gpu_rentals.vram_headroom_gb_from_argv(None) is None


def test_the_onstart_passes_the_headroom_the_budget_was_measured_with(monkeypatch) -> None:
    """One number, three places: the tier table, the onstart the box runs, and
    the registry's budget. If they drift, the guard enforces a flag the
    provisioning no longer passes, or the provisioning passes one the budget
    was not measured with."""
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.test/{key}")
    required = gpu_rentals.TIERS["minimax"]["comfy_vram_headroom_gb"]
    assert required == 12
    script = gpu_rentals._onstart_script("minimax")
    assert f'--vram-headroom {required}"' in script
    root = Path(__file__).resolve().parents[2]
    registry = json.loads((root / "packages" / "media-gateway" / "workflow-registry.json").read_text())
    h3 = next(w for w in registry["workflows"] if w["id"] == "minimax-h3")
    assert h3["motion_reference_budget"]["vram_headroom_gb"] == required
    # The image/video tiers never launch H3 and never pass the flag.
    for tier in ("image", "video"):
        assert "--vram-headroom" not in gpu_rentals._onstart_script(tier)


def test_a_live_ssh_with_a_dead_forward_is_not_a_live_tunnel(tmp_path: Path, monkeypatch) -> None:
    """An ssh process outlives its forward, and a pid check cannot tell.

    Measured 2026-08-11: the far end tore the forward down, ssh sat there for
    24 minutes, and Machines reported the machine attached and reachable while
    every generation failed with connection-refused. The operator re-attached
    repeatedly on the strength of that green indicator. Liveness has to mean
    the port answers.
    """
    _fake_vast(monkeypatch, lambda m, p, b: {"instances": [_ready_instance()]})
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon",
                        lambda url: {"step": "ready", "done": 6, "total": 6, "detail": ""})
    _attach_env(monkeypatch, tmp_path)
    client = _client(tmp_path, monkeypatch)
    client.post("/api/gpu-rentals/7/attach")

    # The ssh process is alive and the pidfile is valid...
    monkeypatch.setattr(gpu_rentals, "_tunnel_pid", lambda *_a, **_k: 4242)
    # ...but nothing accepts on the forwarded port.
    rentals = client.get("/api/gpu-rentals").json()["rentals"]
    assert rentals[0]["attached"] is True
    assert rentals[0]["tunnel_alive"] is False, "a dead forward must not read as a live tunnel"


def _two_ready_instances(monkeypatch, tmp_path):
    """Two machines of the SAME tier — so both serve the same models and the
    gateway's first-match lane rules have to be settled by something."""
    def instance(rid, port):
        return {"id": rid, "label": f"{gpu_rentals.STUDIO_LABEL_PREFIX}minimax-rtx5090-{rid}",
                "actual_status": "running", "public_ipaddr": "9.9.9.9", "gpu_name": "RTX 5090",
                "ports": {"22/tcp": [{"HostPort": port}], "18189/tcp": [{"HostPort": "28189"}]}}

    _fake_vast(monkeypatch, lambda m, p, b: {"instances": [instance(7, "41000"), instance(8, "41001")]})
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon",
                        lambda url: {"step": "ready", "done": 4, "total": 4, "detail": ""})
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "media-state")
    monkeypatch.setattr(gpu_rentals, "_spawn_tunnel", lambda *a: 4321)
    monkeypatch.setattr(gpu_rentals, "_tunnel_pid", lambda rid: 4321)
    monkeypatch.setattr(gpu_rentals, "_schedule_stack_restart", lambda: None)


def test_selecting_a_machine_puts_its_lane_first(tmp_path: Path, monkeypatch) -> None:
    """Two attached machines can serve the same models; lane rules are
    first-match, so the ORDER of the registry is the whole mechanism behind
    'run generations on that one'."""
    _two_ready_instances(monkeypatch, tmp_path)
    client = _client(tmp_path, monkeypatch)
    client.post("/api/gpu-rentals/7/attach")
    client.post("/api/gpu-rentals/8/attach")

    registry = tmp_path / "media-state/rental-lanes.json"
    assert list(json.loads(registry.read_text())) == ["vast:7", "vast:8"]

    assert client.post("/api/gpu-rentals/8/select").json()["attached"] is True

    assert list(json.loads(registry.read_text())) == ["vast:8", "vast:7"], "the selected machine leads"
    env = (tmp_path / "media-state/rental-lanes.env").read_text()
    assert 'RENTAL_COMFY_LANE_RULES="rental8=minimax_h3;rental7=minimax_h3"' in env
    rentals = {r["rental_id"]: r for r in client.get("/api/gpu-rentals").json()["rentals"]}
    assert rentals["vast:8"]["priority"] > rentals["vast:7"]["priority"]


def test_reattaching_does_not_steal_the_selection(tmp_path: Path, monkeypatch) -> None:
    """A dropped tunnel is re-attached by the studio automatically. If that
    re-attach jumped the queue, a machine going quiet for a moment would
    silently take over from the one the user picked."""
    _two_ready_instances(monkeypatch, tmp_path)
    client = _client(tmp_path, monkeypatch)
    client.post("/api/gpu-rentals/7/attach")
    client.post("/api/gpu-rentals/8/select")

    client.post("/api/gpu-rentals/7/attach")

    registry = tmp_path / "media-state/rental-lanes.json"
    assert list(json.loads(registry.read_text())) == ["vast:8", "vast:7"]


def test_switching_between_attached_machines_touches_nothing_remote(tmp_path: Path, monkeypatch) -> None:
    """Switching is a local file write, and it has to cost like one.

    Routing the common case through attach_rental meant a Vast round-trip plus
    a beacon fetch and a tunnel probe (2.0s measured with two live boxes) to
    change one integer — the click sat there long enough to be clicked again.
    """
    _two_ready_instances(monkeypatch, tmp_path)
    client = _client(tmp_path, monkeypatch)
    client.post("/api/gpu-rentals/7/attach")
    client.post("/api/gpu-rentals/8/attach")

    calls = _fake_vast(monkeypatch, lambda m, p, b: pytest.fail(f"switching called Vast: {m} {p}"))
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon",
                        lambda url: pytest.fail("switching probed the beacon"))
    monkeypatch.setattr(gpu_rentals, "_tunnel_carrying_traffic",
                        lambda *_a, **_k: pytest.fail("switching probed the tunnel"))

    body = client.post("/api/gpu-rentals/7/select").json()

    assert calls == [], "an attached machine already has a lane; nothing to ask Vast"
    assert body["attached"] is True and body["lane"] == "rental7"
    # The H3 lane serves both pages: minimax-h3-image runs on the same rented box,
    # matched by the same lane_needles as the video graphs.
    assert body["studio_pages"] == ["video", "image"]
    registry = tmp_path / "media-state/rental-lanes.json"
    assert list(json.loads(registry.read_text())) == ["vast:7", "vast:8"], "the selected machine leads"


def test_switching_to_a_machine_whose_tunnel_died_still_reconnects_it(tmp_path: Path, monkeypatch) -> None:
    """The shortcut is only valid while the tunnel process is there. Without
    that guard, picking a machine whose ssh had exited would quietly put a lane
    nobody can reach at the front of the routing rules."""
    _two_ready_instances(monkeypatch, tmp_path)
    client = _client(tmp_path, monkeypatch)
    client.post("/api/gpu-rentals/7/attach")
    client.post("/api/gpu-rentals/8/attach")

    monkeypatch.setattr(gpu_rentals, "_tunnel_pid",
                        lambda ref: None if ref.native == "7" else 4321)
    spawned: list[int] = []
    monkeypatch.setattr(gpu_rentals, "_spawn_tunnel", lambda rid, *a: spawned.append(rid))

    assert client.post("/api/gpu-rentals/7/select").json()["attached"] is True

    assert spawned == [RentalRef("vast", "7")], "a dead tunnel has to be respawned, not just reordered"
    registry = tmp_path / "media-state/rental-lanes.json"
    assert list(json.loads(registry.read_text())) == ["vast:7", "vast:8"]


def test_the_machine_list_probes_every_box_at_once(tmp_path: Path, monkeypatch) -> None:
    """Probes are network waits, so serially the list cost their SUM — and the
    studios poll it, which made renting a second box slow down the first one's
    panel. The barrier below only clears if both boxes are probed together; a
    serial pass deadlocks on it and times out."""
    import threading

    _two_ready_instances(monkeypatch, tmp_path)
    barrier = threading.Barrier(2, timeout=5)

    def beacon(url):
        barrier.wait()
        return {"step": "ready", "done": 4, "total": 4, "detail": ""}

    monkeypatch.setattr(gpu_rentals, "_fetch_beacon", beacon)
    client = _client(tmp_path, monkeypatch)

    rentals = client.get("/api/gpu-rentals").json()["rentals"]

    assert [r["rental_id"] for r in rentals] == ["vast:7", "vast:8"], "concurrency must not reorder the list"
    assert all(r["phase"] == "ready" for r in rentals)


def test_attach_fails_loudly_when_the_tunnel_is_refused(tmp_path: Path, monkeypatch) -> None:
    # Seen live 2026-08-08: Vast's proxy refused the account key on a fresh box,
    # ssh exited a moment after Popen returned, and the studio reported the
    # machine attached with a lane pointing at a port nobody listened on.
    _fake_vast(monkeypatch, lambda m, p, b: {"instances": [_ready_instance()]})
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon",
                        lambda url: {"step": "ready", "done": 6, "total": 6, "detail": ""})
    _attach_env(monkeypatch, tmp_path)
    # Exercise the REAL spawner (the helper above stubs it out) so the
    # tunnel-verification path is what is under test.
    monkeypatch.undo()
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "media-state")
    _fake_vast(monkeypatch, lambda m, p, b: {"instances": [_ready_instance()]})
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon",
                        lambda url: {"step": "ready", "done": 6, "total": 6, "detail": ""})
    monkeypatch.setattr(gpu_rentals, "RENTAL_SSH_KEY", tmp_path / "key")
    (tmp_path / "key").write_text("x")
    monkeypatch.setattr(gpu_rentals, "_tunnel_pid", lambda rid: None)

    class DeadSsh:
        pid = 4242

        def poll(self):
            return 255

    def fake_popen(*args, **kwargs):
        log = gpu_rentals._tunnel_dir() / "vast-7.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(
            "Warning: Permanently added '[ssh5.vast.ai]:23124' (ED25519) to the list of known hosts.\n"
            "Welcome to vast.ai.\n"
            "root@ssh5.vast.ai: Permission denied (publickey).\n"
        )
        return DeadSsh()

    monkeypatch.setattr(gpu_rentals.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(gpu_rentals, "_kill_tunnel", lambda rid: None)
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/gpu-rentals/7/attach")

    assert response.status_code == 502
    detail = response.json()["detail"]
    assert "Permission denied (publickey)" in detail
    # The message has to say what to DO about it, not just what broke.
    assert "StrictModes" in detail and "re-rented" in detail
    # No half-attached state left behind for the gateway to route into.
    assert gpu_rentals._read_attachments() == {}


def test_detach_clears_overlay(tmp_path: Path, monkeypatch) -> None:
    _fake_vast(monkeypatch, lambda m, p, b: {"instances": [_ready_instance()]})
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon",
                        lambda url: {"step": "ready", "done": 6, "total": 6, "detail": ""})
    spawned, restarts = _attach_env(monkeypatch, tmp_path)
    killed = []
    monkeypatch.setattr(gpu_rentals, "_kill_tunnel", lambda rid: killed.append(rid))
    client = _client(tmp_path, monkeypatch)
    client.post("/api/gpu-rentals/7/attach")
    body = client.delete("/api/gpu-rentals/7/attach").json()
    assert body["attached"] is False and killed == [RentalRef("vast", "7")]
    assert 'RENTAL_COMFY_LANES=""' in (tmp_path / "media-state/rental-lanes.env").read_text()


def test_destroy_detaches_first(tmp_path: Path, monkeypatch) -> None:
    _fake_vast(monkeypatch, lambda m, p, b: {"instances": [_ready_instance()]} if m == "GET" else {"success": True})
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon",
                        lambda url: {"step": "ready", "done": 6, "total": 6, "detail": ""})
    _attach_env(monkeypatch, tmp_path)
    monkeypatch.setattr(gpu_rentals, "_kill_tunnel", lambda rid: None)
    client = _client(tmp_path, monkeypatch)
    client.post("/api/gpu-rentals/7/attach")
    assert client.delete("/api/gpu-rentals/7").json()["destroyed"] is True
    assert gpu_rentals._read_attachments() == {}


def test_destroy_never_restarts_the_stack(tmp_path: Path, monkeypatch) -> None:
    # Destroying an attached machine used to detach-with-restart and then make a
    # Vast DELETE, so the restart landed on top of the request that asked for it
    # and the browser reported "Failed to fetch" for a destroy that had worked.
    order: list[str] = []
    _fake_vast(monkeypatch, lambda m, p, b: (
        order.append(f"{m} {p}") or ({"instances": [_ready_instance()]} if m == "GET" else {"success": True})
    ))
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon",
                        lambda url: {"step": "ready", "done": 6, "total": 6, "detail": ""})
    _attach_env(monkeypatch, tmp_path)
    monkeypatch.setattr(gpu_rentals, "_kill_tunnel", lambda rid: None)
    monkeypatch.setattr(gpu_rentals, "_schedule_stack_restart",
                        lambda: order.append("RESTART SCHEDULED"))
    client = _client(tmp_path, monkeypatch)
    client.post("/api/gpu-rentals/7/attach")
    order.clear()

    body = client.delete("/api/gpu-rentals/7").json()

    assert body["destroyed"] is True
    assert body["restarting_stack"] is False
    assert "DELETE /v0/instances/7/" in order
    assert "RESTART SCHEDULED" not in order
    # The lane is gone from the registry the gateway reads, so nothing routes
    # to the dead box even without a restart.
    assert gpu_rentals._read_attachments() == {}


def test_destroying_an_unattached_machine_leaves_the_stack_alone(tmp_path: Path, monkeypatch) -> None:
    _fake_vast(monkeypatch, lambda m, p, b: {"instances": [_ready_instance()]} if m == "GET" else {"success": True})
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon",
                        lambda url: {"step": "ready", "done": 6, "total": 6, "detail": ""})
    _attach_env(monkeypatch, tmp_path)
    restarts: list[str] = []
    monkeypatch.setattr(gpu_rentals, "_schedule_stack_restart", lambda: restarts.append("x"))
    client = _client(tmp_path, monkeypatch)

    body = client.delete("/api/gpu-rentals/7").json()

    assert body["destroyed"] is True
    assert body["restarting_stack"] is False
    assert restarts == []


def test_create_fails_over_stale_asks(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")

    def handler(method, path, payload):
        if path == "/v0/bundles/":
            return {"offers": [{"id": 1}, {"id": 2}, {"id": 3}]}
        if path in ("/v0/asks/1/", "/v0/asks/2/"):
            raise gpu_rentals.GpuRentalError("Vast API PUT failed: error 404/3603: no_such_ask", status_code=502)
        assert path == "/v0/asks/3/"
        return {"new_contract": 99, "success": True}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/gpu-rentals", json={"tier": "image"}).json()
    assert body["rental_id"] == "vast:99" and body["offer_id"] == "3"


def test_create_falls_back_to_fresh_search_when_the_pinned_offer_evaporated(tmp_path: Path, monkeypatch) -> None:
    """A UI-supplied offer_id is older than the click that sent it. When that
    ask is gone, rent a fresh one for the same tier instead of dead-ending."""
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")

    def handler(method, path, payload):
        if path == "/v0/asks/999/":  # the stale id the UI pinned
            raise gpu_rentals.GpuRentalError("Vast API PUT failed: error 404/3603: no_such_ask", status_code=502)
        if path == "/v0/bundles/":
            return {"offers": [{"id": 41}, {"id": 42}]}
        assert path == "/v0/asks/41/"
        return {"new_contract": 7001, "success": True}

    calls = _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/gpu-rentals", json={"tier": "minimax", "offer_id": 999}).json()
    assert body["rental_id"] == "vast:7001"
    assert body["offer_id"] == "41", "should rent the fresh cheapest, not the stale pin"
    # ONE search up front (it also prices the credit check and stocks the
    # fallbacks a multi-machine batch needs), the pinned ask first, then the
    # fresh candidate.
    assert [c[1] for c in calls] == ["/v0/bundles/", "/v0/asks/999/", "/v0/asks/41/"]


def test_create_does_not_retry_the_pinned_offer_in_the_fresh_list(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")
    attempts = []

    def handler(method, path, payload):
        if path.startswith("/v0/asks/"):
            attempts.append(path)
            if path == "/v0/asks/50/":
                raise gpu_rentals.GpuRentalError("no_such_ask", status_code=502)
            return {"new_contract": 7002, "success": True}
        return {"offers": [{"id": 50}, {"id": 51}]}  # 50 is the stale pin, echoed back

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/gpu-rentals", json={"tier": "image", "offer_id": 50}).json()
    assert body["offer_id"] == "51"
    assert attempts == ["/v0/asks/50/", "/v0/asks/51/"], "the dead pin must not be tried twice"


def test_create_refuses_a_fallback_priced_past_the_quote(tmp_path: Path, monkeypatch) -> None:
    """The button shows one number. When that ask is gone and the next host is
    more than a few cents dearer, stop and re-quote — do not rent it quietly
    (2026-08-22: quoted $0.596/hr, silently rented $0.640/hr)."""
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")

    def handler(method, path, payload):
        if path == "/v0/asks/41/":  # the quoted ask, gone by the click
            raise gpu_rentals.GpuRentalError("Vast API PUT failed: error 404/3603: no_such_ask", status_code=502)
        if path == "/v0/bundles/":
            return {"offers": [{"id": 41, "gpu_name": "RTX 5090", "dph_total": 0.596},
                               {"id": 42, "gpu_name": "RTX 5090", "dph_total": 0.640}]}
        raise AssertionError(f"must not rent the pricier ask: {path}")

    calls = _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    response = client.post("/api/gpu-rentals", json={
        "tier": "minimax", "gpu_class": "rtx5090", "offer_id": 41, "provider": "vast",
        "max_usd_per_hour": 0.596})
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert "0.596" in detail and "0.640" in detail and "Nothing was rented" in detail
    assert [c[1] for c in calls] == ["/v0/bundles/", "/v0/asks/41/"]
    # And the stale snapshot is gone, so the next plan poll re-prices the card.
    assert not [k for k in gpu_rentals._offer_cache if k.startswith("minimax:")]


def test_create_takes_a_fallback_within_a_few_cents_and_reports_the_price(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")

    def handler(method, path, payload):
        if path == "/v0/asks/41/":
            raise gpu_rentals.GpuRentalError("no_such_ask", status_code=502)
        if path == "/v0/bundles/":
            return {"offers": [{"id": 41, "gpu_name": "RTX 5090", "dph_total": 0.596},
                               {"id": 43, "gpu_name": "RTX 5090", "dph_total": 0.6133},
                               {"id": 42, "gpu_name": "RTX 5090", "dph_total": 0.640}]}
        assert path == "/v0/asks/43/", path
        return {"new_contract": 7003, "success": True}

    calls = _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/gpu-rentals", json={
        "tier": "minimax", "gpu_class": "rtx5090", "offer_id": 41, "provider": "vast",
        "max_usd_per_hour": 0.596}).json()
    assert body["offer_id"] == "43"
    # The bill and the quote, side by side, so the UI can say they differ.
    assert body["usd_per_hour"] == 0.6133
    assert body["quoted_usd_per_hour"] == 0.596
    assert [c[1] for c in calls] == ["/v0/bundles/", "/v0/asks/41/", "/v0/asks/43/"]


def test_rent_price_cap_is_two_cents_or_three_percent() -> None:
    assert gpu_rentals.rent_price_cap(0.596) == 0.616   # 2 cents wins below ~$0.67
    assert gpu_rentals.rent_price_cap(1.00) == 1.03     # 3% wins above it


def test_create_surfaces_a_retryable_error_when_the_whole_market_moved(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")

    def handler(method, path, payload):
        if path == "/v0/bundles/":
            return {"offers": [{"id": 60}]}
        raise gpu_rentals.GpuRentalError("no_such_ask", status_code=502)

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    response = client.post("/api/gpu-rentals", json={"tier": "image", "offer_id": 59})
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "2 candidate offers" in detail and "try again" in detail


def test_offer_search_derives_a_bandwidth_floor_from_the_tier_volume(tmp_path: Path, monkeypatch) -> None:
    """The floor is the speed guarantee (a slow host makes provisioning take
    many billed minutes); ranking WITHIN the qualifying set is by price."""
    floors = []

    def handler(method, path, payload):
        floors.append(payload["inet_down"]["gt"])
        return {"offers": [
            {"id": 1, "dph_total": 0.337, "inet_down": 700, "gpu_name": "RTX 5090"},   # cheap, slow
            {"id": 2, "dph_total": 0.669, "inet_down": 3464, "gpu_name": "RTX 5090"},  # 2x price, 5x link
        ]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.get("/api/gpu-rentals/offers?tier=minimax").json()
    # The floor is derived from the tier's own download volume.
    assert floors[0] == gpu_rentals.tier_min_down_mbps("minimax") > 1000
    assert body["download_gb"] == gpu_rentals.tier_download_gb("minimax")
    # Cheapest first inside the qualifying set; both carry a setup estimate.
    assert body["offers"][0]["offer_id"] == "1"
    assert body["offers"][0]["usd_per_hour"] < body["offers"][1]["usd_per_hour"]
    assert all(o["setup_minutes"] is not None for o in body["offers"])


def test_offer_search_relaxes_the_floor_rather_than_returning_nothing(tmp_path: Path, monkeypatch) -> None:
    floors = []

    def handler(method, path, payload):
        floor = payload["inet_down"]["gt"]
        floors.append(floor)
        return {"offers": [{"id": 9, "dph_total": 0.4, "inet_down": 700}]} if floor <= 500 else {"offers": []}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.get("/api/gpu-rentals/offers?tier=video").json()
    assert body["offers"], "must fall back instead of dead-ending when no fast host exists"
    assert floors == [gpu_rentals.tier_min_down_mbps("video"),
                      gpu_rentals.tier_min_down_mbps("video") // 2, 500]
    assert body["min_down_mbps"] == 500


def test_offer_search_is_cached_so_three_tiers_do_not_trip_the_rate_limiter(tmp_path: Path, monkeypatch) -> None:
    calls = _fake_vast(monkeypatch, lambda m, p, b: {"offers": [{"id": 1, "dph_total": 0.4, "inet_down": 9000}]})
    client = _client(tmp_path, monkeypatch)
    for _ in range(3):
        assert client.get("/api/gpu-rentals/offers?tier=image").status_code == 200
    assert len(calls) == 1, "repeat tier lookups must be served from cache"


@pytest.mark.marketplace_transport
def test_vast_rate_limit_is_retried_once(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals.time, "sleep", lambda _s: None)
    attempts = {"n": 0}

    class _Resp:
        def __init__(self, status, payload):
            self.status_code = status
            self._payload = payload
            self.text = ""

        def json(self):
            return self._payload

    urls: list[str] = []

    def fake_request(method, url, json=None, headers=None, timeout=None):
        attempts["n"] += 1
        urls.append(url)
        if attempts["n"] == 1:
            return _Resp(429, {"error": "HTTPTooManyRequests", "msg": "API requests too frequent", "retry_after": 0})
        return _Resp(200, {"instances": []})

    # Patch the pooled SESSION, not requests.request: every Vast call goes
    # through the provider's pooled session so the TLS connection is reused (a bare
    # requests.request per call was most of the Machines view's load time).
    # Patching the module function here silently let this test hit the real API.
    monkeypatch.setattr(vast_provider, "_session", SimpleNamespace(request=fake_request))
    monkeypatch.setenv("VAST_API_KEY", "test-key")
    client = _client(tmp_path, monkeypatch)
    assert client.get("/api/gpu-rentals").status_code == 200
    assert urls.count(f"{vast_provider.API_BASE}/v1/instances/") == 2, (
        "a rate-limited call should be retried, not surfaced as an error"
    )


def _paused_instance(rid=21):
    return {"id": rid, "label": f"{gpu_rentals.STUDIO_LABEL_PREFIX}minimax-p", "actual_status": "exited",
            "cur_state": "stopped", "dph_total": 0.389, "storage_total_cost": 0.0556, "disk_space": 120.0}


def test_the_reaper_runs_on_a_timer_not_only_when_someone_is_watching(
    tmp_path: Path, monkeypatch,
) -> None:
    """Polling only reaps while the Machines view is open. A box that failed
    after the user closed the tab would otherwise bill until they came back."""
    import threading
    _fake_vast(monkeypatch, lambda m, p, b: {"instances": []})
    # Startup handlers only fire inside the TestClient context manager — merely
    # constructing it, as the other tests here do, does not run them.
    with _client(tmp_path, monkeypatch):
        names = [t.name for t in threading.enumerate()]
    assert "gpu-rental-reaper" in names, names
    # It sleeps before its first sweep, so building the app costs no Vast call.


def _failed_dto(rental_id: str = "vast:31", uptime: float = 0.5) -> dict:
    """A DTO shaped like one whose beacon reported a terminal provisioning error."""
    return {
        "rental_id": rental_id, "managed": True, "phase": "error",
        "label": f"{gpu_rentals.STUDIO_LABEL_PREFIX}video-rtx5090-deadbeef",
        "tier": "video", "gpu_class": "rtx5090", "gpu": "RTX 5090",
        "usd_per_hour": 0.92, "uptime_hours": uptime,
        "provision": {"step": "error", "done": 10, "total": 11,
                      "detail": "download stalled at 10/11: qwen3VL.safetensors"},
    }


def test_a_box_that_failed_provisioning_is_destroyed_after_the_grace_window(
    tmp_path: Path, monkeypatch,
) -> None:
    """Vast bills a broken box exactly like a working one and refunds nothing,
    so nobody having the Machines view open must not mean it bills forever."""
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    destroyed = []
    monkeypatch.setattr(gpu_rentals, "destroy_rental", lambda rid: destroyed.append(rid))

    # First sighting only starts the clock — an instant kill would leave no
    # window at all for a human watching it happen.
    assert gpu_rentals.reap_failed_rentals([_failed_dto()]) == []
    assert destroyed == []

    monkeypatch.setattr(gpu_rentals, "PROVISION_FAILURE_GRACE_SECONDS", 0)
    recorded = gpu_rentals.reap_failed_rentals([_failed_dto()])
    assert destroyed == ["vast:31"]
    assert len(recorded) == 1
    entry = recorded[0]
    # The beacon's reason has to outlive the machine: once it is destroyed
    # there is nothing left to ask why.
    assert entry["reason"] == "download stalled at 10/11: qwen3VL.safetensors"
    assert entry["progress"] == "10/11"
    # And what it cost, since the credit is simply gone.
    assert entry["usd_spent"] == pytest.approx(0.46)
    assert gpu_rentals.recent_rental_failures()[0]["rental_id"] == "vast:31"


def test_reaping_a_failure_takes_its_host_out_of_the_running(tmp_path: Path, monkeypatch) -> None:
    """The rental dies; the machine that broke it is on sale again tomorrow.

    Closing the loop is the point: a stalled box is called out, reaped, and the
    HOST is remembered — otherwise cheapest-first ranking offers it straight
    back and the same hour is lost twice."""
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    monkeypatch.setattr(gpu_rentals, "destroy_rental", lambda rid: None)
    monkeypatch.setattr(gpu_rentals, "PROVISION_FAILURE_GRACE_SECONDS", 0)

    dto = {**_failed_dto(), "machine_id": 144917}
    recorded = gpu_rentals.reap_failed_rentals([dto])

    assert recorded[0]["machine_id"] == 144917
    assert 144917 in gpu_rentals.recent_bad_machine_ids()
    # A failure recorded before the cooldown began does not bar the host.
    assert 144917 not in gpu_rentals.recent_bad_machine_ids(within_seconds=0)


def test_a_box_that_recovers_is_not_reaped(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    destroyed = []
    monkeypatch.setattr(gpu_rentals, "destroy_rental", lambda rid: destroyed.append(rid))

    gpu_rentals.reap_failed_rentals([_failed_dto()])          # starts the clock
    # Past the window now, so only the recovery itself can spare the machine.
    monkeypatch.setattr(gpu_rentals, "PROVISION_FAILURE_GRACE_SECONDS", 0)
    ready = {**_failed_dto(), "phase": "ready", "provision": {"step": "ready"}}
    assert gpu_rentals.reap_failed_rentals([ready]) == []
    assert destroyed == [], "a machine that came good must not be destroyed"
    # ...and the countdown restarts rather than firing instantly next time.
    assert gpu_rentals._read_failure_state()["seen"] == {}


def test_autoreap_can_be_switched_off_to_debug_a_failed_box(
    tmp_path: Path, monkeypatch,
) -> None:
    """The escape hatch for the case that produced this code: recovering a box
    by hand over SSH needs the box to still exist."""
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    monkeypatch.setattr(gpu_rentals, "PROVISION_FAILURE_GRACE_SECONDS", 0)
    monkeypatch.setattr(gpu_rentals, "RENTAL_AUTOREAP", False)
    destroyed = []
    monkeypatch.setattr(gpu_rentals, "destroy_rental", lambda rid: destroyed.append(rid))

    assert gpu_rentals.reap_failed_rentals([_failed_dto()]) == []
    assert destroyed == []


def test_an_unmanaged_failed_instance_is_never_touched(tmp_path: Path, monkeypatch) -> None:
    """The hosted billing gateway rents on this same Vast account."""
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    monkeypatch.setattr(gpu_rentals, "PROVISION_FAILURE_GRACE_SECONDS", 0)
    destroyed = []
    monkeypatch.setattr(gpu_rentals, "destroy_rental", lambda rid: destroyed.append(rid))

    foreign = {**_failed_dto(rental_id=99), "managed": False,
               "label": "hivemind-rental-gpur_customer"}
    assert gpu_rentals.reap_failed_rentals([foreign]) == []
    assert destroyed == []


def test_a_failed_destroy_is_recorded_and_does_not_break_the_list(
    tmp_path: Path, monkeypatch,
) -> None:
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    monkeypatch.setattr(gpu_rentals, "PROVISION_FAILURE_GRACE_SECONDS", 0)

    def boom(rental_id):
        raise gpu_rentals.GpuRentalError("vast is down")

    monkeypatch.setattr(gpu_rentals, "destroy_rental", boom)
    recorded = gpu_rentals.reap_failed_rentals([_failed_dto()])
    assert recorded[0]["destroy_error"] == "vast is down"
    # Still failed, so the next sweep tries again rather than forgetting it.
    assert "vast:31" in gpu_rentals._read_failure_state()["seen"]


def test_a_dismissed_failure_leaves_the_view_but_its_host_stays_barred(
    tmp_path: Path, monkeypatch,
) -> None:
    """Each failure notice is the user's to clear — one at a time or all at
    once — but clearing the notice must not forget the host that caused it,
    or cheapest-first ranking hands the same machine straight back."""
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    monkeypatch.setattr(gpu_rentals, "PROVISION_FAILURE_GRACE_SECONDS", 0)
    monkeypatch.setattr(gpu_rentals, "destroy_rental", lambda rid: None)
    gpu_rentals.reap_failed_rentals([
        {**_failed_dto("vast:31"), "machine_id": 144917},
        {**_failed_dto("vast:32"), "machine_id": 555},
        {**_failed_dto("runpod:abc"), "machine_id": 777},
    ])
    assert [f["rental_id"] for f in gpu_rentals.recent_rental_failures()] == ["vast:31", "vast:32", "runpod:abc"]

    def handler(method, path, payload):
        # "failures" is a literal route segment. If it ever fell through to the
        # {rental_id} destroy route, THIS is where Vast would hear about it.
        assert method == "GET", f"dismissing a notice must not touch the marketplace: {method} {path}"
        return {"instances": []}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)

    body = client.delete("/api/gpu-rentals/failures/vast:31").json()
    assert body["dismissed"] == 1
    assert [f["rental_id"] for f in body["failures"]] == ["vast:32", "runpod:abc"]
    # Persisted, not a per-response filter: the list endpoint agrees on the
    # next poll, and the notice does not come back after a reload.
    assert [f["rental_id"] for f in client.get("/api/gpu-rentals").json()["failures"]] == ["vast:32", "runpod:abc"]
    # Dismissed is not forgotten — the host is still out of the running.
    assert {144917, 555, 777} <= gpu_rentals.recent_bad_machine_ids()

    # A second dismissal of the same rental is a no-op, not an error.
    assert client.delete("/api/gpu-rentals/failures/vast:31").json()["dismissed"] == 0

    body = client.delete("/api/gpu-rentals/failures").json()
    assert body["dismissed"] == 2
    assert body["failures"] == []
    assert client.get("/api/gpu-rentals").json()["failures"] == []
    assert {144917, 555, 777} <= gpu_rentals.recent_bad_machine_ids()
    # The log itself is intact: every entry is still there, just stamped.
    log = gpu_rentals._read_failure_state()["log"]
    assert len(log) == 3 and all(e["dismissed_at"] for e in log)


def test_dismissing_by_rental_matches_older_bare_vast_ids(tmp_path: Path, monkeypatch) -> None:
    """The log predates provider-scoped ids, so a bare int entry must answer
    to the "vast:N" form the view sends — and a destroy that kept failing
    re-records the same rental each sweep; one dismissal clears them all."""
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    now = time.time()
    gpu_rentals._write_failure_state({"seen": {}, "log": [
        {"rental_id": 31, "machine_id": 1, "destroyed_at": now - 10},
        {"rental_id": "vast:31", "machine_id": 1, "destroyed_at": now, "destroy_error": "vast is down"},
        {"rental_id": "vast:40", "machine_id": 2, "destroyed_at": now},
    ]})
    assert gpu_rentals.dismiss_rental_failures("vast:31")["dismissed"] == 2
    assert [f["rental_id"] for f in gpu_rentals.recent_rental_failures()] == ["vast:40"]


def test_pause_detaches_then_stops_keeping_the_disk(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    monkeypatch.setattr(gpu_rentals, "_kill_tunnel", lambda rid: None)
    monkeypatch.setattr(gpu_rentals, "_schedule_stack_restart", lambda: None)
    monkeypatch.setattr(gpu_rentals, "_read_attachments", lambda: {"vast:21": {"lane": "rental21"}})
    monkeypatch.setattr(gpu_rentals, "_write_attachments", lambda a: None)

    def handler(method, path, payload):
        if method == "GET":
            return {"instances": [_paused_instance()]}
        assert (method, path) == ("PUT", "/v0/instances/21/")
        assert payload == {"state": "stopped"}, "must stop (disk kept), never destroy"
        return {"success": True}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/gpu-rentals/21/pause").json()
    assert body == {"rental_id": "vast:21", "paused": True, "was_attached": True}
    # Resume must know to restore routing.
    assert gpu_rentals._read_paused_state()["vast:21"]["was_attached"] is True


def test_resume_starts_and_flags_reattach(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    gpu_rentals._write_paused_state({"vast:21": {"was_attached": True}})

    def handler(method, path, payload):
        if method == "GET":
            return {"instances": [_paused_instance()]}
        assert payload == {"state": "running"}
        return {"success": True}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/gpu-rentals/21/resume").json()
    assert body["resuming"] is True and body["will_reattach"] is True
    assert gpu_rentals._read_paused_state()["vast:21"]["pending_reattach"] is True


def test_paused_instance_reports_paused_phase_and_storage_cost(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    _fake_vast(monkeypatch, lambda m, p, b: {"instances": [_paused_instance()]})
    client = _client(tmp_path, monkeypatch)
    machine = client.get("/api/gpu-rentals").json()["rentals"][0]
    assert machine["phase"] == "paused", "a stopped box is paused, not an error state"
    assert machine["paused_usd_per_hour"] == 0.0556
    assert machine["usd_per_hour"] == 0.389


def test_cheapest_preference_drops_the_speed_floor(tmp_path: Path, monkeypatch) -> None:
    """Same GPU either way: the cheap hosts are the slow-link ones. Which is
    cheaper overall depends on session length, so it must be a user choice."""
    floors = []

    def handler(method, path, payload):
        floors.append(payload["inet_down"]["gt"])
        return {"offers": [{"id": 1, "dph_total": 0.337, "inet_down": 740}]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    client.get("/api/gpu-rentals/offers?tier=minimax&prefer=cheapest")
    assert floors == [500], "cheapest must not impose the tier's bandwidth floor"

    floors.clear()
    client.get("/api/gpu-rentals/offers?tier=minimax&prefer=balanced")
    assert floors[0] == gpu_rentals.tier_min_down_mbps("minimax")


def test_balanced_takes_the_cheapest_host_that_clears_the_floor(tmp_path: Path, monkeypatch) -> None:
    """The floor is the speed guarantee; ranking by time INSIDE it paid 38%
    more to save ~55s (the image/video price anomaly)."""
    def handler(method, path, payload):
        return {"offers": [
            {"id": 1, "dph_total": 0.921, "inet_down": 8000, "gpu_name": "RTX 5090"},  # fastest
            {"id": 2, "dph_total": 0.669, "inet_down": 3515, "gpu_name": "RTX 5090"},  # cheapest, still clears
        ]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    offers = client.get("/api/gpu-rentals/offers?tier=minimax").json()["offers"]
    assert offers[0]["offer_id"] == "2"
    assert offers[0]["usd_per_hour"] == 0.669


def test_rent_honours_the_preference(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")
    floors = []

    def handler(method, path, payload):
        if path == "/v0/bundles/":
            floors.append(payload["inet_down"]["gt"])
            return {"offers": [{"id": 3, "dph_total": 0.337, "inet_down": 740}]}
        return {"new_contract": 8001, "success": True}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/gpu-rentals", json={"tier": "minimax", "prefer": "cheapest"}).json()
    assert body["rental_id"] == "vast:8001"
    assert floors == [500]


def test_minimax_tier_ships_the_turbo_lora(tmp_path: Path, monkeypatch, rental_manifest) -> None:
    """A faster LINK only shortens provisioning. The generation-speed lever is
    the turbo workflow — which needs BOTH the LoRA and upstream's loader on the
    box, since ComfyUI's plain loader cannot apply it to our pruned base."""
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}")
    script = gpu_rentals._onstart_script("minimax")
    manifest = rental_manifest["text"]
    assert ("https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/resolve/main/"
            "minimax_h3_turbo_v4_step600_ema.safetensors\tloras/minimax_h3_turbo_v4_step600_ema.safetensors\n") in manifest
    assert "ComfyUI-MiniMax-H3-Turbo" in script
    # Public HF weights need a redirect-following curl; the R2 presigned URLs do not.
    assert "curl -sfL" in script
    # The tier's bandwidth floor must account for the public bytes too.
    # 43.3 -> 66.0 when the still-image lane landed: H3 Studio is built against
    # Kijai's W4A8 pruned pair (11.7 + 11.0 GB), which is a different
    # quantisation from the int8_convrot FL2VA the video lane converts itself,
    # and REF2VA has no video-lane equivalent at all. One rented box serves both
    # studio pages, so both weight sets ship. 66.0 -> 66.7 when the Fast
    # high-res lane landed: a 0.69GB neural upscaler for H3's own latent, which
    # has to be on disk BEFORE ComfyUI starts because its node builds the
    # model_name combo by scanning that directory at schema time.
    assert gpu_rentals.tier_download_gb("minimax") == pytest.approx(66.7, abs=0.2)
    assert "\tlatent_upscale_models/minimax_h3_latent_upscaler_3d_bf16.safetensors\n" in manifest
    assert "Comfyui_Minimax_h3_latent_Upscaler" in script


# --- rental LoRA registry ---------------------------------------------------
# Dev mode marks an installed LoRA as "available for rentals": uploaded once to
# R2, then appended to the onstart download list of every tier whose serving
# set accepts its base-model family — preserving the local models/loras
# relative path, because the studios send exactly that id as the graph's
# lora_name and the rented box must resolve the same name.


def _install_lora(tmp_path: Path, monkeypatch, rel: str = "glow.safetensors",
                  base: str | None = "LTXV 2.3", size: int = 2048) -> str:
    root = tmp_path / "comfy-loras"
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"x" * size)
    if base is not None:
        Path(str(target) + ".civitai.json").write_text(json.dumps({"modelVersion": {"baseModel": base}}))
    monkeypatch.setattr(gpu_rentals, "COMFY_LORAS_ROOT", root)
    return rel


def _sync_uploads(monkeypatch, status: str = "ready", error: str = "") -> list[tuple[str, str, str]]:
    """Replace the background upload thread with an immediate outcome."""
    calls: list[tuple[str, str, str]] = []

    def fake_start(lora_id: str, path: Path, r2_key: str) -> None:
        calls.append((lora_id, str(path), r2_key))
        gpu_rentals._patch_rental_lora(lora_id, status=status, error=error)

    monkeypatch.setattr(gpu_rentals, "_start_rental_lora_upload", fake_start)
    return calls


def test_rental_lora_routes_require_owner(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch, unlock=False)
    assert client.get("/api/gpu-rentals/loras").status_code == 401
    assert client.post("/api/gpu-rentals/loras", json={}).status_code == 401
    assert client.delete("/api/gpu-rentals/loras/x.safetensors").status_code == 401


def test_rental_lora_add_provisions_matching_tiers(tmp_path: Path, monkeypatch, rental_manifest) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}?sig=x")
    rel = _install_lora(tmp_path, monkeypatch)
    uploads = _sync_uploads(monkeypatch)
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/gpu-rentals/loras", json={"id": rel, "rating": "NSFW"})
    assert response.status_code == 201
    body = response.json()
    # Sidecar family "LTXV 2.3" prefix-matches the tier's "LTXV" — and only
    # the LTX tier: an image-tier box has nothing that could load it.
    assert body["tiers"] == ["video"]
    assert body["rating"] == "nsfw"
    assert uploads == [(rel, str(tmp_path / "comfy-loras" / rel), f"user-loras/{rel}")]

    listed = client.get("/api/gpu-rentals/loras").json()["loras"]
    assert [(e["id"], e["status"]) for e in listed] == [(rel, "ready")]

    script = gpu_rentals._onstart_script("video")
    assert f"https://r2.example/user-loras/{rel}?sig=x\tloras/{rel}\n" in rental_manifest["text"]
    # 11 curated video files + this one, in the same beacon accounting.
    assert '"total":12' in script
    gpu_rentals._onstart_script("image")
    assert rel not in rental_manifest["text"]


def test_rental_lora_keeps_nested_relative_path(tmp_path: Path, monkeypatch, rental_manifest) -> None:
    """A LoRA installed under a subdirectory must land at the SAME relative
    path on the box — the graph's lora_name is that relative id."""
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}")
    rel = _install_lora(tmp_path, monkeypatch, rel="ltx/glow lora.safetensors")
    _sync_uploads(monkeypatch)
    client = _client(tmp_path, monkeypatch)
    assert client.post("/api/gpu-rentals/loras", json={"id": rel, "rating": "sfw"}).status_code == 201
    assert gpu_rentals._rental_lora_downloads("video") == [(f"user-loras/{rel}", "loras/ltx")]
    gpu_rentals._onstart_script("video")
    assert "\tloras/ltx/glow lora.safetensors\n" in rental_manifest["text"]


def test_rental_lora_minimax_h3_maps_to_the_minimax_tier(tmp_path: Path, monkeypatch, rental_manifest) -> None:
    """Civitai's H3 category is "MiniMax H3" (character/style LoRAs exist there,
    not just the turbo distill). They ride the H3 tier only — nothing on the
    LTX or image boxes can load them."""
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}")
    rel = _install_lora(tmp_path, monkeypatch, rel="h3/lain.safetensors", base="MiniMax H3")
    _sync_uploads(monkeypatch)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/gpu-rentals/loras", json={"id": rel, "rating": "sfw"}).json()
    assert body["tiers"] == ["minimax"]
    gpu_rentals._onstart_script("minimax")
    assert "\tloras/h3/lain.safetensors\n" in rental_manifest["text"]
    gpu_rentals._onstart_script("video")
    assert rel not in rental_manifest["text"]


def test_rental_lora_context_bases_cover_handplaced_files(tmp_path: Path, monkeypatch) -> None:
    """No sidecar → fall back to the base families the LoRA panel was scoped
    to when the user clicked. Krea 2 rides on both image tiers."""
    rel = _install_lora(tmp_path, monkeypatch, rel="hand-placed.safetensors", base=None)
    _sync_uploads(monkeypatch)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/gpu-rentals/loras",
                       json={"id": rel, "rating": "sfw", "contextBaseModels": ["Krea 2"]}).json()
    assert body["tiers"] == ["image", "video"]


def test_rental_lora_rejects_bad_input(tmp_path: Path, monkeypatch) -> None:
    rel = _install_lora(tmp_path, monkeypatch, rel="klein.safetensors", base="Flux.2 Klein 9B")
    _sync_uploads(monkeypatch)
    client = _client(tmp_path, monkeypatch)
    # Rating is the whole point of the add dialog; no default.
    assert client.post("/api/gpu-rentals/loras", json={"id": rel, "rating": "spicy"}).status_code == 400
    # Klein runs local-MLX only — no rental tier can load it, say so up front.
    response = client.post("/api/gpu-rentals/loras", json={"id": rel, "rating": "sfw"})
    assert response.status_code == 400
    assert "Flux.2 Klein 9B" in response.json()["detail"]
    # Missing file and traversal both refuse.
    assert client.post("/api/gpu-rentals/loras", json={"id": "missing.safetensors", "rating": "sfw"}).status_code == 404
    assert client.post("/api/gpu-rentals/loras", json={"id": "../../etc/passwd", "rating": "sfw"}).status_code == 400


def test_rental_lora_failed_upload_is_excluded_and_retryable(tmp_path: Path, monkeypatch, rental_manifest) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}")
    rel = _install_lora(tmp_path, monkeypatch)
    _sync_uploads(monkeypatch, status="error", error="R2 upload failed: HTTP 500")
    client = _client(tmp_path, monkeypatch)
    client.post("/api/gpu-rentals/loras", json={"id": rel, "rating": "sfw"})
    listed = client.get("/api/gpu-rentals/loras").json()["loras"]
    assert listed[0]["status"] == "error" and "HTTP 500" in listed[0]["error"]
    # A half-uploaded LoRA must never reach a box's download list.
    gpu_rentals._onstart_script("video")
    assert rel not in rental_manifest["text"]
    # Re-adding is the retry path.
    _sync_uploads(monkeypatch)
    assert client.post("/api/gpu-rentals/loras", json={"id": rel, "rating": "sfw"}).status_code == 201
    gpu_rentals._onstart_script("video")
    assert rel in rental_manifest["text"]


def test_rental_lora_remove(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}")
    # The R2 object delete is hygiene, not correctness: a presign failure
    # (no Cloudflare env in tests) must not block the withdrawal.
    monkeypatch.setattr(gpu_rentals, "_presign_r2",
                        lambda method, key: (_ for _ in ()).throw(RuntimeError("no creds")))
    rel = _install_lora(tmp_path, monkeypatch, rel="ltx/glow.safetensors")
    _sync_uploads(monkeypatch)
    client = _client(tmp_path, monkeypatch)
    client.post("/api/gpu-rentals/loras", json={"id": rel, "rating": "sfw"})
    assert client.delete(f"/api/gpu-rentals/loras/{rel}").status_code == 200
    assert client.get("/api/gpu-rentals/loras").json()["loras"] == []
    assert rel not in gpu_rentals._onstart_script("video")
    assert client.delete(f"/api/gpu-rentals/loras/{rel}").status_code == 404


def test_rental_lora_counts_toward_tier_download_gb(tmp_path: Path, monkeypatch) -> None:
    baseline = gpu_rentals.tier_download_gb("video")
    gpu_rentals._write_rental_loras({
        "big.safetensors": {
            "id": "big.safetensors", "r2_key": "user-loras/big.safetensors",
            "tiers": ["video"], "status": "ready", "size_gb": 1.6,
        },
    })
    assert gpu_rentals.tier_download_gb("video") == pytest.approx(baseline + 1.6, abs=0.1)
    # Not ready → not provisioned → not counted.
    gpu_rentals._write_rental_loras({
        "big.safetensors": {
            "id": "big.safetensors", "r2_key": "user-loras/big.safetensors",
            "tiers": ["video"], "status": "uploading", "size_gb": 1.6,
        },
    })
    assert gpu_rentals.tier_download_gb("video") == pytest.approx(baseline, abs=0.01)


def test_long_running_services_survive_a_signal_at_onstart_group(tmp_path: Path, monkeypatch) -> None:
    """ComfyUI and the beacon outlive whatever kills onstart's process group.

    Measured 2026-08-13: launched with bare `nohup`, ComfyUI stayed in onstart's
    group and was killed mid-session — its log stopped at "got prompt" with no
    traceback, 2 MiB of 32 GB VRAM in use, and a submitted job rendered nothing
    until a person asked why. nohup only blocks SIGHUP; setsid gives the process
    its own session, so only a signal aimed at IT can end it.
    """
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}?sig=x")
    onstart = gpu_rentals._onstart_script("video")
    comfy = [line for line in onstart.splitlines() if "main.py" in line]
    assert comfy, "onstart launches ComfyUI"
    for line in comfy:
        assert "setsid" in line, "ComfyUI must not share onstart's process group"
        assert "< /dev/null" in line, "and must never block on a vanished terminal"
    # The beacon is how the boot reports itself, so it needs the same treatment.
    beacon = [line for line in onstart.splitlines() if "http.server" in line]
    assert beacon and all("setsid" in line for line in beacon)


def test_a_lane_whose_far_end_is_dead_is_not_reported_alive(tmp_path: Path, monkeypatch) -> None:
    """`tunnel_alive` must mean "answers", not "accepts".

    ssh accepts the local connection BEFORE it opens the channel to the far end,
    so a TCP probe passes against a forward whose remote service is dead —
    verified on a live lane: connect() succeeded while curl got http_code=000.
    That is how a killed ComfyUI kept every reading green.
    """
    monkeypatch.setattr(gpu_rentals, "_read_attachments",
                        lambda: {"vast:7": {"local_port": 19490}})

    class _Response:
        def __init__(self, ok):
            self.ok = ok

    # The far end answers: healthy.
    monkeypatch.setattr(gpu_rentals.requests, "get", lambda *a, **k: _Response(True))
    assert gpu_rentals._tunnel_carrying_traffic(RentalRef("vast", "7")) is True

    # The forward accepts but the far end resets — the exact shape of the bug.
    def _reset(*_args, **_kwargs):
        raise ConnectionResetError(54, "Connection reset by peer")

    monkeypatch.setattr(gpu_rentals.requests, "get", _reset)
    assert gpu_rentals._tunnel_carrying_traffic(RentalRef("vast", "7")) is False

    # The far end is up but unhealthy (5xx): still not usable.
    monkeypatch.setattr(gpu_rentals.requests, "get", lambda *a, **k: _Response(False))
    assert gpu_rentals._tunnel_carrying_traffic(RentalRef("vast", "7")) is False

    # No attachment at all → nothing to be alive.
    monkeypatch.setattr(gpu_rentals, "_read_attachments", lambda: {})
    assert gpu_rentals._tunnel_carrying_traffic(RentalRef("vast", "7")) is False


def test_attach_separates_a_dead_forward_from_a_dead_comfyui(tmp_path: Path, monkeypatch) -> None:
    """The two failures need different fixes, so they get different sentences."""
    monkeypatch.setattr(gpu_rentals, "_kill_tunnel", lambda rental_id: None)
    monkeypatch.setattr(gpu_rentals, "_tunnel_failure_reason", lambda rental_id: "ssh said nothing")

    class _Proc:
        def poll(self):
            return None

    # Forward opens, nothing answers on it → a MACHINE problem, named as one.
    monkeypatch.setattr(gpu_rentals, "_lane_answers", lambda port, timeout=1.0: False)
    opened = contextlib.nullcontext()
    monkeypatch.setattr(gpu_rentals.socket, "create_connection", lambda *a, **k: opened)
    with pytest.raises(gpu_rentals.GpuRentalError) as caught:
        gpu_rentals._await_tunnel(7, _Proc(), 19490, timeout=0.6)
    assert "ComfyUI did not answer" in str(caught.value)
    assert caught.value.status_code == 502

    # Forward never opens → an SSH problem, and ssh's own words come back.
    def _refused(*_args, **_kwargs):
        raise OSError("connection refused")

    monkeypatch.setattr(gpu_rentals.socket, "create_connection", _refused)
    with pytest.raises(gpu_rentals.GpuRentalError) as caught:
        gpu_rentals._await_tunnel(7, _Proc(), 19490, timeout=0.6)
    assert "did not come up" in str(caught.value)
    assert "ssh said nothing" in str(caught.value)

    # And a lane that answers attaches without complaint.
    monkeypatch.setattr(gpu_rentals, "_lane_answers", lambda port, timeout=1.0: True)
    gpu_rentals._await_tunnel(7, _Proc(), 19490, timeout=0.6)


def _running_box(**over) -> dict:
    """A managed studio box that Vast reports running, beacon port published."""
    return {
        "id": 48183103,
        "label": f"{gpu_rentals.STUDIO_LABEL_PREFIX}minimax-rtx5090-38fe4e13",
        "actual_status": "running",
        "public_ipaddr": "38.87.238.254",
        "machine_id": 141928,
        "start_date": time.time() - 600,
        "ports": {f"{gpu_rentals.BEACON_PORT}/tcp": [{"HostPort": "43798"}]},
        **over,
    }


def test_a_missed_beacon_poll_does_not_rewind_the_progress_ladder(monkeypatch) -> None:
    """A poll that times out is a missed reading, not a state.

    2026-08-20, rental vast:48183103: the beacon is a single-threaded
    `python3 -m http.server` on a box saturating its own uplink pulling models
    over 8 ranged connections per file. Measured mid-download, 21 of 24 polls
    got nothing within 8s while the box was working perfectly. The old code
    answered every miss with step "booting", so the studio's ladder rewound to
    "Booting host" and a box that was 3/5 through its models looked like it had
    started over.
    """
    gpu_rentals._BEACON_CACHE.clear()
    live = {"step": "downloading", "done": 3, "total": 5, "detail": "the 21GB transformer"}
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon", lambda *_a, **_k: live)
    dto = gpu_rentals._instance_dto(_vast_instance(_running_box()), probe=True)
    assert dto["provision"]["step"] == "downloading"
    assert dto["provision"]["done"] == 3
    assert dto["provision"]["stale_seconds"] == 0

    # Now every poll misses. The box has not moved backwards; we simply cannot
    # hear it, and the reading we have is the one to show.
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon", lambda *_a, **_k: None)
    dto = gpu_rentals._instance_dto(_vast_instance(_running_box()), probe=True)
    assert dto["provision"]["step"] == "downloading", "a timed-out poll must not rewind to booting"
    assert dto["provision"]["done"] == 3
    assert dto["phase"] == "provisioning"

    # A box we have genuinely never heard from is still reported as booting:
    # there is nothing remembered to show, and that IS what is happening.
    gpu_rentals._BEACON_CACHE.clear()
    dto = gpu_rentals._instance_dto(_vast_instance(_running_box()), probe=True)
    assert dto["provision"]["step"] == "booting"


def test_a_failed_beacon_reading_survives_the_polls_that_miss_it(monkeypatch) -> None:
    """The reaper reads the beacon through the same timeout as the studio.

    This is what made the flicker expensive rather than cosmetic. A host whose
    network dies kills the model downloads AND the beacon together, so the box
    that most needs reaping is the one least able to answer. On 2026-08-20 the
    error reading existed for five minutes before a poll happened to land in
    one of the box's brief responsive windows; miss it and reap_failed_rentals
    sees "provisioning", not "error", and the dead box bills at $0.487/hr.
    """
    gpu_rentals._BEACON_CACHE.clear()
    died = {"step": "error", "done": 3, "total": 5,
            "detail": "download failed at 3/5: minimax_h3_fl2va_pruned_int8_convrot.safetensors"}
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon", lambda *_a, **_k: died)
    assert gpu_rentals._instance_dto(_vast_instance(_running_box()), probe=True)["phase"] == "error"

    # The box stops answering entirely — as a network-dead box does. The
    # verdict it already gave us stands.
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon", lambda *_a, **_k: None)
    dto = gpu_rentals._instance_dto(_vast_instance(_running_box()), probe=True)
    assert dto["phase"] == "error", "a box that reported failure must stay reapable once it goes quiet"
    assert "download failed at 3/5" in dto["provision"]["detail"]


def test_a_box_that_goes_permanently_quiet_is_reaped_not_billed(monkeypatch) -> None:
    """Silence is not failure — until it is.

    A healthy box starves its beacon for minutes at a stretch while pulling
    models at full speed, so a short quiet spell must never destroy one. A box
    that never comes back is a dead host, and the container still running is
    exactly why nothing else notices.
    """
    gpu_rentals._BEACON_CACHE.clear()
    working = {"step": "downloading", "done": 3, "total": 5, "detail": "the 21GB transformer"}
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon", lambda *_a, **_k: working)
    gpu_rentals._instance_dto(_vast_instance(_running_box()), probe=True)

    # Quiet for a few minutes: busy, not dead. Destroying this box would throw
    # away the models it has already pulled and the money they cost.
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon", lambda *_a, **_k: None)
    gpu_rentals._BEACON_CACHE["vast:48183103"]["at"] = time.time() - 240
    assert gpu_rentals._instance_dto(_vast_instance(_running_box()), probe=True)["phase"] == "provisioning"

    # Quiet past the deadline: terminal, and it says why.
    gpu_rentals._BEACON_CACHE["vast:48183103"]["at"] = time.time() - gpu_rentals.BEACON_SILENCE_SECONDS - 60
    dto = gpu_rentals._instance_dto(_vast_instance(_running_box()), probe=True)
    assert dto["phase"] == "error"
    assert "went quiet at downloading" in dto["provision"]["detail"]
    assert "destroy it and rent again" in dto["provision"]["detail"]
    assert dto["machine_id"] == 141928, "the reaper blacklists the HOST, so it has to survive"


def test_a_ready_box_is_never_destroyed_over_a_quiet_status_file(monkeypatch) -> None:
    """The beacon has done its job by the time the box is serving.

    Guard on the one way this escalation could be catastrophic: reaping a
    working machine. A ready box answers for itself through its tunnel and its
    ComfyUI; its provisioning status file is finished business.
    """
    gpu_rentals._BEACON_CACHE.clear()
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon",
                        lambda *_a, **_k: {"step": "ready", "done": 5, "total": 5, "detail": ""})
    assert gpu_rentals._instance_dto(_vast_instance(_running_box()), probe=True)["phase"] == "ready"

    monkeypatch.setattr(gpu_rentals, "_fetch_beacon", lambda *_a, **_k: None)
    gpu_rentals._BEACON_CACHE["vast:48183103"]["at"] = time.time() - gpu_rentals.BEACON_SILENCE_SECONDS * 5
    dto = gpu_rentals._instance_dto(_vast_instance(_running_box()), probe=True)
    assert dto["phase"] == "ready", "a working machine must never be reaped for a quiet beacon"


def test_restarting_the_stack_does_not_read_as_silence(monkeypatch) -> None:
    """The cache is in-memory, so a restart forgets what it had heard.

    Without a floor at process start, restarting the stack next to a box that
    is 20 minutes into a legitimately slow download would count all 20 minutes
    as silence and destroy it on the first sweep — turning a routine restart
    into a way to lose rentals.
    """
    gpu_rentals._BEACON_CACHE.clear()
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon", lambda *_a, **_k: None)
    monkeypatch.setattr(gpu_rentals, "_PROCESS_STARTED", time.time() - 30)
    old = _running_box(start_date=time.time() - gpu_rentals.BEACON_SILENCE_SECONDS * 3)
    dto = gpu_rentals._instance_dto(_vast_instance(old), probe=True)
    assert dto["phase"] == "provisioning", "silence cannot predate our ability to hear it"

    # Once THIS process has been listening long enough, the verdict lands.
    monkeypatch.setattr(gpu_rentals, "_PROCESS_STARTED",
                        time.time() - gpu_rentals.BEACON_SILENCE_SECONDS - 60)
    dto = gpu_rentals._instance_dto(_vast_instance(old), probe=True)
    assert dto["phase"] == "error"
    assert "never reported in" in dto["provision"]["detail"]


def test_a_box_with_no_published_beacon_port_is_not_judged_on_silence(monkeypatch) -> None:
    """With nowhere to ask, "no answer" says nothing about the box."""
    gpu_rentals._BEACON_CACHE.clear()
    monkeypatch.setattr(gpu_rentals, "_fetch_beacon", lambda *_a, **_k: None)
    monkeypatch.setattr(gpu_rentals, "_PROCESS_STARTED",
                        time.time() - gpu_rentals.BEACON_SILENCE_SECONDS - 60)
    no_ports = _running_box(ports={}, start_date=time.time() - gpu_rentals.BEACON_SILENCE_SECONDS * 3)
    dto = gpu_rentals._instance_dto(_vast_instance(no_ports), probe=True)
    assert dto["phase"] == "provisioning", "a missing port map is not a dead host"


# --- Quick resume: a resume the host is not honouring ------------------------


def test_a_resume_the_host_ignores_is_flagged_after_the_grace_period(tmp_path: Path, monkeypatch) -> None:
    """Vast: a stopped box restarts only "if GPU available" and sits in
    "Scheduling" otherwise — "if stuck >30 seconds, GPU likely rented by
    another user". The DTO says so instead of showing a spinner forever."""
    client = _client(tmp_path, monkeypatch)
    _fake_vast(monkeypatch, lambda m, p, b: {"instances": [_paused_instance()]})
    gpu_rentals._write_paused_state({"vast:21": {"pending_reattach": False,
                                                  "resumed_at": time.time() - gpu_rentals.RESUME_GRACE_SECONDS - 5}})
    machine = client.get("/api/gpu-rentals").json()["rentals"][0]
    assert machine["phase"] == "paused"
    assert machine["resume_blocked"] is True
    assert machine["resume_requested_at"] is not None
    # Within the grace period it is just resuming.
    gpu_rentals._write_paused_state({"vast:21": {"pending_reattach": False, "resumed_at": time.time()}})
    machine = client.get("/api/gpu-rentals").json()["rentals"][0]
    assert machine["resume_blocked"] is False


def test_resume_records_when_it_was_asked_for(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    gpu_rentals._write_paused_state({"vast:21": {"was_attached": False}})

    def handler(method, path, body):
        if method == "GET":
            return {"instances": [_paused_instance()]}
        return {"success": True}

    _fake_vast(monkeypatch, handler)
    body = client.post("/api/gpu-rentals/21/resume").json()
    assert body["resuming"] is True
    assert gpu_rentals._read_paused_state()["vast:21"]["resumed_at"] > 0


# --- warm volumes: the no-download provisioning path -------------------------


class _FakeVolumeProvider:
    """RunPod at the provider boundary: volumes and pods, recorded."""

    def __init__(self) -> None:
        self.volumes: list[dict] = []
        self.specs: list = []
        self.destroyed: list[str] = []

    def create_network_volume(self, name, size_gb, data_center_id):
        self.volumes.append({"name": name, "size": size_gb, "dataCenterId": data_center_id})
        return f"vol{len(self.volumes)}"

    def list_network_volumes(self):
        return list(self.volumes)

    def delete_network_volume(self, volume_id):
        self.volumes = [v for v in self.volumes if v.get("id") != volume_id]


def _warm_setup(tmp_path: Path, monkeypatch) -> tuple[_FakeVolumeProvider, list]:
    _client(tmp_path, monkeypatch)  # MEDIA_STATE_ROOT under tmp_path
    fake = _FakeVolumeProvider()
    monkeypatch.setattr(gpu_rentals.rental_providers, "get", lambda key: fake)
    rented: list[dict] = []

    def fake_create_rental(tier, *args, **kwargs):
        rented.append({"tier": tier, "kwargs": kwargs})
        return {"rental_id": "runpod:stockpod", "provider": "runpod", "rentals": []}

    monkeypatch.setattr(gpu_rentals, "create_rental", fake_create_rental)
    monkeypatch.setattr(gpu_rentals, "destroy_rental", lambda rid: fake.destroyed.append(str(rid)))
    return fake, rented


def test_create_warm_volume_makes_the_volume_and_rents_a_stocking_box(tmp_path: Path, monkeypatch) -> None:
    fake, rented = _warm_setup(tmp_path, monkeypatch)
    out = gpu_rentals.create_warm_volume("minimax", "EU-RO-1")
    assert fake.volumes == [{"name": "hivemind-warm-minimax-eu-ro-1", "size": gpu_rentals.tier_disk_gb("minimax"),
                             "dataCenterId": "EU-RO-1"}]
    assert out["state"] == "stocking" and out["volume_id"] == "vol1" and out["stocking_rental_id"] == "runpod:stockpod"
    # The stocking box is an ordinary rental of the tier, handed the volume to fill.
    assert rented[0]["tier"] == "minimax"
    assert rented[0]["kwargs"]["_warm_volume"]["volume_id"] == "vol1"
    assert rented[0]["kwargs"]["_label_note"] == "stock"
    # Nothing is stocked yet, so a new rental would not pick it up.
    assert gpu_rentals.warm_volume_for("minimax") is None
    # A second call while stocking is refused rather than doubled.
    with pytest.raises(gpu_rentals.GpuRentalError):
        gpu_rentals.create_warm_volume("minimax", "EU-RO-1")


def test_a_stocking_box_that_reports_ready_marks_the_volume_stocked_and_is_destroyed(tmp_path: Path, monkeypatch) -> None:
    fake, _rented = _warm_setup(tmp_path, monkeypatch)
    gpu_rentals.create_warm_volume("minimax", "EU-RO-1")
    gpu_rentals._settle_warm_volumes([{"rental_id": "runpod:stockpod", "phase": "provisioning"}])
    assert gpu_rentals.warm_volume_for("minimax") is None, "not until the box says ready"
    gpu_rentals._settle_warm_volumes([{"rental_id": "runpod:stockpod", "phase": "ready"}])
    entry = gpu_rentals.warm_volume_for("minimax")
    assert entry and entry["state"] == "stocked" and entry["volume_id"] == "vol1"
    assert fake.destroyed == ["runpod:stockpod"], "the volume outlives the box that filled it"
    listed = gpu_rentals.list_warm_volumes()
    assert listed[0]["tier"] == "minimax" and listed[0]["state"] == "stocked"


def test_a_stocking_box_that_fails_marks_the_volume_error_and_keeps_it(tmp_path: Path, monkeypatch) -> None:
    fake, _rented = _warm_setup(tmp_path, monkeypatch)
    gpu_rentals.create_warm_volume("minimax", "EU-RO-1")
    gpu_rentals._settle_warm_volumes([{"rental_id": "runpod:stockpod", "phase": "error",
                                       "provision": {"detail": "download failed at 6/8"}}])
    entry = gpu_rentals._read_warm_volumes()["runpod:minimax"]
    assert entry["state"] == "error" and "download failed" in entry["detail"]
    assert fake.volumes, "the volume is kept: a retry re-stocks in place"
    # Re-stocking reuses the same volume (same data center) instead of creating another.
    gpu_rentals.create_warm_volume("minimax", "EU-RO-1")
    assert len(fake.volumes) == 1
    assert gpu_rentals._read_warm_volumes()["runpod:minimax"]["state"] == "stocking"


def test_a_new_rental_mounts_the_stocked_volume_and_a_cold_one_does_not(tmp_path: Path, monkeypatch) -> None:
    """What the whole thing is for: create_rental hands the provider the
    stocked volume (and its data center) so the box skips every download."""
    _client(tmp_path, monkeypatch)
    gpu_rentals._write_warm_volumes({"runpod:minimax": {
        "provider": "runpod", "volume_id": "volX", "data_center_id": "EU-RO-1", "size_gb": 120,
        "state": "stocked"}})
    specs = []

    class _Provider:
        def create(self, spec):
            specs.append(spec)
            return "pod1"

        @staticmethod
        def ask_evaporated(exc):
            return False

    monkeypatch.setattr(gpu_rentals.rental_providers, "get", lambda key: _Provider())
    monkeypatch.setattr(gpu_rentals, "rental_public_key", lambda: "ssh-ed25519 AAAA test")
    monkeypatch.setattr(gpu_rentals, "_onstart_script", lambda tier: "#!/bin/bash\ntrue\n")
    monkeypatch.setattr(gpu_rentals, "_assert_affordable", lambda *a, **k: None)
    monkeypatch.setattr(gpu_rentals, "_forget_offers", lambda tier: None)
    offer = {"provider": "runpod", "offer_id": "NVIDIA GeForce RTX 5090", "usd_per_hour": 0.89, "warm": True}
    monkeypatch.setattr(gpu_rentals, "_search_offers", lambda *a, **k: ([], {}))
    monkeypatch.setattr(gpu_rentals, "_rank_offers", lambda *a, **k: [offer])
    out = gpu_rentals.create_rental("minimax", gpu_class="rtx5090")
    assert out["rental_id"] == "runpod:pod1"
    assert specs[0].network_volume_id == "volX" and specs[0].data_center_ids == ["EU-RO-1"]
    specs.clear()
    gpu_rentals.create_rental("minimax", gpu_class="rtx5090", warm=False)
    assert specs[0].network_volume_id is None and specs[0].data_center_ids == []
    # An offer the search could not quote warm (no secure price) stays cold
    # even though a volume exists — never billed above its quote.
    specs.clear()
    offer["warm"] = False
    gpu_rentals.create_rental("minimax", gpu_class="rtx5090")
    assert specs[0].network_volume_id is None


def test_offers_are_quoted_warm_at_the_secure_price_when_a_volume_is_stocked(tmp_path: Path, monkeypatch) -> None:
    _client(tmp_path, monkeypatch)
    from hivemind_content_studio.rental_providers import Offer as _Offer
    cold = _Offer(provider="runpod", offer_id="NVIDIA GeForce RTX 5090", gpu_name="RTX 5090", usd_per_hour=0.69,
                  vram_mb=32768, ram_gb=64.0, raw={"securePrice": 0.89, "communityPrice": 0.69})
    ranked = gpu_rentals._rank_offers("minimax", [cold])
    assert ranked[0]["usd_per_hour"] == 0.69 and ranked[0]["warm"] is False
    gpu_rentals._write_warm_volumes({"runpod:minimax": {"provider": "runpod", "volume_id": "volX",
                                                        "data_center_id": "EU-RO-1", "size_gb": 120, "state": "stocked"}})
    ranked = gpu_rentals._rank_offers("minimax", [cold])
    assert ranked[0]["usd_per_hour"] == 0.89 and ranked[0]["warm"] is True
    assert ranked[0]["warm_volume_id"] == "volX" and ranked[0]["setup_minutes"] == gpu_rentals.WARM_SETUP_MINUTES
    # No secure price known: not warm, community price kept.
    nosecure = _Offer(provider="runpod", offer_id="NVIDIA GeForce RTX 5090", gpu_name="RTX 5090", usd_per_hour=0.69,
                      vram_mb=32768, ram_gb=64.0, raw={"communityPrice": 0.69})
    assert gpu_rentals._rank_offers("minimax", [nosecure])[0]["warm"] is False


def test_a_stocking_rental_only_considers_the_volume_providers_offers(tmp_path: Path, monkeypatch) -> None:
    """Ranked offers are cheapest-first across marketplaces; a Vast box cannot
    mount a RunPod volume, so it must never be the box that "stocks" it."""
    _client(tmp_path, monkeypatch)
    specs = []

    class _Provider:
        def __init__(self, key):
            self.key = key

        def create(self, spec):
            specs.append((self.key, spec))
            return "pod1"

        @staticmethod
        def ask_evaporated(exc):
            return False

    monkeypatch.setattr(gpu_rentals.rental_providers, "get", lambda key: _Provider(key))
    monkeypatch.setattr(gpu_rentals, "rental_public_key", lambda: "ssh-ed25519 AAAA test")
    monkeypatch.setattr(gpu_rentals, "_onstart_script", lambda tier: "#!/bin/bash\ntrue\n")
    monkeypatch.setattr(gpu_rentals, "_assert_affordable", lambda *a, **k: None)
    monkeypatch.setattr(gpu_rentals, "_forget_offers", lambda tier: None)
    monkeypatch.setattr(gpu_rentals, "_search_offers", lambda *a, **k: ([], {}))
    monkeypatch.setattr(gpu_rentals, "_rank_offers", lambda *a, **k: [
        {"provider": "vast", "offer_id": "123", "usd_per_hour": 0.60},
        {"provider": "runpod", "offer_id": "NVIDIA GeForce RTX 5090", "usd_per_hour": 0.69},
    ])
    volume = {"provider": "runpod", "volume_id": "volX", "data_center_id": "EU-RO-1"}
    out = gpu_rentals.create_rental("minimax", gpu_class="rtx5090", _warm_volume=volume, _label_note="stock")
    assert out["rental_id"] == "runpod:pod1"
    assert specs == [("runpod", specs[0][1])]
    assert specs[0][1].network_volume_id == "volX" and "-stock-" in specs[0][1].label
