# LTX 2.3 Workflows and MCP Operator Guide

Last verified: 2026-07-17

This document explains the LTX 2.3 video workflows currently registered in Media Studio, how requests move through the Apple Silicon MLX and Windows/CUDA ComfyUI routes, how frame anchors and audio work, and how to perform the complete generation lifecycle through the Media Studio MCP.

Treat this file as the canonical operator contract. The optimization log records historical experiments and points back here; it is not a second API or capability specification.

The implementation sources of truth are:

- `packages/media-gateway/bin/media-studio-mcp.mjs`: MCP tools, schemas, image staging, workflow selection, and response normalization.
- `packages/media-gateway/workflow-registry.json`: non-Eros LTX workflow definitions, defaults, LoRAs, graph slots, and model dependencies.
- `packages/media-gateway/app.py`: Apple Silicon prompt interception, native MLX runners, ComfyUI fallback, jobs, history, and output serving.
- `scripts/hivemind-studio-stack`: service lifecycle, hardware profile, Tailscale proxy, ComfyUI lanes, and ports.
- `packages/unified-studio-launcher/docs/LTX23_EROS_OPTIMIZATION_LOG.md`: benchmark history, rejected optimizations, quality findings, and reproducible test artifacts.

## Current service endpoints

The live service on this Mac currently exposes:

| Surface | URL | Purpose |
| --- | --- | --- |
| Local MCP | `http://127.0.0.1:8796/mcp` | MCP from this Mac |
| Tailnet MCP | `https://liams-macbook-pro-1.tail629894.ts.net:8789/mcp` | MCP from other Tailscale machines |
| Tailnet Studio | `https://liams-macbook-pro-1.tail629894.ts.net:8789/app/` | Browser Studio |
| Tailnet ComfyUI Mobile | `https://liams-macbook-pro-1.tail629894.ts.net:8789/mobile/` | Mobile workflow editor and output browser |
| Local backend | `http://127.0.0.1:8787` | Private generation API behind the MCP |
| Local ComfyUI | `http://127.0.0.1:8188` | Default ComfyUI runtime |
| Dedicated Apple LTX lane | `http://127.0.0.1:8199` | MPS ComfyUI fallback lane |

The token is stored on the server Mac at:

```text
~/.hivemindos/media-studio/secure/zimg-token
```

Use it as either `Authorization: Bearer <token>` or `X-Token: <token>`. Do not commit it or place it in documentation. Output URLs returned with `include_urls: true` contain the token in their query string and must also be treated as private.

The HTTP MCP JSON body limit is 25 MiB. Base64 expands binary input by roughly one third. Inline video is therefore capped at 18 MiB; use `video_url` or a server-local `video_path` for larger clips. Images retain their separate 50 MiB decoded-file cap, but the combined JSON request must still fit inside 25 MiB.

## Architecture and routing

```text
MCP client
  -> local :8796/mcp or Tailscale HTTPS :8789/mcp
    -> Media Studio MCP
      -> load registered workflow and inject prompt/settings/images
      -> stage remote images in ~/.comfy-private.noindex/input
      -> POST the API-format graph to /comfy/api/prompt
        -> Media Studio gateway inspects the graph
          -> Apple Silicon + native marker: run ltx-2-mlx directly
          -> Windows/CUDA/other: forward the original graph to ComfyUI
      -> write redacted job history
      -> serve output through a token-protected Studio URL
```

### Apple Silicon route

On an Apple Silicon hardware profile, registered LTX graphs carry a private native marker. The gateway intercepts the prompt before ComfyUI executes it and launches:

```text
uv run ltx-2-mlx generate --distilled ...
```

The native route currently uses:

- Quantized MLX model variants selected by the workflow.
- Gemma 3 12B 4-bit text encoding.
- Distilled two-stage generation: half-resolution denoising, latent upscale, and distilled refinement.
- Native LoRA fusion for Transition, Better Motion, and IC Dual Character workflows.
- Native multi-image conditioning with frame indices and strengths.
- Native source-video extension through `ltx-2-mlx extend --distilled`. Fast, Exact, and Regular each retain the same distilled transformer they use for ordinary generation; source video and audio are encoded as temporal context rather than reduced to a still frame.
- The official fixed eight-step distilled retake schedule for Apple source-video continuation. CFG, STG, and negative conditioning are intentionally absent in this mode, matching distilled generation semantics.
- Joint video and audio decoding followed by MP4 muxing.
- Automatic ComfyUI model unloading before LTX to release unified memory.
- Output mirroring into the private Comfy output tree so Studio and ComfyUI Mobile can discover it.

The native route does not lower the configured resolution, frame count, or sampler passes to gain speed. It uses the optimized MLX model and execution path while preserving the workflow's authored generation settings.

### Windows, CUDA, and other non-MLX routes

On a non-Apple profile, the native marker is ignored and the same API-format workflow is forwarded to ComfyUI. The MCP contract, workflow IDs, job polling, and output retrieval remain the same. CUDA, Python, model, and process differences stay behind the ComfyUI adapter.

Anchor behavior has one source of truth. The MCP first normalizes start, middle, end, and explicit `keyframes` into one ordered keyframe list. Apple MLX consumes that list as repeated native image conditions. The Comfy/CUDA compiler consumes the same list by:

- Loading and resizing every anchor through the workflow's shared image preprocessing.
- Inserting every anchor, frame index, and strength into both `LTXVImgToVideoInplaceKJ` passes.
- Chaining one `LTXVAddGuide` condition per anchor for first-pass LTX conditioning.
- Keeping the primary likeness anchor aligned with the first normalized keyframe.

This is request-level feature parity for start, middle, end, and arbitrary frame/time anchors across MLX and Comfy/CUDA. The current shared maximum is 20 image anchors, matching the installed Comfy LTX dynamic-node capacity. Regression coverage executes the real HTTP MCP entry path against both the regular and Eros builders and verifies identical normalized frame lists in native metadata and the generated Comfy graph.

Source-video extension follows the same rule. The MCP normalizes `video_base64`, `video_url`, or `video_path` into one private Comfy input. Apple Silicon runs the MLX distilled `extend` pipeline with the selected workflow's own model. Windows/CUDA and other non-MLX hosts compile a two-pass Comfy graph from the selected workflow:

1. `VHS_LoadVideo -> VAEEncode -> LTXVExtendSampler` appends the requested video frames with a 16-frame overlap.
2. The source audio is loaded with the video, mixed with a silence fallback for clips without an audio stream, and encoded with `LTXVAudioVAEEncode`.
3. `LTXVEmptyLatentAudio` adds the requested continuation duration. The completed video and combined audio are joined as an AV latent.
4. `LTXVSetAudioVideoMaskByTime` freezes every video token and every source-audio token while marking only the appended audio interval for generation.
5. The selected workflow's existing refinement model, CFG guider, sampler, and sigma schedule generate that audio interval with video-to-audio cross-attention. The generated video and extended audio are decoded and muxed into one MP4.

Both routes preserve the source clip and append the requested duration. Audio behavior depends on the actual input stream: a source with audio returns `audio_mode: "extend"`, preserves that soundtrack, and generates only the appended interval; a mute source returns `audio_mode: "generate"` and generates synchronized audio across the complete output timeline. On MLX, mute input is represented by audio-VAE-encoded PCM silence for correct latent sizing, then the full audio mask is denoised. Never use an unconditioned all-zero audio latent as preserved silence: it decodes into periodic noise. Source dimensions are retained rather than replaced by image-generation width/height controls. The current cross-platform direction is append/after. Fast, Exact, and Regular are configured out of the box on Apple Silicon; no separate dev-model environment variable is required.

Frame units are explicit. `extension_output_frames` is the number of appended video frames. `extension_latent_frames` is the MLX VAE's internal temporal representation, where one latent frame represents eight output frames. For example, four seconds at 24 fps is 96 output frames and 12 latent frames. A client must use the output-frame count and duration when validating the result; 12 latent frames does not mean a 12-frame clip.

The installer applies two platform-neutral `ComfyUI-LTXVideo` compatibility patches on Windows, Linux/CUDA, and macOS: absent noise masks remain absent instead of becoming null mask entries, and overlap blending aligns offloaded latent devices while retaining integer `batch_index` values. The MPS-only LoRA bypass remains Darwin-only. Lightricks' documented Comfy runtime target is a CUDA GPU with at least 32 GB VRAM; Apple Silicon uses the native MLX route in this Studio.

For the two Eros IDs, Apple Silicon selects distinct MLX model variants. The current non-MLX fallback uses the installed Eros Comfy graph, so the Fast versus Exact distinction is primarily meaningful on the native route.

### Core parity versus model-specific LoRAs

| Capability | Eros Fast | Eros Exact | Regular LTX 2.3 |
| --- | --- | --- | --- |
| Start image by path, URL, or base64 | Yes | Yes | Yes |
| Middle/end/arbitrary image anchors | Yes | Yes | Yes |
| Source video and audio continuation | Yes, matching distilled model | Yes, matching distilled model | Yes, matching distilled model |
| Requested append duration and frame-rate normalization | Yes | Yes | Yes |
| Native MLX on Apple and Comfy fallback on Windows/CUDA | Yes | Yes | Yes |
| Real denoise progress and explicit output/latent frame units | Yes | Yes | Yes |

This parity applies to shared generation controls and transports. Transition, Better Motion, Dual Character, and Ingredients are separate regular-family workflows because those LoRAs target the regular LTX 2.3 base or require a specialized IC-LoRA conditioning topology. They are not automatically injected into Eros Fast/Exact: doing so without a compatible model card and validation could change quality or fail outright. A specialized LoRA should receive an Eros workflow only after its compatibility is confirmed, not merely to make the workflow list look symmetrical.

## Registered LTX workflows

Call `media_list_workflows` at runtime instead of hard-coding this list forever. As of the verification date, six video workflows are available.

### `ltx23-eros-fast`

- Default workflow when `workflow_id` is omitted.
- Aliases: `default`, `video`, `fast`, `ltx`, `ltx-eros`, `ltx23-eros`.
- Apple model: MLXBits 10Eros v1.2 q8 distilled.
- Intended use: fast Eros-tuned image-to-video.
- Defaults: `480x832`, `233` frames, `24` fps, seed `42`.
- Measured reference: `193.11s` for the full 233-frame, approximately 9.7-second benchmark on this Mac.
- Use `frames`; this built-in workflow does not map `duration_seconds`.
- Does not expose a registered negative-prompt slot through the Eros builder.

### `ltx23-eros-exact`

- Alias: `exact`.
- Apple model: Exact-v1 bf16 LoRA merged q8 distilled.
- Intended use: the exact merged Eros model when model fidelity is preferred over the faster Eros variant.
- Defaults: `480x832`, `233` frames, `24` fps, seed `42`.
- Measured reference: `247.44s` for the same full benchmark on this Mac.
- Uses the same MCP fields and built-in Eros graph shape as Eros Fast.

### `ltx23-regular-fp8`

- Official regular LTX 2.3 image-to-video family rather than the Eros fine-tune.
- Aliases: `fastregular`, `fast-regular`, `regular-fast`, `regular`.
- Apple model: local regular q8 distilled subset through MLX.
- Comfy model: official `ltx-2.3-22b-dev-fp8.safetensors` graph.
- Intended use: general image-to-video, cross-platform start/end/multi-anchor work, and the neutral control for LoRA comparisons.
- Defaults: `480x832`, `24` fps, seed `42`; native effective frame default is `233` when neither frames nor duration is supplied.
- Supports `negative_prompt`, `duration_seconds`, `frames`, and `params.cfg`.
- For Apple source-video extension, the eight-step distilled lane is positive-only. `negative_prompt`, CFG, and STG are not consumed in that mode. Phrase continuity and exposure requirements affirmatively in `prompt`; do not mention unwanted concepts such as fading or darkness in the positive text, even as `no fade` or `no darkness`.
- `fast` by itself remains the Eros Fast alias. Use the canonical `ltx23-regular-fp8` ID when an agent must be unambiguous.

### `ltx23-transition-lora`

- Aliases: `transition`, `ltx-transition`, `ltx23-transition`.
- Base: regular LTX 2.3 q8 distilled on Apple, official FP8 graph on Comfy.
- LoRA: `joyfox/LTX-2.3-Transition-LORA`.
- Intended use: authored first-frame to last-frame transitions.
- Recommended LoRA strength: `1.0`.
- Recommended CFG: `4.0`.
- Trigger: `zhuanchang`; automatically appended by default.
- Best request shape: start image plus end image, with a prompt describing the physical path between them.

### `ltx23-better-motion-lora`

- Aliases: `motion`, `better-motion`, `ltx-motion`, `ltx23-motion`.
- LoRA: Better Motion LTX 2.3 T2V/I2V.
- Native LoRA strength: `0.3`.
- Intended use: stronger subject and camera motion while retaining the regular LTX image-to-video workflow.
- Supports the same shared MLX and Comfy/CUDA multi-anchor contract as regular LTX.

### `ltx23-ic-dual-character-lora`

- Aliases: `ic`, `ic-lora`, `dual`, `dual-character`, `ic-dual-character`, `ltx23-ic`.
- LoRA: MaqueAI LTX 2.3 IC Dual Character.
- Native LoRA strength: `0.8`.
- Intended use: storyboarded two-person dialogue coverage, including a two-shot, over-the-shoulder close-up on Character A, and reverse close-up on Character B while preserving identities across angle changes.
- Defaults: `1024x576`, `10s`, `24` fps, CFG `1.0`, seed `42`.
- Recommended prompt style: name both characters, repeat durable visual identifiers, assign explicit shot timing, state camera direction, and demand coherent eyelines and wardrobe continuity.
- A single seed did not show a dramatic quality advantage over the regular base control. Treat the LoRA as a specialized prior, not a guarantee.

## Core capabilities and constraints

### Video mode

Registered LTX workflows accept either image conditioning or a source video. Supplying any video source takes precedence over image fields and selects `video_mode: "extend"`. The source clip remains at the beginning of the result and LTX generates a temporally conditioned continuation. Without a video source, the existing image-anchor behavior is unchanged.

In Explore, select a local LTX workflow and use the video upload button. The duration control becomes extension duration, aspect-ratio controls are hidden because the source dimensions are preserved, and Generate submits the clip through the same Content API and MCP contract described below.

### Video source precedence

For source-video extension, precedence is:

1. `video_base64`
2. `video_url`
3. `video_path`

`video_base64` accepts raw base64 or a `data:video/...;base64,...` data URL. Supported containers are MP4, MOV, WebM, MKV, AVI, and M4V. Remote clients cannot use paths from their own filesystem; use inline base64 or a URL reachable by the server. The current API supports append extension, not arbitrary interior retake.

### Image source precedence

For the start, middle, end, or an explicit keyframe, source precedence is:

1. `image_base64`
2. `image_url`
3. `image_path`
4. Workflow default image, where applicable

`image_base64` accepts either raw base64 or a `data:image/...;base64,...` URL. A data URL is preferred because it preserves the MIME type. `image_url` must be HTTP(S) and reachable from the server Mac. `image_path` is resolved on the server Mac, not the MCP client's filesystem.

Remote clients should use base64 or a server-fetchable URL. Never send a path such as `/Users/me/Desktop/start.png` from another machine and expect the server to see that file.

### Start, middle, end, and arbitrary anchors

Convenience fields:

- `image_base64`, `image_url`, or `image_path`: frame zero.
- `middle_image_base64`, `middle_image_url`, or `middle_image_path`: midpoint.
- `end_image_base64`, `end_image_url`, or `end_image_path`: final frame.

For full control, use `keyframes` items with:

- One image source.
- `frame`, `frame_idx`, or `time_seconds`.
- Optional `role`: `start`, `middle`, or `end`.
- Optional `strength` from `0.0` to `1.0`, default `1.0`.

When no explicit frame/time is supplied, roles map to frame `0`, `floor((frames - 1) / 2)`, and `frames - 1`. Two anchors targeting the same frame are de-duplicated, with the later explicit anchor winning.

The combined request may contain at most 20 unique anchor frames. This limit is applied before either backend is selected, so Apple MLX and Comfy/CUDA accept the same request surface.

Use anchors sparingly. A start frame defines appearance and initial geometry. A middle frame is useful for a required intermediate composition. An end frame is useful for a required final pose or product plate. Incompatible anchors force the model to solve an impossible motion path and can increase morphing.

### Duration, frames, and frame rate

The MCP accepts:

- `duration_seconds`: `0.1` to `30`, for registry workflows that expose it.
- `frames`: `9` to `721`.
- `frame_rate`: `1` to `120`.

On native MLX, frame counts are normalized to the nearest valid `8n + 1` count. For example:

- `41` frames at 24 fps places the final anchor at 1.667 seconds.
- `73` frames at 24 fps places the final anchor at 3 seconds.
- `121` frames at 24 fps places the final anchor at 5 seconds.
- `233` frames at 24 fps places the final anchor at 9.667 seconds and produces an approximately 9.7-second file.
- `241` frames at 24 fps places the final anchor at 10 seconds and produces an approximately 10.04-second file.

For regular-family workflows, `duration_seconds` is converted to approximately `round(duration * fps) + 1` frames and then normalized. For Eros Fast and Eros Exact, set `frames` directly.

In video-extension mode, duration is always converted independently of the source length. The normalized append count is `ceil(duration_seconds * frame_rate / 8) * 8` output frames. Apple MLX divides that value by eight only at the final CLI boundary because `ltx-2-mlx extend --extend-frames` accepts latent frames. Comfy/CUDA receives the full output-frame value in `LTXVExtendSampler.num_new_frames`.

Source clips whose frame count is not already `8n + 1` are padded forward by repeating the final frame; they are never rounded down. A 24-frame source therefore becomes 25 VAE input frames, then a four-second request adds 96 frames for a 121-frame result. Source audio is silence-padded over that one-frame compatibility interval so video and audio conditioning remain aligned.

### Resolution

The public MCP schema allows dimensions from 64 to 4096, but practical cost rises sharply with pixel count and duration. The native distilled two-stage runner should receive width and height divisible by 64 when exact output dimensions matter. A request for `768x432` produced `768x384` because the two-stage half-resolution path snapped the height. `1024x576` is exact and divisible by 64 in both dimensions.

Do not compare timing across different frame counts, dimensions, LoRA counts, cache state, or thermal conditions as though they were equivalent.

### Audio

Native LTX output includes jointly generated audio. Verified regular and IC Dual Character outputs contain H.264 video plus 48 kHz stereo AAC audio. The native runner explicitly performs video and audio decoding and muxing.

The Comfy graphs also include LTX audio latents, audio VAE decoding, and MP4 muxing. They currently contain an internal audio-conditioning asset, but the MCP does not expose a standalone custom input-audio field. Therefore:

- Prompt-directed ambience, voices, and sound can be generated.
- Native MLX source-video extension encodes an existing soundtrack as temporal context. The Comfy/CUDA compiler preserves that source audio and generates the appended audio interval through the joint LTX AV model while conditioning on the completed video. When the source has no audio stream, both routes generate synchronized audio for the entire completed video instead of preserving synthetic silence.
- External audio upload, exact lip-sync to a supplied track, and audio-to-video replacement are not currently first-class MCP capabilities.
- A downstream edit can still remove audio. In particular, FFmpeg `-an` explicitly strips it. Always probe final deliverables with `ffprobe` after comparison or layout assembly.

### Prompting

LTX responds well to chronological, physically observable direction:

1. Establish camera and initial composition.
2. Treat the start image as frame zero instead of redescribing it at length.
3. State what moves first and what stays fixed.
4. Direct acting through gaze, blinking, breathing, head turns, hands, mouth, and jaw motion.
5. Give camera movement a trigger and an explicit final composition.
6. Describe audio and quoted dialogue when generated audio is desired.

Longer clips need enough temporal action to fill their duration. Avoid unrelated transformations, contradictory camera instructions, readable text, and overloaded ensembles.

## MCP tool lifecycle

The relevant tools are:

| Tool | Purpose |
| --- | --- |
| `media_status` | Verify backend, Studio URL, token, runtime, and Comfy health |
| `media_generation_schema` | Inspect programmatic image/video fields and defaults |
| `media_list_workflows` | Discover current registered workflows and the default video workflow |
| `media_generate_image` | Queue text-to-image or a supported image-edit job |
| `media_generate_video` | Queue a registered video workflow |
| `media_get_job` | Poll one image or video job |
| `media_list_history` | List recent redacted jobs |
| `media_list_models` | Inspect installed models and bundles |
| `media_list_loras` | Inspect installed and selected image-generation LoRAs |
| `media_select_loras` | Replace the current image-generation LoRA selection |
| `media_equip_model` / `media_unequip_model` | Manage Studio image models |

Video LoRAs are fixed by their registered workflow. `media_select_loras` controls image-generation LoRAs and does not convert a regular LTX video request into a Better Motion or IC request.

Generation is asynchronous by default:

1. Call `media_generate_video` or `media_generate_image` with `wait: false`.
2. Read `job.id` or `submission.prompt_id` from the response.
3. Poll `media_get_job` until `status` is `success` or `error`.
4. Use `include_urls: true` on the final poll to receive tailnet-reachable `media_urls`.
5. Fetch the selected URL while its token query is intact.

Use `wait: true` only when a client can safely hold a long MCP call open. LTX calls can run for several minutes, so polling is more robust.

### `media_generate_video` parameter reference

| Field | Type / range | Behavior |
| --- | --- | --- |
| `workflow_id` | string, optional | Canonical ID or supported alias; defaults to `ltx23-eros-fast` |
| `prompt` | non-empty string | Positive video/audio prompt; workflow default is used when omitted |
| `negative_prompt` | string, up to 2000 chars | Mapped when the workflow and execution mode support it; native MLX distilled extension is positive-only and ignores this field |
| `image_path` | string | Start image on the server filesystem or existing Comfy input filename |
| `image_base64` | string | Raw base64 or image data URL for the start image; wins over path and URL |
| `image_url` | HTTP(S) URL | Server-fetched start image; wins over path when base64 is absent |
| `video_path` | string | Source video on the server filesystem or existing Comfy input filename |
| `video_base64` | string | Raw base64 or `data:video/...;base64,...`; wins over video path and URL |
| `video_url` | HTTP(S) URL | Server-fetched source video when base64 is absent |
| `video_mode` | `extend` | Preserves the source clip and appends a generated continuation |
| `middle_image_*` | path, base64, or URL | Convenience midpoint anchor |
| `end_image_*` | path, base64, or URL | Convenience final-frame anchor |
| `keyframes` | array | Arbitrary anchors with source, frame/time/role, and strength |
| `params` | object | Registry-defined extras such as `cfg`, `guidance`, or `steps` |
| `width`, `height` | integer, 64 to 4096 | Requested output dimensions |
| `duration_seconds` | number, 1/24 to 30 | Image workflow duration, or amount of new footage appended in video mode |
| `frames` | integer, 9 to 721 | Explicit frame count; use this for Eros |
| `frame_rate` | number, 1 to 120 | Frames per second |
| `seed` | integer, 0 to 1,000,000,000 | Reproducibility seed |
| `transition_lora` | boolean | Enable or disable the Transition LoRA on compatible registry workflows |
| `transition_lora_strength` | number, 0 to 2 | Transition LoRA strength, normally `1.0` |
| `transition_trigger` | string, up to 80 chars | Transition trigger, normally `zhuanchang` |
| `append_transition_trigger` | boolean | Automatically append the trigger when missing |
| `wait` | boolean, default `false` | Hold the tool call and poll until completion/error |
| `timeout_s` | number, 1 to 3600, default `1800` | Maximum wait time when `wait` is true |
| `include_urls` | boolean, default `false` | Include absolute token-bearing output URLs where available |

The successful video response includes `submission`, `job`, and `workflow`. `workflow.route` reports `native-mlx-apple-silicon` or `comfyui-fallback`. In extension mode, `workflow.extension_output_frames` and `workflow.extension_latent_frames` make the two frame units explicit. A completed native `job` includes `elapsed_seconds`, dimensions, frame count, frame rate, seed, anchors, LoRAs, progress fields, and media URLs. Native denoising progress reports the actual current and total step counts; it is not a synthetic workflow-stage counter.

### Local Content API

Explore uses the private Content API at `POST http://127.0.0.1:8765/api/media-studio/video`. This route accepts either `image_base64` or `video_base64`; video wins when both are present. It is synchronous and requires the owner session cookie or `Authorization: Bearer $CONTENT_STUDIO_CONTROL_TOKEN`:

```json
{
  "workflow_id": "ltx23-eros-fast",
  "prompt": "Continue the same uninterrupted tracking shot and preserve the existing motion.",
  "video_base64": "data:video/mp4;base64,...",
  "video_mode": "extend",
  "duration_seconds": 3
}
```

The Content API accepts inline media only. Remote agents should use the tailnet MCP, which also supports `video_url` and server-local `video_path`, returns asynchronous job receipts, and exposes tailnet-reachable result URLs.

### `media_generate_image` parameter reference

| Field | Type / range | Behavior |
| --- | --- | --- |
| `prompt` | required non-empty string | Private image generation or edit prompt |
| `backend` | string, optional | Selects a route such as `mlx-mxfp8-bigloves-klein3-edit` |
| `width`, `height` | integer, 64 to 4096 | Forwarded to the selected runner; individual runners may have lower caps |
| `steps` | integer, 1 to 150 | Forwarded when supported |
| `cfg`, `cfgScale`, `guidance` | number, 0 to 50 | Backend-specific guidance aliases |
| `seed` | integer or string | Random/runner default when omitted, blank, or `-1` |
| `negative_prompt` | string, up to 2000 chars | Used for generation but not persisted in raw history |
| `image_path` | string | Source image for an edit backend, resolved on the server |
| `image_base64` | string | Inline source image; wins over path and URL |
| `image_url` | HTTP(S) URL | Server-fetched source image when base64 is absent |
| `loras` | array of `{id,strength?}` | Per-request image LoRAs; otherwise the current selection is used |
| `wait` | boolean, default `false` | Hold the call until completion/error |
| `timeout_s` | number, 1 to 1800, default `900` | Maximum wait time when `wait` is true |
| `include_urls` | boolean, default `false` | Request absolute output URLs; a final `media_get_job` poll remains canonical |

## Connecting an MCP client

Connector syntax differs by host, but the logical configuration is:

```json
{
  "name": "media-studio",
  "type": "http",
  "url": "https://liams-macbook-pro-1.tail629894.ts.net:8789/mcp",
  "headers": {
    "Authorization": "Bearer ${MEDIA_STUDIO_TOKEN}"
  }
}
```

Both machines must be on the same tailnet. Store `MEDIA_STUDIO_TOKEN` in the client's secret manager rather than writing its value into a checked-in MCP config.

### Curl helper for the raw MCP protocol

The server uses streamable HTTP and currently returns tool results as SSE `data:` lines. This helper sends one tool call:

```bash
export MEDIA_STUDIO_MCP_URL="https://liams-macbook-pro-1.tail629894.ts.net:8789/mcp"
export MEDIA_STUDIO_TOKEN="$(< ~/.hivemindos/media-studio/secure/zimg-token)"

mcp_call() {
  local tool="$1"
  local arguments_json="${2:-}"
  if [ -z "$arguments_json" ]; then
    arguments_json='{}'
  fi
  jq -cn \
    --arg tool "$tool" \
    --argjson arguments "$arguments_json" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$tool,arguments:$arguments}}' \
  | curl -fsS -X POST "$MEDIA_STUDIO_MCP_URL" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -H "Authorization: Bearer $MEDIA_STUDIO_TOKEN" \
      --data-binary @- \
  | sed -n 's/^data: //p' \
  | jq '.result.structuredContent'
}

mcp_call_file() {
  local tool="$1"
  local arguments_file="$2"
  jq -cn \
    --arg tool "$tool" \
    --slurpfile arguments "$arguments_file" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$tool,arguments:$arguments[0]}}' \
  | curl -fsS -X POST "$MEDIA_STUDIO_MCP_URL" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -H "Authorization: Bearer $MEDIA_STUDIO_TOKEN" \
      --data-binary @- \
  | sed -n 's/^data: //p' \
  | jq '.result.structuredContent'
}
```

On a remote Mac, set `MEDIA_STUDIO_TOKEN` from that machine's secure credential store. The server-side token file path only works on the server Mac.

### Health and discovery

```bash
mcp_call media_status '{}'
mcp_call media_generation_schema '{}'
mcp_call media_list_workflows '{"media_type":"video"}'
mcp_call media_list_workflows '{"media_type":"video","query":"dual"}'
```

## Video examples

### Default video request

Omitting `workflow_id` selects `ltx23-eros-fast`. Omitting an image uses that workflow's installed default image.

```bash
ARGS=$(jq -cn --arg prompt \
  'A handheld close-up begins still. The adult subject looks toward the window, blinks, then turns back to camera while soft room ambience and distant rain continue.' \
  '{prompt:$prompt,frames:73,frame_rate:24,wait:false}')

RESPONSE=$(mcp_call media_generate_video "$ARGS")
JOB_ID=$(jq -r '.job.id // .submission.prompt_id' <<<"$RESPONSE")
```

### Poll and download

```bash
mcp_call media_get_job "$(jq -cn --arg id "$JOB_ID" '{id:$id,include_urls:true}')"
```

When the status is `success`, the response contains a tailnet URL similar to:

```text
https://liams-macbook-pro-1.tail629894.ts.net:8789/image/<output>.mp4?token=<private-token>
```

Download it without rewriting the host:

```bash
curl -fL "$MEDIA_URL" -o output.mp4
```

### Extend a source video from another machine

For a remote client file, send a data URL. The duration is the amount appended, not the total output duration:

For Regular Fast, set `workflow_id` to the canonical `ltx23-regular-fp8` ID or one of `fastregular`, `fast-regular`, `regular-fast`, or `regular`. Do not use `fast`: that alias deliberately selects `ltx23-eros-fast`.

```bash
BASE64_FILE=$(mktemp)
ARGS_FILE=$(mktemp)
base64 < source.mp4 | tr -d '\n' > "$BASE64_FILE"

jq -cn \
  --rawfile video "$BASE64_FILE" \
  --arg prompt 'Continue the same uninterrupted shot. Preserve the people, camera path, lighting, velocity, and ongoing body motion as the camera follows them through the doorway.' \
  '{workflow_id:"ltx23-eros-fast",prompt:$prompt,video_base64:("data:video/mp4;base64,"+$video),video_mode:"extend",duration_seconds:3,wait:false}' \
  > "$ARGS_FILE"

mcp_call_file media_generate_video "$ARGS_FILE"
rm -f "$BASE64_FILE" "$ARGS_FILE"
```

For larger clips, replace `video_base64` with a server-fetchable `video_url`. A local `video_path` only works when that path exists on the Media Studio server.

### Starting image as base64

For large base64 values, build the JSON from a file rather than passing the encoded bytes as a command-line argument:

```bash
BASE64_FILE=$(mktemp)
ARGS_FILE=$(mktemp)
base64 < start.jpg | tr -d '\n' > "$BASE64_FILE"

jq -cn \
  --rawfile image "$BASE64_FILE" \
  --arg prompt 'The camera slowly pushes in as the subject looks up and smiles. Hair and clothing move gently in the breeze. Soft city ambience fills the scene.' \
  '{workflow_id:"ltx23-regular-fp8",prompt:$prompt,image_base64:$image,width:576,height:1024,duration_seconds:3,frame_rate:24,wait:false}' \
  > "$ARGS_FILE"

mcp_call_file media_generate_video "$ARGS_FILE"
rm -f "$BASE64_FILE" "$ARGS_FILE"
```

Raw base64 is accepted. A `data:image/jpeg;base64,...` value is also accepted and is preferred when the MIME type is important.

### Starting image by URL

```bash
mcp_call media_generate_video "$(jq -cn \
  --arg image_url 'https://example.tailnet/image/start.png?token=<private-token>' \
  --arg prompt 'The subject takes one measured step forward while the camera tracks backward, preserving the framing.' \
  '{workflow_id:"ltx23-regular-fp8",prompt:$prompt,image_url:$image_url,duration_seconds:3,frame_rate:24,wait:false}')"
```

The URL must be reachable from the Media Studio server. Studio output URLs returned by `media_get_job` are valid inputs when their token query remains attached.

### Starting image by local server path

```bash
mcp_call media_generate_video "$(jq -cn \
  --arg path '/Users/liam/Downloads/start.png' \
  --arg prompt 'The subject turns toward camera as the light changes gently.' \
  '{workflow_id:"ltx23-regular-fp8",prompt:$prompt,image_path:$path,duration_seconds:3,wait:false}')"
```

This only works when the path exists on the Media Studio server Mac. Absolute files outside the private Comfy input directory are hard-linked when possible and copied otherwise.

### Start, middle, and end anchors

The following argument shape uses convenience roles. Replace the placeholders with raw base64 or data URLs:

```json
{
  "workflow_id": "ltx23-regular-fp8",
  "prompt": "The camera arcs smoothly around the subject. At the midpoint the subject turns toward the light, then settles into the final composition with stable identity and exposure.",
  "image_base64": "<START_IMAGE_BASE64>",
  "middle_image_base64": "<MIDDLE_IMAGE_BASE64>",
  "end_image_base64": "<END_IMAGE_BASE64>",
  "duration_seconds": 5,
  "frame_rate": 24,
  "wait": false
}
```

At 24 fps and 5 seconds, both execution paths resolve this to 121 frames with anchors at frames 0, 60, and 120.

### Arbitrary timed keyframes

```json
{
  "workflow_id": "ltx23-regular-fp8",
  "prompt": "A continuous controlled camera move connects each authored composition without cuts or exposure changes.",
  "image_base64": "<START_IMAGE_BASE64>",
  "duration_seconds": 5,
  "frame_rate": 24,
  "keyframes": [
    {
      "time_seconds": 1.5,
      "strength": 0.8,
      "image_base64": "<IMAGE_AT_1_5_SECONDS>"
    },
    {
      "time_seconds": 3.5,
      "strength": 0.9,
      "image_url": "https://example.tailnet/image/frame-3-5.png?token=<private-token>"
    },
    {
      "role": "end",
      "strength": 1.0,
      "image_base64": "<END_IMAGE_BASE64>"
    }
  ],
  "wait": false
}
```

### Transition LoRA

```json
{
  "workflow_id": "ltx23-transition-lora",
  "prompt": "The starting portrait transitions through one continuous natural camera move into the final wide composition. Identity, lighting direction, and fabric details remain coherent throughout.",
  "image_base64": "<START_IMAGE_BASE64>",
  "end_image_base64": "<END_IMAGE_BASE64>",
  "duration_seconds": 5,
  "frame_rate": 24,
  "params": {
    "cfg": 4.0
  },
  "transition_lora_strength": 1.0,
  "append_transition_trigger": true,
  "wait": false
}
```

The workflow appends `zhuanchang` when it is not already present.

### Better Motion LoRA

```json
{
  "workflow_id": "ltx23-better-motion-lora",
  "prompt": "The runner accelerates across the platform as the camera tracks laterally, coat and hair responding naturally to speed. The camera eases to a stop on the final profile composition.",
  "image_base64": "<START_IMAGE_BASE64>",
  "duration_seconds": 5,
  "frame_rate": 24,
  "wait": false
}
```

The registered native LoRA strength is `0.3`; callers do not need to select the file manually.

### IC Dual Character LoRA

```json
{
  "workflow_id": "ltx23-ic-dual-character-lora",
  "prompt": "[Scene] Two adults sit opposite each other in the same train dining car under constant tungsten light. [Characters] Character A keeps her copper micro-braids, crescent earring, mustard coat, and exact face. Character B keeps his wavy black hair, round glasses, teal jacket, and exact face. [Shot 1, 0-3.3s] Stable wide two-shot as Character A places the envelope on the table. [Shot 2, 3.3-6.6s] Hard cut to an over-the-shoulder close-up on Character A as she speaks. [Shot 3, 6.6-10s] Hard cut to the reverse close-up on Character B as he responds. Preserve coherent eyelines, wardrobe, identity, exposure, dialogue motion, and train ambience.",
  "negative_prompt": "extra person, merged faces, identity swap, wardrobe change, incoherent eyeline, dissolve, face morphing, exposure ramp, text, watermark",
  "image_base64": "<TWO_CHARACTER_REFERENCE_BASE64>",
  "width": 1024,
  "height": 576,
  "duration_seconds": 10,
  "frame_rate": 24,
  "seed": 43177,
  "params": {
    "cfg": 1.0
  },
  "wait": false
}
```

### IC-LoRA Ingredients

Workflow ID: `ltx23-ic-ingredients-lora`. Aliases: `ingredients`, `ic-ingredients`, `ltx23-ingredients`, and `reference-sheet`.

This workflow does not treat the supplied image as the first video frame. The image is a clean reference sheet that inventories the characters, wardrobe, props, and location. Each distinct ingredient should occupy its own panel on a black background, with no labels rendered into the image. Put more pixels into the most important identity panels.

Use `reference_description` for a panel-by-panel inventory and `prompt` for the shot to generate. The MCP combines them into the two headings required by the model. A fully assembled prompt containing both headings is also accepted unchanged.

```json
{
  "workflow_id": "ingredients",
  "reference_description": "Top left character panel: an adult Black woman with copper micro-braids, a crescent gold earring, mustard wool coat, and dark green blouse. Top right character panel: an adult East Asian man with wavy black hair, round wire-frame glasses, a teal work jacket, and charcoal shirt. Middle left prop panel: one closed cream envelope. Bottom wide location panel: an empty vintage night-train dining car with warm tungsten lamps and cool rain-streaked windows.",
  "prompt": "Cinematic medium-wide dialogue shot inside the exact dining car. The two adults sit opposite one another with the cream envelope between them. The woman slides it forward while the man watches, both identities and wardrobes remain exact, rain moves across the windows, subtle breathing and blinking, stable exposure, synchronized train ambience.",
  "image_base64": "<REFERENCE_SHEET_BASE64>",
  "width": 768,
  "height": 448,
  "frames": 121,
  "frame_rate": 24,
  "seed": 42,
  "wait": false
}
```

Implementation parity:

- Apple Silicon routes to `ltx-2-mlx ic-lora`. The server losslessly repeats the sheet into a temporary FFV1 reference video, applies the Ingredients IC-LoRA at `1.4`, uses reference conditioning at `1.0`, and runs the full-resolution single-stage topology.
- Windows and CUDA route through ComfyUI. `RepeatImageBatch` expands the sheet to the output frame count, `LTXICLoRALoaderModelOnly` reads the LoRA metadata, and `LTXAddVideoICLoRAGuide` appends the reference latents. `LTXVCropGuides` removes guide tokens before decode.
- Both paths use the same labeled prompt, `768x448`, 121 frames, 24 fps, the official distilled sigma schedule, jointly generated audio, and the recommended Ingredients strength of `1.4`.
- Middle and ending anchors are intentionally not part of this workflow. Use the regular, Transition, or Eros workflows when temporal image anchors are the desired control mechanism.

The Ingredients repository is gated. Accept its terms at `https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients`, then run the installer through `hive-env-run` or the shared Hive environment. The installer reads `HF_TOKEN`, `HUGGING_FACE_HUB_TOKEN`, `HUGGINGFACE_TOKEN`, or the fleet-standard `HUGGINGFACE_READ_WRITE_KEY` at runtime and never writes the credential into project files.

### Exact standalone IC video recipe (the right-hand take)

The right-hand video in the A/B comparison was the standalone IC-LoRA output below. The side-by-side assembly was only a later review artifact and did not participate in generation.

```text
Standalone review copy:
/Users/liam/comfy/hivemind-content-studio/output/ltx23-ic-dual-character-ab-test/ic.mp4

Original private output:
/Users/liam/.comfy-private.noindex/output/LTX23/mlx_ltx23_regular_q8_distilled_mobile_c532fa3b33d8_241f.mp4
```

The frame-zero reference was generated once with Codex's OpenAI image-generation capability. No image-generation seed was exposed or set. The exact prompt was:

```text
Use case: photorealistic-natural
Asset type: single first-frame identity reference for an A/B LTX 2.3 multi-shot dialogue test
Primary request: Create a cinematic widescreen still of exactly two adults seated opposite each other in a quiet vintage night-train dining car, poised at the beginning of a serious but calm conversation.
Character A: an adult Black woman investigative journalist with shoulder-length copper micro-braids, a small crescent-shaped gold earring, a mustard wool coat over a dark green blouse, seated on the left.
Character B: an adult East Asian man railway engineer with wavy black hair, round wire-frame glasses, a teal work jacket over a charcoal shirt, seated on the right.
Scene: They face each other across a narrow table with one closed cream envelope centered between them. Their hands rest separately near their own edge of the table. Rain traces the dark window behind them and warm practical lamps illuminate the carriage.
Style/medium: photorealistic cinematic film still, realistic skin and anatomy, detailed fabric, restrained production design
Composition/framing: true 16:9 landscape, stable eye-level medium-wide two-shot, 35mm lens, both faces fully visible in three-quarter profile, enough background geometry and shoulder detail to support later over-the-shoulder reverse angles
Lighting/mood: controlled warm tungsten interior against cool blue rainy windows, balanced exposure, no clipped highlights, quiet tension
Constraints: exactly two adults; highly distinct faces, hairstyles, earrings, glasses, and clothing colors; no other passengers; no text, logos, watermark, or signage
Avoid: extra people, merged bodies, touching hands, duplicated limbs, cartoon style, shallow blur that obscures either face, overexposure
```

The resulting `1672x941` PNG was stored at:

```text
/Users/liam/comfy/hivemind-content-studio/output/ltx23-ic-dual-character-ab-test/reference.png
```

That one image was supplied only at frame `0`. There were no middle or end anchors in this controlled LoRA test; the model had to create the shot changes and retain both identities itself. The current canonical MCP request is:

```json
{
  "workflow_id": "dual-character",
  "prompt": "[Scene] Photorealistic modern cinematic dialogue inside a vintage night-train dining car during rain. Warm tungsten lamps, cool blue rain-streaked windows, quiet restrained tension. [Characters] Character A: adult Black woman investigative journalist, shoulder-length copper micro-braids, crescent-shaped gold earring, mustard wool coat over a dark green blouse. Character B: adult East Asian man railway engineer, wavy black hair, round wire-frame glasses, teal work jacket over a charcoal shirt. [Shot 1, wide two-shot, 0.0-3.3s] Eye-level medium-wide view across the table. Both characters are visible facing one another with a closed cream envelope between them. Subtle breathing and blinking. Character A slides the envelope slightly toward Character B and begins speaking. [Shot 2, hard cut to over-the-shoulder close-up on Character A, 3.3-6.6s] Camera is behind Character B right shoulder; his teal shoulder and dark hair are soft foreground while Character A face fills the frame. Preserve her exact braids, face, crescent earring, mustard coat and green blouse. She looks directly at him and calmly says, \"This was hidden on the last train.\" Natural lip movement and a small serious nod. [Shot 3, hard cut to reverse over-the-shoulder close-up on Character B, 6.6-10.0s] Camera is behind Character A left shoulder; her mustard shoulder and copper braids are soft foreground while Character B face fills the frame. Preserve his exact wavy hair, face, round glasses, teal jacket and charcoal shirt. He glances down at the envelope, then meets her eyes and replies quietly, \"Then we open it together.\" Natural lip movement and a restrained concerned expression. True editorial hard cuts at the stated times, stable identities and wardrobe across all shots, coherent eyelines, constant exposure, realistic dialogue motion.",
  "negative_prompt": "extra person, third person, identity swap, character fusion, face morphing, changed ethnicity, changed hairstyle, missing glasses, changed wardrobe, duplicated face, duplicated limbs, extra fingers, deformed hands, incoherent eyeline, camera teleport within a shot, continuous morph between shot angles, dissolve, flicker, exposure ramp, blown highlights, excessive bloom, cartoon, anime, illustration, text, subtitles, captions, watermark, logo, low quality, blur",
  "image_path": "/Users/liam/comfy/hivemind-content-studio/output/ltx23-ic-dual-character-ab-test/reference.png",
  "width": 1024,
  "height": 576,
  "duration_seconds": 10,
  "frame_rate": 24,
  "seed": 43177,
  "params": {
    "cfg": 1.0
  },
  "wait": true,
  "timeout_s": 3600,
  "include_urls": false
}
```

The historical shell payload placed `cfg: 1.0` at the top level. The effective value was still `1.0` because that is the workflow default. `params.cfg` above is the supported canonical form now.

Confirmed execution details:

- MCP workflow alias `dual-character` resolved to `ltx23-ic-dual-character-lora`.
- Apple route `native-mlx-apple-silicon`; backend `mlx-ltx-regular-regular-q8-distilled`.
- Model `/Users/liam/comfy/mlx-models/ltx-2.3-mlx-q8-distilled-subset`.
- LoRA `LTX2.3-IC-LORA-Dual-Character.safetensors`, fused at `0.80`.
- Distilled two-stage generation: 8 first-pass denoising steps, latent upscale, then 3 refinement steps.
- Final output: 1024x576 H.264, 241 frames at 24 fps, 10.041667 seconds, plus 48 kHz stereo AAC audio.
- Job `c532fa3b33d8`; backend generation time `345.91s`; complete blocking MCP call `347.05s`.

## How the reference images are generated

LTX animates an image; it is not the image generator used to create our character references.

### Images used in the dual-character tests

The controlled dual-character reference was generated with OpenAI image generation through Codex's image-generation capability, not through LTX and not through the Studio MCP. The final reference was a `1672x941` PNG, close to 16:9, and was then supplied as frame zero to both the regular control and IC-LoRA run.

The image prompt deliberately specified:

- Exactly two adults and no background passengers.
- Durable identity markers for each person: face, ethnicity, hair, accessory, and wardrobe color.
- A stable medium-wide two-shot with both faces visible in three-quarter profile.
- Background and shoulder geometry suitable for later over-the-shoulder angles.
- Controlled exposure with warm interior light and cool rainy windows.
- No text, logos, watermark, merged bodies, touching hands, or shallow blur hiding a face.

For the earlier start/end transition test, the start image was generated first. The end image was created as an identity-preserving edit of that exact image, changing only the action and final prop state while locking camera, crop, people, wardrobe, and environment. This is safer than generating two unrelated stills and hoping LTX can reconcile them.

### Studio MCP text-to-image

`media_generate_image` with only a prompt uses the current default Media Studio text-to-image route. At the time of verification, that route invokes the installed Z-Image Turbo ComfyUI workflow through `ComfyUI/run_z_image_turbo.py`.

```bash
IMAGE_RESPONSE=$(mcp_call media_generate_image "$(jq -cn --arg prompt \
  'Cinematic 16:9 medium-wide still of exactly two adults seated opposite each other in a train dining car, both faces visible, distinct hair and wardrobe, controlled tungsten light, rainy windows, realistic skin, no text or watermark.' \
  '{prompt:$prompt,width:1024,height:576,seed:43177,wait:false}')")

IMAGE_JOB_ID=$(jq -r '.job.id' <<<"$IMAGE_RESPONSE")
```

The default image runner supports width, height, steps, CFG/guidance aliases, seed, negative prompt, and selected image LoRAs. It rounds requested dimensions to multiples of 64 and currently caps the runner dimensions at 2048.

### Studio MCP image editing on Apple Silicon

To edit a supplied image with the native BigLoveKlein3 route, set the backend explicitly and provide an image:

```json
{
  "prompt": "Preserve the exact two people, camera, crop, wardrobe, and environment. Change only the closed mechanical flower into an open articulated flower with a restrained amber glow.",
  "backend": "mlx-mxfp8-bigloves-klein3-edit",
  "image_base64": "<SOURCE_IMAGE_BASE64>",
  "width": 1024,
  "height": 1024,
  "steps": 4,
  "guidance": 1.0,
  "seed": 42,
  "wait": false
}
```

On Apple Silicon this uses the Swift/MLX Flux2 BigLoveKlein3 image-to-image path. When an explicit MLX backend is requested on a non-Apple profile, the MCP returns an availability error. The current JSON MCP route does not provide full remote BigLove edit parity on Windows; use a registered Comfy edit workflow through ComfyUI Mobile until that adapter is added.

### Chaining an MCP-generated image into LTX

1. Queue `media_generate_image`.
2. Poll the image job with `media_get_job` and `include_urls: true`.
3. Read the first `media_urls` entry.
4. Pass that entire token-bearing URL as `image_url` to `media_generate_video`.

```bash
IMAGE_JOB=$(mcp_call media_get_job "$(jq -cn --arg id "$IMAGE_JOB_ID" '{id:$id,include_urls:true}')")
START_URL=$(jq -r '.job.media_urls[0]' <<<"$IMAGE_JOB")

VIDEO_ARGS=$(jq -cn \
  --arg image_url "$START_URL" \
  --arg prompt 'Begin from the exact still. Character A slides the envelope forward, Character B watches, and the camera makes a slow controlled push-in while train ambience continues.' \
  '{workflow_id:"ltx23-regular-fp8",prompt:$prompt,image_url:$image_url,duration_seconds:5,frame_rate:24,wait:false}')

mcp_call media_generate_video "$VIDEO_ARGS"
```

Do not strip the `?token=...` query from the intermediate Studio URL.

## Expected agent behavior

When an MCP-connected agent receives a vague request such as "generate a video for me," it should:

1. Call `media_status` if service health is not already known.
2. Call `media_list_workflows` when workflow choice matters or the request mentions motion, transitions, multiple characters, or exact fidelity.
3. Use `ltx23-eros-fast` when the request is otherwise vague because it is the registered default.
4. Treat an attached client-side image as bytes and send it through `image_base64`; never send the client's local path to the server.
5. Choose Transition for an explicit start/end transformation, Better Motion for stronger motion, IC Dual Character for storyboarded two-person coverage, Ingredients for a panelized character/prop/location reference sheet, Regular for neutral/general LTX, and Eros Exact only when that model variant is requested.
6. Submit asynchronously, poll, and return the final tailnet-reachable media URL.
7. Report `elapsed_seconds` from the completed job as generation time. Do not estimate it from clip duration.

When a new video model is registered, the agent should discover it through `media_list_workflows`; the MCP is not limited to Eros or even to LTX by its public tool name.

## Outputs, history, and privacy

- Raw prompts are replaced with private labels in persisted history.
- Inline images are staged in the private Comfy input directory.
- Generated files live under private Media Studio or Comfy output roots.
- `media_get_job` and `media_list_history` return redacted records by default.
- `include_urls: true` adds absolute URLs using the configured public Studio host, currently the Tailscale DNS name rather than `127.0.0.1`.
- A successful native job reports model variant, dimensions, frames, frame rate, seed, keyframes, LoRAs, progress, `elapsed_seconds`, and output URLs.

## Measured reference jobs

These are observations from this Mac, not performance promises:

| Workflow / case | Dimensions | Frames | Result | Backend time |
| --- | ---: | ---: | --- | ---: |
| Eros Fast benchmark | 480x832 | 233 | Full approximately 9.7s video | 193.11s |
| Eros Exact benchmark | 480x832 | 233 | Full approximately 9.7s video | 247.44s |
| Regular start/end short test | 576x1024 | 41 | Native start/end anchors and audio | 42.14s |
| Regular dual-character control | 1024x576 | 241 | Three-shot 10s control | 318.86s |
| IC Dual Character LoRA | 1024x576 | 241 | Three-shot 10s IC run | 345.91s |

The IC run confirmed native LoRA fusion at `0.80`, a frame-zero image anchor, H.264 video, and AAC audio.

## Troubleshooting

### `401 unauthorized`

- Verify the MCP token is configured on the client.
- Use `Authorization: Bearer ...` or `X-Token`.
- Do not confuse the Media Studio token with a Civitai or Hugging Face credential.

### Request body too large

- The MCP JSON limit is 25 MiB.
- Remember base64 expansion and JSON overhead.
- Use `image_url` for large anchors or several high-resolution frames.

### Remote `image_path` does not work

- Paths resolve on the server Mac.
- Send `image_base64` or `image_url` from another machine.

### Unexpected output dimensions

- Use width and height divisible by 64 for native two-stage MLX.
- Probe the produced file instead of trusting requested dimensions.

### Unexpected duration

- Native frames normalize to `8n + 1`.
- Use 73, 121, 233, or 241 frames for common 3s, 5s, approximately 9.7s, and 10s spans at 24 fps.
- Use `frames` for Eros and `duration_seconds` or `frames` for regular-family workflows.

### No audio

- Probe the source output with `ffprobe` first.
- Native LTX outputs normally include AAC audio.
- Check downstream FFmpeg commands for `-an` or a video-only `-map`.
- The first dual-character side-by-side comparison was silent because the comparison assembly explicitly used `-an`; both source generations contained audio.

### Middle/end image appears to have no effect

- Confirm the running MCP process includes the shared-keyframe compiler; restart the Media Studio stack after updating the code.
- Inspect the submitted Comfy graph. Both `LTXVImgToVideoInplaceKJ` nodes should report the full `num_images` count, and the graph should contain one `LTXVAddGuide` per normalized anchor.
- Confirm each requested frame is within the final frame count and that another explicit keyframe did not replace it at the same frame.
- Check that the anchor images describe a physically and visually compatible motion path.

### Job appears stuck

- Poll `media_get_job`; do not infer failure from a long MCP call.
- Inspect `progress_phase`, `current_step`, and `elapsed_seconds`.
- Long 1024x576, 241-frame runs can take several minutes.

### Output URL points to localhost

- Use `include_urls: true` on `media_get_job`.
- The configured public Studio base rewrites output URLs to the Tailscale DNS host.
- Do not rewrite a correct tailnet URL back to `127.0.0.1`.

## Registering additional video workflows

The MCP video tool is general. To make another local model discoverable:

1. Install an API-format Comfy workflow and, optionally, a Mobile editor workflow.
2. Add a workflow entry to `packages/media-gateway/workflow-registry.json` with a unique ID, media type, builder, paths, defaults, accepted fields, graph slots, and model dependencies.
3. Add native metadata only when a compatible native adapter exists.
4. Restart the Media Studio MCP/supervisor.
5. Verify the workflow appears in `media_list_workflows` and run the same submit/poll/output lifecycle.

Do not add model-specific names to `media_generate_video`. Discovery and workflow metadata are the extension mechanism.
