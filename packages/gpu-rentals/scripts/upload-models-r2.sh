#!/usr/bin/env bash
# Bulk sync of local model weights to the R2 bucket the rental boxes pull
# from (R2 = zero egress fees, which is the whole point at 12-27GB per file).
# Mirrors models.manifest.json. Rerun-safe: rclone skips files already
# uploaded with matching size/hash. ~77GB total; at this Mac's ~3-4MB/s
# uplink this is an overnight job — run under caffeinate.
#
# Credentials: an rclone remote named [r2]. Either a global rclone remote or
# RCLONE_CONFIG=<path> pointing at a config with the derived-token creds
# (access key = Cloudflare token id, secret = sha256 of the token value).
set -euo pipefail

BUCKET="r2:hivemind-rental-models"
M="/Users/liam/comfy/ComfyUI/models"
FLAGS=(--progress --s3-chunk-size 64M --s3-upload-concurrency 4)

# "<local source> <bucket subdir>" pairs, one per manifest artifact
PAIRS=(
  "$M/diffusion_models/Krea2_Turbo_convrot_int8mixed.safetensors               diffusion_models"
  "$M/diffusion_models/Krea2_Turbo_identity_v1_2_convrot_int8mixed.safetensors diffusion_models"
  "$M/vae/flux2-vae.safetensors                                                vae"
  "$M/checkpoints/waiANIMA_v10Base10.safetensors                               checkpoints"
  "$M/text_encoders/qwen_3_06b_base.safetensors                                text_encoders"
  "$M/text_encoders/waiANIMA_v10Base10_txt.safetensors                         text_encoders"
  "$M/text_encoders/qwen35_4b.safetensors                                      text_encoders"
  "$M/vae/qwen_image_vae.safetensors                                           vae"
  "$M/text_encoders/gemma_3_12B_it_fp8_scaled.safetensors                      text_encoders"
  "$M/vae/taeltx2_3.safetensors                                                vae"
  "/Users/liam/comfy/mlx-models/source/eros-dmd-lora/ltx2310eros_v14_dmd_lora.safetensors loras"
  "$M/checkpoints/ltx2310eros_v14.safetensors                                  checkpoints"
  "$M/loras/LTX2.3_Crisp_Enhance.safetensors                                   loras"
)

for pair in "${PAIRS[@]}"; do
    src=$(echo "$pair" | awk '{print $1}')
    sub=$(echo "$pair" | awk '{print $2}')
    echo "=== $(basename "$src") -> $sub/ ==="
    rclone copy "${FLAGS[@]}" "$src" "$BUCKET/$sub/"
done

# small upscale set for the anima hires workflow + /api/upscale fast path
echo "=== upscale_models/ ==="
rclone copy "${FLAGS[@]}" "$M/upscale_models/" "$BUCKET/upscale_models/" \
    --include "*.safetensors" --include "*.pth"

echo "ALL UPLOADS COMPLETE"
echo "verify listing:"
rclone lsl "$BUCKET" | sort -k4
echo "keep the bucket PRIVATE; rental boxes get access via R2_BASE_URL (presigned or token)"
