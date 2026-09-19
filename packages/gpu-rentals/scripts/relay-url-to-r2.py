#!/usr/bin/env python3
"""Chunked relay: any URL -> R2, no local disk, resumable, inline SHA256.

Each 256MB part is fetched with an independent ranged GET (so no long-lived
connection or presigned-URL TTL can kill the whole transfer — Civitai's
presigned URLs die ~30min in, which sank plain rclone copyurl) and uploaded
as one S3 multipart part. A running SHA256 over the byte stream replaces the
read-back verify pass. State (upload id + part etags) persists to JSON so a
rerun resumes instead of restarting.

To reuse: edit the SRC_URL/KEY/EXPECT_* constants below, put an rclone.conf
with an [r2] section beside the script, `pip install boto3`, run. First used
2026-07-29 to relay LTX 2.3 22B dev fp8 (HF Lightricks/LTX-2.3-fp8) into
r2://hivemind-rental-models at 109 parts / 29.1GB, two transient
IncompleteReads retried cleanly, hash matched.
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

SCRATCH = os.path.dirname(os.path.abspath(__file__))
SRC_URL = ("https://huggingface.co/Lightricks/LTX-2.3-fp8/resolve/main/"
           "ltx-2.3-22b-dev-fp8.safetensors")
BUCKET = "hivemind-rental-models"
KEY = "checkpoints/ltx-2.3-22b-dev-fp8.safetensors"
EXPECT_BYTES = 29145431166
EXPECT_SHA = "28606c5b5a06ce56f896d4dfcb20f212739e07a68fbe48e53638188449d26450"
PART_SIZE = 256 * 1024 * 1024
STATE_FILE = os.path.join(SCRATCH, "ltx_relay_state.json")

cfg = configparser.ConfigParser()
cfg.read(os.path.join(SCRATCH, "rclone.conf"))
s3 = boto3.client(
    "s3",
    endpoint_url=cfg["r2"]["endpoint"],
    aws_access_key_id=cfg["r2"]["access_key_id"],
    aws_secret_access_key=cfg["r2"]["secret_access_key"],
    config=Config(retries={"max_attempts": 5, "mode": "adaptive"}),
)


def fetch_range(start, end):
    req = urllib.request.Request(SRC_URL, headers={"Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    want = end - start + 1
    if len(data) != want:
        raise IOError(f"short read: got {len(data)} want {want}")
    return data


def fetch_with_retries(i, n_parts):
    start = (i - 1) * PART_SIZE
    end = min(start + PART_SIZE, EXPECT_BYTES) - 1
    for attempt in range(1, 7):
        try:
            return fetch_range(start, end)
        except Exception as e:
            print(f"part {i}/{n_parts} fetch attempt {attempt} failed: {e}", flush=True)
            time.sleep(min(60, 5 * attempt))
    raise IOError(f"part {i} fetch exhausted retries")


def main():
    # On resume, already-uploaded parts skip the S3 upload but their bytes
    # are still re-fetched so the inline SHA256 covers the full stream.
    state = {}
    if os.path.exists(STATE_FILE):
        state = json.load(open(STATE_FILE))
    if state.get("upload_id"):
        upload_id = state["upload_id"]
        parts = {int(k): v for k, v in state.get("parts", {}).items()}
        print(f"resuming upload {upload_id[:16]}... with {len(parts)} parts done", flush=True)
    else:
        # clear any stale multipart uploads for this key first
        for u in s3.list_multipart_uploads(Bucket=BUCKET).get("Uploads", []):
            if u["Key"] == KEY:
                s3.abort_multipart_upload(Bucket=BUCKET, Key=KEY, UploadId=u["UploadId"])
                print("aborted stale multipart upload", flush=True)
        upload_id = s3.create_multipart_upload(Bucket=BUCKET, Key=KEY)["UploadId"]
        parts = {}
        state = {"upload_id": upload_id, "parts": {}}
        json.dump(state, open(STATE_FILE, "w"))

    sha = hashlib.sha256()
    n_parts = (EXPECT_BYTES + PART_SIZE - 1) // PART_SIZE
    t0 = time.time()
    done_bytes = 0

    # Pipeline: prefetch up to 2 parts ahead (hash consumes them strictly in
    # order), upload on a 4-thread pool with a bounded in-flight window.
    fetch_pool = ThreadPoolExecutor(max_workers=2)
    upload_pool = ThreadPoolExecutor(max_workers=4)
    fetches = {}
    uploads = {}

    def reap_uploads(max_inflight=0):
        # Blocks until at most max_inflight uploads remain, harvesting etags.
        while len(uploads) > max_inflight:
            done_now = [j for j, f in uploads.items() if f.done()]
            if not done_now:
                time.sleep(0.5)
                continue
            for j in done_now:
                etag = uploads.pop(j).result()["ETag"]
                parts[j] = etag
                state["parts"][str(j)] = etag
            json.dump(state, open(STATE_FILE, "w"))

    for i in range(1, n_parts + 1):
        for j in range(i, min(i + 3, n_parts + 1)):
            if j not in fetches:
                fetches[j] = fetch_pool.submit(fetch_with_retries, j, n_parts)
        data = fetches.pop(i).result()
        sha.update(data)
        if i not in parts:
            reap_uploads(max_inflight=4)
            uploads[i] = upload_pool.submit(
                s3.upload_part, Bucket=BUCKET, Key=KEY, UploadId=upload_id,
                PartNumber=i, Body=data)
        done_bytes += len(data)
        if i % 8 == 0 or i == n_parts:
            rate = done_bytes / max(1, time.time() - t0) / 1e6
            print(f"part {i}/{n_parts} hashed ({done_bytes/1e9:.1f}GB, {rate:.0f}MB/s)", flush=True)

    reap_uploads()
    fetch_pool.shutdown()
    upload_pool.shutdown()

    digest = sha.hexdigest()
    print(f"sha256={digest}", flush=True)
    if digest != EXPECT_SHA:
        print("HASH MISMATCH — aborting multipart upload, nothing published", flush=True)
        s3.abort_multipart_upload(Bucket=BUCKET, Key=KEY, UploadId=upload_id)
        sys.exit(1)

    s3.complete_multipart_upload(
        Bucket=BUCKET, Key=KEY, UploadId=upload_id,
        MultipartUpload={"Parts": [{"PartNumber": i, "ETag": parts[i]}
                                   for i in sorted(parts)]})
    os.remove(STATE_FILE)
    print(f"SUCCESS: r2://{BUCKET}/{KEY} complete and SHA256-verified inline", flush=True)


if __name__ == "__main__":
    main()
