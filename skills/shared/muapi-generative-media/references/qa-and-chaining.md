# QA And Chaining

MUAPI generations are usually one stage in a larger media pipeline. Preserve good outputs, record request IDs, and verify through the real user path.

## Run Manifest

Keep a lightweight manifest in the run folder:

```json
{
  "project": "short-video-v08",
  "created_at": "2026-06-28T15:00:00+08:00",
  "uploads": {},
  "requests": {},
  "selected_outputs": {}
}
```

`scripts/muapi_general.py --state state.json` maintains `uploads` and `requests`. Add human selections manually when the user picks a winner.

## Image QA

1. Open or display the downloaded file.
2. Check identity, pose, hands, text, product geometry, legibility, and framing.
3. If compositing into video, confirm aspect ratio and edge crop before animating.
4. Keep rejected variants if they help future prompting; do not overwrite a good backup.

## Video QA

Run basic media inspection:

```bash
ffprobe -hide_banner -i outputs/shot_v01.mp4
```

Check:

- duration matches the spoken line or expected scene length
- frame rate is consistent with neighboring clips
- audio exists or is intentionally absent
- no black/blank frames
- no repeated/generated extra speech
- lip motion aligns with approved audio
- framing and props stay consistent across shots

For final or user-visible video, load `video-render-qa` and run its screenshot/contact-sheet checks.

## Audio QA

Before video generation:

- Listen to the clip.
- Confirm exact text, speaker, delivery, and no clipped starts/ends.
- Normalize sample rate/codec before concatenation or muxing.
- Add silence padding at the tail when the video model has a minimum duration.

## Chaining Rules

- TTS first, then lip-sync/video. Do not spend video credits on unapproved dialogue.
- Generate two-character interaction in one shot when their physical relationship matters.
- For repeated character scenes, create an identity/reference asset first and reuse it.
- For repeated set/desk/prop scenes, create an anchor still and reuse it.
- For replacements, generate standalone inserts with enough handles for editing.
- For final assembly, use `generated-short-assembly-qa` and avoid overwriting the latest good backup.

## Final Delivery Notes

Report:

- local output path
- request ID or result URL
- which model/endpoint was used
- what was verified
- what remains subjective for the user to judge

Never include secrets or raw shared-env values.
