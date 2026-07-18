"""Optional Krea 2 identity-edit adapters for unified Turbo workflows."""

from __future__ import annotations

import hashlib
import math
import os

import folder_paths
import torch.nn.functional as F
from nodes import LoadImage


IDENTITY_LORA = "krea2_identity_edit_v1_2.safetensors"


def _node_class(name):
    import nodes

    node = nodes.NODE_CLASS_MAPPINGS.get(name)
    if node is None:
        raise RuntimeError(
            f"{name} is unavailable. Install lbouaraba/comfyui-krea2edit and restart ComfyUI."
        )
    return node


def _bootstrap_vae_image(image, max_pixels=1_048_576, max_side=1024):
    """Bound the required fallback latent; the official pixel path keeps the full source."""
    height, width = image.shape[1:3]
    scale = min(1.0, max_side / max(height, width), math.sqrt(max_pixels / (height * width)))
    if scale >= 1.0:
        return image[:, :, :, :3]
    target_height = max(16, round(height * scale / 16) * 16)
    target_width = max(16, round(width * scale / 16) * 16)
    channels_first = image[:, :, :, :3].movedim(-1, 1)
    resized = F.interpolate(
        channels_first.float(),
        size=(target_height, target_width),
        mode="bicubic",
        antialias=True,
    )
    return resized.movedim(1, -1).clamp(0, 1)


class HivemindOptionalLoadImage:
    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = [
            name
            for name in os.listdir(input_dir)
            if os.path.isfile(os.path.join(input_dir, name))
        ]
        files = folder_paths.filter_files_content_types(files, ["image"])
        return {
            "required": {
                "image": (["None", *sorted(files)], {"image_upload": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    FUNCTION = "load_image"
    CATEGORY = "Hivemind/Krea2"

    def load_image(self, image):
        if not image or image == "None":
            return (None, None)
        return LoadImage().load_image(image)

    @classmethod
    def IS_CHANGED(cls, image):
        if not image or image == "None":
            return "none"
        path = folder_paths.get_annotated_filepath(image)
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            digest.update(handle.read())
        return digest.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, image):
        if not image or image == "None":
            return True
        if not folder_paths.exists_annotated_filepath(image):
            return f"Invalid image file: {image}"
        return True


class Krea2IdentityOptionalPreLora:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lora_name": (folder_paths.get_filename_list("loras"), {"default": IDENTITY_LORA}),
                "strength": ("FLOAT", {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.05}),
            },
            "optional": {"image": ("IMAGE",)},
        }

    RETURN_TYPES = ("PRE_LORA",)
    FUNCTION = "build"
    CATEGORY = "Hivemind/Krea2"

    def build(self, lora_name, strength=1.0, image=None):
        if image is None:
            return ([],)
        return ([{"lora_name": lora_name, "lora_strength": round(float(strength), 2)}],)


class Krea2IdentityOptionalLoraModel:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "lora_name": (folder_paths.get_filename_list("loras"), {"default": IDENTITY_LORA}),
                "strength": ("FLOAT", {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.05}),
            },
            "optional": {"image": ("IMAGE",)},
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "Hivemind/Krea2"

    def apply(self, model, lora_name, strength=1.0, image=None):
        if image is None:
            return (model,)
        loader = _node_class("LoraLoaderModelOnly")()
        return loader.load_lora_model_only(model, lora_name, float(strength))


class Krea2IdentityOptionalModelPatch:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "vae": ("VAE",),
                "ref_boost": ("FLOAT", {"default": 4.0, "min": 0.0, "max": 1000.0, "step": 0.05}),
                "fit_mode": (["fit", "crop (legacy)"], {"default": "fit"}),
            },
            "optional": {"image": ("IMAGE",)},
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "Hivemind/Krea2"

    def patch(self, model, vae, ref_boost=4.0, fit_mode="fit", image=None):
        if image is None:
            return (model,)
        source_latent = {"samples": vae.encode(_bootstrap_vae_image(image))}
        patcher = _node_class("Krea2EditModelPatch")()
        return patcher.patch(
            model=model,
            source_latent=source_latent,
            ref_boost=float(ref_boost),
            ref_boost_a=1.0,
            vae=vae,
            source_image=image,
            fit_mode=fit_mode,
        )


class Krea2IdentityOptionalEncode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True}),
                "grounding_px": ("INT", {"default": 768, "min": 0, "max": 4096, "step": 64}),
            },
            "optional": {"image": ("IMAGE",)},
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "encode"
    CATEGORY = "Hivemind/Krea2"

    def encode(self, clip, prompt, grounding_px=768, image=None):
        if image is None:
            encoder = _node_class("TextEncodeKrea2")()
            return encoder.encode(clip=clip, prompt=prompt)
        encoder = _node_class("Krea2EditGroundedEncode")()
        return encoder.encode(
            clip=clip,
            prompt=prompt,
            image=image,
            grounding_px=int(grounding_px),
        )


NODE_CLASS_MAPPINGS = {
    "HivemindOptionalLoadImage": HivemindOptionalLoadImage,
    "Krea2IdentityOptionalPreLora": Krea2IdentityOptionalPreLora,
    "Krea2IdentityOptionalLoraModel": Krea2IdentityOptionalLoraModel,
    "Krea2IdentityOptionalModelPatch": Krea2IdentityOptionalModelPatch,
    "Krea2IdentityOptionalEncode": Krea2IdentityOptionalEncode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "HivemindOptionalLoadImage": "Optional Reference Image",
    "Krea2IdentityOptionalPreLora": "Krea2 Identity Optional Pre-LoRA",
    "Krea2IdentityOptionalLoraModel": "Krea2 Identity Optional Model LoRA",
    "Krea2IdentityOptionalModelPatch": "Krea2 Identity Optional Source Patch",
    "Krea2IdentityOptionalEncode": "Krea2 Identity Optional Encode",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
