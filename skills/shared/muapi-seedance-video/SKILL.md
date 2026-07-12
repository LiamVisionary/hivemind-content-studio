---
name: muapi-seedance-video
description: Generate Seedance 2.0/2 Mini videos through MUAPI, including text-to-video, image-to-video, omni-reference with images/video/audio, character-sheet identity workflows, reference uploads, polling, downloads, replacement shots, and vertical social clips. Use when the user says MUAPI, Seedance API, Seedance 2.0 through MuAPI, omni-reference, character consistency, image/audio references for video, lipsync via MUAPI, or asks to regenerate individual AI video shots with consistent identity/set references.
---

# MUAPI Seedance Video

Use MUAPI when the user wants Seedance video generation through the API rather than the Higgsfield consumer CLI or Higgsfield Cloud API. Chain with `video-lipsync-tts` for spoken lines and `generated-short-assembly-qa` for final edits.

## Preconditions

1. Check credentials by name only:
   ```bash
   hive-env-check MUAPI_API_KEY
   ```
2. Run API calls through shared env:
   ```bash
   hive-env-run -- python3 <script>.py ...
   ```
3. Never print, paste, or save the API key. Save only request ids, uploaded media URLs, output URLs, prompts, and local artifact paths.
4. If the user explicitly asks for Higgsfield Cloud, use `higgsfield-generate` plus `higgsfield-api-quirks` instead. MUAPI payloads are not identical to Higgsfield Cloud payloads.

## Endpoints

Use base URL `https://api.muapi.ai/api/v1`.

| Task | Endpoint |
|---|---|
| Upload local media | `POST /upload_file` multipart form field `file` |
| Poll result | `GET /predictions/{request_id}/result` |
| Text-to-video | `POST /seedance-v2.0-t2v` |
| Image-to-video | `POST /seedance-v2.0-i2v` |
| Omni-reference | `POST /seedance-2.0-omni-reference` |
| Character sheet | `POST /seedance-2-character` |
| Seedance 2 Mini T2V | `POST /seedance-2-mini-t2v` |
| Seedance 2 Mini I2V | `POST /seedance-2-mini-i2v` |

Authentication header:

```text
x-api-key: <MUAPI_API_KEY>
```

## Workflow

1. Create a run folder under `/private/tmp/<project>-muapi` or the current project output folder:
   ```text
   refs/
   audio/
   payloads/
   outputs/
   qa/
   state.json
   ```
2. Normalize references before upload. Convert HEIC to JPEG/PNG when needed. Avoid using the user's selfies as literal start frames unless they asked for an image-to-video animation of that exact photo.
3. Upload local reference images, videos, and audio. Reuse URLs from `state.json` when regenerating.
4. For identity consistency, create a character sheet first or reuse the known `@character:<request_id>` / sheet URL. Use 1-3 strong photos and an explicit outfit/style prompt. Do not mix outfits across shots unless the user wants that.
5. For set consistency, use one anchor image or generated still for the environment/desk/background in every shot and repeat the same physical descriptors in prompts.
6. Submit the shot. For serious character/social-video work, prefer `/seedance-2.0-omni-reference`; use Mini for cheap drafts only when the user asks for speed/cost.
7. Poll until terminal status. Download the MP4 and give it a versioned, descriptive filename.
8. Run `video-render-qa` before delivery.

## Payload Patterns

### Omni-reference with image and audio

Use this for lip-synced talking shots and reference-heavy inserts.

```json
{
  "prompt": "@image1 is the consistent character sheet. @image2 is the set reference. A vertical close-up shot of the same 30-year-old man, same black shirt, seated behind the same dark walnut desk, speaking exactly the provided audio line with deadpan authority. No extra words after the line.",
  "aspect_ratio": "9:16",
  "duration": 4,
  "quality": "high",
  "images_list": ["<character_sheet_or_identity_ref_url>", "<set_ref_url>"],
  "audio_files": ["<tts_line_url>"]
}
```

Notes:

- MUAPI Omni uses `audio_files`. Do not copy the Higgsfield Cloud `input_audio` workaround into MUAPI payloads.
- Keep `duration` at least 4 seconds for Omni requests. If the spoken line is shorter, use silence padding or a prompt that says the subject stays silent after the exact line.
- Refer to images as `@image1`, `@image2`, etc. Do not say "based on this selfie" unless that image should visibly become the starting frame.

### Character sheet

```json
{
  "images_list": ["<front_face_url>", "<three_quarter_url>", "<smiling_or_side_url>"],
  "prompt": "30-year-old man with dark wavy hair, youthful face, clean-shaven/light stubble, same black button-up shirt, slim build, cinematic social-video presenter wardrobe"
}
```

Use the returned `request_id` as `@character:<id>` or use `outputs[0]` as a direct sheet image in I2V/Omni prompts. If face age drifts older, regenerate the sheet with explicit age and remove photos that add age/noise.

### Replacement insert

Generate standalone inserts as separate clips, not duplicated shots. Examples:

- Extreme close-up of face in dark dramatic lighting.
- Hands at the same desk flipping through stacks of money.
- Robot cyber bees bringing stacks of money.
- Humanoid robot partner leaning affectionately into frame.

For cash imagery, avoid printable-currency prompts. Ask for angled, moving, partial bundles with no legible serials and no flat isolated banknote layout.

## Prompt Rules Learned The Hard Way

- Say the exact spoken line in the prompt and also provide the exact audio. Add "no extra words" for talking shots.
- If the user corrects wording, regenerate the audio and shot when possible. Do not do surgical audio edits unless the user explicitly asks for that.
- If a scene needs two characters interacting, generate them in one shot. Do not stitch two unrelated clips side by side.
- Preserve props across shots with repeated descriptors: same desk material, same edge position, same shirt, same jewelry, same lighting.
- Version all outputs: `shot_name_v01.mp4`, `shot_name_v02.mp4`, `final_v07_backup.mp4`, etc.

## Helper Script

Use `scripts/muapi_seedance_job.py` for upload, submit, poll, and download. Read it only if you need to patch behavior.

Examples:

```bash
hive-env-run -- python3 Skills/muapi-seedance-video/scripts/muapi_seedance_job.py upload ref1.jpg ref2.jpg --state state.json
hive-env-run -- python3 Skills/muapi-seedance-video/scripts/muapi_seedance_job.py submit --endpoint seedance-2.0-omni-reference --payload payloads/shot01.json --state state.json --download outputs/shot01.mp4
```

## References

- `references/muapi-payloads.md` for exact payload examples and result shapes.
- `references/production-notes.md` for character, desk, robot partner, cash, and replacement-shot lessons.
