"""Owner-gated GPU rentals: provision studio ComfyUI boxes on rented hardware.

Drives the owner's own marketplace accounts directly (VAST_API_KEY,
RUNPOD_API_KEY from the shared hive env) — distinct from the hosted customer
billing gateway, which meters credits server-side. Tier presets, offer filters,
the provisioning bootstrap, and the model set all mirror the CUDA validation
runs recorded in packages/gpu-rentals/ (2026-07-31): verified RTX 5090 boxes,
weights pulled from the private R2 bucket via short-lived presigned URLs.

WHERE the box comes from lives in rental_providers/; this module owns what runs
on it. The division is not cosmetic — the offer filters here encode measured
failures (a container too small to hold the weights has its ComfyUI killed
mid-job, a half-power SKU sold under a full-power name generates slower for
more money), so they rank every marketplace's offers rather than each
marketplace ranking its own.

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
import math
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests

from . import rental_providers
from .rental_providers import (
    Instance,
    LaunchSpec,
    Offer,
    OfferQuery,
    ProviderError,
    RentalRef,
)
# Importing these registers them; the registry order is the order the Machines
# view shops in, so Vast (where every benchmark was measured) comes first.
from .rental_providers import vast as _vast_provider  # noqa: F401
from .rental_providers import runpod as _runpod_provider  # noqa: F401
# The hosted transport: with a HivemindOS account connected, every provider
# call above goes through the worker and this machine holds no marketplace
# key at all. Read at call time, never cached — see rental_providers/gateway.
from .rental_providers import gateway as rental_gateway

CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"
R2_BUCKET = "hivemind-rental-models"
STUDIO_LABEL_PREFIX = "hivemind-studio-gpur-"
COMFY_IMAGE = "vastai/comfy:@vastai-automatic-tag"
# The same image, pinned. `@vastai-automatic-tag` is Vast's own placeholder —
# it resolves a CUDA build against the host's driver at launch and means
# nothing to any other registry client, so RunPod needs a concrete tag.
#
# The layout our provisioning script depends on is portable and was verified
# from the published image config on 2026-08-14: a conda venv at /venv/main and
# ComfyUI cloned under /opt. What is NOT portable is the entrypoint
# (/opt/instance-tools/bin/entrypoint.sh, Vast's own bootstrap), which is why
# the RunPod provider replaces it — see rental_providers/runpod.bootstrap_command.
#
# cuda-13.2, and this is now MEASURED rather than assumed. It used to be
# cuda-12.9 (torch cu128) on the reasoning that it was the lower driver
# requirement and that the faster build was an open question. It is not an open
# question: comfy/quant_ops.py disables comfy-kitchen's CUDA backend outright
# below CUDA 13 —
#     if tuple(map(int, str(torch.version.cuda).split('.'))) < (13,):
#         ck.registry.disable("cuda")
# — which drops int8_linear, dequantize_int8_convrot_weight, scaled_mm_nvfp4
# and sol_attn, so this tier's int8_convrot DiT, nvfp4 text encoder and
# int8_convrot video VAE every one of them fall back to dequantize-then-compute.
#
# Measured 2026-09-18 on ONE rented 5090 (vast:51438645) with the confound
# removed — same box, same seeds, same graph, warm, only torch swapped — for a
# 5s 960x544 H3 clip end to end:
#
#     torch 2.10.0+cu128   int8 VAE 123.5s   fp16 VAE 113.0s
#     torch 2.14.0+cu130   int8 VAE  48.4s   fp16 VAE  48.5s
#
# ~2.3x on every H3 render. The ComfyUI version is deliberately unchanged at
# v0.32.0: this swaps ONE variable. Still overridable without a deploy.
RUNPOD_COMFY_IMAGE = os.environ.get(
    "HIVEMIND_RUNPOD_COMFY_IMAGE", "vastai/comfy:v0.32.0-cuda-13.2-py312"
)


def comfy_image_for(provider_key: str) -> str:
    return RUNPOD_COMFY_IMAGE if provider_key == "runpod" else COMFY_IMAGE
# Progress beacon: the box serves /progress.json on this (published) port so
# the Machines view can render truthful provisioning phases. ComfyUI itself
# stays bound to 127.0.0.1 — only the beacon is exposed.
BEACON_PORT = 18189
# Where the box writes it. The reader used to be the HTTP server alone, so the
# path could stay a literal in the onstart; now that a mute published port is
# read back over SSH instead, writer and reader have to agree in one place.
BEACON_DIR = "/root/beacon"
BEACON_PROGRESS_PATH = f"{BEACON_DIR}/progress.json"
PRESIGN_EXPIRE_SECONDS = 3 * 3600
# Vast's documented ceiling for the onstart/args field. The weight list used
# to live inline (measured 2026-08-08: the video tier's 11 presigned URLs alone
# were ~6.6KB of it) and capped how many user LoRAs a tier could carry; since
# 2026-08-22 the onstart holds one presigned manifest URL instead, so its size
# no longer depends on what a tier serves. The ceiling still bounds the node
# installs and the inlined privacy node.
VAST_ONSTART_LIMIT = 16384
_REQUEST_TIMEOUT = 30
# curl cuts a connection that stays under this floor for DOWNLOAD_STALL_SECONDS
# (exit 28), and the download library below reopens it and RESUMES from the
# bytes already on disk. The floor used to be 50 KB/s, which is low enough that
# no degraded transfer ever trips it: measured 2026-08-10, a route that had
# collapsed to 59 KB/s sat just above the floor and would have needed ~39 HOURS
# to finish an 8.3GB file, holding a billed box at 10/11 the whole time. Healthy
# R2 pulls run 55-100 MB/s aggregate — 5-9 MB/s per file with a whole tier in
# flight — so 1 MB/s sits well below "contended" and well above "dead".
# A connection this slow for this long is stalled, not busy. It used to be
# 1 MB/s, which is a THROUGHPUT expectation rather than a liveness check: a
# healthy 5090 whose link was momentarily shared tripped it and the watchdog
# destroyed the machine. Liveness is this floor; throughput is the deadline.
DOWNLOAD_MIN_BYTES_PER_SEC = 131_072
DOWNLOAD_STALL_SECONDS = 90
# Weights are fetched with several ranged connections per file. One stream tops
# out well below what the box can take — a 5090 measured 6 MB/s on a single
# stream and 32 MB/s across five — and the largest file is the whole tail of
# provisioning, so splitting IT is what shortens the wait.
#
# The split only happens when the object's length is known. It used to be
# learned with a HEAD — and R2 answers 403 to a HEAD on a GET-presigned URL
# (SigV4 signs the method), so every R2 weight silently took the single-stream
# fallback and only the public HuggingFace files were ever split. Measured
# 2026-08-22 against the live bucket. The length now comes from a one-byte
# ranged GET on the same URL, whose Content-Range carries the total.
DOWNLOAD_CONNECTIONS = 8
DOWNLOAD_SPLIT_MIN_BYTES = 512 * 1024 * 1024
# A split object is pulled as CHUNK-sized pieces by a pool of CONNECTIONS
# workers, not as CONNECTIONS fixed eighths. Measured 2026-08-22 on a Vast PRO
# 6000 in Japan against the live bucket: eight connections to R2 opened at the
# same moment ran 63, 44, 30 and 26 MB/s — and the other four under 7 MB/s for
# minutes. With fixed eighths a file's wall time is its slowest connection's,
# which is how the 15.7GB text encoder took 25 of a 27-minute provisioning
# while the 21GB transformer beside it landed in four. A slow connection now
# costs one chunk, and the next chunk is a fresh connection (R2 hands out a
# different edge per connection), so the tail is bounded by CHUNK, not by the
# file.
DOWNLOAD_CHUNK_BYTES = 256 * 1024 * 1024
# Every stream is retried at the shell level, resumed from its own byte offset,
# on ANY failure — not curl's --retry, which (measured 2026-08-22) re-sends a
# bare GET with no Range and truncates the output to zero on each retry, and
# only covers timeouts and HTTP 408/429/5xx in the first place. A connection
# reset (curl 56) or early close (18) on the one stream carrying a 5 GB VAE is
# exactly how rental vast:48337699 died at 6/7 with a healthy host and link.
# Permanent answers (HTTP 400-407, 409-419) are not retried: a 403/404 says
# the URL is wrong, and re-asking costs billed minutes. Everything else is
# retried for PATIENCE seconds of consecutive failure on that stream, with the
# pause growing from PAUSE to 6xPAUSE, and never past the phase DEADLINE below.
# Time, not a count: measured 2026-08-22 on a RunPod 5090 (runpod:vrygri4b9b1x78),
# one stream of each big HuggingFace weight kept timing out after the CDN
# redirect (curl 28 http 302) while the other seven streams of the same file
# finished — a 12-attempt cap gave up after ~8 minutes and the box was
# destroyed at 6/8 with every R2 weight already on disk. ATTEMPTS is only a
# hard stop behind the time bounds.
DOWNLOAD_STREAM_ATTEMPTS = 200
DOWNLOAD_STREAM_PATIENCE_SECONDS = 20 * 60
DOWNLOAD_RETRY_PAUSE_SECONDS = 5
DOWNLOAD_CONNECT_TIMEOUT_SECONDS = 30
# Backstop for a stall the per-transfer floor cannot see, e.g. a connection that
# hangs without dying or a retry loop that keeps resetting. The slowest healthy
# provision observed is ~20 minutes (95GB video tier), so this only fires on a
# machine that is never going to finish.
DOWNLOAD_DEADLINE_SECONDS = 45 * 60
# How often the watcher re-counts landed files and re-publishes the beacon.
DOWNLOAD_POLL_SECONDS = 5

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
    # The VIDEO VAE is not here: it moved to the public set when we swapped the
    # fp16 decoder for Kijai's int8_convrot one, which Comfy-Org mirrors. Only
    # the audio VAE still comes from our bucket.
    ("vae/minimax_h3_audio_vae_fp32.safetensors", "vae"),
]
# The turbo LoRA and its loader come from upstream, not R2: the weights are
# public, and larryvrh's node is REQUIRED to apply them — it re-injects the
# time conditioning a pruned base (ours) lacks, which is the whole reason we
# previously shipped drbaph's AdaLN-stripped conversion as a workaround for
# ComfyUI's plain LoraLoaderModelOnly. (url, models/ subdir, filename, GB)
# SeedVR2 restoration. Public on HuggingFace, so the box pulls them directly
# rather than round-tripping ~9GB through our bucket. Fetched at provisioning
# because the node downloads a missing model on FIRST USE — and the first chunk
# of a paid render is the worst possible moment to start an 8.5GB download.
_SEEDVR2_PUBLIC_FILES = [
    (
        "https://huggingface.co/AInVFX/SeedVR2_comfyUI/resolve/main/"
        "seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors",
        "SEEDVR2",
        "seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors",
        8.5,
    ),
    (
        "https://huggingface.co/numz/SeedVR2_comfyUI/resolve/main/ema_vae_fp16.safetensors",
        "SEEDVR2",
        "ema_vae_fp16.safetensors",
        0.5,
    ),
]

_MINIMAX_PUBLIC_FILES = [
    (
        "https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/resolve/main/"
        "minimax_h3_turbo_v4_step600_ema.safetensors",
        "loras",
        "minimax_h3_turbo_v4_step600_ema.safetensors",
        0.78,
    ),
    # The still-image lane (minimax-h3-image). H3 Studio is built against
    # Kijai's W4A8 pruned pair, NOT the int8_convrot FL2VA we convert ourselves
    # for the video lane — same model, different quantisation, and the pack's
    # sampling profiles are tuned to these. They are public, so the box pulls
    # them straight from HuggingFace rather than round-tripping ~23GB through
    # R2. REF2VA has no video-lane equivalent at all: it is the reference path
    # that makes @Image1..@Image9 work.
    #
    # This adds ~23GB to every H3 box, video-only ones included. That is
    # deliberate: one rented box now serves both studio pages (the tier's
    # studio_pages carries video AND image), so a box that could not run a
    # still would be a box the studio has to refuse work to.
    # SAM3.1, for head replacement's SAM3 masking branch. comfy-core's own
    # SAM3_VideoTrack reads it through CheckpointLoaderSimple, so it lands in
    # checkpoints/. Public, Meta's SAM License, pulled straight from HuggingFace
    # rather than through R2. 1.6GB against the ~23GB this tier already carries,
    # and the manual-mask branch never loads it — but a box that could not track
    # a subject would be a box the studio has to refuse work to.
    (
        "https://huggingface.co/Comfy-Org/sam3.1/resolve/main/"
        "checkpoints/sam3.1_multiplex_fp16.safetensors",
        "checkpoints",
        "sam3.1_multiplex_fp16.safetensors",
        1.63,
    ),
    (
        "https://huggingface.co/Kijai/MiniMax-H3-experimental/resolve/main/"
        "minimax_h3_fl2va_pruned_w4a8_mixed.safetensors",
        "diffusion_models",
        "minimax_h3_fl2va_pruned_w4a8_mixed.safetensors",
        11.7,
    ),
    (
        "https://huggingface.co/Kijai/MiniMax-H3-experimental/resolve/main/"
        "minimax_h3_ref2va_pruned_w4a8_mixed.safetensors",
        "diffusion_models",
        "minimax_h3_ref2va_pruned_w4a8_mixed.safetensors",
        11.0,
    ),
    # THE video decoder for every H3 lane, video and still alike: Kijai's
    # int8_convrot quantisation of H3's video VAE, taken from Comfy-Org's
    # mirror rather than his experimental repo (same quantisation, 2.81GB
    # against 3.17GB because the unquantised tensors stay fp16, and it is the
    # repo every other official H3 artifact here already comes from).
    #
    # Only the DECODER is quantised. All 116 encoder tensors keep the same keys
    # and shapes and carry no int8 at all (83 are simply stored widened to fp32,
    # which is lossless from fp16), so the reference and inpaint lanes — the
    # ones that ENCODE — are numerically unchanged. Measured by the author on an
    # RTX 5070: VAE decode peaks at 2,677MB against fp16's 4,965MB, ~1.5x faster.
    #
    # HARD FLOOR: ComfyUI >= v0.31.0 (comfyanonymous/ComfyUI#15334, bbda8364,
    # 2026-08-06) or this file DECODES TO BLACK FRAMES rather than failing. That
    # is later than the e377e263 H3 contract pinned elsewhere in this package,
    # so v0.31.0 is now the real floor; both images we rent (RunPod's pinned
    # v0.32.0 and Vast's automatic tag) clear it.
    #
    # Public, so it comes straight from HuggingFace instead of through R2 —
    # which also drops 5.2GB of relayed bytes off every H3 box for 2.8GB of
    # upstream ones.
    (
        "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/"
        "vae/minimax_h3_video_vae_int8_convrot.safetensors",
        "vae",
        "minimax_h3_video_vae_int8_convrot.safetensors",
        2.81,
    ),
    # Weights for the "Fast high-res" latent upscaler (bf16 build: same network
    # as the fp16/fp32 files, and bf16 is the numerically forgiving one on the
    # Blackwell cards this tier rents). Public, so it comes straight from
    # HuggingFace. It MUST be on disk before ComfyUI starts: the node builds its
    # model_name combo by scanning this directory at schema time, so a box that
    # downloaded it late would advertise an empty list and reject the graph.
    (
        # Upstream moved this into a per-version folder on 2026-09-17 and the old
        # flat path now 404s, which failed provisioning at 18/19. Same weights,
        # same 0.69GB. The DESTINATION filename below is deliberately left at the
        # old flat name: every graph pins model_name to it.
        "https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler/resolve/main/"
        "minimax_h3_latent_upscaler_3d_conv_v1/"
        "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors",
        "latent_upscale_models",
        "minimax_h3_latent_upscaler_3d_bf16.safetensors",
        0.69,
    ),
]

# H3 Eros Max beta5 — the NSFW tier's transformer, and the ONLY thing that tier
# serves beyond the set above. It is an H3 finetune in the same int8_convrot
# quantisation as our official DiT and loads through the same plain UNETLoader,
# so every H3 lane runs against it by swapping one unet_name; the eros tier
# therefore carries the official serving set too and is a strict superset of
# `minimax`.
#
# TURBO-hybrid: the ref/fl turbo deltas are FUSED into these weights (the
# author's own reason for the build — it saves loading both turbo LoRAs), so
# the eros graphs do NOT stack larryvrh's turbo LoRA on top. It also keeps the
# AdaLN pair our official base has pruned away (adaln_basis / adaln_mean /
# adaln_t_table are all present — read out of the safetensors header
# 2026-09-14), which is why plain LoraLoaderModelOnly can apply concept LoRAs
# to it where the official base needs MiniMaxH3TurboLoRA to re-inject the time
# conditioning first.
#
# Pulled from the author's own HuggingFace mirror rather than Civitai. Same
# bytes — sha256 4dd96549… is Civitai model 2851079 version 3294059 file
# 3178732 — but HF is public and ungated, where a Civitai download needs an
# account token that would then have to ride inside the rental manifest (which
# lives in the private bucket but is handed to every box we rent).
_H3_EROS_DIT = "10Eros_Max_h3_TURBO-hybrid_beta5_int8.safetensors"
_H3_EROS_PUBLIC_FILES = _MINIMAX_PUBLIC_FILES + [
    (
        f"https://huggingface.co/TenStrip/10Eros-Max/resolve/main/{_H3_EROS_DIT}",
        "diffusion_models",
        _H3_EROS_DIT,
        20.97,
    ),
]
# Pinned like every other node on the box. 2026-08-07 HEAD; ships
# h3_silu_temb_grid.safetensors, the silu(t_emb) grid the loader needs.
_H3_TURBO_NODE_COMMIT = "55fee864dd7b2976b1c4ce3c3d5f7968f181409f"
# H3 support is newer than any vastai/comfy release image; the Spectrum node
# was contract-tested against 2026-08-03's e377e263 (native MiniMax H3 +
# packed-latent sampler API). Same pin as provisioning/comfyui-hivemind.sh.
# Bumped 2026-08-30 to the squash-merge of Comfy-Org/ComfyUI#15808 (kijai,
# 2026-08-22, one file: comfy/text_encoders/minimax.py). H3's special tokens
# — <d> 151669, </d> 151670, <|cutoff|> 151671, the lyrics/caption pairs —
# were declared in tokenizer_config.json but missing from the live vocab, so
# each one split into junk subtokens. Measured on a rented 5090 (2026-08-30):
# <d> is one token 151669 with the fix and two ([90707, 29]) without, and </d>
# one against three — and pre-fix the ">" merges with the "[" of the language
# tag, so the damage crosses into "[English]" rather than staying in the tag.
# What that does NOT show: five 4s renders at seed 42 all transcribed VERBATIM
# (faster-whisper large-v3, similarity 1.000) — plain t2v with and without the
# fix, audio-reference mode with and without it, and audio-reference with the
# clip attached but NEVER bound in the prompt, which is the community's
# reported trigger. The split tokenization did not produce gibberish in any
# case we could construct, so take this as removing a known-wrong tokenization,
# NOT as a cure for a failure this stack was measured to have. Untested: long
# or multi-speaker dialogue, non-English, and noisy/long reference clips.
# Pinned AT the fix: 112 commits of churn is already a risk against a graph
# tuned on e377e263, and nothing later buys us anything.
# This is a FLOOR, not an exact pin — onstart only checks out when it is not
# already an ancestor of the image's HEAD, so a box whose image shipped a
# newer ComfyUI silently had the fix while an older one was dragged back to
# Aug 3. That is why the gibberish came and went from box to box.
_H3_COMFY_COMMIT = "924743af083c151296cc16f925aeab113b6484e8"
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
# Its README's minimum ComfyUI commit is e377e263, which _H3_COMFY_COMMIT is a
# descendant of, so the 2026-08-30 tokenizer bump does not disturb it. Every
# new input is set explicitly in the graph.
_H3_SPECTRUM_COMMIT = "9395bf98fc60a04c5f588de7b2bb33516a0b622f"
_H3_KJNODES_COMMIT = "35e5956193769d18a13136cdedb73a36a05c73e6"
# Scene chaining (studio "Continue scene"): MiniMaxH3MotionContext feeds the
# previous clip's tail frames + audio into the next generation and Trim removes
# the re-rendered context head. v0.2.0 (2026-08-09): reference-mode support +
# latent picture path. Patches apply on first node execution only, so plain H3
# jobs on the same box are untouched.
_H3_MOTION_CONTEXT_COMMIT = "c140ae99b8c38f782ebd8564c267b42aacade6a4"

# Head replacement (studio "Replace head", workflow minimax-h3-inpaint). Two
# packs, both pinned like everything else here, and both installed as separate
# ComfyUI custom nodes rather than vendored — we call them, we do not link them.
#
# NKD Basic Tools (MIT) carries the node the whole feature turns on: NKDAVLatent
# encodes the source clip into H3's JOINT audio+video latent and puts the mask on
# it as a noise_mask, which is what lets only the masked pixels be denoised while
# the soundtrack is held. Holding the audio is not a saving, it is the mechanism:
# the model sees the original speech while it paints the face, so the new head
# lip-syncs without a separate pass. NKDMaskOps comes with it and is what turns a
# painted region into a latent-grid mask.
_H3_NKD_BASIC_TOOLS_COMMIT = "290b8557b26a05ef14abdb9e11f96a490777fcd7"
# MaskVidExperiments (GPL-3.0) plans the moving window around the subject and
# pastes the result back without a seam. The model samples that WINDOW, not the
# frame, which is what makes head replacement affordable: a 0.8MP crop of a 1080p
# clip is a quarter of the rows.
_H3_MASKVID_COMMIT = "d98cc899c1fac718acf81cde1735bf57281097cf"
# SeedVR2 video restoration. Pinned because its node inputs are a contract the
# gateway builds graphs against (packages/media-gateway/video_restore.py), and
# because the TensorRT node patches one of its internal methods by name.
_SEEDVR2_COMMIT = "4490bd1f482e026674543386bb2a4d176da245b9"

# Krea2's text encoder node. NOT a ComfyUI core node and not part of INT8-Fast:
# it is a separate pack, and without it every Krea2 graph the studio compiles is
# rejected outright with "Node 'TextEncodeKrea2' not found" — the box provisions
# perfectly, ComfyUI comes up, and the first generation 400s. Found 2026-08-15 by
# running an actual generation on a freshly rented box; it had been missing from
# the image and video tiers on EVERY provider, which is the kind of gap only a
# real end-to-end render can surface. Pinned for the same reason as the H3 nodes.
_KREA2_TEXT_ENCODER_COMMIT = "fb84ab5444b1ec0048e0d38b7450b137eee9c5bc"

# Sol-Attn: NVlabs sparse attention as a Triton kernel, chained onto sage rather
# than replacing it. Measured on a rented 5090 (5s @ 960x544, warm, one seed):
# 34.3s against 38.6s for the Spectrum baseline, same take, detail equal or
# better. It is the DEFAULT accelerator (tau 1.3) in every registered H3 graph,
# which makes this node mandatory on an H3 lane rather than optional: without it
# ComfyUI rejects the whole prompt, including runs that never wanted it. Pinned
# because it is experimental and moves fast; same commit as the standalone
# provisioning script in packages/gpu-rentals.
_H3_SOLATTN_COMMIT = "842c4eaa7d91dbaef3fee3ccdbf36a39521e82fc"

# H3 Studio turns the same H3 weights this lane already carries into a STILL
# image generator (FL2VA/REF2VA), which is what the minimax-h3-image lane runs.
# Pinned to the audited tag: it is alpha and its route surface has changed
# between commits, and the strip below is written against exactly this one.
_H3_STUDIO_TAG = "v0.1.0-alpha.20"

# The "Fast high-res" two-pass lane: a trained neural upscaler for H3's own
# 24-channel latent, so a first pass can be sampled at a fraction of the target
# canvas and lifted to full size WITHOUT the 5B-param VAE decode/encode round
# trip an ordinary pixel upscale would need. Audited before pinning (three
# Python files, no network, no subprocess, no eval); its only sharp edge is a
# torch.load(weights_only=False) branch for .pth checkpoints, which we never
# take — the box pulls the safetensors build below. Pinned like every other
# node here: the pack is two days old and its schema (a DynamicCombo `mode`)
# is exactly what the compiled graph addresses.
_H3_LATENT_UPSCALER_COMMIT = "04f71594d11325be877b5ba05096fcb851c29048"

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
        # +12 over the LTX set for the SeedVR2 restoration weights (~9GB) and
        # the engine cache a TensorRT build writes beside them.
        "disk_gb": 172,
        "models": _IMAGE_MODELS + _VIDEO_MODELS,
        "public_models": _SEEDVR2_PUBLIC_FILES,
        "needs_int8_fast": True,
        "expected": "eros+DMD ~16s per 4s clip @768×512, video+audio · images included",
        "reference_job": "4s clip @768×512, video + audio",
        # 'ltx23-eros' matches no graph content (server-side no-op) but lets
        # the UI's normalized matcher recognize the ltx23-eros-v14-comfy model id.
        # 'seedvr2' matches the restore graph's own model filenames
        # (seedvr2_ema_*.safetensors), which is how a restoration routes to a
        # box rented for video rather than falling back to the local lane.
        "lane_needles": ["krea2_turbo_convrot", "waianima", "ltx2310eros", "ltx-2.3-22b", "ltx23-eros", "seedvr2"],
        "studio_pages": ["image", "video", "restore"],
        "lora_base_models": ["Krea 2", "Anima", "LTXV"],
    },
    "minimax": {
        "label": "Video · MiniMax H3",
        "family": "Video · MiniMax H3",
        "family_detail": "Heavier and slower than LTX — stereo sound, and the one that takes scripted dialogue",
        # 21GB transformer + 15.7GB encoder. 32GB runs it (the box trades
        # encoder residency for reload time); 96GB holds both at once.
        "min_vram_gb": 32,
        # ComfyUI stages weights in system RAM and streams them to the card, so
        # the DiT (20.0GB) and the text encoder (15.0GB) have to fit HOST-side
        # too. Below this a box cannot render even a short clip; above it, how
        # LONG a clip fits is a function of the lane's own RAM, which is why
        # this is a floor and not the whole story — see lane_max_frames().
        # Measured 2026-08-13: a 29.2GiB container rendered a 5s reference clip
        # and had its ComfyUI process KILLED outright on a 10s one, system RAM
        # peaking at 27.12GiB. 32 keeps those boxes rentable for the durations
        # they can actually survive rather than turning the tier off entirely
        # (no offer on the live market clears 48).
        "min_ram_gb": 32,
        # nvfp4 text encoder: Blackwell only, and specifically sm_120.
        "gpu_sm": {120},
        "disk_gb": 120,
        "models": _MINIMAX_MODELS,
        "needs_int8_fast": False,
        "needs_h3_stack": True,
        # ComfyUI's --vram-headroom for this tier's lanes. The H3 motion-
        # reference budget (workflow-registry.json motion_reference_budget) was
        # measured with exactly this much; the onstart passes it, attach records
        # what the box actually runs, and the gateway reads it per job.
        "comfy_vram_headroom_gb": 12,
        # Whole-job seconds for the reference clip on a warm 5090, as the graph
        # was tuned: 183s on 2026-08-07, 102s on 2026-08-08, 40s on 2026-08-10.
        # Quote the current one — the older figures survived in this string for
        # days after the graph had moved on, which is how a 5s clip came to
        # look three times slower than it runs.
        "expected": "5s 960×544 video+audio ~40s warm on a 5090 (Spectrum, 15 steps)",
        "reference_job": "5s clip @960×544, video + audio",
        "public_models": _MINIMAX_PUBLIC_FILES,
        # No "seedvr2" and no "restore": this tier does not carry the restorer.
        # See tier_installs_seedvr2_trt for why restoration lives on the video
        # tier — briefly, this onstart has no room for a second model stack.
        "lane_needles": ["minimax_h3"],
        # The lane this tier is RENTED FOR. Both H3 tiers serve several lanes —
        # the eros box carries the official weights too — so "the first model it
        # serves" is a coin toss, and it landed on plain MiniMax H3 for someone
        # who had deliberately rented the Eros Max box. Named here because the
        # tier is the only thing that knows why the machine was bought.
        "primary_workflow": "minimax-h3",
        "studio_pages": ["video", "image"],
        # Civitai's base-model category for H3 add-on LoRAs (style/character/
        # motion — distinct from the turbo LoRA baked into the serving set) is
        # exactly "MiniMax H3".
        "lora_base_models": ["MiniMax H3"],
    },
}

# The NSFW H3 box. Spelled out as the `minimax` spec plus its differences
# rather than copied, because the two are the SAME machine — same cards, same
# VRAM and RAM floors, same Blackwell-only encoder, same node stack, same
# studio pages — and every one of those numbers was measured once, for both.
# What differs is one file in the serving set and the price of carrying it.
#
# A tier key may not contain a hyphen: `_tier_from_label` reads the tier back
# out of a machine label by splitting on "-", so "minimax-eros" would come
# back as "minimax" and the box would be provisioned as the wrong workload.
TIERS["minimaxeros"] = {
    **TIERS["minimax"],
    "label": "Video · MiniMax H3 Eros (NSFW)",
    "family": "Video · H3 Eros (NSFW)",
    "family_detail": (
        "MiniMax H3 with the Eros Max beta5 transformer — everything the H3 box "
        "does, uncensored, and at 8 steps instead of 15"
    ),
    # +21GB for the eros transformer on top of the H3 set.
    "disk_gb": 145,
    "public_models": _H3_EROS_PUBLIC_FILES,
    # Both, because this box carries both transformers: an official-H3 job runs
    # here unchanged, and the eros graphs are the only ones that name the eros
    # file. The reverse is not true — a plain `minimax` box has no eros weights
    # — and routing is first-match by attachment priority over the whole graph
    # text, which an eros graph shares with the official one through the
    # encoder and VAE filenames. So with both kinds of box attached at once,
    # pin the eros run to this machine with "Run on" rather than trusting the
    # match; a misroute fails loudly on the far end (ComfyUI 400, unknown
    # unet_name) rather than rendering the wrong thing.
    "lane_needles": ["minimax_h3", "10eros_max"],
    "primary_workflow": "minimax-h3-eros",
    # Deliberately NOT in RENTAL_BENCHMARKS: nothing has been timed on this
    # tier yet, and that table is measurements only. Until a row lands the UI
    # draws "—" for seconds per generation, which is the truth.
    "expected": (
        "5s 960×544 video+audio at 8 steps — fewer steps than the official H3 "
        "lane, but not yet timed on a rented card"
    ),
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


class GpuRentalError(ProviderError):
    """Raised for Cloudflare API failures and rental policy violations.

    Subclasses ProviderError so a marketplace failure raised inside
    rental_providers/ and a policy refusal raised here are caught by one
    `except` at the route boundary and keep their own status codes. Every
    caller that used to catch GpuRentalError must now catch ProviderError —
    otherwise a Vast 429 would escape as a 500 instead of the 502 it is.

    `remedy` names the button that repairs it ("connect-account", "passbook")
    so the Machines view can offer the action instead of matching the
    sentence — the same contract hivemindos_models.HivemindosModelsError keeps.

    `payload` is for a refusal the UI is expected to ACT on rather than print.
    A price that moved between the quote and the order is the case it exists
    for: the numbers ride along so the view can re-price its card and ask
    whether to go ahead, instead of parsing two dollar figures back out of an
    English sentence. The sentence stays for callers with no UI (agents, the
    MCP), which is why both are sent.
    """

    def __init__(self, message: str, status_code: int = 502, *, remedy: str = "",
                 payload: dict | None = None) -> None:
        super().__init__(message, status_code)
        self.remedy = remedy
        self.payload = payload or {}


def _env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise GpuRentalError(f"{name} is not configured in the environment", status_code=503)
    return value


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
    """Entries this tier must download: reachable (ready), and chosen for it.

    "Chosen" has two forms and the committed one wins. With pins in
    rental-build.json the tier downloads exactly those and nothing else — an
    explicit decision, reviewed in a diff. With no pins the original rule
    stands: every ready LoRA whose base-model family this tier's serving set
    accepts, which is what every existing rental was provisioned under."""
    # "ready" means a box can GET it — in the bucket, or servable by Civitai.
    ready = [entry for entry in read_rental_loras().values() if entry.get("status") == "ready"]
    pins = pinned_rental_loras(tier)
    if pins is None:
        return [entry for entry in ready if tier in (entry.get("tiers") or [])]
    wanted = set(pins)
    return [entry for entry in ready if str(entry.get("id") or "") in wanted]


def _rental_lora_downloads(tier: str) -> list[dict]:
    """One row per registered LoRA: where it lands, and where it comes from.

    The destination preserves the LOCAL relative path — the studios put
    installed-LoRA ids like "ltx/foo.safetensors" straight into the graph as
    lora_name, so the rented ComfyUI must resolve exactly that name under
    models/loras. It is OUR filename, not the source's: a file renamed after
    download still has to land under the name the graph asks for.

    The source is either our bucket or Civitai, decided once when the LoRA was
    registered (add_rental_lora) and recorded per entry.
    """
    out = []
    for entry in rental_loras_for_tier(tier):
        rel = str(entry.get("id") or "")
        if not rel:
            continue
        civitai = entry.get("civitai") if isinstance(entry.get("civitai"), dict) else {}
        use_civitai = entry.get("source") == "civitai" and bool(civitai.get("version_id"))
        out.append({
            "dest": f"loras/{rel}",
            "key": "" if use_civitai else str(entry.get("r2_key") or f"{RENTAL_LORA_R2_PREFIX}{rel}"),
            "civitai": dict(civitai) if use_civitai else {},
            "size_gb": float(entry.get("size_gb") or 2.0),
        })
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


def _lora_civitai_source(path: Path) -> dict:
    """Civitai ids for an installed LoRA, but only if this account can FETCH it.

    Returns {} for anything that has to ride the bucket instead — no sidecar, an
    ambiguous version, or a file Civitai will not serve us (Early Access answers
    403). Never raises: the bytes are on disk, so the answer to "can we skip the
    upload" is only ever yes or no, never an error the caller has to handle.
    """
    source = installed_cloud_source(path)
    civitai = source.get("civitai") or {}
    if source.get("source") != "civitai" or not civitai.get("version_id"):
        return {}
    try:
        _civitai_signed_url(str(civitai["version_id"]), str(civitai.get("file_id") or ""))
    except GpuRentalError:
        return {}
    except Exception:  # noqa: BLE001 - a transient network fault is also a "no"
        return {}
    return {"version_id": str(civitai["version_id"]), "file_id": str(civitai.get("file_id") or "")}


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
    # A LoRA Civitai will serve needs no upload and no bucket object at all:
    # the box fetches it the same way a swapped-in checkpoint does, from a
    # signed URL resolved here at rent time. Checked ONCE, now, because the
    # answer decides whether to spend a transfer — and because a file this
    # account cannot fetch (Early Access answers 403) must fall back to the
    # upload rather than fail, since the bytes are right here on disk.
    civitai = _lora_civitai_source(path)
    entry_source = "civitai" if civitai else "r2"
    with _rental_lora_lock:
        entries = read_rental_loras()
        existing = entries.get(lora_id)
        if existing and existing.get("status") == "uploading":
            raise GpuRentalError("this LoRA is already uploading", status_code=409)
        already_uploaded = bool(
            existing
            and existing.get("status") == "ready"
            and existing.get("source") != "civitai"
            and int(existing.get("size_bytes") or 0) == size_bytes
        )
        needs_upload = entry_source == "r2" and not already_uploaded
        entry = {
            "id": lora_id,
            "filename": path.name,
            "displayName": str(display_name or "").strip() or path.stem,
            "baseModel": base,
            "rating": rating,
            "tiers": tiers,
            "source": entry_source,
            # Kept for both: withdrawing a LoRA that was once uploaded still has
            # an object to delete, and a Civitai entry that later falls back to
            # the bucket reuses the same key.
            "r2_key": f"{RENTAL_LORA_R2_PREFIX}{lora_id}",
            "civitai": civitai,
            "size_bytes": size_bytes,
            "size_gb": round(size_bytes / 1e9, 3),
            "added_at": str((existing or {}).get("added_at") or now),
            "status": "uploading" if needs_upload else "ready",
            "error": "",
        }
        entries[lora_id] = entry
        _write_rental_loras(entries)
        # Switching an already-uploaded LoRA to Civitai leaves its object in the
        # bucket referenced by nothing. Dropped here rather than at withdrawal,
        # which no longer asks R2 about a Civitai entry at all.
        orphan = (
            str(existing.get("r2_key") or "")
            if existing and existing.get("source") != "civitai" and entry_source == "civitai"
            else ""
        )
    if orphan:
        with contextlib.suppress(Exception):
            requests.delete(_presign_r2("DELETE", orphan), timeout=_REQUEST_TIMEOUT)
    if needs_upload:
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
    # re-add with the same id simply overwrites it. A Civitai-sourced entry
    # never had an object, so there is nothing to ask R2 about.
    if entry.get("source") != "civitai":
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


# --- the project rental build: what a rented box is provisioned WITH ---------
#
# Two things a person can change per tier, and both belong in the repository
# rather than under ~/.hivemindos: which of their LoRAs ride along on that
# tier's boxes, and which checkpoint stands in for one of its default weights.
# Those are decisions about the product — the same on every machine that checks
# this repo out — so they live in a committed file, reviewed in a diff.
#
# The split from the rental-LoRA registry above is the whole reason both exist:
#
#   rental-build.json (git)    what SHOULD be on a tier's boxes — intent
#   rental-loras.json (local)  what is uploaded and reachable — transport state
#
# A pinned LoRA still has to be in the local registry with status "ready"
# before a box downloads it: the pin says which tier wants it, the registry
# says whether the bytes are in the bucket yet. A tier with no pins keeps the
# original rule unchanged — every ready LoRA whose base-model family it serves.
RENTAL_BUILD_PATH = Path(__file__).resolve().parents[2] / "packages/gpu-rentals/rental-build.json"
COMFY_MODELS_ROOT = COMFY_LORAS_ROOT.parent
# The models/ subdirectories a graph names a base weight from (unet_name,
# ckpt_name). A swap may only replace a weight landing in one of these: text
# encoders and VAEs are not interchangeable and are never offered.
RENTAL_CHECKPOINT_SUBDIRS = ("diffusion_models", "checkpoints", "unet")
# A Hugging Face URL that serves the FILE rather than a page about it. Public
# HF repos need no credential, so this one goes into the manifest verbatim.
_HF_FILE_URL = re.compile(r"^https://huggingface\.co/[\w.-]+/[\w.-]+/resolve/\S+$")
# Civitai needs one hop, and the hop happens HERE rather than on the box.
#
# An unauthenticated Civitai download answers 401, and the weights manifest is
# handed to every box we rent, so a token can never go in it. But the token is
# not what the box needs: `/api/download/models/<v>?token=…` answers 302 to an
# AWS SigV4 presigned URL on Civitai's own R2 — the same shape as the presigns
# this module already mints for our bucket, carrying no token and fetchable by
# anyone holding it. Measured 2026-09-14 against version 3208482: the redirect
# lands on civitai-delivery-worker-prod.<acct>.r2.cloudflarestorage.com with
# X-Amz-Expires=86400 (ours are 3h), the token appears nowhere in it, and an
# anonymous range GET answers 206.
#
# So the committed config stores the STABLE ids, never a signed URL — one
# expires and the other is a capability, and neither belongs in a commit — and
# the redirect is followed once per rental, here, where the token already is.
_CIVITAI_DOWNLOAD_URL = "https://civitai.com/api/download/models/{version}"
_CIVITAI_TOKEN_ENV_KEYS = (
    "CIVITAI_TOKEN", "CIVITAI_API_TOKEN", "CIVITAI_API_KEY",
    "CIVITAI_KEY", "CIVITAI_ACCESS_TOKEN", "CIVITAI_BEARER_TOKEN", "CIVITAI_PAT",
)
_CIVITAI_TOKEN_FILE = MEDIA_STATE_ROOT / "secure/civitai-token"
# Answers that mean "ask again", not "no": a rate limit and a bad moment on
# their side. Everything else (401 bad token, 403 Early Access, 404 gone) is a
# decision, and re-asking only wastes the caller's time.
_CIVITAI_TRANSIENT_CODES = {408, 429, 500, 502, 503, 504}
_CIVITAI_ATTEMPTS = 3
_CIVITAI_RETRY_SECONDS = 2.0
_CIVITAI_RETRY_CAP_SECONDS = 15.0
# How many signed URLs to ask Civitai for at once at rent time. Serial was the
# problem: ten pinned LoRAs each able to spend three 30s timeouts meant one slow
# answer held the rental ~96s and two ran past the 190s proxy leg. Four at a
# time bounds the wait by the slowest single file without bursting a rate
# limit that already answers ten registrations in a row with a 429.
_CIVITAI_PARALLEL = 4

_rental_build_lock = threading.Lock()


def read_rental_build() -> dict:
    """The committed build config, or an empty one.

    Never raises: a hand-edited file with a typo in it must not take the
    Machines view — or a rental already paid for — down with it."""
    try:
        data = json.loads(RENTAL_BUILD_PATH.read_text())
    except Exception:
        return {"version": 1, "tiers": {}}
    if not isinstance(data, dict):
        return {"version": 1, "tiers": {}}
    tiers = data.get("tiers")
    data["tiers"] = tiers if isinstance(tiers, dict) else {}
    return data


def _tier_build(tier: str) -> dict:
    entry = read_rental_build()["tiers"].get(tier)
    return entry if isinstance(entry, dict) else {}


def rental_build_is_editable() -> bool:
    """Whether this install can write the committed config at all.

    A git checkout can; a packaged app unpacked into its own bundle cannot, and
    would have nothing to commit even if it could. This is the gate the studio
    hides the whole page behind — the honest form of "dev only" for a surface
    whose entire output is a file in this repository."""
    root = RENTAL_BUILD_PATH.parents[2]
    return (
        (root / ".git").exists()
        and RENTAL_BUILD_PATH.parent.is_dir()
        and os.access(RENTAL_BUILD_PATH.parent, os.W_OK)
    )


def _write_rental_build(data: dict) -> None:
    if not rental_build_is_editable():
        raise GpuRentalError(
            "this install has no project checkout to write the rental build into",
            status_code=409,
        )
    # Two spaces and a trailing newline, like every other committed JSON here:
    # this lands in a commit, and a diff nobody can read is one nobody reviews.
    RENTAL_BUILD_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def pinned_rental_loras(tier: str) -> list[str] | None:
    """This tier's LoRA pins, or None when it has none and the family rule stands."""
    pins = _tier_build(tier).get("loras")
    if not isinstance(pins, list):
        return None
    return [str(value) for value in pins if str(value or "").strip()]


def _civitai_token() -> str:
    """The same resolution order the media gateway uses, so one machine has one
    Civitai identity. CIVITAI_API_KEY is already in the stack's STUDIO_KEYS
    allowlist, which is what puts it in this process at all."""
    for key in _CIVITAI_TOKEN_ENV_KEYS:
        value = os.environ.get(key)
        if value and value.strip():
            return value.strip()
    try:
        return _CIVITAI_TOKEN_FILE.read_text().strip()
    except Exception:
        return ""


def _civitai_signed_url(version_id: str, file_id: str = "") -> str:
    """Follow Civitai's download redirect and return the signed URL it lands on.

    Called once per rental, from manifest assembly only — never from anything
    the studio renders, which would put a third-party request behind a page
    load. The token rides in the QUERY and never in a header: requests carries
    Authorization across the redirect, and R2 then reads it as AWS auth and
    refuses with "Missing x-amz-content-sha256" (the gateway learned this one
    the hard way, see civitai_download_headers).
    """
    token = _civitai_token()
    if not token:
        raise GpuRentalError(
            "This machine has no Civitai token, so the swapped-in checkpoint cannot be "
            "fetched for the box. Add CIVITAI_API_KEY to PassBook and restart the stack.",
            status_code=503,
        )
    params = {"token": token}
    if file_id:
        params["fileId"] = file_id
    url = _CIVITAI_DOWNLOAD_URL.format(version=quote(str(version_id), safe=""))
    # A rate limit is not an answer. Registering ten pinned LoRAs asks Civitai
    # ten times in a burst, and one 429 in that burst used to read as "Civitai
    # will not serve this" — costing a needless upload (measured 2026-09-14,
    # minimax-jav-voice fell back to the bucket and then resolved fine on its
    # own). At RENT time the same 429 would abort a rental outright. So the
    # transient answers are retried and only a definite refusal is returned.
    response = None
    for attempt in range(_CIVITAI_ATTEMPTS):
        try:
            response = requests.get(
                url, params=params,
                headers={"User-Agent": "Hivemind-Studio-Rentals/1.0"},
                allow_redirects=False,
                timeout=_REQUEST_TIMEOUT,
            )
        except requests.RequestException as exc:
            if attempt == _CIVITAI_ATTEMPTS - 1:
                # Context-free on purpose: this is asked at registration, at
                # rental-build save and at rent time, and each caller says what
                # it means there. The pool's own repr stays on the chain for the
                # log ("HTTPSConnectionPool(host='civitai.com'…) Read timed out"),
                # which is a diagnosis, not a sentence anyone can act on.
                raise GpuRentalError(
                    f"Civitai did not answer in time ({_CIVITAI_ATTEMPTS} tries); "
                    "it is usually back within a minute",
                    status_code=503,
                ) from exc
            time.sleep(_CIVITAI_RETRY_SECONDS * (attempt + 1))
            continue
        if response.status_code not in _CIVITAI_TRANSIENT_CODES or attempt == _CIVITAI_ATTEMPTS - 1:
            break
        # Civitai names the wait on a 429; honour it rather than guessing, but
        # never let it hold a rental open for longer than the ladder would.
        try:
            wait = float(response.headers.get("Retry-After") or 0)
        except ValueError:
            wait = 0.0
        time.sleep(min(max(wait, _CIVITAI_RETRY_SECONDS * (attempt + 1)), _CIVITAI_RETRY_CAP_SECONDS))
    location = response.headers.get("Location") or ""
    if response.status_code not in {301, 302, 303, 307, 308} or not location.startswith("https://"):
        # Civitai writes a readable reason for the refusals that matter — Early
        # Access is the common one, and "HTTP 403" tells nobody they need Buzz.
        # Its own sentence first, ours only when it wrote none.
        reason = ""
        try:
            body = response.json()
            reason = str(body.get("message") or body.get("error") or "").strip()
        except Exception:  # noqa: BLE001 - an HTML error page is not a reason
            reason = ""
        raise GpuRentalError(
            f"Civitai will not serve that file: {reason[:120]}"
            if reason else
            f"Civitai refused that file (HTTP {response.status_code}). Check the Civitai "
            "token in PassBook, or pick one with a Hugging Face mirror.",
            status_code=503,
        )
    # The one thing that must never reach a rented box. Measured: it does not,
    # but a manifest is handed to a third party and this costs nothing.
    if token in location:
        raise GpuRentalError("refusing to publish a Civitai URL that carries the token", status_code=500)
    return location


def rental_checkpoint_swaps(tier: str) -> dict[str, dict]:
    """models/ destination -> the swap standing in for it, already validated.

    A row that names no source we can fetch is DROPPED rather than raised on:
    one bad hand-edit must not block every rental of the tier. Nothing here
    touches the network — resolution is manifest-time, and this is read on
    every page render.
    """
    raw = _tier_build(tier).get("checkpoints")
    if not isinstance(raw, dict):
        return {}
    swaps = {}
    for dest, entry in raw.items():
        if not isinstance(entry, dict):
            continue
        url = str(entry.get("url") or "").strip()
        civitai = entry.get("civitai") if isinstance(entry.get("civitai"), dict) else {}
        if _HF_FILE_URL.match(url):
            swaps[str(dest)] = {**entry, "url": url, "civitai": {}}
        elif str(civitai.get("version_id") or "").strip():
            # No URL in the committed file on purpose: a signed one expires, and
            # it is a capability anyone reading the repo could spend.
            swaps[str(dest)] = {**entry, "url": "", "civitai": civitai}
    return swaps


def _resolve_local_checkpoint(model_id: str) -> Path:
    """Absolute path for an installed checkpoint id ("checkpoints/x.safetensors"),
    with the same traversal guard the LoRA path uses."""
    root = COMFY_MODELS_ROOT.resolve()
    candidate = (root / str(model_id or "")).resolve()
    if candidate == root or root not in candidate.parents:
        raise GpuRentalError("refusing to touch a model outside the ComfyUI models directory", status_code=400)
    # The FIRST segment, not the parent directory: the picker lists these trees
    # recursively (a file dropped in checkpoints/ltx/ is a checkpoint), and a
    # guard that only accepted the top level would list files it then refused.
    if candidate.relative_to(root).parts[0] not in RENTAL_CHECKPOINT_SUBDIRS:
        raise GpuRentalError(
            "only a diffusion_models, checkpoints or unet file can stand in for a base weight",
            status_code=400,
        )
    if not candidate.is_file():
        raise GpuRentalError(f"no installed checkpoint named '{model_id}'", status_code=404)
    return candidate


def _read_sidecars(path: Path) -> list[dict]:
    """Both sidecar shapes the media gateway writes, newest convention first."""
    out = []
    for side in (Path(str(path) + ".civitai.json"), path.with_suffix(".metadata.json")):
        try:
            data = json.loads(side.read_text())
        except Exception:
            continue
        if isinstance(data, dict):
            out.append(data)
    return out


def _civitai_file_id(blob: dict, version: dict, path: Path) -> str | None:
    """WHICH file of a Civitai version this local file is, by SHA-256.

    Not optional, and not by name. Civitai version 2961411 ships SIX files all
    called bigLove_klein3.safetensors — the quantisations differ and the names
    do not — so a download without a file id serves the version's primary,
    which on this machine is neither of the two installed builds. The same
    lesson the H3 Eros sourcing ran into: through the API the hashes are the
    only thing that tells two builds of one release apart.

    Returns None when the version has more than one candidate and nothing pins
    this file to one of them — the caller then offers no source at all, rather
    than a confident wrong one. "" means the opposite and is the ordinary case:
    nothing to disambiguate, so the download needs no file id.
    """
    files = version.get("files") if isinstance(version.get("files"), list) else []
    # The .civitai.json shape records the one file it downloaded, directly.
    direct = blob.get("file") if isinstance(blob.get("file"), dict) else {}
    if direct.get("id"):
        return str(direct["id"])
    digest = str(blob.get("sha256") or "").strip().lower()
    if digest:
        for entry in files:
            hashes = entry.get("hashes") if isinstance(entry, dict) else None
            if isinstance(hashes, dict) and str(hashes.get("SHA256") or "").strip().lower() == digest:
                return str(entry.get("id") or "")
    candidates = [entry for entry in files if isinstance(entry, dict) and entry.get("id")]
    if len(candidates) == 1:
        return str(candidates[0]["id"])
    # Last resort: an unambiguous filename match. Useless on the version above,
    # decisive on a version that ships a safetensors and a gguf.
    named = [entry for entry in candidates if str(entry.get("name") or "") == path.name]
    if len(named) == 1:
        return str(named[0]["id"])
    # No file list at all is the older sidecar shape, which only ever recorded
    # one download — there is nothing for it to be ambiguous about.
    return None if candidates else ""


def installed_cloud_source(path: Path) -> dict:
    """Where a rented box could fetch this installed file from.

    Checkpoints and LoRAs are the same question: both are downloaded by the
    media gateway, both get the same two sidecar shapes beside them, and a box
    fetches both the same way.

    Two sources, preferred in this order.

    A Hugging Face URL naming THIS EXACT FILE is best: public, verbatim in the
    manifest, nothing to resolve per rental. The filename check is what makes
    scanning the whole sidecar safe — a description is full of links to other
    weights in the same family, and one of those would land the wrong 20GB file
    under the right name, which no beacon or checksum here would catch.

    Otherwise a Civitai version id, which is resolved to a signed URL at rent
    time (see _civitai_signed_url). `modelUrl` is the page a person reads; the
    ids are what a box is actually fetched with."""
    blobs = _read_sidecars(path)
    for blob in blobs:
        # Searched over the whole sidecar, because the URL can be anywhere in
        # it — a description, a note, a field nobody has seen. The filename
        # check below is what makes that safe; the character class just stops
        # the match at the markup the description is written in.
        for url in re.findall(r"https://huggingface\.co/[^\s\"'<>\\)]+", json.dumps(blob)):
            if _HF_FILE_URL.match(url) and url.rsplit("/", 1)[-1].split("?")[0] == path.name:
                return {"source": "huggingface", "url": url, "modelUrl": "", "civitai": {}}
    for blob in blobs:
        version = blob.get("modelVersion") if isinstance(blob.get("modelVersion"), dict) else blob.get("civitai")
        version = version if isinstance(version, dict) else {}
        model_id = version.get("modelId") or (version.get("model") or {}).get("id")
        if version.get("id"):
            page = f"https://civitai.com/models/{model_id}" if model_id else ""
            if page:
                page = f"{page}?modelVersionId={version['id']}"
            file_id = _civitai_file_id(blob, version, path)
            if file_id is None:
                # A version that ships several files and no way to say which is
                # this one: Civitai would serve its PRIMARY, and the box would
                # get 13GB of the wrong quantisation under the right name. No
                # source at all is better than a confident wrong one.
                return {"source": "", "url": "", "modelUrl": page, "civitai": {}}
            return {
                "source": "civitai",
                "url": "",
                "modelUrl": page,
                "civitai": {"version_id": str(version["id"]), "file_id": file_id},
            }
    return {"source": "", "url": "", "modelUrl": "", "civitai": {}}


def _checkpoint_record(path: Path) -> dict:
    size_bytes = path.stat().st_size
    rel = str(path.relative_to(COMFY_MODELS_ROOT.resolve()))
    return {
        "id": rel,
        "name": path.name,
        "subdir": path.parent.name,
        "size_gb": round(size_bytes / 1e9, 2),
        "size_bytes": size_bytes,
        **installed_cloud_source(path),
    }


def list_installed_checkpoints() -> dict:
    """Every installed base weight, each with the cloud source a rented box
    would have to fetch it from. Files with no source are listed too — the
    swap picker says why one cannot be used rather than hiding it."""
    root = COMFY_MODELS_ROOT.resolve()
    records = []
    for subdir in RENTAL_CHECKPOINT_SUBDIRS:
        folder = root / subdir
        if not folder.is_dir():
            continue
        for path in sorted(folder.rglob("*.safetensors")):
            if path.is_file():
                records.append(_checkpoint_record(path))
    records.sort(key=lambda item: (item["subdir"], item["name"].lower()))
    return {"checkpoints": records}


def tier_base_weights(tier: str) -> list[dict]:
    """The tier's swappable default weights, in the order it downloads them."""
    spec = TIERS[tier]
    swaps = rental_checkpoint_swaps(tier)
    rows = []
    for object_key, subdir in spec["models"]:
        filename = object_key.rsplit("/", 1)[-1]
        rows.append((subdir, filename, MODEL_SIZE_GB.get(object_key, 2.0), "bucket"))
    for _url, subdir, filename, size_gb in spec.get("public_models") or []:
        rows.append((subdir, filename, size_gb, "upstream"))
    out = []
    for subdir, filename, size_gb, origin in rows:
        if subdir not in RENTAL_CHECKPOINT_SUBDIRS:
            continue
        dest = f"{subdir}/{filename}"
        out.append({
            "dest": dest,
            "filename": filename,
            "subdir": subdir,
            "size_gb": size_gb,
            "origin": origin,
            "swap": swaps.get(dest),
        })
    return out


def rental_build_payload() -> dict:
    """Everything the studio's rental-build page draws, in one call."""
    tiers = []
    for tier, spec in TIERS.items():
        tiers.append({
            "tier": tier,
            "label": spec["label"],
            "family": spec["family"],
            "family_detail": spec["family_detail"],
            "lora_base_models": list(spec.get("lora_base_models") or []),
            "pinned_loras": pinned_rental_loras(tier),
            "weights": tier_base_weights(tier),
            "download_gb": tier_download_gb(tier),
            "disk_gb": tier_disk_gb(tier),
        })
    return {
        "editable": rental_build_is_editable(),
        "path": str(RENTAL_BUILD_PATH),
        "tiers": tiers,
    }


def _rental_build_tier_row(tier: str) -> dict:
    payload = rental_build_payload()
    row = next((entry for entry in payload["tiers"] if entry["tier"] == tier), None)
    return {"editable": payload["editable"], "path": payload["path"], "tier": row}


def _mutate_rental_build(tier: str, mutate) -> dict:
    """Read-modify-write one tier under the lock, pruning what it emptied.

    An entry that ends up with neither pins nor swaps is REMOVED rather than
    left as `{}` — an empty object in a committed file reads like a decision
    and is not one."""
    if tier not in TIERS:
        raise GpuRentalError(f"unknown rental tier '{tier}'", status_code=404)
    with _rental_build_lock:
        data = read_rental_build()
        entry = data["tiers"].get(tier)
        entry = dict(entry) if isinstance(entry, dict) else {}
        mutate(entry)
        for key in ("loras", "checkpoints"):
            if key in entry and not entry[key]:
                entry.pop(key)
        if entry:
            data["tiers"][tier] = entry
        else:
            data["tiers"].pop(tier, None)
        data.setdefault("version", 1)
        _write_rental_build(data)
    return _rental_build_tier_row(tier)


def set_rental_build_loras(tier: str, lora_ids: list[str]) -> dict:
    """Pin exactly these installed LoRAs to a tier, and make sure they can land.

    A pin is intent; the bytes still have to be in the bucket. So anything
    pinned here that is not already registered is registered and uploaded on
    the spot — a pin that silently never ships would be the worst of both
    files. The rating the registry asks for is categorisation only today, so it
    is taken from the tier rather than from a second question per card: the
    NSFW tier's adapters are nsfw, everything else sfw. Un-pinning leaves the
    registry (and the uploaded object) alone: another tier may still want it,
    and re-pinning is then free."""
    if tier not in TIERS:
        raise GpuRentalError(f"unknown rental tier '{tier}'", status_code=404)
    wanted = []
    for value in lora_ids or []:
        lora_id = str(value or "").strip()
        if lora_id and lora_id not in wanted:
            wanted.append(lora_id)
    registry = read_rental_loras()
    rating = "nsfw" if "nsfw" in str(TIERS[tier]["label"]).lower() else "sfw"
    for lora_id in wanted:
        entry = registry.get(lora_id)
        if entry and entry.get("status") in {"ready", "uploading"}:
            continue
        path = _resolve_local_lora(lora_id)
        add_rental_lora(
            lora_id,
            str((entry or {}).get("rating") or rating),
            _sidecar_base_model(path),
            path.stem,
            list(TIERS[tier].get("lora_base_models") or []),
        )
    return _mutate_rental_build(tier, lambda entry: entry.__setitem__("loras", wanted))


def set_rental_build_checkpoint(tier: str, dest: str, model_id: str, url: str = "") -> dict:
    """Stand an installed checkpoint in for one of a tier's default weights.

    It lands on the box under the DEFAULT's filename, so every graph that names
    that weight keeps working untouched — the swap is one file, not a second
    lane. An empty model id clears the swap.

    The checkpoint has to name a source a box can reach: a public Hugging Face
    file URL (used verbatim), or a Civitai version (resolved to a signed URL at
    rent time). `url` overrides both — the mirror for a file whose sidecar
    names none."""
    if tier not in TIERS:
        raise GpuRentalError(f"unknown rental tier '{tier}'", status_code=404)
    dest = str(dest or "").strip()
    if dest not in {row["dest"] for row in tier_base_weights(tier)}:
        raise GpuRentalError(f"'{dest}' is not a base weight this tier serves", status_code=400)
    if not str(model_id or "").strip():
        return _mutate_rental_build(
            tier,
            lambda entry: entry.__setitem__(
                "checkpoints", {k: v for k, v in (entry.get("checkpoints") or {}).items() if k != dest},
            ),
        )
    path = _resolve_local_checkpoint(model_id)
    record = _checkpoint_record(path)
    swap = {
        "id": record["id"],
        "filename": path.name,
        "size_gb": record["size_gb"],
        "added_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    pasted = str(url or "").strip()
    if pasted and not _HF_FILE_URL.match(pasted):
        # Under 220 characters and free of paths, braces and newlines ON PURPOSE:
        # describeFailure demotes anything longer or more technical to "…failed"
        # and hides the rest behind Details, which is exactly where the fix
        # would stop being read. The file it refers to is on screen beside it.
        raise GpuRentalError(
            "That is not a Hugging Face file URL. It has to name the file itself — "
            ".../resolve/main/<name>.safetensors — not the page the model lives on.",
            status_code=400,
        )
    if pasted or record["source"] == "huggingface":
        swap["source"] = "huggingface"
        swap["url"] = pasted or record["url"]
    elif record["civitai"].get("version_id"):
        # Resolve it ONCE here, and throw the answer away. Not every file on
        # Civitai is servable to this account — Early Access ones answer 403
        # with "you can use Buzz to access it now" — and finding that out at
        # rent time means a box that is already billing. The refusal carries
        # Civitai's own sentence. Access can still change between now and the
        # next rental, so the rent-time resolution stays too; this only makes
        # the common failure land where the decision is made.
        _civitai_signed_url(
            str(record["civitai"]["version_id"]),
            str(record["civitai"].get("file_id") or ""),
        )
        # Stable ids, never a signed URL: one expires, and both are things a
        # commit should not carry. The redirect is followed again per rental.
        swap["source"] = "civitai"
        swap["civitai"] = record["civitai"]
    else:
        raise GpuRentalError(
            "That checkpoint has no Civitai or Hugging Face metadata, so a rented box has "
            "nowhere to fetch it from. Paste the Hugging Face URL that serves this exact file.",
            status_code=400,
        )

    def apply(entry: dict) -> None:
        entry["checkpoints"] = {**(entry.get("checkpoints") or {}), dest: swap}

    return _mutate_rental_build(tier, apply)

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


SEEDVR2_TRT_NODE_SOURCE = (
    Path(__file__).resolve().parents[2]
    / "packages/comfyui-custom-nodes/hivemind-seedvr2-trt"
)
SEEDVR2_TRT_NODE_FILES = ("__init__.py", "trt_vae.py", "rank_patch.py", "trt_engine.py")


def _seedvr2_trt_node_archive() -> bytes:
    """The TensorRT node pack as one tar.gz, for a box to fetch at boot.

    NOT inlined in the onstart the way hivemind_privacy is. Vast caps the whole
    onstart at VAST_ONSTART_LIMIT and this pack is ~13.5KB even gzipped and
    base64'd — it would eat most of the budget on its own and push the video
    tiers straight past the cap, which Vast rejects with a generic "Invalid
    args" 400. Published like the weights manifest instead: the onstart carries
    one presigned URL, and the same daily sweep deletes it.
    """
    import io
    import tarfile

    buffer = io.BytesIO()
    # mtime=0 so the same source always produces the same bytes — an archive
    # that differs on every rent is a diff nobody can read.
    with tarfile.open(fileobj=buffer, mode="w:gz", compresslevel=9) as archive:
        for name in SEEDVR2_TRT_NODE_FILES:
            body = SEEDVR2_TRT_NODE_SOURCE.joinpath(name).read_bytes()
            info = tarfile.TarInfo(name)
            info.size = len(body)
            info.mtime = 0
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(body))
    return buffer.getvalue()


# Where the node archive lands among the weights, so it rides the manifest.
SEEDVR2_TRT_ARCHIVE_DEST = "Other/hivemind-seedvr2-trt.tar.gz"


def tier_installs_seedvr2_trt(tier: str) -> bool:
    """Which tiers carry the restorer and its TensorRT accelerator.

    One question, not two: a tier either serves the Restore studio — the node
    pack, the ~9GB of weights and the accelerator — or it does not. Splitting
    them is how a box came to advertise restoration with no restorer on it.

    Which is why only the VIDEO tier does. Not a capability limit: the minimax
    tier's Blackwell 32GB+ boxes would be the best restore hardware we rent. It
    is an onstart budget. Vast caps provisioning at VAST_ONSTART_LIMIT and,
    measured 2026-08-31, the minimax onstart had 2089 characters to spare
    against the 2000 the size guard pins — the restorer's clone and pin alone
    are ~350 of them. A second model stack does not fit, and quietly spending
    the last of a shared budget is not a trade worth making silently.

    To change it: slim the minimax onstart — its largest single item is the
    inlined privacy node (~4.1KB packed), which could ride the weights manifest
    the way the TensorRT archive now does — then add "restore" to that tier's
    studio_pages and "seedvr2" to its lane_needles. The test suite pins all
    three together, so they cannot drift apart again.
    """
    return "restore" in (TIERS[tier].get("studio_pages") or [])


def _torch_cu130_lines(total: int) -> list[str]:
    """Put the box on a CUDA 13 torch, because below it EVERY quantized model
    on this stack runs on an unoptimized fallback.

    comfy/quant_ops.py does exactly this at import:

        if tuple(map(int, str(torch.version.cuda).split('.'))) < (13,):
            ck.registry.disable("cuda")

    That one line turns off comfy-kitchen's CUDA backend, which is what
    supplies int8_linear, dequantize_int8_convrot_weight, scaled_mm_nvfp4 and
    sol_attn. So the H3 tier's int8_convrot DiT, its nvfp4 text encoder and the
    int8_convrot video VAE all fall back to dequantize-then-compute.

    MEASURED 2026-09-18 on one rented 5090 (vast:51438645), same seeds, same
    graph, warm, only torch changed — a 5s 960x544 clip end to end:

        torch 2.10.0+cu128   int8 VAE 123.5s   fp16 VAE 113.0s
        torch 2.14.0+cu130   int8 VAE  48.4s   fp16 VAE  48.5s

    i.e. ~2.3x on every H3 render. Isolated, the VAE decode alone goes 12.10s ->
    2.38s and its working set 1.55GiB -> 0.52GiB. Both images we rent ship below
    the line (Vast's automatic tag gave cu128; the RunPod pin names cuda-12.9),
    so this has been costing every H3 rental since the tier existed.

    Nothing here is fatal. A box that cannot reach the torch index is slow, not
    broken, and a slow box still renders — so a failure logs and carries on with
    whatever torch the image shipped.

    torchvision and torchaudio are upgraded WITH torch, never after: they pin an
    exact torch build, and a lone torch bump leaves `import torchvision` raising
    "operator torchvision::nms does not exist", which ComfyUI cannot start past.

    Kept deliberately terse: Vast caps the onstart at 16KB and the headroom
    guard in the test suite pins the slack, so the reasoning lives up here
    (free) rather than in emitted bash (not free).
    """
    return [
        # torch.version.cuda is None on a CPU build; "0" makes that read as too
        # old and lets the install decide, instead of indexing into None.
        "C=$(python -c \"import torch;print((torch.version.cuda or '0').split('.')[0])\""
        " 2>/dev/null||echo 0)",
        # All three in ONE pip command, never torch alone: they pin each other,
        # and a half-applied upgrade leaves `import torchvision` raising
        # "operator torchvision::nms does not exist", which ComfyUI cannot start
        # past. `||true` because a box that could not reach the index is slow,
        # not broken, and a slow box still renders.
        # One f-string for the whole command. Written as an f-prefixed head and
        # plain concatenated tails it emitted `; }}` — the f prefix applies PER
        # LITERAL, so the closing `}}` in a non-f tail stays two characters and
        # the onstart dies with "syntax error: unexpected end of file".
        # -U is load-bearing, not tidiness. Without it pip reads the bare
        # requirement `torch` as already satisfied by the cu128 build the image
        # ships, prints nothing under -q, exits 0, and the whole upgrade is a
        # SILENT no-op — measured on vast:51471250, where the beacon announced
        # the upgrade and the box stayed on 2.10.0+cu128.
        f'[ "${{C:-0}}" -lt 13 ] && {{ beacon torch {total} "Upgrading torch to CUDA 13";'
        f" pip install -qU --index-url https://download.pytorch.org/whl/cu130"
        f" torch torchvision torchaudio >/root/torch.log 2>&1||true; }}",
    ]


def _seedvr2_trt_install_lines(tier: str) -> list[str]:
    """Unpack the TensorRT VAE node and install its runtime. Nothing is fatal.

    The ARCHIVE arrives through the weights manifest rather than through a URL
    of its own — measured 2026-08-31, a second presigned URL costs ~965 chars of
    onstart and the minimax tier had 2089 to spare, which would have taken it
    under the headroom the size guard pins. The manifest already carries one URL
    for everything a box downloads; this is one more row in it.

    Runs BEFORE ComfyUI launches, because custom nodes are scanned once at
    startup, and AFTER dlwait, because the archive is one of the files dlwait
    waits for.

    torch-tensorrt is best effort. A box that restores at 1.0x is a working box;
    a box that refuses to boot because an optional accelerator would not install
    is a wasted rent.
    """
    if not tier_installs_seedvr2_trt(tier):
        return []
    target = "/workspace/ComfyUI/custom_nodes/hivemind-seedvr2-trt"
    return [
        # `|| rm -rf` rather than an on-box syntax check: a half-extracted node
        # breaks ComfyUI's whole custom-node scan, and tar already fails on a
        # damaged archive. That the archive's members PARSE is proved in the
        # repo, before one is ever published (test_gpu_rentals_api.py).
        f'mkdir -p {target} && tar -xzf "$M/{SEEDVR2_TRT_ARCHIVE_DEST}" -C {target} || rm -rf {target}',
        # tensorrt-rtx, NOT torch-tensorrt. The node builds engines by handing
        # an ONNX graph to TensorRT's own parser; it never uses PyTorch's
        # compiler, which is what failed three different ways on rented 5090s
        # (see the history in the node's trt_vae.py).
        #
        # Installed with a torch constraint anyway. Measured 2026-08-31: a bare
        # `pip install torch-tensorrt` upgraded torch 2.10.0+cu130 -> 2.13.0,
        # stranded torchvision, and ComfyUI died on `operator torchvision::nms
        # does not exist` — the box then hung forever in the launch wait below,
        # billing. `|| true` did not help and could not: pip SUCCEEDED; the
        # environment broke. Any pip install into this shared venv can move
        # torch, so every one of them is constrained.
        'V=$(/venv/main/bin/python -c "import torch;print(torch.__version__)")',
        'printf "torch==%s\\n" "$V" > /tmp/torch-pin.txt',
        '/venv/main/bin/pip install -q -c /tmp/torch-pin.txt tensorrt-rtx onnx || '
        '/venv/main/bin/pip install -q -c /tmp/torch-pin.txt tensorrt onnx || true',
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


def _download_lib_lines(
    *,
    floor: int = DOWNLOAD_MIN_BYTES_PER_SEC,
    stall: int = DOWNLOAD_STALL_SECONDS,
    conns: int = DOWNLOAD_CONNECTIONS,
    split: int = DOWNLOAD_SPLIT_MIN_BYTES,
    chunk: int = DOWNLOAD_CHUNK_BYTES,
    tries: int = DOWNLOAD_STREAM_ATTEMPTS,
    pause: int | float = DOWNLOAD_RETRY_PAUSE_SECONDS,
    patience: int = DOWNLOAD_STREAM_PATIENCE_SECONDS,
    connect_timeout: int = DOWNLOAD_CONNECT_TIMEOUT_SECONDS,
    deadline: int = DOWNLOAD_DEADLINE_SECONDS,
    poll: int | float = DOWNLOAD_POLL_SECONDS,
) -> list[str]:
    """The bash that fetches the weights on a rented box.

    Five functions, bash-3.2 clean so the test suite can run them on a Mac
    against a fault-injecting HTTP server, and compact because every byte
    competes with presigned URLs for Vast's 16KB onstart field:

    - c        every transfer: follow redirects, fail on HTTP errors, bound the
               connect, and cut a connection under the liveness floor.
    - plen     the object's length from a ONE-BYTE RANGED GET. Not a HEAD: R2
               returns 403 to a HEAD on a GET-presigned URL, which is what made
               every R2 weight single-stream until 2026-08-22. Asked up to
               three times unless the answer is a permanent 4xx: one missed
               probe used to demote a 15GB weight to a single stream, silently.
    - stream   one ranged connection, retried on any error and RESUMED from the
               part's own length — curl's --retry neither resumes nor covers
               connection resets. Permanent 4xx answers fail at once. A server
               that ignores the range gets a marker so pget can fall back.
    - plain    one connection with no resume, for a server that gave no length.
    - wk       one pool worker: claims the next unclaimed chunk (mkdir is the
               atomic lock) and streams it, until none are left or its stream
               gives up.
    - pget     the whole object: split into CHUNK pieces pulled by CONNS
               workers when it is long enough and the length is known; each
               piece is written into the object at its own offset as soon as
               it lands (no serial copy at the end) and the object is moved
               into place only when every piece is marked done and the length
               verifies, so a partial is never counted as a model. On failure
               $dest.err says what happened.
    - dlstart  <manifest> <models-dir>: one pget per manifest line, FILES
               set for dlwait. A file already at its full size is skipped.
    - dlwait   the watcher: publishes progress — the file being fetched, the
               bytes landed so far across every fetch and the rate since the
               last poll — until every file exists, and otherwise leaves
               through the beacon with the cause. Running jobs are sampled
               BEFORE the files are counted, so a fetch that lands between the
               two reads is never called a failure.
    """
    # bash arithmetic is integer-only: a fractional pause would make `again`
    # error out and the stream die without writing its .err.
    pause = int(pause)
    # Written flat and terse on purpose: the whole onstart must fit Vast's 16KB
    # field alongside ~400 chars per presigned URL, and the minimax tier with
    # one registered LoRA already sits within a few hundred chars of it.
    # Helpers: sz <file> (bytes, 0 when absent), pn <dest> <i> (part name),
    # again <file> <rc> <code> <attempt> (0 = pause and retry; 1 = gave up and
    # wrote <file>.err — permanent HTTP 400-407/409-419, or attempts exhausted).
    return [
        f'c() {{ curl -sfL --connect-timeout {connect_timeout} --speed-limit {floor} --speed-time {stall} "$@"; }}',
        'sz() { [ -f "$1" ] && wc -c < "$1" | tr -d " " || echo 0; }',
        "pn() { printf '%s.part%04d' \"$1\" $2; }",
        # The probe's status rides on its last line (-w), so a permanent 4xx
        # is told apart from a moment's trouble: the first is final, the
        # second is asked again.
        "plen() { a=0; while :; do o=$(c -r 0-0 -o /dev/null -D - --max-filesize 1048576"
        " -w '\\n%{http_code}' \"$1\"); n=$(printf %s \"$o\" | tr -d '\\r'"
        " | awk 'tolower($1)==\"content-range:\"{sub(/.*\\//,\"\",$3); n=$3} END{print n}')"
        '; [ -n "$n" ] && { echo "$n"; return; }; hc=${o##*$\'\\n\'}'
        "; case $hc in 40[0-79]|41[0-9]) return;; esac; a=$((a+1)); [ $a -ge 3 ] && return; sleep 1; done; }",
        # again <file> <rc> <code> <attempt> <ip|seconds>: 0 = paused, try
        # again; 1 = gave up and wrote <file>.err. Gives up on a permanent 4xx,
        # after PATIENCE seconds of consecutive failure (f0 = first failure;
        # each stream is its own subshell, so the variable is per stream), at
        # the phase deadline (DL_DEADLINE, exported by the onstart before the
        # fetchers fork), or at the hard attempt cap — whichever comes first.
        # W is curl's write-out: status, the peer it was talking to, seconds.
        "W='%{http_code}|%{remote_ip}|%{time_total}'",
        'again() { case $3 in 40[0-79]|41[0-9]) echo "http $3" > "$1.err"; return 1;; esac',
        'now=$(date +%s); [ $f0 -eq 0 ] && f0=$now; v=${5/|/ in }',
        f'[ $((now-f0)) -ge {patience} ] || [ $4 -ge {tries} ] || {{ [ -n "${{DL_DEADLINE:-}}" ] && [ $now -ge $DL_DEADLINE ]; }}'
        ' && { echo "curl $2 http $3 via ${v}s after $4 tries/$((now-f0))s" > "$1.err"; return 1; }',
        f'pz=$(($4*{pause})); [ $pz -gt {pause * 6} ] && pz={pause * 6}; sleep $pz; }}',
        "stream() { u=$1; p=$2; s=$3; e=$4; n=$((e-s+1)); a=0; f0=0",
        'while :; do h=$(sz "$p"); [ $h -ge $n ] && return 0',
        'o=$(c -r "$((s+h))-$e" -o "$p.tmp" -w "$W" "$u"); rc=$?; hc=${o%%|*}',
        'case $hc in 206) cat "$p.tmp" >> "$p";;'
        ' 200) [ $s -eq 0 ] || { rm -f "$p.tmp"; : > "$p.nr"; return 2; }; mv "$p.tmp" "$p";; esac',
        'rm -f "$p.tmp"; [ $rc -eq 0 ] && continue',
        'a=$((a+1)); again "$p" $rc $hc $a "${o#*|}" || return 1; done; }',
        "plain() { u=$1; d=$2; a=0; f0=0",
        'while :; do o=$(c -o "$d.dl" -w "$W" "$u"); rc=$?; hc=${o%%|*}',
        '[ $rc -eq 0 ] && { mv "$d.dl" "$d"; return 0; }',
        'rm -f "$d.dl"; a=$((a+1)); again "$d" $rc $hc $a "${o#*|}" || return 1; done; }',
        # wk <url> <dest> <chunk> <chunks> <len>: claim chunk j with mkdir (atomic
        # on every filesystem we land on), stream it, move on; stop when a
        # stream gives up (its .err is the file's verdict below) or says the
        # server ignored the range (.nr).
        # A finished piece is written into the object at its offset (dd, block
        # = piece size, so seek is the piece index) and dropped, by the worker
        # that fetched it: the object is assembled WHILE the pull runs, not
        # copied whole afterwards — on a network volume that serial copy was
        # minutes of "0MB/s" after the last byte landed (stocker 2026-08-22).
        'wk() { u=$1; d=$2; k=$3; m=$4; len=$5; j=0; while [ $j -lt $m ]; do mkdir "$d.c$j" 2>/dev/null || { j=$((j+1)); continue; }'
        '; s=$((j*k)); e=$((s+k-1)); [ $e -ge $len ] && e=$((len-1)); p=$(pn "$d" $j); stream "$u" "$p" $s $e || return'
        '; if [ $m -eq 1 ]; then mv "$p" "$d.dl"; else dd if="$p" of="$d.dl" bs=$k seek=$j conv=notrunc 2>/dev/null && rm -f "$p"; fi'
        ' && : > "$p.ok" || { echo "assemble $j" > "$p.err"; return 1; }; j=$((j+1)); done; }',
        'pget() { u=$1; d=$2; rm -rf "$d".part* "$d".c[0-9]* "$d.dl" "$d.err"; len=$(plen "$u")',
        'case "$len" in ""|*[!0-9]*) plain "$u" "$d"; return;; esac',
        f"n={conns}; k={chunk}; [ $len -lt {split} ] && n=1",
        # One stream means one chunk, the whole object: that is also the
        # fallback for a server that stops honouring ranges mid-way.
        "while :; do [ $n -eq 1 ] && k=$len; m=$(((len+k-1)/k)); i=0",
        'while [ $i -lt $n ]; do wk "$u" "$d" $k $m $len & i=$((i+1)); done; wait',
        'set -- "$d".part*.nr; [ -e "$1" ] && { rm -rf "$d".part* "$d".c[0-9]* "$d.dl"; n=1; continue; }',
        # Every piece must have been written in (its .ok marker), and the
        # object must be exactly the probed length; then and only then is it
        # moved into place. A piece's .err is the file's verdict.
        'bad=""; j=0',
        'while [ $j -lt $m ]; do p=$(pn "$d" $j); [ -e "$p.ok" ] || { bad="part $j"; [ -s "$p.err" ] && bad="part $j: $(cat "$p.err")"; break; }; j=$((j+1)); done',
        '[ -z "$bad" ] && [ "$(sz "$d.dl")" = "$len" ] && { mv "$d.dl" "$d"; rm -rf "$d".part* "$d".c[0-9]*; return 0; }',
        'rm -rf "$d".part* "$d".c[0-9]* "$d.dl"; echo "${bad:-size mismatch}" > "$d.err"; return 1; done; }',
        "dlstart() { FILES=(); while IFS=$'\\t' read -r u d; do [ -n \"$d\" ] || continue; FILES+=(\"$2/$d\")"
        '; mkdir -p "$2/${d%/*}"; [ -s "$2/$d" ] || pget "$u" "$2/$d" & done < "$1"; }',
        # One exit for both ways a download can end badly. Says "destroy it"
        # because there is no repair path: the presigned URLs expire, and a
        # half-provisioned box that launches ComfyUI anyway just fails later,
        # at generate time, where the cause is far harder to see.
        'dlfail() { beacon error "$dn" "download $1 at $dn/$t: ${why:-$cur} — destroy this machine and rent another"; exit 1; }',
        # The detail while fetching: "<file> <GB landed across every fetch>
        # <MB/s since the last poll>" — the two numbers this provisioning was
        # blind to when one file crawled for 25 minutes. Part sizes are read
        # with wc -c (stat, not a read) and the last line wins whether it is
        # one file's or the total's. Empty once everything has landed.
        "dlwait() { dl=$1; shift; t=$#; pb=0; pt=$(date +%s)",
        'while :; do run=$(jobs -r); dn=0; cur=""; why=""; cb=0',
        'for f in "$@"; do if [ -s "$f" ]; then dn=$((dn+1)); else [ -z "$cur" ] && cur=${f##*/}'
        "; cb=$((cb+$(wc -c \"$f\".part* \"$f.dl\" 2>/dev/null | awk '{s=$1} END{print s+0}')))"
        '; [ -s "$f.err" ] && why="$why${why:+; }${f##*/} ($(cat "$f.err"))"; fi; done',
        'now=$(date +%s); r=$(((cb-pb)/(now-pt+1)/1048576)); [ $r -lt 0 ] && r=0; pb=$cb; pt=$now',
        'beacon downloading "$dn" "${cur:+$cur $((cb/1073741824)).$((cb%1073741824*10/1073741824))GB ${r}MB/s}"; [ $dn -eq $t ] && return 0',
        f'[ -z "$run" ] && dlfail "failed"; [ "$(date +%s)" -ge "$dl" ] && dlfail "stalled {deadline // 60}min"; sleep {poll}; done; }}',
    ]


# --- the weights manifest --------------------------------------------------
# The list of weights a box must fetch does NOT live in the onstart. Vast caps
# the onstart at 16KB and a presigned URL is ~400 chars, so with the list
# inline the MiniMax tier could carry about two registered user LoRAs before
# renting was refused — a cap nobody asked for. The onstart now carries ONE
# presigned URL to a small manifest in the private bucket; the box fetches it,
# caches it on /workspace (a paused-then-resumed box reruns its onstart after
# the presigns have expired, and still has to know its file list), and starts
# the same pget jobs from it. Size of the onstart is independent of how many
# weights or LoRAs a tier serves.
#
# Manifest format: one line per weight, `<url>\t<subdir>/<filename>`, the
# path relative to ComfyUI's models/ directory. Tabs because neither a
# presigned URL nor a model filename contains one.
RENTAL_MANIFEST_PREFIX = "rental-manifests/"
# A manifest is useful for as long as the presigns inside it — 3h — plus the
# box's own retry window; after a day it is litter, and the next rent sweeps
# it. Tracked locally by key (no bucket listing needed): rental-manifests.json.
RENTAL_MANIFEST_TTL_SECONDS = 24 * 3600


def tier_download_rows(tier: str) -> list[dict]:
    """Every weight a fresh box pulls for this tier, ONCE per destination.

    One list behind both the manifest and the size math. Two reasons it is a
    function rather than two loops that happen to agree:

    * A LoRA pinned to a tier that ALREADY serves it from its curated set (the
      Anima turbo LoRA is in the image set AND installed locally) would
      otherwise be two rows landing on the same path — the same bytes fetched
      twice, counted twice in the beacon total, and charged twice to the disk
      the box is rented with. First row wins: the curated copy is the one the
      tier was tuned against, and the file is the same either way.
    * A checkpoint swap replaces a row IN PLACE, under the default weight's
      filename, so every graph naming that weight keeps resolving on the box.

    Each row is {dest, key, url, civitai, size_gb, optional} and names exactly one source:
    `key` (an object in our bucket, presigned at manifest time), `url` (fetched
    from upstream verbatim) or `civitai` (ids whose signed URL is resolved at
    manifest time). Nothing here touches the network — this is read on every
    render of the rental-build page.
    """
    spec = TIERS[tier]
    swaps = rental_checkpoint_swaps(tier)
    rows: list[dict] = []
    seen: set[str] = set()

    def add(dest: str, *, key: str = "", url: str = "", civitai: dict | None = None,
            size_gb: float = 2.0, optional: bool = False) -> None:
        if dest in seen:
            return
        seen.add(dest)
        swap = swaps.get(dest)
        if swap:
            rows.append({
                "dest": dest, "key": "", "url": swap.get("url") or "",
                "civitai": swap.get("civitai") or {},
                "size_gb": float(swap.get("size_gb") or 2.0),
                # A swap stands in for a DEFAULT weight every graph names, so it
                # is never optional: a box without it cannot run the tier.
                "optional": False,
            })
        else:
            rows.append({
                "dest": dest, "key": key, "url": url,
                "civitai": dict(civitai or {}), "size_gb": float(size_gb),
                "optional": bool(optional),
            })

    for object_key, subdir in spec["models"]:
        add(
            f"{subdir}/{object_key.rsplit('/', 1)[-1]}",
            key=object_key,
            size_gb=MODEL_SIZE_GB.get(object_key, 2.0),
        )
    # Registered user LoRAs shape the bandwidth floor exactly like the curated
    # set does, and land at the same relative path the graph names them by.
    for lora in _rental_lora_downloads(tier):
        # Optional: a LoRA is an add-on a generation asks for by name. A box
        # without one still runs the tier — unlike a base weight, whose absence
        # breaks every graph — so a miss is named in the rent notice instead of
        # refusing the rental.
        add(lora["dest"], key=lora["key"], civitai=lora["civitai"], size_gb=lora["size_gb"],
            optional=True)
    for url, subdir, filename, size_gb in spec.get("public_models") or []:
        add(f"{subdir}/{filename}", url=url, size_gb=size_gb)
    return rows


def _rental_manifest(tier: str, *, skipped: list | None = None,
                     strict: bool = False) -> tuple[str, int]:
    """The tab-separated manifest for a tier, and how many weights it names.

    The tier's curated serving set plus every user LoRA registered for it,
    each as a presigned GET on the private bucket, then the public upstream
    weights verbatim — all counted in the same beacon total and landed by the
    same pget (verified length, atomic move, never a partial counted).
    """
    download_rows = tier_download_rows(tier)
    # The one hop that leaves this machine at rent time: Civitai's redirect,
    # followed here so the box receives a signed URL and never a token. Asked
    # for every Civitai row AT ONCE, then applied in manifest order.
    #
    # It used to be one row at a time with each able to raise, which made the
    # rental only as reliable as its least reliable add-on: measured 2026-09-14,
    # ten LoRAs pinned to minimaxeros, ONE read timeout, and the whole rental
    # refused with "Civitai did not answer: HTTPSConnectionPool(…) Read timed
    # out" while the box, the base model and the other nine were all fine.
    pending = [(index, row) for index, row in enumerate(download_rows) if not row["url"] and row["civitai"]]
    answers: dict[int, Any] = {}
    if pending:
        with ThreadPoolExecutor(max_workers=min(_CIVITAI_PARALLEL, len(pending))) as pool:
            futures = {
                index: pool.submit(
                    _civitai_signed_url,
                    str(row["civitai"].get("version_id") or ""),
                    str(row["civitai"].get("file_id") or ""),
                )
                for index, row in pending
            }
            for index, future in futures.items():
                try:
                    answers[index] = future.result()
                except GpuRentalError as exc:
                    answers[index] = exc
    rows: list[tuple[str, str]] = []
    for index, row in enumerate(download_rows):
        if row["url"]:
            source = row["url"]
        elif row["civitai"]:
            answer = answers[index]
            if isinstance(answer, GpuRentalError):
                # An add-on is left off THIS box and the rental goes ahead; the
                # caller names it. A required weight still refuses — before a
                # box is paid for — and so does anything while `strict`, which
                # is warm-volume stocking: a volume stocked without a file hands
                # that gap to every warm box after it, and none re-download.
                if row.get("optional") and not strict:
                    if skipped is not None:
                        skipped.append({"lora": row["dest"].removeprefix("loras/"), "reason": str(answer)})
                    continue
                raise answer
            source = answer
        else:
            source = _presign_r2_get(row["key"])
        rows.append((source, row["dest"]))
    if tier_installs_seedvr2_trt(tier):
        # Not a weight, but a file the box must have before ComfyUI starts, and
        # the manifest is the one channel that costs the onstart nothing per
        # file. Counted in the beacon total like everything else it downloads,
        # because it IS something it downloads.
        rows.append((
            _publish_rental_object(
                _seedvr2_trt_node_archive(),
                suffix=".tar.gz",
                content_type="application/gzip",
                label="TensorRT node pack",
            ),
            SEEDVR2_TRT_ARCHIVE_DEST,
        ))
    for url, dest in rows:
        if "\t" in url or "\t" in dest or "\n" in url or "\n" in dest:
            raise GpuRentalError(f"weight entry is not manifest-safe: {dest}", status_code=500)
    return "".join(f"{url}\t{dest}\n" for url, dest in rows), len(rows)


def _manifest_state_path() -> Path:
    return MEDIA_STATE_ROOT / "rental-manifests.json"


def _read_manifest_state() -> dict:
    try:
        state = json.loads(_manifest_state_path().read_text())
    except Exception:
        state = {}
    state.setdefault("keys", {})
    return state


def _prune_rental_manifests(now: float | None = None) -> list[str]:
    """Delete manifests older than RENTAL_MANIFEST_TTL_SECONDS. Best effort:
    a manifest that will not delete is re-tried next time, never fatal."""
    state = _read_manifest_state()
    now = time.time() if now is None else now
    removed = []
    for key, created in list(state["keys"].items()):
        if now - float(created or 0) < RENTAL_MANIFEST_TTL_SECONDS:
            continue
        try:
            response = requests.delete(_presign_r2("DELETE", key), timeout=_REQUEST_TIMEOUT)
        except Exception:  # noqa: BLE001 - network: try again next rent
            continue
        if response.status_code < 400 or response.status_code == 404:
            state["keys"].pop(key, None)
            removed.append(key)
    MEDIA_STATE_ROOT.mkdir(parents=True, exist_ok=True)
    _manifest_state_path().write_text(json.dumps(state, indent=1))
    return removed


def _publish_rental_object(data: bytes, *, suffix: str, content_type: str, label: str) -> str:
    """PUT one boot-time payload to the private bucket; return a presigned GET.

    Raises GpuRentalError when the bucket refuses — a box that cannot fetch what
    it was rented to run is a box that bills for nothing, so renting stops here.

    Tracked in the same manifest state as everything else published for a boot,
    so the same sweep deletes it: a payload lives as long as the presigns inside
    it and is litter afterwards.
    """
    _prune_rental_manifests()
    key = f"{RENTAL_MANIFEST_PREFIX}{datetime.now(timezone.utc):%Y%m%d}/{uuid.uuid4().hex}{suffix}"
    try:
        response = requests.put(
            _presign_r2("PUT", key),
            data=data,
            headers={"Content-Type": content_type},
            timeout=_REQUEST_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise GpuRentalError(f"could not publish the {label} to R2: {exc}", status_code=503) from exc
    if response.status_code >= 400:
        raise GpuRentalError(
            f"could not publish the {label} to R2: HTTP {response.status_code} {response.text[:120]}",
            status_code=503,
        )
    state = _read_manifest_state()
    state["keys"][key] = time.time()
    MEDIA_STATE_ROOT.mkdir(parents=True, exist_ok=True)
    _manifest_state_path().write_text(json.dumps(state, indent=1))
    return _presign_r2_get(key)


def _publish_rental_manifest(text: str) -> str:
    """PUT the manifest to the private bucket; return a presigned GET for it."""
    return _publish_rental_object(
        text.encode("utf-8"),
        suffix=".tsv",
        content_type="text/tab-separated-values",
        label="weights manifest",
    )


def _onstart_script(tier: str, *, skipped: list | None = None, strict: bool = False) -> str:
    spec = TIERS[tier]
    manifest, total = _rental_manifest(tier, skipped=skipped, strict=strict)
    manifest_url = _publish_rental_manifest(manifest)
    lines = [
        "#!/bin/bash",
        "exec > /root/hivemind-provision.log 2>&1",
        "set -u",
        # Before anything slow: a box we cannot reach is a box we cannot use,
        # and every second of provisioning is billed.
        *_authorize_rental_key_lines(),
        f"mkdir -p {BEACON_DIR}",
        # beacon <step> <done> <detail> — atomically publishes progress.json.
        "beacon() { printf '{\"step\":\"%s\",\"done\":%s,\"total\":"
        + str(total)
        + ",\"detail\":\"%s\",\"ts\":%s}' \"$1\" \"$2\" \"$3\" \"$(date +%s)\""
        f" > {BEACON_PROGRESS_PATH}.tmp && mv {BEACON_PROGRESS_PATH}.tmp {BEACON_PROGRESS_PATH}; }}",
        # The download library: pget/plen/stream/plain/dlwait. Kept in its own
        # builder so the test suite can run the very same bash against a
        # misbehaving HTTP server (test/studio/test_rental_downloads.py).
        *_download_lib_lines(),
        'beacon booting 0 "Host accepted, preparing environment"',
        # setsid for the same reason as ComfyUI below: the beacon is how the boot
        # reports itself, so it must outlive whatever signals onstart's group.
        f"(cd {BEACON_DIR} && setsid nohup python3 -m http.server {BEACON_PORT} --bind 0.0.0.0 >/dev/null 2>&1 < /dev/null &)",
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
    # Every tier that serves Krea2 needs its text encoder node. Fetched by SHA
    # rather than at HEAD: an unpinned node build is what the H3 stack was
    # burned by, and the failure mode here is the same shape (the graph either
    # loads or the whole prompt is rejected).
    if "Krea 2" in (spec.get("lora_base_models") or []):
        target = "/workspace/ComfyUI/custom_nodes/ComfyUI-Krea2TextEncoder"
        lines += [
            f"git clone -q https://github.com/ethanfel/ComfyUI-Krea2TextEncoder {target} || true",
            f"git -C {target} fetch -q --depth 1 origin {_KREA2_TEXT_ENCODER_COMMIT} "
            f"&& git -C {target} checkout -q {_KREA2_TEXT_ENCODER_COMMIT} "
            f'|| {{ beacon error 0 "Krea2 text encoder node unavailable"; exit 1; }}',
        ]
    if spec.get("needs_h3_stack"):
        lines += [
            # Smart-memory retention holds the H3 TE (15.7G) + DiT (21G) in
            # system RAM at once; a 31GB box thrashes to death mid-sample
            # (2026-08-04). Under 48GB, trade TE reload time for residency.
            #
            # Read the CGROUP limit, not /proc/meminfo: inside a Vast container
            # meminfo reports the HOST's RAM, so a box sold in eighths of a
            # 503GB machine answered "503" while actually capped at 171GiB, and
            # this test skipped the flag the container needed. Measured on two
            # live rentals 2026-08-13. memory.max reads "max" when the container
            # is uncapped, and cgroup v1 keeps the value under a different path;
            # fall back to meminfo for both rather than guess a number.
            'CG=$(cat /sys/fs/cgroup/memory.max 2>/dev/null'
            ' || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo max)',
            'case "$CG" in *[!0-9]*|"") '
            'RAM_GB=$(awk \'/MemTotal/{printf "%d", $2/1048576}\' /proc/meminfo);; '
            '*) RAM_GB=$((CG/1073741824));; esac',
            # A cgroup limit far above the host is the "uncapped" sentinel, not
            # a real allowance; take whichever of the two is smaller.
            'MEM_GB=$(awk \'/MemTotal/{printf "%d", $2/1048576}\' /proc/meminfo)',
            '[ "$RAM_GB" -gt "$MEM_GB" ] && RAM_GB=$MEM_GB',
            # Refuse a box too small to hold the weights AT ALL, before pulling
            # 40GB onto it. The offer-side floor (min_ram_gb) works from
            # cpu_ram x gpu_frac, which is an estimate — measured 2026-08-13 it
            # read 30.5 against a real 29.2GiB limit on one box and 63 against
            # 171GiB on another. This runs on the box itself, so it is the
            # authoritative check; the listing filter only saves the rental fee.
            f'if [ "$RAM_GB" -lt {spec["min_ram_gb"]} ]; then',
            '  beacon error 0 "this box gives the container only ${RAM_GB}GB of system RAM;'
            f' MiniMax H3 stages a 20GB transformer and a 15GB encoder through it and needs'
            f' {spec["min_ram_gb"]}GB — destroy this machine and rent another"',
            "  exit 1",
            "fi",
            'if [ "$RAM_GB" -lt 48 ];'
            ' then EXTRA_ARGS="$EXTRA_ARGS --disable-smart-memory"; fi',
            # Comfy's memory planner sizes the DiT load from the noise latent
            # alone — MiniMaxH3 declares no memory_usage_factor_conds — so every
            # reference row (pictures, motion clips, soundtracks) is invisible
            # to it, and a reference-mode job dies in block 0 with the whole
            # int8 DiT resident (2026-08-21, job 34a722c2: 26.47GiB + 6.21GiB
            # on a 31.36GiB 5090). --vram-headroom (ComfyUI >= ec4dec93, in the
            # pin above) asks DynamicVRAM to keep that much free. Measured
            # 2026-08-21 on a 110GB-RAM 5090: it costs nothing per step on a
            # plain job, but it did NOT rescue the reference-mode OOM (jobs
            # b9f5b32d/103f6173 failed identically at 12 and 20) — the packed
            # row budget is what keeps a job on the card. Kept because it is
            # free and the lane-argv plumbing reads it; rides with the
            # smart-memory branch and is left off the <48GB path.
            'if [ "$RAM_GB" -ge 48 ];'
            f' then EXTRA_ARGS="$EXTRA_ARGS --vram-headroom {spec["comfy_vram_headroom_gb"]}"; fi',
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
            "CN=/workspace/ComfyUI/custom_nodes",
            "git clone -q --depth 1 https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3 "
            "$CN/ComfyUI-Spectrum-MiniMax-H3 || true",
            "pin $CN/ComfyUI-Spectrum-MiniMax-H3 "
            f"{_H3_SPECTRUM_COMMIT}",
            # The registered minimax-h3 graph patches SageAttention via KJNodes
            # (~1.8x measured on H3 sampling).
            "git clone -q --depth 1 https://github.com/kijai/ComfyUI-KJNodes "
            "$CN/comfyui-kjnodes || true",
            f"pin $CN/comfyui-kjnodes {_H3_KJNODES_COMMIT}",
            # The turbo LoRA cannot be applied by ComfyUI's plain loader: this
            # node re-injects the time conditioning our PRUNED base lacks, and
            # ships the silu(t_emb) grid it needs.
            "git clone -q --depth 1 https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo "
            "$CN/ComfyUI-MiniMax-H3-Turbo || true",
            f"pin $CN/ComfyUI-MiniMax-H3-Turbo {_H3_TURBO_NODE_COMMIT}",
            # Scene chaining: the studio's chained graphs graft this node pack in.
            "git clone -q --depth 1 https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context "
            "$CN/ComfyUI-H3-Motion-Context || true",
            f"pin $CN/ComfyUI-H3-Motion-Context {_H3_MOTION_CONTEXT_COMMIT}",
            # Sol-Attn, which every H3 graph carries at tau 1.3 BY DEFAULT since
            # 2026-08-11 — so a box without it rejects every H3 job outright
            # ("Node 'Sol-Attn (tau 0 = off)' not found", HTTP 400 from the
            # prompt endpoint), not just the runs that asked for acceleration.
            # It was pinned into the standalone provisioning script and never
            # into this onstart, which is the one API-rented boxes actually run.
            "git clone -q --depth 1 https://github.com/kijai/ComfyUI-SolAttn_triton "
            "$CN/ComfyUI-SolAttn_triton || true",
            f"pin $CN/ComfyUI-SolAttn_triton {_H3_SOLATTN_COMMIT}",
            # Fast high-res (two-pass latent upscale). Off by default in the
            # graph, so a box without it would still serve every ordinary job —
            # but the node has no dependencies beyond torch/einops, and a lane
            # that cannot honour the toggle is worse than 200KB of source.
            "git clone -q --depth 1 https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler "
            "$CN/Comfyui_Minimax_h3_latent_Upscaler || true",
            "pin $CN/Comfyui_Minimax_h3_latent_Upscaler "
            f"{_H3_LATENT_UPSCALER_COMMIT}",
            # Head replacement. Both are small pure-python packs; a box without
            # them serves every other H3 job unchanged but refuses the inpaint
            # graph outright ("Node 'NKDAVLatent' not found", HTTP 400 from the
            # prompt endpoint), which is the failure mode the Sol-Attn pin was
            # added here to stop repeating.
            #
            # np <url> <dir> <sha> — clone, pin, install its requirements if it
            # has any. Written as a function because Vast caps this whole script
            # at VAST_ONSTART_LIMIT and spelling the custom_nodes path out four
            # more times cost more of that budget than the helper does.
            'np() { git clone -q --depth 1 "$1" $CN/"$2" || true; pin $CN/"$2" "$3"; '
            '[ -f $CN/"$2"/requirements.txt ] && '
            '/venv/main/bin/pip install -q -r $CN/"$2"/requirements.txt || true; }',
            "np https://github.com/Nekodificador/ComfyUI-NKD-Basic-Tools "
            f"ComfyUI-NKD-Basic-Tools {_H3_NKD_BASIC_TOOLS_COMMIT}",
            f"np https://github.com/drozbay/MaskVidExperiments MaskVidExperiments {_H3_MASKVID_COMMIT}",
            "[ -f $CN/comfyui-kjnodes/requirements.txt ] && "
            "/venv/main/bin/pip install -q -r $CN/comfyui-kjnodes/requirements.txt",
            "/venv/main/bin/pip install -q sageattention",
            # H3 Studio, stripped. The upstream pack registers SIXTEEN routes on
            # ComfyUI's PromptServer, which has no authentication — among them
            # POST /h3studio/dependencies/pdd/install, which runs a git clone.
            # Anything that can reach the Comfy port could install code on this
            # box. We drive the Director's widgets over the MCP and never load
            # its frontend, so the entire HTTP surface is dead weight: the seven
            # register_*_routes() calls in extension.py and the history route in
            # __init__.py are deleted, WEB_DIRECTORY is dropped so no JS is
            # served at all, and web/ (13MB of demo art) is removed with it.
            # The install_*() correctness fixes are deliberately KEPT — they
            # patch prompt/reference/PNG integrity, not the UI.
            "git clone -q --depth 1 --branch " + _H3_STUDIO_TAG + " "
            "https://github.com/thaakeno/ComfyUI-MiniMax-H3-Studio "
            "$CN/ComfyUI-MiniMax-H3-Studio || true",
            "H3S=$CN/ComfyUI-MiniMax-H3-Studio",
            "sed -i -E '/^register_[a-z_]*routes\\(\\)$/d' $H3S/h3studio/extension.py",
            "sed -i -E '/register_fast_history_restore_route/d' $H3S/__init__.py",
            "sed -i -E '/^WEB_DIRECTORY/d' $H3S/__init__.py",
            "sed -i -E 's/, \"WEB_DIRECTORY\"//' $H3S/__init__.py",
            "rm -rf $H3S/web",
            # Telemetry off by BOTH switches: the env var does not survive a
            # child process env, so the sentinel file is the one that holds.
            "touch $H3S/.h3studio-telemetry-disabled",
            # Fail loudly rather than serving a box with live install routes.
            "grep -qE '^register_[a-z_]*routes\\(\\)$' $H3S/h3studio/extension.py && "
            "{ beacon error 0 \"H3 Studio route strip failed\"; exit 1; } || true",
            "[ -f $H3S/requirements.txt ] && "
            "/venv/main/bin/pip install -q -r $H3S/requirements.txt || true",
        ]
    if tier_installs_seedvr2_trt(tier):
        # The restorer itself. Pinned: its graph inputs are a contract the
        # gateway builds against (packages/media-gateway/video_restore.py), and
        # its VAE decode is what the TensorRT node patches.
        svr = "/workspace/ComfyUI/custom_nodes/seedvr2_videoupscaler"
        lines += [
            f"git clone -q --depth 1 https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler {svr} || true",
            f"git -C {svr} checkout -q {_SEEDVR2_COMMIT} || true",
            f"[ -f {svr}/requirements.txt ] && /venv/main/bin/pip install -q -r {svr}/requirements.txt || true",
        ]
    lines.append('beacon downloading 0 "Fetching the weights manifest"')
    # Set BEFORE the fetchers fork: a background job inherits the variables
    # that exist at fork time, and `again` reads DL_DEADLINE so no stream
    # keeps retrying past the phase deadline dlwait enforces.
    lines.append(f"DL_DEADLINE=$(( $(date +%s) + {DOWNLOAD_DEADLINE_SECONDS} ))")
    lines += [
        # The manifest: fetched with the library's own retrying single-stream
        # fetch, cached on the persistent disk, and — when the fetch fails on a
        # rerun because its presign has expired — read from that cache. Only a
        # box with neither can go no further, and it says so.
        "MF=/workspace/.hivemind-manifest",
        f'plain "{manifest_url}" "$MF.new" && mv -f "$MF.new" "$MF"',
        '[ -s "$MF" ] || { beacon error 0 "weights manifest unavailable ($(cat "$MF.new.err" 2>/dev/null))'
        ' — destroy this machine and rent another"; exit 1; }',
        # One pget per manifest line. pget moves the object into place only
        # at its verified length, so a partial is never counted as a model
        # (by the beacon counter, or by a rerun's [ -s ]).
        'dlstart "$MF" "$M"',
        # dlwait publishes progress until every file is in place, and otherwise
        # exits the box through the beacon with the reason (see the library).
        'dlwait "$DL_DEADLINE" "${FILES[@]}"',
        "wait",
        # After the downloads (the archive is one of them), before the launch
        # (custom nodes are scanned once, at startup).
        *_seedvr2_trt_install_lines(tier),
        ". /venv/main/bin/activate",
        # Inside the venv, before the launch: comfy_kitchen picks its backend at
        # import time, so a torch swapped underneath a running ComfyUI changes
        # nothing.
        *_torch_cu130_lines(total),
        f'beacon starting-comfy {total} "Launching ComfyUI"',
        "cd /workspace/ComfyUI",
        # Stock memory flags on purpose: --highvram OOMs the convrot loader
        # (tuning sweep 2026-07-31). Bound to localhost — reach it over SSH.
        #
        # setsid, not bare nohup: nohup only blocks SIGHUP, so ComfyUI stayed in
        # onstart's process group and a signal aimed at that group took it with
        # it. Measured 2026-08-13 — the log stopped mid-run at "got prompt" with
        # no traceback, 2 MiB of 32 GB VRAM in use, and a submitted job rendered
        # nothing for twenty minutes. Its own session means only a signal aimed
        # at ComfyUI can end it. stdin from /dev/null so it can never be stopped
        # waiting on a terminal that is no longer there.
        "setsid nohup python main.py --disable-auto-launch --disable-metadata $EXTRA_ARGS "
        "--port 18188 --listen 127.0.0.1 > /root/comfyui.log 2>&1 < /dev/null &",
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
    # The same rows the manifest is built from, so the bytes a box downloads and
    # the volume it is rented with can never disagree — and a swapped weight is
    # counted at the swap's size, not the default's.
    return round(sum(row["size_gb"] for row in tier_download_rows(tier)), 1)


def tier_min_down_mbps(tier: str) -> int:
    """Link speed needed to fetch this tier inside TARGET_DOWNLOAD_SECONDS."""
    return int(tier_download_gb(tier) * 8 * 1000 / TARGET_DOWNLOAD_SECONDS)


def tier_disk_gb(tier: str) -> int:
    """Disk to provision for this tier, INCLUDING its registered user LoRAs.

    The one number every provider sizes its disk from, and the reason it is a
    function rather than TIERS[tier]["disk_gb"]: the tier constant covers the
    curated serving set only. Registered LoRAs already grow tier_download_gb
    (and through it the bandwidth floor), so before this existed the volume a
    box downloaded could grow without limit while the disk it downloaded onto
    stayed fixed — the LoRA flow was single-source everywhere EXCEPT the place
    that decides whether the bytes fit.

    That failure is not theoretical and not graceful: measured on a live pod
    2026-08-15 (a 20GB volume against an 80GB expectation), a full disk stops
    the download mid-file and the box provisions to an error having billed for
    the whole attempt.
    """
    lora_gb = sum(float(entry.get("size_gb") or 2.0) for entry in rental_loras_for_tier(tier))
    return int(TIERS[tier]["disk_gb"] + math.ceil(lora_gb))


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


def _underpowered(offer: Offer) -> bool:
    """True when a host's own benchmark is far below its class median."""
    key = gpu_class_for_name(offer.gpu_name)
    if key is None:
        return False
    # Unbenchmarked hosts are not evidence of anything; leave them to price
    # ranking rather than hiding offers for a missing field. That covers every
    # RunPod offer, which publishes no per-host benchmark at all.
    if not offer.dlperf:
        return False
    return offer.dlperf < GPU_CLASSES[key]["dlperf"] * UNDERPOWERED_DLPERF_RATIO


def _starved_of_ram(tier: str, offer: Offer) -> bool:
    """True when the container could not hold this tier's weights in system RAM.

    ComfyUI stages weights in system RAM and streams them to VRAM, so the host
    side has to hold them whatever the card is. Measured 2026-08-13: a 29.2GiB
    H3 box rendered a 5s reference clip (21.05GiB VRAM peak) but the ComfyUI
    PROCESS WAS KILLED on a 10s one, system RAM peaking at 27.12GiB before it
    went — the job did not fail, the server died. Nothing checked this before,
    which is how that box came to be rented at all.

    Only H3 has been measured, so only H3 states a min_ram_gb. Every other tier
    falls back to its VRAM floor, which is a bound rather than a guess: the
    weights that have to fit on the card are staged through host RAM to get
    there, so a container with less system RAM than the tier needs VRAM cannot
    load them however the sampler behaves. Before this fallback existed the
    image and video tiers declared no floor at all, and once the datacenter
    constraint came off the Vast query, cheapest-first ranking led with 6-8GB
    containers for a workload that stages 21GB of weights.
    """
    spec = TIERS[tier]
    floor = spec.get("min_ram_gb") or spec["min_vram_gb"]
    if not floor:
        return False
    # A listing that does not say is not evidence of a small box; leave it to
    # price ranking rather than hiding offers over an absent value.
    if not offer.ram_gb:
        return False
    return offer.ram_gb < floor


def _offer_query(tier: str, min_down_mbps: int | None = None,
                 gpu_class: str | None = None) -> OfferQuery:
    """What to shop for, in provider-neutral terms.

    One query covers the tier's whole GPU ladder: three per-class queries per
    tier would triple the calls behind a view that already polls, and Vast
    rate-limits. Results are grouped by class afterwards.
    """
    spec = TIERS[tier]
    return OfferQuery(
        gpu_names=_gpu_names_for(tier, gpu_class),
        min_disk_gb=tier_disk_gb(tier),
        min_down_mbps=tier_min_down_mbps(tier) if min_down_mbps is None else min_down_mbps,
        # Same floor _starved_of_ram applies to the results — see there for why
        # the VRAM figure is a sound fallback where nothing was measured.
        min_ram_gb=spec.get("min_ram_gb") or spec["min_vram_gb"],
    )


def _offer_dto(offer: Offer) -> dict:
    return {
        # Provider-scoped, because two marketplaces can and do hand out the
        # same integer. The renting call routes on this.
        "offer_id": offer.offer_id,
        "provider": offer.provider,
        "provider_label": rental_providers.get(offer.provider).label,
        "gpu": offer.gpu_name,
        "gpu_class": gpu_class_for_name(offer.gpu_name),
        "vram_mb": offer.vram_mb,
        # The container's share, not the machine's headline RAM. Surfaced so
        # the Machines view can show the number that decides whether a box can
        # hold the weights at all.
        "ram_gb": round(offer.ram_gb, 1) if offer.ram_gb else None,
        # This host's own benchmark, not the class median — the two diverge by
        # 2x across SKUs sold under one gpu_name, so the offer has to carry it.
        "dlperf": offer.dlperf,
        "usd_per_hour": offer.usd_per_hour,
        "down_mbps": offer.down_mbps,
        "reliability": offer.reliability,
        "geolocation": offer.geolocation,
        # Shown, not filtered on: see the provider's own query builder.
        "datacenter": offer.datacenter,
    }


# A provisioning box saturates its own uplink: the models are pulled over
# DOWNLOAD_CONNECTIONS ranged connections per file, every file at once, while
# the beacon is a single-threaded `python3 -m http.server`. Measured 2026-08-20
# on rental vast:48183103 mid-download: the beacon answered in 0.54s when it
# answered at all, but 21 of 24 polls got nothing within 8s. A 1.5s budget
# therefore missed most reads on exactly the boxes worth watching.
BEACON_TIMEOUT_SECONDS = float(os.environ.get("HIVEMIND_RENTAL_BEACON_TIMEOUT", "4.0"))

# Last successful beacon read per rental, so a missed poll reports the box's
# last known state instead of erasing it. Keyed by str(RentalRef); entries go
# when the rental does. Written from the polling path and the reaper thread —
# a plain dict is enough, both only ever replace whole values.
_BEACON_CACHE: dict[str, dict] = {}

# Floor for "we have never heard from this box": silence cannot predate our
# ability to hear it. See _beacon_silence.
_PROCESS_STARTED = time.time()


def _fetch_beacon(url: str) -> dict | None:
    """Best-effort read of the box's provisioning beacon; None while unreachable."""
    try:
        response = requests.get(url, timeout=BEACON_TIMEOUT_SECONDS)
        data = response.json()
        return data if isinstance(data, dict) and data.get("step") else None
    except Exception:
        return None


def _beacon_over_ssh(endpoint: tuple[str, str], timeout: float = 5.0) -> dict | None:
    """Read the beacon through the box's SSH door when its HTTP port is not
    routable from here.

    The beacon binds 0.0.0.0 inside the container and the create publishes it,
    but publishing is a request: some hosts simply do not route the mapped
    ports, and from outside they read as closed. That is not a broken box —
    2026-08-24, vast:48544133 was fully provisioned, its beacon file said
    "ComfyUI is up", sshd and ComfyUI were both listening — but the studio
    could not read a word of it, so _beacon_silence called it dead and the
    reaper was 60 seconds from destroying a $0.59/hr machine that worked.

    One channel with no fallback is the same mistake this file just fixed for
    SSH, so the fix is the same: the box has a door, use it. Only ever reached
    when the HTTP read already failed, so a healthy box never pays for it.
    """
    if not RENTAL_SSH_KEY.exists():
        return None
    host, port = endpoint
    try:
        done = subprocess.run(
            ["ssh", "-n",
             "-o", "BatchMode=yes",
             "-o", "StrictHostKeyChecking=accept-new",
             "-o", f"ConnectTimeout={int(timeout)}",
             "-i", str(RENTAL_SSH_KEY), "-p", str(port), f"root@{host}",
             f"cat {BEACON_PROGRESS_PATH}"],
            capture_output=True, text=True, timeout=timeout + 5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    try:
        beacon = json.loads(done.stdout)
    except ValueError:
        return None
    return beacon if isinstance(beacon, dict) else None


def _remember_beacon(rental_id: str, beacon: dict) -> dict:
    _BEACON_CACHE[rental_id] = {"beacon": beacon, "at": time.time()}
    return beacon


def _last_beacon(rental_id: str) -> tuple[dict | None, float]:
    """The last reading we got from this box, and how long ago it arrived."""
    entry = _BEACON_CACHE.get(rental_id)
    if not entry:
        return None, 0.0
    return entry["beacon"], time.time() - float(entry["at"])


def _forget_beacon(rental_id: str) -> None:
    _BEACON_CACHE.pop(str(rental_id), None)


# How long a managed box that is RUNNING may leave us with no beacon contact
# before we call it dead rather than busy. Deliberately generous: a healthy box
# under a full-speed download goes quiet for minutes at a time (see the
# measurement above), and destroying one of those would throw away real
# progress and real money. What this catches is the box that never comes back —
# the failure mode where the host's network dies, which kills the downloads and
# the beacon together, and which otherwise bills at the full hourly rate
# forever behind a hopeful "Booting host".
BEACON_SILENCE_SECONDS = int(os.environ.get("HIVEMIND_RENTAL_BEACON_SILENCE_SECONDS", "900"))


# Port maps and SSH endpoints are resolved by the provider now (an SSH endpoint
# in particular is provider-shaped: Vast usually hands out a proxy host rather
# than the box's own IP, RunPod publishes a direct mapping), and arrive on
# Instance.ports / Instance.ssh.


# How long a managed box may sit in a "loading" state with its container's
# SSH port still closed before we call it wedged rather than slow. Measured
# 2026-08-11: a healthy first-time rental opens that port within a few minutes
# even when the image pull is cold; the box that burned an hour never opened it
# at all while Vast reported the instance up the whole time.
BOOT_STALL_SECONDS = int(os.environ.get("HIVEMIND_RENTAL_BOOT_STALL_SECONDS", "480"))


# Probing a dead endpoint costs its full timeout, and the Machines view, both
# studios and the reaper all poll the same list — so an unreachable box was
# paying that price several times over, per sweep. Short TTL: long enough to
# collapse one round of pollers, short enough that a door coming back is
# noticed within a poll.
_SSH_PROBE_TTL_SECONDS = 20.0
_ssh_probe_cache: dict[tuple[str, str], tuple[float, str | None]] = {}
_ssh_probe_lock = threading.Lock()


def _ssh_banner_fault(host: str, port: str, timeout: float = 3.0,
                      cache: bool = False) -> str | None:
    """None when this endpoint really is SSH; else a plain account of what it is.

    An accepted connection is not evidence, and this is the third time that
    lesson has cost a machine (see _tunnel_carrying_traffic for the other two).
    On 2026-08-24 Vast reported ssh_port 19896 for a healthy box; the port
    accepted every connection, so _container_ssh_open called the door open and
    _boot_stall never fired — but it was Vast's Jupyter HTTPS proxy, and what
    it actually sent back was a TLS fatal alert (15 03 03 00 02 02 32,
    decode_error) at the sight of an SSH banner. The studio showed the rental
    ready for 25 minutes, the user clicked Run on, and the only thing anyone
    learned was "Connection closed by remote host". ComfyUI binds to loopback
    and Vast's command API refuses running instances, so there was no second
    way in and the box had to be destroyed.

    So: read what the far end says. sshd greets first and immediately, which
    makes this one round-trip and no handshake.
    """
    key = (host, str(port))
    if cache:
        with _ssh_probe_lock:
            entry = _ssh_probe_cache.get(key)
        if entry and time.time() - entry[0] < _SSH_PROBE_TTL_SECONDS:
            return entry[1]
    fault = _read_ssh_banner(host, port, timeout)
    if cache:
        with _ssh_probe_lock:
            _ssh_probe_cache[key] = (time.time(), fault)
    return fault


def _read_ssh_banner(host: str, port: str, timeout: float) -> str | None:
    try:
        with socket.create_connection((host, int(port)), timeout=timeout) as sock:
            sock.settimeout(timeout)
            greeting = sock.recv(64)
    except (OSError, ValueError):
        return f"nothing is listening on {host}:{port}"
    if greeting.startswith(b"SSH-"):
        return None
    if not greeting:
        return f"{host}:{port} accepted the connection, then closed it without an SSH banner"
    # 0x16 handshake / 0x15 alert, then a TLS major version of 3.
    if greeting[:1] in (b"\x15", b"\x16") and greeting[1:2] == b"\x03":
        return f"{host}:{port} is serving TLS, not SSH"
    if greeting.startswith(b"HTTP/"):
        return f"{host}:{port} is serving HTTP, not SSH"
    return f"{host}:{port} answered with something that is not SSH"


def _container_ssh_open(endpoint: tuple[str, str] | None, timeout: float = 3.0) -> bool:
    """Is the container's own sshd answering yet?

    This is the honest boot signal. Vast marks an instance running the moment
    the HOST accepts the contract, which is long before the image is unpacked
    and the container exists — so "the instance is up" says nothing about
    whether anything of ours can start. An SSH banner does.
    """
    if not endpoint:
        return False
    host, port = endpoint
    return _ssh_banner_fault(host, port, timeout=timeout) is None


def _reachable_ssh_endpoint(
    instance: Instance, timeout: float = 3.0, cache: bool = False
) -> tuple[tuple[str, str] | None, list[str]]:
    """The first endpoint that speaks SSH, plus why the others did not.

    The faults are carried back rather than logged because they are the whole
    diagnosis: "Connection closed by remote host" tells nobody anything, and
    "ssh7.vast.ai:19896 is serving TLS, not SSH" tells them everything.
    """
    faults: list[str] = []
    for host, port in instance.ssh_endpoints:
        fault = _ssh_banner_fault(host, port, timeout=timeout, cache=cache)
        if fault is None:
            return (host, port), faults
        faults.append(fault)
    return None, faults


def _ssh_door_failure(instance: Instance) -> dict | None:
    """A provisioning record for a box that provisioned fine and has no door.

    The counterpart to _boot_stall and _beacon_silence for the box that got all
    the way to "ComfyUI is up" while every way in was dead. Nothing else
    catches it: the beacon is a published HTTP port and answers happily, so the
    box reads ready, and the failure only surfaces when a person clicks Run on
    and gets a 502 — by which time it has been billing for half an hour.

    Treated as a provisioning failure rather than an error to show, because
    that is what it is and the reaper already knows what to do with one: record
    the reason and destroy the box before it bills for an hour. Renting the
    replacement is still the operator's call, as it is for every other
    provisioning failure — but they are choosing a new machine rather than
    debugging a dead one.
    """
    endpoint, faults = _reachable_ssh_endpoint(instance, cache=True)
    if endpoint is not None:
        return None
    return {
        "step": "error",
        "done": 0,
        "total": None,
        "detail": (
            "this box finished provisioning but has no working SSH door ("
            + "; ".join(faults or ["the marketplace never published one"])
            + ") — nothing can reach its ComfyUI, so destroy this machine and rent another"
        ),
    }


def _boot_stall(instance: Instance, endpoint: tuple[str, str] | None) -> dict | None:
    """A provisioning record for a box whose container never came up.

    Returns None while the box is merely booting - most are - and a terminal
    record once it has had long enough and its SSH port is still shut. Without
    this the studio shows "Booting host" forever: there is no beacon to report
    a failure, because nothing that could write one was ever started, so the
    operator waits on a hopeful progress step while the meter runs.
    """
    started = instance.started_at
    if not started:
        return None
    waited = time.time() - float(started)
    if waited < BOOT_STALL_SECONDS:
        return None
    if _container_ssh_open(endpoint):
        return None
    return {
        "step": "error",
        "done": 0,
        "total": None,
        "detail": (
            f"the host never started this container ({int(waited // 60)} min, SSH still closed). "
            f"That is a bad host, not a slow one - destroy it and rent again."
        ),
    }


def _beacon_silence(instance: Instance, step: str | None, stale: float | None) -> dict | None:
    """A provisioning record for a running box that has stopped answering.

    The counterpart to _boot_stall for a box that DID come up: its container is
    running, so nothing above notices, but the host's network has died and
    taken the model downloads and the beacon with it. 2026-08-20 (rental
    vast:48183103) is the case this exists for - the downloads failed at 3/5
    and the box only got reaped because a poll happened to land in one of its
    brief responsive windows. Miss that window and it bills at the full rate
    behind a progress step that will never advance.

    Returns None while the box is merely busy, which is the common case: a
    healthy download saturates the uplink and starves the single-threaded
    beacon for minutes at a stretch.
    """
    # A box that finished provisioning is not judged on its beacon: it has a
    # tunnel and a ComfyUI to answer for it, and destroying a working machine
    # over a quiet status file is far more expensive than the bill this saves.
    if step == "ready" or step == "error":
        return None
    if step is None:
        # Never heard from it at all - measure from the moment it started, or
        # from the moment THIS process started if that is later. The cache is
        # in-memory, so every restart forgets what it had heard; without the
        # floor, restarting the stack next to a box that is 20 min into a
        # legitimately slow download would read as 20 min of silence and
        # destroy it on the first sweep.
        started = instance.started_at
        if not started:
            return None
        quiet = time.time() - max(float(started), _PROCESS_STARTED)
        what = "never reported in"
    else:
        quiet = float(stale or 0.0)
        what = f"went quiet at {step}"
    if quiet < BEACON_SILENCE_SECONDS:
        return None
    return {
        "step": "error",
        "done": 0,
        "total": None,
        "stale_seconds": int(quiet),
        "detail": (
            f"the box {what} and has not answered for {int(quiet // 60)} min while the host "
            f"reports it running. That is a dead host - destroy it and rent again."
        ),
    }


def _instance_dto(instance: Instance, probe: bool = False) -> dict:
    label = instance.label
    managed = label.startswith(STUDIO_LABEL_PREFIX)
    endpoint = instance.ssh
    ip = instance.public_ip
    ref = instance.ref

    # Truthful lifecycle phase. The provider has already collapsed its API's
    # states to booting/running/stopped; what it CANNOT know is whether our
    # stack came up inside the container, which is what the beacon below adds.
    # Every marketplace calls a box "running" from the moment the host accepts
    # the contract, long before the image is unpacked.
    provision = None
    if instance.state == "stopped":
        # Disk (and every downloaded model) survives; resume skips the pull.
        phase = "paused"
    elif instance.state == "booting":
        phase = "booting"
        # ...unless it has been "booting" long past the point where a container
        # would exist. Escalating to "error" is what puts it in front of the
        # operator and hands it to the reaper below, exactly like a beacon that
        # reports a failure — the difference is only that this box never got
        # far enough to have a beacon at all.
        stall = _boot_stall(instance, endpoint) if (probe and managed) else None
        if stall:
            phase = "error"
            provision = stall
    elif instance.state == "running" and managed:
        beacon_port = instance.ports.get(BEACON_PORT)
        attached = _read_attachments().get(str(ref))
        # Only a box we could actually reach for is judged on its silence: with
        # no published port there is nowhere to ask, and "the provider has not
        # surfaced the port map yet" must not read the same as "the host died".
        asked = bool(probe and ip and beacon_port)
        # An attached box with a tunnel carrying traffic has already answered the
        # only question this whole block asks, from the far end and over
        # localhost. Ask it first: every remote channel below costs seconds when
        # it is the dead one, and this poll is on the path of the Machines view
        # and both studios. Measured 2026-08-24 on a box whose host published
        # ports it does not route: 4.0s for the mute HTTP beacon, 3.6s to walk
        # the SSH candidates, 3.4s to read the beacon over ssh — 10.6s per box,
        # per poll, to re-derive "ready" for a machine already serving.
        beacon = None
        if probe and attached is not None and _tunnel_carrying_traffic(ref, timeout=1.5):
            beacon = _last_beacon(str(ref))[0] or {
                "step": "ready", "done": None, "total": None, "detail": "ComfyUI is up"}
        elif asked:
            beacon = _fetch_beacon(f"http://{ip}:{beacon_port}/progress.json")
        # The published port is one way to ask, not the only one. A host that
        # does not route it leaves a perfectly good box mute, and mute is what
        # _beacon_silence destroys boxes for.
        #
        # `asked` grows only when a door actually answered. Having a candidate
        # endpoint is not having somewhere to ask, and the difference is the
        # whole reason silence is survivable: judge a box on a question it was
        # never in a position to hear and the answer is always "dead".
        # Reading it over ssh spawns a process and pays a connect, so do it only
        # when the remembered reading has actually gone stale. In between, the
        # cache below serves the last one with an honest stale_seconds — which
        # is what that mechanism has always been for.
        remembered, remembered_age = _last_beacon(str(ref))
        if beacon is None and probe and (remembered is None or remembered_age >= _SSH_PROBE_TTL_SECONDS):
            door, _ = _reachable_ssh_endpoint(instance, timeout=2.0, cache=True)
            if door is not None:
                beacon = _beacon_over_ssh(door)
                asked = True
        # A miss is not a state. Falling back to step "booting" rewound the
        # studio's ladder to "Booting host" every time a poll timed out, so a
        # box that was 3/5 through its models looked like it had started over —
        # and, far worse, a box whose beacon said "error" read as "provisioning"
        # to the reaper below, which then left it billing. Serve the last thing
        # the box actually told us, aged, until it has been quiet long enough
        # to call dead.
        stale = 0.0
        if beacon:
            _remember_beacon(str(ref), beacon)
        else:
            beacon, stale = _last_beacon(str(ref))
        if beacon:
            step = beacon.get("step")
            phase = "ready" if step == "ready" else "error" if step == "error" else "provisioning"
            provision = {
                "step": step,
                "done": beacon.get("done"),
                "total": beacon.get("total"),
                "detail": beacon.get("detail") or "",
                # Surfaced so the studio can say "lost contact" rather than
                # presenting a remembered reading as a live one.
                "stale_seconds": int(stale) if stale else 0,
            }
            silence = _beacon_silence(instance, step, stale) if asked else None
            if silence:
                phase = "error"
                provision = silence
            # "ComfyUI is up" is only half the readiness question; the other
            # half is whether anything can reach it. A box whose beacon says
            # ready while every SSH door is dead is a failed provision, and
            # until this check existed the studio showed it green and let the
            # user find out by clicking Run on 25 minutes later.
            #
            # Only a box that is NOT attached is judged this way. An attached
            # one has a live tunnel and a ComfyUI answering for it, and
            # destroying a working machine over one unhappy probe costs far
            # more than the bill it saves — the same rule _beacon_silence
            # follows when it declines to judge a box that reached "ready".
            elif phase == "ready" and probe and attached is None:
                door = _ssh_door_failure(instance)
                if door:
                    phase = "error"
                    provision = door
        else:
            phase = "provisioning"
            provision = {"step": "booting", "done": 0, "total": None, "stale_seconds": 0,
                         "detail": "Container up, waiting for the provisioning beacon"}
            silence = _beacon_silence(instance, None, None) if asked else None
            if silence:
                phase = "error"
                provision = silence
    elif instance.state == "running":
        phase = "running"
    else:
        phase = instance.state or "unknown"

    attachment = _read_attachments().get(str(ref)) if managed else None
    tier = _tier_from_label(label) if managed else None
    gpu_class = (
        _gpu_class_from_label(label) or gpu_class_for_name(str(instance.gpu_name or ""))
        if managed
        else None
    )
    seconds, basis = (
        estimate_generation_seconds(tier, gpu_class) if tier and gpu_class else (None, None)
    )
    return {
        # Provider-scoped ("vast:47390808"). Every route, registry key and
        # pidfile downstream keys on this string.
        "rental_id": str(ref),
        "provider": instance.provider,
        "provider_label": rental_providers.get(instance.provider).label,
        "label": label,
        "managed": managed,
        "tier": tier,
        "tier_label": TIERS[tier]["label"] if tier else None,
        "gpu_class": gpu_class,
        # The card's marketing size in GB from the class table (the studio prices
        # the H3 motion-reference budget against the machine a run will land on).
        "vram_gb": GPU_CLASSES.get(gpu_class, {}).get("vram_gb") if gpu_class else None,
        "reference_job": TIERS[tier]["reference_job"] if tier else None,
        "seconds_per_generation": seconds,
        "estimate_basis": basis,
        "status": instance.state or "unknown",
        "phase": phase,
        "provision": provision,
        "attached": bool(attachment),
        # Higher wins when several attached machines serve the same models —
        # the studios' machine picker writes this.
        "priority": (attachment or {}).get("priority", 0),
        "pending_reattach": bool(_read_paused_state().get(str(ref), {}).get("pending_reattach")),
        # A Quick-resume that the host is not honouring: resume was asked for
        # more than RESUME_GRACE_SECONDS ago and the box is still stopped. Vast
        # keeps the disk and keeps billing it; the GPU itself was released and
        # is most likely rented to someone else. The studio shows the way out
        # (keep waiting, or destroy and rent fresh) instead of a spinner.
        "resume_blocked": bool(
            instance.state == "stopped"
            and (_read_paused_state().get(str(ref), {}).get("resumed_at") or 0)
            and time.time() - float(_read_paused_state().get(str(ref), {}).get("resumed_at") or 0) > RESUME_GRACE_SECONDS
        ),
        "resume_requested_at": _read_paused_state().get(str(ref), {}).get("resumed_at"),
        # The forward, not the process: a live ssh with a dead forward reads as
        # healthy to a pid check and hides the only fact that matters here.
        "tunnel_alive": bool(attachment and _tunnel_carrying_traffic(ref)),
        "models_served": (attachment or {}).get("needles")
        or TIERS.get(_tier_from_label(label), {}).get("lane_needles", []),
        # ComfyUI's --vram-headroom on the attached lane, as read at attach time
        # (0.0 = launched without it, None = unknown or not attached). The H3
        # motion-reference budget needs the tier's comfy_vram_headroom_gb.
        "vram_headroom_gb": (attachment or {}).get("vram_headroom_gb"),
        # What this box was rented for, so a studio handed the machine lands on
        # the lane it was bought for rather than the first one that matches.
        "primary_workflow": TIERS.get(_tier_from_label(label), {}).get("primary_workflow", ""),
        "studio_pages": (attachment or {}).get("studio_pages")
        or TIERS.get(_tier_from_label(label), {}).get("studio_pages", []),
        "gpu": instance.gpu_name,
        # The physical host, not the rental. A rental is gone once destroyed;
        # the machine that wedged it is still in the market tomorrow, so this
        # is what a failure has to be remembered against. None on providers
        # that do not expose it.
        "machine_id": instance.machine_id,
        "usd_per_hour": instance.usd_per_hour,
        # What a paused box costs: the disk keeps billing.
        "paused_usd_per_hour": instance.paused_usd_per_hour,
        "disk_gb": instance.disk_gb,
        "started_at": instance.started_at,
        "uptime_hours": round(max(0.0, (time.time() - instance.started_at) / 3600), 2)
        if instance.started_at
        else None,
        "ssh_command": f"ssh -p {endpoint[1]} root@{endpoint[0]} -L 18188:localhost:18188"
        if endpoint
        else None,
        "comfy_url": "http://localhost:18188 (after the SSH tunnel connects)" if endpoint else None,
    }


# --- public operations ------------------------------------------------------

# (when, offers, the link-speed floor that produced them, marketplace failures)
_offer_cache: dict[str, tuple[float, list[Offer], int, list[dict]]] = {}

# How far above the quoted price a fallback may land before we stop and
# re-quote instead. The Rent button shows ONE number; the ask behind it can be
# gone by the time the click arrives, and the old behaviour was to take the
# next-cheapest host in silence — measured 2026-08-22: quoted $0.596/hr, rented
# $0.640/hr (+7.4%), nothing said. "A few cents either side" is what the button
# promised, so that is the contract: 2 cents or 3%, whichever is more.
RENT_PRICE_TOLERANCE_USD = 0.02
RENT_PRICE_TOLERANCE_FRACTION = 0.03


def rent_price_cap(quoted_usd_per_hour: float) -> float:
    return round(quoted_usd_per_hour + max(RENT_PRICE_TOLERANCE_USD,
                                           RENT_PRICE_TOLERANCE_FRACTION * quoted_usd_per_hour), 4)


def _price_moved(
    tier: str, gpu_class: str, count: int, quoted: float, now: float | None,
    *, because: Exception | None = None,
) -> GpuRentalError:
    """The order could not be filled at the quoted price — as a QUESTION.

    This used to be a dead end. The card quoted the cheapest ask, the ask was
    gone by the time the order landed, and the refusal said "rent again to take
    the new price" — while the refreshed card re-quoted the SAME dead ask, so
    renting again reproduced it exactly. Seen live 2026-09-14: a stale Vast ask
    at $0.8185/hr sat at the top of the market, was the only offer inside its
    own tolerance, and failed every attempt; the owner was told the price had
    moved to $0.863 and then handed the $0.819 button again.

    So the numbers ride on the error and the view asks whether to go ahead at
    the new one. Renting at a HIGHER price than the person agreed to is the
    only case that needs asking: `cap` is an upper bound, so an ask that got
    CHEAPER is inside it already and is taken without a word — the quote is
    what they agreed to pay, and paying less than it needs no permission.

    `now` is None when the market went empty rather than dearer; there is no
    new price to offer, so that stays a plain refusal.
    """
    label = GPU_CLASSES.get(gpu_class, {}).get("label", gpu_class)
    if now is None:
        return GpuRentalError(
            f"the ${quoted:.3f}/hr {label} was taken before the order landed and nothing has "
            "replaced it yet. Nothing was rented; try again in a moment",
            status_code=409,
        )
    # The sentence is for callers with no UI (agents, the MCP). A view reads
    # `priceChanged` and asks instead of printing this.
    reason = f" ({because})" if because else ""
    return GpuRentalError(
        f"the ${quoted:.3f}/hr {label} was taken before the order landed{reason}; the cheapest "
        f"now is ${now:.3f}/hr. Nothing was rented — rent again to take it at ${now:.3f}/hr",
        status_code=409,
        payload={"priceChanged": {
            "quoted": round(float(quoted), 4),
            "now": round(float(now), 4),
            "tier": tier,
            "gpuClass": gpu_class,
            "gpuLabel": label,
            "count": int(count),
        }},
    )


def _forget_offers(tier: str) -> None:
    """Drop the cached market for a tier. Renting consumes an ask (and a
    refusal means the snapshot was already wrong), so the next plan poll has
    to see the live market, not the 45s-old one the card was drawn from."""
    for key in [k for k in _offer_cache if k.startswith(f"{tier}:")]:
        _offer_cache.pop(key, None)
OFFER_CACHE_SECONDS = 45


def _shut_marketplace_keys() -> list[str]:
    """Marketplace keys this machine HOLDS but cannot open.

    The store lists a sealed key by name, and that name is the only thing that
    separates two states which look identical from here — nothing in the
    environment either way — and have opposite repairs. "Never added" is fixed
    by adding a key. "Added, but sealed on a machine whose vault is locked" is
    fixed by signing in to PassBook, and telling that owner to go and find an
    API key they already bought is how an afternoon disappears.

    Same predicate as provider_models._held_but_shut, asked of the rental keys.

    "Sealed" is the diagnosis, not a measurement: what is measured is that the
    store names the key and the process does not have it, and there is a
    second way to get there. Seen 2026-09-07 on this machine: the vault was
    OPEN and the Machines view still read "the marketplace keys are sealed",
    because the stack launcher hands each service only the keys on its
    STUDIO_KEYS allowlist (`passbook run --only`, since 2026-08-30) and the
    marketplace keys were never on it. `ps eww` on the studio pid settles
    which: the key is either on the command's environment or it is not. Both
    states are direct-transport concerns; on the hosted transport this machine
    is not supposed to hold a marketplace key, and this is never consulted.
    """
    try:
        from .shared_env import stored_key_names

        held = stored_key_names()
    except Exception:  # noqa: BLE001 — a store we cannot reach is not "shut"
        return []
    return [
        name
        for provider in rental_providers.all_providers()
        for name in getattr(provider, "env_names", ())
        if name in held and not os.environ.get(name, "").strip()
    ]


def _require_a_marketplace() -> list:
    """The configured providers, or a 503 saying so.

    "No marketplace is set up" and "every marketplace is sold out" render
    identically once the offers list is empty, and they need opposite
    responses from the user — one is a missing API key, the other is a market
    to wait out. An unconfigured studio used to say so plainly because the
    single Vast key raised on use; keep that.

    And there is a third state, which used to wear the first one's message.
    PassBook seals the shared store in place: the keys stay listed by name and
    their values become `hive-sealed:...`, which the reader drops. So a studio
    whose vault is locked has no credentials AND no missing keys, and telling
    that owner to "set VAST_API_KEY in the environment" sends them to buy a
    second key for an account they are already paying for.

    And since 2026-09-07 a fourth, which is now the ordinary one: no account.
    The hosted transport needs no key on this machine at all — the worker
    holds them — so a studio with nothing connected and nothing in the
    environment is told to connect its HivemindOS account, not to go and buy
    marketplace keys. The PassBook diagnosis is kept for the machine that has
    FORCED the direct transport; there, and only there, a sealed store is
    the thing in the way.
    """
    providers = rental_providers.configured_providers()
    if providers:
        return providers
    transport = rental_gateway.transport()
    forced_direct = os.environ.get(rental_gateway.TRANSPORT_ENV, "").strip().lower() == rental_gateway.TRANSPORT_DIRECT
    if transport == rental_gateway.TRANSPORT_GATEWAY:
        # An account is connected (or the gateway is forced). Nothing is
        # configured because the worker said so, or could not be asked — and
        # market() remembers which, with the status the route should answer.
        try:
            market = rental_gateway.market()
        except ProviderError as exc:
            raise GpuRentalError(
                str(exc), status_code=exc.status_code,
                remedy="connect-account" if exc.status_code == 401 else "",
            ) from exc
        labels = ", ".join(
            str(entry.get("label") or entry.get("key"))
            for entry in (market.get("providers") or []) if isinstance(entry, dict)
        ) or "any marketplace"
        raise GpuRentalError(
            f"the hosted GPU marketplace has no provider key set for {labels} right now — "
            "nothing on this machine to fix; try again in a few minutes",
            status_code=503,
        )
    if not forced_direct:
        # Transport auto, no token: the repair is an account, whatever the
        # shared store holds — on this rail the machine's own keys are not
        # supposed to matter, so a sealed one is not the problem to raise.
        raise GpuRentalError(rental_gateway.CONNECT_MESSAGE, status_code=503, remedy="connect-account")
    shut = _shut_marketplace_keys()
    if shut:
        raise GpuRentalError(
            f"the marketplace keys ({', '.join(shut)}) are in this machine's "
            f"shared store, but sealed — the vault is locked. Sign in to "
            f"PassBook (`passbook signin`) and restart the stack to unlock "
            f"them; they are not missing.",
            status_code=503, remedy="passbook",
        )
    names = " or ".join(
        f"{p.label} ({' or '.join(getattr(p, 'env_names', ())) or p.key.upper() + '_API_KEY'})"
        for p in rental_providers.all_providers()
    )
    raise GpuRentalError(
        f"no GPU marketplace is configured — set {names} in the environment, "
        f"or unset {rental_gateway.TRANSPORT_ENV} and connect your HivemindOS account",
        status_code=503,
    )


def marketplace_setup() -> dict:
    """The marketplace state the machine LIST carries: `configured`, and when
    not, the sentence and the button that repairs it.

    `_require_a_marketplace`'s refusal as a value. The list answers 200
    carrying it (gpu_rentals_index): "no marketplace" is the state every
    studio poll meets on a Mac that never rented anything, not an outage.
    `remedy` is "connect-account" | "passbook" | "" — the Machines view keys
    its button off this rather than matching the sentence.
    """
    try:
        _require_a_marketplace()
    except GpuRentalError as exc:
        return {"configured": False, "detail": str(exc), "remedy": exc.remedy}
    return {"configured": True, "detail": "", "remedy": ""}


def marketplace_setup_notice() -> str:
    """Why no marketplace can be asked here, or "" when one is configured."""
    return marketplace_setup()["detail"]


def _marketplace_failure(provider, exc: ProviderError) -> dict:
    """One marketplace's silence, in words the owner can act on.

    Not the upstream string. Vast answers an unusable key with `Vast API POST
    /v0/bundles/ failed: Invalid user key`, which reads as a bug in the studio
    and names no repair; RunPod answers `{"error":{}}` and names nothing at
    all. What the owner needs is which marketplace went quiet, why, and the one
    thing that fixes it — so each failure carries its own repair, and the raw
    line rides along for a log rather than for a toast.
    """
    text = str(exc)
    lowered = text.lower()
    names = " or ".join(getattr(provider, "env_names", ())) or "its API key"
    if any(marker in lowered for marker in
           ("invalid user key", "unauthorized", "401", "403", "auth_error", "forbidden")):
        return {
            "provider": provider.key, "label": provider.label, "kind": "credentials",
            "why": f"{provider.label} rejected the key it was given",
            "fix": f"Check {names}. If it is in the shared store but sealed, sign in "
                   f"to PassBook (`passbook signin`) and restart the stack.",
            "detail": text,
        }
    if "429" in lowered or "too many requests" in lowered or "rate limit" in lowered:
        return {
            "provider": provider.key, "label": provider.label, "kind": "rate-limit",
            "why": f"{provider.label} is rate-limiting this account",
            "fix": "Nothing to fix — the next poll normally clears it.",
            "detail": text,
        }
    return {
        "provider": provider.key, "label": provider.label, "kind": "unreachable",
        "why": f"{provider.label} did not answer",
        "fix": "Usually the marketplace itself; the next poll retries.",
        "detail": text,
    }


def _provider_offers(query: OfferQuery) -> tuple[list[Offer], list[dict]]:
    """Shop every configured marketplace: pool the offers, KEEP the failures.

    A provider that fails is skipped, not fatal. With one marketplace a
    credentials or rate-limit error WAS the answer; with two, letting it
    propagate would blank a Machines view that the other provider could still
    have filled. Total absence of providers is still fatal (see above) — it is
    the case that cannot be waited out.

    But skipped is not the same as unmentioned, and that is the half this used
    to get wrong. An empty pool renders as "No RTX 5090 offers match right
    now", which is a claim about the MARKET — and on 2026-08-28 it was made
    while both marketplaces were answering 401 to a sealed credential and Vast
    alone listed 39 rentable 5090s. The failures therefore travel with the
    offers, and the caller says which of the two happened.
    """
    offers: list[Offer] = []
    failures: list[dict] = []
    for provider in _require_a_marketplace():
        try:
            offers.extend(provider.search_offers(query))
        except ProviderError as exc:
            failures.append(_marketplace_failure(provider, exc))
    return offers, failures


def _search_offers(tier: str, prefer: str = "balanced",
                   gpu_class: str | None = None) -> tuple[list[Offer], int, list[dict]]:
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
        return cached[1], cached[2], cached[3]
    floor = 500 if prefer == "cheapest" else tier_min_down_mbps(tier)
    # dict.fromkeys: prefer="cheapest" starts AT 500, so the plain tuple asked
    # the same question twice on the way down.
    ladder = list(dict.fromkeys((floor, floor // 2, 500)))
    fallback: tuple[list[Offer], int, list[dict]] | None = None
    for candidate_floor in ladder:
        offers, failures = _provider_offers(_offer_query(tier, candidate_floor, gpu_class))
        if not offers:
            # Nothing came back — but WHY decides whether relaxing helps. A
            # link-speed floor no host clears is worth stepping down from; a
            # marketplace that refused our credentials answers the lower floor
            # exactly the same way, so asking twice more only delays the one
            # message that is any use. Stop, and carry the reason out.
            if failures and len(failures) >= len(rental_providers.configured_providers()):
                _offer_cache[key] = (time.time(), [], candidate_floor, failures)
                return [], candidate_floor, failures
            continue
        if fallback is None:
            fallback = (offers, candidate_floor, failures)
        # Relax on what can actually be RENTED, not on what the API returned.
        # This loop used to stop at the first non-empty response, and the
        # filters that run afterwards — min_ram_gb, the half-power SKU drop,
        # the bad-machine cooldown — could then empty it again with no way
        # back. That is how the MiniMax rung came to report "no offers" off a
        # response carrying five: all five were fractional boxes too small to
        # hold H3's weights, and the lower floors that would have found whole
        # machines were never tried. Ranking is pure, so testing it here costs
        # nothing but the extra query, and only on the path that would
        # otherwise have shown the user an empty rung.
        if _rank_offers(tier, offers, limit=1):
            _offer_cache[key] = (time.time(), offers, candidate_floor, failures)
            return offers, candidate_floor, failures
    if fallback is not None:
        # Every floor came back unrentable. Return the strictest non-empty set
        # anyway: the caller renders an empty rung either way, and this keeps
        # min_down_mbps honest about which floor produced it.
        _offer_cache[key] = (time.time(), fallback[0], fallback[1], fallback[2])
        return fallback
    return [], 500, []


def _rank_offers(tier: str, offers: list[Offer], limit: int = 8) -> list[dict]:
    download_gb = tier_download_gb(tier)
    bad_machines = recent_bad_machine_ids()
    dtos = []
    for offer in offers:
        # Drop half-power SKUs before price ranking, which would otherwise
        # prefer them precisely because they are cheap. See _underpowered.
        if _underpowered(offer):
            continue
        # And drop hosts that already failed us today. Cheapest-first ranking
        # otherwise walks straight back onto the machine that just wasted an
        # hour, because nothing about its listing changed when it wedged.
        # machine_id is None on providers that do not expose the physical host
        # (RunPod), and `None in bad_machines` is False, so this correctly does
        # nothing there rather than blocking every offer at once.
        if offer.machine_id is not None and offer.machine_id in bad_machines:
            continue
        # And drop boxes whose container cannot hold the tier's weights in
        # system RAM. This one is not a preference: the box does not render a
        # worse clip, its ComfyUI is killed mid-job. See _starved_of_ram.
        if _starved_of_ram(tier, offer):
            continue
        dto = _offer_dto(offer)
        # What the user actually waits for: the model pull on THIS host. None
        # where the provider does not publish a link speed — an unknown wait,
        # not a zero one.
        dto["setup_minutes"] = (
            round(download_gb * 8 * 1000 / offer.down_mbps / 60, 1) if offer.down_mbps else None
        )
        # A stocked warm volume on this provider: the box would mount it and
        # skip the whole pull — but it then rents on Secure Cloud (network
        # volumes live there), so it is quoted at the SECURE price or not
        # quoted as warm at all. An offer the secure price is unknown for is
        # left cold rather than billed above its quote.
        volume = warm_volume_for(tier, offer.provider)
        secure = (offer.raw or {}).get("securePrice") if volume else None
        if volume and secure:
            dto["usd_per_hour"] = round(float(secure), 4)
            dto["warm"] = True
            dto["warm_volume_id"] = volume["volume_id"]
            dto["warm_data_center"] = volume["data_center_id"]
            dto["setup_minutes"] = WARM_SETUP_MINUTES
        else:
            dto["warm"] = False
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
    offers, floor, failures = _search_offers(tier, prefer, gpu_class)
    return {
        "tier": tier,
        "tier_label": TIERS[tier]["label"],
        "expected": TIERS[tier]["expected"],
        "download_gb": tier_download_gb(tier),
        "min_down_mbps": floor,
        "prefer": prefer,
        "gpu_class": gpu_class,
        # Which marketplaces did not answer this search, if any. An empty
        # `offers` with a failure here is not a sold-out market.
        "marketplace_failures": failures,
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
    offers, floor, failures = _search_offers(tier, prefer)
    classes = tier_gpu_classes(tier)
    grouped: dict[str, list[Offer]] = {key: [] for key in classes}
    for offer in offers:
        key = gpu_class_for_name(offer.gpu_name)
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
            # A stocked warm volume serves this rung: at least one offer mounts
            # it and skips the model pull. Its minutes and region travel with
            # the flag so the card can say so even when the CHEAPEST offer is a
            # cold marketplace box.
            "warm": any(dto.get("warm") for dto in ranked),
            "warm_setup_minutes": next((dto["setup_minutes"] for dto in ranked if dto.get("warm")), None),
            "warm_data_center": next((dto.get("warm_data_center") for dto in ranked if dto.get("warm")), None),
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
        # Which marketplaces went quiet on this search. The rungs cannot say
        # it: an unpriced rung is drawn identically whether the market is sold
        # out or the marketplace refused to talk to us, and the view has to
        # tell the owner which one it is looking at.
        "marketplace_failures": failures,
        "shopped": [p.key for p in rental_providers.configured_providers()],
        "classes": rungs,
    }


# Keyed by provider: two marketplaces, two balances, two independent caches.
_balance_cache: dict[str, dict] = {}
BALANCE_CACHE_SECONDS = 30
# A machine we cannot fund for this long is a machine that dies mid-session:
# marketplaces stop instances once the balance runs past its threshold.
MIN_FUNDED_HOURS = 1.0
# Ceiling on one rent request. Not a technical limit — a guard on a stepper
# that spends real money per click.
MAX_BATCH_MACHINES = 8


def account_balance(provider_key: str) -> dict:
    """One marketplace's credit.

    Per provider and never summed. Vast credit cannot pay for a RunPod pod, so
    a combined figure would authorize rentals the account behind them cannot
    fund — which does not fail loudly, it produces a box that provisions
    (billed) and then dies partway through the session.
    """
    cached = _balance_cache.get(provider_key)
    if cached and time.time() - cached["at"] < BALANCE_CACHE_SECONDS:
        return cached["value"]
    value = {"credit": rental_providers.get(provider_key).credit()}
    _balance_cache[provider_key] = {"at": time.time(), "value": value}
    return value


def _running_burn(instances: list[Instance]) -> float:
    return round(sum(i.usd_per_hour for i in instances if i.state != "stopped"), 4)


def _instances_by_provider() -> dict[str, list[Instance] | None]:
    """Every configured marketplace's rentals, keyed by provider — or None for
    a marketplace whose list call failed.

    The None is the point. _all_instances flattens this and skips the failed
    provider, which is right for a machine LIST (one broken key must not hide
    the boxes billing on the other marketplace) and wrong for anything that
    acts on a machine being ABSENT: a failed call and an empty account both
    flatten to "no instances", and detach_vanished_rentals would tear down a
    live lane on a Vast 429. Callers that act on absence read this form and
    act only where the answer is a list.
    """
    listed: dict[str, list[Instance] | None] = {}
    for provider in _require_a_marketplace():
        try:
            listed[provider.key] = list(provider.list_instances())
        except ProviderError:
            listed[provider.key] = None
    return listed


def _flatten_instances(listed: dict[str, list[Instance] | None]) -> list[Instance]:
    return [instance for instances in listed.values() if instances is not None for instance in instances]


def _all_instances() -> list[Instance]:
    """Every rental on every configured marketplace.

    A provider that fails is skipped rather than fatal, for the same reason as
    _provider_offers: one broken key must not hide the machines that ARE
    running and billing on the other provider. That is the one place where
    swallowing an error is safer than raising it — an unlisted machine is an
    unkillable machine. _instances_by_provider is the same listing in the form
    that still says which marketplace did not answer.
    """
    return _flatten_instances(_instances_by_provider())


def account_state(instances: list[Instance] | None = None) -> dict:
    """Credit and burn, per marketplace and in total.

    `hours_remaining` is the MINIMUM across providers, not a figure derived
    from the totals: the machines that die first are the ones on whichever
    account runs dry first, and averaging that away would report a comfortable
    runway right up until half the fleet stops.
    """
    if instances is None:
        instances = _all_instances()
    if rental_gateway.transport() == rental_gateway.TRANSPORT_GATEWAY:
        # ONE purse. The worker bills HivemindOS credit whichever marketplace
        # the box came from, so per-provider balances do not exist here and
        # the affordability check below reads this row whatever the rung.
        burn = _running_burn(instances)
        try:
            credit = rental_gateway.balance_usd()
        except ProviderError:
            credit = None
        purse = {
            "provider": rental_gateway.PURSE_KEY,
            "label": rental_gateway.PURSE_LABEL,
            "credit_url": rental_gateway.CREDIT_URL,
            "credit": credit,
            "usd_per_hour_running": burn,
            "hours_remaining": round(credit / burn, 1) if credit is not None and burn > 0 else None,
            "machines_running": sum(1 for i in instances if i.state != "stopped"),
        }
        return {
            "credit": credit,
            "usd_per_hour_running": burn,
            "hours_remaining": purse["hours_remaining"],
            "machines_running": purse["machines_running"],
            "providers": [purse],
        }
    per_provider = []
    for provider in rental_providers.configured_providers():
        mine = [i for i in instances if i.provider == provider.key]
        burn = _running_burn(mine)
        try:
            credit = account_balance(provider.key)["credit"]
        except ProviderError:
            credit = None
        per_provider.append({
            "provider": provider.key,
            "label": provider.label,
            "credit_url": provider.credit_url,
            "credit": credit,
            "usd_per_hour_running": burn,
            "hours_remaining": round(credit / burn, 1) if credit is not None and burn > 0 else None,
            "machines_running": sum(1 for i in mine if i.state != "stopped"),
        })
    runways = [p["hours_remaining"] for p in per_provider if p["hours_remaining"] is not None]
    credits = [p["credit"] for p in per_provider if p["credit"] is not None]
    return {
        # Total money on deposit across marketplaces. Spendable only where it
        # sits, which is why `providers` below is the one the UI should show
        # before it offers to rent anything.
        "credit": round(sum(credits), 4) if credits else None,
        "usd_per_hour_running": round(sum(p["usd_per_hour_running"] for p in per_provider), 4),
        "hours_remaining": min(runways) if runways else None,
        "machines_running": sum(p["machines_running"] for p in per_provider),
        "providers": per_provider,
    }


def _probe_instances(instances: list[Instance]) -> list[dict]:
    """DTOs for every instance, probed concurrently.

    A probed DTO is almost entirely network wait: the box's provisioning beacon
    (1.5s ceiling) and an HTTP round-trip through the SSH tunnel (1.5s ceiling).
    Serially, the machine list therefore cost the SUM of every machine's waits —
    and the studios poll this endpoint, so renting a second box made the whole
    Rented panel slower. Measured 2026-08-13 with two live boxes: 2.0s serial
    against 1.6s together (the slowest box alone), and the gap grows with each
    machine. Ordering is preserved; the DTO builder only reads shared state.
    """
    if len(instances) < 2:
        return [_instance_dto(i, probe=True) for i in instances]
    with ThreadPoolExecutor(max_workers=min(8, len(instances))) as pool:
        return list(pool.map(lambda i: _instance_dto(i, probe=True), instances))


def list_rentals(*, settle: bool = True) -> dict:
    """The Machines view's payload.

    `settle` carries the BOOKKEEPING half — destroying a box that failed to
    provision, marking a warm volume stocked, and dropping the lane of a rental
    its marketplace no longer lists. The first two destroy machines, and all of
    it used to run inside the GET that every mounted studio polls. It now
    belongs to the snapshot refresher (register_gpu_rental_routes), which is a
    background thread: a read stays a read, and a request that has to build its
    own snapshot cold does not reap on the way past.
    """
    listed = _instances_by_provider()
    raw = _flatten_instances(listed)
    instances = _probe_instances(raw)
    if settle:
        # A lane whose rental is gone comes down first: the gateway routes by
        # the registry per request, so every poll this waits is another
        # MiniMax job sent to a tunnel with nothing behind it.
        for entry in detach_vanished_rentals(listed):
            print(f"[gpu-rentals] detached lane {entry['lane']}: {entry['reason']}", file=sys.stderr)
        # A stocking box that reports ready has filled its warm volume: mark the
        # volume stocked and destroy the box. Free — the DTOs are in hand.
        try:
            _settle_warm_volumes(instances)
        except Exception as exc:  # never let bookkeeping take the Machines view down
            print(f"[gpu-rentals] warm volume settle failed: {exc}", file=sys.stderr)
        # Free: the DTOs are already in hand, so the box that failed provisioning
        # goes away on the same sweep that noticed it rather than billing until
        # someone reads the screen.
        reaped = {entry["rental_id"] for entry in reap_failed_rentals(instances)
                  if not entry.get("destroy_error")}
        if reaped:
            instances = [dto for dto in instances if dto["rental_id"] not in reaped]
            raw = [i for i in raw if str(i.ref) not in reaped]
    # Never let a balance hiccup take down the machine list — it is the view
    # that tells the user what they are paying for.
    try:
        account = account_state(raw)
    except ProviderError:
        account = {"credit": None, "usd_per_hour_running": _running_burn(raw),
                   "hours_remaining": None, "machines_running": 0, "providers": []}
    # Tier keys ride along so the Machines view discovers tiers instead of
    # hardcoding them (minimax was invisible for exactly that reason).
    return {
        "rentals": instances,
        "tiers": list(TIERS),
        # Machines that failed provisioning and were destroyed. Without this the
        # box would just vanish from the list and the user would be left with a
        # smaller balance and no account of where it went.
        "failures": recent_rental_failures(),
        "account": account,
    }


def _assert_affordable(provider_key: str, count: int, usd_per_hour: float) -> None:
    """Refuse rentals THIS marketplace's credit cannot fund for an hour.

    Marketplaces stop an instance once the balance crosses its threshold, so
    renting past the credit does not fail loudly — it produces a box that
    provisions (billed) and then dies partway through the session. Checked
    against the burn ALREADY running on that same account, including the
    billing gateway's own instances, because they draw on the same balance.

    Per provider, not against the total: the aggregate credit in account_state
    spans two marketplaces that cannot pay each other's bills, so checking a
    RunPod rental against a pile of Vast credit would wave through exactly the
    rental this guard exists to stop.
    """
    provider = rental_providers.get(provider_key)
    try:
        state = account_state()
    except ProviderError:
        return  # Never block a rental because the balance call itself failed.
    purses = state["providers"]
    mine = next((p for p in purses if p["provider"] == provider_key), None)
    if mine is None and len(purses) == 1 and purses[0]["provider"] == rental_gateway.PURSE_KEY:
        # The hosted transport: one HivemindOS purse pays for every
        # marketplace, so it is the account to check whichever rung this is.
        mine = purses[0]
    if not mine or mine["credit"] is None:
        return
    needed = round((mine["usd_per_hour_running"] + usd_per_hour * count) * MIN_FUNDED_HOURS, 2)
    if mine["credit"] >= needed:
        return
    running = mine["machines_running"]
    raise GpuRentalError(
        f"${mine['credit']:.2f} {mine.get('label') or provider.label} credit is not enough to run "
        f"{count} more machine{'s' if count > 1 else ''} at ${usd_per_hour:.3f}/hr"
        + (f" alongside the {running} already running" if running else "")
        + f" — {MIN_FUNDED_HOURS:.0f}h needs ${needed:.2f}. "
        f"Add credit at {mine.get('credit_url') or provider.credit_url} or rent fewer.",
        status_code=402,
    )


def rental_gpu_class(tier: str, gpu_class: str | None = None) -> str:
    """The card a rental of `tier` goes out on — the one asked for, else the
    tier's reference card — refused when the tier cannot run on it.

    Asks no marketplace, so a background order runs it before answering: a
    request that could never succeed is refused at the click, not reported a
    second later as an order that failed."""
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
    return gpu_class


def create_rental(
    tier: str,
    offer_id: str | int | None = None,
    prefer: str = "balanced",
    gpu_class: str | None = None,
    count: int = 1,
    max_usd_per_hour: float | None = None,
    *,
    warm: bool = True,
    _warm_volume: dict | None = None,
    _label_note: str | None = None,
    _on_stage: Callable[[str], None] | None = None,
) -> dict:
    """... `warm`: mount the tier's stocked warm volume on providers that have
    one (RunPod), so the box skips every weight download; False rents a cold
    box even when a volume exists. `_warm_volume`/`_label_note` are how
    create_warm_volume() rents the stocking box: the volume to fill, and a
    label marker the settle step recognises. `_on_stage` hears each step of
    placing the order as it begins — "searching", "preparing", "renting" —
    which is how a background order says where it is."""
    gpu_class = rental_gpu_class(tier, gpu_class)
    stage = _on_stage or (lambda _name: None)
    count = max(1, min(int(count), MAX_BATCH_MACHINES))
    # Renting a box we could never log into bills by the hour for nothing, so
    # prove the key exists BEFORE the money starts (the onstart below embeds it).
    rental_public_key()
    stage("searching")

    # Always search, even when the caller pinned an offer. Marketplace asks go
    # stale within SECONDS, so a UI-supplied offer_id is by definition older
    # than the click that sent it — the search is what stocks the fallbacks
    # (and, for a batch, the other machines' slots). The pin is still tried
    # FIRST below: it is a preference, not a constraint, because failing
    # outright because one ask evaporated is a dead end, not safety.
    searched, _floor, search_failures = _search_offers(tier, prefer, gpu_class)
    ranked = _rank_offers(tier, searched, limit=max(8, count * 3))
    # Candidates are (provider, native offer id). A bare id from an older
    # client still parses, as Vast.
    pinned = RentalRef.parse(offer_id) if offer_id is not None else None
    preferred = [pinned] if pinned else []
    # A stocking box exists to fill ONE provider's volume: an offer from any
    # other marketplace would rent a cold box that cannot mount it and leave
    # the volume empty, so those never enter the candidate list here.
    if _warm_volume:
        ranked = [dto for dto in ranked if dto["provider"] == _warm_volume.get("provider")]
        preferred = [ref for ref in preferred if ref.provider == _warm_volume.get("provider")]
    price_of = {(dto["provider"], dto["offer_id"]): dto["usd_per_hour"] for dto in ranked}
    # Offers quoted warm (secure price, stocked volume) are the only ones that
    # mount the volume: a pinned offer the search did not price stays cold.
    warm_ok = {(dto["provider"], dto["offer_id"]) for dto in ranked if dto.get("warm")}
    fresh = [
        RentalRef(dto["provider"], dto["offer_id"])
        for dto in ranked
        if not pinned or (dto["provider"], dto["offer_id"]) != (pinned.provider, pinned.native)
    ]
    # The price the user clicked bounds what the fallbacks may cost. The pin
    # IS that price and is always tried; everything after it has to land
    # within a few cents or we stop and re-quote rather than quietly renting
    # a pricier host. No cap (older clients, agents) keeps the old behaviour.
    cap = rent_price_cap(max_usd_per_hour) if max_usd_per_hour else None
    if cap is not None:
        fresh = [ref for ref in fresh if price_of.get((ref.provider, ref.native), 0.0) <= cap]
    if not preferred and not fresh:
        cheapest_now = ranked[0]["usd_per_hour"] if ranked else None
        if cap is not None and cheapest_now is not None:
            _forget_offers(tier)
            raise _price_moved(tier, gpu_class, count, max_usd_per_hour, cheapest_now)
        if search_failures:
            # Not a sold-out market: nobody was asked successfully. Renting is
            # where this matters most — "no offers match the tier filters" sent
            # the owner to loosen filters that were never consulted.
            raise GpuRentalError(
                "nothing was rented because no marketplace answered — "
                + "; ".join(f"{f['why']}. {f['fix']}" for f in search_failures),
                status_code=502,
            )
        raise GpuRentalError("no offers currently match the tier filters", status_code=409)
    # Cheapest quote in the qualifying set, and the account it would be spent
    # from. Absent only when the caller pinned an offer the search no longer
    # returns, in which case there is no price to check against and the pin is
    # tried on trust.
    quote = next(iter(ranked), None)
    if quote is not None:
        _assert_affordable(quote["provider"], count, quote["usd_per_hour"])

    # Stocking a warm volume is strict: see _rental_manifest.
    stage("preparing")
    skipped_loras: list[dict] = []
    onstart = _onstart_script(tier, skipped=skipped_loras, strict=bool(_warm_volume))

    stage("renting")
    state: dict[str, Any] = {"tried": 0, "last_error": None}
    # One offer per machine: a marketplace ask is a slot, so renting the same
    # one twice in a batch is how you ask for N machines and get one.
    remaining = preferred + fresh
    created: list[dict] = []

    for _ in range(count):
        rented = None
        while remaining and rented is None:
            candidate = remaining.pop(0)
            provider = rental_providers.get(candidate.provider)
            note = f"-{_label_note}" if _label_note else ""
            label = f"{STUDIO_LABEL_PREFIX}{tier}-{gpu_class}{note}-{uuid.uuid4().hex[:8]}"
            state["tried"] += 1
            # The volume this box mounts, if its provider keeps one for the
            # tier: the one being stocked, or the stocked one every later
            # rental skips its downloads with. A volume pins the box to its
            # data center; a provider without volumes ignores the fields.
            volume = _warm_volume if _warm_volume and _warm_volume.get("provider") == candidate.provider \
                else (warm_volume_for(tier, candidate.provider)
                      if warm and not _warm_volume and (candidate.provider, candidate.native) in warm_ok else None)
            try:
                native_id = provider.create(LaunchSpec(
                    image=comfy_image_for(candidate.provider),
                    disk_gb=tier_disk_gb(tier),
                    label=label,
                    onstart=onstart,
                    # Publish only the beacon; ComfyUI stays on loopback.
                    expose_ports=[BEACON_PORT],
                    offer_id=candidate.native,
                    gpu_names=_gpu_names_for(tier, gpu_class),
                    min_ram_gb=TIERS[tier].get("min_ram_gb") or TIERS[tier]["min_vram_gb"],
                    min_down_mbps=tier_min_down_mbps(tier),
                    network_volume_id=(volume or {}).get("volume_id"),
                    data_center_ids=[volume["data_center_id"]] if volume and volume.get("data_center_id") else [],
                    # The price this ask was shown at — the figure the hosted
                    # worker holds the live rate to. Per offer rather than the
                    # button's number: a fallback within the cap is quoted at
                    # ITS price, and a pin the search no longer lists was
                    # rented at the quote by definition.
                    quoted_usd_per_hour=price_of.get((candidate.provider, candidate.native),
                                                     max_usd_per_hour),
                ))
            except ProviderError as exc:
                if not provider.ask_evaporated(exc):
                    if created:
                        break  # Machines are already billing; report, don't raise.
                    raise
                state["last_error"] = exc
                continue
            rented = {"rental_id": str(RentalRef(candidate.provider, native_id)),
                      "provider": candidate.provider, "label": label,
                      "tier": tier, "gpu_class": gpu_class, "offer_id": candidate.native,
                      # What this machine bills, so the UI can say when it is
                      # not the number the user clicked. A pin the search no
                      # longer lists was rented at the quoted price by
                      # definition — that IS the ask the quote came from.
                      "usd_per_hour": price_of.get((candidate.provider, candidate.native),
                                                   max_usd_per_hour)}
            created.append(rented)
        if rented is None:
            break

    # Either way the market we shopped from is not the market any more: we
    # consumed an ask, or learned the snapshot was stale. Re-price on the
    # next poll instead of showing the pre-rent card for another 45s.
    _forget_offers(tier)

    if not created:
        if cap is not None:
            # Everything within tolerance evaporated; name what is left so the
            # refreshed card and this message agree.
            over = [dto["usd_per_hour"] for dto in ranked if dto["usd_per_hour"] > cap]
            raise _price_moved(tier, gpu_class, count, max_usd_per_hour,
                               min(over) if over else None,
                               because=state["last_error"]) from state["last_error"]
        raise GpuRentalError(
            f"all {state['tried']} candidate offers were taken before we could rent them — "
            "the market moved; try again",
            status_code=409,
        ) from state["last_error"]

    # Single-machine callers keep the flat shape they have always had.
    result = dict(created[0])
    result["rentals"] = created
    result["requested"] = count
    result["quoted_usd_per_hour"] = max_usd_per_hour
    if len(created) < count:
        result["partial"] = (
            f"rented {len(created)} of {count} — the rest of the matching offers were "
            "taken while the batch was going out"
        )
    if skipped_loras:
        # Said where the rent result is read, naming the files: "some LoRAs are
        # missing" would send someone checking all ten by hand.
        names = ", ".join(Path(item["lora"]).name for item in skipped_loras)
        plural = len(skipped_loras) != 1
        note = (
            f"rented without {len(skipped_loras)} pinned LoRA{'s' if plural else ''} Civitai did not "
            f"hand over in time ({names}). The machine and every other LoRA are there — rent again "
            f"later to bring {'them' if plural else 'it'} in"
        )
        result["partial"] = "; ".join(filter(None, [result.get("partial"), note]))
        result["skipped_loras"] = [item["lora"] for item in skipped_loras]
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


def _tunnel_slug(ref: RentalRef) -> str:
    """Filename-safe form of a rental ref.

    "vast:47390808" -> "vast-47390808". A colon is legal in a POSIX filename
    but is the path separator in Finder's presentation layer and in plenty of
    tooling, and these pidfiles are read by hand when a tunnel misbehaves.
    Bare Vast ids written before refs existed slugged to themselves, so old
    pidfiles keep resolving.
    """
    return str(ref).replace(":", "-")


def _tunnel_pid(ref: RentalRef) -> int | None:
    try:
        pid = int((_tunnel_dir() / f"{_tunnel_slug(ref)}.pid").read_text().strip())
        os.kill(pid, 0)
        return pid
    except Exception:
        return None


def _lane_answers(port: int, timeout: float = 1.5) -> bool:
    """Does something on the far end ANSWER on this lane?

    Deliberately a real HTTP request rather than a TCP connect. OpenSSH accepts
    the local connection BEFORE it opens the channel to the far end, so
    connect() succeeds against a forward whose remote service is dead and the
    connection is reset a moment later. Measured on a live lane 2026-08-13:
    connect() SUCCEEDED while the same port answered curl with http_code=000.
    """
    try:
        response = requests.get(
            f"http://127.0.0.1:{int(port)}/system_stats", timeout=timeout
        )
        return response.ok
    except Exception:
        return False


def _lane_comfy_launch_args(port: int, timeout: float = 3.0) -> list[str] | None:
    """The argv ComfyUI behind this lane was launched with, from its /system_stats.

    None when the lane cannot be read or does not publish `system.argv`; the
    caller keeps "unknown" apart from "launched without"."""
    try:
        response = requests.get(
            f"http://127.0.0.1:{int(port)}/system_stats", timeout=timeout
        )
        response.raise_for_status()
        argv = (response.json().get("system") or {}).get("argv")
    except Exception:
        return None
    return [str(item) for item in argv] if isinstance(argv, list) else None


def vram_headroom_gb_from_argv(argv) -> float | None:
    """`--vram-headroom N` (or `--vram-headroom=N`) from a ComfyUI argv, in GB.

    0.0 when the flag is absent (ComfyUI's default), None when argv is unknown.
    Mirrors vram_headroom_gb_from_argv() in packages/media-gateway/app.py, which
    cannot import this package; the last occurrence wins, as argparse has it."""
    if not isinstance(argv, (list, tuple)):
        return None
    items = [str(item) for item in argv]
    value = 0.0
    for index, item in enumerate(items):
        raw = None
        if item == "--vram-headroom" and index + 1 < len(items):
            raw = items[index + 1]
        elif item.startswith("--vram-headroom="):
            raw = item.split("=", 1)[1]
        if raw is None:
            continue
        try:
            value = float(raw)
        except ValueError:
            continue
    return max(0.0, value)


def _tunnel_carrying_traffic(ref: RentalRef, timeout: float = 1.5) -> bool:
    """Is the lane actually usable, not merely the ssh process alive?

    Three layers of this have now been wrong, each one a smaller version of the
    same mistake — checking a proxy for reachability instead of reachability:

      1. a pid check called the tunnel healthy while its forward had been torn
         down by the far end (2026-08-11);
      2. a TCP connect to the local port passed for a forward whose remote
         service was dead, because ssh accepts before it dials (2026-08-13);
      3. so the probe is now a request the far end has to answer.

    What layer 2 cost: ComfyUI on a rental was killed mid-session, and every
    reading stayed green — live ssh pid, accepting local port, `tunnel_alive`
    true — while a submitted job sat rendering nothing. Nobody found out until
    a person asked why there was no clip.
    """
    attachment = _read_attachments().get(str(ref)) or {}
    port = attachment.get("local_port")
    if not port:
        return False
    return _lane_answers(int(port), timeout=timeout)


def _spawn_tunnel(ref: RentalRef, ip: str, ssh_port: str, local_port: int) -> int:
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
        stderr=(_tunnel_dir() / f"{_tunnel_slug(ref)}.log").open("ab"),
    )
    (_tunnel_dir() / f"{_tunnel_slug(ref)}.pid").write_text(str(proc.pid))
    _await_tunnel(ref, proc, local_port)
    return proc.pid


def _await_tunnel(ref: RentalRef, proc: subprocess.Popen, local_port: int, timeout: float = 20.0) -> None:
    """Fail the attach if the tunnel never carries traffic.

    ssh forks, so Popen succeeding says nothing: a rejected key exits a moment
    later and leaves an attachment pointing at a port nobody listens on. That
    happened for real (Vast's proxy refused an account key it had accepted an
    hour earlier on another host), and the studio reported the machine attached
    while every generation had nowhere to go. Wait for the forward, and hand
    back ssh's own last words when it dies.

    Waits for a real ANSWER, not an accepted socket: ssh accepts before it dials
    the far end, so a TCP check here would call the attach a success against a
    box whose ComfyUI is dead — and the studio would list the machine ready
    while every generation had nowhere to land. The two failures get different
    sentences because they need different fixes: a forward that never opened is
    an SSH problem, a forward that opened onto silence is a machine problem."""
    deadline = time.monotonic() + timeout
    forward_opened = False
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            reason = _tunnel_failure_reason(ref)
            _kill_tunnel(ref)
            raise GpuRentalError(
                f"SSH tunnel to the machine failed: {reason}", status_code=502
            )
        if _lane_answers(local_port, timeout=1.0):
            return
        with contextlib.suppress(OSError):
            with socket.create_connection(("127.0.0.1", local_port), timeout=1):
                forward_opened = True
        time.sleep(0.5)
    _kill_tunnel(ref)
    if forward_opened:
        raise GpuRentalError(
            f"The SSH tunnel opened but the machine's ComfyUI did not answer within "
            f"{int(timeout)}s — the box is up and the forward is fine, but nothing is "
            "serving on it. Check /root/comfyui.log on the machine.",
            status_code=502,
        )
    raise GpuRentalError(
        f"SSH tunnel to the machine did not come up within {int(timeout)}s "
        f"({_tunnel_failure_reason(ref)})",
        status_code=504,
    )


def _tunnel_failure_reason(ref: RentalRef) -> str:
    """ssh's last stderr line, which is where the actual cause lives."""
    try:
        lines = [
            line.strip()
            for line in (_tunnel_dir() / f"{_tunnel_slug(ref)}.log").read_text(errors="replace").splitlines()
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


def _kill_tunnel(ref: RentalRef) -> None:
    pid = _tunnel_pid(ref)
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    for suffix in ("pid", "log"):
        try:
            (_tunnel_dir() / f"{_tunnel_slug(ref)}.{suffix}").unlink()
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


def _find_instance(ref: RentalRef) -> Instance:
    """The named rental, from its own provider only.

    Asking one marketplace about another's id would 404 at best; at worst two
    marketplaces hand out the same integer and we act on the wrong box.
    """
    provider = rental_providers.get(ref.provider)
    match = next((i for i in provider.list_instances() if i.native_id == ref.native), None)
    if match is None:
        raise GpuRentalError(f"instance {ref} not found on the account", status_code=404)
    return match


def _lane_port(ref: RentalRef) -> int:
    """A stable local port for this rental's tunnel.

    Numeric ids keep `int % 500` so every Vast machine attached before rental
    refs existed lands on the port it is already tunnelled through — changing
    it would strand a live lane. Anything else hashes, deterministically
    (hash() is salted per process and would move the port across restarts).
    """
    if ref.native.isdigit():
        return TUNNEL_BASE_PORT + (int(ref.native) % 500)
    digest = hashlib.sha256(str(ref).encode()).digest()
    return TUNNEL_BASE_PORT + (int.from_bytes(digest[:4], "big") % 500)


def _lane_name(ref: RentalRef) -> str:
    """The gateway-facing lane name.

    Vast keeps the bare `rental<id>` form it has always had — the name is
    written into COMFY_LANES and COMFY_LANE_RULES, so renaming it would
    re-route every attached machine mid-session. Other providers carry their
    key, which is also what keeps two marketplaces' identical ids apart.
    """
    return f"rental{ref.native}" if ref.provider == "vast" else f"rental{ref.provider}-{ref.native}"


def attach_rental(rental_id: str | int, *, select: bool = False) -> dict:
    ref = RentalRef.parse(rental_id)
    match = _find_instance(ref)
    dto = _instance_dto(match, probe=True)
    if not dto["managed"]:
        raise GpuRentalError("only studio-managed machines can be attached", status_code=409)
    if dto["phase"] != "ready":
        # Carry the provisioning record's own words. "phase: error" alone sent
        # people looking for a broken key when what the box actually had was a
        # marketplace port that does not speak SSH.
        why = (dto.get("provision") or {}).get("detail")
        raise GpuRentalError(
            f"machine is not ready yet (phase: {dto['phase']})" + (f" — {why}" if why else ""),
            status_code=409)
    if not match.ssh_endpoints:
        raise GpuRentalError("instance has no SSH endpoint yet", status_code=409)
    # Try every door before giving up, and say which ones were shut. A
    # marketplace can publish an endpoint that is not SSH at all, and the bare
    # ssh error for that ("Connection closed by remote host") sends everyone
    # hunting for a key or a firewall problem that does not exist.
    endpoint, faults = _reachable_ssh_endpoint(match)
    if endpoint is None:
        raise GpuRentalError(
            "this machine has no working SSH door: " + "; ".join(
                faults or ["the marketplace never published one"]),
            status_code=502,
        )
    ip, ssh_port = endpoint

    tier = _tier_from_label(dto["label"])
    local_port = _lane_port(ref)
    lane = _lane_name(ref)
    if _tunnel_pid(ref) is None:
        _spawn_tunnel(ref, ip, ssh_port, local_port)
    # What the box's ComfyUI was actually launched with. The MiniMax H3
    # motion-reference budget is valid only on a lane running --vram-headroom
    # (this tier's onstart passes it); a box provisioned another way, or whose
    # ComfyUI was relaunched by hand, may not carry it. Recorded so Machines can
    # show it and the attach can say so — the gateway still asks the lane
    # itself per job (POST /api/lanes/resolve), because the registry is a
    # snapshot and the lane is the truth.
    launch_args = _lane_comfy_launch_args(local_port)
    vram_headroom_gb = vram_headroom_gb_from_argv(launch_args)
    attachments = _read_attachments()
    existing = attachments.get(str(ref)) or {}
    # Selecting puts this machine ahead of every other attachment; a plain
    # attach keeps whatever standing it already had (re-attaching a machine
    # after a dropped tunnel must not silently steal routing from the one the
    # user picked), and a first attach lands at the back.
    if select:
        priority = max((a.get("priority") or 0) for a in attachments.values()) + 1 if attachments else 1
    else:
        priority = existing.get("priority") or 0
    attachments[str(ref)] = {
        "lane": lane,
        "local_port": local_port,
        "needles": TIERS[tier]["lane_needles"],
        "tier": tier,
        "studio_pages": TIERS[tier]["studio_pages"],
        "attached_at": existing.get("attached_at") or time.time(),
        "priority": priority,
        "comfy_launch_args": launch_args,
        "vram_headroom_gb": vram_headroom_gb,
    }
    _write_attachments(attachments)
    warnings = []
    required_headroom = TIERS[tier].get("comfy_vram_headroom_gb")
    if required_headroom:
        if vram_headroom_gb is None:
            warnings.append(
                "could not read this machine's ComfyUI launch flags from /system_stats; the "
                f"MiniMax H3 motion-reference budget needs --vram-headroom {required_headroom}, "
                "and the gateway will ask the lane again before each reference-video job"
            )
        elif vram_headroom_gb < required_headroom:
            runs_with = (
                "without --vram-headroom" if vram_headroom_gb == 0
                else f"with --vram-headroom {vram_headroom_gb:g}"
            )
            warnings.append(
                f"this machine's ComfyUI runs {runs_with}; the MiniMax H3 motion-reference "
                f"budget was measured with --vram-headroom {required_headroom} (this tier's "
                "provisioning passes it), so reference-video jobs here are held to the smaller "
                "no-headroom ceiling — re-provision the machine, or relaunch its ComfyUI with the flag"
            )
    paused = _read_paused_state()
    if paused.pop(str(ref), None) is not None:
        _write_paused_state(paused)
    # No restart: the gateway re-reads this registry per request (see
    # refresh_comfy_lanes in packages/media-gateway/app.py), so the lane is live
    # as soon as the file lands. Restarting to add a routing rule killed
    # in-flight generations and made "use this machine" a 30-second event.
    return {"rental_id": str(ref), "attached": True, "lane": lane,
            "restarting_stack": False, "studio_pages": TIERS[tier]["studio_pages"],
            "priority": priority, "vram_headroom_gb": vram_headroom_gb,
            "warnings": warnings}


def select_rental(rental_id: str | int) -> dict:
    """Make this the machine that runs generations for the models it serves.

    Attaching several machines is legitimate — different workloads, different
    lanes — but two that serve the SAME models are a race the user has to be
    able to settle. This is that settlement: attach if needed, then move to
    the front of the first-match lane rules.

    Switching between machines that are ALREADY attached is the common case,
    and it rewrites exactly one integer in a local file. Going through
    attach_rental for that cost a marketplace round-trip plus a beacon fetch
    and a tunnel probe — 2.0s measured with two boxes on 2026-08-13 — which is
    a long time to hold a click that changes nothing on the far end. Nothing is
    skipped: the lane, port, needles and tier were settled at attach time, the
    tunnel is only ever respawned when its pid is gone (attach_rental applies
    the same test), and the gateway re-reads the registry per request.
    """
    ref = RentalRef.parse(rental_id)
    attachments = _read_attachments()
    existing = attachments.get(str(ref))
    if existing and _tunnel_pid(ref) is not None:
        priority = max((a.get("priority") or 0) for a in attachments.values()) + 1
        attachments[str(ref)] = {**existing, "priority": priority}
        _write_attachments(attachments)
        paused = _read_paused_state()
        if paused.pop(str(ref), None) is not None:
            _write_paused_state(paused)
        return {"rental_id": str(ref), "attached": True,
                "lane": existing.get("lane") or _lane_name(ref),
                "restarting_stack": False,
                "studio_pages": existing.get("studio_pages") or [],
                "priority": priority}
    return attach_rental(rental_id, select=True)


def detach_rental(rental_id: str | int, *, restart: bool = False) -> dict:
    """Drop the tunnel and the lane. The gateway notices on its next request.

    `restart` stays as an escape hatch for an operator who has changed the env
    overlay itself (that IS launcher-sourced), but nothing in the normal attach
    or destroy path uses it any more."""
    ref = RentalRef.parse(rental_id)
    _kill_tunnel(ref)
    attachments = _read_attachments()
    removed = attachments.pop(str(ref), None)
    _write_attachments(attachments)
    if removed and restart:
        _schedule_stack_restart()
    return {"rental_id": str(ref), "attached": False,
            "restarting_stack": bool(removed and restart)}


def _managed_instance(ref: RentalRef) -> Instance:
    match = _find_instance(ref)
    if not match.label.startswith(STUDIO_LABEL_PREFIX):
        raise GpuRentalError(
            f"instance {ref} is not managed by the studio — refusing", status_code=409)
    return match


# A box whose provisioning failed will never serve a generation, but it bills
# exactly like one that works — from creation until it is destroyed, and there
# is no refund anywhere in this path. Left alone it burns money forever, and the
# Machines view has to be OPEN for anyone to notice, so the reaper runs on a
# timer too. The grace window exists so the failure is not destroyed the
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


def _billed_hours(dto: dict, now: float) -> float | None:
    """How long a failed box has billed, measured as it is reaped.

    From the provider's start time when there is one — the DTO's uptime_hours
    is the same clock rounded to the minute and read a poll earlier — else
    that rounded figure, else unknown. Unknown is NOT zero: rental
    runpod:vrygri4b9b1x78 (2026-08-22) ran 19 minutes at $0.69/h and went
    into the log as 0.0 h / $0.00, because RunPod's REST payload carries no
    creation time and nothing in the record said the figure was a blank.
    """
    started = dto.get("started_at")
    if started:
        return max(0.0, (now - float(started)) / 3600)
    hours = dto.get("uptime_hours")
    return float(hours) if hours is not None else None


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
        hours = _billed_hours(dto, now)
        rate = dto.get("usd_per_hour") or 0.0
        entry = {
            "rental_id": dto["rental_id"],
            "label": dto.get("label"),
            "tier": dto.get("tier"),
            "gpu_class": dto.get("gpu_class"),
            "gpu": dto.get("gpu"),
            # Remembered so the next search does not hand back the same host.
            "machine_id": dto.get("machine_id"),
            # The beacon's own words — the only account of what went wrong that
            # outlives the machine.
            "reason": provision.get("detail") or "provisioning failed",
            "progress": (f"{provision.get('done')}/{provision.get('total')}"
                         if provision.get("total") else None),
            "uptime_hours": round(hours, 3) if hours is not None else None,
            "usd_per_hour": rate,
            # What the failure cost. Both marketplaces prorate by the second
            # and refund nothing, so this is the number the user actually paid
            # to learn that this host was bad. None when nobody knows: "free"
            # is the one figure that is certainly wrong.
            "usd_spent": round(hours * rate, 4) if hours is not None else None,
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
    """Failures still worth showing — the machine they describe is gone.

    A failure the user has dismissed from the Machines view stays in the log
    (its host is still held out of the next search) but is no longer shown.
    """
    cutoff = time.time() - within_seconds
    return [
        e for e in _read_failure_state()["log"]
        if (e.get("destroyed_at") or 0) >= cutoff and not e.get("dismissed_at")
    ]


# What the worker's ledger says when it ended a rental on its own, in the
# user's terms. Only the codes seen on the live worker are translated; any
# other code is shown as the worker wrote it.
_END_REASON_HINTS = {
    "keepalive-lapsed": (
        "this studio stopped checking in for longer than the hosted marketplace allows "
        "(the Mac was asleep or offline), so the worker released the box as abandoned"
    ),
    "provisioning-failed": "the box never finished provisioning, so the worker released it",
}


def _ledger_row(ref: RentalRef) -> dict | None:
    """The worker's ledger entry for this rental — hosted transport only.

    Never raises: the reason is a courtesy on top of the detach, and a worker
    that cannot be reached must not keep a dead lane routing.
    """
    if rental_gateway.transport() != rental_gateway.TRANSPORT_GATEWAY:
        return None
    try:
        rows = rental_gateway.rentals()
    except Exception:  # noqa: BLE001 — ProviderError, and anything under it
        return None
    matches = [
        row for row in rows
        if str(row.get("provider") or "").lower() == ref.provider
        and str(row.get("nativeId") or "") == ref.native
    ]
    ended = [row for row in matches if str(row.get("status") or "").lower() == "ended"]
    return (ended or matches)[-1] if matches else None


def _ledger_hours(row: dict) -> float | None:
    """How long the box ran by the ledger's own clock; None when it is not there."""
    try:
        started = datetime.fromisoformat(str(row["startedAt"]).replace("Z", "+00:00"))
        ended = datetime.fromisoformat(str(row["endedAt"]).replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError):
        return None
    return max(0.0, (ended - started).total_seconds() / 3600)


def detach_vanished_rentals(listed: dict[str, list[Instance] | None]) -> list[dict]:
    """Drop every attachment whose rental its marketplace no longer lists.

    The studio's own destroy and reap paths detach before a box goes away,
    but a rental can end WITHOUT the studio: the hosted worker stops one whose
    keepalive lapsed (this Mac asleep — 2026-09-14, Vast 50991951), whose
    provisioning stalled or whose lifetime cap passed, and a marketplace
    reclaims a box when the account runs dry. None of that ran detach_rental,
    so the registry kept naming the lane, the gateway kept routing MiniMax
    jobs to a tunnel with nothing behind it, and the Machines list — where
    the error said to re-attach from — was empty.

    `listed` is _instances_by_provider(): a lane is dropped only when ITS
    provider's list call succeeded and came back without the rental. A
    failed call (None) keeps every attachment it covers — an empty answer
    from a broken key is not an empty account, and detaching on it would
    take a live machine out of routing for a Vast 429. A provider missing
    from `listed` is not configured here, and its lanes are left alone for
    the same reason.

    Recorded in the failure log like a reaped box, with the worker's own end
    reason when its ledger has one, so the Machines view can say what
    happened to a machine that has simply stopped being there. Never raises:
    this runs inside the snapshot refresher and the reaper sweep.
    """
    attachments = _read_attachments()
    if not attachments:
        return []
    present = {
        provider: {instance.native_id for instance in instances}
        for provider, instances in listed.items() if instances is not None
    }
    recorded: list[dict] = []
    state: dict | None = None
    now = time.time()
    for key, attachment in list(attachments.items()):
        try:
            ref = RentalRef.parse(key)
        except ProviderError:
            continue
        if str(ref) != key or ref.provider not in present or ref.native in present[ref.provider]:
            # A key detach_rental could not remove anyway (pre-RentalRef, bare
            # int), a marketplace that did not answer, or a box still there.
            continue
        lane = attachment.get("lane") or _lane_name(ref)
        row = _ledger_row(ref) or {}
        end_reason = str(row.get("endReason") or "").strip() or None
        if end_reason:
            hint = _END_REASON_HINTS.get(end_reason)
            reason = (
                f"the hosted marketplace ended rental {ref} ({end_reason})"
                + (f": {hint}" if hint else "")
                + f". Its lane {lane} was detached so jobs stop routing to the dead tunnel."
            )
        else:
            reason = (
                f"{rental_providers.get(ref.provider).label} no longer lists rental {ref}; it "
                f"ended outside the studio. Its lane {lane} was detached so jobs stop routing "
                f"to the dead tunnel."
            )
        tier = attachment.get("tier")
        hours = _ledger_hours(row) if row else None
        rate = row.get("rateUsdPerHour")
        spent = row.get("chargedUsd")
        entry = {
            "kind": "vanished",
            "rental_id": str(ref),
            "provider": ref.provider,
            "label": row.get("label"),
            "tier": tier,
            "tier_label": TIERS[tier]["label"] if tier in TIERS else None,
            "lane": lane,
            "gpu_class": None,
            "gpu": None,
            # No host is indicted: the box went away, it did not fail us.
            "machine_id": None,
            "reason": reason,
            "end_reason": end_reason,
            "progress": None,
            "uptime_hours": round(hours, 3) if hours is not None else None,
            "usd_per_hour": float(rate) if isinstance(rate, (int, float)) else None,
            "usd_spent": round(float(spent), 4) if isinstance(spent, (int, float)) else None,
            # The recency clock recent_rental_failures reads: the box is as
            # gone as a destroyed one.
            "destroyed_at": now,
            "detached_at": now,
        }
        try:
            detach_rental(ref)
        except Exception as exc:  # noqa: BLE001 — a failed detach must not break the sweep
            entry["detach_error"] = str(exc)[:200]
        else:
            # The remembered beacon reading described a box that is gone.
            _forget_beacon(str(ref))
        if state is None:
            state = _read_failure_state()
        state["log"].append(entry)
        recorded.append(entry)
    if state is not None:
        _write_failure_state(state)
    return recorded


def _same_rental(left: Any, right: Any) -> bool:
    """Older log entries carry a bare Vast int; the view sends "vast:31"."""
    try:
        return str(RentalRef.parse(left)) == str(RentalRef.parse(right))
    except ProviderError:
        return str(left) == str(right)


def dismiss_rental_failures(rental_id: str | None = None) -> dict:
    """Hide recorded failures from the Machines view — one rental's, or all.

    Dismissing is not forgetting: the entry stays in the log so the host that
    failed is still barred from the next search (recent_bad_machine_ids reads
    the same log). Only the notice goes away. A rental can have several
    entries — a destroy that kept failing re-records each sweep — and one
    dismissal covers all of them: they are the same failure.
    """
    state = _read_failure_state()
    now = time.time()
    dismissed = 0
    for entry in state["log"]:
        if entry.get("dismissed_at"):
            continue
        if rental_id is not None and not _same_rental(entry.get("rental_id"), rental_id):
            continue
        entry["dismissed_at"] = now
        dismissed += 1
    if dismissed:
        _write_failure_state(state)
    return {"dismissed": dismissed, "failures": recent_rental_failures()}


# How long a host that just failed us stays out of the running. Long enough to
# get through a session without meeting it twice; short enough that a host with
# one bad day is not blacklisted forever.
BAD_MACHINE_COOLDOWN_SECONDS = int(os.environ.get("HIVEMIND_RENTAL_BAD_MACHINE_HOURS", "24")) * 3600


def _shared_bad_machine_ids() -> set[int]:
    """Machines that failed the HOSTED renter, which rents from this same Vast
    account. Asked of the worker at rental_gateway.url() — the same resolver
    every hosted call uses, so the default applies here too; the env override
    predates the hosted transport and still works.

    Fails open on purpose: a blocklist is an optimisation, and a gateway that
    is slow or down must never be the reason a machine cannot be rented.
    """
    base = rental_gateway.url()
    shared: set[int] = set()
    try:
        response = requests.get(
            f"{base}/v1/bad-machines", headers={"Accept": "application/json"}, timeout=2,
        )
        response.raise_for_status()
        payload = response.json()
        for entry in payload.get("machines") or []:
            for key in ("machineId", "hostId"):
                with contextlib.suppress(TypeError, ValueError):
                    if entry.get(key) is not None:
                        shared.add(int(entry[key]))
    except Exception:
        return set()
    return shared


def recent_bad_machine_ids(within_seconds: float = BAD_MACHINE_COOLDOWN_SECONDS) -> set[int]:
    """Hosts that failed recently, by physical machine.

    Every offer we rank passes Vast's own reliability filter (reliability2 >
    0.99), and the host that never started a container had passed it too — so
    the market's score cannot be the only guard. Experience of a host is the
    evidence it does not have — ours locally, and the hosted gateway's, which
    rents from the same account and meets the same hardware.
    """
    cutoff = time.time() - within_seconds
    bad: set[int] = set()
    for entry in _read_failure_state()["log"]:
        if (entry.get("destroyed_at") or 0) < cutoff:
            continue
        machine_id = entry.get("machine_id")
        if machine_id is not None:
            with contextlib.suppress(TypeError, ValueError):
                bad.add(int(machine_id))
    return bad | _shared_bad_machine_ids()


# --- warm volumes ----------------------------------------------------------
# The "no download at all" provisioning path. A persistent network volume on
# RunPod is stocked ONCE with a tier's weights (by a normal rental of that tier
# whose models directory is the volume, destroyed the moment it reports ready),
# and every later rental of the tier in that data center mounts it at
# /workspace: the provisioning script's `[ -s file ] || pget` skips every
# weight, so the box goes boot -> node installs -> ComfyUI up. Measured
# 2026-08-22: a cold Vast PRO 6000 spent 25 of its 27 provisioning minutes on
# downloads. Vast has no volume that survives a box, so this is RunPod-only and
# a Vast rental is never affected by it.
#
# Registry: one entry per (provider, tier) in rental-warm-volumes.json —
#   {"provider", "volume_id", "data_center_id", "size_gb", "created_at",
#    "state": "stocking" | "stocked" | "error", "stocking_rental_id",
#    "stocked_at", "detail"}
# The stocking rental is an ordinary managed rental (label carries "-stock-")
# so every existing reaper, beacon and billing rule applies to it; what is
# special is only that list_rentals() finishes the job: when it reports ready
# the volume is marked stocked and the rental destroyed, when it reports error
# the volume is marked error (and left, so the bytes already on it are not
# thrown away — a retry re-stocks in place).

WARM_VOLUME_PROVIDER = "runpod"

# RunPod network-volume storage, from their published pricing (read 2026-08-22
# at docs.runpod.io/storage/network-volumes): the first 1 TB is $0.07/GB/month,
# anything beyond it $0.05. A volume bills from the moment it is created until
# it is deleted — whether or not any pod is attached to it, and whether or not
# it ever gets used again. That is exactly why the studio shows a RUNNING TOTAL
# next to the rate: a warm region is the one piece of studio spend with no
# machine in the Machines list to remind you it exists, and $8.40/month is
# invisible until someone goes looking for it.
WARM_VOLUME_USD_PER_GB_MONTH = 0.07
WARM_VOLUME_USD_PER_GB_MONTH_ABOVE_1TB = 0.05
WARM_VOLUME_FIRST_TIER_GB = 1024
# The month the per-month rate is quoted against, in hours (365.25/12*24). Used
# to turn the rate into the hourly accrual the total is built from.
WARM_VOLUME_HOURS_PER_MONTH = 730.5


def warm_volume_monthly_usd(size_gb: float) -> float:
    """What a volume of this size costs for a month, on RunPod's tiered rate."""
    size = max(0.0, float(size_gb or 0))
    first = min(size, WARM_VOLUME_FIRST_TIER_GB)
    beyond = max(0.0, size - WARM_VOLUME_FIRST_TIER_GB)
    return round(
        first * WARM_VOLUME_USD_PER_GB_MONTH
        + beyond * WARM_VOLUME_USD_PER_GB_MONTH_ABOVE_1TB,
        4,
    )


def warm_volume_costs(entry: dict, now: float | None = None) -> dict:
    """Rate and running total for one warm volume.

    `usd_accrued` runs from the volume's creation, not from when it finished
    stocking: RunPod bills the storage the moment the volume exists, and a
    volume whose stocking box failed is still charging for the bytes on it.
    Absent when we do not know when it was created — an unknown start must
    read as unknown, never as zero spent.
    """
    monthly = warm_volume_monthly_usd(entry.get("size_gb"))
    hourly = monthly / WARM_VOLUME_HOURS_PER_MONTH if monthly else 0.0
    created = entry.get("created_at")
    try:
        created = float(created)
    except (TypeError, ValueError):
        created = None
    age_hours = max(0.0, ((now if now is not None else time.time()) - created) / 3600) if created else None
    return {
        "usd_per_month": monthly,
        "usd_per_hour": round(hourly, 6),
        "age_hours": round(age_hours, 2) if age_hours is not None else None,
        "usd_accrued": round(hourly * age_hours, 4) if age_hours is not None else None,
    }

# What a warm box costs in provisioning time: boot, node installs, ComfyUI up,
# no weights to pull. Measured 2026-08-22: a RunPod 5090 in EU-RO-1 on the
# stocked H3 volume went create -> "ComfyUI is up" in 144 s (the same tier
# cold on a Vast PRO 6000 that morning: 27 min). Quoted as 3 to stay honest
# about boot variance.
WARM_SETUP_MINUTES = 3
# How long a resumed box may stay stopped before the studio says the GPU is
# probably gone. Vast's guidance is ">30 seconds"; a minute leaves room for
# the marketplace's own polling without hiding the condition.
RESUME_GRACE_SECONDS = 60


def _warm_volumes_path() -> Path:
    return MEDIA_STATE_ROOT / "rental-warm-volumes.json"


def _read_warm_volumes() -> dict[str, dict]:
    try:
        data = json.loads(_warm_volumes_path().read_text())
    except Exception:
        return {}
    return {k: v for k, v in (data or {}).items() if isinstance(v, dict)}


def _write_warm_volumes(state: dict[str, dict]) -> None:
    MEDIA_STATE_ROOT.mkdir(parents=True, exist_ok=True)
    _warm_volumes_path().write_text(json.dumps(state, indent=1))


def warm_volume_for(tier: str, provider_key: str = WARM_VOLUME_PROVIDER) -> dict | None:
    """The stocked volume a new rental of this tier should mount, or None."""
    entry = _read_warm_volumes().get(f"{provider_key}:{tier}")
    if entry and entry.get("state") == "stocked" and entry.get("volume_id"):
        return entry
    return None


def list_warm_volumes() -> list[dict]:
    out = []
    now = time.time()
    for key, entry in sorted(_read_warm_volumes().items()):
        provider_key, _, tier = key.partition(":")
        out.append({"key": key, "provider": provider_key, "tier": tier,
                    "tier_label": TIERS.get(tier, {}).get("label", tier), **entry,
                    **warm_volume_costs(entry, now)})
    return out


def create_warm_volume(tier: str, data_center_id: str, *, gpu_class: str | None = None,
                       offer_id: str | None = None,
                       provider_key: str = WARM_VOLUME_PROVIDER, size_gb: int | None = None) -> dict:
    """Create the volume and start stocking it: one managed rental of the tier
    in that data center with the volume mounted. Idempotent per (provider,
    tier): an existing entry is re-stocked in place instead of duplicated.

    `offer_id` pins the stocking box's GPU type ("runpod:NVIDIA GeForce RTX
    4090"). The box that fills the volume only downloads and boots ComfyUI, so
    the cheapest type the data center has in stock is the right one — the
    tier's own ladder (Blackwell-only for H3) is for the boxes that render.
    """
    if tier not in TIERS:
        raise GpuRentalError(f"unknown tier: {tier}", status_code=400)
    provider = rental_providers.get(provider_key)
    if not hasattr(provider, "create_network_volume"):
        raise GpuRentalError(f"{provider_key} has no persistent volumes", status_code=400)
    key = f"{provider_key}:{tier}"
    volumes = _read_warm_volumes()
    entry = volumes.get(key) or {}
    if entry.get("state") == "stocking" and entry.get("stocking_rental_id"):
        raise GpuRentalError(f"a stocking rental is already running for {key}: "
                             f"{entry['stocking_rental_id']}", status_code=409)
    size = int(size_gb or tier_disk_gb(tier))
    if not entry.get("volume_id") or entry.get("data_center_id") != data_center_id:
        volume_id = provider.create_network_volume(
            f"hivemind-warm-{tier}-{data_center_id.lower()}", size, data_center_id)
        entry = {"provider": provider_key, "volume_id": volume_id, "data_center_id": data_center_id,
                 "size_gb": size, "created_at": time.time()}
    entry.update({"state": "stocking", "detail": "", "stocked_at": None, "stocking_rental_id": None})
    volumes[key] = entry
    _write_warm_volumes(volumes)
    try:
        rented = create_rental(tier, offer_id=offer_id, gpu_class=gpu_class, count=1,
                               _warm_volume=entry, _label_note="stock")
    except Exception as exc:
        entry.update({"state": "error", "detail": f"could not rent a stocking box: {exc}"})
        volumes[key] = entry
        _write_warm_volumes(volumes)
        raise
    entry["stocking_rental_id"] = rented["rental_id"]
    volumes[key] = entry
    _write_warm_volumes(volumes)
    return {"key": key, **entry}


def delete_warm_volume(tier: str, provider_key: str = WARM_VOLUME_PROVIDER) -> dict:
    key = f"{provider_key}:{tier}"
    volumes = _read_warm_volumes()
    entry = volumes.pop(key, None)
    if not entry:
        raise GpuRentalError(f"no warm volume for {key}", status_code=404)
    if entry.get("stocking_rental_id"):
        try:
            destroy_rental(entry["stocking_rental_id"])
        except Exception:
            pass
    rental_providers.get(provider_key).delete_network_volume(entry["volume_id"])
    _write_warm_volumes(volumes)
    return {"key": key, "deleted": True, **entry}


def _settle_warm_volumes(instances: list[dict]) -> None:
    """Called from list_rentals() with the DTOs it is about to return: a
    stocking rental that reports ready has filled its volume — mark it stocked
    and destroy the box (the volume outlives it); one that reports error marks
    the volume error and is left to the reaper like any failed rental."""
    volumes = _read_warm_volumes()
    if not volumes:
        return
    by_id = {str(i.get("rental_id")): i for i in instances}
    changed = False
    for key, entry in volumes.items():
        rid = entry.get("stocking_rental_id")
        if entry.get("state") != "stocking" or not rid:
            continue
        dto = by_id.get(str(rid))
        if dto is None:
            continue
        phase = dto.get("phase")
        if phase == "ready":
            entry.update({"state": "stocked", "stocked_at": time.time(), "stocking_rental_id": None,
                          "detail": f"stocked by {rid}"})
            changed = True
            try:
                destroy_rental(rid)
            except Exception as exc:
                entry["detail"] += f"; stocking box could not be destroyed: {exc}"
        elif phase == "error":
            entry.update({"state": "error", "detail": (dto.get("provision") or {}).get("detail") or "stocking failed"})
            changed = True
    if changed:
        _write_warm_volumes(volumes)


def pause_rental(rental_id: str | int) -> dict:
    """Stop the box but KEEP its disk: models stay downloaded, so resuming
    skips the whole model pull. Both marketplaces bill storage only while
    stopped.

    Attachment is torn down first (a tunnel to a stopped box is a dead lane)
    but remembered, so resume can restore studio routing automatically.
    """
    ref = RentalRef.parse(rental_id)
    _managed_instance(ref)
    was_attached = str(ref) in _read_attachments()
    detach_rental(ref, restart=was_attached)
    rental_providers.get(ref.provider).pause(ref.native)
    paused = _read_paused_state()
    paused[str(ref)] = {"was_attached": was_attached, "paused_at": time.time()}
    _write_paused_state(paused)
    return {"rental_id": str(ref), "paused": True, "was_attached": was_attached}


def resume_rental(rental_id: str | int) -> dict:
    """Start a paused box. The provisioning script re-runs and is idempotent:
    the model downloads all skip (files present), so it goes straight to
    launching ComfyUI. Routing is restored if it was attached when paused.
    """
    ref = RentalRef.parse(rental_id)
    _managed_instance(ref)
    rental_providers.get(ref.provider).resume(ref.native)
    paused = _read_paused_state()
    entry = paused.pop(str(ref), {})
    # Remembered so the Machines view can tell a restart the host is honouring
    # from one it is not: Vast documents that a stopped box restarts only "if
    # GPU available" and sits in "Scheduling" otherwise — "if stuck >30
    # seconds, GPU likely rented by another user". The flag below reads this.
    paused[str(ref)] = {"pending_reattach": bool(entry.get("was_attached")),
                        "resumed_at": time.time()}
    _write_paused_state(paused)
    return {"rental_id": str(ref), "resuming": True,
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


def destroy_rental(rental_id: str | int) -> dict:
    ref = RentalRef.parse(rental_id)
    match = _find_instance(ref)
    label = match.label
    if not label.startswith(STUDIO_LABEL_PREFIX):
        raise GpuRentalError(
            f"instance {ref} ({label or 'no label'}) is not managed by the studio — refusing to destroy",
            status_code=409,
        )
    # Never leave routing pointed at a dead box: tear down any attachment
    # (tunnel + overlay entry) before the instance goes away. No stack restart
    # is involved any more — the gateway re-reads the attachment registry per
    # request, so the lane is gone the moment this returns.
    detach_rental(ref)
    rental_providers.get(ref.provider).destroy(ref.native)
    # The remembered reading dies with the box it described.
    _forget_beacon(str(ref))
    return {"rental_id": str(ref), "destroyed": True, "restarting_stack": False}


# How often the reaper sweeps when nobody has the Machines view open. Long,
# because it costs a Vast call and the money at stake is bounded by the
# provisioning deadline; the polling path already reaps within seconds while
# anyone is watching. Backs off further when the account has no studio boxes.
REAPER_INTERVAL_SECONDS = 180
REAPER_IDLE_INTERVAL_SECONDS = 900
# The hosted worker meters a rental in prepaid ten-minute blocks and can only
# reserve the next block while it holds THIS account's token — which it has
# exactly when this studio lists its instances. A reservation the worker has
# not settled inside the credit authority's 15-minute TTL is released, and a
# rental whose meter goes unfed past its grace is destroyed as abandoned
# ("keepalive-lapsed"). So while any hosted rental exists — paused ones too,
# their disk still meters — the sweep lists at least this often. 150 s rather
# than the 180 s the contract allows, because a sweep also probes every box
# (seconds each) and the cadence is measured from the previous LIST, not from
# the end of the previous sweep.
GATEWAY_KEEPALIVE_SECONDS = 150


def _reaper_loop(stopping: threading.Event | None = None) -> None:
    # `stopping` is the app's shutdown event: waiting on it rather than
    # sleeping means a stop ends the sweep between passes instead of the
    # interpreter tearing the thread down mid-marketplace-call.
    stopping = stopping or threading.Event()
    delay = REAPER_INTERVAL_SECONDS
    while not stopping.wait(delay):
        try:
            listed = _instances_by_provider()
            instances = _flatten_instances(listed)
            managed = [i for i in instances if i.label.startswith(STUDIO_LABEL_PREFIX)]
            # A rental that ended without the studio (the worker stopped it,
            # the account ran dry) leaves its lane routing to nothing until
            # somebody detaches it. This sweep is what runs while nobody has
            # the Machines view open, so it is done here as well — and not
            # behind the autoreap switch: that keeps a FAILED box alive for a
            # hand recovery, and a box that no longer exists has nothing to
            # recover.
            for entry in detach_vanished_rentals(listed):
                print(f"[gpu-rentals] detached lane {entry['lane']} — rental {entry['rental_id']} "
                      f"is gone: {entry['reason']}", flush=True)
            if RENTAL_AUTOREAP:
                # Probe the beacon only for studio boxes: the phase this turns
                # on is the whole reason for the sweep. With autoreap off the
                # list above is still made — it is the keepalive — but nothing
                # is probed or destroyed; that switch exists to keep a box
                # alive for a hand recovery.
                for entry in reap_failed_rentals([_instance_dto(i, probe=True) for i in managed]):
                    spent = entry.get("usd_spent")
                    cost = f"${spent:.2f} spent" if spent is not None else "cost unknown"
                    print(f"[gpu-rentals] destroyed failed rental {entry['rental_id']} "
                          f"({cost}): {entry['reason']}", flush=True)
            delay = REAPER_INTERVAL_SECONDS if managed else REAPER_IDLE_INTERVAL_SECONDS
            if instances and rental_gateway.transport() == rental_gateway.TRANSPORT_GATEWAY:
                # Everything the worker lists is this account's and metered.
                delay = min(delay, GATEWAY_KEEPALIVE_SECONDS)
        except Exception:
            # A marketplace hiccup must not kill the sweeper for the process
            # lifetime.
            delay = REAPER_INTERVAL_SECONDS


# POST /api/gpu-rentals is money. A retry after a proxy timeout (the Hivemind
# Link leg is 190 s), a second tab, or a refresh mid-request used to rent a
# SECOND billing machine. Two guards, both in-process: a client-generated
# ``request_id`` whose result is replayed for a while, and one rent in flight
# per tier at a time.
RENTAL_REQUEST_TTL_SECONDS = 600.0
_rental_requests: dict[str, tuple[float, dict]] = {}
_rental_requests_lock = threading.Lock()
_rentals_in_flight: set[str] = set()
_rentals_in_flight_lock = threading.Lock()
RENTAL_IN_FLIGHT_DETAIL = "A rental is already being placed for this tier — wait for it to appear in the list"


def _replayed_rental(request_id: str) -> dict | None:
    now = time.monotonic()
    with _rental_requests_lock:
        for key in [key for key, (at, _) in _rental_requests.items() if now - at > RENTAL_REQUEST_TTL_SECONDS]:
            _rental_requests.pop(key, None)
        entry = _rental_requests.get(request_id)
    return dict(entry[1]) if entry else None


def _remember_rental(request_id: str, result: dict) -> None:
    with _rental_requests_lock:
        _rental_requests[request_id] = (time.monotonic(), dict(result))


# POST /api/gpu-rentals {"background": true} places the rent as an ORDER and
# answers at once; the list reports the order until it resolves. The click used
# to hold one request open for the whole placement — offer search 4.7s, credit
# check 3.2s, the Civitai links 1.6s (96s on a slow day), the manifest upload,
# then the marketplace's own order, measured on the Eros tier 2026-09-15 —
# behind a spinner that had nothing to say. An order names the step it is on,
# and a finished one is kept for the replay window so a view that missed the
# moment still reads how it ended.
_rental_orders: dict[str, dict] = {}
_rental_orders_lock = threading.Lock()


def _open_rental_order(order_id: str, tier: str, gpu_class: str, count: int,
                       quoted_usd_per_hour: float | None) -> dict:
    order = {
        "order_id": order_id,
        "tier": tier,
        "tier_label": TIERS[tier]["label"],
        "gpu_class": gpu_class,
        "gpu_label": GPU_CLASSES.get(gpu_class, {}).get("label", gpu_class),
        "count": count,
        "quoted_usd_per_hour": quoted_usd_per_hour,
        # searching → preparing → renting → placed | failed
        "stage": "searching",
        "started_at": time.time(),
        "finished_at": None,
        "rental_ids": [],
        "usd_per_hour": None,
        "partial": None,
        "error": None,
    }
    with _rental_orders_lock:
        _rental_orders[order_id] = order
        return dict(order)


def _update_rental_order(order_id: str, **fields: Any) -> None:
    with _rental_orders_lock:
        if order_id in _rental_orders:
            _rental_orders[order_id].update(fields)


def rental_order(order_id: str) -> dict | None:
    with _rental_orders_lock:
        order = _rental_orders.get(order_id)
        return dict(order) if order else None


def rental_orders() -> list[dict]:
    """Every open order, and the finished ones still inside the replay window."""
    now = time.time()
    with _rental_orders_lock:
        for key in [key for key, order in _rental_orders.items()
                    if order["finished_at"] and now - order["finished_at"] > RENTAL_REQUEST_TTL_SECONDS]:
            _rental_orders.pop(key, None)
        return sorted((dict(order) for order in _rental_orders.values()), key=lambda order: order["started_at"])


# How long one machine-list snapshot serves every poller. Each mounted studio
# asks every 30s (8s while a box provisions) and the Machines view asks too, and
# a build lists every configured marketplace and probes every box (1.5s beacon +
# 1.5s tunnel ceilings). Ten seconds is under the fastest poll, so a stale answer
# is never what anybody is looking at.
RENTALS_SNAPSHOT_TTL_SECONDS = 10.0


def _rental_state_fingerprint() -> tuple:
    """What the DTOs read off disk: paused boxes, failure notices, attachments.

    A snapshot may only be reused while these are unchanged. Pausing a box,
    resuming it, attaching a lane or dismissing a failure has to show on the
    very NEXT poll — a ten-second-old answer to "did my click land" is a bug
    report, not a cache hit. Named files rather than a listing of the whole
    state directory, which the media gateway also writes to: unrelated churn
    there would defeat the cache without changing a single machine.
    """
    stamped = []
    for path in (
        _failure_state_path(), _paused_state_path(), _warm_volumes_path(),
        _attach_registry_path(), _overlay_env_path(), _tunnel_dir(),
    ):
        try:
            stat = path.stat()
        except OSError:
            stamped.append((path.name, None, None))
            continue
        stamped.append((path.name, stat.st_mtime_ns, stat.st_size))
    return tuple(stamped)


def register_gpu_rental_routes(app, require_owner) -> None:
    """Attach the owner-gated rental routes to the control API app."""
    from fastapi import Body, Depends, HTTPException
    from fastapi.responses import JSONResponse

    def _guard(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except ProviderError as exc:
            # ProviderError, not GpuRentalError: a marketplace failure raised
            # inside rental_providers/ is the base class, and catching only the
            # subclass would turn a Vast 429 into an unhandled 500.
            payload = getattr(exc, "payload", None)
            if payload:
                # A refusal the view is meant to act on. hubData's api() already
                # reads `message`/`remedy` off an object detail, so the extra
                # keys ride alongside without changing what a plain client sees.
                raise HTTPException(
                    status_code=exc.status_code,
                    detail={"message": str(exc), "remedy": getattr(exc, "remedy", ""), **payload},
                ) from exc
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        except requests.RequestException as exc:
            # A ConnectionError/Timeout out of the provider session is not a
            # ProviderError; Machines offline used to be a plain-text 500.
            raise HTTPException(status_code=503, detail="The GPU marketplace is unreachable") from exc

    def _start_rental_reaper() -> None:
        # Warm each marketplace connection off the request path. The first
        # call in a fresh process pays DNS + TLS — measured at ~7s against a
        # ~0.2s median once the pool is established — and the user who eats it
        # is whoever opens Machines first after a stack restart, staring at a
        # view that looks broken. Also primes the balance caches.
        def _warm() -> None:
            for provider in rental_providers.configured_providers():
                try:
                    account_balance(provider.key)
                except Exception:
                    pass  # no key, no network: the real request will report it

        stopping = getattr(app.state, "shutting_down", None)
        if not isinstance(stopping, threading.Event):
            stopping = threading.Event()
        threading.Thread(target=_warm, name="gpu-rental-warm", daemon=True).start()
        # Started whatever RENTAL_AUTOREAP says: the loop is also the hosted
        # meter's keepalive, and a debugging switch must not be what lets a
        # rental lapse. The switch is honoured inside the loop, where it
        # keeps the sweep from probing or destroying anything.
        threading.Thread(target=_reaper_loop, args=(stopping,), name="gpu-rental-reaper", daemon=True).start()

    # The control app runs these from its lifespan handler; an app without
    # that list (another host embedding these routes) gets the event hook.
    hooks = getattr(app.state, "startup_hooks", None)
    if isinstance(hooks, list):
        hooks.append(_start_rental_reaper)
    else:
        app.add_event_handler("startup", _start_rental_reaper)

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

    # One snapshot for every poller, per app instance (an embedding host — and
    # each test — starts with an empty one). Refreshed on a background thread so
    # no request ever waits on the marketplace round trips, and the reap/settle
    # bookkeeping rides that thread rather than the GET. Kicked BY a request
    # rather than run on a timer: nobody watching means nothing to refresh, and
    # the standing reaper thread already covers the money side on its own clock.
    rentals_snapshot: dict[str, Any] = {"payload": None, "at": 0.0, "state": (), "generation": 0}
    rentals_refreshing = threading.Event()

    def _store_rentals_snapshot(payload: dict, generation: int | None = None) -> dict:
        # A build that began before a rent landed must not put back the list
        # the rent just retired (see _forget_rentals_snapshot).
        if generation is None or generation == rentals_snapshot["generation"]:
            rentals_snapshot.update(payload=payload, at=time.monotonic(), state=_rental_state_fingerprint())
        return payload

    def _forget_rentals_snapshot() -> None:
        """A machine was just rented, so every snapshot so far predates it.

        The view re-reads the list the moment a rent returns, and that read was
        served the pre-order snapshot for up to RENTALS_SNAPSHOT_TTL_SECONDS:
        the spinner stopped over a list with no trace of a machine that was
        already billing (seen live 2026-09-15). Dropping the payload makes the
        next read build its own; the generation stops a refresh that was already
        under way from storing the old list over it."""
        rentals_snapshot["generation"] += 1
        rentals_snapshot["payload"] = None

    def _refresh_rentals_snapshot() -> None:
        generation = rentals_snapshot["generation"]
        try:
            _store_rentals_snapshot(list_rentals(), generation)
        except Exception as exc:  # noqa: BLE001 — a stale list beats no Machines view
            print(f"[gpu-rentals] snapshot refresh failed: {exc}", file=sys.stderr)
            rentals_snapshot["at"] = time.monotonic()
        finally:
            rentals_refreshing.clear()

    def _kick_rentals_refresh() -> None:
        stopping = getattr(app.state, "shutting_down", None)
        if rentals_refreshing.is_set() or (isinstance(stopping, threading.Event) and stopping.is_set()):
            return
        rentals_refreshing.set()
        threading.Thread(target=_refresh_rentals_snapshot, name="gpu-rental-snapshot", daemon=True).start()

    def _rentals_payload() -> dict:
        cached = rentals_snapshot["payload"]
        # Nothing to serve yet, or the state the DTOs are built from has moved:
        # build HERE, so a pause, a resume or a dismissed failure is answered by
        # the request that follows it rather than ten seconds later. Without the
        # bookkeeping though — a page load must never be the thing that destroys
        # a machine.
        if cached is None or rentals_snapshot["state"] != _rental_state_fingerprint():
            generation = rentals_snapshot["generation"]
            return _store_rentals_snapshot(list_rentals(settle=False), generation)
        if time.monotonic() - rentals_snapshot["at"] > RENTALS_SNAPSHOT_TTL_SECONDS:
            # Only the marketplace's own view can have gone stale. Serve the
            # previous answer and rebuild behind it, on the thread that also
            # does the reaping and the warm-volume settling.
            _kick_rentals_refresh()
        return rentals_snapshot["payload"] or cached

    @app.get("/api/gpu-rentals", dependencies=[Depends(require_owner)])
    def gpu_rentals_index() -> dict:
        marketplace = marketplace_setup()
        if not marketplace["configured"]:
            # A state, not an outage (2026-09-07). Every mounted studio polls
            # this list for its Rented source, and the 503 a machine with no
            # marketplace keys used to answer was a red console line every
            # 30 s, forever. Offers, plan and POST still refuse with the 503 —
            # those are actions; this is the list. The Machines view reads the
            # sentence off `marketplace` and shows it where the 503 landed,
            # with the button `remedy` names beside it.
            return {
                "ok": True,
                "rentals": [],
                "tiers": list(TIERS),
                "failures": [],
                "account": None,
                "marketplace": marketplace,
                "orders": rental_orders(),
            }
        # ok:true like the rest of the studio API (additive; the list is
        # under its own keys). Orders ride OUTSIDE the snapshot: a stage that
        # is ten seconds stale is a progress bar that does not move.
        return {"ok": True, **_guard(_rentals_payload), "orders": rental_orders()}

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

    # The rental build: which LoRAs and which checkpoint a tier's NEXT boxes
    # are provisioned with. Literal segments again, ahead of {rental_id}, and
    # "build/checkpoints" ahead of the {tier} routes for the same reason.
    @app.get("/api/gpu-rentals/build", dependencies=[Depends(require_owner)])
    def gpu_rental_build_index() -> dict:
        return _guard(rental_build_payload)

    @app.get("/api/gpu-rentals/build/checkpoints", dependencies=[Depends(require_owner)])
    def gpu_rental_build_checkpoints() -> dict:
        return _guard(list_installed_checkpoints)

    @app.put("/api/gpu-rentals/build/{tier}/loras", dependencies=[Depends(require_owner)])
    def gpu_rental_build_set_loras(tier: str, payload: dict = Body(default={})) -> dict:
        ids = payload.get("ids")
        return _guard(
            set_rental_build_loras,
            tier,
            [str(value) for value in ids] if isinstance(ids, list) else [],
        )

    @app.put("/api/gpu-rentals/build/{tier}/checkpoint", dependencies=[Depends(require_owner)])
    def gpu_rental_build_set_checkpoint(tier: str, payload: dict = Body(default={})) -> dict:
        return _guard(
            set_rental_build_checkpoint,
            tier,
            str(payload.get("dest") or ""),
            str(payload.get("id") or ""),
            str(payload.get("url") or ""),
        )

    # Same ordering rule: "failures" is a literal segment, and a DELETE on it
    # must dismiss notices, never reach gpu_rentals_destroy as a rental id.
    @app.delete("/api/gpu-rentals/failures", dependencies=[Depends(require_owner)])
    def gpu_rental_failures_dismiss_all() -> dict:
        return _guard(dismiss_rental_failures, None)

    @app.delete("/api/gpu-rentals/failures/{rental_id}", dependencies=[Depends(require_owner)])
    def gpu_rental_failures_dismiss(rental_id: str) -> dict:
        return _guard(dismiss_rental_failures, rental_id)

    def _place_rental_order(tier: str, offer_id: str | None, prefer: str, gpu_class: str | None,
                            count: int, max_usd_per_hour: float | None, request_id: str) -> dict:
        """Open an order for this rent, place it on a thread, and hand it back."""
        # Refused here, at the click, whatever needs no marketplace to refuse.
        gpu_class = _guard(rental_gpu_class, tier, gpu_class)
        _guard(rental_public_key)
        with _rentals_in_flight_lock:
            if tier in _rentals_in_flight:
                raise HTTPException(status_code=409, detail=RENTAL_IN_FLIGHT_DETAIL)
            _rentals_in_flight.add(tier)
        order_id = request_id or uuid.uuid4().hex
        order = _open_rental_order(order_id, tier, gpu_class, count, max_usd_per_hour)

        def _place() -> None:
            outcome: dict[str, Any] = {"stage": "failed"}
            try:
                result = create_rental(
                    tier, offer_id, prefer, gpu_class, count, max_usd_per_hour=max_usd_per_hour,
                    _on_stage=lambda stage: _update_rental_order(order_id, stage=stage),
                )
            except ProviderError as exc:
                # What _guard would have put in the 4xx, so the view reads a
                # failed order exactly as it read the refusal.
                outcome["error"] = {
                    "message": str(exc), "status": exc.status_code, "remedy": getattr(exc, "remedy", ""),
                    **(getattr(exc, "payload", None) or {}),
                }
            except requests.RequestException:
                outcome["error"] = {"message": "The GPU marketplace is unreachable", "status": 503}
            except Exception as exc:  # noqa: BLE001 — a thread has no 500 handler to fall back on
                from .observability import record_incident, remedy_text

                outcome["error"] = {
                    "message": remedy_text("unexpected"), "status": 500, "unexpected": True,
                    "incident": record_incident(exc, method="POST", route="/api/gpu-rentals"),
                }
            else:
                result = {"ok": True, **result}
                outcome = {
                    "stage": "placed", "rental_ids": [row["rental_id"] for row in result["rentals"]],
                    "usd_per_hour": result.get("usd_per_hour"), "partial": result.get("partial"),
                }
                if request_id:
                    _remember_rental(request_id, result)
                # The machine bills from here. Rebuild the list BEFORE saying
                # so, so the read that learns the order is placed has the machine
                # in it as well and the view hands one row straight to the other.
                _forget_rentals_snapshot()
                generation = rentals_snapshot["generation"]
                try:
                    _store_rentals_snapshot(list_rentals(settle=False), generation)
                except Exception as exc:  # noqa: BLE001 — the next read builds it instead
                    print(f"[gpu-rentals] list after order {order_id} failed: {exc}", file=sys.stderr)
            finally:
                _update_rental_order(order_id, finished_at=time.time(), **outcome)
                with _rentals_in_flight_lock:
                    _rentals_in_flight.discard(tier)

        threading.Thread(target=_place, name="gpu-rental-order", daemon=True).start()
        return order

    @app.post("/api/gpu-rentals", status_code=201, dependencies=[Depends(require_owner)])
    def gpu_rentals_create(payload: dict = Body(default={})) -> dict:
        tier = str(payload.get("tier") or "image")
        offer_id = payload.get("offer_id")
        # A pinned offer needs its marketplace attached: two providers hand out
        # independent id spaces and nothing stops them colliding on an integer.
        # Clients that send a bare id (and older ones that only ever could) are
        # read as Vast by RentalRef.
        provider = payload.get("provider")
        if offer_id is not None and provider and ":" not in str(offer_id):
            offer_id = f"{provider}:{offer_id}"
        prefer = str(payload.get("prefer") or "balanced")
        gpu_class = payload.get("gpu_class") or None
        try:
            count = int(payload.get("count") or 1)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="count must be a whole number") from None
        if not 1 <= count <= MAX_BATCH_MACHINES:
            raise HTTPException(status_code=400, detail=f"count must be between 1 and {MAX_BATCH_MACHINES}")
        # The price the user clicked. Bounds the fallbacks; absent from older
        # clients, which keep the uncapped behaviour.
        try:
            max_usd_per_hour = float(payload.get("max_usd_per_hour")) if payload.get("max_usd_per_hour") else None
        except (TypeError, ValueError):
            max_usd_per_hour = None
        # Optional, client-generated (a UUID per click). The same id inside
        # RENTAL_REQUEST_TTL_SECONDS answers with the same result and rents
        # nothing new.
        request_id = str(payload.get("request_id") or "").strip()[:128]
        # {"background": true} is the Machines view: answer with an ORDER now and
        # place it on a thread (see _rental_orders). Without it the request holds
        # until the machine is rented, which agents and scripts rely on.
        background = payload.get("background") is True
        if request_id:
            order = rental_order(request_id) if background else None
            if order is not None:
                return JSONResponse({"ok": True, "order": order}, status_code=202)
            replayed = _replayed_rental(request_id)
            if replayed is not None:
                return replayed
        offer = str(offer_id) if offer_id is not None else None
        card = str(gpu_class) if gpu_class else None
        if background:
            order = _place_rental_order(tier, offer, prefer, card, count, max_usd_per_hour, request_id)
            return JSONResponse({"ok": True, "order": order}, status_code=202)
        with _rentals_in_flight_lock:
            if tier in _rentals_in_flight:
                raise HTTPException(status_code=409, detail=RENTAL_IN_FLIGHT_DETAIL)
            _rentals_in_flight.add(tier)
        try:
            result = _guard(create_rental, tier, offer, prefer, card, count, max_usd_per_hour=max_usd_per_hour)
        finally:
            with _rentals_in_flight_lock:
                _rentals_in_flight.discard(tier)
        if isinstance(result, dict):
            result = {"ok": True, **result}
            _forget_rentals_snapshot()
        if request_id and isinstance(result, dict):
            _remember_rental(request_id, result)
        return result

    @app.delete("/api/gpu-rentals/{rental_id}", dependencies=[Depends(require_owner)])
    def gpu_rentals_destroy(rental_id: str) -> dict:
        return _guard(destroy_rental, rental_id)

    # Warm volumes: the no-download provisioning path (RunPod network volumes
    # stocked once per tier, mounted by every later rental in that region).
    @app.get("/api/gpu-rentals/warm-volumes", dependencies=[Depends(require_owner)])
    def gpu_rentals_warm_volumes() -> dict:
        return _guard(lambda: {"volumes": list_warm_volumes(), "provider": WARM_VOLUME_PROVIDER})

    @app.post("/api/gpu-rentals/warm-volumes", dependencies=[Depends(require_owner)])
    def gpu_rentals_warm_volume_create(payload: dict = Body(default={})) -> dict:
        tier = str(payload.get("tier") or "")
        data_center_id = str(payload.get("data_center_id") or "").strip()
        if not data_center_id:
            raise HTTPException(status_code=400, detail="data_center_id is required")
        gpu_class = payload.get("gpu_class") or None
        return _guard(create_warm_volume, tier, data_center_id,
                      gpu_class=str(gpu_class) if gpu_class else None)

    @app.delete("/api/gpu-rentals/warm-volumes/{tier}", dependencies=[Depends(require_owner)])
    def gpu_rentals_warm_volume_delete(tier: str) -> dict:
        return _guard(delete_warm_volume, tier)

    @app.post("/api/gpu-rentals/{rental_id}/pause", dependencies=[Depends(require_owner)])
    def gpu_rentals_pause(rental_id: str) -> dict:
        return _guard(pause_rental, rental_id)

    @app.post("/api/gpu-rentals/{rental_id}/resume", dependencies=[Depends(require_owner)])
    def gpu_rentals_resume(rental_id: str) -> dict:
        return _guard(resume_rental, rental_id)

    @app.post("/api/gpu-rentals/{rental_id}/attach", dependencies=[Depends(require_owner)])
    def gpu_rentals_attach(rental_id: str) -> dict:
        return _guard(attach_rental, rental_id)

    @app.delete("/api/gpu-rentals/{rental_id}/attach", dependencies=[Depends(require_owner)])
    def gpu_rentals_detach(rental_id: str) -> dict:
        return _guard(detach_rental, rental_id)

    @app.post("/api/gpu-rentals/{rental_id}/select", dependencies=[Depends(require_owner)])
    def gpu_rentals_select(rental_id: str) -> dict:
        return _guard(select_rental, rental_id)
