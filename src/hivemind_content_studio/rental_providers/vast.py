"""Vast.ai, behind the Provider interface.

Everything here was inline in gpu_rentals.py until 2026-08-14. The behaviour is
unchanged — including the parts that look odd, which are all load-bearing and
carry their original notes.
"""

from __future__ import annotations

import os
import time
from typing import Any

import requests

from . import Instance, LaunchSpec, Offer, OfferQuery, Provider, ProviderError, register, response_error_text

# Vast is mid-migration to /api/v1 and deprecating v0 per-endpoint. Probed
# 2026-08-05: instances LIST is v1-only (v0 returns deprecated_endpoint), but
# bundles search, asks create, and instance DELETE exist ONLY on v0 (v1 404s).
# Paths below therefore carry their own version prefix.
API_BASE = "https://console.vast.ai/api"
REQUEST_TIMEOUT = 30

# One pooled session for every Vast call. Each bare requests.request() opened a
# fresh TLS connection, and opening the Machines view makes three to five of
# them (instances, balance, a bundles search per tier) — on a high-latency link
# that handshake WAS the page load. urllib3's pool is thread-safe, which is what
# FastAPI's sync-route threadpool needs.
_session = requests.Session()


def _api_key() -> str:
    value = os.environ.get("VAST_API_KEY", "").strip()
    if not value:
        raise ProviderError("VAST_API_KEY is not configured in the environment", status_code=503)
    return value


def request(method: str, path: str, payload: dict | None = None) -> dict:
    """One Vast API call, with its rate-limiter handled.

    Module-level rather than a method so the test suite has a single seam to
    fake the whole marketplace at.
    """
    def _send() -> tuple[Any, dict]:
        response = _session.request(
            method,
            f"{API_BASE}{path}",
            json=payload,
            headers={"Authorization": f"Bearer {_api_key()}"},
            timeout=REQUEST_TIMEOUT,
        )
        try:
            return response, response.json()
        except ValueError:
            return response, {}

    response, body = _send()
    if response.status_code == 429 or body.get("error") == "HTTPTooManyRequests":
        # The relaxation loop plus every tier querying at once can burst past
        # Vast's limiter; it tells us how long to wait, then succeeds.
        time.sleep(float(body.get("retry_after") or 2))
        response, body = _send()
    if response.status_code >= 400 or body.get("error"):
        detail = body.get("msg") or body.get("error") or response_error_text(response.text, response.status_code)
        raise ProviderError(f"Vast API {method} {path} failed: {detail}", status_code=502)
    return body


def _offer_ram_gb(offer: dict) -> float | None:
    """System RAM the CONTAINER gets, which is not the number the listing shows.

    On a search offer `cpu_ram` is the whole machine's RAM and `gpu_frac` is the
    slice this rental buys, so a headline 145GB host sold in eighths hands the
    container ~18GB. Measured 2026-08-13 against two live rentals: the product
    tracked the real cgroup limit on a whole-machine box (31196MB x 1.0 against
    a 29.2GiB limit) and UNDER-read it on a fractional one (515815MB x 0.125 =
    63GiB against a 171GiB limit), so it is a conservative lower bound — it can
    turn away a box that would have worked, never admit one that cannot.

    Not /proc/meminfo: inside the container that reports the HOST's RAM, which
    is how a 503GB reading came back from a box actually capped at 171GiB.
    """
    ram_mb = float(offer.get("cpu_ram") or 0)
    if ram_mb <= 0:
        return None
    return ram_mb * float(offer.get("gpu_frac") or 1.0) / 1024.0


def _mapped_port(instance: dict, container_port: int) -> str | None:
    entries = (instance.get("ports") or {}).get(f"{container_port}/tcp") or [{}]
    return entries[0].get("HostPort")


def _ssh_endpoints(instance: dict) -> list[tuple[str, str]]:
    """Every way into the container, best first.

    Direct 22/tcp first: it is the box's own sshd on the box's own address,
    with nothing of Vast's in the path. The proxy (ssh_host/ssh_port) follows
    as a fallback, because it is all an instance gets when the create did not
    ask for a 22 mapping — and because it is the half that fails. On
    2026-08-24 Vast reported ssh_port 19896 for a healthy running box and that
    port answered a TLS handshake for CN=jupyter.vast.ai: ssh got a fatal
    decode_error alert and reported "Connection closed by remote host", the
    rental had no other door, and it had to be destroyed. Both forms carry -L
    tunneling identically, so preferring the direct one costs nothing.
    """
    endpoints: list[tuple[str, str]] = []
    direct_port = _mapped_port(instance, 22)
    ip = instance.get("public_ipaddr")
    if direct_port and ip:
        endpoints.append((str(ip), str(direct_port)))
    host, port = instance.get("ssh_host"), instance.get("ssh_port")
    if host and port:
        endpoints.append((str(host), str(port)))
    return endpoints


class VastProvider:
    key = "vast"
    label = "Vast.ai"
    credit_url = "vast.ai"

    def configured(self) -> bool:
        return bool(os.environ.get("VAST_API_KEY", "").strip())

    # --- shopping ----------------------------------------------------------

    def search_offers(self, query: OfferQuery) -> list[Offer]:
        body = request("POST", "/v0/bundles/", self._query_body(query))
        return [self._offer(raw) for raw in (body.get("offers") or [])]

    def _query_body(self, query: OfferQuery) -> dict:
        names = query.gpu_names
        body: dict[str, Any] = {
            "verified": {"eq": True},
            "rentable": {"eq": True},
            # NOT datacenter-only. That constraint was here until 2026-08-14,
            # and on the H3 tier it did not thin the market so much as close
            # it: measured live, 45 verified single-GPU 5090 offers existed and
            # 9 were datacenter (hosting_type 1). Those 9 are datacenter
            # precisely because they are big machines sold in fractions, so
            # every one of them failed the caller's RAM floor and the MiniMax
            # rung rendered "No RTX 5090 offers match right now" against a
            # market that had dozens. Reliability still rests on `verified`,
            # reliability2, the caller's failure cooldown and its RAM floor.
            "gpu_name": {"eq": names[0]} if len(names) == 1 else {"in": names},
            "reliability2": {"gt": 0.99},
            "disk_space": {"gt": query.min_disk_gb},
            # `disk_space` only FILTERS. The price Vast quotes (dph_total) is
            # GPU plus storage, and the storage half is computed from
            # `allocated_storage`, which defaults to 8GB when omitted — so
            # without this line every offer is quoted as if it carried an 8GB
            # disk while create() rents it with the tier's 120GB. Measured
            # 2026-08-21 on a 5090 ask: quoted $0.551/hr, billed $0.613/hr,
            # the whole gap being 112GB x $0.40/GB-month. Quote the disk we
            # will actually rent, and the offer price is the instance price.
            "allocated_storage": query.min_disk_gb,
            "type": "on-demand",
            "order": [["dph_total", "asc"]],
            # Price-ordered and truncated, so this has to exceed the whole
            # qualifying market or the priciest rung reads as sold out when it
            # is merely past the cut. 60 was sized against the 49-offer
            # datacenter-only market of 2026-08-08, and the moment the
            # datacenter constraint came off, the image tier's market grew to
            # 100 offers whose 60th cheapest was $0.73 — below every PRO 6000
            # on the market, so that rung reported itself sold out with 29
            # offers live. Re-measured 2026-08-14: 100 image / 55 minimax / 41
            # video. The response is bounded by the real market anyway (limit
            # 2000 returns the same 100).
            "limit": query.limit,
        }
        if query.single_gpu_only:
            body["num_gpus"] = {"eq": 1}
        if query.min_down_mbps is not None:
            body["inet_down"] = {"gt": query.min_down_mbps}
        return body

    def _offer(self, raw: dict) -> Offer:
        return Offer(
            provider=self.key,
            offer_id=str(raw.get("id")),
            gpu_name=str(raw.get("gpu_name") or ""),
            usd_per_hour=round(float(raw.get("dph_total") or 0), 4),
            vram_mb=raw.get("gpu_ram"),
            ram_gb=_offer_ram_gb(raw),
            down_mbps=raw.get("inet_down"),
            # This host's own benchmark, not the class median — the two diverge
            # by 2x across SKUs sold under one gpu_name.
            dlperf=round(float(raw["dlperf"]), 1) if raw.get("dlperf") else None,
            reliability=raw.get("reliability2"),
            geolocation=raw.get("geolocation"),
            # The search response carries no `datacenter` key even when you
            # filter on it — hosting_type is where that lives, and 1 means
            # datacenter. Reported, not filtered on: see _query_body.
            datacenter=raw.get("hosting_type") == 1,
            machine_id=raw.get("machine_id"),
            raw=raw,
        )

    # --- renting -----------------------------------------------------------

    def create(self, spec: LaunchSpec) -> str:
        if not spec.offer_id:
            raise ProviderError("Vast rents a specific ask; no offer was chosen", status_code=400)
        body = request("PUT", f"/v0/asks/{spec.offer_id}/", {
            "client_id": "me",
            "image": spec.image,
            "disk": spec.disk_gb,
            "label": spec.label,
            "onstart": spec.onstart,
            "runtype": "ssh",
            # Publish sshd and the beacon; ComfyUI stays on loopback behind the
            # tunnel. Port 22 is here so the box has a door that is ours rather
            # than Vast's: without a direct mapping _ssh_endpoints can only
            # offer the proxy, and a proxy port that turns out not to speak SSH
            # leaves the rental unreachable and unfixable (2026-08-24). sshd is
            # pubkey-only, so publishing it concedes nothing ComfyUI does not
            # already keep on loopback — RunPod has always mapped 22 this way.
            "env": {f"-p {port}:{port}": "1" for port in (22, *spec.expose_ports)},
        })
        return str(body.get("new_contract"))

    @staticmethod
    def ask_evaporated(exc: ProviderError) -> bool:
        """The ask was taken between our search and our PUT.

        Vast asks go stale within SECONDS, so this is the normal case under any
        contention, not an error worth surfacing — the caller moves to the next
        candidate.
        """
        text = str(exc)
        return "no_such_ask" in text or "not available" in text

    # --- lifecycle ---------------------------------------------------------

    def list_instances(self) -> list[Instance]:
        body = request("GET", "/v1/instances/")
        return [self._instance(raw) for raw in (body.get("instances") or [])]

    def _instance(self, raw: dict) -> Instance:
        actual = raw.get("actual_status")
        stopped = (
            str(raw.get("cur_state") or "").lower() in {"stopped", "exited"}
            or actual in {"exited", "stopped"}
        )
        if stopped:
            state = "stopped"
        elif actual in (None, "", "created", "loading"):
            # Vast marks an instance running the moment the HOST accepts the
            # contract, which is long before the image is unpacked and the
            # container exists — never surface that as a machine state.
            state = "booting"
        elif actual == "running":
            state = "running"
        else:
            state = str(actual)
        # Every published port, generically — the beacon's number belongs to
        # the caller that asked for it, not to this adapter.
        ports: dict[int, str] = {}
        for spec, entries in (raw.get("ports") or {}).items():
            try:
                container_port = int(str(spec).split("/")[0])
            except ValueError:
                continue
            host_port = (entries or [{}])[0].get("HostPort")
            if host_port:
                ports[container_port] = str(host_port)
        return Instance(
            provider=self.key,
            native_id=str(raw.get("id")),
            label=raw.get("label") or "",
            state=state,
            usd_per_hour=round(float(raw.get("dph_total") or 0), 4),
            # What a paused box costs: Vast keeps billing the disk only.
            paused_usd_per_hour=round(float(raw.get("storage_total_cost") or 0), 4),
            gpu_name=raw.get("gpu_name"),
            machine_id=raw.get("machine_id"),
            disk_gb=raw.get("disk_space"),
            started_at=raw.get("start_date"),
            public_ip=raw.get("public_ipaddr"),
            ssh_endpoints=_ssh_endpoints(raw),
            ports=ports,
            raw=raw,
        )

    def destroy(self, native_id: str) -> None:
        request("DELETE", f"/v0/instances/{native_id}/")

    def pause(self, native_id: str) -> None:
        request("PUT", f"/v0/instances/{native_id}/", {"state": "stopped"})

    def resume(self, native_id: str) -> None:
        request("PUT", f"/v0/instances/{native_id}/", {"state": "running"})

    def credit(self) -> float:
        # v0 only — /v1/users/current/ 404s (Vast's migration is per-endpoint).
        body = request("GET", "/v0/users/current/")
        return round(float(body.get("credit") or 0.0), 4)


PROVIDER: Provider = register(VastProvider())
