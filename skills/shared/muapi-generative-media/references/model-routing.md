# MUAPI Model Routing

Do not assume a model's request shape from its name. Discover the live command help or schema, then build the payload.

## Discovery Order

1. Use `muapi-cli` when installed:
   ```bash
   hive-env-run -- sh -c 'export MUAPI_KEY="${MUAPI_KEY:-$MUAPI_API_KEY}"; muapi --help'
   hive-env-run -- sh -c 'export MUAPI_KEY="${MUAPI_KEY:-$MUAPI_API_KEY}"; muapi image --help'
   hive-env-run -- sh -c 'export MUAPI_KEY="${MUAPI_KEY:-$MUAPI_API_KEY}"; muapi workflow --help'
   ```
2. If using the `SamurAIGPT/Generative-Media-Skills` schema locally, query it:
   ```bash
   python3 scripts/muapi_general.py models --schema /path/to/schema_data.json --query seedance --limit 20
   python3 scripts/muapi_general.py schema --schema /path/to/schema_data.json --name seedance-v2.0-t2v
   ```
3. If neither is available, submit only after checking MUAPI docs, CLI help, or a known local payload from a recent successful run.

## Categories Confirmed From Referenced Schema

The referenced schema snapshot contained 267 entries across these categories:

- Text to Image
- Image to Image
- Text to Video
- Image to Video
- Video to Video
- Audio to Video
- Text to Audio
- Text to Text
- Training

Treat these as a catalog map, not a permanent endpoint contract.

## Useful Model Families

Text-to-image:

- `flux-dev`, `flux-schnell`, `flux-2-dev`, `flux-2-pro`
- `hidream-i1-fast`, `hidream-i1-dev`, `hidream-i1-full`
- `midjourney-v7-text-to-image`
- `gpt-image-1.5`, `gpt4o-text-to-image`
- `google-imagen4`, `google-imagen4-fast`, `google-imagen4-ultra`
- `nano-banana`, `nano-banana-pro`

Image-to-image and edit:

- `flux-kontext-pro-i2i`, `flux-kontext-max-i2i`
- `gpt-image-1.5-edit`, `gpt4o-edit`
- `qwen-image-edit`, `qwen-image-edit-plus`
- `nano-banana-edit`, `nano-banana-pro-edit`
- `ai-background-remover`, `ai-image-upscaler`, `topaz-image-upscale`
- `ai-product-shot`, `ai-product-photography`
- `ai-object-eraser`, `ai-image-extension`, `ai-dress-change`

Text-to-video:

- `seedance-v2.0-t2v`, `seedance-pro-t2v`, `seedance-lite-t2v`
- `kling-v3.0-pro-text-to-video`, `kling-v3.0-standard-text-to-video`
- `veo3.1-text-to-video`, `veo3.1-fast-text-to-video`, `veo3.1-4k-video`
- `openai-sora-2-text-to-video`, `openai-sora-2-pro-text-to-video`
- `wan2.6-text-to-video`, `pixverse-v5.5-t2v`, `minimax-hailuo-2.3-pro-t2v`

Image-to-video:

- `seedance-pro-i2v`, `seedance-v1.5-pro-i2v`, `seedance-lite-i2v`
- `kling-v2.6-pro-i2v`, `kling-o1-image-to-video`, `kling-o1-reference-to-video`
- `veo3.1-image-to-video`, `veo3.1-reference-to-video`
- `vidu-q2-reference`, `vidu-q2-pro-start-end-video`
- `ltx-2-pro-image-to-video`, `runway-image-to-video`

Video-to-video and effects:

- `video-effects`, `ai-video-effects`, `image-effects`
- `ai-video-face-swap`, `ai-dance-effects`
- `luma-modify-video`, `luma-flash-reframe`
- `kling-o1-video-edit`, `wan2.2-edit-video`, `remix-video`
- `ai-video-upscaler`, `topaz-video-upscale`
- `ai-clipping`

Audio-to-video / lip-sync:

- `sync-lipsync`
- `latent-sync`
- `creatify-lipsync`
- `veed-lipsync`
- `ltx-2-19b-lipsync`
- `kling-v1-avatar-standard`, `kling-v2-avatar-pro`

Text-to-audio and music:

- `suno-create-music`, `suno-remix-music`, `suno-extend-music`
- `mmaudio-v2-text-to-audio`, `mmaudio-v2-video-to-video`
- `minimax-speech-2.6-hd`, `minimax-speech-2.6-turbo`, `minimax-voice-clone`

## Selection Rules

- For expensive final media, generate a cheap draft or still first.
- For exact person identity and repeated shots, use `muapi-seedance-video` or a model with explicit reference/character support rather than plain text-to-video.
- For exact spoken words, generate and approve the audio first, then lip-sync or pass audio into a model that supports it.
- For output framing, prefer the model's `aspect_ratio` enum when present. Do not force width/height on video endpoints unless the schema requires it.
- For product, UI, logo, and typography-heavy images, favor image models/editors known to preserve structure, and preview text carefully.
- For multi-output jobs, inspect all result URLs before choosing what to present.
