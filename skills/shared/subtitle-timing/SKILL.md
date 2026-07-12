---
name: subtitle-timing
description: Use when converting TTS timings, word timestamps, sentence timings, or audio transcription into SRT/VTT subtitles; aligning subtitles to narration; falling back to Whisper-style transcription; or preparing subtitles for burned-in short videos.
---

# Subtitle Timing

Generate subtitle files that line up with narration.

## Preferred Sources

1. TTS provider timestamps or marks.
2. Forced alignment output.
3. Transcription timestamps from Whisper or a similar local/remote ASR.
4. Duration-based sentence splitting only as a last resort.

## Workflow

1. Normalize script text before alignment: trim whitespace, collapse repeated spaces, preserve punctuation.
2. Split into readable subtitle chunks:
   - Prefer phrases or short sentences.
   - Avoid huge full-screen blocks.
   - Keep line breaks intentional.
3. Write `.srt` or `.vtt` with monotonic, non-overlapping timestamps.
4. Validate by parsing the subtitle file back into cues.
5. If burning into video, render a sample frame to check legibility and placement.

## Fallback

If the TTS engine returns audio but no timing:

1. Transcribe the generated audio.
2. Correct obvious transcript drift against the original script.
3. Preserve the original script text when the transcript only differs by punctuation or casing.

## Guardrails

- Do not fabricate precise word timings when only rough duration exists; call them approximate.
- If audio duration and subtitle end time differ meaningfully, fix alignment before final render.
