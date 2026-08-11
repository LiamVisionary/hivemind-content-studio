#!/usr/bin/env python3
"""Chunked relay of the MiniMax H3 serving set: HF -> R2, no local disk.

Same machinery as relay-url-to-r2.py (256MB ranged GETs -> S3 multipart,
inline SHA256, resumable state), generalized to a file list so the four H3
artifacts stream in one run. Order is smallest-first so pipeline problems
surface in minutes, not hours.

Credentials: rclone-style conf with an [r2] section (access_key_id,
secret_access_key, endpoint). Path from $RCLONE_CONFIG, else rclone.conf
beside this script. Per-file resume state lives in $RELAY_STATE_DIR (else
beside the conf). Sizes and SHA256s below are the HF LFS oids for
Comfy-Org/MiniMax-H3 at revision 0543966 (2026-08-03).
"""
import configparser
import hashlib
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.config import Config

HF = "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/"
BUCKET = "hivemind-rental-models"
PART_SIZE = 256 * 1024 * 1024

FILES = [
    {  # audio VAE first: small enough to prove the whole pipeline fast
        "key": "vae/minimax_h3_audio_vae_fp32.safetensors",
        "bytes": 605254808,
        "sha256": "8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48",
    },
    {
        "key": "vae/minimax_h3_video_vae_fp16.safetensors",
        "bytes": 5207808496,
        "sha256": "7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522",
    },
    {  # official template TE pairing (nvfp4, Blackwell-native)
        "key": "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        "bytes": 15687142551,
        "sha256": "35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6",
    },
    {  # the model itself: pruned int8_convrot per the official H3 template
        "key": "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        "bytes": 20970379616,
        "sha256": "e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a",
    },
]

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONF_PATH = os.environ.get("RCLONE_CONFIG", os.path.join(SCRIPT_DIR, "rclone.conf"))
STATE_DIR = os.environ.get("RELAY_STATE_DIR", os.path.dirname(CONF_PATH))

cfg = configparser.ConfigParser()
cfg.read(CONF_PATH)
s3 = boto3.client(
    "s3",
    endpoint_url=cfg["r2"]["endpoint"],
    aws_access_key_id=cfg["r2"]["access_key_id"],
    aws_secret_access_key=cfg["r2"]["secret_access_key"],
    config=Config(retries={"max_attempts": 5, "mode": "adaptive"}),
)


def fetch_range(url, start, end):
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    want = end - start + 1
    if len(data) != want:
        raise IOError(f"short read: got {len(data)} want {want}")
    return data


def fetch_with_retries(url, total, i, n_parts):
    start = (i - 1) * PART_SIZE
    end = min(start + PART_SIZE, total) - 1
    for attempt in range(1, 7):
        try:
            return fetch_range(url, start, end)
        except Exception as e:
            print(f"part {i}/{n_parts} fetch attempt {attempt} failed: {e}", flush=True)
            time.sleep(min(60, 5 * attempt))
    raise IOError(f"part {i} fetch exhausted retries")


def already_in_r2(spec):
    try:
        head = s3.head_object(Bucket=BUCKET, Key=spec["key"])
    except Exception:
        return False
    return head["ContentLength"] == spec["bytes"]


def relay_one(spec):
    key, total, expect_sha = spec["key"], spec["bytes"], spec["sha256"]
    url = HF + key
    state_file = os.path.join(
        STATE_DIR, "relay_state_" + os.path.basename(key) + ".json")

    state = {}
    if os.path.exists(state_file):
        state = json.load(open(state_file))
    if state.get("upload_id"):
        upload_id = state["upload_id"]
        parts = {int(k): v for k, v in state.get("parts", {}).items()}
        print(f"[{key}] resuming upload {upload_id[:16]}... "
              f"with {len(parts)} parts done", flush=True)
    else:
        for u in s3.list_multipart_uploads(Bucket=BUCKET).get("Uploads", []):
            if u["Key"] == key:
                s3.abort_multipart_upload(Bucket=BUCKET, Key=key,
                                          UploadId=u["UploadId"])
                print(f"[{key}] aborted stale multipart upload", flush=True)
        upload_id = s3.create_multipart_upload(Bucket=BUCKET, Key=key)["UploadId"]
        parts = {}
        state = {"upload_id": upload_id, "parts": {}}
        json.dump(state, open(state_file, "w"))

    sha = hashlib.sha256()
    n_parts = (total + PART_SIZE - 1) // PART_SIZE
    t0 = time.time()
    done_bytes = 0

    fetch_pool = ThreadPoolExecutor(max_workers=2)
    upload_pool = ThreadPoolExecutor(max_workers=4)
    fetches = {}
    uploads = {}

    def reap_uploads(max_inflight=0):
        while len(uploads) > max_inflight:
            done_now = [j for j, f in uploads.items() if f.done()]
            if not done_now:
                time.sleep(0.5)
                continue
            for j in done_now:
                etag = uploads.pop(j).result()["ETag"]
                parts[j] = etag
                state["parts"][str(j)] = etag
            json.dump(state, open(state_file, "w"))

    for i in range(1, n_parts + 1):
        for j in range(i, min(i + 3, n_parts + 1)):
            if j not in fetches:
                fetches[j] = fetch_pool.submit(
                    fetch_with_retries, url, total, j, n_parts)
        data = fetches.pop(i).result()
        sha.update(data)
        if i not in parts:
            reap_uploads(max_inflight=4)
            uploads[i] = upload_pool.submit(
                s3.upload_part, Bucket=BUCKET, Key=key, UploadId=upload_id,
                PartNumber=i, Body=data)
        done_bytes += len(data)
        if i % 8 == 0 or i == n_parts:
            rate = done_bytes / max(1, time.time() - t0) / 1e6
            print(f"[{key}] part {i}/{n_parts} hashed "
                  f"({done_bytes/1e9:.1f}GB, {rate:.0f}MB/s)", flush=True)

    reap_uploads()
    fetch_pool.shutdown()
    upload_pool.shutdown()

    digest = sha.hexdigest()
    if digest != expect_sha:
        print(f"[{key}] HASH MISMATCH ({digest}) — aborting upload, "
              "nothing published", flush=True)
        s3.abort_multipart_upload(Bucket=BUCKET, Key=key, UploadId=upload_id)
        return False

    s3.complete_multipart_upload(
        Bucket=BUCKET, Key=key, UploadId=upload_id,
        MultipartUpload={"Parts": [{"PartNumber": i, "ETag": parts[i]}
                                   for i in sorted(parts)]})
    os.remove(state_file)
    print(f"[{key}] SUCCESS: r2://{BUCKET}/{key} SHA256-verified inline",
          flush=True)
    return True


def main():
    failures = []
    for spec in FILES:
        if already_in_r2(spec):
            print(f"[{spec['key']}] already in R2 at expected size — skipping",
                  flush=True)
            continue
        if not relay_one(spec):
            failures.append(spec["key"])
    if failures:
        print(f"FAILED: {failures}", flush=True)
        sys.exit(1)
    print("ALL MINIMAX H3 ARTIFACTS RELAYED", flush=True)


if __name__ == "__main__":
    main()
