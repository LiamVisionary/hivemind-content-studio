"""The generation runners: what actually submits a graph to a lane, polls it,
and writes the record. One function per studio lane."""
import base64
import binascii
import json
import os
import re
import subprocess
import sys
import time
import tempfile
import uuid
import shutil
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from gateway import config, graphs as _graphs, history as _history, jobs, lanes, loras as _loras, media, models, net, promptroutes, util, workflow_index


def run_generation(job_id, prompt, loras=None, options=None):
    started = util.now_iso()
    with jobs.jobs_lock:
        jobs.jobs[job_id].update({"status": "running", "started_at": started})
    safe_options = {k: v for k, v in (options or {}).items() if k in {"width", "height", "steps", "cfg", "cfgScale", "guidance", "seed", "negative_prompt"}}
    rec = {"id": job_id, "prompt": _history.PRIVATE_PROMPT_LABEL, "status": "running", "created_at": started, "outputs": [], "loras": loras or [], "options": {k: v for k, v in safe_options.items() if k != "negative_prompt"}}
    try:
        if not config.RUNNER.exists():
            raise RuntimeError(f"Runner not found: {config.RUNNER}")
        seed_arg = str(safe_options.get("seed")) if safe_options.get("seed") not in (None, "", -1) else ""
        proc = subprocess.run(
            [str(config.RUNNER), prompt, json.dumps(loras or []), seed_arg, json.dumps(safe_options)],
            cwd=str(config.COMFY),
            text=True,
            capture_output=True,
            timeout=900,
        )
        stdout = proc.stdout.strip()
        stderr = proc.stderr.strip()
        if proc.returncode != 0:
            raise RuntimeError(f"runner exited {proc.returncode}\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}")

        result = None
        chunks, buf, depth = [], [], 0
        for ch in stdout:
            if ch == "{":
                depth += 1
            if depth:
                buf.append(ch)
            if ch == "}":
                depth -= 1
                if depth == 0 and buf:
                    chunks.append("".join(buf))
                    buf = []
        for c in chunks:
            try:
                result = json.loads(c)
            except Exception:
                pass
        outputs = result.get("outputs", []) if isinstance(result, dict) else []
        outputs = media.encrypt_outputs(
            (str(Path(p).resolve()) for p in outputs if Path(p).exists()), job_id=job_id)
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": outputs,
            "runner_stdout": stdout[-4000:],
            "runner_stderr": stderr[-4000:],
        })
    except Exception as e:
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(e)})
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


def run_comfy_klein3_edit(job_id, prompt, image_path, options=None):
    started = util.now_iso()
    options = options or {}
    steps = util.int_option(options, 'steps', 4, 1, 12)
    cfg = util.float_option(options, 'cfg', util.float_option(options, 'guidance', 1.0, 0.0, 20.0), 0.0, 20.0)
    seed = config.resolve_seed_option(options)
    denoise = util.float_option(options, 'denoise', 0.45, 0.0, 1.0)
    width = util.int_quality_option(options, 'width', 512)
    height = util.int_quality_option(options, 'height', 768)
    negative = str(options.get('negative_prompt') or 'noise, abstract texture, distorted face, bad anatomy, plastic skin, over-smoothed, blurry, low quality, duplicate face')
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "comfy-bigloves-klein3-edit",
        "created_at": started,
        "outputs": [],
        "options": {
            "steps": steps,
            "cfg": cfg,
            "seed": seed,
            "denoise": denoise,
            "width": width,
            "height": height,
            "lora_count": len(options.get('loras') or []),
        },
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    try:
        image_path = Path(image_path).resolve()
        allowed = [config.OUT_DIR.resolve(), config.COMFY_OUTPUT_DIR.resolve(), config.COMFY_INPUT_DIR.resolve()]
        if not any(str(image_path).startswith(str(root)) for root in allowed) or not image_path.exists():
            raise RuntimeError("input image is outside private image storage or does not exist")
        config.COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
        input_name = util.safe_name(image_path.name)
        comfy_input = (config.COMFY_INPUT_DIR / input_name).resolve()
        if comfy_input != image_path:
            comfy_input.write_bytes(image_path.read_bytes())
        # Node 4b resizes with crop:'disabled', which stretches anything the
        # canvas doesn't match — keep the requested pixel budget but adopt the
        # source image's aspect so the edit never distorts it.
        width, height = _graphs._reshape_dims_to_image_aspect(comfy_input, width, height, multiple=16)
        rec["options"].update({"width": width, "height": height})
        filename_prefix = f"biglove_klein3_comfy_edit_{job_id}"
        api_prompt = {
            '1': {'class_type':'UNETLoader','inputs':{'unet_name':'BigLoveKlein3_bf16.safetensors','weight_dtype':'default'}},
            '2': {'class_type':'CLIPLoader','inputs':{'clip_name':'qwen_3_8b_fp8mixed.safetensors','type':'flux2','device':'default'}},
            '3': {'class_type':'VAELoader','inputs':{'vae_name':'flux2-vae.safetensors'}},
            '4': {'class_type':'LoadImage','inputs':{'image':input_name}},
            '4b': {'class_type':'ImageScale','inputs':{'image':['4',0],'upscale_method':'lanczos','width':width,'height':height,'crop':'disabled'}},
            '5': {'class_type':'CLIPTextEncode','inputs':{'clip':['2',0],'text':prompt}},
            '6': {'class_type':'CLIPTextEncode','inputs':{'clip':['2',0],'text':negative}},
            '7': {'class_type':'VAEEncode','inputs':{'pixels':['4b',0], 'vae':['3',0]}},
            '8': {'class_type':'KSampler','inputs':{'model':['1',0],'positive':['5',0],'negative':['6',0],'latent_image':['7',0],'seed':seed,'steps':steps,'cfg':cfg,'sampler_name':'euler','scheduler':'beta','denoise':denoise}},
            '9': {'class_type':'VAEDecode','inputs':{'samples':['8',0], 'vae':['3',0]}},
            '10': {'class_type':'SaveImage','inputs':{'images':['9',0], 'filename_prefix':filename_prefix}},
        }
        model_ref = ['1', 0]
        lora_root = (config.COMFY / 'models' / 'loras').resolve()
        for index, item in enumerate(options.get('loras') or [], start=11):
            lora_path = Path(str(item.get('filePath') or '')).resolve()
            try:
                lora_name = str(lora_path.relative_to(lora_root))
            except ValueError as exc:
                raise RuntimeError("BigLove LoRA is outside the private Comfy model folder") from exc
            if not lora_path.is_file():
                raise RuntimeError(f"BigLove LoRA is missing: {lora_name}")
            node_id = str(index)
            api_prompt[node_id] = {
                'class_type': 'LoraLoaderModelOnly',
                'inputs': {
                    'model': model_ref,
                    'lora_name': lora_name,
                    'strength_model': float(item.get('scale', 1.0)),
                },
            }
            model_ref = [node_id, 0]
        api_prompt['8']['inputs']['model'] = model_ref
        body = json.dumps({'prompt': api_prompt, 'client_id': f'zimage-klein3-{job_id}'}).encode('utf-8')
        t0 = time.monotonic()
        req = Request(f"{config.COMFY_HTTP_DEFAULT}/prompt", data=body, headers={'Content-Type':'application/json'})
        queued = json.loads(net.urlopen(req, timeout=20).read().decode('utf-8'))
        prompt_id = queued.get('prompt_id')
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")
        rec['comfy_prompt_id'] = prompt_id
        with jobs.jobs_lock:
            jobs.jobs[job_id] = rec
        history = None
        for _ in range(300):
            time.sleep(2)
            try:
                payload = net.urlopen(f"{config.COMFY_HTTP_DEFAULT}/history/{prompt_id}", timeout=10).read().decode('utf-8')
                data = json.loads(payload or '{}')
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            except Exception:
                pass
        if history is None:
            raise RuntimeError(f"ComfyUI Klein3 edit timed out waiting for prompt {prompt_id}")
        status = history.get('status') or {}
        if status.get('status_str') != 'success' or not status.get('completed'):
            raise RuntimeError(f"ComfyUI Klein3 edit failed: {status}")
        outputs = []
        for node_out in (history.get('outputs') or {}).values():
            for img in node_out.get('images') or []:
                name = util.safe_name(img.get('filename') or '')
                subfolder = img.get('subfolder') or ''
                typ = img.get('type') or 'output'
                root = config.COMFY_OUTPUT_DIR if typ == 'output' else config.COMFY_INPUT_DIR
                p = (root / subfolder / name).resolve()
                # The privacy sweeper may seal the plaintext (.zenc or .e2e)
                # before this check runs — any sealed form counts as existing.
                if media.existing_output_path(p):
                    outputs.append(str(p))
        if not outputs:
            raise RuntimeError("ComfyUI Klein3 edit completed without output images")
        outputs = media.encrypt_outputs(outputs, job_id=job_id)
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": outputs,
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as e:
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(e)})
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


def run_comfy_api_image(job_id, prompt, options=None):
    """Generic runner for auto-detected API-format ComfyUI image workflows.

    The template graph keeps its own tuned defaults; only explicitly provided
    options (prompt, negative, seed, steps, cfg, dimensions) are patched in.
    Lane selection reuses the shared checkpoint-name router, so e.g. waiANIMA
    graphs land on the anima lane automatically.
    """
    started = util.now_iso()
    options = _graphs._normalize_couple_options(dict(options or {}))
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "comfy-api-image",
        "created_at": started,
        "outputs": [],
        "options": {k: v for k, v in options.items() if k not in ("negative_prompt", "workflow_file", "loras")},
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    try:
        workflow_path, graph = _graphs._load_auto_api_workflow(options.get("workflow_file"))
        rec["workflow"] = workflow_path.stem

        director_id = _graphs._h3_studio_director_id(graph)
        if director_id:
            # An H3 Studio graph: one Director owns prompt/canvas/seed/route
            # and the references, so none of the KSampler patching below
            # applies (its sampler is a SamplerCustomAdvanced with no
            # positive/negative inputs to follow).
            _graphs._apply_h3_studio_director(graph, director_id, prompt, options, rec)
        else:
            sampler = next(
                (node for node in graph.values() if str(node.get("class_type")) in _graphs._AUTO_SAMPLER_CLASSES),
                None,
            )
            if sampler is None:
                raise RuntimeError(f"{workflow_path.name} has no KSampler node to drive")
            sampler_inputs = sampler.setdefault("inputs", {})

            seed = config.resolve_seed_option(options)
            for seed_key in ("seed", "noise_seed"):
                if seed_key in sampler_inputs:
                    sampler_inputs[seed_key] = seed
                    rec["options"]["seed"] = seed
                    break
            if options.get("steps"):
                sampler_inputs["steps"] = util.int_option(options, "steps", int(sampler_inputs.get("steps") or 8), 1, 60)
            if options.get("cfg") is not None or options.get("guidance") is not None:
                default_cfg = float(sampler_inputs.get("cfg") or 1.0)
                sampler_inputs["cfg"] = util.float_option(options, "cfg", util.float_option(options, "guidance", default_cfg, 0.0, 20.0), 0.0, 20.0)

            # Positive prompt: follow the sampler's positive conditioning upstream.
            positive_ref = sampler_inputs.get("positive")
            pos_node_id, pos_key = _graphs._auto_find_text_node(graph, positive_ref[0]) if isinstance(positive_ref, list) and positive_ref else (None, None)
            if pos_node_id is None:
                raise RuntimeError(f"{workflow_path.name} has no reachable prompt text node")
            negative = str(options.get("negative_prompt") or "").strip()
            regional = "advanced_mapping" in (graph[pos_node_id].get("inputs") or {})
            couple_on = bool(options.get("couple_mode"))
            negative_handled = False
            if regional and couple_on:
                _graphs._auto_apply_couple_regions(graph[pos_node_id], pos_key, prompt, options)
                rec["couple_mode"] = True
                if _graphs._auto_split_regional_negative(graph, sampler_inputs, pos_node_id, negative):
                    negative_handled = True
            elif regional and str(prompt or "").strip():
                # Couple/regional graphs run single-subject by default: splice the
                # regional node out for full-canvas conditioning; regions only
                # when couple mode is explicitly enabled.
                if _graphs._auto_bypass_regional_prompt_node(graph, pos_node_id, prompt, negative):
                    rec["couple_bypassed"] = True
                    negative_handled = True
                else:
                    graph[pos_node_id]["inputs"][pos_key] = _graphs._auto_fit_regional_prompt(graph[pos_node_id], prompt)
                    if _graphs._auto_split_regional_negative(graph, sampler_inputs, pos_node_id, negative):
                        negative_handled = True
            elif str(prompt or "").strip():
                graph[pos_node_id]["inputs"][pos_key] = str(prompt)

            # Negative prompt: only when it resolves to a DIFFERENT node (regional
            # prompt nodes expose positive+negative from one node — leave those).
            negative_ref = sampler_inputs.get("negative")
            if not negative_handled and negative and isinstance(negative_ref, list) and negative_ref:
                neg_node_id, neg_key = _graphs._auto_find_text_node(graph, negative_ref[0])
                if neg_node_id is not None and neg_node_id != pos_node_id:
                    graph[neg_node_id]["inputs"][neg_key] = negative

            # User LoRAs: validated against the local catalog, chained above the
            # model loader. Only the count is recorded — names stay client-side.
            requested_loras = options.get("loras") or []
            if requested_loras:
                resolved = models.resolve_lora_selection(requested_loras)
                applied = _graphs._auto_apply_model_loras(graph, sampler_inputs, resolved)
                if applied:
                    rec["loras_applied"] = applied

            # Dimensions: patch every node that carries a width+height pair so
            # latent size and regional-prompt canvases stay consistent.
            width = int(options.get("width") or 0)
            height = int(options.get("height") or 0)
            if width > 0 and height > 0:
                for node in graph.values():
                    inputs = node.get("inputs") or {}
                    if isinstance(inputs.get("width"), (int, float)) and isinstance(inputs.get("height"), (int, float)):
                        inputs["width"] = width
                        inputs["height"] = height
                rec["options"]["width"] = width
                rec["options"]["height"] = height

        body = json.dumps({"prompt": graph})
        lane_name = lanes.comfy_lane_for_prompt_body(body, run_on=options.get('run_on'))
        lane_url = lanes.COMFY_LANES.get(lane_name, config.COMFY_HTTP_DEFAULT)
        rec["lane"] = lane_url
        # A rented lane's outputs never touch this disk, so the local
        # history/collect path below cannot see them. Remote runs go through
        # the same push -> route -> sealed-harvest flow as the /comfy proxy.
        remote = lanes.comfy_lane_is_remote(lane_name)
        pushed_inputs = []
        if remote:
            transport_error = lanes.comfy_lane_transport_error(lane_name) or lanes.comfy_lane_liveness_error(lane_name)
            if transport_error:
                raise RuntimeError(transport_error)
            if not media.vault_public_key_spki():
                raise RuntimeError(
                    f"lane '{lane_name}' is remote and its outputs must be sealed: create the owner vault first"
                )
            pushed_inputs = promptroutes.push_prompt_inputs_to_lane(body, lane_name)
        t0 = time.monotonic()
        client_id = f"zimage-auto-{job_id}"
        try:
            queued = _graphs._auto_submit_prompt(lane_url, graph, client_id)
        except HTTPError as exc:
            error_payload = exc.read().decode("utf-8", errors="replace")
            if exc.code != 400 or not _graphs._auto_fill_missing_required_inputs(graph, error_payload, lane_url):
                raise RuntimeError(f"ComfyUI rejected the workflow: {error_payload[:500]}") from exc
            rec["healed_inputs"] = True
            queued = _graphs._auto_submit_prompt(lane_url, graph, client_id)
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")
        rec["comfy_prompt_id"] = prompt_id
        with jobs.jobs_lock:
            jobs.jobs[job_id] = rec
        if remote:
            promptroutes.record_comfy_prompt_route(
                prompt_id, lane_name, pushed_inputs=pushed_inputs, client_id=client_id,
            )
            # Watched inline rather than on a daemon thread: this IS the job's
            # worker, and the watcher already owns harvest, scrub and the
            # failure record.
            route = promptroutes.watch_remote_comfy_prompt(prompt_id) or {}
            if route.get("status") != "harvested":
                raise RuntimeError(route.get("error") or "remote generation did not complete")
            logical_names = [str(name) for name in route.get("outputs") or []]
            outputs = [str(path) for path in map(media.find_output_logical_path, logical_names) if path]
            if not outputs:
                raise RuntimeError("remote workflow completed without output images")
        else:
            history = None
            for _ in range(300):
                time.sleep(2)
                try:
                    payload = net.urlopen(f"{lane_url}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                    data = json.loads(payload or "{}")
                    if prompt_id in data:
                        history = data[prompt_id]
                        break
                except Exception:
                    pass
            if history is None:
                raise RuntimeError(f"auto workflow timed out waiting for prompt {prompt_id}")
            status = history.get("status") or {}
            if status.get("status_str") != "success" or not status.get("completed"):
                raise RuntimeError(f"auto workflow failed: {status}")
            outputs = []
            for node_out in (history.get("outputs") or {}).values():
                for img in node_out.get("images") or []:
                    name = util.safe_name(img.get("filename") or "")
                    subfolder = img.get("subfolder") or ""
                    typ = img.get("type") or "output"
                    root = config.COMFY_OUTPUT_DIR if typ == "output" else config.COMFY_INPUT_DIR
                    p = (root / subfolder / name).resolve()
                    # The privacy sweeper may seal the plaintext (.zenc or .e2e)
                    # before this check runs — any sealed form counts as existing.
                    if media.existing_output_path(p):
                        outputs.append(str(p))
            if not outputs:
                raise RuntimeError("auto workflow completed without output images")
            logical_names = [Path(p).name for p in outputs]
        # Record the vault-sealed setup so "Load in Studio" can recover the exact
        # prompt/seed/model for a studio output (which carries no mobile envelope).
        try:
            workflow_index.record_studio_workflow_setup(logical_names, graph, rec.get("comfy_prompt_id"), rec.get("workflow"))
        except Exception as exc:
            print(f"[workflow-index] studio record skipped: {exc}", file=sys.stderr)
        # A harvested remote output is already a sealed envelope; sealing it
        # again would wrap the envelope, not the image.
        if not remote:
            outputs = media.encrypt_outputs(outputs, job_id=job_id)
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": outputs,
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as e:
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(e)})
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


def _krea2_sampler_choice(options):
    """Resolve (sampler, scheduler) exactly like the graph compiler does.

    Kept in sync so the job record shows the pair that actually ran — the
    low-step default swap is otherwise invisible from the history.
    """
    options = options or {}
    steps = util.int_option(options, "steps", 10, 1, 50)
    sampler, scheduler = config.krea2_sampler_defaults(steps)
    requested_sampler = str(options.get("sampler_name") or "").strip()
    requested_scheduler = str(options.get("scheduler") or "").strip()
    if requested_sampler in config.KREA2_SAMPLERS:
        sampler = requested_sampler
    if requested_scheduler in config.KREA2_SCHEDULERS:
        scheduler = requested_scheduler
    return sampler, scheduler


def run_comfy_krea2_identity(job_id, prompt, image_path=None, options=None):
    started = util.now_iso()
    options = options or {}
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "comfy-krea2-turbo-identity-edit",
        "created_at": started,
        "outputs": [],
        "mode": "identity-edit" if image_path else "text-to-image",
        "options": {
            "width": util.int_option(options, "width", 1024, 64, 4096),
            "height": util.int_option(options, "height", 1024, 64, 4096),
            "steps": util.int_option(options, "steps", 10, 1, 50),
            "cfg": util.float_option(options, "cfg", util.float_option(options, "guidance", 1.0, 0.0, 20.0), 0.0, 20.0),
            "seed": config.resolve_seed_option(options),
            "sampler_name": _krea2_sampler_choice(options)[0],
            "scheduler": _krea2_sampler_choice(options)[1],
            "ref_boost": util.float_option(options, "ref_boost", 4.0, 0.0, 1000.0),
            "identity_strength": util.float_option(options, "identity_strength", 1.0, -10.0, 10.0),
            "grounding_px": util.int_option(options, "grounding_px", 768, 0, 4096),
            "cache_static_tokens": util.bool_option(options, "cache_static_tokens", True),
            "loras": [
                {
                    "id": str(item.get("id") or ""),
                    "strength": util.float_option(item, "strength", 1.0, _loras.LORA_STRENGTH_MIN, _loras.LORA_STRENGTH_MAX),
                }
                for item in (options.get("loras") or [])
                if isinstance(item, dict) and str(item.get("id") or "").strip()
            ],
        },
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    try:
        input_name = None
        if image_path:
            image_path = Path(image_path).expanduser().resolve()
            allowed = [config.OUT_DIR.resolve(), config.COMFY_OUTPUT_DIR.resolve(), config.COMFY_INPUT_DIR.resolve()]
            if not any(str(image_path).startswith(str(root)) for root in allowed) or not image_path.exists():
                raise RuntimeError("input image is outside private image storage or does not exist")
            config.COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
            input_name = util.safe_name(image_path.name)
            comfy_input = (config.COMFY_INPUT_DIR / input_name).resolve()
            if comfy_input != image_path:
                comfy_input.write_bytes(image_path.read_bytes())

        filename_prefix = f"krea2_identity_{job_id}"
        api_prompt = _graphs.build_krea2_turbo_identity_prompt(
            prompt,
            image_name=input_name,
            options=rec["options"],
            filename_prefix=filename_prefix,
        )
        body = json.dumps({"prompt": api_prompt, "client_id": f"media-krea2-{job_id}"}).encode("utf-8")
        t0 = time.monotonic()
        req = Request(f"{config.COMFY_HTTP_DEFAULT}/prompt", data=body, headers={"Content-Type": "application/json"})
        try:
            queued = json.loads(net.urlopen(req, timeout=30).read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI rejected Krea2 identity graph: {detail[:4000]}") from exc
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")
        rec["comfy_prompt_id"] = prompt_id
        with jobs.jobs_lock:
            jobs.jobs[job_id] = rec

        history = None
        for _ in range(450):
            time.sleep(2)
            try:
                payload = net.urlopen(f"{config.COMFY_HTTP_DEFAULT}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                data = json.loads(payload or "{}")
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            except Exception:
                pass
        if history is None:
            raise RuntimeError(f"ComfyUI Krea2 identity generation timed out waiting for prompt {prompt_id}")
        status = history.get("status") or {}
        if status.get("status_str") != "success" or not status.get("completed"):
            raise RuntimeError(f"ComfyUI Krea2 identity generation failed: {status}")

        outputs = []
        for node_out in (history.get("outputs") or {}).values():
            for image in node_out.get("images") or []:
                name = util.safe_name(image.get("filename") or "")
                subfolder = image.get("subfolder") or ""
                typ = image.get("type") or "output"
                root = config.COMFY_OUTPUT_DIR if typ == "output" else config.COMFY_INPUT_DIR
                path = (root / subfolder / name).resolve()
                # The privacy sweeper may seal the plaintext (.zenc or .e2e)
                # before this check runs — any sealed form counts as existing.
                if media.existing_output_path(path):
                    outputs.append(str(path))
        if not outputs:
            raise RuntimeError("ComfyUI Krea2 identity generation completed without output images")
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": media.encrypt_outputs(outputs, job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as exc:
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(exc)})
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


def _compose_labeled_sheet(sheet_path, rows, cols, square, tiles, header_lines, tag="sheet"):
    """Compose a labeled tile sheet from staged plaintext tiles via the venv
    python (PIL lives there, like media_seal.py). Returns the sheet path or
    None — a missing sheet degrades the job, it does not fail it."""
    if not tiles:
        return None
    sheet_path = Path(sheet_path)
    manifest = {
        "output": str(sheet_path),
        "rows": rows,
        "cols": cols,
        "square": square,
        "header_lines": header_lines,
        "tiles": tiles,
    }
    composer = Path(__file__).resolve().parent / "bin" / "compose-strength-hunt-sheet.py"
    try:
        proc = subprocess.run(
            [media.SUBPROCESS_PYTHON, str(composer)],
            input=json.dumps(manifest),
            text=True,
            capture_output=True,
            timeout=300,
        )
        if proc.returncode == 0 and sheet_path.exists():
            return sheet_path
        print(f"[{tag}] sheet composer failed: {proc.stderr[-1000:]}", file=sys.stderr)
    except Exception as exc:
        print(f"[{tag}] sheet composer error: {exc}", file=sys.stderr)
    return None


def _strength_hunt_compose_sheet(job_id, plan, tiles, header_lines):
    return _compose_labeled_sheet(
        config.COMFY_OUTPUT_DIR / f"strhunt_{job_id}_sheet.png",
        plan["rows"],
        plan["cols"],
        plan["rows"] == 1 and len(tiles) > 4,
        tiles,
        header_lines,
        tag="strength-hunt",
    )


def run_comfy_krea2_strength_hunt(job_id, prompt, image_path=None, options=None, hunt=None):
    """Sweep 1-2 LoRA strengths over a FIXED prompt+seed (Mix-Studio's Strength
    Hunt, translated). Portable/CUDA profiles pack every variant into ONE merged
    ComfyUI prompt (shared loaders run once); apple-silicon submits variants
    sequentially because its LoRA stack is baked into the quantized loader
    (MultiLoRAStackToPreLora) — a merged graph would load N model instances.
    Outputs: labeled comparison sheet first, then every variant, all sealed."""
    started = util.now_iso()
    options = options or {}
    hunt = hunt or {}
    normalized = {
        "width": util.int_option(options, "width", 1024, 64, 4096),
        "height": util.int_option(options, "height", 1024, 64, 4096),
        "steps": util.int_option(options, "steps", 10, 1, 50),
        "cfg": util.float_option(options, "cfg", util.float_option(options, "guidance", 1.0, 0.0, 20.0), 0.0, 20.0),
        # One resolve up front: every variant must share the exact same seed.
        "seed": config.resolve_seed_option(options),
        "sampler_name": _krea2_sampler_choice(options)[0],
        "scheduler": _krea2_sampler_choice(options)[1],
        "ref_boost": util.float_option(options, "ref_boost", 4.0, 0.0, 1000.0),
        "identity_strength": util.float_option(options, "identity_strength", 1.0, -10.0, 10.0),
        "grounding_px": util.int_option(options, "grounding_px", 768, 0, 4096),
        "cache_static_tokens": util.bool_option(options, "cache_static_tokens", True),
        "loras": [
            {
                "id": str(item.get("id") or ""),
                "strength": util.float_option(item, "strength", 1.0, _loras.LORA_STRENGTH_MIN, _loras.LORA_STRENGTH_MAX),
            }
            for item in (options.get("loras") or [])
            if isinstance(item, dict) and str(item.get("id") or "").strip()
        ],
    }
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "comfy-krea2-strength-hunt",
        "created_at": started,
        "outputs": [],
        "mode": "identity-edit" if image_path else "text-to-image",
        "options": normalized,
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    staging_dir = None
    try:
        plan = config.build_strength_hunt_plan(normalized["loras"], hunt.get("lora_ids") or [])
        profile = config.accelerator_profile()
        if profile == "apple-silicon" and len(plan["variants"]) > 36:
            raise RuntimeError(
                f"{len(plan['variants'])} variants would each requantize the Krea2 loader on apple-silicon; "
                "lower the swept strengths to 36 variants or run on a CUDA lane"
            )
        rec["strength_hunt"] = {
            "axes": [{"id": axis["id"], "values": axis["values"]} for axis in plan["axes"]],
            "rows": plan["rows"],
            "cols": plan["cols"],
            "variants": len(plan["variants"]),
            "merged": profile != "apple-silicon",
        }
        with jobs.jobs_lock:
            jobs.jobs[job_id] = rec

        input_name = None
        if image_path:
            image_path = Path(image_path).expanduser().resolve()
            allowed = [config.OUT_DIR.resolve(), config.COMFY_OUTPUT_DIR.resolve(), config.COMFY_INPUT_DIR.resolve()]
            if not any(str(image_path).startswith(str(root)) for root in allowed) or not image_path.exists():
                raise RuntimeError("input image is outside private image storage or does not exist")
            config.COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
            input_name = util.safe_name(image_path.name)
            comfy_input = (config.COMFY_INPUT_DIR / input_name).resolve()
            if comfy_input != image_path:
                comfy_input.write_bytes(image_path.read_bytes())

        t0 = time.monotonic()
        graphs = []
        for variant in plan["variants"]:
            variant_options = dict(normalized, loras=variant["loras"])
            graphs.append(_graphs.build_krea2_turbo_identity_prompt(
                prompt,
                image_name=input_name,
                options=variant_options,
                # The filename index is the ordering contract: completion maps
                # arrival order back to grid position through this marker.
                filename_prefix=f"strhunt_{job_id}_strength_hunt_{variant['index']:03d}",
            ))

        def submit_and_wait(api_prompt, label, poll_loops):
            body = json.dumps({"prompt": api_prompt, "client_id": f"media-strhunt-{job_id}"}).encode("utf-8")
            req = Request(f"{config.COMFY_HTTP_DEFAULT}/prompt", data=body, headers={"Content-Type": "application/json"})
            try:
                queued = json.loads(net.urlopen(req, timeout=30).read().decode("utf-8"))
            except HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"ComfyUI rejected strength hunt graph ({label}): {detail[:4000]}") from exc
            prompt_id = queued.get("prompt_id")
            if not prompt_id:
                raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")
            for _ in range(poll_loops):
                time.sleep(2)
                try:
                    payload = net.urlopen(f"{config.COMFY_HTTP_DEFAULT}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                    data = json.loads(payload or "{}")
                    if prompt_id in data:
                        history = data[prompt_id]
                        status = history.get("status") or {}
                        if status.get("status_str") != "success" or not status.get("completed"):
                            raise RuntimeError(f"strength hunt {label} failed: {status}")
                        return history
                except RuntimeError:
                    raise
                except Exception:
                    pass
            raise RuntimeError(f"strength hunt {label} timed out waiting for prompt {prompt_id}")

        histories = []
        if profile == "apple-silicon":
            for i, graph in enumerate(graphs):
                histories.append(submit_and_wait(graph, f"variant {i + 1}/{len(graphs)}", 450))
                rec["strength_hunt"]["completed"] = i + 1
                with jobs.jobs_lock:
                    jobs.jobs[job_id] = rec
        else:
            merged = config.merge_strength_hunt_graphs(graphs)
            histories.append(submit_and_wait(merged, f"merged x{len(graphs)}", 450 + 60 * len(graphs)))

        # Collect ordered outputs; capture plaintext bytes NOW — the privacy
        # sweeper may seal (or the E2E sweeper envelope) them at any moment,
        # and .e2e envelopes are unreadable server-side by design.
        indexed = {}
        for history in histories:
            for node_out in (history.get("outputs") or {}).values():
                for image in node_out.get("images") or []:
                    name = util.safe_name(image.get("filename") or "")
                    index = config.strength_hunt_output_index(name)
                    if index is None:
                        continue
                    subfolder = image.get("subfolder") or ""
                    typ = image.get("type") or "output"
                    root = config.COMFY_OUTPUT_DIR if typ == "output" else config.COMFY_INPUT_DIR
                    path = (root / subfolder / name).resolve()
                    if media.existing_output_path(path):
                        indexed[index] = path
        if not indexed:
            raise RuntimeError("strength hunt completed without any variant outputs")

        staging_dir = Path(tempfile.mkdtemp(prefix=f"strhunt-{job_id}-"))
        tiles = []
        axis_label = {axis["id"]: Path(axis["id"]).stem for axis in plan["axes"]}
        for variant in plan["variants"]:
            path = indexed.get(variant["index"])
            if path is None:
                continue
            label = " · ".join(
                f"{axis_label[axis_id]} {value}" for axis_id, value in variant["coords"].items()
            )
            try:
                data, _mime = media.decrypt_output_bytes(media.logical_path_for_encrypted(path))
            except Exception:
                continue  # sealed to .e2e before we got here — skip its tile
            staged = staging_dir / f"tile_{variant['index']:03d}.png"
            staged.write_bytes(data)
            tiles.append({"path": str(staged), "label": label, "index": variant["index"]})

        axis_text = " x ".join(
            f"{axis_label[axis['id']]} (MAX {axis['values'][-1]})" for axis in plan["axes"]
        )
        header_lines = [
            f"STRENGTH HUNT · SEED {normalized['seed']} · CFG {normalized['cfg']} · STEPS {normalized['steps']}",
            f"AXIS {axis_text} · {len(plan['variants'])} variants",
            (prompt or "")[:200],
        ]
        sheet_path = _strength_hunt_compose_sheet(job_id, plan, tiles, header_lines)

        ordered_outputs = [str(indexed[index]) for index in sorted(indexed)]
        final_outputs = ([str(sheet_path)] if sheet_path else []) + ordered_outputs
        rec["strength_hunt"]["sheet"] = bool(sheet_path)
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": media.encrypt_outputs(final_outputs, job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as exc:
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(exc)})
    finally:
        if staging_dir is not None:
            shutil.rmtree(staging_dir, ignore_errors=True)
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


def run_comfy_krea2_outpaint(job_id, prompt, image_path, options=None, outpaint=None):
    """User-facing canvas expansion (Mix-Studio port): the source keeps its
    pixels, centered on a larger canvas whose missing border is sampled by the
    shared pixel-preserving Krea2 outpaint graph (the same one the LTX anchor
    pipeline trusts), then the source is composited back over the result."""
    started = util.now_iso()
    options = options or {}
    outpaint = outpaint or {}
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "comfy-krea2-outpaint",
        "created_at": started,
        "outputs": [],
        "mode": "outpaint",
        "options": {
            "width": util.int_option(outpaint, "width", 0, 64, 4096),
            "height": util.int_option(outpaint, "height", 0, 64, 4096),
            "steps": util.int_option(options, "steps", 10, 1, 50),
            "seed": config.resolve_seed_option(options),
            "feathering": util.int_option(outpaint, "feathering", 48, 0, 256),
            # Placement of the source on the grown canvas: 0=start, 0.5=center,
            # 1=end per axis (Mix-Studio outpaint-plan port).
            "offset_x": util.float_option(outpaint, "offset_x", 0.5, 0.0, 1.0),
            "offset_y": util.float_option(outpaint, "offset_y", 0.5, 0.0, 1.0),
        },
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    try:
        if not image_path:
            raise RuntimeError("outpaint requires a source image")
        image_path = Path(image_path).expanduser().resolve()
        allowed = [config.OUT_DIR.resolve(), config.COMFY_OUTPUT_DIR.resolve(), config.COMFY_INPUT_DIR.resolve()]
        if not any(str(image_path).startswith(str(root)) for root in allowed) or not image_path.exists():
            raise RuntimeError("input image is outside private image storage or does not exist")
        dimensions = _graphs._image_dimensions(image_path)
        if not dimensions:
            raise RuntimeError("could not read the source image dimensions")
        source_width, source_height = dimensions
        config.COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
        input_name = util.safe_name(image_path.name)
        comfy_input = (config.COMFY_INPUT_DIR / input_name).resolve()
        if comfy_input != image_path:
            comfy_input.write_bytes(image_path.read_bytes())

        t0 = time.monotonic()
        compiled = config.build_krea2_turbo_outpaint_prompt(
            prompt or "",
            input_name,
            source_width=source_width,
            source_height=source_height,
            options={
                "width": rec["options"]["width"],
                "height": rec["options"]["height"],
                "seed": rec["options"]["seed"],
                "steps": rec["options"]["steps"],
                "cfg": 1.0,
                "ref_boost": 4.0,
                "identity_strength": 1.0,
                "grounding_px": 768,
                "feathering": rec["options"]["feathering"],
                "offset_x": rec["options"]["offset_x"],
                "offset_y": rec["options"]["offset_y"],
            },
            profile=config.accelerator_profile(),
            filename_prefix=f"krea2_outpaint_{job_id}",
            identity_checkpoint_available=(
                config.COMFY / "models" / "diffusion_models" / config.KREA2_IDENTITY_CONVROT_MODEL
            ).is_file(),
        )
        geometry = compiled["geometry"]
        rec["geometry"] = geometry
        if geometry["mode"] != "outpaint":
            raise RuntimeError(
                "that target does not grow the canvas — it only resizes; use Upscale for more pixels "
                f"(source {source_width}x{source_height}, target {geometry['target_width']}x{geometry['target_height']})"
            )

        body = json.dumps({"prompt": compiled["graph"], "client_id": f"media-outpaint-{job_id}"}).encode("utf-8")
        req = Request(f"{config.COMFY_HTTP_DEFAULT}/prompt", data=body, headers={"Content-Type": "application/json"})
        try:
            queued = json.loads(net.urlopen(req, timeout=30).read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI rejected the outpaint graph: {detail[:4000]}") from exc
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")
        rec["comfy_prompt_id"] = prompt_id
        with jobs.jobs_lock:
            jobs.jobs[job_id] = rec

        history = None
        for _ in range(450):
            time.sleep(2)
            try:
                payload = net.urlopen(f"{config.COMFY_HTTP_DEFAULT}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                data = json.loads(payload or "{}")
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            except Exception:
                pass
        if history is None:
            raise RuntimeError(f"outpaint timed out waiting for prompt {prompt_id}")
        status = history.get("status") or {}
        if status.get("status_str") != "success" or not status.get("completed"):
            raise RuntimeError(f"outpaint failed: {status}")

        outputs = []
        for node_out in (history.get("outputs") or {}).values():
            for image in node_out.get("images") or []:
                name = util.safe_name(image.get("filename") or "")
                subfolder = image.get("subfolder") or ""
                typ = image.get("type") or "output"
                root = config.COMFY_OUTPUT_DIR if typ == "output" else config.COMFY_INPUT_DIR
                path = (root / subfolder / name).resolve()
                if media.existing_output_path(path):
                    outputs.append(str(path))
        if not outputs:
            raise RuntimeError("outpaint completed without an output image")
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": media.encrypt_outputs(outputs, job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as exc:
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(exc)})
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


COMFY_TEMP_DIR = Path(
    os.environ.get("COMFY_TEMP_DIR", str(Path.home() / ".comfy-private.noindex/temp"))
)


def resolve_comfy_temp_file(filename, subfolder=""):
    """Where ComfyUI actually put a temp output.

    ComfyUI appends its own "temp" segment to the directory it is given, so a
    file the history reports as `x.png` lives at `<COMFY_TEMP_DIR>/temp/x.png`
    on this stack — while a plain ComfyUI puts it directly in the root. Both
    layouts are checked rather than assumed; getting this wrong reads as "the
    graph produced nothing" even though it ran perfectly."""
    name = util.safe_name(str(filename or ""))
    if not name:
        return None
    sub = str(subfolder or "").strip().strip("/")
    root = COMFY_TEMP_DIR.expanduser().resolve()
    for base in (root / "temp", root):
        candidate = (base / sub / name) if sub else (base / name)
        try:
            candidate = candidate.resolve()
        except OSError:
            continue
        if util._is_under(candidate, root) and candidate.is_file():
            return candidate
    return None


def run_sam3_smart_mask(job_id, image_path, options=None):
    """Segment an object out of an image and hand the mask straight back.

    This is the selection step of the masked edit: instead of painting the
    region, name it ("the jacket") or tap it, and SAM3 returns the exact
    silhouette for the existing inpaint path to use.

    The mask never becomes an output. It leaves the graph through PreviewImage
    into ComfyUI's temp directory, is read once, returned INLINE as a data URL,
    and deleted — so smart-select leaves nothing sealed in History and nothing
    plaintext on disk. The source image arrives already-decrypted from the
    browser, so this never needs the vault key."""
    started = util.now_iso()
    options = options or {}
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "sam3-smart-mask",
        "created_at": started,
        "outputs": [],
        "mode": "text" if str(options.get("prompt") or "").strip() else "points",
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    temp_files = []
    try:
        source = Path(image_path).expanduser().resolve()
        if not source.is_file():
            raise RuntimeError("smart-select source image is missing")
        config.COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
        name = util.safe_name(source.name)
        staged = (config.COMFY_INPUT_DIR / name).resolve()
        if staged != source:
            staged.write_bytes(source.read_bytes())

        t0 = time.monotonic()
        api_prompt = config.build_sam3_mask_prompt(
            name,
            prompt=options.get("prompt") or "",
            points=options.get("points"),
            confidence=util.float_option(options, "confidence", 0.2, 0.05, 0.95),
        )
        body = json.dumps({"prompt": api_prompt, "client_id": f"media-smartmask-{job_id}"}).encode("utf-8")
        req = Request(f"{config.COMFY_HTTP_DEFAULT}/prompt", data=body, headers={"Content-Type": "application/json"})
        try:
            queued = json.loads(net.urlopen(req, timeout=30).read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI rejected the smart-select graph: {detail[:2000]}") from exc
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")

        history = None
        # First run loads a 3.45GB checkpoint; warm runs are ~20s.
        for _ in range(300):
            time.sleep(2)
            try:
                payload = net.urlopen(f"{config.COMFY_HTTP_DEFAULT}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                data = json.loads(payload or "{}")
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            except Exception:
                pass
        if history is None:
            raise RuntimeError(f"smart-select timed out waiting for prompt {prompt_id}")
        status = history.get("status") or {}
        if status.get("status_str") != "success":
            raise RuntimeError(f"smart-select failed: {status}")

        mask_bytes = None
        for node_out in (history.get("outputs") or {}).values():
            for image in node_out.get("images") or []:
                filename = str(image.get("filename") or "")
                if not filename:
                    continue
                candidate = resolve_comfy_temp_file(filename, image.get("subfolder"))
                if candidate is None:
                    continue
                temp_files.append(candidate)
                if mask_bytes is None:
                    mask_bytes = candidate.read_bytes()
        if not mask_bytes:
            raise RuntimeError("smart-select produced no mask — try naming the object differently")

        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
            # Inline: the browser composites this into the mask canvas straight
            # away, and nothing about the selection is written down anywhere.
            "mask_base64": "data:image/png;base64," + base64.b64encode(mask_bytes).decode("ascii"),
        })
    except Exception as exc:
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(exc)})
    finally:
        for path in temp_files:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
    # The mask rides back in memory only. Writing it to history.jsonl would put
    # a plaintext selection on disk forever — the one thing the temp-file dance
    # above exists to avoid — and bloat the log with megabytes of base64.
    _history.append_history({key: value for key, value in rec.items() if key != "mask_base64"})
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


def run_ltx_director(job_id, project, options=None):
    """Render one window of an LTX Director timeline (Mix-Studio port).

    The timeline is validated before anything is queued — a bad segment reaches
    ComfyUI as an opaque node error, so `normalize_director_project` refusing it
    here with a sentence is the whole point of the data model. Referenced media
    and the required weights are both checked up front for the same reason.

    Unlike the studio's other video lanes this graph is built in code rather
    than patched from a workflow JSON, because the node takes a bundle of
    scalars that only make sense derived together (see ltx_director_graph)."""
    started = util.now_iso()
    options = dict(options or {})
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "ltx-director",
        "created_at": started,
        "outputs": [],
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    try:
        t0 = time.monotonic()
        options.setdefault("filename_prefix", f"ltx_director_{job_id}")
        options.setdefault("seed", config.resolve_seed_option(options))
        graph, meta = config.build_ltx_director_prompt(project, options)

        missing_media = config.director_missing_assets(meta["project"], str(config.COMFY_INPUT_DIR))
        if missing_media:
            raise RuntimeError(
                "these timeline files are not in the input directory: "
                + ", ".join(missing_media[:8])
            )
        missing_weights = config.missing_ltx_director_assets(models.comfy_model_catalog())
        if missing_weights:
            raise RuntimeError(
                "LTX Director is missing model files: " + ", ".join(missing_weights)
            )
        # Frames/duration are recorded before the run so a timeout still says
        # what was attempted.
        rec["options"] = {
            "frames": meta["frames"],
            "width": meta["width"],
            "height": meta["height"],
            "seconds": meta["seconds"],
            "seed": options["seed"],
        }

        body = json.dumps({"prompt": graph, "client_id": f"media-ltxdirector-{job_id}"}).encode("utf-8")
        req = Request(f"{config.COMFY_HTTP_DEFAULT}/prompt", data=body, headers={"Content-Type": "application/json"})
        try:
            queued = json.loads(net.urlopen(req, timeout=60).read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI rejected the Director graph: {detail[:2000]}") from exc
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")

        history = None
        # A cold run loads a 27GB checkpoint plus a 13GB text encoder, so the
        # first render is minutes of loading before a single step.
        for _ in range(1800):
            time.sleep(2)
            try:
                payload = net.urlopen(f"{config.COMFY_HTTP_DEFAULT}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                data = json.loads(payload or "{}")
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            except Exception:
                pass
        if history is None:
            raise RuntimeError(f"LTX Director timed out waiting for prompt {prompt_id}")
        status = history.get("status") or {}
        if status.get("status_str") != "success":
            raise RuntimeError(f"LTX Director failed: {status}")

        outputs = []
        for node_out in (history.get("outputs") or {}).values():
            # SaveVideo reports under "images" on some builds and "videos" on
            # others; take whichever the node actually produced.
            for item in (node_out.get("videos") or []) + (node_out.get("images") or []):
                name = util.safe_name(item.get("filename") or "")
                if not name:
                    continue
                subfolder = item.get("subfolder") or ""
                root = config.COMFY_OUTPUT_DIR if (item.get("type") or "output") == "output" else config.COMFY_INPUT_DIR
                path = (root / subfolder / name).resolve()
                if media.existing_output_path(path):
                    outputs.append(str(path))
        if not outputs:
            raise RuntimeError("LTX Director completed without producing a video")

        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": media.encrypt_outputs(outputs, job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as exc:
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(exc)})
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


def run_comfy_krea2_inpaint(job_id, prompt, image_path, mask_path, options=None):
    """Masked edit (Mix-Studio soft-inpaint port): the white-on-black mask PNG
    selects what changes. Flow-model-safe wiring — VAEEncode + SetLatentNoiseMask,
    never VAEEncodeForInpaint — and the untouched source is composited back
    outside the grown mask. Core ComfyUI nodes only."""
    started = util.now_iso()
    options = options or {}
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "comfy-krea2-inpaint",
        "created_at": started,
        "outputs": [],
        "mode": "inpaint",
        "options": {
            "steps": util.int_option(options, "steps", 10, 1, 50),
            "seed": config.resolve_seed_option(options),
            "mask_expand": util.int_option(options, "mask_expand", 14, 6, 32),
            "mask_influence": util.int_option(options, "mask_influence", 78, 25, 100),
            "loras": [
                {
                    "id": str(item.get("id") or ""),
                    "strength": util.float_option(item, "strength", 1.0, _loras.LORA_STRENGTH_MIN, _loras.LORA_STRENGTH_MAX),
                }
                for item in (options.get("loras") or [])
                if isinstance(item, dict) and str(item.get("id") or "").strip()
            ],
        },
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    try:
        staged = {}
        for label, source in (("source", image_path), ("mask", mask_path)):
            if not source:
                raise RuntimeError(f"inpaint requires a {label} image")
            source = Path(source).expanduser().resolve()
            allowed = [config.OUT_DIR.resolve(), config.COMFY_OUTPUT_DIR.resolve(), config.COMFY_INPUT_DIR.resolve()]
            if not any(str(source).startswith(str(root)) for root in allowed) or not source.exists():
                raise RuntimeError(f"{label} image is outside private image storage or does not exist")
            config.COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
            name = util.safe_name(source.name)
            comfy_input = (config.COMFY_INPUT_DIR / name).resolve()
            if comfy_input != source:
                comfy_input.write_bytes(source.read_bytes())
            staged[label] = name

        t0 = time.monotonic()
        api_prompt = config.compile_krea2_turbo_inpaint_prompt(
            prompt,
            staged["source"],
            staged["mask"],
            options=dict(rec["options"], sampler_name=options.get("sampler_name"), scheduler=options.get("scheduler")),
            profile=config.accelerator_profile(),
            filename_prefix=f"krea2_inpaint_{job_id}",
        )
        body = json.dumps({"prompt": api_prompt, "client_id": f"media-inpaint-{job_id}"}).encode("utf-8")
        req = Request(f"{config.COMFY_HTTP_DEFAULT}/prompt", data=body, headers={"Content-Type": "application/json"})
        try:
            queued = json.loads(net.urlopen(req, timeout=30).read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI rejected the inpaint graph: {detail[:4000]}") from exc
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")
        rec["comfy_prompt_id"] = prompt_id
        with jobs.jobs_lock:
            jobs.jobs[job_id] = rec

        history = None
        for _ in range(450):
            time.sleep(2)
            try:
                payload = net.urlopen(f"{config.COMFY_HTTP_DEFAULT}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                data = json.loads(payload or "{}")
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            except Exception:
                pass
        if history is None:
            raise RuntimeError(f"inpaint timed out waiting for prompt {prompt_id}")
        status = history.get("status") or {}
        if status.get("status_str") != "success" or not status.get("completed"):
            raise RuntimeError(f"inpaint failed: {status}")

        outputs = []
        for node_out in (history.get("outputs") or {}).values():
            for image in node_out.get("images") or []:
                name = util.safe_name(image.get("filename") or "")
                subfolder = image.get("subfolder") or ""
                typ = image.get("type") or "output"
                root = config.COMFY_OUTPUT_DIR if typ == "output" else config.COMFY_INPUT_DIR
                path = (root / subfolder / name).resolve()
                if media.existing_output_path(path):
                    outputs.append(str(path))
        if not outputs:
            raise RuntimeError("inpaint completed without an output image")
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": media.encrypt_outputs(outputs, job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as exc:
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(exc)})
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


# Interpolation uploads carry whole clips as base64; the JSON cap that guards
# every other route would reject anything past ~18MB of video.
INTERPOLATE_MAX_BODY_BYTES = int(os.environ.get("MEDIA_GATEWAY_INTERPOLATE_MAX_BODY_BYTES", str(512 * 1024 * 1024)))
VIDEO_INLINE_MIMES = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
}


def stage_inline_video_base64(value, max_bytes=400 * 1024 * 1024):
    """Stage a browser-decrypted clip (data URL or raw base64) for processing."""
    if not isinstance(value, str) or not value.strip():
        return None
    encoded = value.strip()
    extension = ".mp4"
    if encoded.startswith("data:"):
        match = re.match(r"^data:(video/[a-zA-Z0-9.+-]+);base64,(.*)$", encoded, flags=re.DOTALL)
        if not match:
            raise ValueError("video_base64 must be raw base64 or a video data URL")
        mime, encoded = match.groups()
        extension = VIDEO_INLINE_MIMES.get(mime.lower(), ".mp4")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("video_base64 is not valid base64") from exc
    if not payload:
        raise ValueError("video_base64 decoded to an empty clip")
    if len(payload) > max_bytes:
        raise ValueError(f"decoded inline video exceeds {max_bytes // (1024 * 1024)}MB")
    config.OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = config.OUT_DIR / f".rife-inline-{uuid.uuid4().hex[:16]}{extension}"
    target.write_bytes(payload)
    return target


def run_video_interpolation(job_id, video_path, options=None):
    """Proper RIFE frame interpolation (Practical-RIFE 4.25, Apple-MLX port —
    vendor/rife-mlx) as a post-process on a finished clip: 2x or 4x the frame
    rate, original audio remuxed untouched (duration is unchanged, only frames
    are inserted BETWEEN existing ones). Runs under the repo venv (MLX), so it
    works for clips from ANY lane — native MLX, local Comfy, or fetched-back
    rentals — and, like upscale, the input arrives already-decrypted from the
    browser, so this never needs the vault key."""
    started = util.now_iso()
    options = options or {}
    factor = 4 if util.int_option(options, "factor", 2, 2, 4) >= 4 else 2
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "rife-interpolation",
        "created_at": started,
        "outputs": [],
        "mode": f"{factor}x",
        "options": {"factor": factor},
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    video_path = Path(video_path)
    output = None
    try:
        if not video_path.is_file():
            raise RuntimeError("interpolation input clip is missing")
        # Pyramid scale 0.5 keeps memory sane on very large frames (upstream's
        # 4K guidance); everything at or below ~1.5K stays full-scale.
        scale = "1.0"
        try:
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=width,height", "-of", "csv=p=0", str(video_path)],
                text=True, capture_output=True, timeout=30,
            )
            dims = [int(v) for v in (probe.stdout or "").strip().split(",") if v.strip().isdigit()]
            if len(dims) == 2 and min(dims) >= 1536:
                scale = "0.5"
        except Exception:
            pass

        config.COMFY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        output = config.COMFY_OUTPUT_DIR / f"rife_{job_id}_{factor}x.mp4"
        t0 = time.monotonic()
        proc = subprocess.run(
            [
                media.SUBPROCESS_PYTHON, "-m", "rife_mlx.pipeline_mlx",
                "-i", str(video_path),
                "-o", str(output),
                "--multi", str(factor),
                "-s", scale,
            ],
            text=True,
            capture_output=True,
            timeout=util.int_option(options, "runtime_timeout_seconds", 1800, 120, 7200),
        )
        if proc.returncode != 0 or not output.is_file() or output.stat().st_size < 1000:
            detail = (proc.stderr or proc.stdout or "unknown rife-mlx error").strip()
            raise RuntimeError(f"RIFE interpolation failed: {detail[-1500:]}")
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": media.encrypt_outputs([str(output)], job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as exc:
        if output is not None:
            output.unlink(missing_ok=True)
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(exc)})
    finally:
        video_path.unlink(missing_ok=True)
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


def run_episode_save(job_id, video_path, options=None):
    """Store a chained episode the BROWSER assembled as a first-class output.

    The shots are E2E-sealed at rest, so only the client can read them and only
    the client can join them (see clipJoiner.js). That left the finished
    episode as a blob URL living in one tab: gone on reload, invisible to
    History, unreachable from any other surface. This is the missing half —
    the joined file is written into the normal output directory and sealed by
    the normal path, so it appears in History exactly like a generated clip.

    The clip arrives already-decrypted from the browser, the same round trip
    RIFE and upscale already make; nothing here needs the vault key."""
    started = util.now_iso()
    options = options or {}
    shots = util.int_option(options, "shots", 0, 0, 512)
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "episode-join",
        "created_at": started,
        "outputs": [],
        "options": {"shots": shots},
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    video_path = Path(video_path)
    output = None
    try:
        if not video_path.is_file():
            raise RuntimeError("episode clip is missing")
        config.COMFY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        output = config.COMFY_OUTPUT_DIR / f"episode_{job_id}.mp4"
        # Move, not copy: the staged input is a plaintext copy of the episode
        # and every extra one is another file the sweeper has to chase.
        shutil.move(str(video_path), str(output))
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": media.encrypt_outputs([str(output)], job_id=job_id),
        })
    except Exception as exc:
        if output is not None:
            output.unlink(missing_ok=True)
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(exc)})
    finally:
        video_path.unlink(missing_ok=True)
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


def run_comfy_upscale(job_id, image_path, options=None):
    """Upscale an existing image. mode='fast' = R-ESRGAN 4x+ Anime6B only
    (~seconds); mode='max' = R-ESRGAN then a tiled Anima diffusion refine pass
    (adds detail, minutes on MPS). The input arrives already-decrypted from the
    browser (image_base64), so this never needs the vault key."""
    started = util.now_iso()
    options = options or {}
    mode = "max" if str(options.get("mode") or "fast").lower() == "max" else "fast"
    scale = util.float_option(options, "scale", 1.5, 1.0, 4.0)
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "comfy-upscale",
        "created_at": started,
        "outputs": [],
        "mode": mode,
        "options": {"scale": scale, "mode": mode},
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    try:
        image_path = Path(image_path).resolve()
        allowed = [config.OUT_DIR.resolve(), config.COMFY_OUTPUT_DIR.resolve(), config.COMFY_INPUT_DIR.resolve()]
        if not any(str(image_path).startswith(str(root)) for root in allowed) or not image_path.exists():
            raise RuntimeError("input image is outside private image storage or does not exist")
        config.COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
        input_name = util.safe_name(image_path.name)
        comfy_input = (config.COMFY_INPUT_DIR / input_name).resolve()
        if comfy_input != image_path:
            comfy_input.write_bytes(image_path.read_bytes())
        filename_prefix = f"upscale_{job_id}"
        # R-ESRGAN_x4plus is a 4x model; downscale to hit the requested net factor.
        esrgan_downscale = max(0.05, min(1.0, scale / 4.0))
        graph = {
            "1": {"class_type": "LoadImage", "inputs": {"image": input_name}},
            "2": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": "RealESRGAN_x4plus_anime_6B.pth"}},
            "3": {"class_type": "ImageUpscaleWithModel", "inputs": {"upscale_model": ["2", 0], "image": ["1", 0]}},
            "4": {"class_type": "ImageScaleBy", "inputs": {"image": ["3", 0], "upscale_method": "bilinear", "scale_by": esrgan_downscale}},
            "9": {"class_type": "SaveImage", "inputs": {"images": ["4", 0], "filename_prefix": filename_prefix}},
        }
        if mode == "max":
            # Re-encode the upscaled pixels (tiled = MPS-safe: the Anima WanVAE
            # overflows MPSGraph's INT_MAX on a full-frame encode) and run a
            # light Anima refine pass to hallucinate detail at the new size.
            prompt_text = str(options.get("prompt") or "masterpiece, best quality, highly detailed, anime coloring")
            negative = str(options.get("negative_prompt") or "worst quality, low quality, blurry, jpeg artifacts, lowres")
            refine_steps = util.int_option(options, "refine_steps", 16, 4, 40)
            refine_denoise = util.float_option(options, "refine_denoise", 0.4, 0.05, 0.8)
            seed = config.resolve_seed_option(options)
            graph.update({
                "10": {"class_type": "UNETLoader", "inputs": {"unet_name": "waiANIMA_v10Base10.safetensors", "weight_dtype": "default"}},
                "11": {"class_type": "CLIPLoader", "inputs": {"clip_name": "waiANIMA_v10Base10_txt.safetensors", "type": "stable_diffusion", "device": "default"}},
                "12": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
                "13": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["11", 0], "text": prompt_text}},
                "14": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["11", 0], "text": negative}},
                "15": {"class_type": "VAEEncodeTiled", "inputs": {"pixels": ["4", 0], "vae": ["12", 0], "tile_size": 512, "overlap": 64, "temporal_size": 64, "temporal_overlap": 8}},
                "16": {"class_type": "KSampler", "inputs": {"model": ["10", 0], "positive": ["13", 0], "negative": ["14", 0], "latent_image": ["15", 0], "seed": seed, "steps": refine_steps, "cfg": 4.0, "sampler_name": "er_sde", "scheduler": "simple", "denoise": refine_denoise}},
                "17": {"class_type": "VAEDecodeTiled", "inputs": {"samples": ["16", 0], "vae": ["12", 0], "tile_size": 512, "overlap": 64, "temporal_size": 64, "temporal_overlap": 8}},
            })
            graph["9"]["inputs"]["images"] = ["17", 0]
        body = json.dumps({"prompt": graph, "client_id": f"media-upscale-{job_id}"}).encode("utf-8")
        lane_url = lanes.comfy_http_for_prompt_body(body, run_on=options.get('run_on'))
        rec["lane"] = lane_url
        t0 = time.monotonic()
        req = Request(f"{lane_url}/prompt", data=body, headers={"Content-Type": "application/json"})
        try:
            queued = json.loads(net.urlopen(req, timeout=30).read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI rejected the upscale graph: {detail[:2000]}") from exc
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")
        rec["comfy_prompt_id"] = prompt_id
        with jobs.jobs_lock:
            jobs.jobs[job_id] = rec
        history = None
        for _ in range(450):
            time.sleep(2)
            try:
                payload = net.urlopen(f"{lane_url}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                data = json.loads(payload or "{}")
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            except Exception:
                pass
        if history is None:
            raise RuntimeError(f"ComfyUI upscale timed out waiting for prompt {prompt_id}")
        status = history.get("status") or {}
        if status.get("status_str") != "success" or not status.get("completed"):
            raise RuntimeError(f"ComfyUI upscale failed: {status}")
        outputs = []
        for node_out in (history.get("outputs") or {}).values():
            for img in node_out.get("images") or []:
                name = util.safe_name(img.get("filename") or "")
                subfolder = img.get("subfolder") or ""
                typ = img.get("type") or "output"
                root = config.COMFY_OUTPUT_DIR if typ == "output" else config.COMFY_INPUT_DIR
                p = (root / subfolder / name).resolve()
                # The privacy sweeper may seal the plaintext (.zenc or .e2e)
                # before this check runs — any sealed form counts as existing.
                if media.existing_output_path(p):
                    outputs.append(str(p))
        if not outputs:
            raise RuntimeError("ComfyUI upscale completed without output images")
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": media.encrypt_outputs(outputs, job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as exc:
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(exc)})
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
