---
name: muapi-generative-media
description: Generate, edit, upload, poll, download, and QA images, videos, audio, music, lip-sync, clipping, upscaling, effects, and workflows through MUAPI. Use when the user says MUAPI, muapi.ai, muapi-cli, asks for a general MUAPI media skill, or wants access to the full MUAPI model catalog. Route Seedance identity/lip-sync shots to muapi-seedance-video when that narrower skill fits.
---

# MUAPI Generative Media

Use this as the general MUAPI operator skill. It covers the common pattern across the MUAPI catalog: discover the model schema, upload local assets, submit a payload, poll the async request, download outputs, and QA the generated media.

This skill is intentionally broader than `muapi-seedance-video`. When the user needs Seedance 2.0 identity consistency, character sheets, omni-reference, or exact talking-head lip sync, load `muapi-seedance-video` and `video-lipsync-tts` after this skill.

## Preconditions

1. Check credentials by key name only:
   ```bash
   hive-env-check MUAPI_API_KEY || hive-env-check MUAPI_KEY
   ```
2. Run MUAPI commands through the shared env. The upstream `muapi-cli` expects `MUAPI_KEY`, while this HivemindOS setup often stores `MUAPI_API_KEY`; map either name at runtime:
   ```bash
   hive-env-run -- sh -c 'export MUAPI_KEY="${MUAPI_KEY:-$MUAPI_API_KEY}"; muapi --help'
   ```
3. Never print, paste, log, or write the API key. Save request IDs, uploaded media URLs, prompts, payload files, result JSON, and local output paths.
4. Prefer `muapi-cli` when it is already installed and exposes the needed operation. If it is missing, use `scripts/muapi_general.py` instead of blocking on a global install. Install `muapi-cli` only when the user asks for the CLI path or the workflow truly needs it.
5. Do not use this skill for direct Higgsfield Cloud requests. Use `higgsfield-generate` and `higgsfield-api-quirks` for the Higgsfield platform API.

## Operating Workflow

1. Create a run folder:
   ```text
   /private/tmp/<project>-muapi/
   refs/
   audio/
   payloads/
   results/
   outputs/
   qa/
   state.json
   ```
2. Clarify the target category: text-to-image, image-to-image, text-to-video, image-to-video, video-to-video, audio-to-video/lip-sync, text-to-audio/music, training, clipping, or workflow.
3. Discover the live command/schema before assuming payload fields. If `muapi-cli` is not installed, skip the CLI probes and use a current schema/docs source plus the helper:
   ```bash
   hive-env-run -- sh -c 'export MUAPI_KEY="${MUAPI_KEY:-$MUAPI_API_KEY}"; muapi --help'
   hive-env-run -- sh -c 'export MUAPI_KEY="${MUAPI_KEY:-$MUAPI_API_KEY}"; muapi workflow --help'
   ```
4. Upload local files that the endpoint needs. Reuse URLs from `state.json` when regenerating.
5. Build a JSON payload that matches the selected endpoint schema. Keep prompts, model IDs, durations, aspect ratios, and media URLs in versioned payload files.
6. Submit and poll. Save both the submit response and completed result JSON.
7. Download outputs with descriptive versioned names.
8. QA the media through the actual user path: image preview for images, `ffprobe` plus `video-render-qa` for videos, and listen/inspect waveform for audio.

## Model Routing

Use `references/model-routing.md` before picking a model. As a quick default:

| Intent | Start Here | Notes |
|---|---|---|
| Draft image | `flux-dev`, `hidream-i1-fast`, `flux-schnell` | Fast iteration and prompt testing. |
| Polished image | `flux-2-pro`, `google-imagen4`, `midjourney-v7-text-to-image`, `gpt-image-1.5` | Confirm availability and schema first. |
| Prompt-based image edit | `flux-kontext-pro-i2i`, `nano-banana-pro-edit`, `qwen-image-edit-plus` | Use uploaded source URLs in `images_list` or `image_url` as required. |
| Text-to-video | `seedance-v2.0-t2v`, `kling-v3.0-pro-text-to-video`, `veo3.1-text-to-video`, `openai-sora-2-text-to-video` | Use the schema's accepted `duration`, `quality`, and `aspect_ratio`. |
| Image-to-video | `seedance-pro-i2v`, `kling-v2.6-pro-i2v`, `veo3.1-image-to-video`, `vidu-q2-reference` | Keep source image composition close to desired framing. |
| Lip-sync existing video | `sync-lipsync`, `latent-sync`, `veed-lipsync`, `ltx-2-19b-lipsync` | Generate and approve line audio first with `video-lipsync-tts`. |
| Effects / video edit | `video-effects`, `ai-video-effects`, `luma-modify-video`, `kling-o1-video-edit` | Verify source/output frame rate before concatenation. |
| Music / audio | `suno-create-music`, `mmaudio-v2-text-to-audio`, `mmaudio-v2-video-to-video` | Suno prompt may be treated as lyrics; check schema before submitting. |
| Shorts extraction | `ai-clipping` | Good for long video to ranked vertical clips. |

## Helper Script

Use the bundled stdlib-only helper for direct API runs:

```bash
cd /Users/liam/Documents/Obsidian/hivemindos-vault/Skills/muapi-generative-media

hive-env-run -- python3 scripts/muapi_general.py upload refs/source.png --state state.json

hive-env-run -- python3 scripts/muapi_general.py submit \
  --endpoint flux-dev-image \
  --payload payloads/image_v01.json \
  --state state.json \
  --wait \
  --download outputs/image_v01.png

hive-env-run -- python3 scripts/muapi_general.py result <request_id> \
  --wait \
  --download outputs/result.mp4
```

The helper accepts `MUAPI_API_KEY` or `MUAPI_KEY`, uses `x-api-key`, and saves state without storing secrets.

## Coordination With Other Skills

- Use `muapi-seedance-video` for Seedance 2.0/2 Mini, character-sheet identity, omni-reference, and exact social-video replacement shots.
- Use `video-lipsync-tts` before any lip-sync or talking-head generation where the line must be exact.
- Use `generated-short-assembly-qa` when assembling multiple generated clips into a final short.
- Use `video-render-qa` before delivery of any generated or assembled video.
- Use `media-cache-hygiene` when reusing large generated media caches or cleaning stale output folders.

## References

- `references/operations.md` for direct API and CLI operating patterns.
- `references/model-routing.md` for model categories, discovery, and source schema notes.
- `references/qa-and-chaining.md` for validation, downloads, handoff, and final assembly checks.
