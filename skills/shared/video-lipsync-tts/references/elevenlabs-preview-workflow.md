# ElevenLabs Preview Workflow

Use this as a reusable pattern for generating line-level previews before video generation.

## Manifest Shape

```json
[
  {
    "id": "01_intro",
    "speaker": "liam",
    "text": "This is a message to all white collar bros.",
    "delivery": "deadpan, confident, stern, authoritative, masculine, low pitch, deliberate pacing",
    "variants": 5
  },
  {
    "id": "06_robot_girl",
    "speaker": "robot_girl",
    "text": "My boyfriend.",
    "delivery": "natural feminine voice, higher pitch, affectionate, slightly stiff precision, no strong accent",
    "variants": 4
  }
]
```

Keep personal voice IDs outside this shared skill. Put them in the job script, local run manifest, or environment-specific config.

## Python Skeleton

Patch this into a run-specific script instead of storing project secrets in the skill.

```python
import json
import os
from pathlib import Path
import urllib.request

api_key = os.environ["ELEVENLABS_API_KEY"]
voice_id = "<voice id from the user or run config>"
model_id = "eleven_v3"
out_dir = Path("audio/previews")
out_dir.mkdir(parents=True, exist_ok=True)

payload = {
    "text": "This is a message to all white collar bros.",
    "model_id": model_id,
    "voice_settings": {
        "stability": 0.55,
        "similarity_boost": 0.85,
        "style": 0.2,
        "use_speaker_boost": True
    },
    "voice_prompt": "deadpan, confident, stern, authoritative, masculine, low pitch, deliberate pacing"
}

request = urllib.request.Request(
    f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
    data=json.dumps(payload).encode("utf-8"),
    headers={"xi-api-key": api_key, "Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=120) as response:
    (out_dir / "01_intro_deadpan.mp3").write_bytes(response.read())
```

Provider schemas change. If the request fails, fetch the current ElevenLabs docs or inspect the error, then adjust the run-specific script. Do not remove the preview step.

## Preview Naming

Use names that make side-by-side listening easy:

```text
01_intro_deadpan_authoritative.mp3
01_intro_low_stern_slow.mp3
02_name_low_authoritative_deliberate_pause.mp3
05_job_flat_authoritative.mp3
06_robot_girl_high_feminine_precise.mp3
```

## Exact-Line QA

Before passing audio to video:

- Listen to the first and last half-second.
- Confirm names and articles: "Liam", "a message", "white collar", etc.
- Confirm no repeated words: "AI AI", duplicated titles, or stutters.
- Confirm no missing words from clipped starts.
- Confirm no extra tag text was spoken.
- Confirm the delivery matches the user's direction.

## Preparing For Video

Normalize all approved clips before muxing or upload:

```bash
ffmpeg -y -i input.mp3 -ar 48000 -ac 2 -c:a aac normalized.m4a
```

Pad silence when needed:

```bash
ffmpeg -y -i line.mp3 -af "apad=pad_dur=0.6" -ar 48000 -ac 2 line_padded.m4a
```

For MUAPI, upload the approved audio and use the returned URL in `audio_files`.
