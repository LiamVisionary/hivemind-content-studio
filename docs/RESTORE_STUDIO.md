# Restore Studio — SeedVR2 video restoration and upscaling

An open, local alternative to the commercial video-restoration tools: load a
clip, test a short segment, compare it against the original frame by frame, and
finish a long render with resumable checkpoints. The footage stays on the
machine you chose to run it on.

## What it actually does

SeedVR2 (`numz/ComfyUI-SeedVR2_VideoUpscaler`) is a diffusion **restorer**, not
an upscaler. It re-generates footage at a higher resolution and, on the way,
removes the compression mush, the sharpening halos and the sensor noise that an
ESRGAN upscale would faithfully enlarge instead. The studio's existing
`/api/upscale` route is still the right tool for one image; this is the one for
footage, where temporal consistency is the whole problem.

## One button, three machines behind it

| | This computer | A rented GPU | Hosted |
|---|---|---|---|
| Cost | electricity | the machine's hourly rate, already metered by GPU rentals | per render, in the credits you already have |
| Billed for | nothing | every hour the box is rented, restoring or idle | the chunks that actually finished |
| Chunks | kept losslessly (FFV1) in the project directory | sealed to your vault as they arrive | fetched back near-lossless (CRF 12, 10-bit) |
| Seams | cross-dissolved | hard cuts — see below | cross-dissolved |
| Re-finish | one ffmpeg pass over the saved chunks | re-joins in the browser, then one pass | one ffmpeg pass over the saved chunks |
| Assembly | the gateway | this browser, where the vault key is | the gateway |
| Footage leaves | no | yes (to a box you rented) | yes (to the hosted service) |

Neither paid lane is a second billing rail. Both spend the same shared
HivemindOS credit balance the studio already uses for hosted models and masking,
and there is nothing new to top up.

**The two paid lanes are not competing; they answer different questions.** A
rented box is the right deal for an afternoon of restoration — you pay for the
hour and everything you run in it is included. It is a poor deal for one clip:
an hour's minimum for a four-minute job, plus provisioning, plus remembering to
destroy it. The hosted lane is the other shape — nothing is running between
renders, the price is quoted before anything is sent, and each chunk is charged
as it finishes. The panel's badge says which is which (`Per hour` / `Per render`)
because getting that choice backwards is what costs money.

**Why the hosted lane keeps the dissolve and the rented one does not.** It is
not a feature decision; it is who may read a finished chunk. A rented lane's
output is sealed to your vault the moment it is harvested and the gateway cannot
read it at all. A hosted chunk comes back as ordinary bytes — so from the
gateway's point of view a hosted project behaves exactly like a local one.

**Why a rented render hard-cuts its seams.** A rented lane's outputs are sealed
to the owner's vault the moment they are harvested — the gateway holds no
readable copy, by design. It therefore cannot trim, blend or concatenate them.
So a rented chunk is trimmed to its body *inside the graph* before it is saved,
and the browser joins the finished chunks with a packet-copy concat. There is no
second copy of a boundary left to dissolve, and the studio says so rather than
offering a dial that would do nothing.

## The three numbers

| Setting | What it is | Why it is not free |
|---|---|---|
| `batch_size` | frames denoised together | must be 4n+1 — the DiT compresses 4 frames to 1 latent plus a key frame, and an off-lattice batch is refused, not rounded |
| `chunk_frames` | frames per graph submit | kept a whole multiple of the batch, so the last batch of a chunk is a full batch |
| `context_frames` | frames re-read at the head of each chunk | already restored by the previous chunk; they are there so the model *enters* the chunk having seen them, which is what stops a visible re-grade at every boundary. They are real render time. |

`seam_frames` then says how many of the twice-restored boundary frames to
cross-dissolve. The dissolve **replaces** frames rather than inserting them, so
the master is exactly as long as the source — a crossfade that shortened the
clip by a few frames per boundary would silently desync the remuxed audio.

## Checkpoints

Every finished chunk is written to the project and recorded in its manifest
before the next one starts. An interrupted render — a stop, a crash, a closed
lid — continues from the first chunk with no file. The chunk loop runs in the
gateway, not the browser, so closing the tab costs nothing.

## Finishing is not restoration

Sharpening, flat-detail softening, grain and the reframe are decided at
**assembly** time from the chunks already on disk. Changing your mind about
grain costs one ffmpeg pass, not another hour of diffusion. That is the whole
reason the chunk files survive the master being written, and it is why deleting
a project is a separate, confirmed action.

"Soften flat detail" is `smartblur` with a negative luma threshold: it blurs
flat areas and leaves edges alone, so skin texture and sensor grain go while
eyelashes stay. It is **not** face-aware, and the panel says so.

## Where the files live

```
<gateway state>/restore/<project-id>/
  project.json      the manifest, and the checkpoint
  source.mp4        the staged original (also serves the compare view)
  chunks/           per-chunk source cuts and lossless restored intermediates
```

Deliberately **not** the output directory: an intermediate there would be sealed
by the output sweeper mid-render. Exactly one file leaves — the finished master,
written into the normal output directory and sealed by the normal path, so it
lands in History like any other clip. Projects untouched for 30 days are reaped
(`ZIMG_RESTORE_PROJECT_TTL_DAYS`), because a project is gigabytes of lossless
intermediates and a feature that never cleans up is a disk leak.

## Three chunk sinks, and why

| Lane | Sink | Reason |
|---|---|---|
| local | `PreviewImage` → ComfyUI temp → the gateway reads the PNGs and encodes the chunk itself | lossless out of the model, never swept into an envelope, and the intermediate's quality is the gateway's choice rather than a fixed h264 default |
| rented | `ImageFromBatch` → `CreateVideo` → `SaveVideo`, harvested and sealed | the gateway cannot read a sealed chunk, so the trim has to happen while the frames are still frames |
| hosted | the container runs the LOCAL sink at its end and returns the encoded chunk | the gateway can read it, so nothing has to change downstream — the trim, the dissolve and the assembly all happen where they always did |

`sink_supports_seams` and `sink_assembles_locally` are the two questions the
runner asks about a sink. Today both answer "everything except the sealed one",
and they are separate functions because they could come apart.

## The hosted lane

### Where the pieces are

| | |
|---|---|
| the billing service | `hivemind-cloud-services/workers/restore-gateway` (Cloudflare Worker + D1 + R2), reserving and settling through paid-agent-gateway's platform-credit authority over a service binding |
| the GPU container | `packages/gpu-rentals/serverless/` — a Modal app: the image, the L40S, a warm ComfyUI, and the three web doors |
| the gateway's client | `packages/media-gateway/cloud_restore.py` |
| the chunk runner | `_restore_chunk_in_cloud` in `packages/media-gateway/app.py` |
| the price on the button | `describeCloudPrice` / `approvedSpendUsd` in `videoRestore.js` |

### There is only one graph builder

The container imports this repo's own `video_restore.build_restore_graph` —
copied into its image by `modal_app.py` — rather than reimplementing it. A
second copy would drift, and a drifted copy means the paid rail quietly produces
different pixels from the free one for the same settings.
`test/studio/test_serverless_restore_handler.py` asserts the two graphs are
byte-identical.

Nothing that crosses the wire is a graph, in either direction: a caller who
could post one could run anything they liked on somebody else's GPU.

### How the money is agreed

1. The studio asks `/api/restore/plan` for the plan **and its price** — one
   round trip for the whole render, not one per chunk. The total is the sum of
   the per-chunk invoices, floor and cent-rounding included, so it is never a
   smoother number the invoices then exceed.
2. That figure goes **on the button** ("Restore 14 chunks · $2.40"), and on the
   preview button too — a two-second test is one chunk and it costs money.
3. Pressing it sends the shown figure back as `max_spend_usd`. Both ends enforce
   it: the service refuses a chunk priced above what was approved, and the
   gateway stops the render if the running total would pass the ceiling.
4. Each chunk is reserved before it is dispatched and settled when it lands. An
   overrun is absorbed, a failure refunds in full, and the project records what
   each chunk really cost — so the progress card shows invoices, not an
   estimate, and a resume knows what is already spent.

A render that runs out of approval or out of balance **stops with its finished
chunks kept**, and resume is a fresh decision at that day's price.

### The credit token never touches disk

The gateway runs the chunk loop, so it is the side that has to hold the owner's
credit token while a render is in flight — but it cannot read the owner's
account itself, and it must not keep a copy. So: the control API attaches the
token to the start request that asks for the hosted lane, the runner pops it out
of `options` **before** the project manifest is written, and keeps it in memory
for that render only. A resume asks for it again and gets it for free, because a
resume is a fresh start request through the same proxy. If the gateway restarts
mid-render the render has stopped anyway, so there is nothing worth persisting.

`test/studio/test_restore_api.py` asserts the token is attached for the hosted
lane and for no other, and that a hosted render with no account connected is
refused *before* a chunk is cut.

### Footage, and where it sits

One chunk at a time, up to the service and back. In between it lives in an R2
bucket the billing worker is the only door to: the container is handed two
ordinary URLs carrying a one-time token that authorises exactly two operations
on exactly one job's two objects. It never holds a credit token — a container
that could reach the balance is a third party with a key to it.

Nothing there is durable. The settle deletes the source, the studio deletes the
output once it has the bytes, and an hourly sweep collects whatever neither did.
Inside the container, the staged clip and every PNG are deleted in a `finally`
rather than on the success path, because a serverless worker is reused by the
next caller.

### Why the GPU end is Modal

The billing worker only ever needed three verbs from the GPU — submit, poll,
cancel — and the first draft aimed them at RunPod Serverless. RunPod wants an
image pushed to a registry, which wants a CUDA machine to build it, and this
machine is a Mac with no registry credential. Modal builds the image in its own
cloud from `modal_app.py`, needs no registry, and already hosts this fleet's
other GPU services. The Modal app answers in the shape the worker was already
reading, so the GPU end moved and the worker did not — which is exactly the
seam that adapter was written around.

The card is an L40S (48GB, $0.000542/s). The three fp8 checkpoints are baked
into the image; the fp16 ones are not (16GB each, marginal gain), and the
gateway lists exactly what is baked and refuses anything else by name before a
chunk is cut.

### Live, and run end to end

The hosted lane is **on**. `https://hivemindos-restore-gateway.hivemindos.workers.dev`
answers `/health` with `enabled: true, configured: true`; the GPU behind it is a
Modal app (`rizzma-inc--hivemind-restore.modal.run`, L40S with an A100-40GB
fallback, the three fp8 checkpoints baked in); the money is the owner's real
HivemindOS balance.

Verified 2026-09-02 by a real paid render through the gateway path, not by unit
test: 105 frames of 640x360, 3B fp8, to 1280x720, in three chunks.

1. The plan came back with its price — `$0.15` for 3 chunks, each at the 5¢
   floor — and `$0.17` was sent back as the approved ceiling.
2. Each chunk was cut, uploaded, reserved, dispatched, rendered, fetched and
   settled in turn: **106.4s** for the first (a cold container: boot, ComfyUI,
   the 3B load, then the render), **46.4s** and **21.0s** warm.
3. The three intermediates came back as h264 10-bit at 1280x720 with every
   frame the container was given — 50, 55, 10 — and the gateway assembled them
   itself: seams dissolved, master finished, **105 frames in, 105 out**, 4.375s
   in and out.
4. The money, on both ledgers. The first run debited only the private USD
   ledger (`$2.00 → $1.85`) and the owner's Account page still said 1,000
   credits — the shared credits database keeps a *public* credits ledger the
   older service chassis never touched. The billing worker now goes through
   paid-agent-gateway's platform-credit authority, and the second run showed
   what a customer should see: **1,000 → 924 credits** (75 for the render), the
   project's own `spend` record `charged_usd 0.15` of `approved_usd 0.17`, and
   the reservation rows carrying our GPU cost beside the charge.

The first attempt stalled: Modal had no L40S free for six minutes and the chunk
sat reserved and queued. Stopping the project from the studio side cancelled
the job upstream, the next step refunded the 5¢, the GPU list gained the A100
fallback, and the render was run again. That is the cancel path and the refund
path exercised for real, which was not the plan but is worth more than the plan.

Getting the money right took three more findings, each only visible live: a
Worker cannot reach another worker on the same account over its public
`workers.dev` name (Cloudflare answers 404 with an empty body — every
worker-to-worker call in the fleet is a service binding for this reason, and
now so is this one); the shared internal service token in PassBook does not
match the one deployed, so the authority now accepts a **restore-scoped token**
pinned to the `restore` service id and the `restore_reserve_` reservation
namespace, the way Interdimensional Cable already had its own; and a warm
isolate keeps serving the previous deploy for a minute, so a fix that "did not
work" thirty seconds after `wrangler deploy` may simply not have landed.

Deploying before the GPU existed had already paid for itself: it found the
**Cloudflare 403 on urllib's default User-Agent** in front of our own worker —
a lane permanently "could not be reached" while every unit test passes and
`curl` works. `hivemindos_models.py`, live for months, already sent a real
User-Agent; `hivemindos_sam3.py`, never deployed, did not and would have hit
this on its first day. Both clients and the container now send one, and the
clients have a test pinning it. The real render found two more, both fixed and
pinned: the start route was refusing the hosted pin as a stale ComfyUI lane
before the resolver saw it, and FastAPI in the Modal web app was reading
`request: Request` as a query parameter under postponed annotations.

### What it is honestly worse at

The intermediates are near-lossless (CRF 12, 10-bit) rather than mathematically
lossless. An FFV1 chunk of 1440p footage is ~80MB for four seconds and this one
crosses the internet twice. Re-finishing still costs one ffmpeg pass rather than
another render — it just starts from a very good copy of the model's output
instead of an exact one.

## The rented rail, run end to end

Verified 2026-09-01 on a rented RTX 5090, not by unit test: 75 frames of
640x360, three chunks, restored to 1280x720 through the whole remote path.

1. The gateway planned three chunks (25 + 30 + 30 source frames, 5 of lead-in on
   each of the last two), resolved the rented lane, and cut and pushed one clip
   per chunk.
2. The box rendered them in **84.3s, 24.4s, 23.8s** — the first pays for loading
   the weights, the next two are the real per-chunk cost with `cache_model` on.
   That gap is the whole argument for caching across chunks.
3. Each finished chunk came back and was sealed on arrival. **The only files on
   disk were `.e2e` envelopes** — no plaintext chunk was ever written, which is
   the privacy claim actually holding rather than being asserted.
4. The project stopped at `awaiting_assembly`, because the gateway cannot read
   what it just sealed.
5. Standing in for the browser: each envelope was unwrapped
   (RSA-OAEP-SHA256 over `iv(12)||dek(32)`, then AES-GCM), the three clips joined
   by packet copy, and the result posted back to `/api/restore/finish`.
6. The join was **frame-exact — 75 in, 75 out**, 3.125s in and out, at 1280x720.
   The in-graph `ImageFromBatch` trim means the join is a plain concatenation;
   there is no second trim to get wrong.
7. The finish pass applied and the master was sealed at rest as `.zenc`. Against
   the unfinished join it measures 48.5 dB PSNR — a real but light touch, which
   is what sharpen 0.3 / grain 0.02 / softening 0.1 should be. Against a bicubic
   upscale of the source it is 29.2 dB, which is the restoration itself.

The test ran against a **throwaway vault** holding a disposable keypair, never
the owner's: the harvest refuses without a sealing key, and the point was to
hold the private half so the browser's side of the join could be executed rather
than assumed.

One thing this found: `/api/restore/plan` takes its options nested under
`options`, while `/api/restore` takes them flat. Nothing is broken — the studio
never calls the plan route, mirroring the arithmetic in `videoRestore.js`
instead, and `test/studio/test_restore_plan_parity.py` pins the two copies
together — but the asymmetry is a trap for anyone who calls the API directly, as
I did, and got a silently defaulted plan back.

## TensorRT VAE decode — built, verified, and it does not help

It works. It is also not worth turning on, and both of those are measured on
rented RTX 5090s rather than argued.

### It works

ONNX export → TensorRT-RTX builds a 294 MB engine → a tiled runtime decodes a
1080p latent. Accuracy against an **identically tiled** PyTorch decode:

| | |
|---|---|
| mean error | **0.049%** |
| pixels over 1% off | **0.0054%** |
| worst pixel | 1.9–3.0% |

bf16's unit roundoff is ~0.4% and TensorRT reorders arithmetic, so a handful of
outlier pixels is what *correct* looks like here. This is not a different
picture.

### It does not help

Same latent, same run, median of three:

| | |
|---|---|
| untiled PyTorch | 2.253s |
| tiled PyTorch | 2.531s |
| **tiled TensorRT** | **2.587s** |

**0.98× on identical tiling — no speedup at all.** The decoder is large 3D
convolutions that PyTorch already runs near peak; there is no fusion or tactic
left to win. Tiling then adds 1.4–1.9× the pixels (overlap, plus flushing the
last tile to the frame edge), so against an untiled decode it is 0.87× — slower.

### How much it could have helped — corrected 2026-09-01

An earlier note here said the decode was "under a tenth of the time", from one
chunk of one render that spent 5.6s encoding, 15.9s in DiT sampling and 2.3s
decoding. **That was wrong to generalise from.** A controlled measurement — same
105 frames of 640x360 to 1280x720, identical graphs differing in one input,
each config run twice, phase markers checked against the raw ComfyUI log,
repeatable to 0.05s — says the opposite:

| config | wall | encode | DiT | decode | peak VRAM |
|---|---|---|---|---|---|
| 3B fp8, batch 5 | 45.4s | 9.2s | 9.2s | **19.9s** | 14.0 GB |
| 3B fp8, batch 21 | 42.3s | 8.8s | 6.5s | **19.9s** | 21.2 GB |
| 7B fp8, batch 5 | 54.4s | 9.2s | 17.8s | **19.9s** | 14.0 GB |

The decode is ~19.9s in every configuration — same VAE, same frames, same output
resolution, so nothing about the model or the batch changes it. That is a fixed
**37–44% of a render**, and on the 3B it is larger than the DiT. The two
measurements are not reconciled: the old one was a single chunk at settings I
did not record alongside it, and the box is gone. Trust the table.

This makes the VAE decode the biggest single lever in the pipeline, not a
rounding error — which is an argument for revisiting an accelerated decode when
better tooling exists, not for having shipped this one. A hypothetical 2× decode
is ~20% off a render, not ~4%.

The reference implementation picks the same first target and says "the DiT graph
and custom temporal operators can be tackled" afterwards. Where it differs from
this note is the *reason* the VAE is worth attacking: not because it is easy,
but because it is where a third of the time actually goes.

### What the studio does with this

The engine is built and measured on the first eligible chunk; the speed gate
sees 0.98×, declines it, and records why. **That is the system working**, and it
is why the gate exists — an "acceleration" that loses is a bug, not a trade-off.
Set `HIVEMIND_SEEDVR2_TRT=0` on a lane to skip even the attempt.

Also verified in passing: the correctness guard correctly refuses temporal batch
21, where the VAE uses its stateful slicing path and the decode is no longer a
pure function.

### The three attempts that failed outright

Recorded so nobody repeats them. All through PyTorch's own compiler, which the
working path never enters:

| Attempt | Failure |
|---|---|
| `torch.export` → `dynamo.compile` | `GuardOnDataDependentSymNode: Could not guard on Eq(u0, 1)` — also with a fully static shape. |
| `torch.compile(backend="tensorrt")` | rank-10 tensor against TensorRT's rank-8 limit. |
| …with the rank fixed | `CUDA illegal memory access` → `Fatal Python error: Aborted`. |

The rank fix is kept (`rank_patch.py`, proven bit-identical): `torch.tile` whose
repeats are all-ones-but-one is an `expand` in disguise. The offender was
`context_parallel_lib.cache_send_recv` — a file that reads as a multi-GPU path
and runs on one card.

## The DiT — both levers measured, both dead ends

The DiT is where the time is: ~10.4s of a ~27s chunk, against ~5.6s encoding and
~2.3s decoding. Two accelerators were already wired for it and neither had ever
been measured. Both were, on a rented RTX 5090, **four chunks with one input clip
each — a real render, not a synthetic loop**:

| config | chunk 1 | chunk 2 | chunk 3 | chunk 4 |
|---|---|---|---|---|
| `sdpa` (baseline) | 10.56s | 10.50s | 10.06s | 10.44s |
| `sdpa` + compile | **15.42s** | **CRASH** | — | — |
| SageAttention 2 | 10.97s | 10.45s | 10.04s | — |

### `torch.compile` is architecturally unavailable here — now removed

Chunk one is **47% slower** (it is compiling) and chunk two dies with
`TypeError: CompatibleDiT does not support len()`. The crash is upstream's: on
the second generation the node re-runs `apply_model_specific_config`, its
`isinstance(model, CompatibleDiT)` check does not see through torch.compile's
`OptimizedModule`, so it wraps the already-compiled model a second time.

A fresh process per chunk would dodge the crash and recompile every time — which
is the 15.42s column. **There is no arrangement in which a chunked render
benefits**, so the "Compile the model" toggle is gone from the studio and the
gateway refuses the option (`torch_compile_supported()`). Re-test when the node
pack updates; if upstream's check learns to see through the wrapper, it is one
benchmark away from being a real question again.

Found on the way: the toggle had **never worked at all**. Its graph node was
missing two required inputs (`dynamo_cache_size_limit`, `dynamo_recompile_limit`)
so ComfyUI rejected the whole graph with a 400. Fixing that is what exposed the
crash behind it.

### SageAttention 2 gives nothing on this DiT

~10.2s against ~10.4s — inside the run-to-run noise. (`sageattn_3` silently
falls back to 2: it needs the `sageattn3` package, not just a Blackwell card,
which is why a benchmark has to read back the mode that was *applied* rather
than the one requested.)

### Where that leaves a render

Nothing cheap is left on the table, but the shape of what is left is now known.
The DiT runs at PyTorch's full speed. The VAE decode is 37–44% of the render and
TensorRT does not improve it — that is the one place a real win is still
theoretically available, and no tool measured here reaches it. The levers that
remain are product trade-offs the studio already exposes: a smaller model, a
lower short-edge target, or a larger temporal batch where memory allows.

Two of those are cheaper than they look. The 7B costs only **+20% wall clock**
over the 3B (54.4s vs 45.4s on the same 105 frames), not the 2× its parameter
count suggests, because the DiT it doubles is a minority of the render. And a
bigger temporal batch is **not a speed lever**: 5 → 21 is 1.41× on the DiT but
1.07× on the render, for 52% more VRAM. Raise it for temporal steadiness, not
for time — the studio's own hint on that slider now says so.

### What actually accelerates a render

Model caching across chunks (which the lane already does — it is most of the
wall clock on a long render otherwise), and choosing the model and target
resolution deliberately. Not the VAE as accelerated here, not `torch.compile`,
and — measured, against my own expectation — not a bigger temporal batch.

### Which rented tier restores

The **video** tier, and only that one. It carries the SeedVR2 pack, its ~9GB of
weights, and the TensorRT accelerator; `studio_pages`, `lane_needles` and the
provisioning all say so together, and a test pins them together because they
came apart once already.

The minimax tier's Blackwell 32GB+ boxes would be better restore hardware, and
they are excluded for onstart budget rather than capability: Vast caps
provisioning at 16KB and, measured 2026-08-31, that tier had 2089 characters of
headroom against the 2000 the size guard pins — the restorer's clone and pin
alone are ~350 of them. To change it, slim that onstart (its largest single item
is the inlined privacy node, ~4.1KB packed, which could ride the weights
manifest the way the TensorRT archive now does), then add `restore` to its
`studio_pages` and `seedvr2` to its `lane_needles`.

## Running the tests

The gateway and studio tests are in the repo's gate:

    python -m pytest test/studio -q
    cd packages/open-generative-ai && node --test tests/videoRestore.test.js

The media gateway has its own suite, which `testpaths` also does not reach:

    cd packages/media-gateway && python -m pytest -q

The hosted lane's billing service is in the other repo and has three static,
no-network suites — the estimator against its own measurements, the reserve /
settle contract, and the footage relay:

    cd ~/hivemind-cloud-services/workers/restore-gateway && pnpm test

The TensorRT node pack is **not** — `testpaths = ["test"]` does not reach it, and
its own tests need a flag to collect at all:

    cd packages/comfyui-custom-nodes/hivemind-seedvr2-trt
    python -m pytest -q --import-mode=importlib         # 28 pass, 13 skip (no torch)

Without that flag pytest tries to import the pack's `__init__.py` — a ComfyUI
entry point doing relative imports — and all 41 tests error at setup, which
looks like a broken environment rather than a gate that never ran. It never ran:
two tests in it were failing unnoticed until 2026-09-01, when this was found by
running them properly. Neither was a logic bug; both used torch without the skip
guard the rest of the file uses. Fixed, but the lesson is the collection error,
not the tests.

## Where the code is

| File | Owns |
|---|---|
| `packages/media-gateway/video_restore.py` | plan arithmetic, the ComfyUI graph, assembly steps, finishing filters, the TensorRT policy, the manifest — pure, unit-tested without a GPU |
| `packages/comfyui-custom-nodes/hivemind-seedvr2-trt` | the TensorRT attempt: the decode patch, the rank rewrite (`rank_patch.py`, proven bit-identical), the graph probe, and the speed/numerics checks that would decide whether an engine is kept |
| `packages/media-gateway/app.py` | the runner: staging, chunk submission, resume, ffmpeg, sealing, the spend ceiling, and the `/api/restore/*` routes |
| `packages/media-gateway/cloud_restore.py` | the hosted lane's client: upload, reserve, poll, fetch, forget — and the sentence a person reads when the balance runs out |
| `packages/gpu-rentals/serverless/` | the hosted lane's container: a RunPod Serverless SeedVR2 worker that builds its graph from `video_restore.py` rather than a copy of it |
| `hivemind-cloud-services/workers/restore-gateway` | the hosted lane's billing service: quote, reserve, dispatch, settle, and the R2 relay the footage crosses |
| `src/hivemind_content_studio/video_restore.py` | the studio's proxy onto those routes (owner gate, gateway token) |
| `packages/open-generative-ai/src/lib/videoRestore.js` | the browser's restatement of the plan maths, the price arithmetic, and the gateway calls |
| `packages/open-generative-ai/src/studios/RestoreStudio.jsx` | the studio |

The graph builder exists **once** on purpose, and the plan maths **twice**.

The graph: the serverless container imports `video_restore.build_restore_graph`
rather than reimplementing it, so the paid rail cannot drift into different
pixels than the free one. `test/studio/test_serverless_restore_handler.py`
asserts the two are byte-identical.

The plan maths exists twice because the panel has to say "14 chunks,
2560x1440" while the file is still in the picker, before anything is uploaded.
`test/studio/test_restore_plan_parity.py` runs the same cases through both
copies and compares them chunk for chunk — two copies of an arithmetic is one
copy to forget when it changes.
