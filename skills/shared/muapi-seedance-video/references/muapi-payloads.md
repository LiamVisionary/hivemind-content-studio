# MUAPI Payloads

Use these examples as starting points. Always keep secrets in `MUAPI_API_KEY` and run through `hive-env-run`.

## Upload

```bash
hive-env-run -- python3 Skills/muapi-seedance-video/scripts/muapi_seedance_job.py upload refs/face.jpg refs/set.jpg --state state.json
```

The script saves uploaded media URLs under `state.json`.

## Text-To-Video

Endpoint: `seedance-v2.0-t2v`

```json
{
  "prompt": "A vertical cinematic talking-head shot of a 30-year-old founder seated behind a dark walnut desk, dramatic gray background, deadpan authoritative stare.",
  "aspect_ratio": "9:16",
  "duration": 4,
  "quality": "high",
  "remove_watermark": false
}
```

## Image-To-Video

Endpoint: `seedance-v2.0-i2v`

```json
{
  "prompt": "@image1 is the character sheet. The same person sits behind the same desk, hands clasped, camera slowly pushes in.",
  "images_list": ["<character_sheet_url>"],
  "aspect_ratio": "9:16",
  "duration": 4,
  "quality": "high",
  "remove_watermark": false
}
```

## Omni-Reference

Endpoint: `seedance-2.0-omni-reference`

```json
{
  "prompt": "@image1 is the character identity sheet. @image2 is the exact desk/set reference. The same man sits fully behind the same visible walnut desk occupying the lower third of the frame. He says exactly the audio line, then remains silent. No extra words.",
  "aspect_ratio": "9:16",
  "duration": 4,
  "quality": "high",
  "images_list": ["<character_sheet_url>", "<desk_set_url>"],
  "audio_files": ["<tts_line_url>"]
}
```

## Character Sheet

Endpoint: `seedance-2-character`

```json
{
  "images_list": ["<front_url>", "<three_quarter_url>", "<smile_or_side_url>"],
  "prompt": "30-year-old man, youthful face, dark wavy hair, clean-shaven or light stubble, black button-up shirt, slim build, cinematic tech-founder presenter wardrobe"
}
```

Poll the returned `request_id`. Use either:

- `@character:<request_id>` inline in T2V/I2V/Omni prompts.
- `outputs[0]` as `@image1` for tighter face fidelity.

## Result Shape

Successful result objects commonly include:

```json
{
  "status": "completed",
  "outputs": ["https://.../video.mp4"]
}
```

Some wrappers use `url` or `video.url`. The helper script checks all three.

## Common Failures

- HTTP 401/403: missing or stale `MUAPI_API_KEY`.
- HTTP 422: payload shape, unsupported duration, or missing required media list.
- Square or wrong framing: missing string `aspect_ratio`.
- Talking after the desired line: audio duration/prompt mismatch. Regenerate audio or add a clean silence tail; do not trim words unless asked.
- Identity drift: regenerate character sheet or use the sheet URL directly as `@image1`.
