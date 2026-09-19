"""Optional Krea 2 identity-edit adapters for unified Turbo workflows."""

from __future__ import annotations

import hashlib
import math
import os
import sys

import folder_paths
import torch
import torch.nn.functional as F
from einops import rearrange
from nodes import LoadImage

import comfy.ldm.common_dit
import comfy.patcher_extension
from comfy.ldm.flux.layers import timestep_embedding


IDENTITY_LORA = "krea2_identity_edit_v1_2.safetensors"
REGULAR_CONVROT_MODEL = "Krea2_Turbo_convrot_int8mixed.safetensors"
IDENTITY_CONVROT_MODEL = "Krea2_Turbo_identity_v1_2_convrot_int8mixed.safetensors"


def _node_class(name):
    import nodes

    node = nodes.NODE_CLASS_MAPPINGS.get(name)
    if node is None:
        raise RuntimeError(
            f"{name} is unavailable. Install lbouaraba/comfyui-krea2edit and restart ComfyUI."
        )
    return node


def _official_module():
    node = _node_class("Krea2EditModelPatch")
    module = sys.modules.get(node.__module__)
    if module is None:
        raise RuntimeError("The loaded comfyui-krea2edit module could not be resolved")
    return module


def _tensor_layout_key(value):
    if value is None:
        return None
    return (
        tuple(value.shape),
        tuple(value.stride()),
        str(value.dtype),
        str(value.device),
    )


def _tensor_identity_key(value):
    if value is None:
        return None
    return (id(value), value.data_ptr(), *_tensor_layout_key(value))


def _transformer_options_key(options):
    """Track the options that can alter pre-block text fusion attention."""
    cond = options.get("cond_or_uncond")
    if isinstance(cond, (list, tuple)):
        cond = tuple(cond)
    return (
        cond,
        id(options.get("optimized_attention_override")),
        _tensor_identity_key(options.get("sample_sigmas")),
    )


def _krea2_edit_forward_cached(
    m,
    x,
    timesteps,
    context,
    src_latent,
    transformer_options,
    static_cache,
    ref_boost=1.0,
    ref_boost_a=1.0,
    ref_boost_mask=None,
    ref_native=False,
    pos_mode="anchor",
):
    """Krea2 edit forward with exact caching before joint transformer attention.

    Source projection, text fusion, RoPE, and reference bias do not depend on the
    timestep or noisy target. Transformer block states are intentionally never
    cached because Krea2 performs joint source/target self-attention in every block.
    """
    official = _official_module()
    patch = m.patch
    temporal = x.ndim == 5
    if temporal:
        b5, _c5, t5, _h5, _w5 = x.shape
    x = official._to_4d(x)
    bs, _c, H_orig, W_orig = x.shape

    x = comfy.ldm.common_dit.pad_to_patch_size(x, (patch, patch), padding_mode="replicate")
    H, W = x.shape[-2], x.shape[-1]
    h_, w_ = H // patch, W // patch
    tgt_img = m.first(
        rearrange(x, "b c (h ph) (w pw) -> b (h w) (c ph pw)", ph=patch, pw=patch)
    )

    src_list = src_latent if isinstance(src_latent, (list, tuple)) else [src_latent]
    cache_key = (
        bs,
        H,
        W,
        str(x.device),
        str(x.dtype),
        _tensor_layout_key(context),
        tuple(_tensor_layout_key(src) for src in src_list),
        float(ref_boost),
        float(ref_boost_a),
        _tensor_layout_key(ref_boost_mask),
        bool(ref_native),
        str(pos_mode),
        _transformer_options_key(transformer_options),
    )

    if static_cache.get("key") != cache_key:
        srcs = []
        for source_latent in src_list:
            src = official._to_4d(source_latent).to(x.device, x.dtype)
            if src.shape[0] != bs:
                src = src[:1].expand(bs, *src.shape[1:])
            if not ref_native and src.shape[-2:] != (H, W):
                print(
                    f"[krea2edit] LATENT-PATH fit_src (crop): "
                    f"src={tuple(src.shape[-2:])} -> {H}x{W}",
                    flush=True,
                )
                src = official._fit_src(src, H, W).to(x.dtype)
            srcs.append(
                comfy.ldm.common_dit.pad_to_patch_size(
                    src, (patch, patch), padding_mode="replicate"
                )
            )
        src_grids = [
            (source.shape[-2] // patch, source.shape[-1] // patch) for source in srcs
        ]
        src_imgs = [
            m.first(
                rearrange(
                    source,
                    "b c (h ph) (w pw) -> b (h w) (c ph pw)",
                    ph=patch,
                    pw=patch,
                )
            )
            for source in srcs
        ]

        fused_context = m.txtfusion(
            m._unpack_context(context),
            mask=None,
            transformer_options=transformer_options,
        )
        fused_context = m.txtmlp(fused_context)
        txtlen = fused_context.shape[1]
        tgtlen = tgt_img.shape[1]
        srclen = sum(source.shape[1] for source in src_imgs)
        device = tgt_img.device

        if pos_mode == "stride1" and ref_native:
            print(
                f"[krea2edit] STRIDE1-POS fit: ref grids {src_grids} "
                f"centered in ({h_},{w_})",
                flush=True,
            )
            if any(h_ - gh > 2 or w_ - gw > 2 for gh, gw in src_grids):
                print(
                    "[krea2edit] NOTE: fit margins >2 tokens (large source/output "
                    "aspect-ratio gap). fit is trained for matched/near-matched AR; "
                    "for a big AR change prefer 'crop', or set the output AR closer "
                    "to the source.",
                    flush=True,
                )
            ref_ids = [
                official._imgids_offset(bs, index + 1, gh, gw, h_, w_, device)
                for index, (gh, gw) in enumerate(src_grids)
            ]
        else:
            ref_ids = [
                official._imgids(bs, index + 1, gh, gw, device)
                for index, (gh, gw) in enumerate(src_grids)
            ]

        pos = torch.cat(
            [torch.zeros(bs, txtlen, 3, device=device, dtype=torch.float32)]
            + ref_ids
            + [official._imgids(bs, 0, h_, w_, device)],
            dim=1,
        )
        freqs = m.pe_embedder(pos)

        attn_bias = None
        if ref_boost != 1.0 or ref_boost_a != 1.0:
            boosts = [ref_boost_a] * (len(src_imgs) - 1) + [ref_boost]
            attn_bias = official._ref_attn_bias(
                boosts,
                ref_boost_mask,
                txtlen,
                [source.shape[1] for source in src_imgs],
                tgtlen,
                src_grids,
                tgt_img.device,
                tgt_img.dtype,
            )

        static_cache.clear()
        static_cache.update(
            key=cache_key,
            context=fused_context,
            src_imgs=src_imgs,
            freqs=freqs,
            attn_bias=attn_bias,
            txtlen=txtlen,
            tgtlen=tgtlen,
            srclen=srclen,
            hits=0,
        )
        print(
            f"[krea2edit] static pre-block cache primed: text={txtlen}, "
            f"source={srclen}, target={tgtlen}",
            flush=True,
        )
    else:
        static_cache["hits"] += 1
        if static_cache["hits"] == 1:
            print("[krea2edit] static pre-block cache active", flush=True)

    t = m.tmlp(timestep_embedding(timesteps, m.tdim).unsqueeze(1).to(tgt_img.dtype))
    tvec = m.tproj(t)
    combined = torch.cat(
        [static_cache["context"]] + static_cache["src_imgs"] + [tgt_img], dim=1
    )
    for block in m.blocks:
        combined = block(
            combined,
            tvec,
            static_cache["freqs"],
            static_cache["attn_bias"],
            transformer_options=transformer_options,
        )

    final = m.last(combined, t)
    txtlen = static_cache["txtlen"]
    srclen = static_cache["srclen"]
    tgtlen = static_cache["tgtlen"]
    out = final[:, txtlen + srclen:txtlen + srclen + tgtlen, :]
    out = rearrange(
        out,
        "b (h w) (c ph pw) -> b c (h ph) (w pw)",
        h=h_,
        w=w_,
        ph=patch,
        pw=patch,
        c=m.channels,
    )
    out = out[:, :, :H_orig, :W_orig]
    if temporal:
        out = out.reshape(b5, t5, m.channels, H_orig, W_orig).movedim(1, 2)
    return out


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


class Krea2IdentityOptionalAppleModelLoader:
    @classmethod
    def INPUT_TYPES(cls):
        models = folder_paths.get_filename_list("diffusion_models")
        return {
            "required": {
                "regular_model": (models, {"default": REGULAR_CONVROT_MODEL}),
                "identity_model": (models, {"default": IDENTITY_CONVROT_MODEL}),
            },
            "optional": {"image": ("IMAGE",)},
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load"
    CATEGORY = "Hivemind/Krea2"

    def load(self, regular_model, identity_model, image=None):
        model_name = identity_model if image is not None else regular_model
        loader = _node_class("OTUNetLoaderW8A8")()
        return loader.load_unet(
            unet_name=model_name,
            weight_dtype="default",
            model_type="krea2",
            on_the_fly_quantization=False,
            enable_convrot=True,
            lora_mode="None",
        )


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
            "optional": {
                "image": ("IMAGE",),
                # Off by default: the cached forward diverges from the official
                # Krea2EditModelPatch on the very first step (same seed, 1-step
                # pixel diff max=162) and compounds into visible grain by step 10
                # (mean |laplacian| 18.5-30.3 vs 3.0-3.6 official, 2026-07-22 A/B).
                "cache_static_tokens": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "Hivemind/Krea2"

    def patch(
        self,
        model,
        vae,
        ref_boost=4.0,
        fit_mode="fit",
        image=None,
        cache_static_tokens=False,
    ):
        if image is None:
            return (model,)
        source_latent = {"samples": vae.encode(_bootstrap_vae_image(image))}
        if not cache_static_tokens:
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

        official = _official_module()
        patched_model = model.clone()
        model_wrapper = model.model
        source_samples = model_wrapper.process_latent_in(source_latent["samples"])
        pixel_cache = {}
        processed_pixel_cache = {}
        static_cache = {}

        if fit_mode == "fit" and (vae is None or image is None):
            print(
                "[krea2edit] WARNING: fit_mode='fit' needs both vae and source image; "
                "falling back to the latent crop path.",
                flush=True,
            )

        def wrapper(
            executor,
            x,
            timesteps,
            context,
            attention_mask=None,
            transformer_options={},
            **kwargs,
        ):
            diffusion_model = executor.class_obj
            source = source_samples
            if vae is not None and image is not None:
                source_x = official._to_4d(x)
                target_h, target_w = source_x.shape[-2:]
                cache_key = (target_h, target_w, fit_mode)
                if cache_key not in processed_pixel_cache:
                    if not pixel_cache:
                        print(
                            f"[krea2edit] pixel path ACTIVE (fit_mode={fit_mode})",
                            flush=True,
                        )
                    encoded = official._fit_encode_image(
                        image,
                        vae,
                        target_h,
                        target_w,
                        pixel_cache,
                        ("a", target_h, target_w),
                        fit_mode,
                    )
                    processed_pixel_cache[cache_key] = model_wrapper.process_latent_in(encoded)
                source = processed_pixel_cache[cache_key]
            return _krea2_edit_forward_cached(
                diffusion_model,
                x,
                timesteps,
                context,
                source,
                transformer_options,
                static_cache,
                ref_boost=float(ref_boost),
                ref_boost_a=1.0,
                ref_native=(fit_mode == "fit" and vae is not None and image is not None),
                pos_mode="stride1" if fit_mode == "fit" else "anchor",
            )

        transformer_options = patched_model.model_options.setdefault("transformer_options", {})
        comfy.patcher_extension.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL,
            "krea2_edit",
            wrapper,
            transformer_options,
        )
        return (patched_model,)


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
    "Krea2IdentityOptionalAppleModelLoader": Krea2IdentityOptionalAppleModelLoader,
    "Krea2IdentityOptionalLoraModel": Krea2IdentityOptionalLoraModel,
    "Krea2IdentityOptionalModelPatch": Krea2IdentityOptionalModelPatch,
    "Krea2IdentityOptionalEncode": Krea2IdentityOptionalEncode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "HivemindOptionalLoadImage": "Optional Reference Image",
    "Krea2IdentityOptionalPreLora": "Krea2 Identity Optional Pre-LoRA",
    "Krea2IdentityOptionalAppleModelLoader": "Krea2 Identity Optional Fast Model",
    "Krea2IdentityOptionalLoraModel": "Krea2 Identity Optional Model LoRA",
    "Krea2IdentityOptionalModelPatch": "Krea2 Identity Optional Source Patch",
    "Krea2IdentityOptionalEncode": "Krea2 Identity Optional Encode",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
