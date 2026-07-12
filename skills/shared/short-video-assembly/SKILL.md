---
name: short-video-assembly
description: Use when the user wants to assemble a short-form MP4 from narration audio, stock/local clips, subtitles, music, or images; render vertical/horizontal/square shorts; concatenate clips to match audio; mux audio; burn subtitles; or build reusable video composition code.
---

# Short Video Assembly

Create a finished short video from script assets.

## Inputs

- Audio file, usually narration.
- One or more validated video/image materials.
- Optional `.srt` subtitles.
- Target aspect: `9:16`, `16:9`, or `1:1`.
- Optional background music, title card, watermark, or platform constraints.

## Workflow

1. Probe inputs with `ffprobe`; reject unreadable media.
2. Determine target duration from narration unless the user specifies otherwise.
3. Select and trim clips to cover the full duration.
4. Normalize dimensions:
   - `9:16`: 1080x1920
   - `16:9`: 1920x1080
   - `1:1`: 1080x1080
5. Crop/scale with center or subject-aware framing. Avoid stretching.
6. Concatenate clips with ffmpeg concat or MoviePy, depending on the project stack.
7. Mux narration audio. Duck background music if present.
8. Burn subtitles only when requested or when platform output needs them.
9. Export H.264/AAC MP4 unless the target platform requires another codec.
10. Run `video-render-qa` before delivery.

## Defaults

- Short social videos should default to `9:16`.
- Keep transitions simple unless the user asks for a style.
- Avoid auto-posting. Rendering and publishing are separate actions.
