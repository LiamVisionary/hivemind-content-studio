# MUAPI Operations

This reference captures the reusable operating pattern for MUAPI jobs. It is adapted for HivemindOS shared-env workflows from the MIT-licensed `SamurAIGPT/Generative-Media-Skills` repository and its `muapi-cli` usage.

## Auth

Shared env may contain either key name:

```bash
hive-env-check MUAPI_API_KEY || hive-env-check MUAPI_KEY
```

When invoking the upstream CLI, map the HivemindOS key name to the CLI key name without printing it:

```bash
hive-env-run -- sh -c 'export MUAPI_KEY="${MUAPI_KEY:-$MUAPI_API_KEY}"; muapi --help'
```

If `muapi-cli` is not installed, use `scripts/muapi_general.py` for direct HTTP calls. Do not perform a global install unless the user wants the CLI workflow or the task specifically needs CLI-only functionality.

For direct API calls, use:

```text
x-api-key: <shared-env-key>
```

## Base Endpoints

Confirmed from the referenced MUAPI skill repository:

| Purpose | Method | Path |
|---|---:|---|
| Upload local media | POST | `https://api.muapi.ai/api/v1/upload_file` |
| Submit model job | POST | `https://api.muapi.ai/api/v1/<endpoint>` |
| Poll result | GET | `https://api.muapi.ai/api/v1/predictions/<request_id>/result` |

The submit endpoint is usually the schema `endpoint_url`, not always the display `name`. Discover it before posting.

## Direct Helper Examples

Upload local references:

```bash
hive-env-run -- python3 scripts/muapi_general.py upload refs/person.jpg refs/audio.mp3 --state state.json
```

Submit a text-to-image job:

```json
{
  "prompt": "A cinematic product photo of a matte black robot bee delivering a stack of money, sharp macro lighting",
  "width": 1024,
  "height": 1536,
  "num_images": 1
}
```

```bash
hive-env-run -- python3 scripts/muapi_general.py submit \
  --endpoint flux-dev-image \
  --payload payloads/robot_bee_money_v01.json \
  --state state.json \
  --wait \
  --download outputs/robot_bee_money_v01.png
```

Submit a prompt-based image edit:

```json
{
  "prompt": "Keep the person identity and pose, replace the background with a modern glass office, natural lighting",
  "images_list": ["https://uploaded.source/image.jpg"],
  "aspect_ratio": "9:16"
}
```

```bash
hive-env-run -- python3 scripts/muapi_general.py submit \
  --endpoint flux-kontext-pro-i2i \
  --payload payloads/edit_v01.json \
  --wait \
  --download outputs/edit_v01.png
```

Submit text-to-video:

```json
{
  "prompt": "A vertical cinematic shot of robot cyber bees flying in formation, carrying stacks of cash toward a founder at a dark walnut desk",
  "aspect_ratio": "9:16",
  "duration": 5,
  "quality": "high"
}
```

```bash
hive-env-run -- python3 scripts/muapi_general.py submit \
  --endpoint seedance-v2.0-t2v \
  --payload payloads/bee_money_v01.json \
  --wait \
  --download outputs/bee_money_v01.mp4
```

Lip-sync an existing video:

```json
{
  "video_url": "https://uploaded.video/source.mp4",
  "audio_url": "https://uploaded.audio/approved_line.mp3"
}
```

```bash
hive-env-run -- python3 scripts/muapi_general.py submit \
  --endpoint sync-lipsync \
  --payload payloads/lipsync_v01.json \
  --wait \
  --download outputs/lipsync_v01.mp4
```

Clip a long video into vertical highlights:

```json
{
  "video_url": "https://uploaded.video/longform.mp4",
  "num_highlights": 3,
  "aspect_ratio": "9:16",
  "return_coordinates_only": false
}
```

```bash
hive-env-run -- python3 scripts/muapi_general.py submit \
  --endpoint ai-clipping \
  --payload payloads/clipping_v01.json \
  --wait
```

## Result Handling

MUAPI result shapes vary. Check for:

- `outputs: ["https://..."]`
- `url`
- `file_url`
- `media_url`
- nested `video.url`, `image.url`, or image arrays

The helper recursively extracts media URLs and downloads the first one when `--download` is passed. If a job returns multiple assets, save the result JSON and download each URL explicitly with `scripts/muapi_general.py download`.

## Common Failure Modes

- 401/403: missing or invalid shared env key.
- 404: endpoint display name used instead of schema `endpoint_url`.
- 422: wrong field name, wrong media list field, unsupported duration, invalid aspect ratio, or missing required file URL.
- Square/wrong framing: numeric width and height used for a model that expects string `aspect_ratio`.
- Bad lip-sync: unapproved audio, clipped line starts, long silence inside the line, or generated speech instead of exact TTS.
- Stitch drift: source clips have mixed frame rates or codecs. Re-encode before assembly.
