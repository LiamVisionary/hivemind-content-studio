"""The provider seam: RunPod's adapter, and what having two marketplaces means.

Vast's own behaviour is covered in depth by test_gpu_rentals_api.py, which
drives it through the studio's routes. This file is about the things that only
exist because there is more than one provider.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from hivemind_content_studio import gpu_rentals
from hivemind_content_studio.rental_providers import (
    Instance,
    LaunchSpec,
    Offer,
    OfferQuery,
    ProviderError,
    RentalRef,
)
from hivemind_content_studio.rental_providers import runpod as runpod_provider
from hivemind_content_studio.rental_providers import vast as vast_provider


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path, monkeypatch):
    gpu_rentals._offer_cache.clear()
    gpu_rentals._balance_cache.clear()
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "media-state")
    yield
    gpu_rentals._offer_cache.clear()
    gpu_rentals._balance_cache.clear()


# --- rental refs -----------------------------------------------------------


def test_a_bare_id_still_means_vast() -> None:
    """Every attachment, pidfile and paused-state entry on this machine was
    written with a bare Vast integer before providers existed. A machine that
    is attached and rendering must not become unreachable because the id format
    changed underneath it."""
    assert RentalRef.parse(47390808) == RentalRef("vast", "47390808")
    assert RentalRef.parse("47390808") == RentalRef("vast", "47390808")
    assert str(RentalRef.parse(47390808)) == "vast:47390808"


def test_a_scoped_id_round_trips() -> None:
    ref = RentalRef.parse("runpod:x1y2z3")
    assert (ref.provider, ref.native) == ("runpod", "x1y2z3")
    assert RentalRef.parse(str(ref)) == ref


@pytest.mark.parametrize("value", ["", "   ", ":", "vast:", ":123"])
def test_a_malformed_id_is_a_400_not_a_crash(value: str) -> None:
    with pytest.raises(ProviderError) as exc:
        RentalRef.parse(value)
    assert exc.value.status_code == 400


def test_the_tunnel_slug_keeps_colons_out_of_filenames() -> None:
    """Pidfiles are read by hand when a tunnel misbehaves, and a colon is the
    path separator in plenty of tooling. Bare Vast ids slug to themselves so
    pidfiles written before refs existed still resolve."""
    assert gpu_rentals._tunnel_slug(RentalRef("vast", "7")) == "vast-7"
    assert gpu_rentals._tunnel_slug(RentalRef("runpod", "abc")) == "runpod-abc"


def test_vast_lanes_and_ports_do_not_move_when_a_second_provider_arrives() -> None:
    """The lane name is written into the gateway's routing rules and the port
    is the far end of a live SSH forward. Renaming either would re-route or
    strand a machine mid-session, so Vast keeps exactly what it had."""
    vast = RentalRef("vast", "7")
    assert gpu_rentals._lane_name(vast) == "rental7"
    assert gpu_rentals._lane_port(vast) == gpu_rentals.TUNNEL_BASE_PORT + 7
    # RunPod carries its key, which is also what keeps two marketplaces'
    # identical ids apart.
    pod = RentalRef("runpod", "x1y2z3")
    assert gpu_rentals._lane_name(pod) == "rentalrunpod-x1y2z3"
    # Non-numeric ids hash deterministically — hash() is salted per process and
    # would move the port on every restart.
    assert gpu_rentals._lane_port(pod) == gpu_rentals._lane_port(pod)
    assert gpu_rentals.TUNNEL_BASE_PORT <= gpu_rentals._lane_port(pod) < gpu_rentals.TUNNEL_BASE_PORT + 500


# --- RunPod catalog --------------------------------------------------------


CATALOG = {
    "gpuTypes": [
        {"id": "NVIDIA GeForce RTX 5090", "memoryInGb": 32,
         "communityCloud": True, "secureCloud": True,
         "communityPrice": 0.69, "securePrice": 0.99,
         "lowestPrice": {"stockStatus": "High", "minMemory": 41}},
        {"id": "NVIDIA GeForce RTX 4090", "memoryInGb": 24,
         "communityCloud": True, "secureCloud": True,
         "communityPrice": 0.34, "securePrice": 0.44,
         "lowestPrice": {"stockStatus": "Medium", "minMemory": 30}},
        # The trap: a distinct GPU type whose 300W part benchmarks at half a
        # full PRO 6000 and generates slower than a 5090 for twice the price.
        {"id": "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition", "memoryInGb": 96,
         "communityCloud": True, "secureCloud": False,
         "communityPrice": 0.99, "securePrice": None,
         "lowestPrice": {"stockStatus": "High", "minMemory": 100}},
        # A MIG slice — 24GB of a card we listed for its 96.
        {"id": "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb", "memoryInGb": 24,
         "communityCloud": True, "secureCloud": False,
         "communityPrice": 0.50, "securePrice": None,
         "lowestPrice": {"stockStatus": "High", "minMemory": 30}},
        # Stocked nowhere right now.
        {"id": "NVIDIA RTX PRO 6000 Blackwell Server Edition", "memoryInGb": 96,
         "communityCloud": True, "secureCloud": True,
         "communityPrice": 1.69, "securePrice": 1.69,
         "lowestPrice": {"stockStatus": None, "minMemory": 125}},
    ]
}


def _fake_graphql(monkeypatch, data=None):
    monkeypatch.setattr(runpod_provider, "graphql", lambda query: data if data is not None else CATALOG)
    monkeypatch.setenv("RUNPOD_API_KEY", "test-runpod-key")


def test_runpod_never_offers_a_maxq_or_a_mig_slice(monkeypatch) -> None:
    """On Vast the half-power PRO 6000 hides behind the same gpu_name as the
    full one and has to be caught by a benchmark heuristic. On RunPod it is a
    separate GPU type id, so simply never naming it is the whole filter — and
    the same goes for the MIG slices, which sell a quarter of the card under a
    name that contains the card's."""
    _fake_graphql(monkeypatch)
    offers = runpod_provider.PROVIDER.search_offers(OfferQuery(
        gpu_names=["RTX 5090", "RTX PRO 6000 WS", "RTX PRO 6000 S"], min_disk_gb=120))
    ids = [o.offer_id for o in offers]
    assert not any("Max-Q" in i or "MIG" in i for i in ids), ids


def test_runpod_drops_types_with_no_stock(monkeypatch) -> None:
    """No stock status means nothing is schedulable. Returning it at price
    None would put an unrentable rung at the head of a cheapest-first ladder."""
    _fake_graphql(monkeypatch)
    offers = runpod_provider.PROVIDER.search_offers(OfferQuery(
        gpu_names=["RTX 5090", "RTX PRO 6000 S"], min_disk_gb=120))
    assert [o.offer_id for o in offers] == ["NVIDIA GeForce RTX 5090"]


def test_runpod_prices_the_cloud_tier_it_actually_rents_on(monkeypatch) -> None:
    """Community is about a third cheaper than Secure (measured 2026-08-14: a
    5090 is $0.69 against $0.99) and is what a destroy-when-done rental wants."""
    _fake_graphql(monkeypatch)
    query = OfferQuery(gpu_names=["RTX 5090"], min_disk_gb=120)
    monkeypatch.setattr(runpod_provider, "CLOUD_TYPE", "COMMUNITY")
    assert runpod_provider.PROVIDER.search_offers(query)[0].usd_per_hour == 0.69
    monkeypatch.setattr(runpod_provider, "CLOUD_TYPE", "SECURE")
    assert runpod_provider.PROVIDER.search_offers(query)[0].usd_per_hour == 0.99


def test_runpod_reports_container_ram_so_the_shared_floor_applies(monkeypatch) -> None:
    """The RAM guard exists because a container too small to stage the weights
    has its ComfyUI killed mid-job. It has to work the same whichever
    marketplace the offer came from."""
    _fake_graphql(monkeypatch)
    offers = runpod_provider.PROVIDER.search_offers(OfferQuery(
        gpu_names=["RTX 5090", "RTX 4090"], min_disk_gb=80))
    by_name = {o.gpu_name: o for o in offers}
    assert by_name["RTX 5090"].ram_gb == 41.0
    assert by_name["RTX 4090"].ram_gb == 30.0
    # 30GB clears the image tier's 24GB floor but not H3's 32GB one.
    assert gpu_rentals._starved_of_ram("image", by_name["RTX 4090"]) is False
    assert gpu_rentals._starved_of_ram("minimax", by_name["RTX 4090"]) is True


def test_runpod_offers_carry_no_invented_evidence(monkeypatch) -> None:
    """RunPod publishes no per-host benchmark, link speed or location. Those
    must stay None rather than becoming zeros — the shared filters read a
    missing number as "no evidence" and a zero as a bad host."""
    _fake_graphql(monkeypatch)
    offer = runpod_provider.PROVIDER.search_offers(
        OfferQuery(gpu_names=["RTX 5090"], min_disk_gb=120))[0]
    assert (offer.dlperf, offer.down_mbps, offer.geolocation, offer.machine_id) == (None,) * 4
    # And so the half-power heuristic cannot fire on an unbenchmarked offer.
    assert gpu_rentals._underpowered(offer) is False


@pytest.mark.marketplace_transport
def test_a_graphql_error_is_not_a_silent_empty_rung(monkeypatch) -> None:
    """GraphQL answers 200 with an `errors` array. Reading the status alone
    turns a broken query into a rung that looks sold out."""
    monkeypatch.setenv("RUNPOD_API_KEY", "test-runpod-key")

    class _Response:
        status_code = 200

        @staticmethod
        def json():
            return {"errors": [{"message": "Something went wrong"}]}

    monkeypatch.setattr(runpod_provider._session, "post", lambda *a, **k: _Response())
    with pytest.raises(ProviderError):
        runpod_provider.graphql("{ myself { clientBalance } }")


# --- RunPod provisioning ---------------------------------------------------


def test_the_pod_bootstrap_starts_sshd_before_the_shared_script(monkeypatch) -> None:
    """Vast's image entrypoint sets up sshd for us; RunPod's start command
    replaces the entrypoint entirely. The tunnel is the only way anything
    reaches ComfyUI, so a box we cannot SSH into bills by the hour for nothing.
    """
    command = runpod_provider.bootstrap_command("echo PROVISION_BODY")
    assert command[:2] == ["bash", "-lc"]
    script = command[2]
    assert script.index("sshd") < script.index("PROVISION_BODY"), \
        "the shared script authorizes our key, so sshd has to exist first"
    assert "openssh-server" in script
    # A public IP with password auth left at the image's default is not a risk
    # worth inheriting.
    assert "PasswordAuthentication no" in script


def test_the_pod_bootstrap_puts_the_venv_on_path(monkeypatch) -> None:
    """The shared script installs with an absolute /venv/main/bin/pip but
    launches ComfyUI as a bare `python main.py`, which only resolves because
    Vast's entrypoint activates the venv — and that entrypoint is exactly what
    RunPod replaces.

    Without this the pod provisions perfectly and then serves nothing, which is
    the worst shape a failure can take here: the box is up, SSH answers, the
    tunnel opens onto silence, and the meter runs.
    """
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")
    onstart = gpu_rentals._onstart_script("minimax")
    assert "setsid nohup python main.py" in onstart, \
        "if the launch line stops being a bare `python`, this guard can go"

    script = runpod_provider.bootstrap_command(onstart)[2]
    assert 'export PATH="/venv/main/bin:$PATH"' in script
    assert script.index("/venv/main/bin:$PATH") < script.index("python main.py")


def test_the_pod_bootstrap_holds_the_container_open() -> None:
    """On Vast the image's entrypoint outlives onstart and holds the container.
    Here the script IS the entrypoint, so returning kills PID 1 — and the pod
    would stop seconds after a SUCCESSFUL provision, taking ComfyUI, the beacon
    and 40GB of freshly downloaded weights with it, all of it billed.

    It has to hold on failure too: the provisioning script exits non-zero after
    writing its beacon, and the operator needs the box alive to SSH in and read
    the log. Deciding when a failed box dies is the reaper's job.
    """
    # A provisioning script that FAILS — the shared one has `exit 1` paths in
    # the middle of it, and a live pod crash-looped on exactly this.
    script = runpod_provider.bootstrap_command("echo done\nexit 1")[2]
    assert script.rstrip().endswith("exec sleep infinity"), \
        "PID 1 has to outlive the provisioning, not be it"
    assert "|| true" in script, \
        "a non-zero provision must not propagate to PID 1 and kill the container"
    assert "exec bash /root/provision.sh" not in script, \
        "exec makes the script PID 1, so its own `exit 1` takes the pod down"


def test_the_shared_script_survives_the_heredoc_verbatim() -> None:
    """The provisioning script carries base64 blobs, presigned URLs and nested
    shell functions. A single unbalanced quote reaching the command line would
    strand a billing box, so it goes through a QUOTED heredoc — no expansion,
    no escaping."""
    nasty = "printf '%s' 'a\"b'\\''c' && echo $HOME `date` ${X}"
    script = runpod_provider.bootstrap_command(nasty)[2]
    assert nasty in script
    assert "<<'HIVEMIND_PROVISION_EOF'" in script, "quoted, or $HOME expands at write time"


def test_creating_a_pod_asks_for_the_floors_instead_of_filtering_for_them(monkeypatch) -> None:
    """RunPod schedules against minRAMPerGPU and minDownloadMbps, which is
    strictly better than Vast's model where the same floors can only be applied
    by discarding listings after the fact."""
    monkeypatch.setenv("RUNPOD_API_KEY", "test-runpod-key")
    sent = {}

    def fake_request(method, path, payload=None):
        sent.update({"method": method, "path": path, "payload": payload})
        return {"id": "x1y2z3"}

    monkeypatch.setattr(runpod_provider, "request", fake_request)
    pod_id = runpod_provider.PROVIDER.create(LaunchSpec(
        image="vastai/comfy:v0.32.0-cuda-12.9-py312",
        disk_gb=120, label="hivemind-studio-gpur-minimax-rtx5090-abc",
        onstart="echo hi", expose_ports=[18189],
        min_ram_gb=32, min_down_mbps=1924,
        offer_id="NVIDIA GeForce RTX 5090",
    ))
    assert pod_id == "x1y2z3"
    payload = sent["payload"]
    assert payload["minRAMPerGPU"] == 32
    assert payload["minDownloadMbps"] == 1924
    assert payload["gpuTypeIds"] == ["NVIDIA GeForce RTX 5090"]
    assert payload["containerDiskInGb"] == 120
    # And no network volume. RunPod defaults volumeInGb to 20 and mounts it at
    # /workspace, which is where the weights go — so leaving it unset sizes a
    # disk the models never touch and strands them on 20GB. A live pod died
    # exactly this way with df showing 80G free.
    assert payload["volumeInGb"] == 0
    # Port 22 for the tunnel plus the beacon — and nothing else. ComfyUI stays
    # on loopback; publishing it would turn a private lane into a public one.
    assert set(payload["ports"]) == {"22/tcp", "18189/tcp"}
    assert payload["supportPublicIp"] is True


def test_a_pod_with_no_public_ip_yet_has_no_ssh_endpoint(monkeypatch) -> None:
    """Half a mapping is not an endpoint. Returning one would have the studio
    spawn a tunnel to nowhere and call the machine attached."""
    booting = runpod_provider.PROVIDER._instance({
        "id": "x1", "name": "hivemind-studio-gpur-image-rtx5090-aa",
        "desiredStatus": "RUNNING", "runtime": None,
    })
    assert booting.state == "booting" and booting.ssh is None
    running = runpod_provider.PROVIDER._instance({
        "id": "x1", "name": "hivemind-studio-gpur-image-rtx5090-aa",
        "desiredStatus": "RUNNING", "costPerHr": 0.69, "machineId": "yizo48lib8oi",
        "machine": {"gpuTypeId": "NVIDIA GeForce RTX 5090"},
        "runtime": {"ports": [
            {"privatePort": 22, "publicPort": 41000, "ip": "1.2.3.4", "isIpPublic": True},
            {"privatePort": 18189, "publicPort": 41001, "ip": "1.2.3.4", "isIpPublic": True},
            # A live pod reports its carrier-NAT address alongside the routable
            # one. Taking whichever came last made the endpoint flip between
            # them poll to poll, and a tunnel aimed at 100.64/10 just hangs.
            {"privatePort": 19123, "publicPort": 60055, "ip": "100.65.31.209",
             "isIpPublic": False},
        ]},
    })
    assert running.state == "running"
    assert running.ssh == ("1.2.3.4", "41000")
    assert running.ports[18189] == "41001"
    assert running.public_ip == "1.2.3.4", "the carrier-NAT address is not an endpoint"
    # Mapped back to the name the benchmark ladder speaks.
    assert running.gpu_name == "RTX 5090"
    # RunPod does name the physical host, so the bad-machine cooldown works.
    assert running.machine_id == "yizo48lib8oi"


def test_a_pod_is_only_running_once_its_ports_are_published(monkeypatch) -> None:
    """desiredStatus goes RUNNING while the image is still being pulled, and
    the port map is what says the container actually exists. Trusting the
    status alone reports a machine as up with no endpoint to reach it on."""
    inst = runpod_provider.PROVIDER._instance(
        {"id": "x1", "name": "n", "desiredStatus": "RUNNING", "publicIp": "1.2.3.4"},
        {"runtime": {"uptimeInSeconds": -6, "ports": None}},
    )
    assert inst.state == "booting" and inst.ssh is None


# --- two marketplaces at once ----------------------------------------------


def _only(provider_key: str, offers: list[Offer], monkeypatch):
    """Make exactly one provider answer, with these offers."""
    monkeypatch.setenv("VAST_API_KEY", "k")
    monkeypatch.setenv("RUNPOD_API_KEY", "k")
    monkeypatch.setattr(vast_provider.VastProvider, "search_offers",
                        lambda self, q: offers if provider_key == "vast" else [])
    monkeypatch.setattr(runpod_provider.RunPodProvider, "search_offers",
                        lambda self, q: offers if provider_key == "runpod" else [])


def test_runpod_fills_a_rung_vast_has_nothing_for(monkeypatch) -> None:
    """The whole reason the second provider exists.

    On 2026-08-14 the H3 tier had zero rentable 5090s and the rung rendered
    "No RTX 5090 offers match right now". A second marketplace turns that into
    a priced rung instead of a dead end.
    """
    _only("runpod", [Offer(provider="runpod", offer_id="NVIDIA GeForce RTX 5090",
                           gpu_name="RTX 5090", usd_per_hour=0.69, ram_gb=41.0,
                           vram_mb=32768, datacenter=True)], monkeypatch)
    plan = gpu_rentals.rental_plan("minimax")
    rung = next(r for r in plan["classes"] if r["gpu_class"] == "rtx5090")
    assert rung["available"] == 1
    assert rung["usd_per_hour"] == 0.69
    assert rung["offers"][0]["provider"] == "runpod"
    # And it is still priced per generation off the measured 5090 benchmark —
    # the ladder does not care which marketplace supplied the card.
    assert rung["estimate_basis"] == "measured"
    assert rung["usd_per_generation"] == round(40.0 * 0.69 / 3600, 4)


def test_one_marketplace_failing_does_not_hide_the_others_offers(monkeypatch) -> None:
    """A rate limit or an expired key on one provider must not blank a view the
    other could have filled."""
    monkeypatch.setenv("VAST_API_KEY", "k")
    monkeypatch.setenv("RUNPOD_API_KEY", "k")

    def boom(self, query):
        raise ProviderError("RunPod GraphQL failed: 401")

    monkeypatch.setattr(runpod_provider.RunPodProvider, "search_offers", boom)
    monkeypatch.setattr(vast_provider.VastProvider, "search_offers", lambda self, q: [
        Offer(provider="vast", offer_id="1", gpu_name="RTX 5090", usd_per_hour=0.47,
              ram_gb=62.0, down_mbps=9000, dlperf=199.2)])
    offers = gpu_rentals.list_offers("minimax")["offers"]
    assert [o["provider"] for o in offers] == ["vast"]


def test_the_cheaper_marketplace_wins_the_rung(monkeypatch) -> None:
    """Ranking is cheapest-first across the pooled market, so which provider
    leads is decided by price on the day and by nothing else."""
    monkeypatch.setenv("VAST_API_KEY", "k")
    monkeypatch.setenv("RUNPOD_API_KEY", "k")
    monkeypatch.setattr(vast_provider.VastProvider, "search_offers", lambda self, q: [
        Offer(provider="vast", offer_id="1", gpu_name="RTX 5090", usd_per_hour=0.47,
              ram_gb=62.0, down_mbps=9000)])
    monkeypatch.setattr(runpod_provider.RunPodProvider, "search_offers", lambda self, q: [
        Offer(provider="runpod", offer_id="NVIDIA GeForce RTX 5090", gpu_name="RTX 5090",
              usd_per_hour=0.69, ram_gb=41.0)])
    offers = gpu_rentals.list_offers("minimax")["offers"]
    assert [(o["provider"], o["usd_per_hour"]) for o in offers] == [("vast", 0.47), ("runpod", 0.69)]


def test_credit_is_checked_against_the_account_that_would_pay(monkeypatch) -> None:
    """Vast credit cannot fund a RunPod pod. Checking a rental against the
    aggregate would wave through exactly the rental this guard exists to stop —
    the box provisions (billed) and dies partway through the session.
    """
    monkeypatch.setattr(gpu_rentals, "account_state", lambda *_a, **_k: {
        "credit": 500.0, "usd_per_hour_running": 0.0, "hours_remaining": None,
        "machines_running": 0,
        "providers": [
            {"provider": "vast", "label": "Vast.ai", "credit_url": "vast.ai",
             "credit": 500.0, "usd_per_hour_running": 0.0, "machines_running": 0},
            {"provider": "runpod", "label": "RunPod", "credit_url": "runpod.io/console/billing",
             "credit": 0.10, "usd_per_hour_running": 0.0, "machines_running": 0},
        ],
    })
    # Vast has the money.
    gpu_rentals._assert_affordable("vast", 1, 0.47)
    # RunPod does not, and says so in its own terms.
    with pytest.raises(gpu_rentals.GpuRentalError) as exc:
        gpu_rentals._assert_affordable("runpod", 1, 0.69)
    assert exc.value.status_code == 402
    assert "RunPod credit" in str(exc.value)
    assert "runpod.io/console/billing" in str(exc.value)


def test_a_machine_is_only_ever_asked_about_on_its_own_marketplace(monkeypatch) -> None:
    """Two marketplaces hand out independent id spaces and nothing stops them
    colliding on a string. Asking the wrong one is a 404 at best and the wrong
    box at worst."""
    monkeypatch.setenv("VAST_API_KEY", "k")
    monkeypatch.setenv("RUNPOD_API_KEY", "k")
    asked: list[str] = []

    def vast_list(self):
        asked.append("vast")
        return [Instance(provider="vast", native_id="7", label="x", state="running")]

    def runpod_list(self):
        asked.append("runpod")
        return [Instance(provider="runpod", native_id="7", label="y", state="running")]

    monkeypatch.setattr(vast_provider.VastProvider, "list_instances", vast_list)
    monkeypatch.setattr(runpod_provider.RunPodProvider, "list_instances", runpod_list)
    found = gpu_rentals._find_instance(RentalRef("runpod", "7"))
    assert asked == ["runpod"], "the other marketplace must not even be consulted"
    assert found.label == "y"


# --- user LoRAs are provider-agnostic -------------------------------------


def _register_lora(monkeypatch, tmp_path: Path, *, size_gb: float = 3.0,
                   lora_id: str = "krea2/my-style.safetensors") -> None:
    """One registered rental LoRA, written straight to the registry.

    Goes through the real file the provisioning path reads rather than a stub,
    so this exercises the same single source the studio's "Use in rentals"
    button feeds.
    """
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "media-state")
    (tmp_path / "media-state").mkdir(parents=True, exist_ok=True)
    gpu_rentals._write_rental_loras({lora_id: _lora_entry(lora_id, "Krea 2", size_gb)})


def _lora_entry(lora_id: str, base_model: str, size_gb: float) -> dict:
    """A registry entry in the shape add_rental_lora writes.

    `tiers` is resolved from the base model at REGISTRATION time and stored, so
    a hand-built entry has to carry it or the provisioning filter skips the
    LoRA silently — and `status` must be "ready" for the same reason.
    """
    return {
        "id": lora_id, "base_model": base_model, "size_gb": size_gb,
        "tiers": gpu_rentals.tiers_for_lora_base([base_model]),
        "r2_key": f"{gpu_rentals.RENTAL_LORA_R2_PREFIX}{lora_id}",
        "rating": "sfw", "status": "ready", "added_at": "2026-08-15",
    }


def test_a_registered_lora_reaches_both_providers_from_one_source(monkeypatch, tmp_path: Path) -> None:
    """The whole point of building the onstart in gpu_rentals: there is exactly
    one LoRA pipeline, and swapping the marketplace cannot change it.

    A LoRA registered once must appear in the provisioning script that BOTH
    providers are handed, byte for byte — the script is built before any
    provider is chosen.
    """
    _register_lora(monkeypatch, tmp_path)
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: f"https://r2.example/{key}")
    script = gpu_rentals._onstart_script("image")
    assert "user-loras/krea2/my-style.safetensors" in script
    # And it lands where the studios' graphs name it: installed-LoRA ids keep
    # their subdirectory, so lora_name resolves identically on the rented box.
    assert "loras/krea2" in script

    captured = {}
    monkeypatch.setattr(runpod_provider.RunPodProvider, "create",
                        lambda self, spec: captured.update(spec=spec) or "podid")
    monkeypatch.setattr(gpu_rentals, "_assert_affordable", lambda *a, **k: None)
    monkeypatch.setattr(gpu_rentals, "rental_public_key", lambda: "ssh-ed25519 AAAA")
    monkeypatch.setattr(gpu_rentals, "_rank_offers", lambda tier, offers, limit=8: [
        {"provider": "runpod", "offer_id": "NVIDIA GeForce RTX 5090",
         "usd_per_hour": 0.69, "setup_minutes": 2.0}])
    monkeypatch.setattr(gpu_rentals, "_search_offers", lambda *a, **k: ([], 500))
    gpu_rentals.create_rental("image")
    assert "user-loras/krea2/my-style.safetensors" in captured["spec"].onstart, \
        "RunPod is handed the same script, LoRAs included"


def test_a_registered_lora_grows_the_disk_it_downloads_onto(monkeypatch, tmp_path: Path) -> None:
    """LoRAs already grew the download volume and the bandwidth floor. The disk
    has to grow with them or the box runs out of room mid-fetch — which does not
    fail gracefully, it stops the download part-way having billed for the whole
    attempt.
    """
    base_disk = gpu_rentals.TIERS["image"]["disk_gb"]
    _register_lora(monkeypatch, tmp_path, size_gb=12.0)
    assert gpu_rentals.tier_disk_gb("image") == base_disk + 12
    # The download volume and the link floor move with it, as they always did.
    assert gpu_rentals.tier_download_gb("image") > 12
    # Fractional sizes round UP: a disk sized a byte short is a failed rental.
    gpu_rentals._write_rental_loras({"a": _lora_entry("a", "Krea 2", 0.4)})
    assert gpu_rentals.tier_disk_gb("image") == base_disk + 1


def test_lora_disk_sizing_reaches_the_offer_search_and_the_launch(monkeypatch, tmp_path: Path) -> None:
    """One number, both consumers: the disk we FILTER hosts on and the disk we
    ASK for have to agree, or we rent a box that cannot hold what we then try
    to put on it."""
    _register_lora(monkeypatch, tmp_path, size_gb=12.0)
    expected = gpu_rentals.tier_disk_gb("image")
    assert gpu_rentals._offer_query("image").min_disk_gb == expected

    captured = {}
    monkeypatch.setattr(runpod_provider.RunPodProvider, "create",
                        lambda self, spec: captured.update(spec=spec) or "podid")
    monkeypatch.setattr(gpu_rentals, "_presign_r2_get", lambda key: "https://r2.example/x")
    monkeypatch.setattr(gpu_rentals, "_assert_affordable", lambda *a, **k: None)
    monkeypatch.setattr(gpu_rentals, "rental_public_key", lambda: "ssh-ed25519 AAAA")
    monkeypatch.setattr(gpu_rentals, "_search_offers", lambda *a, **k: ([], 500))
    monkeypatch.setattr(gpu_rentals, "_rank_offers", lambda tier, offers, limit=8: [
        {"provider": "runpod", "offer_id": "NVIDIA GeForce RTX 5090",
         "usd_per_hour": 0.69, "setup_minutes": 2.0}])
    gpu_rentals.create_rental("image")
    assert captured["spec"].disk_gb == expected
    # And RunPod turns that into its container disk, with no volume to strand it.
    payload_disk = int(captured["spec"].disk_gb)
    assert payload_disk == expected


def test_a_lora_for_another_base_model_never_ships_to_the_wrong_tier(monkeypatch, tmp_path: Path) -> None:
    """Routing is by the LoRA's base-model family, and it is the same rule on
    every provider because it runs before one is chosen."""
    monkeypatch.setattr(gpu_rentals, "MEDIA_STATE_ROOT", tmp_path / "media-state")
    (tmp_path / "media-state").mkdir(parents=True, exist_ok=True)
    gpu_rentals._write_rental_loras({
        "krea2/a.safetensors": _lora_entry("krea2/a.safetensors", "Krea 2", 1.0),
        "h3/b.safetensors": _lora_entry("h3/b.safetensors", "MiniMax H3", 1.0),
    })
    image = {e["id"] for e in gpu_rentals.rental_loras_for_tier("image")}
    video = {e["id"] for e in gpu_rentals.rental_loras_for_tier("video")}
    minimax = {e["id"] for e in gpu_rentals.rental_loras_for_tier("minimax")}
    assert image == {"krea2/a.safetensors"}
    # The video tier serves Krea2 as well, so it carries that LoRA too.
    assert video == {"krea2/a.safetensors"}
    assert minimax == {"h3/b.safetensors"}
