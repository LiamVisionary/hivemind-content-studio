#!/usr/bin/env bash
# Provisioning script for the Hivemind rental ComfyUI image on Vast.ai.
# Runs once at first boot inside the vastai/ai-dock ComfyUI template
# (set PROVISIONING_SCRIPT=<raw URL of this file> in the template env).
#
# Contract: idempotent; downloads model weights into ${COMFYUI_DIR}/models/*,
# installs the custom nodes the exported workflows need, never bakes secrets.
# Tokens arrive via instance env: R2_BASE_URL (presigned or public bucket),
# CIVITAI_TOKEN, HF_TOKEN.

set -euo pipefail

COMFYUI_DIR="${COMFYUI_DIR:-/opt/ComfyUI}"
MODELS_DIR="${COMFYUI_DIR}/models"
R2_BASE_URL="${R2_BASE_URL:?set R2_BASE_URL to the model bucket base URL}"

# ComfyUI flags: same privacy posture as the home stack — no metadata in outputs.
export COMFYUI_ARGS="${COMFYUI_ARGS:---disable-metadata}"
# Redact prompt graphs from /history and /queue (the hivemind_privacy custom
# node installed below enforces this; default ON for rentals, set 0 to disable).
export COMFY_PRIVATE_HISTORY_PROMPTS="${COMFY_PRIVATE_HISTORY_PROMPTS:-1}"

fetch() { # fetch <url> <dest-relative-to-models-dir>
    local url="$1" dest="${MODELS_DIR}/$2"
    if [[ -s "$dest" ]]; then
        echo "skip (exists): $2"
        return 0
    fi
    mkdir -p "$(dirname "$dest")"
    echo "fetch: $2"
    wget -q --show-progress --tries=3 -O "${dest}.part" "$url"
    mv "${dest}.part" "$dest"
}

fetch_civitai() { # fetch_civitai <model-version-id> <dest>
    fetch "https://civitai.com/api/download/models/$1?token=${CIVITAI_TOKEN:?}" "$2"
}

# ---------------------------------------------------------------------------
# Custom nodes — keep in lockstep with the exported workflow requirements.
# TODO: lock this list from the actual workflow JSON exports (media-gateway
# MCP registry) before first customer boot.
# ---------------------------------------------------------------------------
NODES=(
    # "https://github.com/<org>/<node-repo>"
)
for repo in "${NODES[@]}"; do
    dir="${COMFYUI_DIR}/custom_nodes/$(basename "$repo")"
    [[ -d "$dir" ]] || git clone --depth 1 "$repo" "$dir"
    [[ -f "$dir/requirements.txt" ]] && pip install -q -r "$dir/requirements.txt"
done

# ---------------------------------------------------------------------------
# hivemind_privacy custom node (written inline so this script stays a single
# self-contained provisioning artifact). Three jobs, mirroring the home
# stack's server patches on an UNPATCHED pinned ComfyUI:
#   1. COMFY_PRIVATE_HISTORY_PROMPTS: redact prompt graphs from /history and
#      /queue responses (even mid-run) — plaintext prompt text is never
#      queryable from the rented box's HTTP surface. Encrypted workflow
#      envelopes (client-key sealed) are preserved for the gateway's
#      workflow index. Default ON here (home default is off + launcher-set).
#   2. POST /hivemind/scrub-files: lets the gateway delete this prompt's
#      output/input files right after requester-sealed harvest, instead of
#      leaving customer media on the instance until teardown.
#   3. HIVEMIND_LANE_TOKEN: when the instance env sets it, every request to
#      :8188 (websocket included) must carry `Authorization: Bearer <token>`
#      or `?token=` — the per-instance auth in front of the lane, in-process
#      so no extra proxy service is needed.
# ---------------------------------------------------------------------------
privacy_dir="${COMFYUI_DIR}/custom_nodes/hivemind_privacy"
mkdir -p "$privacy_dir"
cat > "${privacy_dir}/__init__.py" <<'HIVEMIND_PRIVACY_EOF'
"""Hivemind rental privacy node: history/queue prompt redaction, post-harvest
file scrub route, sampler progress readout, and per-instance lane-token auth.
See the provisioning script header in
packages/gpu-rentals/provisioning/comfyui-hivemind.sh."""

import hmac
import os
import time

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def _privacy_enabled():
    return os.environ.get("COMFY_PRIVATE_HISTORY_PROMPTS", "1").lower() in {"1", "true", "yes", "on"}


# --- sampler progress -------------------------------------------------------
# ComfyUI publishes per-node progress over the WEBSOCKET only, and its /history
# entry appears just once, at the end — so a lane polled over HTTP has no way to
# know a job is 6 steps into 15, and the studio's bar can only be a guess.
# Recording it here gives the gateway a pollable view of the real thing.
#
# Patch the registry METHOD rather than registering a ProgressHandler:
# reset_progress_state() builds a NEW ProgressRegistry per prompt and only calls
# reset_handlers() on the old one, so a handler registered at startup goes deaf
# after the first job. The method survives every rebuild.
#
# Counters and node ids only — the same payload shape the redaction above
# allows, so enabling progress cannot walk back the prompt privacy.
_PROGRESS = {"prompt_id": "", "node_id": "", "value": 0.0, "max": 0.0, "updated_at": 0.0}


def _record_progress(prompt_id, node_id, value, max_value):
    try:
        _PROGRESS.update(
            prompt_id=str(prompt_id or ""),
            node_id=str(node_id or ""),
            value=float(value),
            max=float(max_value),
            updated_at=time.time(),
        )
    except (TypeError, ValueError):
        pass


try:
    from comfy_execution import progress as _comfy_progress
except Exception:  # pragma: no cover - older ComfyUI without the registry
    _comfy_progress = None

if _comfy_progress is not None:
    _orig_update_progress = _comfy_progress.ProgressRegistry.update_progress

    def _recording_update_progress(self, node_id, value, max_value, *args, **kwargs):
        _record_progress(getattr(self, "prompt_id", ""), node_id, value, max_value)
        return _orig_update_progress(self, node_id, value, max_value, *args, **kwargs)

    _comfy_progress.ProgressRegistry.update_progress = _recording_update_progress


def _is_encrypted_workflow_envelope(value):
    return (
        isinstance(value, dict)
        and value.get("encrypted") is True
        and value.get("format") == "comfyui-mobile-encrypted-workflow"
        and isinstance(value.get("iterations"), int)
        and isinstance(value.get("salt"), str)
        and isinstance(value.get("iv"), str)
        and isinstance(value.get("data"), str)
    )


def _redact_extra_data(extra_data):
    if not isinstance(extra_data, dict):
        return {}
    redacted = {}
    for key in ("client_id", "create_time", "preview_method", "mobile_hidden_workflow", "comfy_usage_source"):
        value = extra_data.get(key)
        if isinstance(value, (str, int, float, bool)) or value is None:
            redacted[key] = value
    extra_pnginfo = extra_data.get("extra_pnginfo")
    if isinstance(extra_pnginfo, dict):
        workflow = extra_pnginfo.get("workflow")
        if _is_encrypted_workflow_envelope(workflow):
            redacted["extra_pnginfo"] = {"workflow": workflow}
    return redacted


def _redact_prompt_tuple(item):
    if not isinstance(item, (list, tuple)):
        return item
    redacted = list(item[:5])
    if len(redacted) > 2:
        redacted[2] = {}
    if len(redacted) > 3:
        redacted[3] = _redact_extra_data(redacted[3])
    return redacted


def _redact_history_entry(entry):
    if not isinstance(entry, dict):
        return entry
    entry = dict(entry)
    if "prompt" in entry:
        entry["prompt"] = _redact_prompt_tuple(entry["prompt"])
    return entry


import execution  # noqa: E402

_orig_get_history = execution.PromptQueue.get_history


def _private_get_history(self, *args, **kwargs):
    out = _orig_get_history(self, *args, **kwargs)
    if not _privacy_enabled() or not isinstance(out, dict):
        return out
    return {key: _redact_history_entry(value) for key, value in out.items()}


execution.PromptQueue.get_history = _private_get_history

def _wrap_queue_accessor(name):
    """Redact one PromptQueue queue accessor, if this ComfyUI has it.

    ComfyUI serves /queue from get_current_queue_volatile() and the websocket
    status from get_current_queue(); patching only the latter left the running
    prompt readable at /queue for the whole generation (measured on pinned
    e377e263, 2026-08-07). Wrapping every accessor the class exposes keeps a
    future rename from silently reopening that hole — the assertion below turns
    one into a hard startup failure rather than a quiet leak."""
    original = getattr(execution.PromptQueue, name, None)
    if original is None:
        return False

    def _private_accessor(self, *args, **kwargs):
        out = original(self, *args, **kwargs)
        if not _privacy_enabled() or not isinstance(out, tuple) or len(out) != 2:
            return out
        running, pending = out
        return (
            [_redact_prompt_tuple(item) for item in (running or [])],
            [_redact_prompt_tuple(item) for item in (pending or [])],
        )

    setattr(execution.PromptQueue, name, _private_accessor)
    return True


_QUEUE_ACCESSORS = [
    name for name in dir(execution.PromptQueue)
    if name.startswith("get_current_queue")
]
_WRAPPED_QUEUE_ACCESSORS = [name for name in _QUEUE_ACCESSORS if _wrap_queue_accessor(name)]
if not _WRAPPED_QUEUE_ACCESSORS:
    raise RuntimeError(
        "hivemind_privacy: no PromptQueue queue accessor to redact — refusing to "
        "run a rental lane that would serve prompts at /queue"
    )

try:
    from aiohttp import web
    from server import PromptServer
    import folder_paths
except Exception:  # pragma: no cover - import-order safety only
    PromptServer = None

if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    routes = PromptServer.instance.routes

    @routes.post("/hivemind/scrub-files")
    async def hivemind_scrub_files(request):
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)
        deleted, missing, refused = [], [], []
        for ref in list(payload.get("files") or [])[:256]:
            if not isinstance(ref, dict):
                continue
            base = folder_paths.get_directory_by_type(str(ref.get("type") or "output"))
            name = os.path.basename(str(ref.get("filename") or ""))
            subfolder = str(ref.get("subfolder") or "")
            if not base or not name:
                refused.append(ref)
                continue
            base = os.path.abspath(base)
            target = os.path.abspath(os.path.join(base, subfolder, name))
            try:
                inside = os.path.commonpath([base, target]) == base
            except ValueError:
                inside = False
            if not inside:
                refused.append(ref)
                continue
            if os.path.isfile(target):
                try:
                    os.remove(target)
                    deleted.append({"type": ref.get("type"), "subfolder": subfolder, "filename": name})
                except OSError:
                    refused.append(ref)
            else:
                missing.append({"type": ref.get("type"), "subfolder": subfolder, "filename": name})
        return web.json_response({"deleted": deleted, "missing": missing, "refused": refused})

    @routes.get("/hivemind/progress")
    async def hivemind_progress(request):
        """Latest sampler counters, for the gateway's completion watcher."""
        return web.json_response(dict(_PROGRESS))

    _LANE_TOKEN = os.environ.get("HIVEMIND_LANE_TOKEN", "").strip()
    _EXEMPT_PATHS = {"/", "/system_stats"} | {
        p.strip() for p in os.environ.get("HIVEMIND_LANE_TOKEN_EXEMPT", "").split(",") if p.strip()
    }

    if _LANE_TOKEN:

        def _token_ok(supplied):
            return bool(supplied) and hmac.compare_digest(supplied, _LANE_TOKEN)

        @web.middleware
        async def _hivemind_lane_auth(request, handler):
            if request.method == "OPTIONS" or request.path in _EXEMPT_PATHS:
                return await handler(request)
            auth = request.headers.get("Authorization", "")
            if auth.startswith("Bearer ") and _token_ok(auth[len("Bearer "):]):
                return await handler(request)
            if _token_ok(request.query.get("token", "")):
                return await handler(request)
            return web.json_response({"error": "unauthorized"}, status=401)

        PromptServer.instance.app.middlewares.append(_hivemind_lane_auth)
HIVEMIND_PRIVACY_EOF

# ---------------------------------------------------------------------------
# Model weights — mirrors models.manifest.json. R2 has zero egress fees, so
# every boot pulls from our bucket, not from Civitai/HF (rate limits, ToS).
# ---------------------------------------------------------------------------

# krea2-image tier
fetch "${R2_BASE_URL}/diffusion_models/Krea2_Turbo_convrot_int8mixed.safetensors" \
      "diffusion_models/Krea2_Turbo_convrot_int8mixed.safetensors"
fetch "${R2_BASE_URL}/diffusion_models/Krea2_Turbo_identity_v1_2_convrot_int8mixed.safetensors" \
      "diffusion_models/Krea2_Turbo_identity_v1_2_convrot_int8mixed.safetensors"
fetch "${R2_BASE_URL}/vae/flux2-vae.safetensors" "vae/flux2-vae.safetensors"

# wai-anima-image tier
fetch "${R2_BASE_URL}/checkpoints/waiANIMA_v10Base10.safetensors" \
      "checkpoints/waiANIMA_v10Base10.safetensors"
fetch "${R2_BASE_URL}/text_encoders/qwen_3_06b_base.safetensors" \
      "text_encoders/qwen_3_06b_base.safetensors"
fetch "${R2_BASE_URL}/text_encoders/waiANIMA_v10Base10_txt.safetensors" \
      "text_encoders/waiANIMA_v10Base10_txt.safetensors"
fetch "${R2_BASE_URL}/text_encoders/qwen35_4b.safetensors" \
      "text_encoders/qwen35_4b.safetensors"
fetch "${R2_BASE_URL}/vae/qwen_image_vae.safetensors" "vae/qwen_image_vae.safetensors"

# ltx23-eros-video tier (32GB+ VRAM instances only — gate on tier env)
if [[ "${RENTAL_TIER:-image}" == "video" ]]; then
    fetch "${R2_BASE_URL}/checkpoints/ltx-2.3-22b-dev-fp8.safetensors" \
          "checkpoints/ltx-2.3-22b-dev-fp8.safetensors"
    fetch "${R2_BASE_URL}/checkpoints/ltx2310eros_v14.safetensors" \
          "checkpoints/ltx2310eros_v14.safetensors"
    fetch "${R2_BASE_URL}/loras/ltx2310eros_v14_dmd_lora.safetensors" \
          "loras/ltx2310eros_v14_dmd_lora.safetensors"
    fetch "${R2_BASE_URL}/text_encoders/gemma_3_12B_it_fp8_scaled.safetensors" \
          "text_encoders/gemma_3_12B_it_fp8_scaled.safetensors"
    fetch "${R2_BASE_URL}/vae/taeltx2_3.safetensors" "vae/taeltx2_3.safetensors"
fi

# minimax-h3-video tier (Blackwell 32GB+ — the nvfp4 TE needs sm_120; use the
# int8_convrot TE instead if Ada cards ever join this tier). H3 support is
# newer than any release image: pin ComfyUI to the commit the Spectrum node is
# contract-tested against (2026-08-03, native MiniMax H3 + packed-latent
# sampler API), then install the Spectrum forecaster node.
if [[ "${RENTAL_TIER:-image}" == "minimax-video" ]]; then
    # Smart-memory retention holds TE (15.7G) + DiT (21G) in system RAM at
    # once; a 31GB-RAM box thrashes to death mid-sample (2026-08-04). Under
    # 48GB, trade TE reload time for sequential residency.
    total_ram_gb=$(awk '/MemTotal/{printf "%d", $2/1048576}' /proc/meminfo)
    if (( total_ram_gb < 48 )); then
        export COMFYUI_ARGS="${COMFYUI_ARGS} --disable-smart-memory"
    fi
    H3_COMFY_COMMIT="e377e263049f9338b4d12a3dd417b36ae62948ff"
    if ! git -C "$COMFYUI_DIR" merge-base --is-ancestor "$H3_COMFY_COMMIT" HEAD 2>/dev/null; then
        git -C "$COMFYUI_DIR" fetch --depth 200 origin master
        git -C "$COMFYUI_DIR" checkout "$H3_COMFY_COMMIT"
        pip install -q -r "$COMFYUI_DIR/requirements.txt"
    fi
    spectrum_dir="${COMFYUI_DIR}/custom_nodes/ComfyUI-Spectrum-MiniMax-H3"
    [[ -d "$spectrum_dir" ]] || git clone --depth 1 \
        https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3.git "$spectrum_dir"
    # SageAttention (~1.8x measured on H3 sampling) via the KJNodes patch node;
    # the registered minimax-h3 graph references PathchSageAttentionKJ.
    kjnodes_dir="${COMFYUI_DIR}/custom_nodes/comfyui-kjnodes"
    [[ -d "$kjnodes_dir" ]] || git clone --depth 1 \
        https://github.com/kijai/ComfyUI-KJNodes.git "$kjnodes_dir"
    [[ -f "$kjnodes_dir/requirements.txt" ]] && pip install -q -r "$kjnodes_dir/requirements.txt"
    pip install -q sageattention

    # Sol-Attn: NVlabs' training-free sparse attention (arXiv 2607.24027) as a
    # Triton kernel. Measured on a rented 5090 (5s @ 960x544, warm, one seed):
    # 34.3s against 38.6s for the Spectrum baseline — 11% off the whole run at
    # equal-or-better detail, holding the same take. It CHAINS onto sage rather
    # than replacing it (sage stays the dense fallback), keeps H3's packed
    # conditioning rows exact, and needs Triton, which the CUDA 13 image has.
    # First use compiles + autotunes its kernels (~6s, once per process).
    # Pinned: it is experimental and moves fast.
    solattn_dir="${COMFYUI_DIR}/custom_nodes/ComfyUI-SolAttn_triton"
    if [[ ! -d "$solattn_dir" ]]; then
        git clone -q https://github.com/kijai/ComfyUI-SolAttn_triton.git "$solattn_dir"
        git -C "$solattn_dir" checkout -q 842c4eaa7d91dbaef3fee3ccdbf36a39521e82fc
    fi

    # Fast high-res: a trained neural upscaler for H3's own 24-channel latent,
    # so the studio's two-pass lane can sample small and finish at full size
    # without the 5B-param VAE decode/encode round trip. Pinned; audited before
    # pinning (no network, no subprocess, no eval — its one torch.load with
    # weights_only=False only runs for .pth checkpoints, and we ship safetensors).
    upscaler_dir="${COMFYUI_DIR}/custom_nodes/Comfyui_Minimax_h3_latent_Upscaler"
    if [[ ! -d "$upscaler_dir" ]]; then
        git clone -q https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git "$upscaler_dir"
        git -C "$upscaler_dir" checkout -q 04f71594d11325be877b5ba05096fcb851c29048
    fi
    # The node scans this directory at schema time, so the weights have to land
    # before ComfyUI starts or the model_name combo comes up empty.
    fetch "https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler/resolve/main/minimax_h3_latent_upscaler_3d_bf16.safetensors" \
          "latent_upscale_models/minimax_h3_latent_upscaler_3d_bf16.safetensors"

    # RIFE weights for core ComfyUI's FrameInterpolate (no custom node needed).
    # 24 -> 48 fps costs +2.9s on a ~40s generation and leaves duration intact.
    fetch "https://huggingface.co/Comfy-Org/frame_interpolation/resolve/main/frame_interpolation/rife_v4.26.safetensors" \
          "frame_interpolation/rife_v4.26.safetensors"

    fetch "${R2_BASE_URL}/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors" \
          "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"
    fetch "${R2_BASE_URL}/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" \
          "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
    fetch "${R2_BASE_URL}/vae/minimax_h3_video_vae_fp16.safetensors" \
          "vae/minimax_h3_video_vae_fp16.safetensors"
    fetch "${R2_BASE_URL}/vae/minimax_h3_audio_vae_fp32.safetensors" \
          "vae/minimax_h3_audio_vae_fp32.safetensors"
    # BETA: larryvrh 4-step Turbo distill (drbaph ckpt500 pruned-ComfyUI
    # conversion) for the minimax-h3-turbo workflow.
    fetch "${R2_BASE_URL}/loras/minimax_h3_turbo_4step_ckpt500_pruned_comfyui.safetensors" \
          "loras/minimax_h3_turbo_4step_ckpt500_pruned_comfyui.safetensors"
fi

echo "provisioning complete"
