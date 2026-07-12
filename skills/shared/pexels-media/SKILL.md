---
name: pexels-media
description: Use when the user needs Pexels photo or video search, stock footage discovery, asset download/caching, orientation or duration filtering, media attribution capture, or to add Pexels as a reusable media source in a project.
---

# Pexels Media

Use Pexels as a stock media source without copying secrets into a repo.

## Env

- Read `PEXELS_API_KEY` or `PEXELS_API_KEYS` from `~/.hivemindos/.env`.
- Use `hive-env-check PEXELS_API_KEY` or `hive-env-check PEXELS_API_KEYS` to verify presence.
- Never print the key.

## Workflow

1. Turn the user's topic into 1-5 concrete visual search terms.
2. Choose media type:
   - Videos: `https://api.pexels.com/videos/search`
   - Photos: `https://api.pexels.com/v1/search`
3. Apply constraints from the task: `orientation`, `size`, `locale`, minimum duration, resolution, aspect ratio, and count.
4. Prefer assets that already match the target orientation and resolution. Avoid heavy post-crop if matching media exists.
5. Download into a cache directory using a stable URL hash filename.
6. Save sidecar metadata when useful: provider, query, source URL, photographer, Pexels page URL, license note, downloaded file path.
7. Validate before returning:
   - Video: `ffprobe` shows a video stream, positive duration, expected dimensions or aspect.
   - Image: inspect dimensions with an image library or `sips -g pixelWidth -g pixelHeight`.

## Notes

- Use HTTPS with TLS verification on.
- Treat Pexels URLs as third-party remote input; validate media before passing it into render tools.
- If a search returns weak results, try adjacent terms rather than lowering validation standards.
- Return local paths and metadata, not raw API responses unless the user asks.
