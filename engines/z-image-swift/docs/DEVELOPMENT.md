# Development

This document covers the current contributor workflow: build, test, format, release, and the targeted validation paths that still matter in this repo.

## Build

This repo supports two build toolchains:

- `xcodebuild` for production/release builds (matches CI packaging)
- SwiftPM (`swift build` / `swift test`) for rapid iteration and tests

### Production / Release Builds (xcodebuild)

Default release-path build (matches CI packaging):

```bash
./scripts/build.sh
```

`scripts/build.sh` is a thin `xcodebuild` wrapper that:

- validates `xcodebuild`/`xcrun`/`xcode-select` are configured
- ensures the Metal compiler tools (`metal`, `metallib`) are available
  - if missing, it attempts `xcodebuild -downloadComponent MetalToolchain`
- enables non-interactive SwiftPM build-tool plugins for Xcode builds (MLX shader preparation)
- builds all workspace schemes except `*-Package` (override via `SCHEMES=...`)

Common overrides:

```bash
DERIVED_DATA_PATH=./dist ./scripts/build.sh
CONFIGURATION=Debug ./scripts/build.sh
SCHEMES="ZImageCLI ZImageServe" ./scripts/build.sh
DESTINATION='platform=macOS,arch=arm64' ./scripts/build.sh
```

Equivalent explicit command (single scheme):

```bash
xcodebuild build \
  -scheme ZImageCLI \
  -configuration Release \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath .build/xcode \
  -skipPackagePluginValidation \
  ENABLE_PLUGIN_PREPAREMLSHADERS=YES \
  CLANG_COVERAGE_MAPPING=NO
```

Built binaries land under:

- `.build/xcode/Build/Products/<Debug|Release>/`

### Rapid Development Builds (SwiftPM)

SwiftPM is the fast path for tests and local development builds:

```bash
./scripts/verify_fast.sh
swift build --product ZImageServe
```

Important: `mlx-swift`'s SwiftPM build does **not** emit a default Metal shader library.
The first time you run a SwiftPM-built executable (including via `swift run`), it can fail until you build and install `mlx.metallib` next to the binary:

```bash
swift build -c debug --product ZImageCLI
./scripts/build_mlx_metallib.sh --configuration debug
.build/debug/ZImageCLI --help
```

`./scripts/build_mlx_metallib.sh` uses the Metal toolchain (`xcrun metal` / `xcrun metallib`). If those tools are missing, install the Xcode Metal toolchain component:

```bash
xcodebuild -downloadComponent MetalToolchain
```

The default repo path for production binaries is still the Xcode build above.

## Tests

Default verification path:

```bash
./scripts/verify_fast.sh
```

### SwiftPM sandbox guard

This repo vendors an in-process Seatbelt sandbox/tripwire (`swiftpm-sandbox-testing`) into the SwiftPM executable and test targets to prevent accidental host mutations during `swift test` / `swift run`.

By default it denies:

- filesystem writes outside the repo workspace (with temp-dir compatibility allowances), and
- outbound IP networking (unless explicitly enabled).

If you rely on an existing Hugging Face cache under `~/.cache/huggingface/hub`, set this in the invoking shell so cached snapshots remain discoverable even though `HOME` is redirected by the guard:

```bash
HF_HUB_CACHE="$HOME/.cache/huggingface/hub" ./scripts/verify_fast.sh
```

Use `SWIFTPM_SANDBOX_SELFTEST=1` to assert the guard is active at process startup.

The MLX-backed test support prepares the SwiftPM metallib automatically on demand, and the opt-in E2E suite builds the SwiftPM `ZImageCLI` product automatically when needed.

Heavier test suites are opt-in:

- `ZImageIntegrationTests`: require real model weights
- `ZImageE2ETests`: build and execute the CLI

Enable the heavier suites explicitly:

```bash
HF_HUB_CACHE="$HOME/.cache/huggingface/hub" ZIMAGE_RUN_INTEGRATION_TESTS=1 ./scripts/verify_fast.sh --filter PipelineIntegrationTests
HF_HUB_CACHE="$HOME/.cache/huggingface/hub" ZIMAGE_RUN_INTEGRATION_TESTS=1 ./scripts/verify_fast.sh --filter ControlNetIntegrationTests
HF_HUB_CACHE="$HOME/.cache/huggingface/hub" ZIMAGE_RUN_INTEGRATION_TESTS=1 ./scripts/verify_fast.sh --filter LoRAIntegrationTests
HF_HUB_CACHE="$HOME/.cache/huggingface/hub" ZIMAGE_RUN_INTEGRATION_TESTS=1 ./scripts/verify_fast.sh --filter PerformanceTests
HF_HUB_CACHE="$HOME/.cache/huggingface/hub" ZIMAGE_RUN_E2E_TESTS=1 ./scripts/verify_fast.sh --filter CLIEndToEndTests
HF_HUB_CACHE="$HOME/.cache/huggingface/hub" ZIMAGE_RUN_E2E_TESTS=1 ./scripts/verify_fast.sh --filter ServeEndToEndTests
```

`ZImageE2ETests` use the `ZImageCLI` executable built by the same SwiftPM stack as `swift test`. They do not invoke `xcodebuild` internally.
The same preparation flow now builds `ZImageServe` on demand for the staging-daemon E2E checks.

Additional integration-test knobs:

- `ZIMAGE_BASE_SMOKE_MODEL`: optional local override for the Base smoke test snapshot path
- `ZIMAGE_TEST_LORA_PATH`: optional local LoRA path override for `LoRAIntegrationTests`
  - Recommended when running under the SwiftPM sandbox guard: LoRA tests can default to a Hugging Face LoRA repo id, and networking is denied by default.

### Opt-In Base Smoke Test

For a real-model Base sanity check without enabling the full integration suite by default:

```bash
HF_HUB_CACHE="$HOME/.cache/huggingface/hub" \
ZIMAGE_RUN_INTEGRATION_TESTS=1 \
ZIMAGE_RUN_BASE_SMOKE=1 \
ZIMAGE_BASE_SMOKE_MODEL="$HOME/.cache/huggingface/hub/models--Tongyi-MAI--Z-Image/snapshots/04cc4abb7c5069926f75c9bfde9ef43d49423021" \
./scripts/verify_fast.sh --filter PipelineIntegrationTests/testBaseModelSmokeGeneration
```

Notes:

- `ZIMAGE_RUN_BASE_SMOKE=1` is required; otherwise the test skips.
- `ZIMAGE_BASE_SMOKE_MODEL` is optional. When omitted, the test uses `Tongyi-MAI/Z-Image` and resolves it through the normal cache/download path.
  - When running under the SwiftPM sandbox guard, set `HF_HUB_CACHE="$HOME/.cache/huggingface/hub"` so resolution uses your existing cache instead of attempting a download (network is denied by default).

## CI And Packaging

Current CI behavior:

- triggers:
  - pull requests: run the SwiftPM verification job
  - pushes to `main`: run verification, then build/package/release the nightly artifact
- runner: `macos-latest`
- Xcode: `16.0`
- artifact: `zimage.macos.arm64.zip`
- release target: GitHub prerelease tag `nightly`
- smoke checks:
  - `./scripts/verify_fast.sh`
  - `ZImageCLI --help` from the packaged release directory after `default.metallib` is copied alongside the binary

Source of truth:

- `.github/workflows/ci.yml`

If you change build flags, artifact names, or release semantics, update this doc, the workflow, and the root `README.md` together.

## Docs Expectations

When user-visible behavior changes, update the docs in the same patch:

- CLI behavior: `README.md`, `docs/CLI.md`, `Sources/ZImageCLI/main.swift`
- model loading or cache behavior: `docs/MODELS_AND_WEIGHTS.md`
- code structure and ownership: `docs/ARCHITECTURE.md`
- build/test/release workflow: this file and `.github/workflows/ci.yml`

Prefer one detailed explanation in `docs/` and link to it rather than duplicating long prose in multiple places.

## Targeted Validation

### Control-Memory Validation

When changing `ZImageControlPipeline`, ControlNet loading, or the VAE encode/decode path, use the retained high-resolution probe:

```bash
./scripts/verify_fast.sh
SCHEMES=ZImageCLI CONFIGURATION=Debug ./scripts/build.sh
.build/xcode/Build/Products/Debug/ZImageCLI control \
  --prompt "memory validation" \
  --control-image images/canny.jpg \
  --controlnet-weights alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1 \
  --control-file Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors \
  --width 1536 \
  --height 2304 \
  --steps 1 \
  --log-control-memory \
  --no-progress \
  --output /tmp/zimage-control-memory-check.png
```

Watch these markers:

- `control-context.after-baseline-reduction`
- `control-context.after-eval`
- `control-context.after-clear-cache`
- `transformer.denoising-load.after-apply`
- `controlnet.denoising-load.after-apply`
- `decode.after-eval`

Current retained policy:

- keep `--log-control-memory` as the public probe
- keep transformer, ControlNet, and active LoRA state absent until denoising is about to start
- load the control-path VAE encoder on demand and unload it immediately after the typed control context is materialized
- clear MLX cache before denoiser modules are loaded
- keep incremental ControlNet hint accumulation
- keep query-chunked VAE self-attention enabled by default

Current measured status from the March 8, 2026 follow-up run:

- high-resolution `1536x2304` control-context residency after cache clear stayed around `315 MiB`
- the remaining large jump happens at the deferred denoiser load boundary, not during control-context storage
- the retained high-resolution probe still peaked around `59.3 GiB` process footprint

The current follow-up summary lives in [dev_plans/controlnet-memory-followup.md](dev_plans/controlnet-memory-followup.md).

### Staging-Daemon Warm-Serving Validation

When changing `ZImageServe`, the CLI shared layer, or the serving residency policy, keep a repeated-request probe in the loop:

```bash
SCHEMES=ZImageServe CONFIGURATION=Debug ./scripts/build.sh
SOCKET=/tmp/zimage-serve-stage.sock
.build/xcode/Build/Products/Debug/ZImageServe serve \
  --socket "$SOCKET" \
  --residency-policy adaptive \
  --warm-model mzbac/z-image-turbo-8bit &

.build/xcode/Build/Products/Debug/ZImageServe --socket "$SOCKET" \
  -p "a red apple on black velvet" \
  -m mzbac/z-image-turbo-8bit \
  -W 256 -H 256 -s 1 --no-progress \
  -o /tmp/zimage-stage-1.png

.build/xcode/Build/Products/Debug/ZImageServe --socket "$SOCKET" \
  -p "a red apple on black velvet" \
  -m mzbac/z-image-turbo-8bit \
  -W 256 -H 256 -s 1 --no-progress \
  -o /tmp/zimage-stage-2.png
```

Watch for these indicators in the daemon log:

- the resident worker is reused for both requests
- `Model already loaded, skipping load` appears on the matching requests
- heavy-module load markers do not repeat unless the worker was evicted

Current measured status from the March 13, 2026 validation run on the local cached `mzbac/z-image-turbo-8bit` profile:

- daemon prewarm loaded the transformer once before serving
- first staged `256x256`, `1`-step request completed in about `4s`
- second matching request completed in about `1s`
- daemon log counts:
  - `Loading transformer`: `1`
  - `Model already loaded, skipping load`: `2`
  - `Reusing resident text worker`: `2`

Also keep the staging-daemon lifecycle suite in the loop:

```bash
HF_HUB_CACHE="$HOME/.cache/huggingface/hub" ZIMAGE_RUN_E2E_TESTS=1 ./scripts/verify_fast.sh --filter ServeEndToEndTests
```

Current measured status from the March 13, 2026 operational validation run:

- `ServeEndToEndTests`: `7` tests passed in about `2.1s`
- manual cancel probe against cached `mzbac/z-image-turbo-8bit`:
  - `status` reported the active job id while the request was running
  - `cancel` acknowledged the active job immediately
  - the submitting client exited non-zero after receiving the cancellation event

### Numerical-Parity Work

If you are chasing Swift vs Python or Diffusers drift, read:

- [golden_checks.md](golden_checks.md)
- [context/zimage_runtime_precision_parity_report.md](context/zimage_runtime_precision_parity_report.md)

Those docs are the current background set for parity and precision work.

## Performance Notes

These models are large. First-time downloads can be tens of GB, and higher resolutions still stress unified memory. Historical investigations live under `docs/debug_notes/` and `docs/archive/`; the current operating summary lives in [dev_plans/controlnet-memory-followup.md](dev_plans/controlnet-memory-followup.md).
