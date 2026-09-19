#!/usr/bin/env bash
# Search Vast.ai for rentable offers matching a rental tier.
# Usage: hive-env-run -- ./vast-search.sh [4090|5090|a6000|l40s]
# Needs: pip install vastai; VAST_API_KEY in the hive env.
set -euo pipefail

TIER="${1:-4090}"
case "$TIER" in
    4090)  GPU="RTX_4090"  ;;
    5090)  GPU="RTX_5090"  ;;
    a6000) GPU="RTX_A6000" ;;
    l40s)  GPU="L40S"      ;;
    *) echo "unknown tier: $TIER" >&2; exit 1 ;;
esac

# datacenter+verified only: rental customers' prompts/outputs run on this box,
# so we do not use anonymous community hosts (see README privacy note).
exec vastai search offers \
    "gpu_name=${GPU} num_gpus=1 datacenter=true verified=true rentable=true \
     reliability>0.99 inet_down>500 disk_space>160 cuda_vers>=12.4" \
    -o 'dph+'
