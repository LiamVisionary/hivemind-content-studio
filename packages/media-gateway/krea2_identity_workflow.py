"""Single-source Krea 2 Turbo identity-edit API workflow compiler."""

from __future__ import annotations

import os
import time


KREA2_TURBO_PRE_LORA_SOURCE_MODEL = "krea2_turbo_bf16.safetensors"
KREA2_IDENTITY_BACKENDS = {
    "comfy-krea2-turbo-identity-edit",
    "krea2-turbo-identity-edit",
    "krea2-identity-edit",
}
KREA2_IDENTITY_LORA = "krea2_identity_edit_v1_2.safetensors"
KREA2_TURBO_PORTABLE_MODEL = os.environ.get(
    "KREA2_TURBO_PORTABLE_MODEL",
    "krea2_turbo_fp8_scaled.safetensors",
)


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


def build_krea2_turbo_identity_prompt(
    prompt,
    image_name=None,
    options=None,
    profile="apple-silicon",
    filename_prefix="krea2_identity",
):
    """Build one optional-reference Krea2 Turbo graph for Apple and portable runtimes."""
    options = options or {}
    width = _int_option(options, "width", 1024, 64, 4096)
    height = _int_option(options, "height", 1024, 64, 4096)
    width = max(64, width - (width % 16))
    height = max(64, height - (height % 16))
    steps = _int_option(options, "steps", 10, 1, 50)
    cfg = _float_option(options, "cfg", _float_option(options, "guidance", 1.0, 0.0, 20.0), 0.0, 20.0)
    seed = _int_option(options, "seed", int(time.time()) % 1_000_000_000, 0, 1_000_000_000)
    grounding_px = _int_option(options, "grounding_px", 768, 0, 4096)
    ref_boost = _float_option(options, "ref_boost", 4.0, 0.0, 1000.0)
    identity_strength = _float_option(options, "identity_strength", 1.0, -10.0, 10.0)
    has_image = bool(image_name)

    if not has_image:
        if profile == "apple-silicon":
            model_nodes = {
                "1": {"class_type": "MultiLoRAStackToPreLora", "inputs": {"lora_stack": "[]"}},
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
        return {
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
    return graph
