---
name: video-render-qa
description: Use when verifying generated videos, shorts, reels, rendered MP4 files, subtitles, audio streams, dimensions, duration, nonblank frames, frame extraction, or final media QA before delivery or publishing.
---

# Video Render QA

Verify a rendered video before calling it done.

## Checks

1. File exists and has nonzero size.
2. `ffprobe` shows:
   - video stream
   - expected width and height
   - positive duration
   - expected codec or platform-safe codec
   - audio stream when narration/music is expected
3. Extract at least one frame from the middle of the video.
4. Visually inspect or image-check that the frame is not blank.
5. If subtitles are burned in, inspect a subtitle frame for placement and legibility.
6. If serving through an API, request the output URL and confirm HTTP 200 plus expected byte size.

## Useful Commands

```bash
ffprobe -v error -show_entries format=duration,size -show_entries stream=index,codec_type,codec_name,width,height,avg_frame_rate -of json "$VIDEO"
ffmpeg -y -loglevel error -ss 00:00:02 -i "$VIDEO" -frames:v 1 /tmp/render-frame.jpg
```

## Report

Summarize the actual file path, duration, dimensions, codecs, and any remaining risk. Do not overclaim quality from metadata alone.
