"""RunPod, behind the same Provider interface as Vast.

Added 2026-08-14 because the H3 tier kept running out of market. RunPod is not
a marketplace of individual asks — it is a fixed-inventory cloud with one price
per GPU type per cloud tier — so several things Vast needs are simply different
here, and the differences are worth stating because they are not bugs:

  * There are no per-host offers to rank. `search_offers` synthesizes ONE offer
    per GPU type from the published price, so the shared ladder in gpu_rentals
    can price a rung without knowing which marketplace it came from. Anything
    the ladder ranks on and RunPod does not publish per host (a benchmark, a
    link speed, a location) is left None, which the shared filters treat as
    "no evidence" rather than as a bad value.
  * There is no ask to lose, so nothing here can evaporate mid-rent.
  * RAM, disk and link speed are CONSTRAINTS AT CREATE TIME rather than
    properties of a listing — minRAMPerGPU and minDownloadMbps make RunPod
    schedule a machine that satisfies them. That is strictly better than
    Vast's model, where the same floors can only be applied by discarding
    listings after the fact.

It also takes TWO APIs, which is not a design choice:

  * REST (rest.runpod.io/v1) owns pods — create, list, stop, start, delete.
  * GraphQL (api.runpod.io/graphql) owns GPU types, their prices and the
    account balance. Verified against the published OpenAPI document on
    2026-08-14: the REST v1 spec has no /gputypes and no user or balance route
    at all, so this is the only way to price a rung or check the credit.

The big one is provisioning. Vast's image ships an entrypoint
(/opt/instance-tools/bin/entrypoint.sh) that sets up sshd and then runs the
`onstart` field for us. RunPod has no such convention: it takes a start command
that REPLACES the entrypoint. So the shared onstart script — built once in
gpu_rentals and identical on both providers — is wrapped here in the small
amount of bootstrap Vast was doing invisibly: install and start sshd, then hand
over. The script's own first act is to authorize our key (see
_authorize_rental_key_lines), so sshd must exist before it runs, not after.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime
from typing import Any

import requests

from . import Instance, LaunchSpec, Offer, OfferQuery, Provider, ProviderError, register

REST_BASE = "https://rest.runpod.io/v1"
GRAPHQL_URL = "https://api.runpod.io/graphql"
REQUEST_TIMEOUT = 30

# Same reasoning as the Vast session: the Machines view makes several calls per
# poll and a fresh TLS handshake each time is the page load on a slow link.
_session = requests.Session()


def _api_key() -> str:
    """RunPod credentials.

    RUNPOD_API_KEY first, then RUNPOD_MANAGEMENT_API_KEY — the shared hive env
    already carries the latter for unrelated fleet work, and it is NOT
    necessarily the same account that holds this studio's rental credit. The
    studio-specific name wins so the two can differ on one machine.
    """
    for name in ("RUNPOD_API_KEY", "RUNPOD_MANAGEMENT_API_KEY"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    raise ProviderError("RUNPOD_API_KEY is not configured in the environment", status_code=503)


def request(method: str, path: str, payload: dict | None = None) -> Any:
    """A pods call, against the REST API."""
    response = _session.request(
        method,
        f"{REST_BASE}{path}",
        json=payload,
        headers={"Authorization": f"Bearer {_api_key()}"},
        timeout=REQUEST_TIMEOUT,
    )
    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.status_code >= 400:
        detail = ""
        if isinstance(body, dict):
            detail = str(body.get("error") or body.get("message") or "")
        elif isinstance(body, list) and body and isinstance(body[0], dict):
            detail = str(body[0].get("error") or "")
        raise ProviderError(
            f"RunPod API {method} {path} failed: {detail or response.text[:200]}",
            status_code=502,
        )
    return body


def graphql(query: str) -> dict:
    """A catalog or balance call, against the GraphQL API.

    GraphQL answers 200 with an `errors` array rather than an HTTP status, so a
    failure here has to be read out of the body — treating the 200 as success
    is how a broken query becomes an empty rung that looks sold out.
    """
    response = _session.post(
        GRAPHQL_URL,
        json={"query": query},
        headers={"Authorization": f"Bearer {_api_key()}"},
        timeout=REQUEST_TIMEOUT,
    )
    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.status_code >= 400 or body.get("errors"):
        detail = str(body.get("errors") or response.text[:200])[:200]
        raise ProviderError(f"RunPod GraphQL failed: {detail}", status_code=502)
    return body.get("data") or {}


# RunPod names its cards differently from Vast, and the ladder speaks Vast's
# names because that is where every measurement in RENTAL_BENCHMARKS was taken.
# Mapping here rather than widening GPU_CLASSES keeps the ladder single-sourced:
# a card is one class with one benchmark, however many marketplaces sell it.
#
# Absent by design, and this is the important half of the table. RunPod sells
# "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition" as its own GPU type,
# plus two MIG slices of the Server Edition (1g.24gb, 2g.48gb). The Max-Q is the
# 300W part that benchmarks at half a full PRO 6000 and generates SLOWER than a
# 5090 for twice the price — the exact SKU _underpowered exists to catch on Vast,
# where both hide behind one gpu_name. Here they are separate ids, so simply not
# naming them is a cleaner filter than any heuristic.
GPU_TYPE_IDS: dict[str, list[str]] = {
    "RTX 4090": ["NVIDIA GeForce RTX 4090"],
    "RTX 5090": ["NVIDIA GeForce RTX 5090"],
    "RTX PRO 6000 WS": ["NVIDIA RTX PRO 6000 Blackwell Workstation Edition"],
    "RTX PRO 6000 S": ["NVIDIA RTX PRO 6000 Blackwell Server Edition"],
}
_VAST_NAME_BY_RUNPOD_ID = {
    runpod_id: vast_name
    for vast_name, runpod_ids in GPU_TYPE_IDS.items()
    for runpod_id in runpod_ids
}

# Community is roughly a third cheaper than Secure (measured 2026-08-14: a 5090
# is $0.69 against $0.99) and is the tier a rental studio wants — these are
# single-session boxes we destroy when the work is done, not long-lived
# infrastructure with an uptime commitment.
CLOUD_TYPE = os.environ.get("HIVEMIND_RUNPOD_CLOUD_TYPE", "COMMUNITY").upper()

_CATALOG_QUERY = """
{
  gpuTypes {
    id
    displayName
    memoryInGb
    communityCloud
    secureCloud
    communityPrice
    securePrice
    lowestPrice(input: {gpuCount: 1}) { stockStatus minMemory }
  }
}
"""


def bootstrap_command(onstart: str) -> list[str]:
    """Wrap the shared provisioning script in the bootstrap Vast does for free.

    Returns a docker entrypoint. sshd comes first and unconditionally: the
    tunnel is the ONLY way anything reaches ComfyUI on a rented box, so a
    machine we cannot SSH into is a machine that bills by the hour for nothing.
    Everything after it is the provider-agnostic script, written out through a
    quoted heredoc so no amount of quoting inside it can break the command line
    — the script carries base64 blobs, presigned URLs and nested shell
    functions, and a single unbalanced quote would otherwise strand the box.

    It ENDS by blocking forever, which is not decoration. On Vast the onstart
    script is run by the image's own entrypoint, which stays alive afterwards
    holding the container open. Here the script IS the entrypoint, so the
    moment it returns, PID 1 exits and RunPod tears the pod down — taking
    ComfyUI, the beacon and 40GB of freshly downloaded weights with it, having
    billed for all of it. The provisioning script backgrounds everything it
    starts (setsid nohup), so without this the pod would stop within seconds of
    finishing a successful provision.
    """
    script = (
        "set -u\n"
        # The image sets `umask 002` for its own build, and it is still in
        # force here. That makes every directory we create group-writable,
        # which sshd flatly refuses for /run/sshd ("must be owned by root and
        # not group or world-writable") — it exits 255 and the box is
        # unreachable. Same family as the Vast authorized_keys StrictModes
        # trap: OpenSSH rejects permissions it considers unsafe rather than
        # warning, so anything on the SSH path has to set its own mode instead
        # of inheriting one.
        "umask 022\n"
        # Everything the bootstrap does is logged where the BEACON can serve it.
        # The beacon is a plain http.server over /root/beacon and is the only
        # channel that exists before SSH does — so when the bootstrap is what
        # broke, this is the difference between a diagnosable box and a
        # $0.69/hr black box. Learned the hard way on 2026-08-15: sshd failed
        # to start, every SSH attempt was refused, and its log sat on a disk
        # nothing could reach.
        "mkdir -p /root/beacon\n"
        "exec > >(tee -a /root/beacon/bootstrap.log) 2>&1\n"
        # The venv, which Vast's entrypoint activates and we have just skipped.
        # The shared script installs with an absolute /venv/main/bin/pip but
        # LAUNCHES ComfyUI as a bare `python main.py`, so without this the pod
        # provisions perfectly — 40GB of weights, every node pinned, the beacon
        # reporting progress — and then finds no `python` on Ubuntu 24.04 at
        # all. That failure is invisible from the outside: the box is up, SSH
        # answers, the tunnel opens, and nothing serves on the other end.
        "export VIRTUAL_ENV=/venv/main\n"
        'export PATH="/venv/main/bin:$PATH"\n'
        # dpkg rather than `command -v sshd`: the daemon is not on PATH on
        # every base image even when it is installed.
        "if ! dpkg -s openssh-server >/dev/null 2>&1; then\n"
        "  apt-get update -qq && apt-get install -y -qq --no-install-recommends openssh-server\n"
        "fi\n"
        # Explicit mode as well as the umask: the directory can already exist
        # with the wrong mode, in which case mkdir -p is a no-op.
        "mkdir -p /run/sshd && chmod 755 /run/sshd\n"
        # Host keys, which are NOT in the image. openssh-server is preinstalled
        # here (Vast needs it), so the dpkg check above skips the apt install
        # that would normally generate them — and Vast's entrypoint, which
        # generates them at boot, is the thing we just replaced. sshd then exits
        # immediately with "no hostkeys available" and the box is unreachable
        # while looking perfectly healthy from the outside: container up, ports
        # published, beacon reporting progress, and every SSH connection
        # refused. Measured on a live pod 2026-08-15. ssh-keygen -A only
        # creates what is missing, so it is safe on every restart.
        "ssh-keygen -A\n"
        # The box only ever accepts our key. Leaving password auth to the
        # image's defaults on a public IP is not a risk worth inheriting.
        "sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config\n"
        "sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config\n"
        # Log it: a silent sshd failure is the one failure that removes our
        # ability to diagnose anything else on the box.
        "command -v sshd || echo 'NO sshd BINARY ON PATH'\n"
        "ls -la /usr/sbin/sshd || true\n"
        "/usr/sbin/sshd -E /root/beacon/sshd.log; echo \"sshd exit=$?\"\n"
        "(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ':22 ' "
        "|| echo 'NOTHING LISTENING ON 22'\n"
        f"{onstart}\n"
    )
    return [
        "bash",
        "-lc",
        "cat <<'HIVEMIND_PROVISION_EOF' > /root/provision.sh\n"
        f"{script}"
        "HIVEMIND_PROVISION_EOF\n"
        # The provisioning script runs as a CHILD and its exit code is
        # swallowed, then PID 1 blocks forever. Both halves are load-bearing,
        # and `exec bash provision.sh` (which is what this was first) gets both
        # wrong: the shared script has `exit 1` failure paths in the middle of
        # it, so as PID 1 it takes the container down with it the moment
        # anything goes wrong — RunPod then restarts it and the whole thing
        # crash-loops, which is exactly what a live pod did on 2026-08-15.
        # Holding the box open on failure is the point: the operator needs to
        # SSH in and read /root/hivemind-provision.log, and the studio's reaper
        # is what decides when a failed box dies. A pod that vanishes takes the
        # only evidence with it.
        "chmod +x /root/provision.sh && { bash /root/provision.sh || true; }; exec sleep infinity",
    ]


class RunPodProvider:
    key = "runpod"
    label = "RunPod"
    credit_url = "runpod.io/console/billing"

    def configured(self) -> bool:
        return any(
            os.environ.get(name, "").strip()
            for name in ("RUNPOD_API_KEY", "RUNPOD_MANAGEMENT_API_KEY")
        )

    # --- shopping ----------------------------------------------------------

    def search_offers(self, query: OfferQuery) -> list[Offer]:
        """One synthetic offer per GPU type we asked about and RunPod stocks.

        There is nothing to rank within a type — every pod of a type costs the
        same — so one row per type is the whole market, not a sample of it.
        Types with no stock or no price on our cloud tier are dropped rather
        than returned at price None, so an unavailable rung reads as sold out
        exactly like a marketplace rung with no asks.
        """
        wanted: dict[str, str] = {}
        for vast_name in query.gpu_names:
            for runpod_id in GPU_TYPE_IDS.get(vast_name, []):
                wanted[runpod_id] = vast_name
        if not wanted:
            return []
        offers: list[Offer] = []
        for entry in graphql(_CATALOG_QUERY).get("gpuTypes") or []:
            runpod_id = str(entry.get("id") or "")
            if runpod_id not in wanted:
                continue
            price = self._price(entry)
            if price is None:
                continue
            lowest = entry.get("lowestPrice") or {}
            # No stock status at all means nothing is schedulable right now.
            if not lowest.get("stockStatus"):
                continue
            offers.append(Offer(
                provider=self.key,
                offer_id=runpod_id,
                gpu_name=wanted[runpod_id],
                usd_per_hour=round(price, 4),
                vram_mb=int(entry["memoryInGb"] * 1024) if entry.get("memoryInGb") else None,
                # System RAM the smallest machine of this type carries. On
                # RunPod that is what the container gets — there is no
                # machine/container split to undo as there is on Vast.
                ram_gb=float(lowest["minMemory"]) if lowest.get("minMemory") else None,
                # Left unset deliberately, and the consequence is real: RunPod
                # publishes no per-host link speed, so the bandwidth floor that
                # keeps BILLED provisioning time down cannot be used to choose
                # between hosts here. It is applied at create time instead
                # (minDownloadMbps), which is the better tool anyway.
                down_mbps=None,
                dlperf=None,
                reliability=None,
                geolocation=None,
                datacenter=True,
                # RunPod does not expose the physical host, so the shared
                # bad-machine cooldown has nothing stable to remember a failure
                # against and correctly does not fire for these offers.
                machine_id=None,
                raw=entry,
            ))
        return offers

    @staticmethod
    def _price(entry: dict) -> float | None:
        """Hourly price on the cloud tier we rent from.

        A type that is not offered on our tier, or is offered at no price, is
        out of stock — not free.
        """
        if CLOUD_TYPE == "COMMUNITY":
            if not entry.get("communityCloud"):
                return None
            return float(entry["communityPrice"]) if entry.get("communityPrice") else None
        if not entry.get("secureCloud"):
            return None
        return float(entry["securePrice"]) if entry.get("securePrice") else None

    # --- renting -----------------------------------------------------------

    def create(self, spec: LaunchSpec) -> str:
        gpu_type_ids = (
            [spec.offer_id]
            if spec.offer_id
            else [rid for name in spec.gpu_names for rid in GPU_TYPE_IDS.get(name, [])]
        )
        if not gpu_type_ids:
            raise ProviderError("no RunPod GPU type matches the requested class", status_code=400)
        payload: dict[str, Any] = {
            "name": spec.label,
            "imageName": spec.image,
            "gpuTypeIds": gpu_type_ids,
            "gpuCount": 1,
            "cloudType": CLOUD_TYPE,
            # Container disk, not a network volume: the weights are pulled
            # fresh per rental and the box is destroyed after, so a persistent
            # volume would bill for storage nobody reads again.
            "containerDiskInGb": int(spec.disk_gb),
            # volumeInGb MUST be 0, and stating the intent above is not enough
            # to make it so. RunPod defaults it to 20 and mounts it at
            # /workspace — which is exactly where the provisioning script puts
            # the weights. So an 80GB container disk sat empty at 1% while the
            # models filled a 20GB volume nobody asked for and the download
            # died at "no space left" with df reporting 80G free. Measured on a
            # live pod 2026-08-15: `/dev/nvme0n1p3 20G 20G 4.0K 100% /workspace`
            # next to `overlay 80G 104M 80G 1% /`.
            "volumeInGb": 0,
            "ports": [f"{port}/tcp" for port in (22, *spec.expose_ports)],
            # Without a public IP there is no port 22 to reach and no tunnel.
            "supportPublicIp": True,
            # Replaces the image's entrypoint. On the Vast image that
            # entrypoint is Vast's own instance-tools bootstrap, which has
            # nothing to do here.
            "dockerEntrypoint": bootstrap_command(spec.onstart),
            "dockerStartCmd": [],
        }
        # Scheduling constraints, not filters: RunPod picks a machine that
        # satisfies these. The RAM floor is the one that matters — measured
        # 2026-08-13 on Vast, a container too small to stage the weights does
        # not render badly, its ComfyUI is killed mid-job.
        if spec.min_ram_gb:
            payload["minRAMPerGPU"] = int(spec.min_ram_gb)
        if spec.min_down_mbps:
            payload["minDownloadMbps"] = int(spec.min_down_mbps)
        body = request("POST", "/pods", payload)
        pod_id = body.get("id") if isinstance(body, dict) else None
        if not pod_id:
            raise ProviderError(f"RunPod did not return a pod id: {json.dumps(body)[:200]}")
        return str(pod_id)

    @staticmethod
    def ask_evaporated(exc: ProviderError) -> bool:
        """RunPod has no asks to lose — a failure here is a real failure."""
        return False

    # --- lifecycle ---------------------------------------------------------

    # The published port MAP is GraphQL-only. REST /pods returns `ports` as the
    # spec we asked for (["22/tcp", "18189/tcp"]) and never the host ports they
    # landed on, so a pod listed purely from REST has no reachable SSH endpoint
    # and the studio would wait on "booting" forever. Verified against a live
    # pod 2026-08-15.
    #
    # createdAt is GraphQL-only too. The REST Pod schema has no creation time
    # at all — only lastStartedAt (checked against the published OpenAPI
    # document 2026-08-22) — and reading createdAt off the REST payload is how
    # rental runpod:vrygri4b9b1x78 ran 19 minutes at $0.69/h with no uptime in
    # the Machines view and was reaped as 0.0 h / $0.00. See _started_at. Both
    # fields were validated against the live GraphQL schema the same day; a
    # field the schema does not know 400s the whole query, and with it the
    # port map, so nothing goes in here unverified.
    _RUNTIME_QUERY = """
    { myself { pods { id createdAt lastStartedAt machine { podHostId gpuTypeId }
        runtime { uptimeInSeconds ports { ip isIpPublic privatePort publicPort } } } } }
    """

    def list_instances(self) -> list[Instance]:
        body = request("GET", "/pods")
        pods = body if isinstance(body, list) else (body.get("pods") or body.get("data") or [])
        pods = [raw for raw in pods if isinstance(raw, dict)]
        if not pods:
            return []
        # One extra call for the whole account, not one per pod: the studios
        # poll this endpoint and a per-pod query would scale the machine list
        # with the fleet.
        runtimes: dict[str, dict] = {}
        try:
            for entry in ((graphql(self._RUNTIME_QUERY).get("myself") or {}).get("pods") or []):
                runtimes[str(entry.get("id"))] = entry
        except ProviderError:
            # Degrade to REST-only rather than dropping the machine list: a pod
            # with no endpoint reads as still booting, which is recoverable.
            # Losing the list entirely would hide a machine that is billing.
            pass
        return [self._instance(raw, runtimes.get(str(raw.get("id"))) or {}) for raw in pods]

    def _instance(self, raw: dict, live: dict | None = None) -> Instance:
        live = live or {}
        status = str(raw.get("desiredStatus") or "").upper()
        runtime = live.get("runtime") or raw.get("runtime") or {}
        ports: dict[int, str] = {}
        public_ip = raw.get("publicIp") or None
        for mapping in runtime.get("ports") or []:
            if not isinstance(mapping, dict):
                continue
            private, public = mapping.get("privatePort"), mapping.get("publicPort")
            if not (private and public):
                continue
            ports[int(private)] = str(public)
            # isIpPublic matters: a pod reports BOTH its routable address and a
            # 100.64.0.0/10 carrier-NAT one, and taking whichever mapping came
            # last made the endpoint flip between them poll to poll. The
            # private one is unreachable from here, so a tunnel aimed at it
            # simply hangs.
            if mapping.get("isIpPublic") and mapping.get("ip"):
                public_ip = mapping["ip"]
        if status in {"EXITED", "TERMINATED", "STOPPED"}:
            state = "stopped"
        elif status == "RUNNING" and ports:
            # Same caveat as Vast, one layer deeper: RUNNING means the pod is
            # scheduled, and the ports appear only once the container is really
            # up. Whether OUR stack came up inside it is what the beacon
            # answers. uptimeInSeconds is negative while it is still starting.
            state = "running"
        else:
            state = "booting"
        machine = live.get("machine") or raw.get("machine") or {}
        gpu_id = machine.get("gpuTypeId") or raw.get("gpuTypeId")
        ssh_port = ports.get(22)
        return Instance(
            provider=self.key,
            native_id=str(raw.get("id")),
            label=raw.get("name") or "",
            state=state,
            usd_per_hour=round(float(raw.get("costPerHr") or 0), 4),
            # A stopped pod keeps billing its container disk.
            paused_usd_per_hour=round(float(raw.get("storageCostPerHr") or 0), 4),
            gpu_name=_VAST_NAME_BY_RUNPOD_ID.get(str(gpu_id or ""), gpu_id),
            # RunPod DOES name the physical host, so the shared bad-machine
            # cooldown works here exactly as it does on Vast.
            machine_id=raw.get("machineId") or machine.get("podHostId"),
            disk_gb=raw.get("containerDiskInGb"),
            started_at=_started_at(raw, live, runtime),
            public_ip=public_ip,
            ssh=(public_ip, ssh_port) if public_ip and ssh_port else None,
            ports=ports,
            raw={**raw, "runtime": runtime},
        )

    def destroy(self, native_id: str) -> None:
        request("DELETE", f"/pods/{native_id}")

    def pause(self, native_id: str) -> None:
        request("POST", f"/pods/{native_id}/stop")

    def resume(self, native_id: str) -> None:
        request("POST", f"/pods/{native_id}/start")

    def credit(self) -> float:
        data = graphql("{ myself { clientBalance } }")
        return round(float((data.get("myself") or {}).get("clientBalance") or 0.0), 4)


def _started_at(raw: dict, live: dict, runtime: dict) -> float | None:
    """When the pod started billing, from whichever payload actually says.

    Creation time first: the boot-stall check measures how long a box has been
    failing to come up, and uptime does not exist yet for precisely those
    pods. But REST /pods has never carried createdAt — it is GraphQL-only, so
    it arrives in `live` — and a pod with no start time has no uptime in the
    Machines view, no cost, and a reaper record that says it ran for free
    (rental runpod:vrygri4b9b1x78, 2026-08-22: 19 min at $0.69/h, booked as
    0.0 h / $0.00). lastStartedAt is REST's nearest thing: the last start, so
    it skips a paused stretch, which is also the stretch that billed at the
    disk rate only. The runtime clock is the last resort — it runs negative
    while the container is still starting, and a negative uptime is not a
    start time.
    """
    for field_name in ("createdAt", "lastStartedAt"):
        for source in (raw, live):
            started = _epoch(source.get(field_name))
            if started:
                return started
    try:
        uptime = float(runtime.get("uptimeInSeconds") or 0)
    except (TypeError, ValueError):
        uptime = 0.0
    return time.time() - uptime if uptime > 0 else None


def _epoch(value: Any) -> float | None:
    """RunPod timestamps are ISO 8601; the rest of the studio counts seconds."""
    if not value:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


PROVIDER: Provider = register(RunPodProvider())
