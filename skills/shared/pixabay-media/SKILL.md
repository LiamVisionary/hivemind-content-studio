---
name: pixabay-media
description: Use when the user needs Pixabay photo, illustration, vector, music, or video search; reusable Pixabay asset downloads; stock-media fallback after Pexels; or adding Pixabay media retrieval to a project.
---

# Pixabay Media

Use Pixabay as a stock media source or fallback provider.

## Env

- Read `PIXABAY_API_KEY` or `PIXABAY_API_KEYS` from `~/.hivemindos/.env`.
- Use `hive-env-check PIXABAY_API_KEY` or `hive-env-check PIXABAY_API_KEYS` to verify presence.
- Never print the key.

## Workflow

1. Convert the topic into concise visual search terms.
2. Pick the endpoint:
   - Videos: `https://pixabay.com/api/videos/`
   - Images: `https://pixabay.com/api/`
3. Set task-appropriate parameters: `q`, `video_type`, `image_type`, `orientation`, `category`, `safesearch=true`, `per_page`, and `lang`.
4. For videos, choose the smallest rendition that satisfies the target resolution to avoid waste.
5. Download into a stable URL-hash cache and keep provider metadata.
6. Validate:
   - Video: `ffprobe` stream, dimensions, duration, readable frames.
   - Image: dimensions and nonzero size.
7. Return local paths, provider metadata, and any source URLs needed for attribution.

## Notes

- Keep Pexels and Pixabay skills separate when wiring provider-specific API shapes.
- A broader stock-media router can call both skills and rank candidates, but each provider should keep its own query and quality rules.
- Do not silently use copyrighted or non-stock sources as fallback.
