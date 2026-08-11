from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio import gpu_rentals
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
def _funded_account(monkeypatch):
    """Renting checks the credit first. That is its own seam so the tests
    about renting do not all have to fake a bank balance; the tests about the
    credit gate override this."""
    monkeypatch.setattr(gpu_rentals, "account_state", lambda: {
        "credit": 500.0, "usd_per_hour_running": 0.0,
        "hours_remaining": None, "machines_running": 0,
    })


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


def _fake_vast(monkeypatch, handler) -> list[tuple[str, str, dict | None]]:
    calls: list[tuple[str, str, dict | None]] = []

    def fake(method: str, path: str, payload: dict | None = None) -> dict:
        calls.append((method, path, payload))
        return handler(method, path, payload)

    monkeypatch.setattr(gpu_rentals, "_vast_request", fake)
    return calls


def test_gpu_rental_routes_require_owner(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch, unlock=False)
    assert client.get("/api/gpu-rentals").status_code == 401
    assert client.get("/api/gpu-rentals/offers").status_code == 401
    assert client.post("/api/gpu-rentals", json={}).status_code == 401
    assert client.delete("/api/gpu-rentals/123").status_code == 401


def test_offers_filters_and_shape(tmp_path: Path, monkeypatch) -> None:
    def handler(method, path, payload):
        assert (method, path) == ("POST", "/v0/bundles/")
        assert payload["datacenter"] == {"eq": True}
        assert payload["verified"] == {"eq": True}
        # One query covers the tier's whole GPU ladder — three per-class
        # queries per tier would triple the calls behind a polling view.
        assert payload["gpu_name"]["in"] == [
            "RTX 4090", "RTX 5090", "RTX PRO 6000 WS", "RTX PRO 6000 S"]
        return {"offers": [{"id": 1, "gpu_name": "RTX 5090", "dph_total": 0.402, "gpu_ram": 32607,
                            "inet_down": 755.0, "reliability2": 0.9942, "geolocation": "South Korea, KR"}]}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.get("/api/gpu-rentals/offers?tier=image").json()
    assert body["tier"] == "image"
    assert body["offers"][0] == {
        "offer_id": 1, "gpu": "RTX 5090", "gpu_class": "rtx5090", "vram_mb": 32607,
        "usd_per_hour": 0.402, "down_mbps": 755.0, "reliability": 0.9942,
        "geolocation": "South Korea, KR", "dlperf": None,
        # Time to first generation on THIS host, from the tier's download volume.
        "setup_minutes": 4.6,
    }


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
    assert 10 not in ids, "half-power Max-Q must not be offered as a PRO 6000"
    assert 11 in ids
    # A merely slower-than-median host of the right SKU still qualifies, and an
    # unbenchmarked one is not evidence of anything.
    assert 12 in ids and 13 in ids
    assert next(o for o in offers if o["offer_id"] == 11)["dlperf"] == 278.9


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


def test_create_uses_cheapest_offer_and_provisioning_onstart(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}?sig=x")

    def handler(method, path, payload):
        if path == "/v0/bundles/":
            return {"offers": [{"id": 77, "dph_total": 0.4}, {"id": 88, "dph_total": 0.5}]}
        assert (method, path) == ("PUT", "/v0/asks/77/")
        assert payload["image"] == gpu_rentals.COMFY_IMAGE
        assert payload["label"].startswith(gpu_rentals.STUDIO_LABEL_PREFIX)
        onstart = payload["onstart"]
        assert "Krea2_Turbo_convrot_int8mixed.safetensors" in onstart
        assert "ComfyUI-INT8-Fast" in onstart
        assert "--highvram" not in onstart
        assert "https://r2.example/" in onstart
        return {"new_contract": 4242, "success": True}

    calls = _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    response = client.post("/api/gpu-rentals", json={"tier": "image"})
    assert response.status_code == 201
    assert response.json()["rental_id"] == 4242
    assert [c[1] for c in calls] == ["/v0/bundles/", "/v0/asks/77/"]


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
    assert [r["rental_id"] for r in body["rentals"]] == [1001, 1002, 1003]
    assert body["requested"] == 3
    # Single-machine callers keep the flat shape they have always had.
    assert body["rental_id"] == 1001
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
    monkeypatch.setattr(gpu_rentals, "account_state", lambda: {
        "credit": 1.20, "usd_per_hour_running": 0.40, "hours_remaining": 3.0, "machines_running": 1})
    calls = _fake_vast(monkeypatch, lambda m, p, b: {"offers": [
        {"id": 1, "dph_total": 1.47, "gpu_name": "RTX PRO 6000 WS"}]})
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/gpu-rentals", json={"tier": "image", "gpu_class": "rtxpro6000", "count": 2})

    assert response.status_code == 402
    detail = response.json()["detail"]
    assert "$1.20 credit" in detail and "2 more machines" in detail
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


def test_video_tier_provisions_ltx_set(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}?sig=x")
    script = gpu_rentals._onstart_script("video")
    assert "ltx-2.3-22b-dev-fp8.safetensors" in script
    assert "ltx2310eros_v14_dmd_lora.safetensors" in script
    assert "gemma_3_12B_it_fp8_scaled.safetensors" in script


def test_minimax_tier_provisions_h3_stack(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}?sig=x")
    script = gpu_rentals._onstart_script("minimax")
    # The full manifest minimax-h3-video serving set (DiT + TE + both VAEs).
    assert "minimax_h3_fl2va_pruned_int8_convrot.safetensors" in script
    assert "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" in script
    assert "minimax_h3_video_vae_fp16.safetensors" in script
    assert "minimax_h3_audio_vae_fp32.safetensors" in script
    # The turbo LoRA and its loader come from upstream, not R2: the loader is
    # REQUIRED to apply the LoRA to our pruned base, and both are pinned.
    assert "minimax_h3_turbo_v4_step600_ema.safetensors" in script
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
    # Resume, so aborting a slow transfer costs the retry and not the bytes.
    assert "curl -sf -C -" in script or "curl -sfL -C -" in script
    assert "--retry 8" in script

    # A job that is still RUNNING never trips the "all jobs exited" escape, so
    # the watcher needs its own deadline or a hung connection bills forever.
    assert f"DL_DEADLINE=$(( $(date +%s) + {gpu_rentals.DOWNLOAD_DEADLINE_SECONDS} ))" in script
    assert 'if [ "$(date +%s)" -ge "$DL_DEADLINE" ]; then dlfail' in script
    assert 'if [ -z "$(jobs -r)" ]; then dlfail' in script
    # Both exits say what to do: the presigned URLs expire, so there is no
    # repair path for a half-provisioned box.
    assert "destroy this machine and rent another" in script


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
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get",
                        lambda key: "https://r2.example/" + "u" * 4000)
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
    assert client.delete("/api/gpu-rentals/5").json() == {
        "rental_id": 5, "destroyed": True, "restarting_stack": False,
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


def test_missing_vast_key_maps_to_503(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    # build_control_app re-applies the shared hive env, so clear the key AFTER
    # the app is built to simulate an unconfigured machine.
    monkeypatch.delenv("VAST_API_KEY", raising=False)
    response = client.get("/api/gpu-rentals")
    assert response.status_code == 503
    assert "VAST_API_KEY" in response.json()["detail"]


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
    assert rental["provision"] == {"step": "downloading", "done": 3, "total": 6,
                                   "detail": "gemma_3_12B_it_fp8_scaled.safetensors"}


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
    assert spawned == {"rid": 7, "ip": "9.9.9.9", "port": "41000", "lport": gpu_rentals.TUNNEL_BASE_PORT + 7}
    assert restarts == []
    env = (tmp_path / "media-state/rental-lanes.env").read_text()
    assert 'RENTAL_COMFY_LANES="rental7=http://127.0.0.1:18307"' in env
    assert 'RENTAL_COMFY_LANE_RULES="rental7=krea2_turbo_convrot,waianima"' in env
    assert 'RENTAL_COMFY_REMOTE_LANES="rental7"' in env
    # list now reports attached + tunnel_alive + studio pages
    rentals = client.get("/api/gpu-rentals").json()["rentals"]
    assert rentals[0]["attached"] is True and rentals[0]["tunnel_alive"] is True
    assert rentals[0]["studio_pages"] == ["image"]


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
    assert list(json.loads(registry.read_text())) == ["7", "8"]

    assert client.post("/api/gpu-rentals/8/select").json()["attached"] is True

    assert list(json.loads(registry.read_text())) == ["8", "7"], "the selected machine leads"
    env = (tmp_path / "media-state/rental-lanes.env").read_text()
    assert 'RENTAL_COMFY_LANE_RULES="rental8=minimax_h3;rental7=minimax_h3"' in env
    rentals = {r["rental_id"]: r for r in client.get("/api/gpu-rentals").json()["rentals"]}
    assert rentals[8]["priority"] > rentals[7]["priority"]


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
    assert list(json.loads(registry.read_text())) == ["8", "7"]


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
        log = gpu_rentals._tunnel_dir() / "7.log"
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
    assert body["attached"] is False and killed == [7]
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
    assert body["rental_id"] == 99 and body["offer_id"] == 3


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
    assert body["rental_id"] == 7001
    assert body["offer_id"] == 41, "should rent the fresh cheapest, not the stale pin"
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
    assert body["offer_id"] == 51
    assert attempts == ["/v0/asks/50/", "/v0/asks/51/"], "the dead pin must not be tried twice"


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
    assert body["offers"][0]["offer_id"] == 1
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
    # through _vast_session so the TLS connection is reused (a bare
    # requests.request per call was most of the Machines view's load time).
    # Patching the module function here silently let this test hit the real API.
    monkeypatch.setattr(gpu_rentals, "_vast_session", SimpleNamespace(request=fake_request))
    monkeypatch.setenv("VAST_API_KEY", "test-key")
    client = _client(tmp_path, monkeypatch)
    assert client.get("/api/gpu-rentals").status_code == 200
    assert urls.count(f"{gpu_rentals.VAST_API_BASE}/v1/instances/") == 2, (
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


def _failed_dto(rental_id: int = 31, uptime: float = 0.5) -> dict:
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
    assert destroyed == [31]
    assert len(recorded) == 1
    entry = recorded[0]
    # The beacon's reason has to outlive the machine: once it is destroyed
    # there is nothing left to ask why.
    assert entry["reason"] == "download stalled at 10/11: qwen3VL.safetensors"
    assert entry["progress"] == "10/11"
    # And what it cost, since the credit is simply gone.
    assert entry["usd_spent"] == pytest.approx(0.46)
    assert gpu_rentals.recent_rental_failures()[0]["rental_id"] == 31


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
    assert "31" in gpu_rentals._read_failure_state()["seen"]


def test_pause_detaches_then_stops_keeping_the_disk(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    monkeypatch.setattr(gpu_rentals, "_kill_tunnel", lambda rid: None)
    monkeypatch.setattr(gpu_rentals, "_schedule_stack_restart", lambda: None)
    monkeypatch.setattr(gpu_rentals, "_read_attachments", lambda: {"21": {"lane": "rental21"}})
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
    assert body == {"rental_id": 21, "paused": True, "was_attached": True}
    # Resume must know to restore routing.
    assert gpu_rentals._read_paused_state()["21"]["was_attached"] is True


def test_resume_starts_and_flags_reattach(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "state")
    gpu_rentals._write_paused_state({"21": {"was_attached": True}})

    def handler(method, path, payload):
        if method == "GET":
            return {"instances": [_paused_instance()]}
        assert payload == {"state": "running"}
        return {"success": True}

    _fake_vast(monkeypatch, handler)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/gpu-rentals/21/resume").json()
    assert body["resuming"] is True and body["will_reattach"] is True
    assert gpu_rentals._read_paused_state()["21"]["pending_reattach"] is True


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
    assert offers[0]["offer_id"] == 2
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
    assert body["rental_id"] == 8001
    assert floors == [500]


def test_minimax_tier_ships_the_turbo_lora(tmp_path: Path, monkeypatch) -> None:
    """A faster LINK only shortens provisioning. The generation-speed lever is
    the turbo workflow — which needs BOTH the LoRA and upstream's loader on the
    box, since ComfyUI's plain loader cannot apply it to our pruned base."""
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}")
    script = gpu_rentals._onstart_script("minimax")
    assert "minimax_h3_turbo_v4_step600_ema.safetensors" in script
    assert '"$M/loras/minimax_h3_turbo_v4_step600_ema.safetensors"' in script
    assert "ComfyUI-MiniMax-H3-Turbo" in script
    # Public HF weights need a redirect-following curl; the R2 presigned URLs do not.
    assert "curl -sfL" in script
    # The tier's bandwidth floor must account for the public bytes too.
    assert gpu_rentals.tier_download_gb("minimax") == pytest.approx(43.3, abs=0.2)
