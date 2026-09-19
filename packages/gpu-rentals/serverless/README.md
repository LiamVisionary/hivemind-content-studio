# The serverless restore worker

The GPU behind Restore Studio's **hosted** lane: it restores one chunk of video
and hands it back. It runs on Modal — a container that starts, does one chunk,
and is either reused for the next one seconds later or scaled back to zero.

It is the third machine in a set. `provisioning/comfyui-hivemind.sh` next door
sets up a GPU somebody **rented by the hour**; this is for somebody who has one
clip and does not want a box at all.

| file | owns |
|---|---|
| `modal_app.py` | the image (torch cu128, ComfyUI, the pinned SeedVR2 node, the baked weights), the GPU class, the warm ComfyUI process, and the three web doors the billing worker knocks on |
| `handler.py` | the errand: fetch the chunk, build the graph, run it, encode, deliver, clean up |

## Why Modal, and not the provider this was first written for

The billing worker only ever needed three verbs from the GPU end — submit,
poll, cancel. The first draft aimed them at RunPod Serverless, which wants an
image pushed to a registry, which wants a CUDA machine to build it on. This
repo's laptop is a Mac and no registry credential exists here. Modal builds the
image in its own cloud from `modal_app.py`, needs no registry, and is already
how this fleet hosts its other GPU services. So the GPU end moved and the
billing worker did not: `modal_app.py`'s web app answers in the shape the
worker was already reading.

## The one design rule

**There is only one graph builder.** `handler.py` imports the studio's own
`video_restore.build_restore_graph` — the same function the local lane and the
rented lane submit — and `modal_app.py` copies that module into the image
beside it. A second copy would drift, and a drifted copy means the paid rail
quietly produces different pixels from the free one for the same settings.

`test/studio/test_serverless_restore_handler.py` holds it to that: same settings
in, byte-identical graph out. It also parses `BAKED_MODELS` out of
`modal_app.py` and asserts it matches the list the gateway offers for the hosted
lane — a model on one list and not the other is either a 16GB download on
somebody's credits or a lane hiding a model it has.

That also makes this container, in every respect that matters, a **local lane**.
Frames come back through ComfyUI's temp directory as PNGs and are encoded here,
which is why a hosted render keeps the seam dissolve and the re-finish that a
rented one gives up.

## What crosses the wire

In, from the restore-gateway worker, via `POST /submit`:

```jsonc
{ "input": {
  "source_url": "https://…/v1/blobs/<job>/source?t=…",  // this chunk, lead-in included
  "upload_url": "https://…/v1/blobs/<job>/output?t=…",  // where the result goes
  "frames": 30, "fps": 24.0,
  "model": "seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors",
  "resolution": 1440, "max_edge": 0, "batch_size": 5,
  "color_correction": "lab", "seed": 42
} }
```

Out, via `GET /status/<id>`: `{"status": "COMPLETED", "output": {"uploaded":
true, "frames": 30, "bytes": 8123456, "seconds": 41.2}, "executionTime": 41200}`
— a receipt, not the clip. The bytes went straight to `upload_url`.

**No graph crosses the wire**, in either direction. A caller who could post one
could run anything they liked on the GPU. And no HivemindOS credit token
reaches this end: the doors are gated by one bearer shared with the billing
worker (Modal secret `hivemind-restore-endpoint`, worker secret
`RESTORE_BACKEND_TOKEN`) and nothing else.

## Two things it is not allowed to decide

**It returns every frame it was given**, lead-in included. The studio's
assembler needs both copies of a chunk boundary to dissolve the seam; a
container that helpfully trimmed would turn every hosted render into hard cuts
and nobody would know why.

**Near-lossless, not lossless.** The local lane keeps its intermediates in FFV1
because they never leave the disk they were written on. An FFV1 chunk of 1440p
footage is ~80MB for four seconds; the same chunk at CRF 12 in 10-bit is under
ten, and this one crosses the internet twice. That is a real trade and the
studio's panel names it rather than implying the rails produce identical files.

## Which models, and why only those

The three fp8 checkpoints — 3B, 7B, 7B sharp — plus the VAE, **baked into the
image**. Not the fp16 ones: 16GB each, a 50GB image, and a marginal gain on a
48GB card. Baked rather than fetched on first use because a cold container that
has to download 8GB is a cost that lands on whoever happened to arrive first,
and the gateway's price floor is sized for a model *load*, not a download. The
web app refuses any other model name at the door.

Keep `SEEDVR2_COMMIT` equal to the one `provisioning/comfyui-hivemind.sh` pins.
A restoration should look the same wherever it ran.

## Deploying

```bash
modal secret create hivemind-restore-endpoint RESTORE_ENDPOINT_TOKEN=<the bearer>
modal deploy packages/gpu-rentals/serverless/modal_app.py
```

The deploy prints the web app's origin; that goes into the billing worker's
`RESTORE_BACKEND_URL`, and the same bearer into its `RESTORE_BACKEND_TOKEN`
secret. `GET /health` with the bearer lists the GPU class and the baked models.

## Privacy

Nothing survives a job. The staged source, the restored clip and every PNG are
deleted in a `finally`, not on the success path — a container is reused by the
**next** caller, and one caller's footage still in the input directory when
somebody else's job starts is the whole disclosure risk of this design.
