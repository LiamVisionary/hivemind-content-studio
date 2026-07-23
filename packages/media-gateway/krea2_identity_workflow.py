"""Single-source Krea 2 Turbo identity-edit API workflow compiler."""

from __future__ import annotations

import json
import os
import random
from pathlib import Path


KREA2_TURBO_PRE_LORA_SOURCE_MODEL = "krea2_turbo_bf16.safetensors"
KREA2_IDENTITY_BACKENDS = {
    "comfy-krea2-turbo-identity-edit",
    "krea2-turbo-identity-edit",
    "krea2-identity-edit",
}
KREA2_IDENTITY_LORA = "krea2_identity_edit_v1_2.safetensors"
KREA2_IDENTITY_CONVROT_MODEL = os.environ.get(
    "KREA2_IDENTITY_CONVROT_MODEL",
    "Krea2_Turbo_identity_v1_2_convrot_int8mixed.safetensors",
)
KREA2_TURBO_PORTABLE_MODEL = os.environ.get(
    "KREA2_TURBO_PORTABLE_MODEL",
    "krea2_turbo_fp8_scaled.safetensors",
)


SEED_MAX = 1_000_000_000


def resolve_seed_option(options, key="seed"):
    """Resolve a sampler seed; missing, invalid, or negative (-1) means randomize."""
    try:
        value = int((options or {}).get(key, -1))
    except Exception:
        value = -1
    if value < 0:
        return random.randint(0, SEED_MAX)
    return min(SEED_MAX, value)


def _int_option(options, key, default, lo, hi):
    try:
        value = int(options.get(key, default))
    except Exception:
        value = default
    return max(lo, min(hi, value))


def _float_option(options, key, default, lo, hi):
    try:
        value = float(options.get(key, default))
    except Exception:
        value = default
    return max(lo, min(hi, value))


def _bool_option(options, key, default):
    value = options.get(key, default)
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no", "off", ""}
    return bool(value)


def _default_identity_checkpoint_available():
    comfy_root = Path(os.environ.get("COMFYUI_DIR", Path.home() / "comfy/ComfyUI"))
    return (comfy_root / "models/diffusion_models" / KREA2_IDENTITY_CONVROT_MODEL).is_file()


def _lora_entries(options):
    entries = []
    seen = set()
    for item in options.get("loras") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("id") or item.get("name") or item.get("lora") or "").strip()
        if not name or name in seen:
            continue
        entries.append({
            "on": True,
            "lora": name,
            "strength": _float_option(item, "strength", 1.0, -10.0, 10.0),
        })
        seen.add(name)
    return entries


def _append_portable_lora_nodes(graph, model_ref, entries, start_id=20):
    current_ref = model_ref
    for offset, entry in enumerate(entries):
        node_id = str(start_id + offset)
        graph[node_id] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": current_ref,
                "lora_name": entry["lora"],
                "strength_model": entry["strength"],
            },
        }
        current_ref = [node_id, 0]
    return current_ref


def build_krea2_turbo_identity_prompt(
    prompt,
    image_name=None,
    options=None,
    profile="apple-silicon",
    filename_prefix="krea2_identity",
    identity_checkpoint_available=None,
):
    """Build one optional-reference Krea2 Turbo graph for Apple and portable runtimes."""
    options = options or {}
    width = _int_option(options, "width", 1024, 64, 4096)
    height = _int_option(options, "height", 1024, 64, 4096)
    width = max(64, width - (width % 16))
    height = max(64, height - (height % 16))
    steps = _int_option(options, "steps", 10, 1, 50)
    cfg = _float_option(options, "cfg", _float_option(options, "guidance", 1.0, 0.0, 20.0), 0.0, 20.0)
    seed = resolve_seed_option(options)
    grounding_px = _int_option(options, "grounding_px", 768, 0, 4096)
    ref_boost = _float_option(options, "ref_boost", 4.0, 0.0, 1000.0)
    identity_strength = _float_option(options, "identity_strength", 1.0, -10.0, 10.0)
    # Default off: the cached identity forward is numerically divergent from the
    # official patch (grain regression, 2026-07-22 A/B); opt back in only after
    # the prime-step divergence in _krea2_edit_forward_cached is fixed.
    cache_static_tokens = _bool_option(options, "cache_static_tokens", False)
    extra_loras = _lora_entries(options)
    has_image = bool(image_name and str(image_name).strip().lower() != "none")
    if identity_checkpoint_available is None:
        identity_checkpoint_available = _default_identity_checkpoint_available()
    use_baked_identity = (
        profile == "apple-silicon"
        and has_image
        and identity_checkpoint_available
        and identity_strength == 1.0
        and not extra_loras
    )

    if not has_image:
        if profile == "apple-silicon":
            model_nodes = {
                "1": {
                    "class_type": "MultiLoRAStackToPreLora",
                    "inputs": {"lora_stack": json.dumps(extra_loras, separators=(",", ":"))},
                },
                "2": {
                    "class_type": "OTUNetLoaderW8A8",
                    "inputs": {
                        "unet_name": KREA2_TURBO_PRE_LORA_SOURCE_MODEL,
                        "weight_dtype": "default",
                        "model_type": "krea2",
                        "on_the_fly_quantization": True,
                        "enable_convrot": True,
                        "lora_mode": "None",
                        "pre_lora": ["1", 0],
                    },
                },
            }
        else:
            model_nodes = {
                "2": {
                    "class_type": "UNETLoader",
                    "inputs": {"unet_name": KREA2_TURBO_PORTABLE_MODEL, "weight_dtype": "default"},
                },
            }
        graph = {
            **model_nodes,
            "3": {
                "class_type": "CLIPLoader",
                "inputs": {
                    "clip_name": "qwen3vl_4b_bf16.safetensors",
                    "type": "krea2",
                    "device": "default",
                },
            },
            "4": {"class_type": "TextEncodeKrea2", "inputs": {"clip": ["3", 0], "prompt": prompt}},
            "5": {"class_type": "TextEncodeKrea2", "inputs": {"clip": ["3", 0], "prompt": ""}},
            "6": {
                "class_type": "EmptySD3LatentImage",
                "inputs": {"width": width, "height": height, "batch_size": 1},
            },
            "7": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["2", 0],
                    "positive": ["4", 0],
                    "negative": ["5", 0],
                    "latent_image": ["6", 0],
                    "seed": seed,
                    "steps": steps,
                    "cfg": cfg,
                    "sampler_name": "euler_ancestral",
                    "scheduler": "beta",
                    "denoise": 1.0,
                },
            },
            "8": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
            "9": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["8", 0]}},
            "10": {
                "class_type": "SaveImage",
                "inputs": {"images": ["9", 0], "filename_prefix": filename_prefix},
            },
        }
        if profile != "apple-silicon" and extra_loras:
            graph["7"]["inputs"]["model"] = _append_portable_lora_nodes(graph, ["2", 0], extra_loras)
        return graph

    graph = {
        "1": {"class_type": "HivemindOptionalLoadImage", "inputs": {"image": image_name or "None"}},
        "4": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": "qwen3vl_4b_bf16.safetensors",
                "type": "krea2",
                "device": "default",
            },
        },
        "5": {
            "class_type": "Krea2IdentityOptionalEncode",
            "inputs": {"clip": ["4", 0], "prompt": prompt, "image": ["1", 0], "grounding_px": grounding_px},
        },
        "6": {
            "class_type": "Krea2IdentityOptionalEncode",
            "inputs": {"clip": ["4", 0], "prompt": "", "image": ["1", 0], "grounding_px": grounding_px},
        },
        "7": {
            "class_type": "EmptySD3LatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1},
        },
        "8": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "9": {
            "class_type": "Krea2IdentityOptionalModelPatch",
            "inputs": {
                "model": ["3", 0],
                "vae": ["8", 0],
                "image": ["1", 0],
                "ref_boost": ref_boost,
                "fit_mode": "fit",
                "cache_static_tokens": cache_static_tokens,
            },
        },
        "10": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["9", 0],
                "positive": ["5", 0],
                "negative": ["6", 0],
                "latent_image": ["7", 0],
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": "euler_ancestral",
                "scheduler": "beta",
                "denoise": 1.0,
            },
        },
        "11": {"class_type": "VAEDecode", "inputs": {"samples": ["10", 0], "vae": ["8", 0]}},
        "12": {
            "class_type": "SaveImage",
            "inputs": {"images": ["11", 0], "filename_prefix": filename_prefix},
        },
    }

    if profile == "apple-silicon":
        if use_baked_identity:
            graph["3"] = {
                "class_type": "OTUNetLoaderW8A8",
                "inputs": {
                    "unet_name": KREA2_IDENTITY_CONVROT_MODEL,
                    "weight_dtype": "default",
                    "model_type": "krea2",
                    "on_the_fly_quantization": False,
                    "enable_convrot": True,
                    "lora_mode": "None",
                },
            }
        else:
            if extra_loras:
                identity_and_style_loras = [
                    {"on": True, "lora": KREA2_IDENTITY_LORA, "strength": identity_strength},
                    *extra_loras,
                ]
                graph["2"] = {
                    "class_type": "MultiLoRAStackToPreLora",
                    "inputs": {"lora_stack": json.dumps(identity_and_style_loras, separators=(",", ":"))},
                }
            else:
                graph["2"] = {
                    "class_type": "Krea2IdentityOptionalPreLora",
                    "inputs": {
                        "lora_name": KREA2_IDENTITY_LORA,
                        "strength": identity_strength,
                        "image": ["1", 0],
                    },
                }
            graph["3"] = {
                "class_type": "OTUNetLoaderW8A8",
                "inputs": {
                    "unet_name": KREA2_TURBO_PRE_LORA_SOURCE_MODEL,
                    "weight_dtype": "default",
                    "model_type": "krea2",
                    "on_the_fly_quantization": True,
                    "enable_convrot": True,
                    "lora_mode": "None",
                    "pre_lora": ["2", 0],
                },
            }
    else:
        graph["2"] = {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": KREA2_TURBO_PORTABLE_MODEL, "weight_dtype": "default"},
        }
        graph["3"] = {
            "class_type": "Krea2IdentityOptionalLoraModel",
            "inputs": {
                "model": ["2", 0],
                "lora_name": KREA2_IDENTITY_LORA,
                "strength": identity_strength,
                "image": ["1", 0],
            },
        }
        if extra_loras:
            graph["9"]["inputs"]["model"] = _append_portable_lora_nodes(graph, ["3", 0], extra_loras)
    return graph


def ltx_anchor_canvas_geometry(source_width, source_height, target_width, target_height):
    """Return a contain-and-pad plan without changing the source aspect ratio."""
    values = [source_width, source_height, target_width, target_height]
    if any(int(value) <= 0 for value in values):
        raise ValueError("source and target dimensions must be positive")
    source_width, source_height, target_width, target_height = map(int, values)
    source_ratio = source_width / source_height
    target_ratio = target_width / target_height
    ratio_error = abs(source_ratio - target_ratio) / target_ratio
    if ratio_error <= 0.005:
        return {
            "mode": "passthrough" if (source_width, source_height) == (target_width, target_height) else "resize",
            "source_width": source_width,
            "source_height": source_height,
            "scaled_width": target_width,
            "scaled_height": target_height,
            "target_width": target_width,
            "target_height": target_height,
            "left": 0,
            "top": 0,
            "right": 0,
            "bottom": 0,
        }

    scale = min(target_width / source_width, target_height / source_height)
    scaled_width = max(1, min(target_width, round(source_width * scale)))
    scaled_height = max(1, min(target_height, round(source_height * scale)))
    horizontal = target_width - scaled_width
    vertical = target_height - scaled_height
    left = horizontal // 2
    top = vertical // 2
    return {
        "mode": "outpaint",
        "source_width": source_width,
        "source_height": source_height,
        "scaled_width": scaled_width,
        "scaled_height": scaled_height,
        "target_width": target_width,
        "target_height": target_height,
        "left": left,
        "top": top,
        "right": horizontal - left,
        "bottom": vertical - top,
    }


def build_krea2_turbo_outpaint_prompt(
    prompt,
    image_name,
    *,
    source_width,
    source_height,
    options=None,
    profile="apple-silicon",
    filename_prefix="krea2_outpaint",
    identity_checkpoint_available=None,
):
    """Build the shared pixel-preserving LTX anchor-canvas graph.

    Only the missing canvas is sampled. The contained source is composited back
    over the decoded result with the inverse feather mask so its pixels remain
    the authoritative start-frame content.
    """
    options = dict(options or {})
    target_width = _int_option(options, "width", 768, 64, 4096)
    target_height = _int_option(options, "height", 448, 64, 4096)
    target_width -= target_width % 16
    target_height -= target_height % 16
    geometry = ltx_anchor_canvas_geometry(
        source_width,
        source_height,
        target_width,
        target_height,
    )

    if geometry["mode"] == "passthrough":
        return {
            "graph": {
                "1": {"class_type": "HivemindOptionalLoadImage", "inputs": {"image": image_name}},
            },
            "output": ["1", 0],
            "geometry": geometry,
        }
    if geometry["mode"] == "resize":
        return {
            "graph": {
                "1": {"class_type": "HivemindOptionalLoadImage", "inputs": {"image": image_name}},
                "2": {
                    "class_type": "ImageScale",
                    "inputs": {
                        "image": ["1", 0],
                        "upscale_method": "lanczos",
                        "width": target_width,
                        "height": target_height,
                        "crop": "disabled",
                    },
                },
            },
            "output": ["2", 0],
            "geometry": geometry,
        }

    scene_prompt = str(prompt or "").strip()
    edit_prompt = (
        "Extend only the missing canvas around the source image into coherent, sharp scene content. "
        "Keep the contained source region unchanged, including every subject, face, pose, object, camera "
        "distance, vertical framing, lighting, color, and readable design. Continue the environment naturally. "
        "Treat every visible character, product, logo, emblem, sign, and piece of text as already complete: do "
        "not repeat, clone, mirror, replace, extend, or add another instance of any of them in the new area. "
        "Generate only the missing surrounding environment and background continuation. Fixed camera. No blurred "
        "borders, sidebars, duplicate subjects or objects, crop, zoom, pullback, reframing, or new foreground objects."
    )
    if scene_prompt:
        edit_prompt += f" Scene context: {scene_prompt}"
    graph = build_krea2_turbo_identity_prompt(
        edit_prompt,
        image_name=image_name,
        options={
            **options,
            "width": target_width,
            "height": target_height,
            "steps": _int_option(options, "steps", 10, 1, 50),
            "cfg": _float_option(options, "cfg", 1.0, 0.0, 20.0),
            "ref_boost": _float_option(options, "ref_boost", 4.0, 0.0, 1000.0),
            "identity_strength": _float_option(options, "identity_strength", 1.0, -10.0, 10.0),
            "grounding_px": _int_option(options, "grounding_px", 768, 0, 4096),
        },
        profile=profile,
        filename_prefix=filename_prefix,
        identity_checkpoint_available=identity_checkpoint_available,
    )
    graph["13"] = {
        "class_type": "ImageScale",
        "inputs": {
            "image": ["1", 0],
            "upscale_method": "lanczos",
            "width": geometry["scaled_width"],
            "height": geometry["scaled_height"],
            "crop": "disabled",
        },
    }
    graph["14"] = {
        "class_type": "ImagePadForOutpaint",
        "inputs": {
            "image": ["13", 0],
            "left": geometry["left"],
            "top": geometry["top"],
            "right": geometry["right"],
            "bottom": geometry["bottom"],
            "feathering": _int_option(options, "feathering", 48, 0, 256),
        },
    }
    graph["15"] = {
        "class_type": "InpaintModelConditioning",
        "inputs": {
            "positive": ["5", 0],
            "negative": ["6", 0],
            "vae": ["8", 0],
            "pixels": ["14", 0],
            "mask": ["14", 1],
            "noise_mask": True,
        },
    }
    graph["16"] = {
        "class_type": "DifferentialDiffusion",
        "inputs": {"model": ["9", 0], "strength": 1.0},
    }
    graph["10"]["inputs"].update({
        "model": ["16", 0],
        "positive": ["15", 0],
        "negative": ["15", 1],
        "latent_image": ["15", 2],
        "denoise": 1.0,
    })
    graph["17"] = {"class_type": "InvertMask", "inputs": {"mask": ["14", 1]}}
    graph["19"] = {
        "class_type": "ImageScale",
        "inputs": {
            "image": ["1", 0],
            "upscale_method": "lanczos",
            "width": target_width,
            "height": target_height,
            "crop": "center",
        },
    }
    graph["20"] = {
        "class_type": "ImageBlur",
        "inputs": {"image": ["19", 0], "blur_radius": 31, "sigma": 10.0},
    }
    graph["21"] = {
        "class_type": "ImageCompositeMasked",
        "inputs": {
            "destination": ["20", 0],
            "source": ["14", 0],
            "x": 0,
            "y": 0,
            "resize_source": False,
            "mask": ["17", 0],
        },
    }
    graph["15"]["inputs"]["pixels"] = ["21", 0]
    graph["10"]["inputs"]["denoise"] = _float_option(options, "denoise", 0.7, 0.1, 1.0)
    graph["18"] = {
        "class_type": "ImageCompositeMasked",
        "inputs": {
            "destination": ["11", 0],
            "source": ["14", 0],
            "x": 0,
            "y": 0,
            "resize_source": False,
            "mask": ["17", 0],
        },
    }
    graph["12"]["inputs"]["images"] = ["18", 0]
    return {"graph": graph, "output": ["18", 0], "geometry": geometry}
