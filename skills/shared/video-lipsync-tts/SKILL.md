---
name: video-lipsync-tts
description: Create, preview, select, and prepare TTS voice lines for AI video lip syncing, especially ElevenLabs v3-style delivery prompting, user-provided voice IDs, natural robot voices, deadpan authoritative narration, line-exact audio clips, silence padding, and passing approved audio into MUAPI/Seedance or other generated-video workflows. Use when the user asks for lip sync, voice clips, ElevenLabs, TTS previews, "use my voice", "make her voice higher", "line is clipped", "audio blips", or exact spoken dialogue in generated videos.
---

# Video Lip Sync TTS

Use this skill before generating lip-synced video shots. The goal is not "some voiceover"; it is exact, previewable, line-level audio that the user can approve before expensive video generation.

## Safety And Setup

1. Check credentials by name only:
   ```bash
   hive-env-check ELEVENLABS_API_KEY
   ```
2. Use shared env:
   ```bash
   hive-env-run -- python3 <tts-script>.py
   ```
3. Do not upload private user voice clips to external ASR or cloning services unless the user explicitly approves that specific upload.
4. Do not hardcode personal voice IDs into shared skills. Store provided voice IDs in the run manifest or script for that job.

## Workflow

1. Split the script into atomic lines. One line should map to one video shot whenever lip sync matters.
2. Preserve exact text. Fix "a" vs "the", names, repeated words, and clipped phrases before generating audio.
3. Generate 3-6 delivery variants for important lines. Name them descriptively:
   ```text
   01_intro_deadpan_authoritative.mp3
   02_name_low_deliberate_pause.mp3
   05_job_flat_authoritative.mp3
   ```
4. Deliver previews before video generation. Let the user pick the winning variants.
5. For each approved line, normalize to MP3 or WAV and record:
   - line id
   - exact text
   - voice id or provider voice name
   - delivery prompt
   - local path
   - uploaded URL if used by MUAPI
6. If a line is shorter than the video model minimum duration, pad silence after the line rather than stretching speech.
7. Feed the approved audio into video generation:
   - MUAPI Seedance Omni: `audio_files: ["<audio_url>"]`
   - Higgsfield Cloud Seedance: follow `higgsfield-api-quirks` for its `input_audio` shape
   - Consumer Higgsfield CLI: use the CLI audio flag only if the selected model supports it
8. After video generation, listen for:
   - wrong article/name/word
   - repeated words
   - clipped starts or endings
   - long unnatural pauses
   - blips after concatenation
   - invented speech after the provided line

## Delivery Defaults

For stern founder-style male narration:

```text
deadpan, confident, stern, authoritative, masculine, low pitch, deliberate pacing, dry delivery, no smile in the voice
```

For a mostly-human robot woman:

```text
natural feminine voice, slightly higher pitch, calm and affectionate, just a little stiff or precise, no strong accent, not a harsh robotic filter
```

Use paralinguistic tags sparingly. Tags can affect timing or be spoken by some providers if used incorrectly. Preview every tagged line.

## Timing Rules

- Avoid obvious surgical cuts unless explicitly requested.
- If a line has a bad pause, regenerate that line with a revised delivery prompt. Do not remove the pause with a hard cut unless the user asks for that style of fix.
- If a line gets clipped at the beginning, prepend 100-250 ms of silence before the speech.
- If concatenated audio blips between scenes, normalize all clips to the same sample rate and codec before muxing.
- Keep final video shot duration slightly longer than the approved line so mouth motion can settle.

## References

- `references/elevenlabs-preview-workflow.md` for script skeletons, prompt examples, and exact-line QA.
