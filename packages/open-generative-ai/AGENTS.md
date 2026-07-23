# Agent Instructions for Open Generative AI

## Multi-platform support is mandatory

This app must continue to support macOS, Windows, Linux, and remote/provider-backed runtimes wherever existing code already does.

When adding platform-specific optimizations, such as MLX/Metal/MPS paths for Apple Silicon, CUDA paths for NVIDIA, DirectML/CPU paths for Windows, or GGUF/sd.cpp paths for portable local inference:

- Do **not** outright replace or remove existing platform methods.
- Add optimized paths as additive providers, adapters, feature flags, or runtime-selected branches.
- Preserve existing Windows/Linux/macOS behavior unless a change is intentionally cross-platform and verified.
- Keep provider selection explicit and fallback-safe: if an optimized backend is unavailable, the app should fall back to the previous supported backend or show a clear actionable error.
- Avoid baking Apple-only assumptions into shared UI, model catalogs, IPC contracts, or generation parameter shapes.
- When changing local inference, test or reason through at least:
  - packaged Electron app behavior,
  - source/dev Electron behavior,
  - macOS Apple Silicon,
  - non-Apple platforms that depend on the existing sd.cpp/Wan2GP/API paths.

In short: **optimize per platform, but preserve all existing platform paths.**

## Iterate on the dev server, not on builds

Default to the vite dev server for ALL frontend iteration — run the
`open-generative-ai` launch config (port 5173). Its proxies make it fully
functional against the live local stack with no owner unlock and no build:
`/api` → the studio control API (127.0.0.1:8765) and `/local-ai` → the
loopback hosted bridge (127.0.0.1:8794, ungated).

Run `npm run vite:build` ONLY when the user explicitly asks for a build or to
deploy changes to the served app (8765 / the Tailscale HTTPS URL on 8789 —
both serve the prebuilt `dist/`, so remote browsers only see built output).
Do not make the user wait through build+restart cycles to review UI work:
verify on the dev server first, build once at the end when asked.

## Privacy is a hard boundary — client-only data, existing encryption only

No prompt, image, image metadata, workflow graph, prompt-helper text, or
generation-parameter data may ever be visible to anyone except the client
(the owner's unlocked browser/session). This is non-negotiable and applies to
every new feature, endpoint, log line, job record, and history entry.

Any new logic MUST comply with the encryption and redaction machinery that
already exists — never invent a parallel path around it:

- Media outputs at rest: encrypt via the gateway's existing output encryption
  (`encrypt_outputs` in `packages/media-gateway/app.py`, `.zenc` sidecars);
  serve only through the token/owner-gated decrypt routes.
- Prompts in job records, history, and logs: store `PRIVATE_PROMPT_LABEL`
  (or equivalent redaction), never raw prompt text.
- ComfyUI traffic: prompt graphs and history pass through the existing
  redaction layers (server.js / app.py `/queue`,`/history`,`/object_info`
  interception, encrypted workflow envelopes). New proxies must reuse them.
- Studio server data: owner-gated behind the signed-cookie boundary in
  `src/hivemind_content_studio/private_access.py`; private fields use its
  cipher (`enc:v1` sealed manifests/sidecars).
- Never write prompts, workflows, or media paths into shared telemetry,
  shared-brain memory, run registries, or error messages that leave the
  machine.

If a change cannot satisfy these constraints with the existing mechanisms,
stop and ask before shipping it.
