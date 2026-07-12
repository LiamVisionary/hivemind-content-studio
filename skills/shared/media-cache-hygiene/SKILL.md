---
name: media-cache-hygiene
description: Use when creating, inspecting, cleaning, or reusing media caches for downloaded stock footage, images, audio, generated assets, URL-hashed files, corrupted cache entries, provider metadata, or deterministic media reuse across video workflows.
---

# Media Cache Hygiene

Keep reusable media caches reliable and non-mysterious.

## Pattern

- File name: stable hash of canonical source URL or generation prompt ID.
- Sidecar metadata: same basename with `.json`.
- Validate before reuse, not only after download.
- Delete corrupt zero-byte or unreadable cache files.

## Metadata

Track useful fields:

- provider
- source_url
- page_url
- query
- downloaded_at
- original_width / original_height
- duration
- license_note
- local_path
- validation_result

## Validation

- Video: `ffprobe` must find video stream, positive duration, dimensions, and readable frames.
- Audio: `ffprobe` must find audio stream and positive duration.
- Image: nonzero file size and readable dimensions.

## Guardrails

- Never put API keys in cache metadata.
- Do not assume an existing cache file is valid.
- Prefer pruning only files the cache owns. Avoid broad deletes outside the cache directory.
