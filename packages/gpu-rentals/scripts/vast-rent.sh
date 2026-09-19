#!/usr/bin/env bash
# Rent one Vast.ai offer as a Hivemind ComfyUI rental box.
# Usage: hive-env-run -- ./vast-rent.sh <offer-id> [image|video]
# Needs: VAST_API_KEY, R2_BASE_URL, CIVITAI_TOKEN in the hive env.
#
# NOTE: image tag + env plumbing follow the current Vast ComfyUI template
# (vastai/comfy + PROVISIONING_SCRIPT contract). Verify against
# `vastai search templates comfyui` on first run — Vast rotates template tags.
set -euo pipefail

OFFER_ID="${1:?usage: vast-rent.sh <offer-id> [image|video]}"
RENTAL_TIER="${2:-image}"

PROVISIONING_URL="${PROVISIONING_URL:?set to the raw URL of provisioning/comfyui-hivemind.sh}"
DISK_GB=$([[ "$RENTAL_TIER" == "video" ]] && echo 220 || echo 120)

exec vastai create instance "$OFFER_ID" \
    --image vastai/comfy:@vastai-automatic-tag \
    --disk "$DISK_GB" \
    --ssh --direct \
    --env "-e PROVISIONING_SCRIPT=${PROVISIONING_URL} \
           -e RENTAL_TIER=${RENTAL_TIER} \
           -e R2_BASE_URL=${R2_BASE_URL:?} \
           -e CIVITAI_TOKEN=${CIVITAI_TOKEN:-} \
           -e COMFYUI_ARGS=--disable-metadata \
           -p 8188:8188"
