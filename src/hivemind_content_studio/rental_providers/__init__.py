"""Where a rented GPU comes from.

Until 2026-08-14 there was exactly one answer — Vast — and gpu_rentals.py said
so in its imports, its field names and its error strings. This package is the
seam that lets a second marketplace exist without any of that leaking further.

The split runs along one line: a provider knows how to *buy and run a box*, and
knows nothing about what we run on it. It never sees TIERS, GPU_CLASSES, the
benchmark ladder or the onstart script — it is handed an OfferQuery (find me
machines shaped like this) or a LaunchSpec (start this image with this script
on it) and hands back normalized records. Everything that decides WHICH box is
worth renting stays in gpu_rentals.py, where the measurements live, and is
therefore shared by every provider rather than reimplemented per marketplace.

That direction matters: the filters in gpu_rentals are not preferences, they
are scar tissue (a box whose container RAM cannot hold the weights does not
render a worse clip — its ComfyUI is killed mid-job). A provider that did its
own ranking would quietly opt out of all of it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


class ProviderError(RuntimeError):
    """A marketplace API failed, or refused something we asked for.

    Carries an HTTP status so the control API can pass a 402 (out of credit) or
    a 409 (the ask evaporated) straight through instead of flattening every
    upstream problem into a 502.
    """

    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def response_error_text(body_text: str, status_code: int, limit: int = 200) -> str:
    """The readable part of a failed marketplace response.

    A Cloudflare or maintenance page comes back as HTML; pasting its first
    200 characters into the toast read ``<!DOCTYPE html><html lang="en">…``.
    Say what it is instead."""
    text = str(body_text or "").strip()
    if text.startswith("<"):
        return f"the marketplace returned an error page (HTTP {status_code})"
    return text[:limit] or f"HTTP {status_code}"


@dataclass(frozen=True)
class RentalRef:
    """A rental id that says which marketplace it belongs to.

    Vast ids are ints and RunPod ids are strings like `abc123def`, so the shared
    id had to become text. It is written `provider:native` — "vast:47390808",
    "runpod:x1y2z3" — and every route, registry key and pidfile name uses that
    form.

    A BARE id still parses, as Vast. That is not politeness to old callers: the
    attach registry, the paused-state file and the tunnel pidfiles on this
    machine are all keyed by bare Vast ints written before this package
    existed, and a machine that is attached and rendering must not become
    unreachable because we changed an id format underneath it.
    """

    provider: str
    native: str

    DEFAULT_PROVIDER = "vast"

    def __str__(self) -> str:
        return f"{self.provider}:{self.native}"

    @classmethod
    def parse(cls, value: Any) -> "RentalRef":
        text = str(value).strip()
        if not text:
            raise ProviderError("empty rental id", status_code=400)
        if ":" not in text:
            return cls(cls.DEFAULT_PROVIDER, text)
        provider, _, native = text.partition(":")
        provider, native = provider.strip().lower(), native.strip()
        if not provider or not native:
            raise ProviderError(f"malformed rental id: {text!r}", status_code=400)
        return cls(provider, native)


@dataclass
class OfferQuery:
    """What we are shopping for, in terms every marketplace understands.

    Deliberately not a tier. gpu_rentals resolves a tier into this — which
    cards, how much disk, how fast a link — so that a provider cannot acquire
    an opinion about MiniMax H3.

    `min_down_mbps` is a floor on the box's link because provisioning is BILLED:
    the tier's weights are tens of gigabytes and a slow host spends that
    download on the meter. Providers that do not publish link speed leave
    `down_mbps` unset on the offers they return and this is simply not applied.
    """

    gpu_names: list[str]
    min_disk_gb: float
    min_down_mbps: int | None = None
    # System RAM the container must have to stage this workload's weights.
    # Vast cannot express it in a query and the caller filters the results;
    # RunPod takes it as a scheduling constraint, which is strictly better —
    # it picks a machine that satisfies it instead of us discarding ones that
    # do not.
    min_ram_gb: float | None = None
    # Marketplaces sell fractions of a machine; a whole-machine cloud ignores it.
    single_gpu_only: bool = True
    limit: int = 400


@dataclass
class Offer:
    """One rentable machine, normalized.

    Every field except `provider`, `offer_id`, `gpu_name` and `usd_per_hour` is
    optional, because marketplaces publish different things — and an ABSENT
    field must never read as a bad value. gpu_rentals' filters are written to
    skip a missing number rather than infer a small one from it, which is why
    `ram_gb=None` and `ram_gb=0` have to stay distinguishable here.
    """

    provider: str
    offer_id: str
    gpu_name: str
    usd_per_hour: float
    vram_mb: int | None = None
    # The CONTAINER's share of system RAM, not the machine's headline figure.
    # Normalizing this in the provider is the whole reason it is a method and
    # not a passthrough: on Vast it is cpu_ram x gpu_frac, on a fixed-plan
    # cloud it is simply what the plan includes.
    ram_gb: float | None = None
    down_mbps: float | None = None
    # The provider's own deep-learning benchmark for THIS host, where it has
    # one. Used to spot half-power SKUs sold under a full-power name.
    dlperf: float | None = None
    reliability: float | None = None
    geolocation: str | None = None
    datacenter: bool | None = None
    # The physical host behind the offer. A rental dies; the machine that
    # wedged it is still on the market tomorrow, so the failure cooldown is
    # remembered against this and not against the rental id.
    machine_id: Any = None
    raw: dict = field(default_factory=dict)


@dataclass
class LaunchSpec:
    """Start this image, with this script on it, and let us SSH in.

    `onstart` is the provisioning script. Providers differ in how it is
    delivered — Vast takes it as a field on the ask, RunPod takes a start
    command that replaces the image's entrypoint — but its CONTENT is shared,
    so it is built once in gpu_rentals and never per provider.

    `expose_ports` is the beacon only. ComfyUI itself stays bound to loopback
    on every provider and is reached exclusively through the SSH tunnel; a
    provider that published it would silently turn a private lane into a public
    one.
    """

    image: str
    disk_gb: float
    label: str
    onstart: str
    # Carried through from the tier so providers that schedule against it can.
    min_ram_gb: float | None = None
    min_down_mbps: int | None = None
    expose_ports: list[int] = field(default_factory=list)
    # Set when the caller has a specific offer in hand; marketplaces need it,
    # fixed-inventory clouds pick their own machine from gpu_names.
    offer_id: str | None = None
    gpu_names: list[str] = field(default_factory=list)
    # A pre-stocked persistent volume to mount instead of pulling the weights:
    # the provider's own network-volume id, the data centers it can be reached
    # from (a volume pins the rental to its own region), and where to mount
    # it. Only RunPod has volumes that outlive a box and attach to a fresh one;
    # a marketplace (Vast) has no equivalent and ignores all three.
    network_volume_id: str | None = None
    data_center_ids: list[str] = field(default_factory=list)
    volume_mount_path: str = "/workspace"


@dataclass
class Instance:
    """A running (or booting, or stopped) rental, normalized.

    `state` is one of "booting" | "running" | "stopped" | "error", mapped by the
    provider from whatever its API calls those. gpu_rentals refines it further
    using the box's own provisioning beacon — the marketplace's idea of
    "running" means the host accepted the contract, which is long before
    anything of ours exists.
    """

    provider: str
    native_id: str
    label: str
    state: str
    usd_per_hour: float = 0.0
    # What a paused box still costs. Both marketplaces keep billing the disk.
    paused_usd_per_hour: float = 0.0
    gpu_name: str | None = None
    machine_id: Any = None
    disk_gb: float | None = None
    started_at: float | None = None
    public_ip: str | None = None
    # Every way into the container, best first: a direct port mapping ahead of
    # any proxy the provider fronts it with. A list rather than one endpoint
    # because a marketplace can hand out an address that is not SSH at all —
    # on 2026-08-24 Vast reported ssh_port 19896 for a live box and that port
    # was its Jupyter HTTPS proxy (TLS handshake, CN=jupyter.vast.ai), which
    # left the rental unreachable with nothing else to try. Attach walks these
    # in order, so a second candidate is the difference between a slow attach
    # and a box that has to be destroyed.
    ssh_endpoints: list[tuple[str, str]] = field(default_factory=list)
    # container port -> published host port, for the beacon.
    ports: dict[int, str] = field(default_factory=dict)
    raw: dict = field(default_factory=dict)

    @property
    def ssh(self) -> tuple[str, str] | None:
        """The endpoint to try first; None while the box has no door at all."""
        return self.ssh_endpoints[0] if self.ssh_endpoints else None

    @property
    def ref(self) -> RentalRef:
        return RentalRef(self.provider, self.native_id)


class Provider(Protocol):
    """One marketplace.

    Implementations live beside this file. They are stateless: every method
    reads its credentials from the environment at call time, so a key added
    after the process started works on the next request rather than after a
    restart.
    """

    key: str
    label: str
    # Where the user tops up, quoted verbatim in the out-of-credit message.
    credit_url: str
    # Every environment variable this provider accepts as its credential, in
    # the order it tries them. Declared rather than guessed from `key`, because
    # the guess is right for exactly one of the two: RunPod also answers to
    # RUNPOD_MANAGEMENT_API_KEY, which is the name the shared hive env actually
    # uses. A studio that cannot name the key it is missing cannot tell "never
    # set up" from "set up but sealed" — and those have opposite repairs.
    env_names: tuple[str, ...]

    def configured(self) -> bool:
        """True when this provider has credentials to work with.

        Checked before every call that would otherwise raise: with two
        providers installed, one missing key must degrade to "that marketplace
        is not set up" and leave the other one's machines listed, not take the
        whole Machines view down.
        """

    def search_offers(self, query: OfferQuery) -> list[Offer]: ...

    def create(self, spec: LaunchSpec) -> str:
        """Rent one machine; returns the native id."""

    def list_instances(self) -> list[Instance]: ...

    def destroy(self, native_id: str) -> None: ...

    def pause(self, native_id: str) -> None: ...

    def resume(self, native_id: str) -> None: ...

    def credit(self) -> float:
        """Spendable balance, in USD.

        Per provider, never summed: Vast credit cannot pay for a RunPod pod, so
        an aggregate figure would authorize rentals the account cannot fund.
        """


_REGISTRY: dict[str, Provider] = {}


def register(provider: Provider) -> Provider:
    _REGISTRY[provider.key] = provider
    return provider


def get(key: str) -> Provider:
    try:
        return _REGISTRY[key]
    except KeyError:
        raise ProviderError(f"unknown rental provider: {key}", status_code=400) from None


def all_providers() -> list[Provider]:
    return list(_REGISTRY.values())


def configured_providers() -> list[Provider]:
    """Every provider that could actually be used right now.

    The list the Machines view shops across. A provider with no key is not an
    error here — it is simply not stocked.
    """
    return [p for p in _REGISTRY.values() if p.configured()]
