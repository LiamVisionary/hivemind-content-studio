"""The serverless GPU behind Restore Studio's hosted lane, on Modal.

WHY MODAL. The restore-gateway worker only ever needed three things from the GPU
end: submit a chunk job, poll it, cancel it. RunPod could have been that end and
the first draft was written for it — but RunPod wants an image pushed to a
registry, and building one needs a CUDA machine. Modal builds the image in its
own cloud from this file, needs no registry, and is already how this fleet
hosts its other GPU services. So the GPU end moved and the worker did not: the
web app at the bottom of this file answers in the same shape the worker was
already reading (`status` / `output` / `executionTime`), which is the seam the
worker was designed around.

WHAT RUNS HERE. A ComfyUI with exactly one job in it — SeedVR2 — started once
per container and kept warm between chunks, driven by `handler.py`, which
imports the studio's own `video_restore.build_restore_graph` so there is exactly
ONE graph builder across the free, rented and hosted rails. The weights are
baked into the image rather than fetched on first use: a cold container that
has to download 8GB is a cost that lands on whoever happened to arrive first,
and the gateway's price floor is sized for a model LOAD, not a download.

WHICH MODELS. The three fp8 checkpoints the studio actually recommends. Not
the fp16 ones: they are 16GB each, the image would be 50GB, and their gain is
marginal on a 48GB card. The gateway lists exactly these for the hosted lane
and refuses anything else BY NAME before a chunk is cut — a job that pulled
16GB on somebody's credits is the failure this whole design is bent around.

Deploy:  modal deploy packages/gpu-rentals/serverless/modal_app.py
Secret:  `hivemind-restore-endpoint` must hold RESTORE_ENDPOINT_TOKEN — the
         bearer the restore-gateway worker presents. Same value on both ends.
"""

# No `from __future__ import annotations` here, on purpose. The web app below
# imports `Request` INSIDE `web()` (the GPU image has no fastapi), and FastAPI
# resolves a postponed annotation against module globals — where that name does
# not exist — so it read `request: Request` as a query parameter called
# "request" and answered 422 to everything. Measured on the first deploy.
import hmac
import os
import subprocess
import sys
import time
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
# This module is imported twice: on the laptop by `modal deploy`, where the repo
# is three directories up, and inside the container, where it sits alone at
# /root and there is no repo at all. The local paths only matter to the first.
REPO = HERE.parents[2] if len(HERE.parents) > 2 else HERE

# Pinned to the same commit the rented-box provisioner pins
# (packages/gpu-rentals/provisioning/comfyui-hivemind.sh). A restoration is
# supposed to look the same wherever it ran.
SEEDVR2_COMMIT = "4490bd1f482e026674543386bb2a4d176da245b9"
# In order of preference, and a LIST on purpose. Measured on the first real
# render, 2026-09-02: Modal had no L40S to give for over six minutes ("waiting
# to be scheduled on a GPU_L40S worker") while a paying chunk sat reserved. An
# A100-40GB is the same class for this model — 40GB is plenty for the fp8
# checkpoints at 4K — and costs 7.6% more per second, which the worker's rate
# is set to. Whatever is free first takes the job.
GPU = [name.strip() for name in os.environ.get("HIVEMIND_RESTORE_GPU", "L40S,A100-40GB").split(",") if name.strip()]
APP_NAME = "hivemind-restore-worker"
# Echoed by /health, so a deploy can be told apart from a container still
# serving the previous one.
BUILD = "2026-09-02.4"

# Filename -> Hugging Face repo, exactly as the node's own model_registry has
# them. The 3B and the VAE live in numz's repo; the mixed-block 7B builds are
# AInVFX's.
BAKED_MODELS = {
    "seedvr2_ema_3b_fp8_e4m3fn.safetensors": "numz/SeedVR2_comfyUI",
    "seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors": "AInVFX/SeedVR2_comfyUI",
    "seedvr2_ema_7b_sharp_fp8_e4m3fn_mixed_block35_fp16.safetensors": "AInVFX/SeedVR2_comfyUI",
    "ema_vae_fp16.safetensors": "numz/SeedVR2_comfyUI",
}
MODEL_DIR = "/comfyui/models/SEEDVR2"


def download_weights() -> None:
    """Runs once, at image build, inside Modal's cloud."""
    from huggingface_hub import hf_hub_download

    for name, repo in BAKED_MODELS.items():
        hf_hub_download(repo, name, local_dir=MODEL_DIR)


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libgl1", "libglib2.0-0")
    # CUDA 12.8 wheels: they carry their own runtime libraries, so no toolkit
    # image is needed. Installed FIRST so ComfyUI's unpinned `torch` line is
    # already satisfied and cannot pull a CPU build from PyPI over the top.
    .pip_install(
        "torch==2.7.1", "torchvision==0.22.1", "torchaudio==2.7.1",
        index_url="https://download.pytorch.org/whl/cu128",
    )
    .run_commands(
        "git clone --depth 1 https://github.com/comfyanonymous/ComfyUI /comfyui",
        "cd /comfyui && pip install -r requirements.txt",
        "git clone https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler "
        "/comfyui/custom_nodes/seedvr2_videoupscaler",
        f"cd /comfyui/custom_nodes/seedvr2_videoupscaler && git checkout {SEEDVR2_COMMIT}",
        "cd /comfyui/custom_nodes/seedvr2_videoupscaler && pip install -r requirements.txt",
    )
    .pip_install("huggingface_hub")
    .run_function(download_weights)
    .env({
        "PYTHONPATH": "/app",
        "HIVEMIND_COMFY_ROOT": "/comfyui",
        "HIVEMIND_COMFY_URL": "http://127.0.0.1:8188",
        "HIVEMIND_RESTORE_DEVICE": "cuda:0",
        "HIVEMIND_RESTORE_OFFLOAD": "cpu",
        "HIVEMIND_WORK_DIR": "/tmp/hivemind-restore",
    })
    # The studio's own graph builder, copied in rather than reimplemented.
    .add_local_file(REPO / "packages" / "media-gateway" / "video_restore.py", "/app/video_restore.py")
    .add_local_file(HERE / "handler.py", "/app/handler.py")
)

app = modal.App(APP_NAME)


@app.cls(
    gpu=GPU,
    image=image,
    timeout=1800,
    # Stay warm this long after the last chunk. A render's next chunk arrives
    # seconds after the previous one finished, and a warm container is the
    # entire difference between an 8GB model load per chunk and per render.
    scaledown_window=240,
    cpu=4,
    memory=16384,
)
class RestoreWorker:
    @modal.enter()
    def boot(self) -> None:
        """ComfyUI, once per container, in the background.

        Not waited for here: the first job's own `_wait_for_comfy` overlaps the
        boot with fetching its chunk instead of doing the two in series.
        """
        self.comfy = subprocess.Popen(
            [
                sys.executable, "/comfyui/main.py",
                "--listen", "127.0.0.1", "--port", "8188",
                "--disable-auto-launch", "--disable-metadata",
            ],
            cwd="/comfyui",
            stdout=open("/tmp/comfyui.log", "ab"),
            stderr=subprocess.STDOUT,
        )

    @modal.exit()
    def halt(self) -> None:
        try:
            self.comfy.terminate()
            self.comfy.wait(timeout=10)
        except Exception:
            pass

    @modal.method()
    def restore(self, job_input: dict) -> dict:
        """One chunk: fetch, restore, encode, deliver. See handler.py."""
        if "/app" not in sys.path:
            sys.path.insert(0, "/app")
        import handler

        return handler.handler({"input": job_input})


# --- the doors the billing worker knocks on -----------------------------------
#
# A plain FastAPI app on a CPU container, speaking the shape the restore-gateway
# worker already reads. Authenticated by ONE bearer token shared with that
# worker and nothing else: no HivemindOS credit token ever reaches this end,
# and a caller who found this URL without the bearer gets a 401 and no clue.

web_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]")


@app.function(
    image=web_image,
    secrets=[modal.Secret.from_name("hivemind-restore-endpoint")],
    timeout=60,
)
@modal.asgi_app(label="hivemind-restore")
def web():
    from fastapi import FastAPI, HTTPException, Request

    api = FastAPI(docs_url=None, redoc_url=None)
    expected = (os.environ.get("RESTORE_ENDPOINT_TOKEN") or "").strip()

    def authorise(request: Request) -> None:
        # Constant-time, because the token is the only thing between the
        # public internet and a GPU that costs money by the second.
        presented = (request.headers.get("authorization") or "").removeprefix("Bearer ").strip()
        if not expected or not presented or not hmac.compare_digest(presented, expected):
            raise HTTPException(status_code=401, detail="unauthorised")

    @api.get("/health")
    def health(request: Request) -> dict:
        authorise(request)
        return {"ok": True, "service": APP_NAME, "gpu": GPU, "models": sorted(BAKED_MODELS), "build": BUILD}

    # NOTE: `gpu` above is the preference list; which card a given chunk landed
    # on is Modal's to know and is not reported back — the price is quoted for
    # the dearer of the two so it cannot be undercharged.

    @api.post("/submit")
    async def submit(request: Request) -> dict:
        authorise(request)
        body = await request.json()
        job_input = body.get("input") if isinstance(body, dict) else None
        if not isinstance(job_input, dict):
            raise HTTPException(status_code=400, detail="input is required")
        model = str(job_input.get("model") or "")
        if model and model not in BAKED_MODELS:
            # Refused at the door rather than downloaded on somebody's credits.
            raise HTTPException(status_code=400, detail=f"this worker does not carry {model}")
        # `.aio` because this handler is async; the blocking form works but
        # Modal warns, and it blocks the event loop the other doors share.
        call = await RestoreWorker().restore.spawn.aio(job_input)
        return {"id": call.object_id, "status": "IN_QUEUE"}

    @api.get("/status/{call_id}")
    def status(call_id: str, request: Request) -> dict:
        authorise(request)
        try:
            call = modal.FunctionCall.from_id(call_id)
        except Exception:
            raise HTTPException(status_code=404, detail="no such job") from None
        try:
            output = call.get(timeout=0)
        except TimeoutError:
            return {"id": call_id, "status": "IN_PROGRESS"}
        except Exception as exc:
            # The function raised, or its container died. Either way nothing
            # was delivered, and the worker refunds on FAILED.
            return {"id": call_id, "status": "FAILED", "error": type(exc).__name__}
        seconds = float((output or {}).get("seconds") or 0.0) if isinstance(output, dict) else 0.0
        return {
            "id": call_id,
            "status": "COMPLETED",
            "output": output,
            # Milliseconds, as the worker expects: it was written against a
            # provider that reported them that way.
            "executionTime": int(seconds * 1000),
        }

    @api.post("/cancel/{call_id}")
    def cancel(call_id: str, request: Request) -> dict:
        authorise(request)
        try:
            modal.FunctionCall.from_id(call_id).cancel()
        except Exception:
            pass
        return {"id": call_id, "status": "CANCELLED"}

    return api
