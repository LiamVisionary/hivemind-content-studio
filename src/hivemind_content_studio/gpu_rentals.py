"""Owner-gated GPU rentals: provision studio ComfyUI boxes on Vast.ai.

Drives the owner's own Vast account directly (VAST_API_KEY from the shared
hive env) — distinct from the hosted customer billing gateway, which meters
credits server-side. Tier presets, offer filters, the provisioning bootstrap,
and the model set all mirror the CUDA validation runs recorded in
packages/gpu-rentals/ (2026-07-31): datacenter+verified RTX 5090 boxes,
weights pulled from the private R2 bucket via short-lived presigned URLs.

Safety rail: this module only ever destroys instances whose label carries
STUDIO_LABEL_PREFIX. The hosted billing worker rents `hivemind-rental-gpur_*`
instances on the same Vast account; those must never be touched from here.
"""
from __future__ import annotations

import base64
import contextlib
import gzip
import hashlib
import hmac
import json
import os
import re
import signal
import socket
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests

# Vast is mid-migration to /api/v1 and deprecating v0 per-endpoint. Probed
# 2026-08-05: instances LIST is v1-only (v0 returns deprecated_endpoint), but
# bundles search, asks create, and instance DELETE exist ONLY on v0 (v1 404s).
# Paths below therefore carry their own version prefix.
VAST_API_BASE = "https://console.vast.ai/api"
CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"
R2_BUCKET = "hivemind-rental-models"
STUDIO_LABEL_PREFIX = "hivemind-studio-gpur-"
COMFY_IMAGE = "vastai/comfy:@vastai-automatic-tag"
# Progress beacon: the box serves /progress.json on this (published) port so
# the Machines view can render truthful provisioning phases. ComfyUI itself
# stays bound to 127.0.0.1 — only the beacon is exposed.
BEACON_PORT = 18189
PRESIGN_EXPIRE_SECONDS = 3 * 3600
# Vast's documented ceiling for the onstart/args field. Measured 2026-08-08:
# the video tier's 11 presigned URLs alone are ~6.6KB of it.
VAST_ONSTART_LIMIT = 16384
_REQUEST_TIMEOUT = 30
# curl aborts a transfer that stays under this floor for DOWNLOAD_STALL_SECONDS,
# and its own --retry then reopens the connection, resuming from the .dl
# partial. The floor used to be 50 KB/s, which is low enough that no degraded
# transfer ever trips it: measured 2026-08-10, a route that had collapsed to
# 59 KB/s sat just above the floor and would have needed ~39 HOURS to finish an
# 8.3GB file, holding a billed box at 10/11 the whole time. Healthy R2 pulls run
# 55-100 MB/s aggregate — 5-9 MB/s per file with a whole tier in flight — so
# 1 MB/s sits well below "contended" and well above "dead".
DOWNLOAD_MIN_BYTES_PER_SEC = 1_048_576
DOWNLOAD_STALL_SECONDS = 60
# Backstop for a stall the per-transfer floor cannot see, e.g. a connection that
# hangs without dying or a retry loop that keeps resetting. The slowest healthy
# provision observed is ~20 minutes (95GB video tier), so this only fires on a
# machine that is never going to finish.
DOWNLOAD_DEADLINE_SECONDS = 45 * 60

# Per-tier serving sets: (R2 object key, ComfyUI models/ subpath). Mirrors
# packages/gpu-rentals/models.manifest.json.
_IMAGE_MODELS = [
    ("diffusion_models/Krea2_Turbo_convrot_int8mixed.safetensors", "diffusion_models"),
    ("text_encoders/qwen3VL4BAbliteratedComfyui_v10.safetensors", "text_encoders"),
    # Bucket key is checkpoints/ (bulk-upload layout); the box needs it in
    # diffusion_models/ because the workflow loads it via UNETLoader.
    ("checkpoints/waiANIMA_v10Base10.safetensors", "diffusion_models"),
    ("text_encoders/waiANIMA_v10Base10_txt.safetensors", "text_encoders"),
    ("loras/anima-turbo-lora-v0.2.safetensors", "loras"),
    ("vae/qwen_image_vae.safetensors", "vae"),
]
_VIDEO_MODELS = [
    ("checkpoints/ltx-2.3-22b-dev-fp8.safetensors", "checkpoints"),
    ("checkpoints/ltx2310eros_v14.safetensors", "checkpoints"),
    ("loras/ltx2310eros_v14_dmd_lora.safetensors", "loras"),
    ("text_encoders/gemma_3_12B_it_fp8_scaled.safetensors", "text_encoders"),
    ("vae/taeltx2_3.safetensors", "vae"),
]
# MiniMax H3 joint video+stereo-audio (Blackwell-only: the nvfp4 TE needs
# sm_120 — the RTX 5090 filter covers it). Mirrors manifest tier
# minimax-h3-video; the DiT loads via plain UNETLoader on the pinned commit,
# so the tier does NOT need the INT8-Fast custom loader.
_MINIMAX_MODELS = [
    ("diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors", "diffusion_models"),
    ("text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "text_encoders"),
    ("vae/minimax_h3_video_vae_fp16.safetensors", "vae"),
    ("vae/minimax_h3_audio_vae_fp32.safetensors", "vae"),
]
# The turbo LoRA and its loader come from upstream, not R2: the weights are
# public, and larryvrh's node is REQUIRED to apply them — it re-injects the
# time conditioning a pruned base (ours) lacks, which is the whole reason we
# previously shipped drbaph's AdaLN-stripped conversion as a workaround for
# ComfyUI's plain LoraLoaderModelOnly. (url, models/ subdir, filename, GB)
_MINIMAX_PUBLIC_FILES = [
    (
        "https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/resolve/main/"
        "minimax_h3_turbo_v4_step600_ema.safetensors",
        "loras",
        "minimax_h3_turbo_v4_step600_ema.safetensors",
        0.78,
    ),
]
# Pinned like every other node on the box. 2026-08-07 HEAD; ships
# h3_silu_temb_grid.safetensors, the silu(t_emb) grid the loader needs.
_H3_TURBO_NODE_COMMIT = "55fee864dd7b2976b1c4ce3c3d5f7968f181409f"
# H3 support is newer than any vastai/comfy release image; the Spectrum node
# is contract-tested against this ComfyUI commit (2026-08-03, native MiniMax
# H3 + packed-latent sampler API). Same pin as provisioning/comfyui-hivemind.sh.
_H3_COMFY_COMMIT = "e377e263049f9338b4d12a3dd417b36ae62948ff"
# The custom nodes were cloned at HEAD until 2026-08-07, when upstream Spectrum
# dc6e1b3 flipped bootstrap_first_forecast's default to true — every H3 job on a
# box provisioned after that commit died in validate() against our tuned
# degree=4/warmup_steps=5 graph, hours after the last box had validated clean.
# A rented box must run the node build the registered graph was tuned against,
# so both are pinned like ComfyUI itself. Bump deliberately, with a live rerun.
# v0.2.3 (2026-08-08). Bumped from v0.1.8 deliberately: v0.1.9 turns the
# bootstrap/warmup clash that broke us into an auto-disable, and v0.2.0/v0.2.1
# add audio_blend_weight + default offline_smoothing_replay after upstream
# validated that a single pass at video=0.5/audio=0 "reproduced degraded speech
# and stuttering" — H3 output is joint video+audio, so that is our failure mode.
# Its README pins the SAME minimum ComfyUI commit we already run (e377e263), so
# this needs no ComfyUI bump. Every new input is set explicitly in the graph.
_H3_SPECTRUM_COMMIT = "9395bf98fc60a04c5f588de7b2bb33516a0b622f"
_H3_KJNODES_COMMIT = "35e5956193769d18a13136cdedb73a36a05c73e6"
# Scene chaining (studio "Continue scene"): MiniMaxH3MotionContext feeds the
# previous clip's tail frames + audio into the next generation and Trim removes
# the re-rendered context head. v0.2.0 (2026-08-09): reference-mode support +
# latent picture path. Patches apply on first node execution only, so plain H3
# jobs on the same box are untouched.
_H3_MOTION_CONTEXT_COMMIT = "c140ae99b8c38f782ebd8564c267b42aacade6a4"

# lane_needles: lowercase substrings matched by the media-gateway's
# COMFY_LANE_RULES against graph class names + model file inputs — attach
# routes generations that reference these models to the rented box.
# Download volume per artifact (GB, from models.manifest.json). Used to derive
# each tier's bandwidth floor: on a 650 Mbps host a 95GB video tier takes ~20
# minutes of BILLED time, on a 3.5 Gbps host ~3.6 minutes. Measured 2026-08-06:
# link speed is the hard ceiling — 8 parallel connections only bought 21% over
# one (65 -> 79 MB/s), so host choice is the lever, not download tuning.
MODEL_SIZE_GB = {
    "diffusion_models/Krea2_Turbo_convrot_int8mixed.safetensors": 12.0,
    "text_encoders/qwen3VL4BAbliteratedComfyui_v10.safetensors": 8.3,
    "checkpoints/waiANIMA_v10Base10.safetensors": 3.9,
    "text_encoders/waiANIMA_v10Base10_txt.safetensors": 1.2,
    "loras/anima-turbo-lora-v0.2.safetensors": 0.15,
    "vae/qwen_image_vae.safetensors": 0.25,
    "checkpoints/ltx-2.3-22b-dev-fp8.safetensors": 27.1,
    "checkpoints/ltx2310eros_v14.safetensors": 27.2,
    "loras/ltx2310eros_v14_dmd_lora.safetensors": 1.6,
    "text_encoders/gemma_3_12B_it_fp8_scaled.safetensors": 13.2,
    "vae/taeltx2_3.safetensors": 0.02,
    "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors": 21.0,
    "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors": 15.7,
    "vae/minimax_h3_video_vae_fp16.safetensors": 5.2,
    "vae/minimax_h3_audio_vae_fp32.safetensors": 0.6,
}
# Target: models land within this many seconds of billed provisioning time.
TARGET_DOWNLOAD_SECONDS = 180


# --- GPU performance ladder -------------------------------------------------
# A rental is a workload (TIERS: which models, which lanes) crossed with a GPU
# class (this table: how fast, how much VRAM, what it costs). They were one
# thing until 2026-08-08, which pinned every workload to a single 5090.
#
# `gpu_names` are Vast's own `gpu_name` strings, taken from a live
# datacenter/verified bundles sweep — a name Vast does not use returns zero
# offers, which reads to the user as "sold out" rather than "typo". The PRO
# 6000 genuinely ships under two of them (server and workstation editions).
#
# `dlperf` is Vast's own per-host deep-learning benchmark, median over the
# verified datacenter offers of that GPU on 2026-08-08. It is a measured
# number rather than a spec sheet, which is why estimates below scale by it —
# but it is a generic DL mix, not a diffusion benchmark, so anything derived
# from it is an estimate and is labelled as one.
REFERENCE_GPU_CLASS = "rtx5090"

GPU_CLASSES: dict[str, dict[str, Any]] = {
    "rtx4090": {
        "label": "RTX 4090",
        "gpu_names": ["RTX 4090"],
        "vram_gb": 24,
        # CUDA compute capability. Ada (89) has fp8 and int8 tensor cores;
        # only Blackwell (120) has the nvfp4 the H3 text encoder needs.
        "sm": 89,
        "dlperf": 97.0,
        "note": "Smallest card the image models fit on; about half a 5090's throughput.",
    },
    "rtx5090": {
        "label": "RTX 5090",
        "gpu_names": ["RTX 5090"],
        "vram_gb": 32,
        "sm": 120,
        "dlperf": 197.2,
        "note": "The card every studio workflow was validated and tuned on.",
    },
    "rtxpro6000": {
        "label": "RTX PRO 6000",
        "gpu_names": ["RTX PRO 6000 WS", "RTX PRO 6000 S"],
        "vram_gb": 96,
        "sm": 120,
        "dlperf": 281.8,
        "note": "Same Blackwell generation, ~40% more throughput and 96GB — "
                "big enough to hold H3's encoder and transformer at once.",
    },
}
# Deliberately absent: H100/H200/B200. They cannot run the H3 tier at all (no
# sm_120 nvfp4 for its text encoder), and for the other two their edge is
# batch throughput, not single-clip latency — at 3-9x the hourly price they
# lose on cost per generation even if the benchmark ratio held, so putting
# them at the top of a performance slider would sell the worst deal as the
# best one. Ampere (RTX 3090 / A5000) is absent for the opposite reason: it is
# barely cheaper than a 5090 here and has neither fp8 nor a validated int8
# convrot path.

# Whole-job seconds for each workload's reference job on a warm box. MEASURED,
# not modelled — every other number in the ladder is scaled from these, so
# they are the only place a real stopwatch reading belongs. Add a row after
# validating a class live; the UI shows measured rows differently.
RENTAL_BENCHMARKS: dict[tuple[str, str], float] = {
    ("image", "rtx5090"): 2.8,     # 1024², 8-step deis, steady state (2026-07-31)
    # eros v1.4 + DMD, 4s @768x512, 8 steps. 15.6 + 16.1 + 15.8 on rental
    # 47390808 (2026-08-10), replacing 48.0 from 2026-07-31. That host
    # benchmarks BELOW its class median (dlperf 160.3 against 197.2), and the
    # graph now decodes the audio it had been discarding, so this is if
    # anything a ceiling for the class rather than a flattering pick.
    ("video", "rtx5090"): 15.8,
    # Controlled pair, 2026-08-10: identical graph, prompt, seed protocol and
    # harness, one warmup discarded, two timed runs each, submit-to-sealed.
    ("minimax", "rtx5090"): 40.0,       # 38.9 + 41.1 (rental 47390569)
    ("minimax", "rtxpro6000"): 75.1,    # 75.0 + 75.2 (rental 47391521)
}
# The 5090 row replaces a 102.0s reading from 2026-08-08 — the graph was
# retuned in between (it now runs euler with Spectrum history in VRAM), which
# is the likely cause but is not something the untracked graph file can prove.
# Cold start costs ~33s on top of these, not the ~150s weight init noted then.
#
# The PRO 6000 row is the surprise, and it is not a fluke: sampling alone is
# 51s against the 5090's 20s for the same 15 steps, so it is on-GPU, not the
# tunnel or the mux. Three boxes, one direction — 5090 40.0s, PRO 6000 Max-Q
# 47.9s, PRO 6000 Server Edition 75.1s. Hardware differences that are
# CONFIRMED: the PRO 6000 runs a 2430MHz core against the 5090's 3105MHz, and
# has ECC enabled where the 5090 has no ECC at all. Not confirmed, but the
# likeliest cause of the rest of the gap: the two hosts shipped different CUDA
# builds (torch 2.10.0+cu128 on the PRO 6000, +cu130 on the 5090), and this
# workload leans on int8_convrot and nvfp4 kernels where the Blackwell paths
# differ between them. Proving that needs the same CUDA on both boxes.
#
# The practical consequence is already handled below: the ladder orders by
# these times, so the H3 slider no longer sells a slower, pricier card as its
# top rung.


TIERS: dict[str, dict[str, Any]] = {
    "image": {
        "label": "Image · Krea2 + WAI Anima",
        "family": "Images",
        "family_detail": "Krea2 · WAI Anima — realism, anime, toon",
        # The floor: Krea2's int8 transformer (12GB) plus its Qwen encoder
        # (8.3GB) sit resident at ~21GB once Comfy's smart memory settles.
        "min_vram_gb": 24,
        "disk_gb": 80,
        "models": _IMAGE_MODELS,
        "needs_int8_fast": True,
        "expected": "Krea2 2.8s/gen @1024² · Anima ~1s/gen (steady, after warmup)",
        "reference_job": "1024² image",
        "lane_needles": ["krea2_turbo_convrot", "waianima"],
        "studio_pages": ["image"],
        # Civitai base-model families whose add-on LoRAs this tier's serving
        # set can actually load — the routing key for user-registered rental
        # LoRAs. Matched with the gateway's normalized-prefix family rule, so
        # "LTXV" accepts sidecars that say "LTXV 2.3".
        "lora_base_models": ["Krea 2", "Anima"],
    },
    # Both video tiers make sound. LTX 2.3 denoises a joint audio+video latent
    # exactly like H3 does, so the old "Video" vs "Video + audio" split was
    # simply wrong — and our own eros graph made the lie look true by decoding
    # the picture half and dropping the audio half on the floor (fixed
    # 2026-08-10). Name the tiers after their models and let family_detail
    # carry the real trade-off.
    "video": {
        "label": "Video · LTX 2.3 + eros v1.4 DMD",
        "family": "Video · LTX 2.3",
        "family_detail": "eros v1.4 DMD — 8 steps, joint video+audio, and the image models ride along",
        # The eros checkpoint alone is 27.2GB; below 32GB it spills to system
        # RAM mid-sample instead of running.
        "min_vram_gb": 32,
        "disk_gb": 160,
        "models": _IMAGE_MODELS + _VIDEO_MODELS,
        "needs_int8_fast": True,
        "expected": "eros+DMD ~16s per 4s clip @768×512, video+audio · images included",
        "reference_job": "4s clip @768×512, video + audio",
        # 'ltx23-eros' matches no graph content (server-side no-op) but lets
        # the UI's normalized matcher recognize the ltx23-eros-v14-comfy model id.
        "lane_needles": ["krea2_turbo_convrot", "waianima", "ltx2310eros", "ltx-2.3-22b", "ltx23-eros"],
        "studio_pages": ["image", "video"],
        "lora_base_models": ["Krea 2", "Anima", "LTXV"],
    },
    "minimax": {
        "label": "Video · MiniMax H3",
        "family": "Video · MiniMax H3",
        "family_detail": "Heavier and slower than LTX — stereo sound, and the one that takes scripted dialogue",
        # 21GB transformer + 15.7GB encoder. 32GB runs it (the box trades
        # encoder residency for reload time); 96GB holds both at once.
        "min_vram_gb": 32,
        # nvfp4 text encoder: Blackwell only, and specifically sm_120.
        "gpu_sm": {120},
        "disk_gb": 120,
        "models": _MINIMAX_MODELS,
        "needs_int8_fast": False,
        "needs_h3_stack": True,
        # Whole-job seconds for the reference clip on a warm 5090, as the graph
        # was tuned: 183s on 2026-08-07, 102s on 2026-08-08, 40s on 2026-08-10.
        # Quote the current one — the older figures survived in this string for
        # days after the graph had moved on, which is how a 5s clip came to
        # look three times slower than it runs.
        "expected": "5s 960×544 video+audio ~40s warm on a 5090 (Spectrum, 15 steps)",
        "reference_job": "5s clip @960×544, video + audio",
        "public_models": _MINIMAX_PUBLIC_FILES,
        "lane_needles": ["minimax_h3"],
        "studio_pages": ["video"],
        # Civitai's base-model category for H3 add-on LoRAs (style/character/
        # motion — distinct from the turbo LoRA baked into the serving set) is
        # exactly "MiniMax H3".
        "lora_base_models": ["MiniMax H3"],
    },
}


def tier_gpu_classes(tier: str) -> list[str]:
    """Classes that can run this workload at all, smallest card first.

    Capability only — this is the set, not the running order. The order the
    user sees is decided in rental_plan(), where the live prices are known;
    ordering here by any performance proxy is what once put the priciest and
    SLOWEST card at the head of the ladder."""
    spec = TIERS[tier]
    allowed = [
        key
        for key, gpu in GPU_CLASSES.items()
        if gpu["vram_gb"] >= spec["min_vram_gb"]
        and (gpu["sm"] in spec["gpu_sm"] if spec.get("gpu_sm") else True)
    ]
    return sorted(allowed, key=lambda key: (GPU_CLASSES[key]["vram_gb"], GPU_CLASSES[key]["dlperf"]))


def estimate_generation_seconds(tier: str, gpu_class: str) -> tuple[float, str]:
    """(seconds, basis) for this workload's reference job on this class.

    Scales the measured reference-class time by the benchmark ratio, which
    assumes the whole job scales with GPU throughput. Model loads, the mux and
    the network legs do not, so a faster class will land slightly slower than
    this says — hence `basis`, which the UI renders as measured vs estimated
    instead of quoting every number with the same confidence."""
    measured = RENTAL_BENCHMARKS.get((tier, gpu_class))
    if measured is not None:
        return round(measured, 1), "measured"
    anchor = RENTAL_BENCHMARKS.get((tier, REFERENCE_GPU_CLASS))
    if anchor is None:
        return 0.0, "unknown"
    ratio = GPU_CLASSES[REFERENCE_GPU_CLASS]["dlperf"] / GPU_CLASSES[gpu_class]["dlperf"]
    return round(anchor * ratio, 1), "estimated"

# Attach state: JSON registry + generated launcher overlay + tunnel pidfiles.
MEDIA_STATE_ROOT = Path(os.environ.get("HIVEMIND_MEDIA_STATE_DIR", str(Path.home() / ".hivemindos/media-studio")))
RENTAL_SSH_KEY = Path.home() / ".hivemindos/gpu-rentals-ssh/vast_ed25519"
STACK_LAUNCHER = Path.home() / ".local/bin/zimage-stack"
TUNNEL_BASE_PORT = 18300


class GpuRentalError(RuntimeError):
    """Raised for Vast/Cloudflare API failures and rental policy violations."""

    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def _env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise GpuRentalError(f"{name} is not configured in the environment", status_code=503)
    return value


# One pooled session for every Vast call. Each bare requests.request() opened a
# fresh TLS connection, and opening the Machines view makes three to five of
# them (instances, balance, a bundles search per tier) — on a high-latency link
# that handshake WAS the page load. urllib3's pool is thread-safe, which is what
# FastAPI's sync-route threadpool needs.
_vast_session = requests.Session()


def _vast_request(method: str, path: str, payload: dict | None = None) -> dict:
    response = _vast_session.request(
        method,
        f"{VAST_API_BASE}{path}",
        json=payload,
        headers={"Authorization": f"Bearer {_env('VAST_API_KEY')}"},
        timeout=_REQUEST_TIMEOUT,
    )
    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.status_code == 429 or body.get("error") == "HTTPTooManyRequests":
        # The relaxation loop plus every tier querying at once can burst past
        # Vast's limiter; it tells us how long to wait, then succeeds.
        time.sleep(float(body.get("retry_after") or 2))
        response = _vast_session.request(
            method,
            f"{VAST_API_BASE}{path}",
            json=payload,
            headers={"Authorization": f"Bearer {_env('VAST_API_KEY')}"},
            timeout=_REQUEST_TIMEOUT,
        )
        try:
            body = response.json()
        except ValueError:
            body = {}
    if response.status_code >= 400 or body.get("error"):
        detail = body.get("msg") or body.get("error") or response.text[:200]
        raise GpuRentalError(f"Vast API {method} {path} failed: {detail}", status_code=502)
    return body


# --- R2 presigning (SigV4 query auth, stdlib only) -------------------------
# Cloudflare API tokens double as R2 S3 credentials: access key id is the
# token's id, secret is the SHA-256 hex of the token value.

_s3_creds_cache: dict[str, str] = {}


def _r2_credentials() -> tuple[str, str, str]:
    token = _env("CLOUDFLARE_API_TOKEN")
    account = _env("CLOUDFLARE_ACCOUNT_ID")
    if "access_key" not in _s3_creds_cache:
        response = requests.get(
            f"{CLOUDFLARE_API_BASE}/accounts/{account}/tokens/verify",
            headers={"Authorization": f"Bearer {token}"},
            timeout=_REQUEST_TIMEOUT,
        )
        data = response.json() if response.content else {}
        token_id = (data.get("result") or {}).get("id") if data.get("success") else None
        if not token_id:
            raise GpuRentalError("could not verify the Cloudflare account token for R2 access", status_code=503)
        _s3_creds_cache["access_key"] = token_id
        _s3_creds_cache["secret"] = hashlib.sha256(token.encode()).hexdigest()
    return _s3_creds_cache["access_key"], _s3_creds_cache["secret"], account


def _presign_r2(method: str, object_key: str, *, now: datetime | None = None) -> str:
    access_key, secret, account = _r2_credentials()
    host = f"{account}.r2.cloudflarestorage.com"
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    date = stamp[:8]
    scope = f"{date}/auto/s3/aws4_request"
    path = "/" + quote(f"{R2_BUCKET}/{object_key}", safe="/")
    query = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{access_key}/{scope}",
        "X-Amz-Date": stamp,
        "X-Amz-Expires": str(PRESIGN_EXPIRE_SECONDS),
        "X-Amz-SignedHeaders": "host",
    }
    canonical_query = "&".join(f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in sorted(query.items()))
    canonical_request = "\n".join(
        [method, path, canonical_query, f"host:{host}\n", "host", "UNSIGNED-PAYLOAD"]
    )
    string_to_sign = "\n".join(
        ["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical_request.encode()).hexdigest()]
    )
    key = f"AWS4{secret}".encode()
    for part in (date, "auto", "s3", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    return f"https://{host}{path}?{canonical_query}&X-Amz-Signature={signature}"


def _presign_r2_get(object_key: str, *, now: datetime | None = None) -> str:
    return _presign_r2("GET", object_key, now=now)


# --- user LoRA registry for rentals -----------------------------------------
# Dev-mode "Use in rentals" on a studio LoRA card: the locally installed file
# is uploaded once to the private R2 bucket and recorded here, and provisioning
# appends it to the onstart download list of every tier whose serving set
# accepts the LoRA's base-model family. The registry lives next to
# rental-lanes.json so all rental state shares one root. Machines already
# running keep the serving set they provisioned with — this changes what the
# NEXT rental downloads, by design.
#
# Every entry carries an sfw/nsfw rating, asked at add time. Today that is
# categorization only; it exists so a later NSFW mode can hide "nsfw" entries
# by default without re-asking about every file.

RENTAL_LORA_R2_PREFIX = "user-loras/"
RENTAL_LORA_RATINGS = {"sfw", "nsfw"}
# Same default as the media-gateway (COMFY_DIR in packages/media-gateway/app.py)
# and the stack launcher, so all three agree on where installed LoRAs live.
COMFY_LORAS_ROOT = Path(os.environ.get("COMFY_DIR", str(Path.home() / "comfy/ComfyUI"))) / "models" / "loras"

_rental_lora_lock = threading.Lock()
# id -> {"done": bytes, "total": bytes} while an upload thread is running.
# In-memory on purpose: writing the registry file per chunk would thrash it.
_rental_lora_progress: dict[str, dict[str, int]] = {}


def _normalize_base(value: Any) -> str:
    """Mirror of the gateway's normalize_base (packages/media-gateway/app.py)."""
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _lora_base_matches(base: Any, families: list[str] | None) -> bool:
    """The gateway's lora_base_matches family rule: normalized prefix match in
    either direction, so "LTXV" accepts a sidecar that says "LTXV 2.3"."""
    cur = {_normalize_base(x) for x in (families or []) if _normalize_base(x)}
    b = _normalize_base(base)
    if not b or not cur:
        return False
    return b in cur or any(b.startswith(x) or x.startswith(b) for x in cur)


def tiers_for_lora_base(base_models: list[str] | None) -> list[str]:
    """Tiers whose serving set accepts any of these base-model families."""
    return [
        tier for tier, spec in TIERS.items()
        if any(_lora_base_matches(base, spec.get("lora_base_models")) for base in (base_models or []))
    ]


def _rental_lora_registry_path() -> Path:
    return MEDIA_STATE_ROOT / "rental-loras.json"


def read_rental_loras() -> dict[str, dict]:
    try:
        data = json.loads(_rental_lora_registry_path().read_text())
        loras = data.get("loras") if isinstance(data, dict) else None
        return loras if isinstance(loras, dict) else {}
    except Exception:
        return {}


def _write_rental_loras(entries: dict[str, dict]) -> None:
    MEDIA_STATE_ROOT.mkdir(parents=True, exist_ok=True)
    _rental_lora_registry_path().write_text(json.dumps({"version": 1, "loras": entries}, indent=1))


def _patch_rental_lora(lora_id: str, **fields: Any) -> dict | None:
    """Read-modify-write one entry under the lock — the upload thread and the
    API mutate the same file."""
    with _rental_lora_lock:
        entries = read_rental_loras()
        entry = entries.get(lora_id)
        if entry is None:
            return None
        entry.update(fields)
        _write_rental_loras(entries)
        return entry


def rental_loras_for_tier(tier: str) -> list[dict]:
    """Entries this tier must download: uploaded (ready) and family-matched."""
    return [
        entry for entry in read_rental_loras().values()
        if entry.get("status") == "ready" and tier in (entry.get("tiers") or [])
    ]


def _rental_lora_downloads(tier: str) -> list[tuple[str, str]]:
    """(R2 key, models/ subpath) per registered LoRA, preserving the LOCAL
    relative path on the box: the studios put installed-LoRA ids like
    "ltx/foo.safetensors" straight into the graph as lora_name, so the rented
    ComfyUI must resolve exactly the same name under models/loras."""
    out = []
    for entry in rental_loras_for_tier(tier):
        rel = str(entry.get("id") or "")
        subdir = "loras" if "/" not in rel else f"loras/{rel.rsplit('/', 1)[0]}"
        out.append((str(entry.get("r2_key") or f"{RENTAL_LORA_R2_PREFIX}{rel}"), subdir))
    return out


def _resolve_local_lora(lora_id: str) -> Path:
    """Absolute path for an installed-LoRA id — same traversal guard as the
    gateway's resolve_installed_lora_path."""
    root = COMFY_LORAS_ROOT.resolve()
    candidate = (root / str(lora_id or "")).resolve()
    if candidate == root or root not in candidate.parents:
        raise GpuRentalError("refusing to touch a LoRA outside the ComfyUI loras directory", status_code=400)
    if not candidate.is_file():
        raise GpuRentalError(f"no installed LoRA named '{lora_id}'", status_code=404)
    return candidate


def _sidecar_base_model(path: Path) -> str:
    """Base-model family from the Civitai sidecar; empty for hand-placed files."""
    try:
        data = json.loads(Path(str(path) + ".civitai.json").read_text())
        version = data.get("modelVersion") if isinstance(data.get("modelVersion"), dict) else data
        return str(version.get("baseModel") or "").strip()
    except Exception:
        return ""


def list_rental_loras() -> dict:
    entries = sorted(read_rental_loras().values(), key=lambda e: str(e.get("added_at") or ""))
    for entry in entries:
        progress = _rental_lora_progress.get(str(entry.get("id") or ""))
        if progress and entry.get("status") == "uploading":
            entry["uploaded_bytes"] = int(progress.get("done") or 0)
    return {"loras": entries}


def add_rental_lora(
    lora_id: str,
    rating: str,
    base_model: str = "",
    display_name: str = "",
    context_base_models: list[str] | None = None,
) -> dict:
    """Register an installed LoRA for rental provisioning.

    The R2 upload runs in the background; the entry only joins a tier's
    download list once it lands (status "ready"). Re-adding is how a rating is
    changed and how a failed upload is retried — a file already uploaded at the
    same size just gets its metadata refreshed, no second transfer."""
    rating = str(rating or "").strip().lower()
    if rating not in RENTAL_LORA_RATINGS:
        raise GpuRentalError("rating must be 'sfw' or 'nsfw'", status_code=400)
    # The id lands inside a double-quoted bash word in the onstart script, so
    # refuse anything the shell or curl could reinterpret. Spaces are fine.
    if re.search(r'["\'$`\\\n\r\x00-\x1f?#&%]', str(lora_id or "")):
        raise GpuRentalError("LoRA filename has characters the provisioning script cannot carry", status_code=400)
    path = _resolve_local_lora(lora_id)
    base = str(base_model or "").strip() or _sidecar_base_model(path)
    if _normalize_base(base) == _normalize_base("Unknown/local"):
        base = ""
    tiers = tiers_for_lora_base([base] if base else [])
    if not tiers:
        # Hand-placed file with no sidecar: fall back to the base families the
        # LoRA panel was scoped to when the user clicked.
        tiers = tiers_for_lora_base(context_base_models)
    if not tiers:
        raise GpuRentalError(
            f"no rental tier serves LoRAs for base model '{base or 'unknown'}'",
            status_code=400,
        )
    size_bytes = path.stat().st_size
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _rental_lora_lock:
        entries = read_rental_loras()
        existing = entries.get(lora_id)
        if existing and existing.get("status") == "uploading":
            raise GpuRentalError("this LoRA is already uploading", status_code=409)
        already_uploaded = bool(
            existing
            and existing.get("status") == "ready"
            and int(existing.get("size_bytes") or 0) == size_bytes
        )
        entry = {
            "id": lora_id,
            "filename": path.name,
            "displayName": str(display_name or "").strip() or path.stem,
            "baseModel": base,
            "rating": rating,
            "tiers": tiers,
            "r2_key": f"{RENTAL_LORA_R2_PREFIX}{lora_id}",
            "size_bytes": size_bytes,
            "size_gb": round(size_bytes / 1e9, 3),
            "added_at": str((existing or {}).get("added_at") or now),
            "status": "ready" if already_uploaded else "uploading",
            "error": "",
        }
        entries[lora_id] = entry
        _write_rental_loras(entries)
    if not already_uploaded:
        _rental_lora_progress[lora_id] = {"done": 0, "total": size_bytes}
        _start_rental_lora_upload(lora_id, path, entry["r2_key"])
    return entry


def remove_rental_lora(lora_id: str) -> dict:
    with _rental_lora_lock:
        entries = read_rental_loras()
        entry = entries.pop(lora_id, None)
        if entry is None:
            raise GpuRentalError(f"'{lora_id}' is not registered for rentals", status_code=404)
        _write_rental_loras(entries)
    # Bucket hygiene, not correctness: a stale object costs pennies and a
    # re-add with the same id simply overwrites it.
    with contextlib.suppress(Exception):
        requests.delete(_presign_r2("DELETE", str(entry.get("r2_key") or "")), timeout=_REQUEST_TIMEOUT)
    return {"removed": lora_id}


class _FileWithProgress:
    """File wrapper requests can stream. __len__ keeps the transfer a plain
    Content-Length PUT (R2 rejects chunked bodies on presigned PUTs), and each
    read updates the progress the LoRA panel polls."""

    def __init__(self, fh: Any, size: int, lora_id: str) -> None:
        self._fh = fh
        self._size = size
        self._id = lora_id

    def __len__(self) -> int:
        return self._size

    def read(self, amount: int = -1) -> bytes:
        chunk = self._fh.read(amount)
        if chunk:
            progress = _rental_lora_progress.get(self._id)
            if progress is not None:
                progress["done"] += len(chunk)
        return chunk


def _upload_rental_lora(lora_id: str, path: Path, r2_key: str) -> None:
    try:
        url = _presign_r2("PUT", r2_key)
        with path.open("rb") as fh:
            response = requests.put(
                url,
                data=_FileWithProgress(fh, path.stat().st_size, lora_id),
                timeout=(30, 300),
            )
        if response.status_code >= 400:
            raise GpuRentalError(f"R2 upload failed: HTTP {response.status_code} {response.text[:120]}")
        _patch_rental_lora(lora_id, status="ready", error="")
    except Exception as exc:  # presign 503s and requests errors: same surface
        _patch_rental_lora(lora_id, status="error", error=str(exc))
    finally:
        _rental_lora_progress.pop(lora_id, None)


def _start_rental_lora_upload(lora_id: str, path: Path, r2_key: str) -> None:
    threading.Thread(
        target=_upload_rental_lora,
        args=(lora_id, path, r2_key),
        name=f"rental-lora-upload-{path.name}",
        daemon=True,
    ).start()


# --- provisioning ----------------------------------------------------------

PRIVACY_NODE_SOURCE = (
    Path(__file__).resolve().parents[2]
    / "packages/gpu-rentals/provisioning/hivemind_privacy.py"
)
_PRIVACY_HEREDOC = "HIVEMIND_PRIVACY_EOF"


def _privacy_node_install_lines() -> list[str]:
    """Install the hivemind_privacy node on every rented box.

    Without it the box is a stock ComfyUI: /history and /queue serve the prompt
    graph in plaintext while a job runs, and there is no way to delete the
    output and the staged reference image after harvest — measured 2026-08-07,
    every remote job recorded files_scrubbed=false and left customer media on
    the instance until teardown. The gateway's whole remote-lane contract
    (packages/media-gateway/app.py) assumes this route exists, so provisioning
    verifies it answers before declaring the box ready rather than discovering
    it is absent at scrub time, one generation too late."""
    # Vast caps the whole onstart at VAST_ONSTART_LIMIT and the presigned model
    # URLs already eat ~600 chars each, so the node ships gzipped: 9KB of source
    # inline blew the video tier past the cap by 3.6KB and Vast rejected the
    # rental with a generic "Invalid args" 400. Compressed it costs ~2.5KB and
    # stays self-contained — no fetch that could fail or expire on a restart.
    body = PRIVACY_NODE_SOURCE.read_text(encoding="utf-8")
    packed = base64.b64encode(gzip.compress(body.encode("utf-8"), mtime=0)).decode("ascii")
    target = "/workspace/ComfyUI/custom_nodes/hivemind_privacy/__init__.py"
    return [
        "mkdir -p /workspace/ComfyUI/custom_nodes/hivemind_privacy",
        f"printf '%s' '{packed}' | base64 -d | gzip -d > {target}",
        # A truncated or mangled node means no prompt redaction and no scrub
        # route; better to fail provisioning than to serve without them.
        f"python3 -c \"import ast,sys;ast.parse(open('{target}').read())\" || "
        "{ beacon error 0 \"privacy node failed to unpack\"; exit 1; }",
        "export COMFY_PRIVATE_HISTORY_PROMPTS=1",
    ]


RENTAL_SSH_PUBKEY = RENTAL_SSH_KEY.with_suffix(".pub")


def rental_public_key() -> str:
    """The rental key's PUBLIC half, for the box to authorize itself.

    Derived from the private key when the .pub file is absent, so a half-copied
    key directory cannot silently cost a rental."""
    if RENTAL_SSH_PUBKEY.is_file():
        text = RENTAL_SSH_PUBKEY.read_text(encoding="utf-8").strip()
        if text.startswith("ssh-"):
            return text
    if not RENTAL_SSH_KEY.is_file():
        raise GpuRentalError(f"rental SSH key missing at {RENTAL_SSH_KEY}", status_code=503)
    try:
        derived = subprocess.run(
            ["ssh-keygen", "-y", "-f", str(RENTAL_SSH_KEY)],
            capture_output=True, text=True, timeout=15, check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError) as exc:
        raise GpuRentalError(f"cannot derive the rental public key: {exc}", status_code=503) from None
    if not derived.startswith("ssh-"):
        raise GpuRentalError("cannot derive the rental public key", status_code=503)
    return derived


def _authorize_rental_key_lines() -> list[str]:
    """Make the box's authorized_keys usable, first thing.

    ROOT CAUSE, 2026-08-08, confirmed by reading the box's own filesystem: Vast
    writes /root/.ssh/authorized_keys from the HOST, and on some hosts it lands
    owned by the host account (observed `vastai_kaalia:docker`) instead of root.
    OpenSSH runs StrictModes=yes by default and silently ignores an
    authorized_keys the login user does not own, so sshd rejected every attempt
    with 'Permission denied (publickey)' while our key sat in that very file.
    The rental was unreachable and unfixable: ComfyUI binds to loopback, only
    the beacon port is published, and Vast's command API is read-only on
    running instances.

    chown is the fix — it makes the file sshd's to read no matter who wrote it.
    Appending our key too costs nothing and covers the separate case where a
    key genuinely was not propagated. Both are idempotent: onstart re-runs on
    every instance start."""
    pubkey = rental_public_key()
    if "'" in pubkey or "\n" in pubkey:
        raise GpuRentalError("rental public key has unexpected characters", status_code=503)
    return [
        "mkdir -p /root/.ssh",
        f"grep -qxF '{pubkey}' /root/.ssh/authorized_keys 2>/dev/null || "
        f"echo '{pubkey}' >> /root/.ssh/authorized_keys",
        # StrictModes: wrong owner is as good as no key at all.
        "chown -R root:root /root/.ssh",
        "chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys",
    ]


def _onstart_script(tier: str) -> str:
    spec = TIERS[tier]
    # The tier's curated serving set plus every user LoRA registered for it —
    # same presigned-GET delivery, same beacon accounting, same atomic .dl→mv.
    models = list(spec["models"]) + _rental_lora_downloads(tier)
    total = len(models) + len(spec.get("public_models") or [])
    lines = [
        "#!/bin/bash",
        "exec > /root/hivemind-provision.log 2>&1",
        "set -u",
        # Before anything slow: a box we cannot reach is a box we cannot use,
        # and every second of provisioning is billed.
        *_authorize_rental_key_lines(),
        "mkdir -p /root/beacon",
        # beacon <step> <done> <detail> — atomically publishes progress.json.
        "beacon() { printf '{\"step\":\"%s\",\"done\":%s,\"total\":"
        + str(total)
        + ",\"detail\":\"%s\",\"ts\":%s}' \"$1\" \"$2\" \"$3\" \"$(date +%s)\""
        " > /root/beacon/progress.json.tmp && mv /root/beacon/progress.json.tmp /root/beacon/progress.json; }",
        'beacon booting 0 "Host accepted, preparing environment"',
        f"(cd /root/beacon && nohup python3 -m http.server {BEACON_PORT} --bind 0.0.0.0 >/dev/null 2>&1 &)",
        'beacon installing 0 "Installing the ComfyUI stack"',
        "mkdir -p /workspace/ComfyUI",
        "rsync -a /opt/workspace-internal/ComfyUI/ /workspace/ComfyUI/",
        "M=/workspace/ComfyUI/models",
        'EXTRA_ARGS=""',
        *_privacy_node_install_lines(),
    ]
    if spec["needs_int8_fast"]:
        lines.append(
            "git clone -q --depth 1 https://github.com/BobJohnson24/ComfyUI-INT8-Fast "
            "/workspace/ComfyUI/custom_nodes/ComfyUI-INT8-Fast || true"
        )
    if spec.get("needs_h3_stack"):
        lines += [
            # Smart-memory retention holds the H3 TE (15.7G) + DiT (21G) in
            # system RAM at once; a 31GB box thrashes to death mid-sample
            # (2026-08-04). Under 48GB, trade TE reload time for residency.
            "if (( $(awk '/MemTotal/{printf \"%d\", $2/1048576}' /proc/meminfo) < 48 ));"
            ' then EXTRA_ARGS="$EXTRA_ARGS --disable-smart-memory"; fi',
            f"if ! git -C /workspace/ComfyUI merge-base --is-ancestor {_H3_COMFY_COMMIT} HEAD 2>/dev/null; then",
            "  git -C /workspace/ComfyUI fetch -q --depth 200 origin master",
            f"  git -C /workspace/ComfyUI checkout -q {_H3_COMFY_COMMIT}",
            "  /venv/main/bin/pip install -q -r /workspace/ComfyUI/requirements.txt",
            "fi",
            # pin <dir> <sha> — check out the exact commit the graph was tuned
            # against. A shallow clone lands on HEAD, so fetch the sha by name
            # (GitHub serves any reachable one) and fail loudly if it is gone:
            # silently sampling on an unpinned node build is how this broke.
            "pin() { git -C \"$1\" fetch -q --depth 1 origin \"$2\" && "
            "git -C \"$1\" checkout -q \"$2\" || "
            "{ beacon error 0 \"custom node pin $2 unavailable\"; exit 1; }; }",
            "git clone -q --depth 1 https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3 "
            "/workspace/ComfyUI/custom_nodes/ComfyUI-Spectrum-MiniMax-H3 || true",
            "pin /workspace/ComfyUI/custom_nodes/ComfyUI-Spectrum-MiniMax-H3 "
            f"{_H3_SPECTRUM_COMMIT}",
            # The registered minimax-h3 graph patches SageAttention via KJNodes
            # (~1.8x measured on H3 sampling).
            "git clone -q --depth 1 https://github.com/kijai/ComfyUI-KJNodes "
            "/workspace/ComfyUI/custom_nodes/comfyui-kjnodes || true",
            f"pin /workspace/ComfyUI/custom_nodes/comfyui-kjnodes {_H3_KJNODES_COMMIT}",
            # The turbo LoRA cannot be applied by ComfyUI's plain loader: this
            # node re-injects the time conditioning our PRUNED base lacks, and
            # ships the silu(t_emb) grid it needs.
            "git clone -q --depth 1 https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo "
            "/workspace/ComfyUI/custom_nodes/ComfyUI-MiniMax-H3-Turbo || true",
            f"pin /workspace/ComfyUI/custom_nodes/ComfyUI-MiniMax-H3-Turbo {_H3_TURBO_NODE_COMMIT}",
            # Scene chaining: the studio's chained graphs graft this node pack in.
            "git clone -q --depth 1 https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context "
            "/workspace/ComfyUI/custom_nodes/ComfyUI-H3-Motion-Context || true",
            f"pin /workspace/ComfyUI/custom_nodes/ComfyUI-H3-Motion-Context {_H3_MOTION_CONTEXT_COMMIT}",
            "[ -f /workspace/ComfyUI/custom_nodes/comfyui-kjnodes/requirements.txt ] && "
            "/venv/main/bin/pip install -q -r /workspace/ComfyUI/custom_nodes/comfyui-kjnodes/requirements.txt",
            "/venv/main/bin/pip install -q sageattention",
        ]
    files = []
    lines.append('beacon downloading 0 "Starting model downloads"')
    for object_key, subdir in models:
        filename = object_key.rsplit("/", 1)[-1]
        url = _presign_r2_get(object_key)
        files.append(f'"$M/{subdir}/{filename}"')
        lines.append(f'mkdir -p "$M/{subdir}"')
        # Atomic .dl → mv so a partial download is never counted as a
        # complete model (by the beacon counter, or by a rerun's [ -s ]).
        # -C - resumes the .dl partial across curl's own retries.
        lines.append(
            f'[ -s "$M/{subdir}/{filename}" ] || {{ curl -sf -C - --retry 8 --retry-delay 5 '
            f'--speed-limit {DOWNLOAD_MIN_BYTES_PER_SEC} --speed-time {DOWNLOAD_STALL_SECONDS} '
            f'-o "$M/{subdir}/{filename}.dl" "{url}" '
            f'&& mv "$M/{subdir}/{filename}.dl" "$M/{subdir}/{filename}"; }} &'
        )
    # Public upstream weights (no presigning, no R2 round trip) pulled the same
    # atomic way and counted in the same beacon total.
    for url, subdir, filename, _size_gb in spec.get("public_models") or []:
        files.append(f'"$M/{subdir}/{filename}"')
        lines.append(f'mkdir -p "$M/{subdir}"')
        lines.append(
            f'[ -s "$M/{subdir}/{filename}" ] || {{ curl -sfL -C - --retry 8 --retry-delay 5 '
            f'--speed-limit {DOWNLOAD_MIN_BYTES_PER_SEC} --speed-time {DOWNLOAD_STALL_SECONDS} '
            f'-o "$M/{subdir}/{filename}.dl" "{url}" '
            f'&& mv "$M/{subdir}/{filename}.dl" "$M/{subdir}/{filename}"; }} &'
        )
    lines += [
        f"FILES=({' '.join(files)})",
        f"DL_DEADLINE=$(( $(date +%s) + {DOWNLOAD_DEADLINE_SECONDS} ))",
        # One exit for both ways a download can end badly. Says "destroy it"
        # because there is no repair path: the presigned URLs expire, and a
        # half-provisioned box that launches ComfyUI anyway just fails later,
        # at generate time, where the cause is far harder to see.
        f'dlfail() {{ beacon error "$DONE" "download $1 at $DONE/{total}: $CURRENT'
        ' — destroy this machine and rent another"; exit 1; }',
        "while true; do",
        '  DONE=0; CURRENT=""',
        '  for f in "${FILES[@]}"; do',
        '    if [ -s "$f" ]; then DONE=$((DONE+1)); else [ -z "$CURRENT" ] && CURRENT=$(basename "$f"); fi',
        "  done",
        '  beacon downloading "$DONE" "$CURRENT"',
        f'  [ "$DONE" -eq {total} ] && break',
        # Failure escape: when every download job has exited but files are
        # still missing, report the error through the beacon instead of
        # spinning forever (a curl that exhausts retries would otherwise
        # leave the machine stuck at N/total).
        '  if [ -z "$(jobs -r)" ]; then dlfail "failed"; fi',
        # A job that is still RUNNING can be just as stuck as one that died:
        # curl only gives up when a transfer drops under the speed floor, and
        # a connection can hang without ever tripping it. Bound the wait so a
        # machine that will never finish stops billing at a known cost.
        f'  if [ "$(date +%s)" -ge "$DL_DEADLINE" ]; then dlfail "stalled {DOWNLOAD_DEADLINE_SECONDS // 60}min"; fi',
        "  sleep 5",
        "done",
        "wait",
        f'beacon starting-comfy {total} "Launching ComfyUI"',
        ". /venv/main/bin/activate",
        "cd /workspace/ComfyUI",
        # Stock memory flags on purpose: --highvram OOMs the convrot loader
        # (tuning sweep 2026-07-31). Bound to localhost — reach it over SSH.
        "nohup python main.py --disable-auto-launch --disable-metadata $EXTRA_ARGS "
        "--port 18188 --listen 127.0.0.1 > /root/comfyui.log 2>&1 &",
        "until curl -sf localhost:18188/system_stats >/dev/null; do sleep 2; done",
        # The privacy layer is a precondition, not a nice-to-have: if its scrub
        # route did not register, this box cannot delete customer media after a
        # generation, so it must never be handed out as ready.
        "if ! curl -sf -X POST -H 'Content-Type: application/json' -d '{\"files\":[]}' "
        "localhost:18188/hivemind/scrub-files >/dev/null; then",
        f'  beacon error {total} "privacy layer failed to load — refusing to serve"',
        "  exit 1",
        "fi",
        f'beacon ready {total} "ComfyUI is up"',
        'echo "hivemind studio provisioning complete"',
    ]
    script = "\n".join(lines) + "\n"
    # Vast rejects an oversized onstart with a generic
    # "Invalid args: len(image) > 1024, or len(args) > 16384, or len(label) > 256",
    # which says nothing about which one or by how much. Anything added to
    # provisioning competes with ~600 chars per presigned model URL, so measure
    # here and name the overflow instead of shipping a 400 to the user.
    if len(script) > VAST_ONSTART_LIMIT:
        raise GpuRentalError(
            f"provisioning script for tier '{tier}' is {len(script)} chars, "
            f"{len(script) - VAST_ONSTART_LIMIT} over Vast's {VAST_ONSTART_LIMIT} limit",
            status_code=500,
        )
    return script


def tier_download_gb(tier: str) -> float:
    """Total bytes a fresh box must pull for this tier (unknown files ~2GB)."""
    spec = TIERS[tier]
    total = sum(MODEL_SIZE_GB.get(key, 2.0) for key, _ in spec["models"])
    total += sum(size for _url, _sub, _name, size in spec.get("public_models") or [])
    # Registered user LoRAs count too: they shape the bandwidth floor exactly
    # like the curated set does.
    total += sum(float(entry.get("size_gb") or 2.0) for entry in rental_loras_for_tier(tier))
    return round(total, 1)


def tier_min_down_mbps(tier: str) -> int:
    """Link speed needed to fetch this tier inside TARGET_DOWNLOAD_SECONDS."""
    return int(tier_download_gb(tier) * 8 * 1000 / TARGET_DOWNLOAD_SECONDS)


def _gpu_names_for(tier: str, gpu_class: str | None) -> list[str]:
    classes = [gpu_class] if gpu_class else tier_gpu_classes(tier)
    return [name for key in classes for name in GPU_CLASSES[key]["gpu_names"]]


def gpu_class_for_name(gpu_name: str) -> str | None:
    for key, gpu in GPU_CLASSES.items():
        if gpu_name in gpu["gpu_names"]:
            return key
    return None


# Vast sells more than one SKU under a single gpu_name. "RTX PRO 6000 WS"
# covers both the 600W workstation card and the 300W Max-Q, and Vast's own
# benchmark rates the Max-Q at HALF the class median (142.9 against 281.8 —
# measured on rental 47390575, 2026-08-10, nvidia-smi confirming a 300W cap
# against the 5090's 575W). Since _rank_offers sorts by price and the Max-Q is
# the cheapest PRO 6000 on the market, the TOP rung of the performance slider
# reliably handed out a card that generated slower than the 5090 rung beneath
# it, at 2.3x the hourly price: 47.9s per reference clip against 40.0s.
# Ordinary host-to-host spread inside one class is much tighter (the 5090
# offers we drew ranged 160-199, i.e. 0.81 of median at worst), so this
# threshold separates a different SKU from a merely unlucky host.
UNDERPOWERED_DLPERF_RATIO = 0.7


def _underpowered(offer: dict) -> bool:
    """True when a host's own benchmark is far below its class median."""
    key = gpu_class_for_name(str(offer.get("gpu_name") or ""))
    if key is None:
        return False
    dlperf = float(offer.get("dlperf") or 0)
    # Unbenchmarked hosts are not evidence of anything; leave them to price
    # ranking rather than hiding offers for a missing field.
    if dlperf <= 0:
        return False
    return dlperf < GPU_CLASSES[key]["dlperf"] * UNDERPOWERED_DLPERF_RATIO


def _offer_query(tier: str, min_down_mbps: int | None = None, gpu_class: str | None = None) -> dict:
    spec = TIERS[tier]
    names = _gpu_names_for(tier, gpu_class)
    return {
        "verified": {"eq": True},
        "rentable": {"eq": True},
        "datacenter": {"eq": True},
        # One query covers the whole ladder: three per-class queries per tier
        # would triple the calls behind a view that already polls, and Vast
        # rate-limits. Results are grouped by class afterwards.
        "gpu_name": {"eq": names[0]} if len(names) == 1 else {"in": names},
        "num_gpus": {"eq": 1},
        "reliability2": {"gt": 0.99},
        "inet_down": {"gt": tier_min_down_mbps(tier) if min_down_mbps is None else min_down_mbps},
        "disk_space": {"gt": spec["disk_gb"]},
        "type": "on-demand",
        "order": [["dph_total", "asc"]],
        # Price-ordered and truncated, so this has to exceed the whole
        # qualifying market or the priciest rung reads as sold out when it is
        # merely past the cut. Measured 2026-08-08: 49 verified datacenter
        # single-GPU offers across every card we list.
        "limit": 60,
    }


def _offer_dto(offer: dict) -> dict:
    return {
        "offer_id": offer.get("id"),
        "gpu": offer.get("gpu_name"),
        "gpu_class": gpu_class_for_name(str(offer.get("gpu_name") or "")),
        "vram_mb": offer.get("gpu_ram"),
        # This host's own benchmark, not the class median — the two diverge by
        # 2x across SKUs sold under one gpu_name, so the offer has to carry it.
        "dlperf": round(float(offer["dlperf"]), 1) if offer.get("dlperf") else None,
        "usd_per_hour": round(float(offer.get("dph_total") or 0), 4),
        "down_mbps": offer.get("inet_down"),
        "reliability": offer.get("reliability2"),
        "geolocation": offer.get("geolocation"),
    }


def _fetch_beacon(url: str) -> dict | None:
    """Best-effort read of the box's provisioning beacon; None while unreachable."""
    try:
        response = requests.get(url, timeout=1.5)
        data = response.json()
        return data if isinstance(data, dict) and data.get("step") else None
    except Exception:
        return None


def _mapped_port(instance: dict, container_port: int) -> str | None:
    entries = (instance.get("ports") or {}).get(f"{container_port}/tcp") or [{}]
    return entries[0].get("HostPort")


def _ssh_endpoint(instance: dict) -> tuple[str, str] | None:
    """SSH endpoint for the instance: direct 22/tcp mapping when the host
    publishes one, else Vast's SSH proxy (ssh_host/ssh_port) — API-created
    instances usually only get the proxy, and -L tunneling works over both."""
    direct_port = _mapped_port(instance, 22)
    ip = instance.get("public_ipaddr")
    if direct_port and ip:
        return ip, str(direct_port)
    host, port = instance.get("ssh_host"), instance.get("ssh_port")
    if host and port:
        return str(host), str(port)
    return None


def _instance_dto(instance: dict, probe: bool = False) -> dict:
    label = instance.get("label") or ""
    managed = label.startswith(STUDIO_LABEL_PREFIX)
    endpoint = _ssh_endpoint(instance)
    ip = instance.get("public_ipaddr")
    actual = instance.get("actual_status")

    # Truthful lifecycle phase. Vast reports intended_status="running" from the
    # moment a contract exists — never surface that as a machine state.
    provision = None
    stopped = str(instance.get("cur_state") or "").lower() in {"stopped", "exited"} or actual in {"exited", "stopped"}
    if stopped:
        # Disk (and every downloaded model) survives; resume skips the pull.
        phase = "paused"
    elif actual in (None, "", "created", "loading"):
        phase = "booting"
    elif actual == "running" and managed:
        beacon_port = _mapped_port(instance, BEACON_PORT)
        beacon = _fetch_beacon(f"http://{ip}:{beacon_port}/progress.json") if (probe and ip and beacon_port) else None
        if beacon:
            step = beacon.get("step")
            phase = "ready" if step == "ready" else "error" if step == "error" else "provisioning"
            provision = {
                "step": beacon.get("step"),
                "done": beacon.get("done"),
                "total": beacon.get("total"),
                "detail": beacon.get("detail") or "",
            }
        else:
            phase = "provisioning"
            provision = {"step": "booting", "done": 0, "total": None,
                         "detail": "Container up, waiting for the provisioning beacon"}
    elif actual == "running":
        phase = "running"
    else:
        phase = actual or "unknown"

    attachment = _read_attachments().get(str(instance.get("id"))) if managed else None
    tier = _tier_from_label(label) if managed else None
    gpu_class = (
        _gpu_class_from_label(label) or gpu_class_for_name(str(instance.get("gpu_name") or ""))
        if managed
        else None
    )
    seconds, basis = (
        estimate_generation_seconds(tier, gpu_class) if tier and gpu_class else (None, None)
    )
    return {
        "rental_id": instance.get("id"),
        "label": label,
        "managed": managed,
        "tier": tier,
        "tier_label": TIERS[tier]["label"] if tier else None,
        "gpu_class": gpu_class,
        "reference_job": TIERS[tier]["reference_job"] if tier else None,
        "seconds_per_generation": seconds,
        "estimate_basis": basis,
        "status": actual or instance.get("intended_status") or "unknown",
        "phase": phase,
        "provision": provision,
        "attached": bool(attachment),
        # Higher wins when several attached machines serve the same models —
        # the studios' machine picker writes this.
        "priority": (attachment or {}).get("priority", 0),
        "pending_reattach": bool(_read_paused_state().get(str(instance.get("id")), {}).get("pending_reattach")),
        "tunnel_alive": bool(attachment and _tunnel_pid(instance.get("id"))),
        "models_served": (attachment or {}).get("needles")
        or TIERS.get(_tier_from_label(label), {}).get("lane_needles", []),
        "studio_pages": (attachment or {}).get("studio_pages")
        or TIERS.get(_tier_from_label(label), {}).get("studio_pages", []),
        "gpu": instance.get("gpu_name"),
        "usd_per_hour": round(float(instance.get("dph_total") or 0), 4),
        # What a paused box costs: Vast keeps billing the disk only.
        "paused_usd_per_hour": round(float(instance.get("storage_total_cost") or 0), 4),
        "disk_gb": instance.get("disk_space"),
        "started_at": instance.get("start_date"),
        "uptime_hours": round(max(0.0, (time.time() - instance["start_date"]) / 3600), 2)
        if instance.get("start_date")
        else None,
        "ssh_command": f"ssh -p {endpoint[1]} root@{endpoint[0]} -L 18188:localhost:18188"
        if endpoint
        else None,
        "comfy_url": "http://localhost:18188 (after the SSH tunnel connects)" if endpoint else None,
    }


# --- public operations ------------------------------------------------------

_offer_cache: dict[str, tuple[float, list[dict], int]] = {}
OFFER_CACHE_SECONDS = 45


def _search_offers(tier: str, prefer: str = "balanced", gpu_class: str | None = None) -> tuple[list[dict], int]:
    """Offers for a tier, across its whole GPU ladder unless one is named.

    prefer="balanced" (default) requires a link fast enough to fetch the tier
    in ~3 minutes, then takes the cheapest host clearing that bar.
    prefer="cheapest" drops the bar: the cheapest GPUs are on slow links, so
    the box costs about half as much per hour but takes several times longer
    to provision. Which is actually cheaper depends on session length —
    provisioning is billed, so a fast host wins for short sessions and a cheap
    host wins for long ones. That is a user call, not a default we can pick.
    """
    key = f"{tier}:{prefer}:{gpu_class or 'ladder'}"
    cached = _offer_cache.get(key)
    if cached and time.time() - cached[0] < OFFER_CACHE_SECONDS:
        return cached[1], cached[2]
    floor = 500 if prefer == "cheapest" else tier_min_down_mbps(tier)
    for candidate_floor in (floor, floor // 2, 500):
        body = _vast_request("POST", "/v0/bundles/", _offer_query(tier, candidate_floor, gpu_class))
        offers = body.get("offers") or []
        if offers:
            _offer_cache[key] = (time.time(), offers, candidate_floor)
            return offers, candidate_floor
    return [], 500


def _rank_offers(tier: str, offers: list[dict], limit: int = 8) -> list[dict]:
    download_gb = tier_download_gb(tier)
    dtos = []
    for offer in offers:
        # Drop half-power SKUs before price ranking, which would otherwise
        # prefer them precisely because they are cheap. See _underpowered.
        if _underpowered(offer):
            continue
        dto = _offer_dto(offer)
        down = float(offer.get("inet_down") or 0)
        # What the user actually waits for: the model pull on THIS host.
        dto["setup_minutes"] = round(download_gb * 8 * 1000 / down / 60, 1) if down else None
        dtos.append(dto)
    # The FLOOR already guarantees every candidate starts fast enough, so
    # rank by price inside that set. Ranking by time first paid 38% more
    # ($0.921 vs $0.669) to save ~55s — the floor is the speed guarantee,
    # price is what is left to optimize.
    dtos.sort(key=lambda d: (d["usd_per_hour"], d["setup_minutes"] or 99))
    return dtos[:limit]


def list_offers(tier: str, prefer: str = "balanced", gpu_class: str | None = None) -> dict:
    if tier not in TIERS:
        raise GpuRentalError(f"unknown tier: {tier}", status_code=400)
    if gpu_class is not None and gpu_class not in tier_gpu_classes(tier):
        raise GpuRentalError(
            f"{GPU_CLASSES.get(gpu_class, {}).get('label', gpu_class)} cannot run the "
            f"{TIERS[tier]['label']} workload",
            status_code=400,
        )
    offers, floor = _search_offers(tier, prefer, gpu_class)
    return {
        "tier": tier,
        "tier_label": TIERS[tier]["label"],
        "expected": TIERS[tier]["expected"],
        "download_gb": tier_download_gb(tier),
        "min_down_mbps": floor,
        "prefer": prefer,
        "gpu_class": gpu_class,
        "offers": _rank_offers(tier, offers),
    }


def rental_plan(tier: str, prefer: str = "balanced") -> dict:
    """The whole ladder for one workload: every class it can run on, what a
    machine of that class costs right now, and how long a generation takes.

    One Vast query serves all of it, so the configurator can re-price the
    slider without a request per stop."""
    if tier not in TIERS:
        raise GpuRentalError(f"unknown tier: {tier}", status_code=400)
    spec = TIERS[tier]
    offers, floor = _search_offers(tier, prefer)
    classes = tier_gpu_classes(tier)
    grouped: dict[str, list[dict]] = {key: [] for key in classes}
    for offer in offers:
        key = gpu_class_for_name(str(offer.get("gpu_name") or ""))
        if key in grouped:
            grouped[key].append(offer)

    rungs = []
    for key in classes:
        gpu = GPU_CLASSES[key]
        ranked = _rank_offers(tier, grouped[key], limit=5)
        cheapest = ranked[0] if ranked else None
        seconds, basis = estimate_generation_seconds(tier, key)
        price = cheapest["usd_per_hour"] if cheapest else None
        rungs.append({
            "gpu_class": key,
            "label": gpu["label"],
            "vram_gb": gpu["vram_gb"],
            "note": gpu["note"],
            "usd_per_hour": price,
            "available": len(ranked),
            "setup_minutes": cheapest["setup_minutes"] if cheapest else None,
            "seconds_per_generation": seconds,
            "estimate_basis": basis,
            # The number that actually decides which rung is worth it: a
            # faster card that costs more per hour can still be cheaper per
            # clip, and a cheaper card is often not.
            "usd_per_generation": round(seconds * price / 3600, 4) if price and seconds else None,
            "offers": ranked,
        })

    # CHEAPEST FIRST, always. The rungs differ on three axes that do not agree
    # with each other — hourly price, seconds per generation, VRAM — so there
    # is no single "up". Price is the one the user is actually spending, and an
    # unpriced (sold out) rung sorts last because it cannot be picked at all.
    rungs.sort(key=lambda r: (r["usd_per_hour"] is None, r["usd_per_hour"] or 0.0))

    # Flags rather than an order, so the UI can say what each rung IS instead
    # of implying it by position. Only rungs you can actually rent compete.
    pickable = [r for r in rungs if r["available"] and r["usd_per_hour"]]
    fastest = min((r for r in pickable if r["seconds_per_generation"]),
                  key=lambda r: r["seconds_per_generation"], default=None)
    cheapest_per_gen = min((r for r in pickable if r["usd_per_generation"]),
                           key=lambda r: r["usd_per_generation"], default=None)
    for rung in rungs:
        rung["cheapest"] = bool(pickable) and rung is pickable[0]
        rung["fastest"] = rung is fastest
        rung["best_value"] = rung is cheapest_per_gen
        # The trap this whole ladder exists to expose: paying MORE per hour and
        # getting no more speed. True for the PRO 6000 on MiniMax H3, measured.
        rung["costs_more_no_faster"] = bool(
            rung["seconds_per_generation"] and rung["usd_per_hour"] and any(
                other["usd_per_hour"] and other["usd_per_hour"] < rung["usd_per_hour"]
                and other["seconds_per_generation"]
                and other["seconds_per_generation"] <= rung["seconds_per_generation"]
                for other in pickable
            )
        )
    return {
        "tier": tier,
        "tier_label": spec["label"],
        "family": spec["family"],
        "family_detail": spec["family_detail"],
        "reference_job": spec["reference_job"],
        "expected": spec["expected"],
        "download_gb": tier_download_gb(tier),
        "min_down_mbps": floor,
        "min_vram_gb": spec["min_vram_gb"],
        "prefer": prefer,
        # The smallest card that fits. `classes` is capability-ordered; the
        # rungs below are price-ordered, so this is not simply rungs[0].
        "floor_class": classes[0],
        "reference_class": REFERENCE_GPU_CLASS,
        "studio_pages": spec["studio_pages"],
        "classes": rungs,
    }


_balance_cache: dict[str, Any] = {"at": 0.0, "value": None}
BALANCE_CACHE_SECONDS = 30
# A machine we cannot fund for this long is a machine that dies mid-session:
# Vast stops instances once the balance runs past its threshold.
MIN_FUNDED_HOURS = 1.0
# Ceiling on one rent request. Not a technical limit — a guard on a stepper
# that spends real money per click.
MAX_BATCH_MACHINES = 8


def account_balance() -> dict:
    """Vast credit, and what the machines already running are burning.

    Foreign instances count: the hosted billing gateway rents on this same
    account, so its burn is real money this account no longer has."""
    if _balance_cache["value"] is not None and time.time() - _balance_cache["at"] < BALANCE_CACHE_SECONDS:
        return _balance_cache["value"]
    # v0 only — /v1/users/current/ 404s (Vast's migration is per-endpoint).
    body = _vast_request("GET", "/v0/users/current/")
    value = {"credit": round(float(body.get("credit") or 0.0), 4)}
    _balance_cache.update(at=time.time(), value=value)
    return value


def _running_burn(instances: list[dict]) -> float:
    return round(sum(
        float(i.get("dph_total") or 0)
        for i in instances
        if str(i.get("cur_state") or "").lower() not in {"stopped", "exited"}
    ), 4)


def account_state() -> dict:
    """Credit, current burn, and how long the credit lasts at that burn."""
    body = _vast_request("GET", "/v1/instances/")
    instances = body.get("instances") or []
    credit = account_balance()["credit"]
    burn = _running_burn(instances)
    return {
        "credit": credit,
        "usd_per_hour_running": burn,
        "hours_remaining": round(credit / burn, 1) if burn > 0 else None,
        "machines_running": sum(
            1 for i in instances if str(i.get("cur_state") or "").lower() not in {"stopped", "exited"}
        ),
    }


def list_rentals() -> dict:
    body = _vast_request("GET", "/v1/instances/")
    instances = [_instance_dto(i, probe=True) for i in (body.get("instances") or [])]
    raw = body.get("instances") or []
    # Free: the DTOs are already in hand, so the box that failed provisioning
    # goes away on the same poll that noticed it rather than billing until
    # someone reads the screen.
    reaped = {entry["rental_id"] for entry in reap_failed_rentals(instances)
              if not entry.get("destroy_error")}
    if reaped:
        instances = [dto for dto in instances if dto["rental_id"] not in reaped]
        raw = [i for i in raw if i.get("id") not in reaped]
    burn = _running_burn(raw)
    # Never let a balance hiccup take down the machine list — it is the view
    # that tells the user what they are paying for.
    try:
        credit = account_balance()["credit"]
    except GpuRentalError:
        credit = None
    # Tier keys ride along so the Machines view discovers tiers instead of
    # hardcoding them (minimax was invisible for exactly that reason).
    return {
        "rentals": instances,
        "tiers": list(TIERS),
        # Machines that failed provisioning and were destroyed. Without this the
        # box would just vanish from the list and the user would be left with a
        # smaller balance and no account of where it went.
        "failures": recent_rental_failures(),
        "account": {
            "credit": credit,
            "usd_per_hour_running": burn,
            "hours_remaining": round(credit / burn, 1) if credit is not None and burn > 0 else None,
        },
    }


def _assert_affordable(count: int, usd_per_hour: float) -> None:
    """Refuse rentals the credit cannot fund for an hour.

    Vast stops an instance once the balance crosses its threshold, so renting
    past the credit does not fail loudly — it produces a box that provisions
    (billed) and then dies partway through the session. Checked against the
    burn ALREADY running, including the billing gateway's own instances,
    because they draw on the same balance."""
    try:
        state = account_state()
    except GpuRentalError:
        return  # Never block a rental because the balance call itself failed.
    needed = round((state["usd_per_hour_running"] + usd_per_hour * count) * MIN_FUNDED_HOURS, 2)
    if state["credit"] >= needed:
        return
    running = state["machines_running"]
    raise GpuRentalError(
        f"${state['credit']:.2f} credit is not enough to run "
        f"{count} more machine{'s' if count > 1 else ''} at ${usd_per_hour:.3f}/hr"
        + (f" alongside the {running} already running" if running else "")
        + f" — {MIN_FUNDED_HOURS:.0f}h needs ${needed:.2f}. Add credit at vast.ai or rent fewer.",
        status_code=402,
    )


def create_rental(
    tier: str,
    offer_id: int | None = None,
    prefer: str = "balanced",
    gpu_class: str | None = None,
    count: int = 1,
) -> dict:
    if tier not in TIERS:
        raise GpuRentalError(f"unknown tier: {tier}", status_code=400)
    ladder = tier_gpu_classes(tier)
    if gpu_class is None:
        gpu_class = REFERENCE_GPU_CLASS if REFERENCE_GPU_CLASS in ladder else ladder[0]
    if gpu_class not in ladder:
        raise GpuRentalError(
            f"{GPU_CLASSES.get(gpu_class, {}).get('label', gpu_class)} cannot run the "
            f"{TIERS[tier]['label']} workload (needs {TIERS[tier]['min_vram_gb']}GB+"
            + (" Blackwell" if TIERS[tier].get("gpu_sm") == {120} else "")
            + ")",
            status_code=400,
        )
    count = max(1, min(int(count), MAX_BATCH_MACHINES))
    # Renting a box we could never log into bills by the hour for nothing, so
    # prove the key exists BEFORE the money starts (the onstart below embeds it).
    rental_public_key()

    # Always search, even when the caller pinned an offer. Vast asks go stale
    # within SECONDS, so a UI-supplied offer_id is by definition older than the
    # click that sent it — the search is what stocks the fallbacks (and, for a
    # batch, the other machines' slots). The pin is still tried FIRST below:
    # it is a preference, not a constraint, because failing outright because
    # one ask evaporated is a dead end, not safety.
    ranked = _rank_offers(tier, _search_offers(tier, prefer, gpu_class)[0],
                          limit=max(8, count * 3))
    preferred = [int(offer_id)] if offer_id is not None else []
    fresh = [o["offer_id"] for o in ranked if o.get("offer_id") not in preferred]
    if not preferred and not fresh:
        raise GpuRentalError("no offers currently match the tier filters", status_code=409)
    # Cheapest quote in the qualifying set. Absent only when the caller pinned
    # an offer the search no longer returns, in which case there is no price to
    # check against and the pin is tried on trust.
    quote = next((o["usd_per_hour"] for o in ranked), None)
    if quote is not None:
        _assert_affordable(count, quote)

    onstart = _onstart_script(tier)

    def _ask_evaporated(exc: GpuRentalError) -> bool:
        text = str(exc)
        return "no_such_ask" in text or "not available" in text

    state: dict[str, Any] = {"tried": 0, "last_error": None}
    # One offer per machine: a Vast ask is a slot, so renting the same one
    # twice in a batch is how you ask for N machines and get one.
    remaining = preferred + fresh
    created: list[dict] = []

    for _ in range(count):
        rented = None
        while remaining and rented is None:
            candidate = remaining.pop(0)
            label = f"{STUDIO_LABEL_PREFIX}{tier}-{gpu_class}-{uuid.uuid4().hex[:8]}"
            state["tried"] += 1
            try:
                body = _vast_request("PUT", f"/v0/asks/{candidate}/", {
                    "client_id": "me",
                    "image": COMFY_IMAGE,
                    "disk": TIERS[tier]["disk_gb"],
                    "label": label,
                    "onstart": onstart,
                    "runtype": "ssh",
                    # Publish only the beacon port; ComfyUI stays on loopback.
                    "env": {f"-p {BEACON_PORT}:{BEACON_PORT}": "1"},
                })
            except GpuRentalError as exc:
                if not _ask_evaporated(exc):
                    if created:
                        break  # Machines are already billing; report, don't raise.
                    raise
                state["last_error"] = exc
                continue
            rented = {"rental_id": body.get("new_contract"), "label": label,
                      "tier": tier, "gpu_class": gpu_class, "offer_id": candidate}
            created.append(rented)
        if rented is None:
            break

    if not created:
        raise GpuRentalError(
            f"all {state['tried']} candidate offers were taken before we could rent them — "
            "the market moved; try again",
            status_code=409,
        ) from state["last_error"]

    # Single-machine callers keep the flat shape they have always had.
    result = dict(created[0])
    result["rentals"] = created
    result["requested"] = count
    if len(created) < count:
        result["partial"] = (
            f"rented {len(created)} of {count} — the rest of the matching offers were "
            "taken while the batch was going out"
        )
    return result


# --- attach: route studio generations to a rented box -----------------------
# Attach = SSH tunnel (Mac local port -> box loopback :18188) + a lanes overlay
# the stack launcher folds into COMFY_LANES/COMFY_LANE_RULES/COMFY_REMOTE_LANES
# at gateway start. The tunnel is spawned detached (survives stack restarts);
# the media-gateway restart to pick up lanes is scheduled detached too.


def _attach_registry_path() -> Path:
    return MEDIA_STATE_ROOT / "rental-lanes.json"


def _overlay_env_path() -> Path:
    return MEDIA_STATE_ROOT / "rental-lanes.env"


def _tunnel_dir() -> Path:
    return MEDIA_STATE_ROOT / "rental-tunnels"


def _read_attachments() -> dict[str, dict]:
    try:
        return json.loads(_attach_registry_path().read_text())
    except Exception:
        return {}


def _write_attachments(attachments: dict[str, dict]) -> None:
    MEDIA_STATE_ROOT.mkdir(parents=True, exist_ok=True)
    # Highest priority first, everywhere. Lane rules are FIRST-MATCH in the
    # gateway, so when two attached machines both serve (say) MiniMax H3, this
    # order is the whole mechanism behind "run it on that one".
    ordered = dict(sorted(
        attachments.items(),
        key=lambda kv: (-(kv[1].get("priority") or 0), kv[0]),
    ))
    attachments = ordered
    _attach_registry_path().write_text(json.dumps(attachments, indent=1))
    lanes = ",".join(f"{a['lane']}=http://127.0.0.1:{a['local_port']}" for a in attachments.values())
    rules = ";".join(f"{a['lane']}={','.join(a['needles'])}" for a in attachments.values())
    remotes = ",".join(a["lane"] for a in attachments.values())
    _overlay_env_path().write_text(
        "# Generated by gpu_rentals attach — do not edit; sourced by the stack launcher.\n"
        f'RENTAL_COMFY_LANES="{lanes}"\n'
        f'RENTAL_COMFY_LANE_RULES="{rules}"\n'
        f'RENTAL_COMFY_REMOTE_LANES="{remotes}"\n'
    )


def _tunnel_pid(rental_id: int) -> int | None:
    try:
        pid = int((_tunnel_dir() / f"{rental_id}.pid").read_text().strip())
        os.kill(pid, 0)
        return pid
    except Exception:
        return None


def _spawn_tunnel(rental_id: int, ip: str, ssh_port: str, local_port: int) -> int:
    if not RENTAL_SSH_KEY.exists():
        raise GpuRentalError(f"rental SSH key missing at {RENTAL_SSH_KEY}", status_code=503)
    _tunnel_dir().mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        ["ssh", "-N",
         "-o", "ExitOnForwardFailure=yes",
         "-o", "StrictHostKeyChecking=accept-new",
         "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4",
         "-i", str(RENTAL_SSH_KEY), "-p", str(ssh_port), f"root@{ip}",
         "-L", f"{local_port}:localhost:18188"],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=(_tunnel_dir() / f"{rental_id}.log").open("ab"),
    )
    (_tunnel_dir() / f"{rental_id}.pid").write_text(str(proc.pid))
    _await_tunnel(rental_id, proc, local_port)
    return proc.pid


def _await_tunnel(rental_id: int, proc: subprocess.Popen, local_port: int, timeout: float = 20.0) -> None:
    """Fail the attach if the tunnel never carries traffic.

    ssh forks, so Popen succeeding says nothing: a rejected key exits a moment
    later and leaves an attachment pointing at a port nobody listens on. That
    happened for real (Vast's proxy refused an account key it had accepted an
    hour earlier on another host), and the studio reported the machine attached
    while every generation had nowhere to go. Wait for the forward, and hand
    back ssh's own last words when it dies."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            reason = _tunnel_failure_reason(rental_id)
            _kill_tunnel(rental_id)
            raise GpuRentalError(
                f"SSH tunnel to the machine failed: {reason}", status_code=502
            )
        with contextlib.suppress(OSError):
            with socket.create_connection(("127.0.0.1", local_port), timeout=1):
                return
        time.sleep(0.5)
    _kill_tunnel(rental_id)
    raise GpuRentalError(
        f"SSH tunnel to the machine did not come up within {int(timeout)}s "
        f"({_tunnel_failure_reason(rental_id)})",
        status_code=504,
    )


def _tunnel_failure_reason(rental_id: int) -> str:
    """ssh's last stderr line, which is where the actual cause lives."""
    try:
        lines = [
            line.strip()
            for line in (_tunnel_dir() / f"{rental_id}.log").read_text(errors="replace").splitlines()
            if line.strip() and not line.startswith("Warning: Permanently added")
        ]
    except OSError:
        return "no output from ssh"
    for line in reversed(lines):
        if "Permission denied" in line:
            return (
                f"{line} — the box's /root/.ssh/authorized_keys is unreadable by sshd "
                "(StrictModes rejects a file the login user does not own). Boxes "
                "provisioned since 2026-08-08 fix their own ownership at startup; an "
                "older one has to be destroyed and re-rented"
            )
        if "Welcome to vast.ai" in line or "Have fun" in line:
            continue
        return line
    return "no output from ssh"


def _kill_tunnel(rental_id: int) -> None:
    pid = _tunnel_pid(rental_id)
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    for suffix in ("pid", "log"):
        try:
            (_tunnel_dir() / f"{rental_id}.{suffix}").unlink()
        except OSError:
            pass


def _schedule_stack_restart() -> None:
    """Restart the stack out-of-band, after the caller's response has landed.

    The restart kills the control API that is answering the very request which
    asked for it, so the delay is not cosmetic: at 1s a destroy still had a
    Vast DELETE to make, and the browser got 'Failed to fetch' for an operation
    that had actually succeeded. Schedule this LAST in any handler, and leave
    enough room for the response to flush."""
    subprocess.Popen(
        ["/bin/bash", "-c", f"sleep 3; exec {STACK_LAUNCHER} restart"],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _tier_from_label(label: str) -> str:
    remainder = label[len(STUDIO_LABEL_PREFIX):] if label.startswith(STUDIO_LABEL_PREFIX) else ""
    tier = remainder.split("-", 1)[0]
    return tier if tier in TIERS else "image"


def _gpu_class_from_label(label: str) -> str | None:
    """Machines rented before the ladder existed carry no class in their label
    (`…-image-abc123`); their GPU name identifies them instead."""
    remainder = label[len(STUDIO_LABEL_PREFIX):] if label.startswith(STUDIO_LABEL_PREFIX) else ""
    parts = remainder.split("-")
    return parts[1] if len(parts) > 1 and parts[1] in GPU_CLASSES else None


def attach_rental(rental_id: int, *, select: bool = False) -> dict:
    body = _vast_request("GET", "/v1/instances/")
    match = next((i for i in body.get("instances") or [] if i.get("id") == rental_id), None)
    if match is None:
        raise GpuRentalError(f"instance {rental_id} not found on the account", status_code=404)
    dto = _instance_dto(match, probe=True)
    if not dto["managed"]:
        raise GpuRentalError("only studio-managed machines can be attached", status_code=409)
    if dto["phase"] != "ready":
        raise GpuRentalError(f"machine is not ready yet (phase: {dto['phase']})", status_code=409)
    endpoint = _ssh_endpoint(match)
    if endpoint is None:
        raise GpuRentalError("instance has no SSH endpoint yet", status_code=409)
    ip, ssh_port = endpoint

    tier = _tier_from_label(dto["label"])
    local_port = TUNNEL_BASE_PORT + (rental_id % 500)
    if _tunnel_pid(rental_id) is None:
        _spawn_tunnel(rental_id, ip, ssh_port, local_port)
    attachments = _read_attachments()
    existing = attachments.get(str(rental_id)) or {}
    # Selecting puts this machine ahead of every other attachment; a plain
    # attach keeps whatever standing it already had (re-attaching a machine
    # after a dropped tunnel must not silently steal routing from the one the
    # user picked), and a first attach lands at the back.
    if select:
        priority = max((a.get("priority") or 0) for a in attachments.values()) + 1 if attachments else 1
    else:
        priority = existing.get("priority") or 0
    attachments[str(rental_id)] = {
        "lane": f"rental{rental_id}",
        "local_port": local_port,
        "needles": TIERS[tier]["lane_needles"],
        "tier": tier,
        "studio_pages": TIERS[tier]["studio_pages"],
        "attached_at": existing.get("attached_at") or time.time(),
        "priority": priority,
    }
    _write_attachments(attachments)
    paused = _read_paused_state()
    if paused.pop(str(rental_id), None) is not None:
        _write_paused_state(paused)
    # No restart: the gateway re-reads this registry per request (see
    # refresh_comfy_lanes in packages/media-gateway/app.py), so the lane is live
    # as soon as the file lands. Restarting to add a routing rule killed
    # in-flight generations and made "use this machine" a 30-second event.
    return {"rental_id": rental_id, "attached": True, "lane": f"rental{rental_id}",
            "restarting_stack": False, "studio_pages": TIERS[tier]["studio_pages"],
            "priority": priority}


def select_rental(rental_id: int) -> dict:
    """Make this the machine that runs generations for the models it serves.

    Attaching several machines is legitimate — different workloads, different
    lanes — but two that serve the SAME models are a race the user has to be
    able to settle. This is that settlement: attach if needed, then move to
    the front of the first-match lane rules."""
    return attach_rental(rental_id, select=True)


def detach_rental(rental_id: int, *, restart: bool = False) -> dict:
    """Drop the tunnel and the lane. The gateway notices on its next request.

    `restart` stays as an escape hatch for an operator who has changed the env
    overlay itself (that IS launcher-sourced), but nothing in the normal attach
    or destroy path uses it any more."""
    _kill_tunnel(rental_id)
    attachments = _read_attachments()
    removed = attachments.pop(str(rental_id), None)
    _write_attachments(attachments)
    if removed and restart:
        _schedule_stack_restart()
    return {"rental_id": rental_id, "attached": False, "restarting_stack": bool(removed and restart)}


def _managed_instance(rental_id: int) -> dict:
    body = _vast_request("GET", "/v1/instances/")
    match = next((i for i in body.get("instances") or [] if i.get("id") == rental_id), None)
    if match is None:
        raise GpuRentalError(f"instance {rental_id} not found on the account", status_code=404)
    if not str(match.get("label") or "").startswith(STUDIO_LABEL_PREFIX):
        raise GpuRentalError(
            f"instance {rental_id} is not managed by the studio — refusing", status_code=409)
    return match


# A box whose provisioning failed will never serve a generation, but Vast bills
# it exactly like one that works — from creation until it is destroyed, and
# there is no refund anywhere in this path. Left alone it burns money forever,
# and the Machines view has to be OPEN for anyone to notice, so the reaper runs
# on a timer too. The grace window exists so the failure is not destroyed the
# instant it appears; the reason is recorded before the box goes away, because
# after that there is nothing left to ask.
PROVISION_FAILURE_GRACE_SECONDS = int(os.environ.get("HIVEMIND_RENTAL_REAP_GRACE", "60"))
# Escape hatch for exactly the case that produced this code: an operator who
# wants to SSH into a box that failed provisioning and recover it by hand.
RENTAL_AUTOREAP = os.environ.get("HIVEMIND_RENTAL_AUTOREAP", "1") != "0"
FAILURE_LOG_LIMIT = 20


def _failure_state_path() -> Path:
    return MEDIA_STATE_ROOT / "rental-failures.json"


def _read_failure_state() -> dict:
    try:
        state = json.loads(_failure_state_path().read_text())
    except Exception:
        state = {}
    state.setdefault("seen", {})
    state.setdefault("log", [])
    return state


def _write_failure_state(state: dict) -> None:
    MEDIA_STATE_ROOT.mkdir(parents=True, exist_ok=True)
    state["log"] = state.get("log", [])[-FAILURE_LOG_LIMIT:]
    _failure_state_path().write_text(json.dumps(state, indent=1))


def reap_failed_rentals(instances: list[dict]) -> list[dict]:
    """Destroy managed boxes stuck in a terminal provisioning error.

    Takes DTOs the caller has already fetched so the polling path costs no
    extra Vast call. Returns the failures recorded this pass. Never raises:
    a machine list must not break because one destroy did.
    """
    state = _read_failure_state()
    seen: dict[str, float] = state["seen"]
    now = time.time()
    failed = {
        str(dto["rental_id"]): dto for dto in instances
        if dto.get("managed") and dto.get("phase") == "error"
    }
    # Anything that recovered, or that someone destroyed by hand, stops counting.
    for rental_id in list(seen):
        if rental_id not in failed:
            seen.pop(rental_id, None)

    recorded = []
    for rental_id, dto in failed.items():
        first_seen = seen.setdefault(rental_id, now)
        if not RENTAL_AUTOREAP or now - first_seen < PROVISION_FAILURE_GRACE_SECONDS:
            continue
        provision = dto.get("provision") or {}
        hours = dto.get("uptime_hours") or 0.0
        rate = dto.get("usd_per_hour") or 0.0
        entry = {
            "rental_id": dto["rental_id"],
            "label": dto.get("label"),
            "tier": dto.get("tier"),
            "gpu_class": dto.get("gpu_class"),
            "gpu": dto.get("gpu"),
            # The beacon's own words — the only account of what went wrong that
            # outlives the machine.
            "reason": provision.get("detail") or "provisioning failed",
            "progress": (f"{provision.get('done')}/{provision.get('total')}"
                         if provision.get("total") else None),
            "uptime_hours": round(hours, 3),
            "usd_per_hour": rate,
            # What the failure cost. Vast prorates by the second and refunds
            # nothing, so this is the number the user actually paid to learn
            # that this host was bad.
            "usd_spent": round(hours * rate, 4),
            "destroyed_at": now,
        }
        try:
            destroy_rental(dto["rental_id"])
        except Exception as exc:  # noqa: BLE001 - a failed reap must not break the list
            entry["destroy_error"] = str(exc)[:200]
        else:
            seen.pop(rental_id, None)
        state["log"].append(entry)
        recorded.append(entry)

    _write_failure_state(state)
    return recorded


def recent_rental_failures(within_seconds: float = 6 * 3600) -> list[dict]:
    """Failures still worth showing — the machine they describe is gone."""
    cutoff = time.time() - within_seconds
    return [e for e in _read_failure_state()["log"] if (e.get("destroyed_at") or 0) >= cutoff]


def pause_rental(rental_id: int) -> dict:
    """Stop the box but KEEP its disk: models stay downloaded, so resuming
    skips the whole model pull. Vast bills storage only while stopped.

    Attachment is torn down first (a tunnel to a stopped box is a dead lane)
    but remembered, so resume can restore studio routing automatically.
    """
    _managed_instance(rental_id)
    was_attached = str(rental_id) in _read_attachments()
    detach_rental(rental_id, restart=was_attached)
    _vast_request("PUT", f"/v0/instances/{rental_id}/", {"state": "stopped"})
    paused = _read_paused_state()
    paused[str(rental_id)] = {"was_attached": was_attached, "paused_at": time.time()}
    _write_paused_state(paused)
    return {"rental_id": rental_id, "paused": True, "was_attached": was_attached}


def resume_rental(rental_id: int) -> dict:
    """Start a paused box. Vast re-runs onstart, which is idempotent: the
    model downloads all skip (files present), so it goes straight to
    launching ComfyUI. Routing is restored if it was attached when paused.
    """
    _managed_instance(rental_id)
    _vast_request("PUT", f"/v0/instances/{rental_id}/", {"state": "running"})
    paused = _read_paused_state()
    entry = paused.pop(str(rental_id), {})
    if entry.get("was_attached"):
        # Cleared by attach_rental once the tunnel is actually back up; the
        # Machines view watches this and re-attaches when the box reports ready.
        paused[str(rental_id)] = {"pending_reattach": True}
    _write_paused_state(paused)
    return {"rental_id": rental_id, "resuming": True,
            "will_reattach": bool(entry.get("was_attached"))}


def _paused_state_path() -> Path:
    return MEDIA_STATE_ROOT / "rental-paused.json"


def _read_paused_state() -> dict:
    try:
        return json.loads(_paused_state_path().read_text())
    except Exception:
        return {}


def _write_paused_state(state: dict) -> None:
    MEDIA_STATE_ROOT.mkdir(parents=True, exist_ok=True)
    _paused_state_path().write_text(json.dumps(state, indent=1))


def destroy_rental(rental_id: int) -> dict:
    body = _vast_request("GET", "/v1/instances/")
    match = next((i for i in body.get("instances") or [] if i.get("id") == rental_id), None)
    if match is None:
        raise GpuRentalError(f"instance {rental_id} not found on the account", status_code=404)
    label = match.get("label") or ""
    if not label.startswith(STUDIO_LABEL_PREFIX):
        raise GpuRentalError(
            f"instance {rental_id} ({label or 'no label'}) is not managed by the studio — refusing to destroy",
            status_code=409,
        )
    # Never leave routing pointed at a dead box: tear down any attachment
    # (tunnel + overlay entry) before the instance goes away. No stack restart
    # is involved any more — the gateway re-reads the attachment registry per
    # request, so the lane is gone the moment this returns.
    detach_rental(rental_id)
    _vast_request("DELETE", f"/v0/instances/{rental_id}/")
    return {"rental_id": rental_id, "destroyed": True, "restarting_stack": False}


# How often the reaper sweeps when nobody has the Machines view open. Long,
# because it costs a Vast call and the money at stake is bounded by the
# provisioning deadline; the polling path already reaps within seconds while
# anyone is watching. Backs off further when the account has no studio boxes.
REAPER_INTERVAL_SECONDS = 180
REAPER_IDLE_INTERVAL_SECONDS = 900


def _reaper_loop() -> None:
    delay = REAPER_INTERVAL_SECONDS
    while True:
        time.sleep(delay)
        try:
            body = _vast_request("GET", "/v1/instances/")
            raw = body.get("instances") or []
            managed = [i for i in raw if str(i.get("label") or "").startswith(STUDIO_LABEL_PREFIX)]
            # Probe the beacon only for studio boxes: the phase this turns on
            # is the whole reason for the sweep.
            for entry in reap_failed_rentals([_instance_dto(i, probe=True) for i in managed]):
                print(f"[gpu-rentals] destroyed failed rental {entry['rental_id']} "
                      f"(${entry['usd_spent']:.2f} spent): {entry['reason']}", flush=True)
            delay = REAPER_INTERVAL_SECONDS if managed else REAPER_IDLE_INTERVAL_SECONDS
        except Exception:
            # A Vast hiccup must not kill the sweeper for the process lifetime.
            delay = REAPER_INTERVAL_SECONDS


def register_gpu_rental_routes(app, require_owner) -> None:
    """Attach the owner-gated rental routes to the control API app."""
    from fastapi import Body, Depends, HTTPException

    def _guard(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except GpuRentalError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    @app.on_event("startup")
    def _start_rental_reaper() -> None:
        # Warm the Vast connection off the request path. The first call in a
        # fresh process pays DNS + TLS to console.vast.ai — measured at ~7s
        # against a ~0.2s median once the pool is established — and the user
        # who eats it is whoever opens Machines first after a stack restart,
        # staring at a view that looks broken. Also primes the balance cache.
        def _warm() -> None:
            try:
                account_balance()
            except Exception:
                pass  # no key, no network: the real request will report it

        threading.Thread(target=_warm, name="gpu-rental-warm", daemon=True).start()
        if not RENTAL_AUTOREAP:
            return
        threading.Thread(target=_reaper_loop, name="gpu-rental-reaper", daemon=True).start()

    @app.get("/api/gpu-rentals/offers", dependencies=[Depends(require_owner)])
    def gpu_rental_offers(tier: str = "image", prefer: str = "balanced",
                          gpu_class: str | None = None) -> dict:
        return _guard(list_offers, tier, prefer, gpu_class)

    @app.get("/api/gpu-rentals/plan", dependencies=[Depends(require_owner)])
    def gpu_rental_plan(tier: str = "image", prefer: str = "balanced") -> dict:
        return _guard(rental_plan, tier, prefer)

    @app.get("/api/gpu-rentals/account", dependencies=[Depends(require_owner)])
    def gpu_rental_account() -> dict:
        return _guard(account_state)

    @app.get("/api/gpu-rentals", dependencies=[Depends(require_owner)])
    def gpu_rentals_index() -> dict:
        return _guard(list_rentals)

    # The rental-LoRA routes come before the {rental_id} ones: Starlette
    # matches in registration order, and a literal "loras" segment must never
    # be parsed as a rental id.
    @app.get("/api/gpu-rentals/loras", dependencies=[Depends(require_owner)])
    def gpu_rental_loras_index() -> dict:
        return _guard(list_rental_loras)

    @app.post("/api/gpu-rentals/loras", status_code=201, dependencies=[Depends(require_owner)])
    def gpu_rental_loras_add(payload: dict = Body(default={})) -> dict:
        context = payload.get("contextBaseModels")
        return _guard(
            add_rental_lora,
            str(payload.get("id") or ""),
            str(payload.get("rating") or ""),
            str(payload.get("baseModel") or ""),
            str(payload.get("displayName") or ""),
            [str(value) for value in context] if isinstance(context, list) else None,
        )

    # :path — installed-LoRA ids keep their models/loras subdirectories.
    @app.delete("/api/gpu-rentals/loras/{lora_id:path}", dependencies=[Depends(require_owner)])
    def gpu_rental_loras_remove(lora_id: str) -> dict:
        return _guard(remove_rental_lora, lora_id)

    @app.post("/api/gpu-rentals", status_code=201, dependencies=[Depends(require_owner)])
    def gpu_rentals_create(payload: dict = Body(default={})) -> dict:
        tier = str(payload.get("tier") or "image")
        offer_id = payload.get("offer_id")
        prefer = str(payload.get("prefer") or "balanced")
        gpu_class = payload.get("gpu_class") or None
        count = payload.get("count") or 1
        return _guard(
            create_rental,
            tier,
            int(offer_id) if offer_id is not None else None,
            prefer,
            str(gpu_class) if gpu_class else None,
            int(count),
        )

    @app.delete("/api/gpu-rentals/{rental_id}", dependencies=[Depends(require_owner)])
    def gpu_rentals_destroy(rental_id: int) -> dict:
        return _guard(destroy_rental, rental_id)

    @app.post("/api/gpu-rentals/{rental_id}/pause", dependencies=[Depends(require_owner)])
    def gpu_rentals_pause(rental_id: int) -> dict:
        return _guard(pause_rental, rental_id)

    @app.post("/api/gpu-rentals/{rental_id}/resume", dependencies=[Depends(require_owner)])
    def gpu_rentals_resume(rental_id: int) -> dict:
        return _guard(resume_rental, rental_id)

    @app.post("/api/gpu-rentals/{rental_id}/attach", dependencies=[Depends(require_owner)])
    def gpu_rentals_attach(rental_id: int) -> dict:
        return _guard(attach_rental, rental_id)

    @app.delete("/api/gpu-rentals/{rental_id}/attach", dependencies=[Depends(require_owner)])
    def gpu_rentals_detach(rental_id: int) -> dict:
        return _guard(detach_rental, rental_id)

    @app.post("/api/gpu-rentals/{rental_id}/select", dependencies=[Depends(require_owner)])
    def gpu_rentals_select(rental_id: int) -> dict:
        return _guard(select_rental, rental_id)
