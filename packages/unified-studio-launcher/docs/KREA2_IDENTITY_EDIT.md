# Krea 2 Turbo Identity Edit

## What is installed

The unified studio exposes `conradlocke/krea2-identity-edit` v1.2 through one image backend:

`comfy-krea2-turbo-identity-edit`

The reference image is optional.

- No image: the API compiler emits the literal regular Krea 2 Turbo graph.
- Image supplied: the same Turbo lane adds the full identity LoRA, the official VAE source-token patch, and image-grounded Qwen3-VL conditioning.

Pinned dependencies:

- Model: [`conradlocke/krea2-identity-edit`](https://huggingface.co/conradlocke/krea2-identity-edit), revision `29f4b0b96bf01bf3de7c9f1313ca3337538ca247`
- Full v1.2 weight: `krea2_identity_edit_v1_2.safetensors`, SHA-256 `6adf9a69cc9502d286db7b69964d37da7e9cfe4b05b4d004bc275f087d3fd3cf`
- Official nodes: [`lbouaraba/comfyui-krea2edit`](https://github.com/lbouaraba/comfyui-krea2edit), commit `b5d3c2f3485ea9990ca8190b930a209c9f6d5e39`

The full-rank 1.83GB weight is intentional. Rank-reduced alternatives were not substituted because this lane is quality-first.

## Setup

From the repository root:

```bash
hive-env-run -- python3 scripts/install_krea2_identity.py --comfy-dir ~/comfy/ComfyUI
~/.local/bin/zimage-stack restart
```

The installer pins the official node checkout, verifies the model size and SHA-256, links or copies the project adapter, and installs the API/editor workflows. The model is public; a configured Hugging Face token is used when available but is not written to the project.

Installed editor workflow:

`Krea2 Turbo Identity Optional Apple Silicon.json`

Leave **Optional Reference Image** at `None` for regular Turbo. Select or upload an image to activate identity edit.

## MCP

Call `media_generate_image`:

```json
{
  "backend": "comfy-krea2-turbo-identity-edit",
  "prompt": "Restage the same adult person in a cinematic cafe portrait while preserving exact facial identity.",
  "image_base64": "data:image/png;base64,...",
  "width": 768,
  "height": 768,
  "steps": 10,
  "cfg": 1,
  "seed": 621904,
  "ref_boost": 4,
  "identity_strength": 1,
  "grounding_px": 768,
  "wait": true,
  "timeout_s": 300
}
```

`image_base64` accepts bare base64 or a `data:image/...;base64,...` URL. It wins over `image_path`; `image_url` also remains supported by the MCP staging layer. Omit all three image fields to run unchanged regular Krea 2 Turbo.

The shared Python MCP client now sets its HTTP read timeout to `timeout_s + 30` when `wait=true`, so long image jobs do not fail at the old fixed 30-second transport timeout.

## Direct API

POST JSON to `/api/generate` with bearer authentication:

```json
{
  "backend": "comfy-krea2-turbo-identity-edit",
  "prompt": "Preserve the same adult person's identity and move them into a softly lit studio portrait.",
  "image_base64": "data:image/jpeg;base64,...",
  "width": 768,
  "height": 768,
  "steps": 10,
  "cfg": 1,
  "ref_boost": 4,
  "identity_strength": 1,
  "grounding_px": 768
}
```

Direct JSON bodies support up to 25MB. The decoded image limit is 20MB. Raw base64 and image data URLs are accepted and staged into the private Comfy input directory. Multipart `image` uploads and private `image_path` inputs continue to work.

Poll `/api/job/{id}` until `status` is `success` or `error`.

## Runtime paths

Apple Silicon uses the established quality-preserving lane:

`full identity LoRA -> krea2_turbo_bf16 -> on-the-fly ConvRot INT8 -> euler_ancestral/beta`

The LoRA is applied before quantization. Applying runtime LoRAs to the already quantized ConvRot checkpoint previously produced blotchy artifacts.

CUDA/Windows uses the portable Comfy path:

`krea2_turbo_fp8_scaled -> optional model-LoRA gate -> official source patch`

Without an image, CUDA/Windows bypasses the identity LoRA and source patch and runs regular Turbo. Override the portable model filename with `KREA2_TURBO_PORTABLE_MODEL` when a local installation uses a different official Krea 2 Turbo checkpoint name.

## Recommended controls

- `steps=10`, `cfg=1`: balanced Turbo default from the model workflow.
- `steps=8`: stronger composition/instruction adherence.
- `steps=12`: potentially more face detail.
- `ref_boost=4`: recommended identity fidelity.
- `identity_strength=1`: trained LoRA strength.
- `grounding_px=768`: top of the trained 384-768 vision-grounding range.
- Inputs around 1MP are the upstream sweet spot.

## Benchmarks

Measured on this M5 Apple Silicon studio through the supervised Comfy lane:

| Route | Settings | State | Comfy/gateway time |
| --- | --- | --- | ---: |
| Regular Turbo | 528x368, 8 steps | warm | 19.85s |
| Optional workflow, no image | 528x368, 8 steps | warm control before exact fallback compiler | 21.52s |
| Regular Turbo | 768x768, 10 steps | warm | 26.74s |
| Identity edit | 768x768, 10 steps | cold model/LoRA bake | 82.81s |
| Identity edit | 768x768, 10 steps | warm, new seed | 60.62s |
| Identity edit through MCP inline base64 | 384x384, 8 steps | warm model | 42.04s gateway elapsed |

The 528x368 no-image control and regular workflow produced byte-for-byte identical decrypted PNGs at the same seed. The API compiler was then tightened further: no-image requests now emit the exact regular graph, eliminating adapter-specific cache switching rather than merely approximating the regular path.

Identity edit is slower because the diffusion model attends over reference-image source tokens at every denoise step, in addition to Qwen3-VL grounding and VAE work. No step reduction, lower-rank LoRA, smaller source-token representation, or lower-quality model was used to hide this cost.

## Apple MPS finding

The first 768 test used a 1536x2048 reference and failed before denoising with:

`MPSGaph does not support tensor dims larger than INT_MAX`

The upstream node initially VAE-encoded the full 3.1MP source even though its FIT pixel path later resizes the source to the target grid. The project adapter now caps only that required bootstrap/fallback latent to about 1MP. The official FIT path still receives the untouched original image and performs its own target-resolution pixel encode, so the successful output retains the full reference-fidelity path.

Verified quality output:

`krea2_identity_v12_cafe_768_00001_.png` (private encrypted output storage)

Prompt used:

> Restage the same adult woman in a candid cinematic photograph at a quiet modern cafe beside a tall window. She wears an elegant charcoal blazer over a white top and looks toward the camera with a subtle natural smile. Preserve her exact facial identity, distinctive eye shape, short black bob haircut, facial proportions, and natural skin texture. Soft directional afternoon light, realistic photography, shallow depth of field.
