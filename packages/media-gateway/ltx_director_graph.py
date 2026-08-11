"""LTX Director graph: a validated timeline becomes an API-format ComfyUI prompt.

Translated from Mix-Studio's `buildLtxDirectorGraph` (lib/ltx-director-workflows.js
L332+) — BlackMixture/Mix-Studio, GPL-3.0. See THIRD_PARTY_NOTICES.md.

Shape of the run, which is the part worth understanding:

  LTXDirector turns the whole timeline into ONE conditioning + latent pair, then
  the graph samples it twice. The base pass runs at half scale (`scale_by` 0.5)
  on a coarse sigma ladder; its latent is upsampled by the LTX spatial upscaler
  and re-guided for a short refine pass. Video and audio latents ride together
  through the sampler (concat) and are split again for decoding (separate),
  which is why an LTX 2.3 clip arrives with sound instead of silent — the trap
  recorded in the eros lane.

  LTXDirectorCropGuides trims the guide frames back off after each pass. Skipping
  it leaves the guide images baked into the output as visible extra frames.

Asset names come from ASSETS below rather than from the caller, because a
mistyped checkpoint reaches ComfyUI as a validation error with no useful context.
`missing_ltx_director_assets()` answers that question up front instead.
"""

import copy

from ltx_director_timeline import (
    DIRECTOR_FPS,
    director_output_frames,
    director_prompt_inputs,
    director_timeline_data,
    director_window_project,
    normalize_director_project,
)

# Sigma ladders lifted verbatim from the donor's server (LTX_SIGMAS_BASE /
# LTX_SIGMAS_REFINE). The base ladder's long flat head is deliberate: LTX 2.3
# distilled needs several near-1.0 steps before it commits to structure.
SIGMAS_BASE = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
SIGMAS_REFINE = "0.85, 0.7250, 0.4219, 0.0"

ASSETS = {
    "checkpoint": "ltx-2.3-22b-dev-fp8.safetensors",
    "distilled_lora": "ltx/2.3/ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
    # The donor pins the fp4_mixed encoder, which is an NVIDIA quantisation this
    # Mac cannot run; fp8_scaled is the same weights in a format MPS handles.
    "text_encoder": "gemma_3_12B_it_fp8_scaled.safetensors",
    "text_encoder_lora": "ltx/2.3/gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors",
    "upscaler": "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
    "ic_lora": "ltx/2.3/ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors",
}

# LTXDirector output slots, named because positional indexes into an 8-output
# node are how graphs quietly wire audio into a video socket.
_D_MODEL, _D_POSITIVE, _D_VIDEO_LATENT, _D_AUDIO_LATENT = 0, 1, 2, 3
_D_GUIDE_DATA, _D_MOTION_GUIDE_DATA = 4, 5
# LTXDirectorGuide: positive, negative, latent, model, latent_downscale_factor
_G_POSITIVE, _G_NEGATIVE, _G_LATENT, _G_MODEL = 0, 1, 2, 3
# CheckpointLoaderSimple: MODEL, CLIP, VAE
_CKPT_VAE = 2


def _round_to(value, multiple, minimum):
    return max(minimum, int(round(float(value) / multiple)) * multiple)


def assets_for(overrides=None):
    merged = dict(ASSETS)
    if overrides:
        merged.update({k: v for k, v in overrides.items() if k in ASSETS and v})
    return merged


def missing_ltx_director_assets(available, overrides=None):
    """Which required weights ComfyUI is not offering.

    `available` is what /object_info reports per folder:
    {"checkpoints": [...], "loras": [...], "text_encoders": [...],
     "latent_upscale_models": [...]}.
    """
    assets = assets_for(overrides)
    wanted = [
        ("checkpoints", assets["checkpoint"]),
        ("loras", assets["distilled_lora"]),
        ("text_encoders", assets["text_encoder"]),
        ("loras", assets["text_encoder_lora"]),
        ("latent_upscale_models", assets["upscaler"]),
        ("loras", assets["ic_lora"]),
    ]
    missing = []
    for folder, name in wanted:
        if name not in (available.get(folder) or []):
            missing.append(name)
    return missing


def _lora_chain(graph, model_link, loras, prefix):
    """Extra model-only LoRAs stacked after the distilled one."""
    current = model_link
    index = 0
    for lora in loras or []:
        name = str((lora or {}).get("name") or "").strip()
        if not name or (lora or {}).get("enabled") is False:
            continue
        index += 1
        key = f"{prefix}_{index}"
        strength = lora.get("strength")
        graph[key] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": current,
                "lora_name": name,
                "strength_model": float(strength) if isinstance(strength, (int, float)) else 1.0,
            },
        }
        current = [key, 0]
    return current


def build_ltx_director_prompt(project, options=None, asset_overrides=None):
    """Return (graph, meta) for a validated Director project."""
    options = options or {}
    normalized = normalize_director_project(project)
    window = director_window_project(normalized)
    prompt_inputs = director_prompt_inputs(window)
    frames = director_output_frames(normalized)
    assets = assets_for(asset_overrides)

    # The model samples on a 64-px grid; the node then snaps to divisible_by=32.
    width = _round_to(options.get("width", 1280), 64, 256)
    height = _round_to(options.get("height", 720), 64, 256)
    window_frames = window["range"]["lengthFrames"]
    seconds = window_frames / DIRECTOR_FPS

    graph = {}
    graph["ckpt"] = {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": assets["checkpoint"]},
    }
    graph["model_lora"] = {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {
            "model": ["ckpt", 0],
            "lora_name": assets["distilled_lora"],
            # 0.5 is the donor's value and it matters: the distilled LoRA at full
            # strength flattens motion on this sigma ladder.
            "strength_model": 0.5,
        },
    }
    model_link = _lora_chain(graph, ["model_lora", 0], options.get("loras"), "director_lora")

    graph["te"] = {
        "class_type": "LTXAVTextEncoderLoader",
        "inputs": {
            "text_encoder": assets["text_encoder"],
            "ckpt_name": assets["checkpoint"],
            "device": "default",
        },
    }
    graph["te_lora"] = {
        "class_type": "LoraLoader",
        "inputs": {
            "model": ["ckpt", 0],
            "clip": ["te", 0],
            "lora_name": assets["text_encoder_lora"],
            "strength_model": 0.7,
            "strength_clip": 0.7,
        },
    }
    graph["audio_vae"] = {
        "class_type": "LTXVAudioVAELoader",
        "inputs": {"ckpt_name": assets["checkpoint"]},
    }

    graph["director"] = {
        "class_type": "LTXDirector",
        "inputs": {
            "model": model_link,
            # Slot 1 of LoraLoader is the CLIP the text-encoder LoRA produced.
            "clip": ["te_lora", 1],
            "audio_vae": ["audio_vae", 0],
            "global_prompt": window["globalPrompt"],
            "start_second": 0,
            "end_second": seconds,
            "duration_seconds": seconds,
            "start_frame": 0,
            "end_frame": window_frames,
            "duration_frames": window_frames,
            "timeline_data": director_timeline_data(window),
            "use_custom_audio": len(window["audioSegments"]) > 0,
            "use_custom_motion": len(window["motionSegments"]) > 0,
            "inpaint_audio": window["settings"]["inpaintAudio"],
            "local_prompts": prompt_inputs["localPrompts"],
            "segment_lengths": prompt_inputs["segmentLengths"],
            "epsilon": window["settings"]["epsilon"],
            "frame_rate": DIRECTOR_FPS,
            "display_mode": "seconds",
            "guide_strength": prompt_inputs["guideStrength"],
            "custom_width": width,
            "custom_height": height,
            "resize_method": window["settings"]["resizeMethod"],
            "divisible_by": 32,
            "img_compression": window["settings"]["imgCompression"],
            "override_audio": window["settings"]["overrideAudio"],
        },
    }
    graph["zero_negative"] = {
        "class_type": "ConditioningZeroOut",
        "inputs": {"conditioning": ["director", _D_POSITIVE]},
    }
    graph["conditioning"] = {
        "class_type": "LTXVConditioning",
        "inputs": {
            "positive": ["director", _D_POSITIVE],
            "negative": ["zero_negative", 0],
            "frame_rate": DIRECTOR_FPS,
        },
    }

    # The IC-LoRA is what makes a motion-guidance track mean anything; with no
    # motion segments it is dead weight on the sampler, so it stands down.
    ic_lora = (
        (window["settings"]["icLoraName"] or assets["ic_lora"])
        if window["motionSegments"] else "None"
    )

    def guide_inputs(positive, negative, latent, scale_by):
        return {
            "positive": positive,
            "negative": negative,
            "vae": ["ckpt", _CKPT_VAE],
            "latent": latent,
            "guide_data": ["director", _D_GUIDE_DATA],
            "motion_guide_data": ["director", _D_MOTION_GUIDE_DATA],
            "model": ["director", _D_MODEL],
            "ic_lora_name": ic_lora,
            "ic_lora_strength": window["settings"]["icLoraStrength"],
            "scale_by": scale_by,
            "upscale_method": "bicubic",
            "image_attention_strength": 1,
            "crop": "center",
            "auto_snap_ic_grid": True,
            "use_tiled_encode": False,
            "tile_size": 256,
            "tile_overlap": 64,
            "retake_mode": False,
        }

    # ── base pass, half scale ────────────────────────────────────────────────
    graph["guide_base"] = {
        "class_type": "LTXDirectorGuide",
        "inputs": guide_inputs(
            ["conditioning", 0], ["conditioning", 1], ["director", _D_VIDEO_LATENT], 0.5
        ),
    }
    graph["concat1"] = {
        "class_type": "LTXVConcatAVLatent",
        "inputs": {
            "video_latent": ["guide_base", _G_LATENT],
            "audio_latent": ["director", _D_AUDIO_LATENT],
        },
    }
    graph["noise"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": int(options.get("seed", 0))}}
    graph["guider1"] = {
        "class_type": "CFGGuider",
        "inputs": {
            "model": ["guide_base", _G_MODEL],
            "positive": ["guide_base", _G_POSITIVE],
            "negative": ["guide_base", _G_NEGATIVE],
            "cfg": 1,
        },
    }
    graph["sampler_sel1"] = {
        "class_type": "KSamplerSelect",
        "inputs": {"sampler_name": "euler_ancestral_cfg_pp"},
    }
    graph["sigmas1"] = {
        "class_type": "ManualSigmas",
        "inputs": {"sigmas": options.get("sigmas_base") or SIGMAS_BASE},
    }
    graph["samp1"] = {
        "class_type": "SamplerCustomAdvanced",
        "inputs": {
            "noise": ["noise", 0], "guider": ["guider1", 0],
            "sampler": ["sampler_sel1", 0], "sigmas": ["sigmas1", 0],
            "latent_image": ["concat1", 0],
        },
    }
    graph["sep1"] = {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["samp1", 0]}}
    graph["crop1"] = {
        "class_type": "LTXDirectorCropGuides",
        "inputs": {
            "positive": ["guide_base", _G_POSITIVE],
            "negative": ["guide_base", _G_NEGATIVE],
            "latent": ["sep1", 0],
        },
    }

    # ── refine pass, upsampled to full scale ─────────────────────────────────
    graph["ups_model"] = {
        "class_type": "LatentUpscaleModelLoader",
        "inputs": {"model_name": assets["upscaler"]},
    }
    graph["ups"] = {
        "class_type": "LTXVLatentUpsampler",
        "inputs": {
            "samples": ["crop1", 2],
            "upscale_model": ["ups_model", 0],
            "vae": ["ckpt", _CKPT_VAE],
        },
    }
    graph["guide_refine"] = {
        "class_type": "LTXDirectorGuide",
        "inputs": guide_inputs(["crop1", 0], ["crop1", 1], ["ups", 0], 1),
    }
    graph["guider2"] = {
        "class_type": "CFGGuider",
        "inputs": {
            "model": ["guide_refine", _G_MODEL],
            "positive": ["guide_refine", _G_POSITIVE],
            "negative": ["guide_refine", _G_NEGATIVE],
            "cfg": 1,
        },
    }
    graph["sampler_sel2"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler_cfg_pp"}}
    graph["sigmas2"] = {
        "class_type": "ManualSigmas",
        "inputs": {"sigmas": options.get("sigmas_refine") or SIGMAS_REFINE},
    }
    graph["concat2"] = {
        "class_type": "LTXVConcatAVLatent",
        "inputs": {
            "video_latent": ["guide_refine", _G_LATENT],
            # The audio latent from the base pass carries forward; only the video
            # half is refined.
            "audio_latent": ["sep1", 1],
        },
    }
    graph["samp2"] = {
        "class_type": "SamplerCustomAdvanced",
        "inputs": {
            "noise": ["noise", 0], "guider": ["guider2", 0],
            "sampler": ["sampler_sel2", 0], "sigmas": ["sigmas2", 0],
            "latent_image": ["concat2", 0],
        },
    }
    graph["sep2"] = {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["samp2", 0]}}
    graph["crop2"] = {
        "class_type": "LTXDirectorCropGuides",
        "inputs": {
            "positive": ["guide_refine", _G_POSITIVE],
            "negative": ["guide_refine", _G_NEGATIVE],
            "latent": ["sep2", 0],
        },
    }

    # ── decode and mux ───────────────────────────────────────────────────────
    graph["decode"] = {
        "class_type": "VAEDecodeTiled",
        "inputs": {
            "samples": ["crop2", 2], "vae": ["ckpt", _CKPT_VAE],
            "tile_size": 768, "overlap": 64,
            # temporal_size above the clip length means "one temporal tile" —
            # tiling time as well as space is what makes seams pulse.
            "temporal_size": 4096, "temporal_overlap": 4,
        },
    }
    graph["audio_dec"] = {
        "class_type": "LTXVAudioVAEDecode",
        "inputs": {"samples": ["sep2", 1], "audio_vae": ["audio_vae", 0]},
    }
    graph["video"] = {
        "class_type": "CreateVideo",
        "inputs": {"images": ["decode", 0], "fps": DIRECTOR_FPS, "audio": ["audio_dec", 0]},
    }
    graph["save"] = {
        "class_type": "SaveVideo",
        "inputs": {
            "video": ["video", 0],
            "filename_prefix": options.get("filename_prefix") or "ltx_director",
            "format": "auto",
            "codec": "auto",
        },
    }

    meta = {
        "frames": frames,
        "width": width,
        "height": height,
        "seconds": seconds,
        "assets": assets,
        "icLoraName": ic_lora,
        "localPrompts": prompt_inputs["localPrompts"],
        "segmentLengths": prompt_inputs["segmentLengths"],
        "guideStrength": prompt_inputs["guideStrength"],
        "project": copy.deepcopy(normalized),
    }
    return graph, meta
