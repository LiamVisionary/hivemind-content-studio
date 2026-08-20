# H3 still-image lane + client-side clip prep — assimilation plan

Four donors were evaluated together because they converge on one workflow: **prepare a reference,
generate a still or a shot from it.** Three contribute; one is ideas-only; one is rejected outright.

| Donor | License | Verdict | What we take |
| --- | --- | --- | --- |
| [thaakeno/ComfyUI-MiniMax-H3-Studio](https://github.com/thaakeno/ComfyUI-MiniMax-H3-Studio) `v0.1.0-alpha.20` | MIT | **Fork + strip** | The `H3Studio*` node runtime (H3 as a still-image model) |
| [Tr1dae/ComfyUI-QuickClip](https://github.com/Tr1dae/ComfyUI-QuickClip) | MIT | **Client JS only, no Python** | `web/js/quickclip_timeline.js` interaction model; `detect.py` as algorithm reference |
| Nugget Video Trimmer (`PoopMan333/Video_Tools` on HF) | **none** | **Spec only, no code** | Published feature list only — see licence note |
| [OpenShot/openshot-qt](https://github.com/OpenShot/openshot-qt) | GPL-3.0 / LGPL-3.0 | **Rejected** | Project schema as a design reference |
| [Adudeguyman/ComfyUI-Fantastic-MiniMaxH3-PromptBuilder](https://github.com/Adudeguyman/ComfyUI-Fantastic-MiniMaxH3-PromptBuilder) | MIT | **Rules only, no install** | The documented H3 reference budget; picture-role → retention-marker mapping |
| [Adudeguyman/Fantastic-Upgraded-Captioning-Kit](https://github.com/Adudeguyman/Fantastic-Upgraded-Captioning-Kit) | MIT | **Deferred** | Dataset prep / captioning — a training-side concern, not a studio one |

## Licence notes

This repo is AGPL-3.0-or-later. GPLv3 §13 permits combining GPLv3 with AGPLv3, so OpenShot was never
blocked on licence — it is rejected on architecture (below). MIT donors are freely adaptable with
notice retention (`THIRD_PARTY_NOTICES.md` + per-file provenance headers).

**Nugget Video Trimmer publishes no licence**, on the HF repo or in the file. Absent a licence grant,
default copyright applies and the code is **not reusable here at any scale**. Its author described the
feature set publicly in the r/StableDiffusion post; feature sets are not copyrightable, so that list is
taken as a *specification* and implemented independently on our existing `mediabunny` dependency. No
Nugget code is read into, copied into, or vendored by this repo.

## Security audit (blocking, completed before any install)

Both ComfyUI donors register routes on `PromptServer`, which has **no authentication** — anything that
can reach the Comfy port can call them. This is the same exposure class as the LTXDirector pack, which
already forced a fork once.

### H3 Studio — 4 unsafe routes, 2 safe

| Route | Finding |
| --- | --- |
| `POST /h3studio/dependencies/pdd/install` | runs `git clone`/`fetch` — unauthenticated RCE by design |
| `POST /h3studio/dependencies/llama/install` | installs llama-cpp |
| `POST /h3studio/face-refine/install` | installs detector/SAM deps |
| `POST /h3studio/history/{upsert,favorite}` | unauthenticated disk writes |
| `GET /h3studio/thumbnail` | **safe** — `_safe_image_path()` resolves then asserts the path is under input/output/temp |
| `GET /h3studio/loras` | **safe** — enumerates `folder_paths.get_filename_list("loras")` only |

> **Correction (2026-08-19).** The first pass of this audit read only the modules GitHub code search
> surfaced and undercounted. A full clone shows **sixteen** routes across **eight** modules, not six
> across four: `dependency_web.py`, `llama_cpp_dependency.py`, `history_library.py`,
> `face_refine/setup.py`, `web_routes.py`, `runtime_web.py`, `comfy_compat.py` and
> `history_fast_restore.py`. The extra ones are status/capability reads plus
> `/h3studio/history/{item,library,rebuild}`. The verdict is unchanged and the remedy got simpler:
> every registration happens in one place, so ALL of it goes rather than a chosen four.

**Action (implemented in `gpu_rentals.py`):** clone the pinned tag and strip the whole HTTP surface
rather than a subset. All seven `register_*_routes()` calls sit together at `h3studio/extension.py`
140-146 and the eighth is `register_fast_history_restore_route()` in `__init__.py`, so a two-line sed
removes every route; `WEB_DIRECTORY` is dropped so no frontend is served at all, and `web/` (13 MB of
demo art) goes with it. We drive the Director's widgets over the MCP and never load its UI, so the
routes were only ever liability. The `install_*()` calls are deliberately KEPT — they patch
prompt/reference/PNG integrity, not the UI. The strip ends with a `grep` that fails the box loudly if
any registration survived, because a silently-unstripped pack is the failure worth catching. Pin
telemetry off (`H3STUDIO_TELEMETRY=0` *and* the `.h3studio-telemetry-disabled`
sentinel file — belt and braces, since the env var does not survive a launchd child env; see
`stack-env-vars-need-stack-local-env`). Models are stocked via our own R2 flow, so the installer
endpoints are pure loss anyway.

### QuickClip — arbitrary file read, do not install the Python side

`media_handler` reads `?path=` from the query string and passes it to `require_video_path()`, which
checks only existence and file extension before `p.resolve()` — **no confinement to any allowed root** —
then serves the file with `web.FileResponse`. `listdir_handler` passes an arbitrary path to
`list_directory()`, which enumerates any directory, plus `list_windows_drives()` on Windows.

```
GET  /quickclip/media?path=/Users/<user>/anything.mp4    → serves it
POST /quickclip/listdir {"path": "/"}                    → enumerates it
```

**Action:** the QuickClip Python package is **not installed**. Beyond the vulnerability it is useless to
us: it is a host-filesystem browser, and our media is E2E-sealed at rest, so it could not read our clips
even if it were safe. Only `web/js/quickclip_timeline.js` (MIT, client-side) informs our interaction
model.

## Why OpenShot is rejected

Not a licence problem. Three architectural ones:

1. **`openshot-qt` is a PyQt desktop app.** Our studio is a React SPA served by `control_api` on :8765
   behind the owner gate. There is no embedding path.
2. **`libopenshot` does not package.** PyPI returns 404 for both `openshot` and `libopenshot`; it is a
   cmake + SWIG C++ build over a JUCE audio library. On Apple Silicon that is a from-source build we
   would own indefinitely.
3. **It inverts the privacy model.** `libopenshot` is a server-side library over plaintext files. Our
   clips are E2E-sealed at rest and the server holds no key — which is exactly why
   `src/lib/clipJoiner.js` does packet-copy concat *in the browser* via `mediabunny`. Routing frames
   through `libopenshot` means unsealing server-side.

What we keep is its **project schema as a design reference**: clips carrying `start`/`end`/`position`/
`layer`, properties keyframed as Bezier point lists, transitions modelled as mask clips. That is a
proven data model for the timeline below, and costs nothing to borrow.

## Phase 1 — Clip Prep (client-side, no GPU, no new dependency)

The Nugget feature set, QuickClip's "no round trip" property, and OpenShot's clip schema, implemented on
`mediabunny` — which we already depend on for `clipJoiner.js`.

Everything runs **in the browser**, which here is a requirement rather than a preference: sealed source
media can only be decrypted where the vault key lives.

| Capability | Source of the idea | Notes |
| --- | --- | --- |
| Trim (per-clip in/out) | Nugget, QuickClip | Extends the existing packet-copy path — lossless when cuts land on keyframes |
| Reorder / multi-clip | OpenShot schema | Grows `ChainTimeline.jsx` past its current single-chain model |
| Crop | Nugget | Re-encode path |
| Compress (resolution + fps) | Nugget | **The point of the feature** — see below |
| Single-frame grab | Nugget, QuickClip | Feeds the H3 start-frame slot |
| Storyboard (manual + auto) | Nugget, QuickClip `detect.py` | Auto-detect is explicitly "iffy" upstream; ships behind manual |
| GIF export | Nugget | Lowest priority |

### Why compression is the load-bearing feature

The Nugget author reports that resizing and compressing a reference video makes Ref2V materially
faster. That independently reproduces a measurement already in our own notes
(`h3-motion-reference-vram-ceiling`): the H3 reference budget is spent on `min(reference, clip)` length,
so a shorter, smaller reference frees the full generation range. Clip prep is therefore not a
convenience wrapper around the H3 reference lane — it is the front half of it, and the two ship
together.

Output routes straight into the H3 reference slots (`motion_context_*` for video refs — **never**
`video_*`, per `h3-scene-chaining`) with no server round trip.

## Phase 1b — the reference budget (landed 2026-08-18)

The Prompt Builder's headline feature is that it **flags when a run goes over H3's reference
limits**, counting total audio and video time across every source. We had none of that: the panel
enforced per-kind counts and nothing else, while its own hint text already claimed "2–15s each, 15s
combined" with nothing measuring it.

H3 rations references four ways at once. Only the first was visible here:

1. **Twelve references total.** Nine pictures plus three clips is exactly twelve — switch one clip's
   soundtrack on and you are at thirteen, because a split soundtrack is its own reference.
   Our limits were `{images: 9, audios: 3, videos: 3}`, which tops out at **fifteen**.
2. **Three audio clips**, and a split soundtrack is one of them — so three clips with sound spend the
   entire audio allowance before a voice clip is attached. Our `useAudio` toggle consumed no audio slot.
3. **2–15 seconds per clip.**
4. **15 seconds is the TOTAL for a kind, not a per-clip allowance.** Three 15-second clips is 45
   seconds and three times over; three clips only fit at about five seconds each.

And the one that is genuinely easy to miss: **a split soundtrack spends from both duration totals at
once.** A 12-second video with its audio on uses 12 of the 15 video seconds *and* 12 of the 15 audio
seconds, leaving 3 seconds of audio for everything else.

The rules are the donation; the implementation is ours (`referenceBudgetReport` in
`src/lib/h3References.js`, 10 tests in `tests/referenceBudget.test.js`). Nothing is installed — this
pack has the same unauthenticated-`PromptServer`-route shape as the others, and we only needed the
documented limits.

Durations are measured by `src/lib/mediaDuration.js`: a detached element with `preload="metadata"`
reads the container header without decoding a frame, which is why `probeClip` is *not* used here —
decoding nine references to read a number the container already carries would be absurd.

**Verified against real media**: a 7s clip with its soundtrack on, a 6s silent clip and a 9s voice
clip measure as video 13/15 (fine) and audio 16/15 (over) — the overage existing *only* because the
7 seconds are billed twice. That is the exact case the panel was previously blind to.

The report is **advisory and never removes anything**, deliberately: dropping a reference renumbers
every label after it and would silently invalidate `<Picture N>`/`<Video N>`/`<Audio N>` tags already
written into the prompt. The fix is a trim, which Clip Prep does without spending a slot — which is
why these two phases belong together.

### Prompt-writer improvements (same donor, folded into the existing profile)

No new helper — the improvements went into `prompt_profiles.py`, which already had the six-section
format, the `<Subject N>`/`<Picture N>` split and the audio copy family. What it lacked:

- **Which retention marker a picture ROLE takes.** The four markers were named; nothing said a pinned
  first/last frame is `fully_preserved`, an inherited setting is `partially_preserved`, one feature
  moved onto a subject is `attribute_transfer`, and composition/look/style/storyboard are
  `weak_reference`. That mapping is what actually decides whether a reference lands.
- **The visual task type.** We had `[audio reuse]`/`[audio reference]` but no
  `[keyframe completion]`/`[reference generation]` for the summary.
- The clarification that `attribute_transfer` is a retention marker only and never becomes a task type.
- An over-budget note in the inventory clause — and an explicit instruction *not* to renumber, since
  the labels must match what the graph sends.

The captioning kit is **deferred**, not rejected: it is a LoRA-dataset prepper (trim to MMH3 training
parameters, LLM captioning with per-dataset instructions). Real value, but it belongs to the training
pipeline rather than the studio, and nothing in the studio consumes it today.

## Phase 2 progress (2026-08-19)

**Landed:** the stripped-fork provisioning, in `gpu_rentals.py`'s H3 (`minimax`) tier — clone at
`v0.1.0-alpha.20`, remove every route registration, drop `WEB_DIRECTORY` and `web/`, disable telemetry
by both switches, then a guard that fails the box if any registration survived. Verified: the strip
applied to a real clone leaves `__init__.py` and `extension.py` parsing with zero registrations, and
the minimax onstart measures **14,029 / 16,384 bytes — 2,355 to spare** against Vast's cap.

**The blocker for the workflow itself.** `H3_Studio_Unified_Image.json` cannot be converted to API
format by reading it, because its sampler is not a node — it is a **ComfyUI subgraph**
(`5930b00d-…`), and API format has no subgraph concept. Expanded, that one box is six nodes:

```
H3StudioContextSamplingPreset ─ model/sampler/sigmas
BasicGuider ─ RandomNoise ─ SamplerCustomAdvanced ─ H3StudioDecode ─ H3StudioFrameSelector
```

So the real API graph is ten nodes, not five: Loader → Director → Condition → (those six) → SaveImage.
The full link map is recorded in the session notes.

Writing that graph by hand is the wrong move: several of these nodes build `INPUT_TYPES` dynamically
(the Director alone carries 61 widgets, and its per-reference inputs are generated in a loop), so
static analysis gives names that *look* right and are not. The correct source is ComfyUI's own
`/object_info`, which reports the exact schema of every registered node. That needs the stripped pack
loaded in a ComfyUI — either the local one on :8188 (needs a restart) or the first rented box.

**Still to do:** generate the API graph from `/object_info`; register `minimax-h3-image`
(`media_type: image`, `beta: true`) in the MCP registry; wire it into the React ImageStudio reusing
`h3References.js`; stock the W4A8 FL2VA/REF2VA weights, the 32B encoder and the H3 VAE to R2; verify
on a rental.

## Phase 2 — `minimax-h3-image` lane

H3 Studio does **not** ship a liftable graph. `example_workflows/H3_Studio_Unified_Image.json` is 20
nodes, 9 of which are sticky notes; the real graph is five custom nodes — `H3StudioLoader`,
`H3StudioCondition`, `H3StudioDirector`, `H3StudioLazyImageSwitch`, `H3StudioSaveImage`. There is no
`KSampler`, no `VAEDecode` and no text-encode node anywhere in it. All FL2VA/REF2VA routing, sampling,
frame selection and Face Refine lives inside `h3studio/nodes/image_runtime.py` (92 KB).

So this cannot be registered the way the LTX and Krea graphs were. Instead: install the stripped fork on
the H3 lanes and register an API-format workflow that drives `H3StudioDirector`'s widget inputs, with
**every optional input pinned explicitly** (`rented-comfy-custom-nodes-must-be-pinned`). Their
classic-Nodes-1.0 JS Director is not used — our React UI drives the node inputs over the MCP.

The reference vocabulary lines up exactly: H3 Studio addresses up to nine ordered references as
`@Image1`..`@Image9`, which is the grammar `src/lib/h3References.js`, the cast compiler and Persona ID
bundles already speak. Those light up on the image side for free.

**Blocked on:** stocking the W4A8 FL2VA/REF2VA weights, the 32B conditioning encoder and the H3 VAE to
R2, then a rental run to verify. `media_type: image` in the H3 family; `beta: true` while upstream is
alpha.

## Status

- [x] Security audit of both ComfyUI donors
- [x] Phase 1 — Clip Prep (trim, crop, compress, frame grab, storyboard)
- [ ] Phase 1 remainder — GIF export, auto scene-cut detection, multi-clip timeline
- [ ] Phase 2 — `minimax-h3-image` lane

### Phase 1 as landed (2026-08-18)

| File | Role |
| --- | --- |
| `src/lib/clipPrepPlan.js` | Pure planner — zero imports, so the arithmetic is testable without WebCodecs |
| `src/lib/clipPrep.js` | The mediabunny half — `probeClip` / `prepareClip` / `grabFrame`; **dynamic-import only** |
| `src/dialogs/ClipPrepDialog.jsx` | The UI; every number it shows comes from `planClip()` |
| `tests/clipPrepPlan.test.js` | 10 tests over the planner |
| `src/studios/video/ReferencesMenu.jsx` | Prep action on each video reference row |

The planner/transform split is load-bearing, not tidiness: `ReferencesMenu` imports the dialog
statically, so if the dialog reached mediabunny statically the whole studio chunk would carry it. Build
output confirms the split holds — `index` and `Menu` contain no mediabunny reference, `VideoStudio`
lists it only in the dynamic-import preload manifest, and only the lazily-loaded `clipPrep` chunk
(30 kB) imports it.

**Measured on a real 1920×1080@60 12s clip with audio**, driving the shipped component in a browser:

- Reference preset → **640×360 @ 16fps, audio intact**, predicted raster matched measured raster.
- **13.5 MB → 1.04 MB (12.9× smaller.)** This is the compression win the Nugget author reported,
  reproduced here.
- 9:16 centered crop → 358×640; trim + scrub + budget readout all correct; the warning flips at the
  moment the reference drops under the shot length.
- Storyboard → 6 tiles at 0.2…2.7s across a 0–3s trim: evenly spaced, inset half a step, all strictly
  inside the range.

Two defects were caught during verification and fixed:

1. `even()` floors at 2, which is right for a dimension but wrong for an **offset** — a centered square
   crop got `top: 2` instead of `0` and overflowed the frame. Split out `evenOffset()`.
2. `grabFrame` re-derived its height from the requested width, running the ratio through a second
   even-rounding: a grabbed start frame came out **358×638** against its own reference clip's
   **358×640**. It now accepts both edges and pins the plan's raster exactly.

The suite also caught a house rule this work had broken: every `<video controls>` must carry
`controlsList="nodownload"`, because Chrome names a `blob:` download from the URL's UUID and ignores
the File's name, so there must be exactly one download path.

### Reproducing the verification

The component was driven through a temporary owner-gate-free harness (not committed). To rebuild it:

```bash
ffmpeg -y -f lavfi -i "testsrc2=size=1920x1080:rate=60:duration=12" \
  -f lavfi -i "sine=frequency=440:duration=12" \
  -c:v libx264 -pix_fmt yuv420p -g 60 -c:a aac -shortest \
  packages/open-generative-ai/public/__clipprep/source.mp4
```

Then mount `ClipPrepDialog` from a scratch Vite entry with `sourceUrl="/__clipprep/source.mp4"` and run
the dev server on 5273 (`open-generative-ai-alt` in `.claude/launch.json`). Re-probe the applied blob
rather than trusting the dialog's own readout — that is what caught defect 2. **Delete
`public/__clipprep/` afterwards**: Vite copies `public/` into `dist/`, so a 13 MB fixture left there
ships.
