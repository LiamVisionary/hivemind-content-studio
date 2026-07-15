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
