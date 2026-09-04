"""The native Apple-silicon MLX routes - Klein3 edit, the character sheet, LTX
video - and the head-swap guide builder. No ComfyUI in the path."""
import hashlib
import json
import os
import re
import select
import subprocess
import threading
import time
import tempfile
import uuid
import shutil
from pathlib import Path
from urllib.request import Request
from urllib.error import HTTPError

from gateway import config, graphs, history as _history, jobs, loras, media as _media, net, runners, util


def queue_native_mlx_biglove_job(prompt, image_path, options, workflow=None):
    if not config.supports_native_mlx_biglove_route():
        raise RuntimeError(f"native MLX BigLove route is not available for accelerator profile {config.accelerator_profile()}")
    options = dict(options or {})
    image_names = options.get('image_paths') if isinstance(options.get('image_paths'), list) else [image_path]
    uploaded_images = []
    for item in image_names[:graphs.BIGLOVE_KLEIN3_MAX_REFERENCES]:
        p = Path(str(item))
        if not p.is_absolute():
            p = config.COMFY_INPUT_DIR / str(item)
        uploaded_images.append(p)
    uploaded_image = uploaded_images[0]
    if len(uploaded_images) > 1:
        options['image_paths'] = [str(p) for p in uploaded_images]
    job_id = uuid.uuid4().hex[:12]
    fingerprint = jobs._klein_request_fingerprint(prompt, uploaded_images, options)
    record = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "comfy_prompt": graphs._comfy_history_prompt_tuple(job_id, workflow),
        "status": "queued",
        "backend": "mlx-mxfp8-bigloves-klein3-edit",
        "created_at": util.now_iso(),
        "options": {
            **{k: v for k, v in options.items() if k not in {'negative_prompt', 'loras', 'image_paths', 'studio_lane', 'run_on'}},
            **({'reference_images': len(uploaded_images)} if len(uploaded_images) > 1 else {}),
            **({'lora_count': len(options.get('loras') or [])} if options.get('loras') else {}),
        },
        "source": "comfy-prompt-intercept",
    }
    registered_job_id = jobs._register_klein_job(job_id, fingerprint, record)
    if registered_job_id != job_id:
        return registered_job_id
    args = (job_id, prompt, uploaded_image, options or {}, workflow)
    jobs.start_studio_generation_thread(
        'image', options, jobs._run_admitted_klein_job,
        (job_id, fingerprint, run_mlx_klein3_edit, args),
    )
    return job_id

def run_mlx_klein3_edit(job_id, prompt, image_path, options=None, workflow=None):
    started = util.now_iso()
    options = options or {}
    with jobs.jobs_lock:
        queued_rec = jobs.jobs.get(job_id) or {}
    # 0 means "no size asked for" and lands on the trained bucket — the old 512
    # fallback would now read as a request for a 0.26MP draft.
    requested_width = util.int_quality_option(options, 'requested_width', util.int_quality_option(options, 'width', 0))
    requested_height = util.int_quality_option(options, 'requested_height', util.int_quality_option(options, 'height', 0))
    target_width = util.int_quality_option(options, 'width', requested_width)
    target_height = util.int_quality_option(options, 'height', requested_height)
    bucket_width, bucket_height = graphs.snap_biglove_klein3_resolution(target_width, target_height)
    width, height = graphs._cap_native_mx_dimensions(bucket_width, bucket_height)
    steps = graphs.normalize_biglove_klein3_steps(options.get('steps', 4))
    guidance = util.float_quality_option(options, 'guidance', 1.0)
    seed = config.resolve_seed_option(options)
    native_loras = loras._dedupe_lora_requests(options.get('loras') or [])
    reference_images = []
    for item in (options.get('image_paths') if isinstance(options.get('image_paths'), list) else [image_path]):
        p = Path(str(item)).resolve()
        reference_images.append(p)
    reference_images = reference_images[:graphs.BIGLOVE_KLEIN3_MAX_REFERENCES] or [Path(image_path).resolve()]
    out = config.OUT_DIR / f"biglove_klein3_mlx_{job_id}.png"
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "comfy_prompt": graphs._comfy_history_prompt_tuple(job_id, workflow),
        "status": "running",
        "backend": "mlx-mxfp8-bigloves-klein3-edit",
        "created_at": queued_rec.get("created_at") or started,
        "started_at": started,
        "outputs": [],
        "options": {
            "width": width,
            "height": height,
            "steps": steps,
            "guidance": guidance,
            "seed": seed,
            # Only when the caller actually named a size — 0 is "took the
            # model's own canvas", which `width`/`height` already report.
            **({"requested_width": requested_width} if requested_width > 0 else {}),
            **({"requested_height": requested_height} if requested_height > 0 else {}),
            **({'reference_images': len(reference_images)} if len(reference_images) > 1 else {}),
            **({'lora_count': len(native_loras)} if native_loras else {}),
        },
        "current_step": 0,
        "total_steps": steps,
        "progress": 0,
        "step_progress": 0,
        "progress_phase": "queued",
        **({'coalesced_requests': queued_rec['coalesced_requests']} if queued_rec.get('coalesced_requests') else {}),
    }
    with jobs.jobs_lock:
        latest = jobs.jobs.get(job_id) or {}
        if latest.get('coalesced_requests'):
            rec['coalesced_requests'] = latest['coalesced_requests']
        jobs.jobs[job_id] = rec
    try:
        if not config.supports_native_mlx_biglove_route():
            raise RuntimeError(f"native MLX BigLove route is not available for accelerator profile {config.accelerator_profile()}")
        if not config.SWIFT_FLUX2_BIN.exists():
            raise RuntimeError(f"Swift Flux2 MLX runner not found: {config.SWIFT_FLUX2_BIN}")
        if not config.SWIFT_MLX_METALLIB.exists():
            raise RuntimeError(f"Swift Flux2 MLX metallib not found: {config.SWIFT_MLX_METALLIB}")
        allowed = [config.OUT_DIR.resolve(), config.COMFY_OUTPUT_DIR.resolve(), (Path.home() / ".comfy-private.noindex/input").resolve()]
        for ref_path in reference_images:
            if not any(str(ref_path).startswith(str(root)) for root in allowed) or not ref_path.exists():
                raise RuntimeError("input image is outside private image storage or does not exist")
        # Size the canvas from the reference image, not the fixed portrait
        # bucket — the bucket kept its ~1.5MP budget but stretched every
        # non-2:3 source. Same budget, source aspect, then the speed cap.
        width, height = graphs._cap_native_mx_dimensions(
            *graphs._reshape_dims_to_image_aspect(reference_images[0], bucket_width, bucket_height)
        )
        rec["options"].update({"width": width, "height": height})
        with jobs.jobs_lock:
            jobs.jobs[job_id] = rec
        result = _klein3_native_edit_once(
            prompt,
            reference_images,
            out,
            width=width,
            height=height,
            steps=steps,
            guidance=guidance,
            seed=seed,
            native_loras=native_loras,
            server_job_id=job_id,
            poll_job_id=job_id,
        )
        if result.get("warm_fallback"):
            rec["warm_server_fallback"] = result["warm_fallback"]
        graphs.embed_workflow_text_chunk(out, workflow)
        visible_out = jobs.mirror_output_to_comfy_output(out, job_id=job_id)
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": [str(visible_out.resolve())],
            "elapsed_seconds": result["elapsed"],
            "runner_stdout": result["stdout"],
            "runner_stderr": result["stderr"],
            "current_step": steps,
            "total_steps": steps,
            "progress": 100,
            "step_progress": 100,
            "progress_phase": "done",
        })
    except Exception as e:
        fallback_note = getattr(e, "warm_fallback", None)
        if fallback_note:
            rec["warm_server_fallback"] = fallback_note
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(e)})
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


def _klein3_native_edit_once(prompt, reference_images, out, *, width, height, steps,
                             guidance, seed, native_loras=None, server_job_id=None,
                             poll_job_id=None):
    """One native Klein 9B edit: warm Swift server first, CLI fallback.

    BigLoveKlein3 MXFP8 is exposed to flux-2-swift-mlx as the local Klein9B transformer.
    The MXFP8 file is pre-dequantized with Comfy's exact E8M0 blocked-scale layout
    so the Swift MLX path can load it cleanly through its bf16 loader.
    The Swift pipeline uses Flux2's correct I2I conditioning path instead of mflux's
    image-latent/noise-injection edit shim, which was producing fuzzy/noisy copies.

    `server_job_id` names the run on the warm server's progress endpoint;
    `poll_job_id` (when set) mirrors that progress into jobs[poll_job_id] via
    poll_swift_flux2_progress. Returns {"elapsed", "stdout", "stderr",
    "warm_fallback"}; raises RuntimeError on failure (with .warm_fallback set
    when the warm server had already been tried)."""
    out = Path(out)
    warm_fallback = None
    config.OUT_DIR.mkdir(parents=True, exist_ok=True)
    if config.use_swift_flux2_server():
        t0 = time.monotonic()
        payload_data = {
            "prompt": prompt,
            "imagePath": str(reference_images[0]),
            "outputPath": str(out),
            "width": width,
            "height": height,
            "steps": steps,
            "guidance": guidance,
            "seed": seed,
            "jobId": server_job_id or out.stem,
        }
        if len(reference_images) > 1:
            payload_data["imagePaths"] = [str(p) for p in reference_images]
        if native_loras:
            payload_data["loras"] = native_loras
        payload = json.dumps(payload_data).encode("utf-8")
        req = Request(
            config.SWIFT_FLUX2_SERVER_URL.rstrip("/") + "/generate",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            progress_stop = threading.Event()
            progress_thread = None
            if poll_job_id:
                progress_thread = threading.Thread(
                    target=graphs.poll_swift_flux2_progress,
                    args=(poll_job_id, steps, progress_stop),
                    daemon=True,
                )
                progress_thread.start()
            try:
                with net.urlopen(req, timeout=1200) as resp:
                    server_rec = json.loads(resp.read().decode("utf-8") or "{}")
            finally:
                progress_stop.set()
                if progress_thread is not None:
                    progress_thread.join(timeout=1)
        except Exception as server_error:
            # Keep the single app route reliable: if the warm server is not
            # up yet, fall back to the CLI path below instead of failing the
            # user's generation request.
            server_rec = {"ok": False, "error": f"warm server unavailable: {server_error}"}
        elapsed = round(time.monotonic() - t0, 2)
        if server_rec.get("ok") and out.exists() and out.stat().st_size >= 1000:
            return {
                "elapsed": elapsed,
                "stdout": f"Swift Flux2 persistent server: {server_rec.get('elapsedSeconds')}s",
                "stderr": "",
                "warm_fallback": None,
            }
        warm_fallback = util.json_safe_text(server_rec.get("error") or "missing output")
        if native_loras:
            error = RuntimeError(f"Swift Flux2 persistent server is required for native LoRA edits: {warm_fallback}")
            error.warm_fallback = warm_fallback
            raise error
    cmd = [
        str(config.SWIFT_FLUX2_BIN),
        'i2i',
        prompt,
        # Swift ArgumentParser array options take ONE value per flag:
        # --images a --images b. A single flag followed by several paths
        # makes every path after the first an unexpected argument.
        *[arg for p in reference_images for arg in ('--images', str(p))],
        '--model', 'klein-9b',
        '--transformer-quant', 'bf16',
        '--text-quant', '8bit',
        '--vae-variant', 'standard',
        '--steps', str(steps),
        '--guidance', str(guidance),
        '--seed', str(seed),
        '--width', str(width),
        '--height', str(height),
        '--output', str(out),
    ]
    env = os.environ.copy()
    env.setdefault('MLX_METAL_PATH', str(config.SWIFT_MLX_METALLIB))
    t0 = time.monotonic()
    proc = subprocess.run(cmd, cwd=str(config.SWIFT_FLUX2_BIN.parent), text=True, capture_output=True, timeout=1200, env=env)
    elapsed = round(time.monotonic() - t0, 2)
    stdout = proc.stdout.strip()
    stderr = proc.stderr.strip()
    try:
        if proc.returncode != 0:
            raise RuntimeError(f"MLX runner exited {proc.returncode}\nSTDOUT:\n{stdout[-2000:]}\nSTDERR:\n{stderr[-2000:]}")
        if not out.exists() or out.stat().st_size < 1000:
            raise RuntimeError("MLX runner finished without a valid output image")
    except RuntimeError as error:
        if warm_fallback:
            error.warm_fallback = warm_fallback
        raise
    return {
        "elapsed": elapsed,
        "stdout": util.json_safe_text(stdout),
        "stderr": util.json_safe_text(stderr),
        "warm_fallback": warm_fallback,
    }


KLEIN_CHARACTER_SHEET_BACKEND = "mlx-klein3-character-sheet"


def _poll_klein_sheet_view_progress(job_id, server_job_id, view_index, view_count, steps, stop_event):
    """Mirror one view's warm-server denoise progress into the sheet job as a
    fraction of the whole sheet, so the studio's ETA bar stays monotonic
    instead of sawtoothing 0-100 once per view."""
    url = config.SWIFT_FLUX2_SERVER_URL.rstrip("/") + "/progress/" + str(server_job_id)
    while not stop_event.is_set():
        try:
            with net.urlopen(url, timeout=2) as resp:
                progress_rec = json.loads(resp.read().decode("utf-8") or "{}")
            current = int(progress_rec.get("currentStep") or 0)
            total = int(progress_rec.get("totalSteps") or steps or 1)
            view_fraction = min(1.0, current / max(1, total))
            overall = int(round(((view_index + view_fraction) / max(1, view_count)) * 100))
            with jobs.jobs_lock:
                job = jobs.jobs.get(job_id)
                if job and job.get("status") == "running":
                    job.update({
                        "current_step": view_index * steps + current,
                        "total_steps": steps * view_count,
                        "progress": max(0, min(100, overall)),
                        "step_progress": int(progress_rec.get("currentStepPercent") or (100 if current > 0 else 0)),
                        "progress_phase": f"view {view_index + 1}/{view_count}",
                    })
                    jobs.jobs[job_id] = job
        except Exception:
            pass
        stop_event.wait(0.25)


def queue_klein_character_sheet(prompt, reference_images, options, views, preset=None):
    options = dict(options or {})
    if reference_images:
        options['image_paths'] = [str(Path(p)) for p in reference_images]
    job_id = uuid.uuid4().hex[:12]
    fingerprint = jobs._klein_request_fingerprint(
        prompt,
        reference_images,
        options,
        mode='character-sheet',
        extra={'preset': preset, 'views': views},
    )
    record = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "comfy_prompt": graphs._comfy_history_prompt_tuple(job_id, backend=KLEIN_CHARACTER_SHEET_BACKEND),
        "status": "queued",
        "created_at": util.now_iso(),
        "backend": KLEIN_CHARACTER_SHEET_BACKEND,
        "mode": "character-sheet",
        "options": {
            **{k: v for k, v in options.items() if k not in {'negative_prompt', 'loras', 'image_paths', 'studio_lane', 'run_on'}},
            **({'reference_images': len(reference_images)} if len(reference_images) > 1 else {}),
            **({'lora_count': len(options.get('loras') or [])} if options.get('loras') else {}),
        },
        "character_sheet": {
            **({'preset': preset} if preset else {}),
            "views": [view["id"] for view in views],
            "labels": [view["label"] for view in views],
            "total": len(views),
            "completed": 0,
        },
    }
    registered_job_id = jobs._register_klein_job(job_id, fingerprint, record)
    if registered_job_id != job_id:
        return registered_job_id
    args = (job_id, prompt, reference_images, options, views, preset)
    jobs.start_studio_generation_thread(
        'image', options, jobs._run_admitted_klein_job,
        (job_id, fingerprint, run_klein_character_sheet, args),
    )
    return job_id


def run_klein_character_sheet(job_id, prompt, reference_images, options=None, views=None, preset=None):
    """The Civitai multi-view recipe on the studio's native Klein edit lane:
    every view is one white-background edit of the SAME reference(s) with the
    SAME seed (identity holds across tiles, like Strength Hunt's fixed seed),
    then a labeled sheet leads the outputs so single-url clients get the sheet
    and History keeps the individual views."""
    started = util.now_iso()
    options = options or {}
    views = views or []
    with jobs.jobs_lock:
        queued_rec = jobs.jobs.get(job_id) or {}
    requested_width = util.int_quality_option(options, 'requested_width', util.int_quality_option(options, 'width', 1024))
    requested_height = util.int_quality_option(options, 'requested_height', util.int_quality_option(options, 'height', 1536))
    # Every tile shares one canvas — the trained portrait bucket. Reshaping to
    # the reference aspect (the single-edit behavior) would make ragged grids
    # from square or landscape references.
    bucket_width, bucket_height = graphs.snap_biglove_klein3_resolution(requested_width, requested_height)
    width, height = graphs._cap_native_mx_dimensions(bucket_width, bucket_height)
    steps = graphs.normalize_biglove_klein3_steps(options.get('steps', 4))
    guidance = util.float_quality_option(options, 'guidance', 1.0)
    seed = config.resolve_seed_option(options)
    native_loras = loras._dedupe_lora_requests(options.get('loras') or [])
    view_count = len(views)
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "comfy_prompt": graphs._comfy_history_prompt_tuple(job_id, backend=KLEIN_CHARACTER_SHEET_BACKEND),
        "status": "running",
        "backend": KLEIN_CHARACTER_SHEET_BACKEND,
        "mode": "character-sheet",
        "created_at": queued_rec.get("created_at") or started,
        "started_at": started,
        "outputs": [],
        "options": {
            "width": width,
            "height": height,
            "steps": steps,
            "guidance": guidance,
            "seed": seed,
            "requested_width": requested_width,
            "requested_height": requested_height,
            **({'reference_images': len(reference_images)} if len(reference_images) > 1 else {}),
            **({'lora_count': len(native_loras)} if native_loras else {}),
        },
        "character_sheet": {
            **({'preset': preset} if preset else {}),
            "views": [view["id"] for view in views],
            "labels": [view["label"] for view in views],
            "total": view_count,
            "completed": 0,
        },
        "current_step": 0,
        "total_steps": steps * max(1, view_count),
        "progress": 0,
        "step_progress": 0,
        "progress_phase": "queued",
        **({'coalesced_requests': queued_rec['coalesced_requests']} if queued_rec.get('coalesced_requests') else {}),
    }
    with jobs.jobs_lock:
        latest = jobs.jobs.get(job_id) or {}
        if latest.get('coalesced_requests'):
            rec['coalesced_requests'] = latest['coalesced_requests']
        jobs.jobs[job_id] = rec
    staging_dir = None
    view_outputs = []
    try:
        if not views:
            raise RuntimeError("character sheet needs at least one view")
        if not config.supports_native_mlx_biglove_route():
            raise RuntimeError(f"native MLX BigLove route is not available for accelerator profile {config.accelerator_profile()}")
        if not config.SWIFT_FLUX2_BIN.exists():
            raise RuntimeError(f"Swift Flux2 MLX runner not found: {config.SWIFT_FLUX2_BIN}")
        if not config.SWIFT_MLX_METALLIB.exists():
            raise RuntimeError(f"Swift Flux2 MLX metallib not found: {config.SWIFT_MLX_METALLIB}")
        allowed = [config.OUT_DIR.resolve(), config.COMFY_OUTPUT_DIR.resolve(), (Path.home() / ".comfy-private.noindex/input").resolve()]
        resolved_refs = []
        for ref_path in reference_images:
            ref_path = Path(ref_path).resolve()
            if not any(str(ref_path).startswith(str(root)) for root in allowed) or not ref_path.exists():
                raise RuntimeError("input image is outside private image storage or does not exist")
            resolved_refs.append(ref_path)
        staging_dir = Path(tempfile.mkdtemp(prefix=f"charsheet-{job_id}-"))
        t0 = time.monotonic()
        tiles = []
        for index, view in enumerate(views):
            view_prompt = config.character_sheet_view_prompt(view, prompt)
            out = config.OUT_DIR / f"charsheet_{job_id}_{index:02d}_{view['id']}.png"
            server_job_id = f"{job_id}-v{index:02d}"
            progress_stop = threading.Event()
            progress_thread = None
            if config.use_swift_flux2_server():
                progress_thread = threading.Thread(
                    target=_poll_klein_sheet_view_progress,
                    args=(job_id, server_job_id, index, view_count, steps, progress_stop),
                    daemon=True,
                )
                progress_thread.start()
            try:
                _klein3_native_edit_once(
                    view_prompt,
                    resolved_refs,
                    out,
                    width=width,
                    height=height,
                    steps=steps,
                    guidance=guidance,
                    seed=seed,
                    native_loras=native_loras,
                    server_job_id=server_job_id,
                )
            finally:
                progress_stop.set()
                if progress_thread is not None:
                    progress_thread.join(timeout=1)
            # Capture plaintext bytes NOW — the privacy/E2E sweepers may seal
            # the file at any moment, and .e2e envelopes are unreadable
            # server-side by design.
            data, _mime = _media.decrypt_output_bytes(out)
            staged = staging_dir / f"tile_{index:02d}.png"
            staged.write_bytes(data)
            tiles.append({"path": str(staged), "label": view["label"], "index": index})
            visible_out = jobs.mirror_output_to_comfy_output(out, job_id=job_id)
            view_outputs.append(str(visible_out.resolve()))
            with jobs.jobs_lock:
                job = jobs.jobs.get(job_id) or rec
                job["character_sheet"]["completed"] = index + 1
                job.update({
                    "current_step": (index + 1) * steps,
                    "progress": int(round(((index + 1) / view_count) * 100)),
                    "step_progress": 100,
                    "progress_phase": f"view {index + 1}/{view_count} done",
                })
                jobs.jobs[job_id] = job
                rec = job
        grid = config.character_sheet_grid(len(tiles))
        header_lines = [
            f"CHARACTER SHEET · SEED {seed} · STEPS {steps} · GUIDANCE {guidance}",
            f"{view_count} views · " + " / ".join(view["label"] for view in views),
            (prompt or "")[:200],
        ]
        sheet_path = runners._compose_labeled_sheet(
            config.OUT_DIR / f"charsheet_{job_id}_sheet.png",
            grid["rows"],
            grid["cols"],
            grid["square"],
            tiles,
            header_lines,
            tag="character-sheet",
        )
        sheet_outputs = []
        if sheet_path is not None:
            sheet_outputs = [str(jobs.mirror_output_to_comfy_output(sheet_path, job_id=job_id).resolve())]
        rec["character_sheet"]["sheet"] = bool(sheet_outputs)
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": sheet_outputs + view_outputs,
            "elapsed_seconds": round(time.monotonic() - t0, 2),
            "progress": 100,
            "step_progress": 100,
            "progress_phase": "done",
        })
    except Exception as e:
        # Keep the views that did finish — they are already mirrored, and a
        # partial turnaround is still useful.
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(e), "outputs": view_outputs})
    finally:
        if staging_dir is not None:
            shutil.rmtree(staging_dir, ignore_errors=True)
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


def _comfy_history_prompt_tuple_for_native_ltx(job_id, workflow=None, backend='mlx-ltx-eros-video'):
    extra = {'backend': backend}
    if workflow:
        extra['extra_pnginfo'] = {'workflow': _history.scrub_workflow_prompt_text(workflow)}
    return [0, job_id, {}, extra, []]


def queue_native_mlx_ltx_job(native, workflow=None):
    if not config.supports_native_mlx_ltx_route():
        raise RuntimeError(f"native MLX LTX route is not available for accelerator profile {config.accelerator_profile()}")
    variant = native.get('variant')
    spec = config.LTX2_MLX_VARIANTS.get(variant)
    if not spec:
        raise RuntimeError(f"unknown native MLX LTX variant: {variant}")
    options = dict(native.get('options') or {})
    native = {**native, 'options': options}
    operation = str(native.get('operation') or 'generate')
    native_keyframes = native.get('images') if isinstance(native.get('images'), list) else []
    native_loras = graphs._native_ltx_loras(options.get('loras') or [])
    job_id = uuid.uuid4().hex[:12]
    backend = graphs._ltx_mlx_backend_name(spec, variant)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = {
            "id": job_id,
            "prompt": _history.PRIVATE_PROMPT_LABEL,
            "comfy_prompt": _comfy_history_prompt_tuple_for_native_ltx(job_id, workflow, backend),
            "status": "queued",
            "backend": backend,
            "created_at": util.now_iso(),
            "outputs": [],
            "options": {
                "variant": variant,
                "title": spec.get('title'),
                "width": options.get('width'),
                "height": options.get('height'),
                "frames": options.get('frames'),
                "frame_rate": options.get('frame_rate'),
                "seed": options.get('seed'),
                "operation": operation,
                **({"ingredient_source_count": options.get('ingredient_source_count'),
                    "ingredient_sheet_columns": options.get('ingredient_sheet_columns'),
                    "ingredient_sheet_rows": options.get('ingredient_sheet_rows'),
                    "ingredient_conditioning_only": options.get('ingredient_conditioning_only', True),
                    } if operation == 'ic-lora' and options.get('ingredient_source_count') else {}),
                **({"source_video": Path(str(native.get('video_path') or '')).name,
                    "duration_seconds": options.get('duration_seconds'),
                    "extension_output_frames": options.get('extension_output_frames'),
                    "extension_latent_frames": options.get('extension_latent_frames', options.get('extend_latent_frames')),
                    "extension_pipeline": "distilled" if options.get('distilled', spec.get('video_distilled', False)) else "dev"} if operation == 'extend' else {}),
                **({'lora_count': len(native_loras), 'loras': [
                    {'name': item.get('name') or Path(str(item.get('source') or '')).name, 'strength': item.get('scale', 1.0)}
                    for item in native_loras
                ]} if native_loras else {}),
                "keyframes": [
                    {
                        "image": Path(str(item.get('image_path') or item.get('image') or '')).name,
                        "frame": item.get('frame'),
                        "strength": item.get('strength'),
                        **({"role": item.get("role")} if item.get("role") else {}),
                    }
                    for item in native_keyframes
                    if isinstance(item, dict)
                ],
                "benchmark_seconds": spec.get('benchmark_seconds'),
            },
            "source": "comfy-prompt-intercept",
        }
    jobs.start_studio_generation_thread(
        'video', options, run_native_mlx_ltx_video, (job_id, native, workflow))
    return job_id


def _resolve_native_ltx_image_path(value):
    image_path = Path(str(value or ''))
    if not image_path.is_absolute():
        image_path = config.COMFY_INPUT_DIR / str(image_path)
    return image_path.resolve()


def _resolve_native_ltx_video_path(value):
    return _resolve_native_ltx_image_path(value)


# Post-generation grain cleanup for the distilled LTX path.
#
# The distilled two-stage pipeline refines the upscaled latent in 3 steps, which
# leaves a fine high-frequency residue that is re-rolled every frame — it reads
# as crawling grain. atadenoise is the right tool: it averages each pixel across
# neighbouring frames ONLY while the pixel stays inside a threshold, so static
# grain is averaged away while anything that actually moves is left alone (a
# plain temporal blur, e.g. hqdn3d's temporal terms, would trade the grain for
# more ghosting). The `strong` tier adds a purely SPATIAL hqdn3d pass — its two
# temporal terms are pinned to 0 for the same reason.
LTX_DENOISE_FILTERS = {
    'light': 'atadenoise=0a=0.02:0b=0.04:1a=0.02:1b=0.04:2a=0.02:2b=0.04:s=9',
    'strong': 'atadenoise=0a=0.04:0b=0.08:1a=0.04:1b=0.08:2a=0.04:2b=0.08:s=17,hqdn3d=1.5:1.0:0:0',
}


def normalize_ltx_denoise_mode(value):
    """Accept off/light/strong (plus loose truthy spellings); '' means no pass."""
    mode = str(value or '').strip().lower()
    if mode in LTX_DENOISE_FILTERS:
        return mode
    if mode in {'1', 'true', 'yes', 'on'}:
        return 'light'
    return ''


def apply_ltx_denoise_pass(path, mode):
    """Re-encode `path` in place through the grain filter. Returns a detail dict.

    Failure is non-fatal: the untouched original stays on disk, because a clip
    with grain beats no clip at all.
    """
    mode = normalize_ltx_denoise_mode(mode)
    if not mode:
        return None
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        return {'mode': mode, 'applied': False, 'error': 'ffmpeg not found'}
    target = Path(path)
    scratch = target.with_name(f'{target.stem}.denoise-tmp{target.suffix or ".mp4"}')
    cmd = [
        ffmpeg, '-y', '-loglevel', 'error',
        '-i', str(target),
        '-vf', LTX_DENOISE_FILTERS[mode],
        '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p',
        # LTX generates audio alongside the video — keep it bit-exact.
        '-c:a', 'copy',
        '-movflags', '+faststart',
        str(scratch),
    ]
    started = time.monotonic()
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        if result.returncode != 0 or not scratch.exists() or scratch.stat().st_size < 1000:
            detail = (result.stderr or result.stdout or 'unknown ffmpeg error').strip()
            scratch.unlink(missing_ok=True)
            return {'mode': mode, 'applied': False, 'error': detail[-400:]}
        os.replace(scratch, target)
        return {'mode': mode, 'applied': True, 'seconds': round(time.monotonic() - started, 2)}
    except Exception as exc:
        scratch.unlink(missing_ok=True)
        return {'mode': mode, 'applied': False, 'error': str(exc)[-400:]}


# BFS "Best Face Swap" head-swap IC-LoRA (Alissonerdx). Its v3 conditioning is a
# GUIDE VIDEO, not a plain reference: every frame reserves a strip filled with
# chroma green holding the replacement face, placed ALONGSIDE the source footage
# so the new identity stays visible for the whole clip. Reproduced from the
# author's own ReservedRegionFrameComposer node (ComfyUI-BFSNodes/nodes.py) using
# the settings baked into workflow_ltx2_head_swap_drag_and_drop_v3.0.json, node 360:
#   ["left", 256, "all_faces_every_frame", 12, "loop", "auto", 100, 12, 12,
#    "center", "center", 0, 255, 0]
# i.e. a 256px strip on the LEFT, face at 100% scale, 12px padding, centred, and
# present in every frame. Getting the strip side or the chroma colour wrong gives
# the model conditioning it was never trained on, so these are not free knobs.
#
# The strip belongs to the GUIDE ONLY. Per the author's model card: "Even though
# the guide video used during inference contains the vertical chroma-key side
# strip, the final generated result does not include that strip." The workflow
# agrees — its sampler latent is sized from the un-stripped source (GetImageSize
# -> SolidMask) and nothing is cropped after VAEDecode. So the render is sized to
# the SOURCE frame, the guide is wider than it, and the output is delivered as-is.
BFS_HEADSWAP_REGION_PX = 256
BFS_HEADSWAP_REGION_POSITION = 'left'
BFS_HEADSWAP_CHROMA = '0x00FF00'
BFS_HEADSWAP_FACE_PADDING_PX = 12
# _prepare_face in the same node adds a 16px white border before placement.
BFS_HEADSWAP_FACE_BORDER_PX = 16
# Both axes of the render must sit on the pipeline's latent grid. Single-stage
# needs multiples of 32, the half-res paths (--upsample-only) need 64; snapping
# to 64 keeps the delivered size identical whichever sampler path is chosen,
# instead of the runtime silently flooring it to something else.
BFS_HEADSWAP_DIMENSION_GRID = 64
# v3's trigger. v1/v2 used a bare "head swap"; v3 is the structured form, and the
# author's card is explicit that the FACE/ACTION sections carry the identity and
# motion description the adapter was trained against.
BFS_HEADSWAP_PROMPT_HELP = (
    'head-swap prompts need the BFS v3 trigger, or the IC-LoRA does not engage and the '
    'render just reproduces the guide. Use:\n'
    '  head_swap: FACE: <apparent gender, ethnicity, skin tone, age range, head shape, hair> '
    'ACTION: <clothing, body position, movement, hand actions, objects, camera-facing behaviour>'
)


def bfs_headswap_lora_selected(item):
    """Is this LoRA entry the BFS head-swap adapter?

    Matched on the filename because that is all the runner carries. The author's
    release is head_swap_v3_rank_adaptive_fro_098.safetensors; earlier versions
    and renames still read as head-swap.
    """
    if not isinstance(item, dict):
        return False
    text = f"{item.get('filePath') or ''} {item.get('name') or ''} {item.get('source') or ''}".lower()
    return 'head_swap' in text or 'head-swap' in text or 'headswap' in text


FACEFUSION_DIR = Path(os.environ.get('FACEFUSION_DIR', str(Path.home() / 'comfy/facefusion')))
HEADSWAP_BACKENDS = ('bfs', 'facefusion')


def _headswap_backend_name(options):
    """Which head-swap engine this job asked for. Unknown values fall back to BFS."""
    raw = (graphs._prompt_string((options or {}).get('head_swap_backend')) or '').strip().lower()
    return raw if raw in HEADSWAP_BACKENDS else 'bfs'


def facefusion_available():
    return (FACEFUSION_DIR / 'facefusion.py').is_file() and (FACEFUSION_DIR / '.venv' / 'bin' / 'python').is_file()


def run_facefusion_head_swap(job_id, native, options, *, started):
    """Swap the face onto the ORIGINAL frames with FaceFusion.

    The opposite trade to BFS: this never regenerates the picture, so body,
    clothing, background and motion stay bit-identical to the source and the
    whole clip is processed rather than a fixed frame budget — but it replaces
    only the face region, so hair and head shape stay the source actor's. No
    prompt, no LoRA, no guide video; none of the LTX preconditions apply.
    """
    if not facefusion_available():
        raise RuntimeError(
            f'FaceFusion is not installed at {FACEFUSION_DIR}. Clone '
            'https://github.com/facefusion/facefusion there and create its .venv, '
            'or point FACEFUSION_DIR at an existing checkout.'
        )
    source_video = _resolve_native_ltx_video_path(native.get('video_path'))
    face_image = _resolve_native_ltx_image_path(native.get('reference_image_path'))
    allowed = [config.COMFY_INPUT_DIR.resolve(), config.COMFY_OUTPUT_DIR.resolve(), config.OUT_DIR.resolve()]
    for path, label in ((source_video, 'source video'), (face_image, 'face image')):
        if not path.exists() or not any(util._is_under(path, root) for root in allowed):
            raise RuntimeError(f'head-swap {label} is outside private Comfy storage or does not exist')

    out_dir = config.COMFY_OUTPUT_DIR / 'Eros'
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f'facefusion_headswap_{job_id}.mp4'
    rec = {
        'id': job_id,
        'prompt': _history.PRIVATE_PROMPT_LABEL,
        'status': 'running',
        'backend': 'facefusion',
        'created_at': started,
        'outputs': [],
        'options': {
            'operation': 'head-swap',
            'head_swap_backend': 'facefusion',
            'title': 'FaceFusion head swap',
            'source_video': source_video.name,
            'reference_image': face_image.name,
        },
        'progress': 5,
        'progress_phase': 'facefusion',
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    # --processors takes a list; face_enhancer restores detail the 128px swapper
    # loses, at roughly double the runtime.
    processors = ['face_swapper']
    if util.bool_option(options, 'head_swap_face_enhancer', False):
        processors.append('face_enhancer')
    cmd = [
        str(FACEFUSION_DIR / '.venv' / 'bin' / 'python'), 'facefusion.py', 'headless-run',
        '--source-paths', str(face_image),
        '--target-path', str(source_video),
        '--output-path', str(out),
        '--processors', *processors,
        # Apple Silicon has no CUDA; CoreML is what makes this ~10x quicker than
        # the diffusion path rather than slower.
        '--execution-providers', 'coreml',
    ]
    rec['options']['processors'] = list(processors)
    t0 = time.monotonic()
    _media.mark_output_active(out)
    try:
        proc = _run_native_ltx_subprocess(
            job_id, rec, cmd,
            cwd=str(FACEFUSION_DIR),
            env=os.environ.copy(),
            timeout=util.int_option(options, 'runtime_timeout_seconds', 2400, 60, 14400),
        )
        elapsed = round(time.monotonic() - t0, 2)
        if proc.returncode != 0:
            raise RuntimeError(
                f'facefusion exited {proc.returncode}\n'
                f'STDOUT:\n{proc.stdout.strip()[-1500:]}\nSTDERR:\n{proc.stderr.strip()[-1500:]}'
            )
        if not out.exists() or out.stat().st_size < 1000:
            raise RuntimeError('facefusion finished without a valid output video')
        width, height = _probe_video_dimensions(out)
        rec['options'].update({'width': width, 'height': height})
        visible_out = jobs.mirror_output_to_comfy_output(out, job_id=job_id)
        rec.update({
            'status': 'success',
            'finished_at': util.now_iso(),
            'outputs': [str(visible_out.resolve())],
            'elapsed_seconds': elapsed,
            'progress': 100,
            'step_progress': 100,
            'progress_phase': 'done',
        })
    except NativeJobCancelled:
        rec.update({'status': 'cancelled', 'finished_at': util.now_iso(),
                    'error': 'Cancelled by the owner', 'progress_phase': 'cancelled'})
    except Exception as exc:
        rec.update({'status': 'error', 'finished_at': util.now_iso(),
                    'error': str(exc), 'progress_phase': 'error'})
    finally:
        _media.mark_output_inactive(out)
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    return rec


def find_bfs_headswap_lora():
    """Locate the installed BFS head-swap adapter, newest-looking first.

    Matched by name rather than pinned to one filename so a v4 release, or a
    rename, still resolves.
    """
    root = (config.COMFY / 'models' / 'loras')
    if not root.is_dir():
        return None
    found = [p for p in root.glob('*.safetensors') if bfs_headswap_lora_selected({'filePath': str(p)})]
    return sorted(found)[-1] if found else None


def bfs_headswap_prompt_has_trigger(prompt):
    """Does this prompt carry the v3 trigger the head-swap IC-LoRA expects?"""
    text = (graphs._prompt_string(prompt) or '').lower()
    return 'head_swap:' in text or 'head swap:' in text


def _probe_video_dimensions(path):
    """(width, height) of a video's first video stream, or raise."""
    ffprobe = shutil.which('ffprobe')
    if not ffprobe:
        raise RuntimeError('ffprobe is required to measure the source video')
    payload = subprocess.check_output(
        [
            ffprobe, '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height', '-of', 'json', str(path),
        ],
        text=True, stderr=subprocess.DEVNULL, timeout=30,
    )
    stream = (json.loads(payload or '{}').get('streams') or [{}])[0]
    width, height = int(stream.get('width') or 0), int(stream.get('height') or 0)
    if width <= 0 or height <= 0:
        raise RuntimeError(f'Could not read video dimensions from {Path(path).name}')
    return width, height


def _snap_headswap_dimension(value, grid=BFS_HEADSWAP_DIMENSION_GRID):
    """Round a pixel dimension to the nearest grid multiple, never below one."""
    snapped = int(round(float(value) / grid)) * grid
    return max(grid, snapped)


def plan_bfs_headswap_geometry(source_width, source_height, *, region_px=None, max_dimension=0):
    """Decide the guide layout and render size for a head swap. Pure arithmetic.

    Mirrors ReservedRegionFrameComposer exactly: the canvas KEEPS the source
    frame size and the footage is fitted into what the strip leaves, centred,
    with chroma filling the rest::

        canvas = Image.new("RGBA", (orig_w, orig_h), ...)
        video_x, video_y = region_size_px, (orig_h - fitted_video_h) // 2

    The render is therefore the SAME size as the guide, and the delivered frame
    is that render untouched. The model was trained to read the fitted, inset
    footage and draw the swapped scene back out across the WHOLE frame — which
    is why the author's card says the result carries no strip and his workflow
    has no crop node. Widening the canvas instead hands the LoRA a layout it has
    never seen and it just copies the guide through.
    """
    region = int(region_px or BFS_HEADSWAP_REGION_PX)
    region -= region % 32
    if region < 32:
        raise RuntimeError('Head-swap face strip must be at least 32px')
    src_w, src_h = int(source_width), int(source_height)
    if src_w <= 0 or src_h <= 0:
        raise RuntimeError('Head-swap source video has no usable dimensions')
    width, height = float(src_w), float(src_h)
    cap = int(max_dimension or 0)
    if cap > 0 and max(width, height) > cap:
        ratio = cap / max(width, height)
        width, height = width * ratio, height * ratio
    frame_w = _snap_headswap_dimension(width)
    frame_h = _snap_headswap_dimension(height)
    available_w = frame_w - region
    if available_w < 64:
        raise RuntimeError(
            f'Head-swap strip ({region}px) leaves no room in a {frame_w}px frame'
        )
    # Fit the footage into what is left, preserving its aspect (the node's
    # "fitted_video_*"). Even dimensions keep libx264/yuv420p happy.
    fit = min(available_w / src_w, frame_h / src_h)
    video_w = max(2, int(round(src_w * fit)) & ~1)
    video_h = max(2, int(round(src_h * fit)) & ~1)
    return {
        'width': frame_w,
        'height': frame_h,
        'region_px': region,
        'video_width': video_w,
        'video_height': video_h,
        'video_x': region if BFS_HEADSWAP_REGION_POSITION == 'left' else 0,
        'video_y': (frame_h - video_h) // 2,
        # The render, and so the delivered frame, is the whole canvas.
        'content_width': frame_w,
        'content_height': frame_h,
        'source_width': src_w,
        'source_height': src_h,
    }


def build_bfs_headswap_guide_video(source_video, face_image, output_path, *, region_px=None, max_dimension=0, frame_rate=None):
    """Compose the BFS head-swap guide clip: reserved face strip + fitted source.

    Reproduces ReservedRegionFrameComposer — same frame size as the source, the
    footage fitted into what the strip leaves and centred, chroma everywhere
    else. The caller renders at ``width`` x ``height`` (the whole canvas) and
    ships that untouched; see the BFS_HEADSWAP_* notes for why nothing is cropped.
    """
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise RuntimeError('ffmpeg is required to build the BFS head-swap guide video')
    src_w, src_h = _probe_video_dimensions(source_video)
    geometry = plan_bfs_headswap_geometry(src_w, src_h, region_px=region_px, max_dimension=max_dimension)
    canvas_w, height = geometry['width'], geometry['height']
    region = geometry['region_px']
    video_w, video_h = geometry['video_width'], geometry['video_height']
    video_x, video_y = geometry['video_x'], geometry['video_y']
    face_w = max(8, region - 2 * BFS_HEADSWAP_FACE_PADDING_PX)
    face_h = max(8, height - 2 * BFS_HEADSWAP_FACE_PADDING_PX)
    face_x = BFS_HEADSWAP_FACE_PADDING_PX if BFS_HEADSWAP_REGION_POSITION == 'left' else canvas_w - region + BFS_HEADSWAP_FACE_PADDING_PX

    output_path.parent.mkdir(parents=True, exist_ok=True)
    filtergraph = (
        f"color=c={BFS_HEADSWAP_CHROMA}:s={canvas_w}x{height}[bg];"
        f"[1:v]pad=iw+{2 * BFS_HEADSWAP_FACE_BORDER_PX}:ih+{2 * BFS_HEADSWAP_FACE_BORDER_PX}:"
        f"{BFS_HEADSWAP_FACE_BORDER_PX}:{BFS_HEADSWAP_FACE_BORDER_PX}:white,"
        f"scale={face_w}:{face_h}:force_original_aspect_ratio=decrease[face];"
        f"[bg][face]overlay=x={face_x}:y=(H-h)/2[withface];"
        # Fitted, not stretched: the node preserves the footage's aspect inside
        # the leftover width and lets chroma take the slack above and below.
        f"[0:v]scale={video_w}:{video_h}[content];"
        f"[withface][content]overlay=x={video_x}:y={video_y}:shortest=1[out]"
    )
    cmd = [
        ffmpeg, '-y', '-loglevel', 'error',
        '-i', str(source_video),
        '-loop', '1', '-i', str(face_image),
        '-filter_complex', filtergraph,
        '-map', '[out]',
    ]
    if frame_rate:
        # Resample the guide to the RENDER's frame rate. The runtime reads the
        # first N frames of the guide at its native rate, so a 25fps guide driving
        # a 24fps render walks reference frame i and output frame i apart by 4%
        # over the clip — the swapped face lags the motion it is meant to track.
        cmd.extend(['-r', str(frame_rate)])
        geometry['frame_rate'] = float(frame_rate)
    cmd.extend([
        '-c:v', 'libx264', '-crf', '12', '-preset', 'medium', '-pix_fmt', 'yuv420p',
        str(output_path),
    ])
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if result.returncode != 0 or not output_path.exists() or output_path.stat().st_size < 1000:
        detail = (result.stderr or result.stdout or 'unknown ffmpeg error').strip()
        raise RuntimeError(f'Head-swap guide build failed: {detail[-400:]}')
    return geometry


# Lightricks' IC-LoRA Detailer. Published against "LTX-2-19b", which reads like a
# different base than our 22B — but it targets transformer_blocks 0..47 at hidden
# dim 4096 and resolves 480/480 modules against the v1.4 transformer, so the two
# share topology and it fuses cleanly. It carries no .alpha tensors, so the
# strength passed here is the whole story.
LTX_DETAILER_LORA = 'LTX2_IC_LoRA_Detailer.safetensors'


def apply_ltx_detailer_pass(path, options, *, model_path, prompt, height, width, frames, frame_rate, seed, job_id, rec, env):
    """Optionally refine `path` in place with the IC-LoRA Detailer.

    This is a genuine second sampling pass, not a filter: the Detailer is an
    IC-LoRA that conditions on reference video frames, so the first pass's own
    output is fed back as the conditioning video.

    Returns None the instant no strength is set, which is what keeps an ordinary
    generation exactly as fast as it was before this existed. Failure is
    non-fatal for the same reason the denoise pass is — the un-refined clip is
    still a clip.
    """
    try:
        strength = float(options.get('detailer_strength') or 0)
    except (TypeError, ValueError):
        return None
    if strength <= 0:
        return None
    strength = max(0.05, min(1.5, strength))

    lora = (config.COMFY / 'models' / 'loras' / LTX_DETAILER_LORA)
    if not lora.is_file():
        return {'strength': strength, 'applied': False, 'error': f'{LTX_DETAILER_LORA} not installed'}

    target = Path(path)
    scratch = target.with_name(f'{target.stem}.detailer-tmp{target.suffix or ".mp4"}')
    cmd = [
        "uv", "run", "ltx-2-mlx", "ic-lora",
        "--model", str(model_path),
        "--gemma", config.LTX2_MLX_GEMMA,
        "--prompt", prompt,
        "--lora", str(lora), str(strength),
        # The clip we just made is the reference. Strength 1.0 keeps its
        # structure; the Detailer LoRA is what adds texture on top.
        "--video-conditioning", str(target), "1.0",
        "--single-stage",
        "-H", str(height), "-W", str(width), "-f", str(frames),
        "--frame-rate", str(frame_rate),
        "--seed", str(seed),
        "-o", str(scratch),
    ]
    started = time.monotonic()
    rec["progress_phase"] = "ltx-2-mlx detailer"
    try:
        proc = _run_native_ltx_subprocess(
            job_id, rec, cmd, cwd=str(config.LTX2_MLX_DIR), env=env,
            timeout=util.int_option(options, 'runtime_timeout_seconds', 2400, 60, 14400),
        )
        if proc.returncode != 0 or not scratch.exists() or scratch.stat().st_size < 1000:
            detail = ((proc.stderr or proc.stdout or 'unknown detailer error')).strip()
            scratch.unlink(missing_ok=True)
            return {'strength': strength, 'applied': False, 'error': detail[-400:]}
        os.replace(scratch, target)
        return {'strength': strength, 'applied': True, 'seconds': round(time.monotonic() - started, 2)}
    except NativeJobCancelled:
        scratch.unlink(missing_ok=True)
        raise
    except Exception as exc:
        scratch.unlink(missing_ok=True)
        return {'strength': strength, 'applied': False, 'error': str(exc)[-400:]}


def _create_native_ltx_static_reference_video(image_path, output_path, frames, frame_rate):
    """Encode a lossless repeated reference sheet for MLX IC-LoRA conditioning."""
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise RuntimeError('ffmpeg is required for native MLX IC-LoRA reference conditioning')
    output_path.parent.mkdir(parents=True, exist_ok=True)
    frame_rate_arg = str(int(frame_rate)) if float(frame_rate).is_integer() else str(frame_rate)
    cmd = [
        ffmpeg, '-y', '-loglevel', 'error',
        '-loop', '1', '-framerate', frame_rate_arg,
        '-i', str(image_path),
        '-frames:v', str(frames),
        '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'rgb24',
        str(output_path),
    ]
    result = subprocess.run(cmd, text=True, capture_output=True, timeout=180)
    if result.returncode != 0 or not output_path.exists() or output_path.stat().st_size < 1000:
        detail = (result.stderr or result.stdout or 'unknown ffmpeg error').strip()
        raise RuntimeError(f'failed to prepare lossless IC-LoRA reference video: {detail[-1200:]}')
    return output_path


def _native_ltx_runtime_keyframes(native, frames):
    specs = native.get('images') if isinstance(native.get('images'), list) else []
    options = native.get('options') if isinstance(native.get('options'), dict) else {}
    default_crf = util.int_option(options, 'image_crf', 33, 0, 63)
    if not specs:
        specs = [{'image_path': native.get('image_path'), 'frame': 0, 'strength': 1.0, 'role': 'start'}]
    out = []
    for item in specs:
        if not isinstance(item, dict):
            continue
        image_name = graphs._native_ltx_keyframe_image_name(item) or graphs._prompt_string(item.get('image_path'))
        if not image_name:
            continue
        try:
            frame = max(0, min(frames - 1, int(round(float(item.get('frame', 0))))))
        except Exception:
            frame = 0
        out.append({
            'path': _resolve_native_ltx_image_path(image_name),
            'frame': frame,
            'strength': graphs._native_ltx_keyframe_strength(item),
            'crf': util.int_option(item, 'crf', default_crf, 0, 63),
            'role': str(item.get('role') or '').strip() or None,
        })
    if not out and native.get('image_path'):
        out.append({
            'path': _resolve_native_ltx_image_path(native.get('image_path')),
            'frame': 0,
            'strength': 1.0,
            'crf': default_crf,
            'role': 'start',
        })
    return sorted(out, key=lambda item: item['frame'])


def _ltx_anchor_cache_path(source, width, height, prompt, seed):
    digest = hashlib.sha256()
    digest.update(b'ltx-anchor-canvas-v4\0')
    digest.update(Path(source).read_bytes())
    digest.update(f'\0{int(width)}x{int(height)}\0{int(seed)}\0'.encode('utf-8'))
    digest.update(str(prompt or '').encode('utf-8'))
    return config.COMFY_INPUT_DIR / '.ltx-anchor-cache' / f'{digest.hexdigest()[:24]}.png'


def _ltx_target_description(prompt):
    text = str(prompt or '').strip()
    marker = '### Target Description'
    if marker in text:
        return text.rsplit(marker, 1)[1].strip()
    return text


def _stage_ltx_anchor_source_for_comfy(source):
    source = Path(source).resolve()
    input_root = config.COMFY_INPUT_DIR.resolve()
    if util._is_under(source, input_root):
        return source, source.relative_to(input_root).as_posix()
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:24]
    suffix = source.suffix.lower() if source.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'} else '.png'
    staged = input_root / '.ltx-anchor-sources' / f'{digest}{suffix}'
    staged.parent.mkdir(parents=True, exist_ok=True)
    if not staged.exists():
        shutil.copyfile(source, staged)
    return staged, staged.relative_to(input_root).as_posix()


def _write_ltx_anchor_resize(source, output, width, height):
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise RuntimeError('ffmpeg is required to prepare LTX timeline anchors')
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_name(f'.{output.stem}.{uuid.uuid4().hex[:8]}.tmp.png')
    result = subprocess.run(
        [
            ffmpeg, '-y', '-loglevel', 'error', '-i', str(source),
            '-vf', f'scale={int(width)}:{int(height)}:flags=lanczos',
            '-frames:v', '1', str(temp),
        ],
        text=True,
        capture_output=True,
        timeout=120,
    )
    if result.returncode != 0 or not temp.is_file():
        temp.unlink(missing_ok=True)
        detail = (result.stderr or result.stdout or 'unknown ffmpeg error').strip()
        raise RuntimeError(f'failed to resize LTX anchor: {detail[-1200:]}')
    os.replace(temp, output)


def _prepare_native_ltx_anchor_canvas(source, width, height, prompt, seed):
    """Prepare one physical target-sized anchor with the shared Krea graph."""
    source = Path(source).resolve()
    dimensions = graphs._image_dimensions(source)
    if not dimensions:
        raise RuntimeError(f'could not read LTX anchor dimensions: {source.name}')
    source_width, source_height = dimensions
    staged_source, image_name = _stage_ltx_anchor_source_for_comfy(source)
    compiled = config.build_krea2_turbo_outpaint_prompt(
        prompt,
        image_name,
        source_width=source_width,
        source_height=source_height,
        options={
            'width': width,
            'height': height,
            'seed': seed,
            'steps': 10,
            'cfg': 1.0,
            'ref_boost': 4.0,
            'identity_strength': 1.0,
            'grounding_px': 768,
            'feathering': 48,
        },
        profile=config.accelerator_profile(),
        filename_prefix='ltx_anchor_canvas',
    )
    geometry = compiled['geometry']
    if geometry['mode'] == 'passthrough':
        return staged_source, geometry

    output = _ltx_anchor_cache_path(staged_source, width, height, prompt, seed)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.is_file():
        return output, {**geometry, 'cached': True}
    if geometry['mode'] == 'resize':
        _write_ltx_anchor_resize(staged_source, output, width, height)
        return output, {**geometry, 'cached': False}

    graph = compiled['graph']
    prefix = f'ltx_anchor_canvas_{output.stem}'
    graph['12']['inputs']['filename_prefix'] = prefix
    body = json.dumps({
        'prompt': graph,
        'client_id': f'media-ltx-anchor-{uuid.uuid4().hex[:12]}',
    }).encode('utf-8')
    request = Request(
        f'{config.COMFY_HTTP_DEFAULT}/prompt',
        data=body,
        headers={'Content-Type': 'application/json'},
    )
    try:
        queued = json.loads(net.urlopen(request, timeout=30).read().decode('utf-8'))
    except HTTPError as exc:
        detail = exc.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'ComfyUI rejected LTX anchor outpaint graph: {detail[:4000]}') from exc
    prompt_id = queued.get('prompt_id')
    if not prompt_id:
        raise RuntimeError(f'ComfyUI did not return an LTX anchor prompt id: {queued}')

    history = None
    for _ in range(900):
        time.sleep(0.5)
        try:
            payload = net.urlopen(f'{config.COMFY_HTTP_DEFAULT}/history/{prompt_id}', timeout=10).read().decode('utf-8')
            data = json.loads(payload or '{}')
            if prompt_id in data:
                history = data[prompt_id]
                break
        except Exception:
            pass
    if history is None:
        raise RuntimeError(f'LTX anchor outpaint timed out waiting for prompt {prompt_id}')
    status = history.get('status') or {}
    if status.get('status_str') != 'success' or not status.get('completed'):
        raise RuntimeError(f'LTX anchor outpaint failed: {status}')
    media = None
    for node_output in (history.get('outputs') or {}).values():
        images = node_output.get('images') or []
        if images:
            media = images[0]
            break
    if not media:
        raise RuntimeError('LTX anchor outpaint completed without an image')
    logical = (config.COMFY_OUTPUT_DIR / str(media.get('subfolder') or '') / util.safe_name(media.get('filename') or '')).resolve()
    if logical.is_file():
        image_bytes = logical.read_bytes()
    elif _media.encrypted_path_for(logical).is_file():
        image_bytes, _ = _media.decrypt_output_bytes(logical)
    else:
        raise RuntimeError('LTX anchor outpaint image disappeared before staging')
    temp = output.with_name(f'.{output.stem}.{uuid.uuid4().hex[:8]}.tmp.png')
    temp.write_bytes(image_bytes)
    os.replace(temp, output)
    return output, {**geometry, 'cached': False}


def _update_native_ltx_process_progress(job_id, rec, text):
    matches = list(re.finditer(r"Denoising(?: \(guided\))?:[^\r\n]*?\|\s*(\d+)/(\d+)\s*\[", text))
    if matches:
        current, total = (int(value) for value in matches[-1].groups())
        rec.update({
            "current_step": current,
            "total_steps": total,
            "progress": min(90, 10 + round(80 * current / max(1, total))),
            "step_progress": round(100 * current / max(1, total)),
            "progress_phase": "denoising",
        })
    elif "Decoding video + audio" in text:
        rec.update({"progress": 94, "progress_phase": "decoding"})
    elif "Loading decoders" in text:
        rec.update({"progress": 91, "progress_phase": "loading-decoders"})
    else:
        return
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


class NativeJobCancelled(Exception):
    """The owner cancelled a native generation job; the runner marks it 'cancelled'."""


def native_job_cancel_requested(job_id):
    with jobs.jobs_lock:
        return bool((jobs.jobs.get(job_id) or {}).get('cancel_requested'))


def _run_native_ltx_subprocess(job_id, rec, cmd, *, cwd, env, timeout=2400):
    """Run ltx-2-mlx while publishing tqdm progress from both output streams."""
    if native_job_cancel_requested(job_id):
        raise NativeJobCancelled(f"job {job_id} was cancelled before the render started")
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
        # Its own process group, so shutdown can kill the whole render — the
        # runner spawns workers of its own, and terminating only the parent
        # leaves them holding the GPU.
        start_new_session=True,
    )
    with jobs.jobs_lock:
        jobs.native_job_procs[job_id] = proc
    streams = [stream for stream in (proc.stdout, proc.stderr) if stream is not None]
    output = {proc.stdout: bytearray(), proc.stderr: bytearray()}
    progress_tail = ""
    started = time.monotonic()
    try:
        while streams:
            if native_job_cancel_requested(job_id):
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
                raise NativeJobCancelled(f"job {job_id} was cancelled mid-render")
            if time.monotonic() - started > timeout:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
                raise subprocess.TimeoutExpired(cmd, timeout)
            ready, _, _ = select.select(streams, [], [], 0.25)
            for stream in ready:
                chunk = os.read(stream.fileno(), 8192)
                if not chunk:
                    streams.remove(stream)
                    continue
                output[stream].extend(chunk)
                if len(output[stream]) > 500_000:
                    del output[stream][:-500_000]
                progress_tail = (progress_tail + chunk.decode('utf-8', errors='replace'))[-8192:]
                _update_native_ltx_process_progress(job_id, rec, progress_tail)
        returncode = proc.wait()
    except Exception:
        if proc.poll() is None:
            proc.terminate()
        raise
    finally:
        with jobs.jobs_lock:
            if jobs.native_job_procs.get(job_id) is proc:
                jobs.native_job_procs.pop(job_id, None)
    # The cancel route may have terminated the process directly, between this
    # loop's flag checks — report that as a cancellation, not an exit -15 error.
    if returncode != 0 and native_job_cancel_requested(job_id):
        raise NativeJobCancelled(f"job {job_id} was cancelled mid-render")
    stdout = bytes(output.get(proc.stdout, b'')).decode('utf-8', errors='replace')
    stderr = bytes(output.get(proc.stderr, b'')).decode('utf-8', errors='replace')
    return subprocess.CompletedProcess(cmd, returncode, stdout=stdout, stderr=stderr)


def run_native_mlx_ltx_video(job_id, native, workflow=None):
    started = util.now_iso()
    variant = native.get('variant')
    spec = config.LTX2_MLX_VARIANTS.get(variant) or {}
    backend = graphs._ltx_mlx_backend_name(spec, variant)
    options = dict(native.get('options') or {})
    operation = str(native.get('operation') or 'generate').strip().lower()
    # FaceFusion is a different kind of tool entirely — a per-frame 2D swap onto
    # the original footage, with no diffusion model, prompt, LoRA or guide. It
    # therefore branches out before every LTX precondition below, which would
    # otherwise demand a model and a prompt it has no use for.
    if operation == 'head-swap' and _headswap_backend_name(options) == 'facefusion':
        return run_facefusion_head_swap(job_id, native, options, started=started)
    prompt = str(native.get('prompt') or '').strip()
    width = util.int_quality_option(options, 'width', 480)
    height = util.int_quality_option(options, 'height', 832)
    # Only generate and ic-lora pass -H/-W to the CLI; extend inherits the
    # source clip's size and head-swap re-derives its own from the guide.
    if operation in ('generate', 'ic-lora'):
        snapped = graphs._ltx_snap_render_dimensions(
            width, height,
            single_stage=operation == 'ic-lora' and bool(options.get('single_stage', True)),
        )
        if snapped != (width, height):
            print(f"[ltx] {job_id} render size {width}x{height} is off the pipeline grid; snapped to {snapped[0]}x{snapped[1]}", flush=True)
            width, height = snapped
    frames = graphs._ltx_valid_frame_count(options.get('frames', 233), 233)
    if operation == 'ic-lora':
        frames = max(frames, util.int_option(options, 'target_min_frames', 9, 9, 721))
    reference_min_frames = util.int_option(options, 'reference_min_frames', 121, 1, 10000)
    reference_frames = max(frames, reference_min_frames)
    frame_rate = util.float_quality_option(options, 'frame_rate', 24.0)
    frame_rate_arg = str(int(frame_rate)) if float(frame_rate).is_integer() else str(frame_rate)
    seed = util.int_option(options, 'seed', 42, 0, 1_000_000_000)
    keyframes = _native_ltx_runtime_keyframes(native, frames)
    native_loras = graphs._native_ltx_loras(options.get('loras') or [])
    cfg_scale = util.float_quality_option(options, 'cfg_scale', util.float_quality_option(options, 'cfg', 0.0))
    model_path = Path(str(options.get('model') or spec.get('model') or '')).resolve()
    out_dir = config.COMFY_OUTPUT_DIR / graphs._ltx_mlx_output_subdir(spec)
    out_dir.mkdir(parents=True, exist_ok=True)
    extension_output_frames = int(options.get('extension_output_frames') or (int(options.get('extend_latent_frames') or 0) * 8))
    extension_latent_frames = int(options.get('extension_latent_frames') or options.get('extend_latent_frames') or 0)
    distilled_extension = operation == 'extend' and bool(options.get('distilled', spec.get('video_distilled', False)))
    output_frame_label = f"extend-{extension_output_frames}f" if operation == 'extend' else f"{frames}f"
    out = out_dir / f"{spec.get('output_prefix', 'mlx_ltx_eros_mobile')}_{job_id}_{output_frame_label}.mp4"
    reference_video_path = None
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "comfy_prompt": _comfy_history_prompt_tuple_for_native_ltx(job_id, workflow, backend),
        "status": "running",
        "backend": backend,
        "created_at": started,
        "outputs": [],
        "options": {
            "variant": variant,
            "title": spec.get('title'),
            "model": str(model_path),
            "width": width,
            "height": height,
            "frames": frames,
            "frame_rate": frame_rate,
            "seed": seed,
            "operation": operation,
            **({"reference_image": Path(str(native.get('reference_image_path') or '')).name,
                "conditioning_strength": options.get('conditioning_strength', 1.0),
                "reference_strength": options.get('reference_strength', 1.0),
                "reference_frames": reference_frames,
                "single_stage": bool(options.get('single_stage', True)),
                **({"ingredient_source_count": options.get('ingredient_source_count'),
                    "ingredient_sheet_columns": options.get('ingredient_sheet_columns'),
                    "ingredient_sheet_rows": options.get('ingredient_sheet_rows'),
                    "ingredient_conditioning_only": options.get('ingredient_conditioning_only', True),
                    } if options.get('ingredient_source_count') else {}),
                } if operation == 'ic-lora' else {}),
            **({"source_video": Path(str(native.get('video_path') or '')).name,
                "duration_seconds": options.get('duration_seconds'),
                "extension_output_frames": extension_output_frames,
                "extension_latent_frames": extension_latent_frames,
                "extension_pipeline": "distilled" if distilled_extension else "dev"} if operation == 'extend' else {}),
            **({'cfg_scale': cfg_scale} if cfg_scale else {}),
            **({'lora_count': len(native_loras), 'loras': [
                {'name': item.get('name') or Path(str(item.get('source') or '')).name, 'strength': item.get('scale', 1.0)}
                for item in native_loras
            ]} if native_loras else {}),
            "keyframes": [
                {
                    "image": item['path'].name,
                    "frame": item['frame'],
                    "strength": item['strength'],
                    "crf": item['crf'],
                    **({"role": item["role"]} if item.get("role") else {}),
                }
                for item in keyframes
            ],
            "benchmark_seconds": spec.get('benchmark_seconds'),
        },
        "current_step": 0,
        "total_steps": 8 if operation == 'ic-lora' or distilled_extension else (int(options.get('steps') or 30) if operation == 'extend' else 2),
        "progress": 0,
        "step_progress": 0,
        "progress_phase": "queued",
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    try:
        if not config.supports_native_mlx_ltx_route():
            raise RuntimeError(f"native MLX LTX route is not available for accelerator profile {config.accelerator_profile()}")
        if not config.LTX2_MLX_DIR.exists():
            raise RuntimeError(f"ltx-2-mlx checkout not found: {config.LTX2_MLX_DIR}")
        if not model_path.exists():
            raise RuntimeError(f"MLX LTX model not found: {model_path}")
        if not prompt:
            raise RuntimeError("prompt is required for native MLX LTX generation")
        allowed = [config.COMFY_INPUT_DIR.resolve(), config.COMFY_OUTPUT_DIR.resolve(), config.OUT_DIR.resolve()]
        source_video = None
        reference_image = None
        # Set only on the head-swap path; the shared post-run block reads it to
        # check the render came back at the size the guide was planned around.
        headswap_guide_info = None
        if operation == 'head-swap':
            # Needs both halves of the guide: the footage to alter and the face to
            # put into it. Validate them together so a missing one fails here with
            # a clear message rather than deep inside the ffmpeg filtergraph.
            source_video = _resolve_native_ltx_video_path(native.get('video_path'))
            if not source_video.exists() or not any(util._is_under(source_video, root) for root in allowed):
                raise RuntimeError("head-swap source video is outside private Comfy storage or does not exist")
            reference_image = _resolve_native_ltx_image_path(native.get('reference_image_path'))
            if not reference_image.exists() or not any(util._is_under(reference_image, root) for root in allowed):
                raise RuntimeError("head-swap face image is outside private Comfy storage or does not exist")
            # The BFS adapter is what teaches the model to read the reserved strip
            # and redraw the scene at full frame — without it the render comes
            # back as a copy of the guide. It is therefore a property of the
            # TASK, not a LoRA the operator has to remember to switch on, so the
            # task supplies it. Requiring it by hand cost several full renders
            # that looked like a compositor bug.
            headswap_lora_strength = util.float_quality_option(options, 'head_swap_lora_strength', 1.0)
            selected_bfs = [item for item in native_loras if bfs_headswap_lora_selected(item)]
            if selected_bfs:
                # Honour the operator's own entry, but the task owns its strength.
                for item in selected_bfs:
                    item['scale'] = headswap_lora_strength
            else:
                found = find_bfs_headswap_lora()
                if not found:
                    raise RuntimeError(
                        'head-swap needs the BFS head-swap IC-LoRA, and no file matching '
                        f'"head_swap" was found in {(config.COMFY / "models" / "loras")}. Install it from '
                        'https://civitai.com/models/2027766 (BFS - Best Face Swap).'
                    )
                native_loras.append({
                    'name': found.stem,
                    'filePath': str(found),
                    'scale': headswap_lora_strength,
                })
            if not bfs_headswap_prompt_has_trigger(prompt):
                # Without its trigger the v3 IC-LoRA has nothing to act on, and
                # the cheapest thing the model can do is reproduce the guide it
                # was handed — strip, face box and all. Failing here costs a
                # second; letting it run costs the whole render.
                raise RuntimeError(BFS_HEADSWAP_PROMPT_HELP)
        elif operation == 'extend':
            source_video = _resolve_native_ltx_video_path(native.get('video_path'))
            if not source_video.exists() or not any(util._is_under(source_video, root) for root in allowed):
                raise RuntimeError("input video is outside private Comfy storage or does not exist")
        elif operation == 'ic-lora':
            reference_image = _resolve_native_ltx_image_path(native.get('reference_image_path'))
            if not reference_image.exists() or not any(util._is_under(reference_image, root) for root in allowed):
                raise RuntimeError("IC-LoRA reference image is outside private Comfy storage or does not exist")
            if not native_loras:
                raise RuntimeError("native MLX IC-LoRA generation requires at least one IC-LoRA model")
            for item in keyframes:
                image_path = item['path']
                if not image_path.exists() or not any(util._is_under(image_path, root) for root in allowed):
                    raise RuntimeError("input image is outside private Comfy storage or does not exist")
            dev_transformer = graphs._prompt_string(options.get('dev_transformer'))
            distilled_lora = graphs._prompt_string(options.get('distilled_lora'))
            if dev_transformer and not (model_path / dev_transformer).is_file():
                raise RuntimeError(f"native MLX IC-LoRA dev transformer not found: {dev_transformer}")
            if distilled_lora and not (model_path / distilled_lora).is_file():
                raise RuntimeError(f"native MLX IC-LoRA distilled LoRA not found: {distilled_lora}")
        else:
            # LTX 2.3 generate supports text-to-video: zero keyframes is valid
            # (the ltx-2-mlx CLI simply omits --image). Only validate anchors the
            # caller actually supplied.
            for item in keyframes:
                image_path = item['path']
                if not image_path.exists() or not any(util._is_under(image_path, root) for root in allowed):
                    raise RuntimeError("input image is outside private Comfy storage or does not exist")
        lora_root = (config.COMFY / 'models' / 'loras').resolve()
        for item in native_loras:
            lora_path = Path(str(item.get('filePath') or '')).resolve() if item.get('filePath') else None
            if not lora_path or not lora_path.exists() or not util._is_under(lora_path, lora_root):
                raise RuntimeError(f"native MLX LTX LoRA not found: {item.get('source') or item.get('name') or 'unnamed LoRA'}")
            item['filePath'] = str(lora_path)
        if operation == 'ic-lora' and keyframes:
            rec.update({'progress': 2, 'progress_phase': 'preparing-anchor'})
            with jobs.jobs_lock:
                jobs.jobs[job_id] = rec
            prepared_keyframes = []
            preparation = []
            anchor_prompt = _ltx_target_description(prompt)
            for item in keyframes:
                prepared_path, canvas = _prepare_native_ltx_anchor_canvas(
                    item['path'],
                    width,
                    height,
                    anchor_prompt,
                    seed,
                )
                prepared_keyframes.append({**item, 'path': prepared_path})
                preparation.append({
                    **canvas,
                    'frame': item['frame'],
                    **({'role': item['role']} if item.get('role') else {}),
                })
            keyframes = prepared_keyframes
            rec['options']['keyframes'] = [
                {
                    'image': item['path'].name,
                    'frame': item['frame'],
                    'strength': item['strength'],
                    'crf': item['crf'],
                    **({'role': item['role']} if item.get('role') else {}),
                }
                for item in keyframes
            ]
            rec['options']['anchor_preparation'] = preparation
            with jobs.jobs_lock:
                jobs.jobs[job_id] = rec
        if config._env_enabled("ZIMG_LTX_MLX_FREE_COMFY_BEFORE_RUN", "1"):
            rec["progress_phase"] = "free-comfy"
            with jobs.jobs_lock:
                jobs.jobs[job_id] = rec
            graphs._call_comfy_free_before_ltx()
        if operation == 'extend':
            extend_latent_frames = util.int_option(options, 'extension_latent_frames', util.int_option(options, 'extend_latent_frames', 12, 1, 90), 1, 90)
            steps = util.int_option(options, 'steps', 30, 1, 100)
            stg_scale = util.float_quality_option(options, 'stg_scale', 1.0)
            cmd = [
                "uv", "run", "ltx-2-mlx", "extend",
                *(["--distilled"] if distilled_extension else []),
                "--model", str(model_path),
                "--gemma", config.LTX2_MLX_GEMMA,
                "--prompt", prompt,
                "--video", str(source_video),
                "--extend-frames", str(extend_latent_frames),
                "--direction", "after",
            ]
            if not distilled_extension:
                cmd.extend([
                    "--steps", str(steps),
                    "--cfg-scale", str(cfg_scale or 3.0),
                    "--stg-scale", str(stg_scale),
                ])
            cmd.extend(["--seed", str(seed), "-o", str(out)])
        elif operation == 'head-swap':
            # BFS v3 conditions on a composed guide, not the raw footage: the face
            # sits in a reserved chroma strip that stays visible for every frame,
            # which is what gives it identity that survives the whole clip.
            guide_path = config.COMFY_INPUT_DIR / '.ltx-reference' / f'{job_id}-headswap.mp4'
            guide_info = build_bfs_headswap_guide_video(
                source_video, reference_image, guide_path,
                region_px=util.int_option(options, 'head_swap_region_px', BFS_HEADSWAP_REGION_PX, 32, 2048),
                max_dimension=util.int_option(options, 'head_swap_max_dimension', 0, 0, 4096),
                frame_rate=frame_rate,
            )
            headswap_guide_info = guide_info
            rec['options']['head_swap'] = dict(guide_info)
            # Everything that decides whether a head swap works, except the
            # prompt — which stays out of the log on purpose. Diagnosing this
            # from the guide file alone cost several wrong theories.
            print(
                f"[ltx] head-swap {job_id} model={Path(str(model_path)).name}"
                f" render={guide_info['width']}x{guide_info['height']} frames={frames}"
                f" video={guide_info['video_width']}x{guide_info['video_height']}"
                f"@{guide_info['video_x']},{guide_info['video_y']}"
                f" loras={[(Path(str(i['filePath'])).name, i.get('scale', 1.0)) for i in native_loras]}"
                f" ref_strength={util.float_quality_option(options, 'reference_strength', 1.0)}"
                f" cond_strength={util.float_quality_option(options, 'conditioning_strength', 1.0)}"
                f" pipeline={graphs._prompt_string(options.get('head_swap_pipeline')) or 'single-stage'}"
                f" trigger={bfs_headswap_prompt_has_trigger(prompt)}",
                flush=True,
            )
            # Render the guide's own frame, which is also the source's frame: the
            # model reads the fitted, inset footage and draws the swapped scene
            # back across the WHOLE frame, so this render IS the deliverable.
            # Nothing is cropped — cropping the strip off is what read as a zoom.
            width, height = guide_info['width'], guide_info['height']
            cmd = [
                "uv", "run", "ltx-2-mlx", "ic-lora",
                "--model", str(model_path),
                "--gemma", config.LTX2_MLX_GEMMA,
                "--prompt", prompt,
            ]
            for item in native_loras:
                cmd.extend(["--lora", str(item['filePath']), str(item.get('scale', 1.0))])
            cmd.extend([
                "--video-conditioning", str(guide_path), str(util.float_quality_option(options, 'reference_strength', 1.0)),
                "--conditioning-strength", str(util.float_quality_option(options, 'conditioning_strength', 1.0)),
            ])
            # --single-stage tracks the control most tightly and is the default.
            # The fast path generates at half res with the control applied
            # throughout, upsamples, then runs a control-aware refine.
            if graphs._prompt_string(options.get('head_swap_pipeline')) == 'fast':
                cmd.extend([
                    "--upsample-only",
                    "--refine-steps", str(util.int_option(options, 'head_swap_refine_steps', 3, 1, 8)),
                ])
            else:
                cmd.append("--single-stage")
            cmd.extend([
                "-H", str(height), "-W", str(width), "-f", str(frames),
                "--frame-rate", frame_rate_arg,
                "--seed", str(seed),
                "-o", str(out),
            ])
        elif operation == 'ic-lora':
            reference_video_path = config.COMFY_INPUT_DIR / '.ltx-reference' / f'{job_id}.mkv'
            _create_native_ltx_static_reference_video(reference_image, reference_video_path, reference_frames, frame_rate)
            cmd = [
                "uv", "run", "ltx-2-mlx", "ic-lora",
                "--model", str(model_path),
                "--gemma", config.LTX2_MLX_GEMMA,
                "--prompt", prompt,
            ]
            for item in native_loras:
                cmd.extend(["--lora", str(item['filePath']), str(item.get('scale', 1.0))])
            if options.get('dev_transformer'):
                cmd.extend(["--dev-transformer", str(options['dev_transformer'])])
            if options.get('guided_dev'):
                cmd.extend([
                    "--guided-dev",
                    "--stage1-steps", str(options.get('stage1_steps', 30)),
                    "--cfg-scale", str(options.get('cfg_scale', 4.0)),
                    "--stg-scale", str(options.get('stg_scale', 1.0)),
                ])
            if options.get('distilled_lora'):
                cmd.extend([
                    "--distilled-lora", str(options['distilled_lora']),
                    "--distilled-lora-strength", str(options.get('distilled_lora_strength', 0.5)),
                ])
            cmd.extend([
                "--video-conditioning", str(reference_video_path), str(options.get('reference_strength', 1.0)),
                "--conditioning-strength", str(options.get('conditioning_strength', 1.0)),
            ])
            for item in keyframes:
                cmd.extend([
                    "--image", str(item['path']), str(item['frame']), str(item['strength']), str(item['crf'])
                ])
            if options.get('single_stage', True):
                cmd.append("--single-stage")
            if options.get('low_ram', False):
                cmd.append("--low-ram")
            cmd.extend([
                "-H", str(height),
                "-W", str(width),
                "-f", str(frames),
                "--frame-rate", frame_rate_arg,
                "--seed", str(seed),
                "-o", str(out),
            ])
        else:
            # A distilled package has a distilled transformer and runs the no-CFG
            # --distilled two-stage. A dev package (locally converted v1.4, say)
            # has no distilled transformer, so --distilled would abort at load:
            # --two-stage is its equivalent — dev model + CFG at half res, upscale,
            # then distilled-LoRA refine. Slower, and it needs the q8 build.
            pipeline_flag = "--distilled" if spec.get('video_distilled') else "--two-stage"
            cmd = [
                "uv", "run", "ltx-2-mlx", "generate",
                pipeline_flag,
                "--model", str(model_path),
                "--gemma", config.LTX2_MLX_GEMMA,
                "--prompt", prompt,
            ]
            # Only the CFG two-stage path has a stage-1 step budget worth tuning;
            # --distilled reads its step count from the sigma table.
            stage1_steps = spec.get('video_stage1_steps')
            if stage1_steps and not spec.get('video_distilled'):
                cmd.extend(["--stage1-steps", str(int(stage1_steps))])
            # NAG carries the negative prompt on the distilled path, which runs
            # cfg=1 and would otherwise ignore it entirely. The dev two-stage
            # path has real CFG and consumes the negative prompt through that.
            negative_prompt = graphs._prompt_string(options.get('negative_prompt'))
            if negative_prompt and spec.get('video_distilled'):
                nag_scale = util.float_quality_option(options, 'nag_scale', config.LTX_NAG_DEFAULTS['scale'])
                if nag_scale > 1.0:
                    cmd.extend([
                        "--negative-prompt", negative_prompt,
                        "--nag-scale", str(nag_scale),
                        "--nag-alpha", str(util.float_quality_option(options, 'nag_alpha', config.LTX_NAG_DEFAULTS['alpha'])),
                        "--nag-tau", str(util.float_quality_option(options, 'nag_tau', config.LTX_NAG_DEFAULTS['tau'])),
                    ])
            for item in keyframes:
                cmd.extend([
                    "--image", str(item['path']), str(item['frame']), str(item['strength']), str(item['crf'])
                ])
            for item in native_loras:
                cmd.extend(["--lora", str(item['filePath']), str(item.get('scale', 1.0))])
            if cfg_scale:
                cmd.extend(["--cfg-scale", str(cfg_scale)])
            cmd.extend([
                "-H", str(height),
                "-W", str(width),
                "-f", str(frames),
                "--frame-rate", frame_rate_arg,
                "--seed", str(seed),
                "-o", str(out),
            ])
        env = os.environ.copy()
        env.setdefault("LTX2_DIT_EVAL_EVERY", "8")
        # Per-variant sampling recipe (sigma ramps, ancestral eta). setdefault keeps
        # an operator-exported value authoritative for one-off experiments.
        for key, value in (spec.get('runtime_env') or {}).items():
            env.setdefault(str(key), str(value))
        if spec.get('runtime_env'):
            rec['options']['sampling_recipe'] = dict(spec['runtime_env'])
        rec["progress_phase"] = "ltx-2-mlx"
        rec["progress"] = 5
        with jobs.jobs_lock:
            jobs.jobs[job_id] = rec
        t0 = time.monotonic()
        _media.mark_output_active(out)
        try:
            proc = _run_native_ltx_subprocess(
                job_id,
                rec,
                cmd,
                cwd=str(config.LTX2_MLX_DIR),
                env=env,
                timeout=util.int_option(options, 'runtime_timeout_seconds', 2400, 60, 14400),
            )
            elapsed = round(time.monotonic() - t0, 2)
            stdout = proc.stdout.strip()
            stderr = proc.stderr.strip()
            if proc.returncode != 0:
                raise RuntimeError(f"ltx-2-mlx exited {proc.returncode}\nSTDOUT:\n{stdout[-2000:]}\nSTDERR:\n{stderr[-2000:]}")
            # Cancelled between the render finishing and the post passes: stop
            # here rather than spending more GPU time on a clip nobody wants.
            if native_job_cancel_requested(job_id):
                raise NativeJobCancelled(f"job {job_id} was cancelled after the render")
            if not out.exists() or out.stat().st_size < 1000:
                raise RuntimeError("ltx-2-mlx finished without a valid output video")
            # A head-swap render is already the deliverable: the reserved strip is
            # part of the guide the model reads, never part of the frame it draws
            # (author's model card), so there is nothing to crop off. Verify the
            # size we asked for is the size we got, and say so loudly if not.
            if headswap_guide_info:
                got_w, got_h = _probe_video_dimensions(out)
                want_w = headswap_guide_info['width']
                want_h = headswap_guide_info['height']
                if (got_w, got_h) != (want_w, want_h):
                    print(
                        f"[ltx] head-swap {job_id} rendered {got_w}x{got_h}, expected {want_w}x{want_h}",
                        flush=True,
                    )
                rec['options']['head_swap'] = {**headswap_guide_info, 'output_width': got_w, 'output_height': got_h}
            # Both post-passes run while the output is still marked active, so the
            # E2E sweeper never seals the intermediate file out from under them.
            # Detailer first: it resamples the clip, so grain filtering afterwards
            # judges the texture that actually ships.
            detailer_detail = apply_ltx_detailer_pass(
                out, options,
                model_path=model_path, prompt=prompt,
                height=height, width=width, frames=frames,
                frame_rate=frame_rate_arg, seed=seed,
                job_id=job_id, rec=rec, env=env,
            )
            if detailer_detail:
                rec['options']['detailer'] = detailer_detail
                if not detailer_detail.get('applied'):
                    print(f"[ltx] detailer pass skipped for {job_id}: {detailer_detail.get('error')}", flush=True)
            denoise_detail = apply_ltx_denoise_pass(out, options.get('denoise'))
            if denoise_detail:
                rec['options']['denoise'] = denoise_detail
                if not denoise_detail.get('applied'):
                    print(f"[ltx] denoise pass skipped for {job_id}: {denoise_detail.get('error')}", flush=True)
            visible_out = jobs.mirror_output_to_comfy_output(out, job_id=job_id)
        finally:
            _media.mark_output_inactive(out)
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": [str(visible_out.resolve())],
            "elapsed_seconds": elapsed,
            "runner_stdout": util.json_safe_text(stdout),
            "runner_stderr": util.json_safe_text(stderr),
            "current_step": rec.get("total_steps", 2),
            "total_steps": rec.get("total_steps", 2),
            "progress": 100,
            "step_progress": 100,
            "progress_phase": "done",
        })
    except NativeJobCancelled:
        rec.update({"status": "cancelled", "finished_at": util.now_iso(), "error": "Cancelled by the owner", "progress_phase": "cancelled"})
    except Exception as e:
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(e), "progress_phase": "error"})
    finally:
        if reference_video_path:
            try:
                reference_video_path.unlink(missing_ok=True)
            except Exception:
                pass
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
