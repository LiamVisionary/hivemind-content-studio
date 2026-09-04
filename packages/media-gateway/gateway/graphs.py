"""ComfyUI API graph work: reading a prompt body, the BigLove/Krea2/H3
builders, the auto-workflow filler, and the native-MLX route detectors."""
import json
import math
import os
import re
import subprocess
import sys
import zlib
import shutil
from pathlib import Path
from urllib.request import Request, urlopen

from gateway import config, history, jobs, lanes, loras as _loras, native_mlx, net, util


def _prompt_nodes_from_body(body):
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
        prompt = data.get('prompt') if isinstance(data, dict) else None
        return prompt if isinstance(prompt, dict) else {}
    except Exception:
        return {}


def _prompt_body_client_id(body):
    """The submitter's own client_id, which Comfy echoes on the queue entry."""
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
        return str(data.get('client_id') or '') if isinstance(data, dict) else ''
    except Exception:
        return ''


BIGLOVE_KLEIN3_BASE_BUCKET = (1024, 1536)
# A requested canvas is honored as a PIXEL BUDGET around that bucket (the edit
# adopts the reference's aspect afterwards), clamped to the range Klein 9B stays
# coherent and in-memory over: ~0.26MP for a fast draft, ~2MP for a final. The
# ceiling is deliberately below the 24 GB per-job reservation's comfort limit.
BIGLOVE_KLEIN3_MIN_PIXELS = 512 * 512
BIGLOVE_KLEIN3_MAX_PIXELS = 1152 * 1728
# FLUX.2 Klein conditions on up to 4 reference images (the Swift engine's
# Flux2Config.maxReferenceImages for every klein variant, matching BFL's
# editing docs). Every reference cap on this route reads this one number.
BIGLOVE_KLEIN3_MAX_REFERENCES = 4
BIGLOVE_KLEIN3_COMFY_MXFP8_MODEL = "BigLoveKlein3_mxfp8.safetensors"
BIGLOVE_KLEIN3_COMFY_DEQUANT_BF16_MODEL = "BigLoveKlein3_mxfp8_dequant_bf16.safetensors"
BIGLOVE_KLEIN3_COMFY_BF16_MODEL = "BigLoveKlein3_bf16.safetensors"
BIGLOVE_KLEIN3_MLX_DERIVED_MODELS = {
    "BigLoveKlein3_mxfp8_swift_mapped_mlx.safetensors",
    "BigLoveKlein3_mxfp8_mlx_native.safetensors",
}
BIGLOVE_KLEIN3_COMFY_MPS_UNSUPPORTED_MODELS = BIGLOVE_KLEIN3_MLX_DERIVED_MODELS | {
    BIGLOVE_KLEIN3_COMFY_MXFP8_MODEL,
    BIGLOVE_KLEIN3_COMFY_DEQUANT_BF16_MODEL,
}
COMFY_MODELISH_INPUT_KEYS = {
    'model', 'model_name', 'ckpt_name', 'unet_name', 'vae_name',
    'clip_name', 'text_encoder', 'text_encoder_name', 'diffusion_model',
    'name',
}


def normalize_biglove_klein3_steps(value):
    """BigLoveKlein3 page recommends exactly 4 steps, or 2 for upscaling."""
    try:
        steps = int(round(float(value)))
    except Exception:
        steps = 4
    return 2 if steps <= 2 else 4


def orient_biglove_klein3_bucket(width, height):
    """The known-good ~1.5MP trained bucket, oriented to a requested shape.

    The reference workflow metadata uses ImageScaleToTotalPixels at 1.5 MP and
    lands near 1024x1504. The model page's closest recommended trained bucket is
    1024x1536, so the native fast path uses that exact bucket instead of
    arbitrary full-resolution workflow sizes. Callers that cannot trust the
    requested size (a Comfy graph whose EmptyLatentImage is still the stock
    512x512 while an ImageScaleToTotalPixels node sets the real canvas) pin
    themselves here rather than treating that size as a budget.
    """
    bucket_w, bucket_h = BIGLOVE_KLEIN3_BASE_BUCKET
    try:
        landscape = float(width) > float(height)
    except (TypeError, ValueError):
        landscape = False
    return (bucket_h, bucket_w) if landscape else (bucket_w, bucket_h)


def snap_biglove_klein3_resolution(width, height):
    """Resolve a BigLoveKlein3 native canvas from a requested pixel budget.

    This used to pin EVERY native run to the trained bucket, which silently
    threw away the caller's resolution — the studio's Resolution control and the
    registry's advertised width/height inputs did nothing on Apple Silicon, so
    an edit could be neither run cheap for a draft nor pushed for a final (the
    portable Comfy lane honored them all along). The bucket is still what an
    unspecified request lands on; a requested size is now honored as a pixel
    BUDGET, scaled off the bucket and clamped to the supported range. Aspect is
    not taken from the request: an edit reshapes this budget onto the
    reference's own aspect afterwards.
    """
    try:
        requested_w = int(round(float(width)))
        requested_h = int(round(float(height)))
    except (TypeError, ValueError):
        requested_w = requested_h = 0
    if requested_w <= 0 or requested_h <= 0:
        return orient_biglove_klein3_bucket(requested_w, requested_h)
    bucket_w, bucket_h = orient_biglove_klein3_bucket(requested_w, requested_h)
    budget = min(BIGLOVE_KLEIN3_MAX_PIXELS, max(BIGLOVE_KLEIN3_MIN_PIXELS, requested_w * requested_h))
    scale = (budget / float(bucket_w * bucket_h)) ** 0.5
    return (
        _round_to_multiple(bucket_w * scale, multiple=32),
        _round_to_multiple(bucket_h * scale, multiple=32),
    )


def _reshape_dims_to_image_aspect(image_path, width, height, *, multiple=32):
    """Reshape a width×height pixel budget to a source image's aspect ratio.

    An edit rescales the reference onto the output canvas, so a canvas whose
    aspect differs from the source distorts it — the fixed 1024x1536 bucket
    stretched square references vertically. Keep the caller's pixel budget,
    adopt the source aspect (clamped to 3:1 either way so a degenerate strip
    cannot blow up one dimension), and stay on the sampling grid. When the
    source cannot be read the caller's dims pass through unchanged.
    """
    dims = _image_dimensions(image_path) if image_path else None
    if not dims or dims[0] <= 0 or dims[1] <= 0:
        return width, height
    try:
        budget = max(1, int(width)) * max(1, int(height))
    except Exception:
        return width, height
    aspect = max(1.0 / 3.0, min(3.0, dims[0] / dims[1]))
    new_width = (budget * aspect) ** 0.5
    return (
        _round_to_multiple(new_width, multiple=multiple),
        _round_to_multiple(new_width / aspect, multiple=multiple),
    )


def exact_comfy_biglove_model_name():
    if not config.supports_apple_silicon_optimizations():
        return None
    override = os.environ.get("ZIMG_EXACT_COMFY_BIGLOVE_MODEL", "").strip()
    model_dir = config.COMFY / "models" / "diffusion_models"
    candidates = [
        override,
        BIGLOVE_KLEIN3_COMFY_BF16_MODEL,
        BIGLOVE_KLEIN3_COMFY_DEQUANT_BF16_MODEL,
    ]
    for name in candidates:
        if name and (model_dir / name).exists():
            return name
    return None


def exact_comfy_biglove_prompt_body(body):
    """Map BigLove MXFP8 filenames to a Comfy/MPS-compatible exact model.

    The Swift sidecar uses derived safetensors with MLX-specific tensor names,
    PyTorch/MPS cannot execute Float8_e4m3fn tensors, and the local dequant file
    still carries Comfy quant sidecars. When a real Comfy workflow is forwarded
    for fidelity on this Mac, use the clean installed BF16 file instead of any
    MXFP8/MLX/dequant filename.
    """
    target_model = exact_comfy_biglove_model_name()
    if not target_model:
        return body
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
    except Exception:
        return body
    prompt = data.get('prompt') if isinstance(data, dict) else None
    if not isinstance(prompt, dict):
        return body
    changed = False
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get('inputs')
        if not isinstance(inputs, dict):
            continue
        for key, value in list(inputs.items()):
            if not isinstance(value, str) or not lanes._is_modelish_input_key(key):
                continue
            if Path(value).name in BIGLOVE_KLEIN3_COMFY_MPS_UNSUPPORTED_MODELS and value != target_model:
                inputs[key] = target_model
                changed = True
                print(f"[comfy-proxy] rewrote BigLove exact model {Path(value).name} -> {target_model}", flush=True)
    if not changed:
        return body
    return json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


KREA2_TURBO_LEGACY_CONVROT_MODEL = "Krea2_Turbo_convrot_int8mixed.safetensors"


def _api_ref_node_id(value):
    if isinstance(value, list) and value:
        return str(value[0])
    return None


def exact_comfy_krea2_turbo_pre_lora_prompt_body(body):
    """Repair stale Krea2 Turbo ConvRot runtime-LoRA prompts before Comfy runs them.

    Older browser sessions can keep submitting:
      UNETLoader(Krea2_Turbo_convrot_int8mixed) -> MultiLoRAStack -> KSampler

    That applies LoRAs to already-quantized ConvRot INT8 weights and has shown
    blotchy/noisy texture artifacts. The safe Apple Silicon route bakes LoRAs
    into the BF16 Turbo source first, then quantizes ConvRot INT8 on the fly.
    The guard also normalizes stale Krea2 Turbo sampler settings from the old
    er_sde/simple experiment to the current euler_ancestral/beta default.
    """
    if not config.supports_apple_silicon_optimizations():
        return body
    if not (config.COMFY / "models" / "diffusion_models" / config.KREA2_TURBO_PRE_LORA_SOURCE_MODEL).exists():
        return body
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
    except Exception:
        return body
    prompt = data.get('prompt') if isinstance(data, dict) else None
    if not isinstance(prompt, dict):
        return body

    changed = False
    def is_krea2_turbo_loader(node):
        if not isinstance(node, dict):
            return False
        inputs = node.get('inputs')
        if not isinstance(inputs, dict):
            return False
        model_name = Path(str(inputs.get('unet_name') or '')).name
        if node.get('class_type') == 'UNETLoader':
            return model_name == KREA2_TURBO_LEGACY_CONVROT_MODEL
        if node.get('class_type') == 'OTUNetLoaderW8A8':
            return model_name == config.KREA2_TURBO_PRE_LORA_SOURCE_MODEL and inputs.get('model_type') == 'krea2'
        return False

    if any(is_krea2_turbo_loader(node) for node in prompt.values()):
        for node in prompt.values():
            if not isinstance(node, dict) or node.get('class_type') != 'KSampler':
                continue
            inputs = node.get('inputs')
            if not isinstance(inputs, dict):
                continue
            if inputs.get('sampler_name') == 'er_sde' and inputs.get('scheduler') == 'simple':
                inputs['sampler_name'] = 'euler_ancestral'
                inputs['scheduler'] = 'beta'
                changed = True
                print("[comfy-proxy] rewrote stale Krea2 Turbo sampler er_sde/simple -> euler_ancestral/beta", flush=True)

    for lora_id, lora_node in list(prompt.items()):
        if not isinstance(lora_node, dict) or lora_node.get('class_type') != 'MultiLoRAStack':
            continue
        lora_inputs = lora_node.get('inputs')
        if not isinstance(lora_inputs, dict):
            continue
        model_ref = lora_inputs.get('model')
        clip_ref = lora_inputs.get('clip')
        unet_id = _api_ref_node_id(model_ref)
        clip_id = _api_ref_node_id(clip_ref)
        if unet_id is None or unet_id not in prompt:
            continue
        unet_node = prompt.get(unet_id)
        if not isinstance(unet_node, dict) or unet_node.get('class_type') != 'UNETLoader':
            continue
        unet_inputs = unet_node.get('inputs')
        if not isinstance(unet_inputs, dict):
            continue
        if Path(str(unet_inputs.get('unet_name') or '')).name != KREA2_TURBO_LEGACY_CONVROT_MODEL:
            continue

        lora_node['class_type'] = 'MultiLoRAStackToPreLora'
        lora_node['inputs'] = {'lora_stack': lora_inputs.get('lora_stack', '[]')}

        unet_node['class_type'] = 'OTUNetLoaderW8A8'
        unet_node['inputs'] = {
            'pre_lora': [str(lora_id), 0],
            'unet_name': config.KREA2_TURBO_PRE_LORA_SOURCE_MODEL,
            'weight_dtype': 'default',
            'model_type': 'krea2',
            'on_the_fly_quantization': True,
            'enable_convrot': True,
            'lora_mode': 'None',
        }

        for node in prompt.values():
            if not isinstance(node, dict):
                continue
            if node is unet_node:
                continue
            inputs = node.get('inputs')
            if not isinstance(inputs, dict):
                continue
            for key, value in list(inputs.items()):
                if isinstance(value, list) and len(value) >= 2 and str(value[0]) == str(lora_id):
                    slot = value[1]
                    if slot == 0:
                        inputs[key] = [str(unet_id), 0]
                    elif slot == 1 and clip_id is not None:
                        inputs[key] = [str(clip_id), 0]

        changed = True
        print(
            "[comfy-proxy] rewrote stale Krea2 Turbo ConvRot runtime-LoRA graph to Pre-LoRA BF16->ConvRot route",
            flush=True,
        )

    if not changed:
        return body
    return json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def build_krea2_turbo_identity_prompt(prompt, image_name=None, options=None, profile=None, filename_prefix="krea2_identity"):
    return config.compile_krea2_turbo_identity_prompt(
        prompt,
        image_name=image_name,
        options=options,
        profile=profile or config.accelerator_profile(),
        filename_prefix=filename_prefix,
        identity_checkpoint_available=(
            config.COMFY / "models" / "diffusion_models" / config.KREA2_IDENTITY_CONVROT_MODEL
        ).is_file(),
    )


def _load_auto_api_workflow(workflow_file):
    """Load + validate an API-format graph from an allowed folder.

    Two roots, both read-only to a client: the user's drop-in folders, and the
    gateway's OWN workflows/ directory — the graphs the registry ships and
    names by `workflow_file` (loadHostedImageModels resolves them to absolute
    paths). Without the second root a registered comfy-api-image lane could
    never load its own graph.
    """
    path = Path(str(workflow_file or "")).expanduser().resolve()
    allowed_roots = [root.resolve() for root in config.AUTO_WORKFLOW_DIRS + [config.REGISTRY_WORKFLOW_DIR]]
    if path.suffix.lower() != ".json" or not any(str(path).startswith(f"{root}{os.sep}") for root in allowed_roots):
        raise RuntimeError("workflow file is outside the auto-workflow folders")
    if not path.is_file():
        raise RuntimeError(f"workflow file is missing: {path.name}")
    data = json.loads(path.read_text(encoding="utf-8"))
    graph = data.get("prompt") if isinstance(data, dict) and isinstance(data.get("prompt"), dict) else data
    if not isinstance(graph, dict) or not graph or not all(
        isinstance(node, dict) and node.get("class_type") for node in graph.values()
    ):
        raise RuntimeError(f"{path.name} is not an API-format ComfyUI graph (use ComfyUI's 'Save (API format)')")
    return path, json.loads(json.dumps(graph))


_AUTO_PROMPT_TEXT_KEYS = ("text", "positive_text", "prompt")
_AUTO_SAMPLER_CLASSES = {"KSampler", "KSamplerAdvanced"}


def _auto_find_text_node(graph, start_id, seen=None):
    """Follow a conditioning ref upstream to the first node carrying prompt text."""
    seen = seen or set()
    node_id = str(start_id)
    if node_id in seen or node_id not in graph:
        return None, None
    seen.add(node_id)
    node = graph[node_id]
    inputs = node.get("inputs") or {}
    for key in _AUTO_PROMPT_TEXT_KEYS:
        if isinstance(inputs.get(key), str):
            return node_id, key
    for value in inputs.values():
        if isinstance(value, list) and value:
            found = _auto_find_text_node(graph, value[0], seen)
            if found[0] is not None:
                return found
    return None, None


def _auto_submit_prompt(lane_url, graph, client_id):
    body = json.dumps({"prompt": graph, "client_id": client_id}).encode("utf-8")
    req = Request(f"{lane_url}/prompt", data=body, headers={"Content-Type": "application/json"})
    return json.loads(net.urlopen(req, timeout=30).read().decode("utf-8"))


def _auto_fill_missing_required_inputs(graph, error_payload, lane_url):
    """Self-heal stale API exports: fill inputs a node gained after the export.

    ComfyUI 400s with node_errors listing required_input_missing entries; the
    lane's /object_info declares each input's default. Returns True when at
    least one input was filled (caller retries once).
    """
    try:
        detail = json.loads(error_payload or "{}")
    except Exception:
        return False
    healed = False
    for node_id, node_error in (detail.get("node_errors") or {}).items():
        node = graph.get(str(node_id))
        if not isinstance(node, dict):
            continue
        missing = [
            err.get("extra_info", {}).get("input_name")
            for err in (node_error.get("errors") or [])
            if err.get("type") == "required_input_missing"
        ]
        missing = [name for name in missing if name]
        if not missing:
            continue
        class_type = str(node.get("class_type") or "")
        try:
            payload = net.urlopen(f"{lane_url}/object_info/{class_type}", timeout=10).read().decode("utf-8")
            spec = (json.loads(payload).get(class_type) or {}).get("input") or {}
        except Exception:
            continue
        declared = {}
        for group in ("required", "optional"):
            declared.update(spec.get(group) or {})
        for input_name in missing:
            entry = declared.get(input_name)
            if not (isinstance(entry, list) and len(entry) >= 2 and isinstance(entry[1], dict) and "default" in entry[1]):
                continue
            node.setdefault("inputs", {})[input_name] = entry[1]["default"]
            healed = True
    return healed


def _auto_fit_regional_prompt(node, prompt_text):
    """Regional-prompt nodes (ForgeCouple style) need one prompt line per region.

    The region count comes from the node's own advanced_mapping; a shorter
    prompt is padded by repeating its last line so a plain one-line prompt
    still renders instead of failing validation.
    """
    inputs = node.get("inputs") or {}
    if "advanced_mapping" not in inputs:
        return str(prompt_text)
    try:
        regions = len(json.loads(inputs.get("advanced_mapping") or "[]"))
    except Exception:
        regions = 0
    if regions < 2:
        return str(prompt_text)
    lines = [line.strip() for line in str(prompt_text).splitlines() if line.strip()] or [str(prompt_text)]
    while len(lines) < regions:
        lines.append(lines[-1])
    return "\n".join(lines)


def _normalize_couple_options(options):
    """Coerce couple_* options to safe primitives — they land in job records."""
    if not isinstance(options, dict):
        return options
    for flag in ("couple_mode", "couple_shared"):
        if flag in options:
            options[flag] = str(options.get(flag)).strip().lower() in ("1", "true", "yes", "on")
    if "couple_split" in options:
        try:
            options["couple_split"] = min(0.9, max(0.1, float(options["couple_split"])))
        except (TypeError, ValueError):
            options["couple_split"] = 0.5
    if "couple_direction" in options:
        vertical = str(options.get("couple_direction") or "").strip().lower() in ("vertical", "stacked", "vert")
        options["couple_direction"] = "vertical" if vertical else "horizontal"
    if "couple_pair" in options:
        pair = str(options.get("couple_pair") or "").strip().lower()
        options["couple_pair"] = pair if pair in ("girls", "mixed", "boys") else "girls"
    return options


_COUPLE_PAIR_ANCHORS = {"girls": "2girls", "mixed": "1boy, 1girl", "boys": "2boys"}
_COUPLE_SOLO_TAG_PREFIX = re.compile(r"^\s*(?:(?:1girl|1boy|2girls|2boys|solo|couple)\s*,\s*)+", re.IGNORECASE)


def _couple_anchor_line(line, anchor):
    """Prefix a character line with the pair's composition anchor.

    Empirically (anima turbo lane, 2026-07-22): regional masks steer per-area
    attributes but only a composition tag on every line makes TWO characters
    appear — without it the regions blend into one subject. Leading solo/pair
    tags are stripped first so user-typed "1girl, ..." doesn't fight the pair.
    """
    return f"{anchor}, {_COUPLE_SOLO_TAG_PREFIX.sub('', str(line)).strip()}"


def _auto_bypass_regional_prompt_node(graph, node_id, prompt, negative):
    """Single-subject default for regional/couple graphs (couple mode off).

    Splices the regional-prompt node out of the graph: the sampler's model is
    rewired to the node's upstream model and its conditioning is replaced by
    full-canvas CLIPTextEncode nodes on the same CLIP — including a real
    negative encode, so cfg behaves normally. Returns False when the node is
    referenced in a way that can't be rewired (caller falls back to padding).
    """
    node = graph.get(str(node_id)) or {}
    inputs = node.get("inputs") or {}
    model_ref = inputs.get("model")
    clip_ref = inputs.get("clip")
    if not (isinstance(model_ref, list) and isinstance(clip_ref, list)):
        return False
    ref_sites = []
    for other_id, other in graph.items():
        if str(other_id) == str(node_id):
            continue
        for key, value in (other.get("inputs") or {}).items():
            if isinstance(value, list) and len(value) == 2 and str(value[0]) == str(node_id):
                if int(value[1]) > 1:
                    return False  # auxiliary output (parsed prompt) we can't substitute
                ref_sites.append((other, key, int(value[1])))
    numeric_ids = [int(k) for k in graph if str(k).isdigit()]
    pos_id = str(max(numeric_ids or [0]) + 1)
    neg_id = str(max(numeric_ids or [0]) + 2)
    for other, key, output_index in ref_sites:
        if output_index == 0:
            other["inputs"][key] = list(model_ref)
        else:
            other["inputs"][key] = [neg_id if key == "negative" else pos_id, 0]
    graph[pos_id] = {"class_type": "CLIPTextEncode", "inputs": {"clip": list(clip_ref), "text": str(prompt)}}
    graph[neg_id] = {"class_type": "CLIPTextEncode", "inputs": {"clip": list(clip_ref), "text": str(negative or "")}}
    del graph[str(node_id)]
    return True


def _auto_split_regional_negative(graph, sampler_inputs, node_id, negative):
    """Give a regional-prompt graph a real negative conditioning input.

    Couple templates wire the sampler's negative to the SAME regional output
    as the positive, which turns cfg into a mathematical no-op (uncond ==
    cond). When the regional node stays in the graph, rewire negative to a
    plain CLIPTextEncode on the node's own CLIP — ComfyUI skips it entirely
    at cfg 1.0, and it provides real guidance above that.
    """
    node = graph.get(str(node_id)) or {}
    clip_ref = (node.get("inputs") or {}).get("clip")
    negative_ref = sampler_inputs.get("negative")
    if not isinstance(clip_ref, list):
        return False
    if not (isinstance(negative_ref, list) and negative_ref and str(negative_ref[0]) == str(node_id)):
        return False
    numeric_ids = [int(k) for k in graph if str(k).isdigit()]
    neg_id = str(max(numeric_ids or [0]) + 1)
    graph[neg_id] = {"class_type": "CLIPTextEncode", "inputs": {"clip": list(clip_ref), "text": str(negative or "")}}
    sampler_inputs["negative"] = [neg_id, 0]
    return True


def _auto_apply_model_loras(graph, sampler_inputs, resolved_loras):
    """Chain user LoRAs into an auto-workflow graph (model-only patches).

    Walks the sampler's model conditioning upstream to the edge right above
    the checkpoint/UNET loader and splices LoraLoaderModelOnly nodes there —
    upstream of any regional-prompt or template LoRA nodes, matching the
    established anima pattern. Returns how many LoRAs were applied.
    """
    if not resolved_loras:
        return 0
    holder = sampler_inputs
    for _ in range(len(graph) + 1):
        ref = holder.get("model")
        if not (isinstance(ref, list) and ref and str(ref[0]) in graph):
            return 0
        upstream_inputs = (graph[str(ref[0])].get("inputs") or {})
        if isinstance(upstream_inputs.get("model"), list):
            holder = upstream_inputs
            continue
        break
    lora_root = (config.COMFY / "models" / "loras").resolve()
    previous = list(holder["model"])
    next_id = max([int(k) for k in graph if str(k).isdigit()] or [0]) + 1
    applied = 0
    for item in resolved_loras:
        try:
            lora_name = str(Path(item["path"]).resolve().relative_to(lora_root))
        except Exception:
            lora_name = str(item.get("id") or "").strip()
        if not lora_name:
            continue
        graph[str(next_id)] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": previous, "lora_name": lora_name, "strength_model": float(item.get("strength", 1.0))},
        }
        previous = [str(next_id), 0]
        next_id += 1
        applied += 1
    if applied:
        holder["model"] = previous
    return applied


def _auto_apply_couple_regions(node, pos_key, prompt, options):
    """Couple mode: map prompt lines to explicit regions via Advanced mapping.

    Line order: optional shared full-canvas scene line first (couple_shared),
    then one character line per region. couple_split is the first character's
    share of the canvas along couple_direction (horizontal = side by side,
    vertical = stacked); remaining characters divide the rest evenly.
    """
    inputs = node.setdefault("inputs", {})
    lines = [line.strip() for line in str(prompt).splitlines() if line.strip()] or [str(prompt).strip()]
    shared = bool(options.get("couple_shared")) and len(lines) >= 2
    shared_line = lines[0] if shared else None
    regions = lines[1:] if shared else list(lines)
    while len(regions) < 2:
        regions.append(regions[-1])
    anchor = _COUPLE_PAIR_ANCHORS.get(str(options.get("couple_pair") or "girls"), "2girls")
    regions = [_couple_anchor_line(region, anchor) for region in regions]
    split = options.get("couple_split")
    try:
        split = min(0.9, max(0.1, float(split)))
    except (TypeError, ValueError):
        split = 0.5
    vertical = str(options.get("couple_direction") or "").strip().lower() in ("vertical", "stacked", "vert")
    rows = []
    if shared_line is not None:
        try:
            weight = float(inputs.get("background_weight") or 0.3)
        except (TypeError, ValueError):
            weight = 0.3
        rows.append([0.0, 1.0, 0.0, 1.0, weight])
    bounds = [0.0, split]
    step = (1.0 - split) / max(1, len(regions) - 1)
    while len(bounds) < len(regions) + 1:
        bounds.append(bounds[-1] + step)
    bounds[-1] = 1.0
    for index in range(len(regions)):
        lo, hi = round(bounds[index], 4), round(bounds[index + 1], 4)
        rows.append([0.0, 1.0, lo, hi, 1.0] if vertical else [lo, hi, 0.0, 1.0, 1.0])
    inputs["mode"] = "Advanced"
    inputs["background"] = "None"
    inputs["advanced_mapping"] = json.dumps(rows)
    inputs[pos_key] = "\n".join(([shared_line] if shared_line is not None else []) + regions)


# ---- H3 Studio graphs -------------------------------------------------------
#
# The MiniMax H3 still-image lane is not a KSampler graph: one H3StudioDirector
# node owns prompt, canvas, seed, route and references, and the sampler is a
# SamplerCustomAdvanced fed from it. Everything below patches THAT node.
H3_STUDIO_DIRECTOR_CLASS = "H3StudioDirector"
# h3studio/constants.py MAX_REFERENCE_IMAGES. The Director declares
# media_{1..9}/media_filename_{1..9} optional inputs; collect_images() loads a
# reference from ComfyUI input storage when only the filename is set, so a
# headless graph needs no LoadImage nodes of its own.
H3_STUDIO_MAX_REFERENCES = 9


def _h3_studio_director_id(graph):
    """The Director node's id, or None when this is not an H3 Studio graph."""
    for node_id, node in (graph or {}).items():
        if isinstance(node, dict) and str(node.get("class_type")) == H3_STUDIO_DIRECTOR_CLASS:
            return str(node_id)
    return None


def _h3_studio_reference_names(options):
    """Ordered ComfyUI-input filenames for this run's references.

    Order is load-bearing: the compiler labels them <Picture 1>..<Picture N> by
    the same index the caller sent them in. The Director reads a reference by
    name out of ComfyUI's input storage, so anything staged elsewhere (a
    multipart upload lands in the gateway's own upload dir) is copied in —
    which is also what makes push_prompt_inputs_to_lane find it for a rental.
    """
    values = options.get("reference_image_paths") or []
    if len(values) > H3_STUDIO_MAX_REFERENCES:
        raise RuntimeError(f"H3 Studio accepts at most {H3_STUDIO_MAX_REFERENCES} reference images")
    comfy_input = config.COMFY_INPUT_DIR.resolve()
    names = []
    for value in values:
        path = Path(str(value)).expanduser().resolve()
        if not path.is_file():
            raise RuntimeError(f"reference image is missing: {path.name}")
        if not util._is_under(path, comfy_input):
            comfy_input.mkdir(parents=True, exist_ok=True)
            staged = comfy_input / util.safe_name(path.name)
            staged.write_bytes(path.read_bytes())
            path = staged
        names.append(path.name)
    return names


def _h3_studio_megapixels(options):
    """Canvas AREA for the Director, which sizes from aspect_ratio + megapixels.

    An explicit width+height is exact and routes through aspect_ratio "custom"
    instead. Otherwise the studio's Resolution tier (`base_size`, the short
    side) is what the user actually chose, so it is converted to the area the
    Director understands — dropping it would silently pin every H3 still to the
    graph's own default.
    """
    explicit = options.get("megapixels")
    if explicit is not None:
        return util.float_option(options, "megapixels", 1.0, 0.20, 8.50)
    short_side = util.int_option(options, "base_size", 0, 0, 8192)
    if short_side <= 0:
        return None
    ratio = _h3_studio_aspect_ratio(str(options.get("aspect_ratio") or "1:1"))
    long_side = round(short_side * ratio)
    return max(0.20, min(8.50, (short_side * long_side) / 1_000_000))


def _h3_studio_aspect_ratio(text):
    """Long-side / short-side for an "W:H" label; 1.0 when it cannot be read."""
    left, _, right = str(text or "").partition(":")
    try:
        width, height = float(left), float(right)
    except ValueError:
        return 1.0
    if width <= 0 or height <= 0:
        return 1.0
    return max(width, height) / min(width, height)


def _apply_h3_studio_director(graph, director_id, prompt, options, rec):
    """Drive an H3 Studio graph from a studio generation request.

    Only inputs the Director already declares are touched. Numeric ranges are
    clamped here (ComfyUI does not enforce widget min/max at submit); the enum
    widgets are passed through, because ComfyUI DOES validate combos and its
    rejection names the offending value better than a duplicated table here
    would.
    """
    inputs = graph[director_id].setdefault("inputs", {})

    if str(prompt or "").strip():
        inputs["prompt"] = str(prompt)

    seed = config.resolve_seed_option(options)
    # The Director owns the seed (RandomNoise reads its noise_seed output), and
    # its widget is unsigned — a negative would be clamped to 0 on the box.
    inputs["seed"] = max(0, int(seed))
    rec["options"]["seed"] = inputs["seed"]

    width = util.int_option(options, "width", 0, 0, 16384)
    height = util.int_option(options, "height", 0, 0, 16384)
    if width > 0 and height > 0:
        # plan_resolution() takes the RATIO from aspect_ratio (width/height
        # only when it is literally "custom") and the AREA from megapixels —
        # always, custom included. Both have to be set or the canvas silently
        # drifts: dimensions alone render the graph's 1:1 default, and a
        # "custom" ratio alone keeps the default area (1024x576 came back as
        # 1632x928 in exactly that case).
        inputs["width"] = width
        inputs["height"] = height
        inputs["aspect_ratio"] = "custom"
        inputs["megapixels"] = round(max(0.20, min(8.50, (width * height) / 1_000_000)), 2)
        rec["options"]["width"] = width
        rec["options"]["height"] = height
        rec["options"]["megapixels"] = inputs["megapixels"]
    else:
        requested_ratio = str(options.get("aspect_ratio") or "").strip()
        if requested_ratio:
            inputs["aspect_ratio"] = requested_ratio
            rec["options"]["aspect_ratio"] = requested_ratio
        megapixels = _h3_studio_megapixels(options)
        if megapixels is not None:
            inputs["megapixels"] = round(megapixels, 2)
            rec["options"]["megapixels"] = inputs["megapixels"]

    if options.get("adherence") is not None:
        inputs["adherence"] = util.float_option(options, "adherence", 0.85, 0.0, 1.0)
        rec["options"]["adherence"] = inputs["adherence"]
    for key in ("route", "sampling_profile", "frame_profile"):
        value = str(options.get(key) or "").strip()
        if value:
            inputs[key] = value
            rec["options"][key] = value

    # References. Every slot is written explicitly — including the empty ones —
    # so a re-used graph cannot carry a previous run's filename, and the
    # ordinals stay dense from 1.
    names = _h3_studio_reference_names(options)
    for ordinal in range(1, H3_STUDIO_MAX_REFERENCES + 1):
        name = names[ordinal - 1] if ordinal <= len(names) else ""
        inputs[f"media_filename_{ordinal}"] = name
        inputs[f"media_type_{ordinal}"] = "image"
    if names:
        rec["reference_images"] = len(names)
        # 1 reference resolves to image_to_image (FL2VA first-frame anchor) and
        # 2+ to reference_edit (REF2VA) unless the caller pinned `route`. That
        # is the node's own auto-routing, recorded so the history says which
        # path a run actually took.
        rec["options"].setdefault("route", str(inputs.get("route") or "auto"))
    return names


def _node_inputs(node):
    return node.get('inputs') if isinstance(node, dict) and isinstance(node.get('inputs'), dict) else {}


def _linked_node_key(value):
    if isinstance(value, list) and value:
        key = value[0]
        if isinstance(key, (str, int)):
            return str(key)
    return None


def _find_linked_prompt_node(nodes_by_id, start_value, predicate):
    start = _linked_node_key(start_value)
    if not start:
        return None
    queue = [start]
    seen = set()
    while queue:
        key = queue.pop(0)
        if key in seen:
            continue
        seen.add(key)
        node = nodes_by_id.get(key)
        if not isinstance(node, dict):
            continue
        if predicate(node):
            return node
        for value in _node_inputs(node).values():
            nxt = _linked_node_key(value)
            if nxt and nxt not in seen:
                queue.append(nxt)
    return None


def _collect_linked_load_image_names(nodes_by_id, start_value, seen=None):
    key = _linked_node_key(start_value)
    if not key:
        return []
    seen = seen or set()
    if key in seen:
        return []
    seen.add(key)
    node = nodes_by_id.get(key)
    if not isinstance(node, dict):
        return []
    inputs = _node_inputs(node)
    if node.get('class_type') == 'LoadImage':
        image_name = _prompt_string(inputs.get('image'))
        return [image_name] if image_name else []
    names = []
    for value in inputs.values():
        names.extend(_collect_linked_load_image_names(nodes_by_id, value, seen))
    return names


def _native_reference_image_names(nodes_by_id, nodes, sampler_inputs):
    names = []
    # Flux.2 editor workflows often attach reference images through conditioning
    # nodes with a `pixels` input. Preserve those, including intentional repeats.
    for node in nodes:
        inputs = _node_inputs(node)
        if 'pixels' in inputs:
            names.extend(_collect_linked_load_image_names(nodes_by_id, inputs.get('pixels')))
    if not names and sampler_inputs:
        names.extend(_collect_linked_load_image_names(nodes_by_id, sampler_inputs.get('latent_image')))
    if not names:
        for node in nodes:
            if node.get('class_type') == 'LoadImage':
                image_name = _prompt_string(_node_inputs(node).get('image'))
                if image_name:
                    names.append(image_name)
                    break
    return names[:BIGLOVE_KLEIN3_MAX_REFERENCES]


def _prompt_string(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def _prompt_number(value, default=None):
    try:
        if value in (None, ''):
            return default
        n = float(value)
        return n if n == n else default
    except Exception:
        return default


def _resolve_prompt_string(nodes_by_id, value, default=None, seen=None):
    direct = _prompt_string(value)
    if direct is not None:
        return direct
    link = _prompt_link(value)
    if not link:
        return default
    key, _slot = link
    seen = seen or set()
    if key in seen:
        return default
    seen.add(key)
    node = nodes_by_id.get(key)
    if not isinstance(node, dict):
        return default
    inputs = _node_inputs(node)
    class_type = str(node.get('class_type') or '')
    if class_type in {'PrimitiveString', 'PrimitiveStringMultiline', 'StringLiteral'}:
        return _prompt_string(inputs.get('value') if 'value' in inputs else inputs.get('text')) or default
    for name in ('text', 'prompt', 'value'):
        if name in inputs:
            resolved = _resolve_prompt_string(nodes_by_id, inputs.get(name), default=None, seen=seen)
            if resolved:
                return resolved
    return default


def _resolve_prompt_audio_seconds(nodes_by_id, value, seen=None):
    link = _prompt_link(value)
    if not link:
        return None
    key, _slot = link
    seen = seen or set()
    if key in seen:
        return None
    seen.add(key)
    node = nodes_by_id.get(key)
    if not isinstance(node, dict):
        return None
    inputs = _node_inputs(node)
    class_type = str(node.get('class_type') or '')
    if class_type in {'LoadAudio', 'VHS_LoadAudio'}:
        audio_name = _prompt_string(inputs.get('audio') or inputs.get('audio_path'))
        if not audio_name:
            return None
        audio_path = Path(audio_name)
        if not audio_path.is_absolute():
            audio_path = config.COMFY_INPUT_DIR / audio_name
        if not audio_path.exists():
            return None
        try:
            out = subprocess.check_output(
                [
                    'ffprobe',
                    '-v', 'error',
                    '-show_entries', 'format=duration',
                    '-of', 'default=noprint_wrappers=1:nokey=1',
                    str(audio_path),
                ],
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=5,
            ).strip()
            seconds = float(out)
            return seconds if seconds == seconds and seconds > 0 else None
        except Exception:
            return None
    for candidate in inputs.values():
        seconds = _resolve_prompt_audio_seconds(nodes_by_id, candidate, seen=seen)
        if seconds is not None:
            return seconds
    return None


def _prompt_link(value):
    if isinstance(value, list) and len(value) >= 2:
        key = value[0]
        slot = value[1]
        if isinstance(key, (str, int)):
            try:
                return str(key), int(slot)
            except Exception:
                return str(key), 0
    return None


def _is_biglove_klein3_model_name(name):
    raw = str(name or '').lower()
    compact = re.sub(r'[^a-z0-9]+', '', raw)
    return (
        'biglove' in compact
        and 'klein3' in compact
        and any(marker in raw or marker in compact for marker in ['mxfp8', 'fp8', 'float8', 'e4m3', 'e5m2', 'swift_mapped_mlx', 'mlx_native'])
    )


def _image_dimensions(path):
    p = Path(path)
    if not p.exists():
        return None
    ffprobe = shutil.which('ffprobe')
    if ffprobe:
        try:
            payload = subprocess.check_output(
                [
                    ffprobe, '-v', 'error', '-select_streams', 'v:0',
                    '-show_entries', 'stream=width,height', '-of', 'json', str(p),
                ],
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
            stream = (json.loads(payload or '{}').get('streams') or [{}])[0]
            width, height = int(stream.get('width') or 0), int(stream.get('height') or 0)
            if width > 0 and height > 0:
                return width, height
        except Exception:
            pass
    try:
        out = subprocess.check_output(
            ['/usr/bin/sips', '-g', 'pixelWidth', '-g', 'pixelHeight', str(p)],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        width = height = None
        for line in out.splitlines():
            if 'pixelWidth:' in line:
                width = int(line.rsplit(':', 1)[1].strip())
            elif 'pixelHeight:' in line:
                height = int(line.rsplit(':', 1)[1].strip())
        if width and height:
            return width, height
    except Exception:
        pass
    return None


def _load_image_dimensions(image_name):
    image_path = Path(str(image_name or ''))
    if not image_path.is_absolute():
        image_path = config.COMFY_INPUT_DIR / str(image_name or '')
    return _image_dimensions(image_path)


def _scale_to_total_pixels_dims(width, height, megapixels):
    if not width or not height or width <= 0 or height <= 0:
        return None
    target_pixels = float(megapixels or 0) * 1_000_000
    if target_pixels <= 0:
        return int(width), int(height)
    scale = (target_pixels / float(width * height)) ** 0.5
    return max(1, int(round(width * scale))), max(1, int(round(height * scale)))


def _resolve_prompt_image_dimensions(nodes_by_id, value, seen=None):
    link = _prompt_link(value)
    if not link:
        return None
    key, _slot = link
    seen = seen or set()
    if key in seen:
        return None
    seen.add(key)
    node = nodes_by_id.get(key)
    if not isinstance(node, dict):
        return None
    class_type = str(node.get('class_type') or '')
    inputs = _node_inputs(node)
    if class_type == 'LoadImage':
        image_name = _prompt_string(inputs.get('image'))
        return _load_image_dimensions(image_name) if image_name else None
    if class_type == 'ImageScaleToTotalPixels':
        dims = _resolve_prompt_image_dimensions(nodes_by_id, inputs.get('image'), seen)
        if not dims:
            return None
        megapixels = _prompt_number(inputs.get('megapixels'), _prompt_number(inputs.get('total_pixels'), None))
        if megapixels is None:
            # Some editor widgets serialize the megapixel value only in widget
            # metadata; if it is absent from the API prompt, preserve upstream dims.
            return dims
        return _scale_to_total_pixels_dims(dims[0], dims[1], megapixels)
    # Pass-through common image nodes where output dimensions match the image input.
    for name in ('image', 'pixels', 'images'):
        if name in inputs:
            dims = _resolve_prompt_image_dimensions(nodes_by_id, inputs.get(name), seen)
            if dims:
                return dims
    return None


def _resolve_prompt_number(nodes_by_id, value, default=None):
    direct = _prompt_number(value, None)
    if direct is not None:
        return direct
    link = _prompt_link(value)
    if not link:
        return default
    key, slot = link
    node = nodes_by_id.get(key)
    if not isinstance(node, dict):
        return default
    class_type = str(node.get('class_type') or '')
    inputs = _node_inputs(node)
    if class_type in {'PrimitiveInt', 'PrimitiveFloat', 'PrimitiveNumber'}:
        return _prompt_number(inputs.get('value'), default)
    if class_type == 'ComfyMathExpression':
        values = {}
        for name, raw in inputs.items():
            if not str(name).startswith('values.'):
                continue
            key_name = str(name).split('.', 1)[1]
            values[key_name] = _resolve_prompt_number(nodes_by_id, raw, None)
        expr = _prompt_string(inputs.get('expression')) or ''
        if expr and re.fullmatch(r'[0-9A-Za-z_+\-*/(). \t]+', expr):
            try:
                clean_values = {k: float(v) for k, v in values.items() if v is not None}
                result = eval(expr, {"__builtins__": {}}, clean_values)
                numeric = _prompt_number(result, None)
                if numeric is not None:
                    return numeric
            except Exception:
                pass
    if class_type == 'PainterAudioLength':
        seconds = _resolve_prompt_audio_seconds(nodes_by_id, inputs.get('audio'))
        if seconds is not None:
            return seconds
    if class_type == 'GetImageSize':
        dims = _resolve_prompt_image_dimensions(nodes_by_id, inputs.get('image'))
        if dims:
            return float(dims[0 if slot == 0 else 1 if slot == 1 else 0])
    return default


def _round_to_multiple(value, multiple=64):
    return int(max(multiple, round(value / multiple) * multiple))


def _cap_native_mx_dimensions(width, height):
    """Optionally cap warmed MXFP8 edit sizes to a draft-speed envelope.

    This used to default to 448x672 = 301056 px (the measured sub-10s 2-step
    envelope on this Mac), which silently rendered every BigLove Klein edit at
    ~0.3MP — visibly blurry — regardless of the requested resolution. The cap
    is now off by default so edits run at the model's trained ~1.5MP bucket
    (~20s). Set ZIMAGE_NATIVE_MX_MAX_PIXELS to a positive pixel count
    (e.g. 301056) to restore the draft-speed cap.
    """
    try:
        max_pixels = int(os.environ.get('ZIMAGE_NATIVE_MX_MAX_PIXELS', '0'))
    except Exception:
        max_pixels = 0
    try:
        width = int(width)
        height = int(height)
    except Exception:
        return width, height
    if max_pixels <= 0 or width <= 0 or height <= 0 or width * height <= max_pixels:
        return width, height
    scale = (max_pixels / float(width * height)) ** 0.5
    return _round_to_multiple(width * scale, multiple=32), _round_to_multiple(height * scale, multiple=32)


def _preserve_source_aspect_for_default_square(image_name, width, height):
    """Avoid quality loss from accidental square crop/downscale in Mobile.

    Many Comfy/mobile templates leave EmptyLatentImage at the default 512x512.
    For image-editing, that default square silently crops portrait references and
    makes the native result look blurrier/worse than the earlier 512x768 route.
    Treat an untouched 512x512 latent as "use source aspect"; explicit non-square
    graph dimensions are preserved.
    """
    if width != 512 or height != 512:
        return width, height
    image_path = Path(str(image_name))
    if not image_path.is_absolute():
        image_path = config.COMFY_INPUT_DIR / str(image_name)
    dims = _image_dimensions(image_path)
    if not dims:
        return width, height
    src_w, src_h = dims
    if src_w <= 0 or src_h <= 0:
        return width, height
    aspect = src_w / src_h
    if 0.92 <= aspect <= 1.08:
        return width, height
    short_edge = 512
    if aspect < 1:
        out_w = short_edge
        out_h = min(1024, max(512, _round_to_multiple(short_edge / aspect)))
    else:
        out_w = min(1024, max(512, _round_to_multiple(short_edge * aspect)))
        out_h = short_edge
    return out_w, out_h


def _has_exact_comfy_features_required(nodes):
    """True when native MLX translation would drop graph semantics.

    Native MLX is only a small, fast image-edit shortcut. If the workflow uses
    Comfy-only behavior (reference-conditioning subgraphs, graph LoRAs, custom
    Flux2 sampler/scheduler/guider, explicit VAE loading), route the original
    prompt to ComfyUI so those nodes execute exactly instead of approximating
    them with width/height/steps/prompt extraction.
    """
    exact_only = {
        'ReferenceLatent',
        'LoraLoader',
        'Power Lora Loader (rgthree)',
        'Power Lora Loader',
        'SamplerCustomAdvanced',
        'CFGGuider',
        'Flux2Scheduler',
        'VAELoader',
    }
    for node in nodes:
        class_type = str(node.get('class_type') or '')
        if class_type in exact_only:
            return True
    return False


def _normalize_ltx_mlx_variant(value):
    raw = str(value or '').strip().lower()
    raw = raw.replace('_', '-')
    raw = re.sub(r'[^a-z0-9.-]+', '-', raw).strip('-')
    if raw in config.LTX2_MLX_VARIANTS:
        return raw
    return config.LTX2_MLX_VARIANT_ALIASES.get(raw)


def _ltx_mlx_backend_name(spec, variant):
    prefix = str((spec or {}).get('backend_prefix') or 'mlx-ltx-eros').strip().rstrip('-')
    return f"{prefix}-{variant}"


def _ltx_mlx_output_subdir(spec):
    subdir = str((spec or {}).get('output_subdir') or 'Eros').strip().strip('/')
    return subdir or 'Eros'


def _ltx_mlx_variant_from_text(value):
    text = str(value or '')
    for pattern in (
        r'native_mlx_ltx__([A-Za-z0-9_.-]+)',
        r'native[-_ ]mlx[-_ ]ltx[:=]([A-Za-z0-9_.-]+)',
        r'mlx[-_ ]ltx[:=]([A-Za-z0-9_.-]+)',
    ):
        match = re.search(pattern, text, re.I)
        if match:
            variant = _normalize_ltx_mlx_variant(match.group(1))
            if variant:
                return variant
    return None


def _native_mlx_ltx_metadata_from_workflow(workflow):
    if not isinstance(workflow, dict):
        return None
    extra = workflow.get('extra') if isinstance(workflow.get('extra'), dict) else {}
    native = extra.get('nativeMlxLtx') or extra.get('native_mlx_ltx')
    if not isinstance(native, dict) or native.get('enabled') is False:
        return None
    variant = _normalize_ltx_mlx_variant(native.get('variant') or native.get('id'))
    if not variant:
        return None
    return {
        'variant': variant,
        'pipeline': str(native.get('pipeline') or 'generate').strip().lower(),
        'defaults': native.get('defaults') if isinstance(native.get('defaults'), dict) else {},
        'keyframes': native.get('keyframes') if isinstance(native.get('keyframes'), list) else [],
        'loras': native.get('loras') if isinstance(native.get('loras'), list) else [],
        'video': native.get('video') if isinstance(native.get('video'), dict) else None,
        'ingredient_sheet': (native.get('ingredientSheet') or native.get('ingredient_sheet')) if isinstance(native.get('ingredientSheet') or native.get('ingredient_sheet'), dict) else None,
        'ic_lora': (native.get('icLora') or native.get('ic_lora')) if isinstance(native.get('icLora') or native.get('ic_lora'), dict) else None,
        # This is an ALLOWLIST: a key absent here is silently dropped no matter
        # what the MCP emitted. head_swap arrived alongside pipeline='head-swap'
        # and was discarded here, so the head-swap branch found no face and fell
        # through to the Comfy graph. Any new pipeline needs its payload listed.
        'head_swap': (native.get('headSwap') or native.get('head_swap')) if isinstance(native.get('headSwap') or native.get('head_swap'), dict) else None,
    }


def _native_mlx_ltx_metadata_from_body(data, nodes):
    workflow = None
    if isinstance(data, dict):
        extra_data = data.get('extra_data') if isinstance(data.get('extra_data'), dict) else {}
        extra_pnginfo = extra_data.get('extra_pnginfo') if isinstance(extra_data.get('extra_pnginfo'), dict) else {}
        direct_native = extra_pnginfo.get('nativeMlxLtx') or extra_pnginfo.get('native_mlx_ltx')
        if isinstance(direct_native, dict):
            workflow = {'extra': {'nativeMlxLtx': direct_native}}
        else:
            workflow = extra_pnginfo.get('workflow') if isinstance(extra_pnginfo.get('workflow'), dict) else None
    meta = _native_mlx_ltx_metadata_from_workflow(workflow)
    if meta:
        return meta
    ic_loader = next((node for node in nodes if str(node.get('class_type') or '') == 'LTXICLoRALoaderModelOnly'), None)
    ic_guide = next((node for node in nodes if str(node.get('class_type') or '') == 'LTXAddVideoICLoRAGuide'), None)
    if ic_loader and ic_guide:
        loader_inputs = _node_inputs(ic_loader)
        guide_inputs = _node_inputs(ic_guide)
        lora_name = _prompt_string(loader_inputs.get('lora_name'))
        try:
            lora_strength = float(loader_inputs.get('strength_model', 1.0))
        except Exception:
            lora_strength = 1.0
        try:
            reference_strength = float(guide_inputs.get('strength', 1.0))
        except Exception:
            reference_strength = 1.0
        return {
            'variant': 'regular-q8-distilled',
            'pipeline': 'ic-lora',
            'defaults': {},
            'keyframes': [],
            'loras': ([{'name': lora_name, 'strength': lora_strength}] if lora_name else []),
            'video': None,
            'ic_lora': {
                'single_stage': True,
                'conditioning_strength': 1.0,
                'reference_strength': reference_strength,
            },
        }
    for node in nodes:
        inputs = _node_inputs(node)
        for value in inputs.values():
            if isinstance(value, str):
                variant = _ltx_mlx_variant_from_text(value)
                if variant:
                    return {'variant': variant, 'defaults': {'frames': 233}, 'keyframes': [], 'loras': [], 'video': None}
        node_meta = node.get('_meta') if isinstance(node.get('_meta'), dict) else {}
        for value in node_meta.values():
            if isinstance(value, str):
                variant = _ltx_mlx_variant_from_text(value)
                if variant:
                    return {'variant': variant, 'defaults': {'frames': 233}, 'keyframes': [], 'loras': [], 'video': None}
    return None


def _first_ltx_prompt_text(nodes_by_id, nodes):
    preferred_ids = ('824', '536', '2483')
    for key in preferred_ids:
        node = nodes_by_id.get(key)
        if not isinstance(node, dict):
            continue
        inputs = _node_inputs(node)
        value = inputs.get('value') if 'value' in inputs else inputs.get('text')
        text = _resolve_prompt_string(nodes_by_id, value)
        if text:
            return text
    negative_terms = re.compile(r'\b(child|minor|underage|cartoon|low quality|watermark|negative|bad anatomy)\b', re.I)
    candidates = []
    for node in nodes:
        inputs = _node_inputs(node)
        class_type = str(node.get('class_type') or '')
        value = inputs.get('value') if 'value' in inputs else inputs.get('text')
        if class_type in {'CLIPTextEncode', 'PrimitiveString', 'PrimitiveStringMultiline', 'StringLiteral'}:
            text = _resolve_prompt_string(nodes_by_id, value)
            if text and not negative_terms.search(text):
                candidates.append(text)
    if not candidates:
        return None
    return max(candidates, key=len)


def _first_ltx_image_name(nodes):
    preferred_ids = {'773', '4'}
    load_images = [node for node in nodes if str(node.get('class_type') or '') == 'LoadImage']
    for node in load_images:
        if str(node.get('id') or '') in preferred_ids:
            image_name = _prompt_string(_node_inputs(node).get('image'))
            if image_name:
                return image_name
    for node in load_images:
        image_name = _prompt_string(_node_inputs(node).get('image'))
        if image_name:
            return image_name
    return None


def _native_ltx_keyframe_image_name(item):
    if not isinstance(item, dict):
        return None
    for key in ('image', 'image_path', 'path', 'filename', 'file'):
        image_name = _prompt_string(item.get(key))
        if image_name:
            return image_name
    return None


def _native_ltx_role_frame(role, frames):
    text = str(role or '').strip().lower()
    if text in {'start', 'first', 'first_frame', 'beginning'}:
        return 0
    if text in {'middle', 'mid', 'center', 'centre'}:
        return max(0, (frames - 1) // 2)
    if text in {'end', 'last', 'last_frame', 'final'}:
        return max(0, frames - 1)
    return None


def _native_ltx_keyframe_frame(item, frames, frame_rate):
    if not isinstance(item, dict):
        return 0
    for key in ('frame', 'frame_idx', 'frame_index'):
        if item.get(key) is not None:
            try:
                return max(0, min(frames - 1, int(round(float(item.get(key))))))
            except Exception:
                break
    for key in ('time_seconds', 'time', 'seconds'):
        if item.get(key) is not None:
            try:
                return max(0, min(frames - 1, int(round(float(item.get(key)) * float(frame_rate or 24.0)))))
            except Exception:
                break
    role_frame = _native_ltx_role_frame(item.get('role'), frames)
    return 0 if role_frame is None else role_frame


def _native_ltx_keyframe_strength(item):
    if not isinstance(item, dict):
        return 1.0
    try:
        strength = float(item.get('strength', 1.0))
    except Exception:
        strength = 1.0
    if not math.isfinite(strength):
        strength = 1.0
    return max(0.0, min(1.0, strength))


def _native_ltx_lora_name(item):
    if isinstance(item, str):
        return item.strip()
    if not isinstance(item, dict):
        return None
    for key in ('filePath', 'file_path', 'path', 'name', 'lora_name', 'lora', 'id'):
        value = _prompt_string(item.get(key))
        if value:
            return value
    return None


def _native_ltx_lora_strength(item):
    if isinstance(item, dict):
        for key in ('scale', 'strength', 'strength_model', 'model_strength'):
            if item.get(key) is not None:
                try:
                    value = float(item.get(key))
                    if math.isfinite(value):
                        return value
                except Exception:
                    return 1.0
    return 1.0


def _native_ltx_lora_enabled(item):
    if not isinstance(item, dict):
        return True
    value = item.get('enabled', item.get('on', item.get('active', True)))
    return value is not False and str(value).strip().lower() not in {'0', 'false', 'off', 'no', 'none', 'disabled'}


def _native_ltx_loras(raw_loras):
    out = []
    seen = set()
    if not isinstance(raw_loras, list):
        return out
    for item in raw_loras:
        if not _native_ltx_lora_enabled(item):
            continue
        name = _native_ltx_lora_name(item)
        if not name:
            continue
        path = _loras._resolve_lora_path(name)
        strength = _native_ltx_lora_strength(item)
        key = (str(path or name), round(strength, 6))
        if key in seen:
            continue
        seen.add(key)
        out.append({
            'name': Path(str(name)).name,
            'source': name,
            'scale': strength,
            **({'filePath': path} if path else {}),
        })
    return out


def _native_ltx_keyframes(raw_keyframes, frames, frame_rate, fallback_image=None):
    out = []
    if isinstance(raw_keyframes, list):
        for item in raw_keyframes:
            if not isinstance(item, dict):
                continue
            image_name = _native_ltx_keyframe_image_name(item)
            if not image_name:
                continue
            out.append({
                'image_path': image_name,
                'frame': _native_ltx_keyframe_frame(item, frames, frame_rate),
                'strength': _native_ltx_keyframe_strength(item),
                'role': str(item.get('role') or '').strip() or None,
            })
    if fallback_image and not any(int(k.get('frame', 0)) == 0 for k in out):
        out.insert(0, {'image_path': fallback_image, 'frame': 0, 'strength': 1.0, 'role': 'start'})
    if not out and fallback_image:
        out.append({'image_path': fallback_image, 'frame': 0, 'strength': 1.0, 'role': 'start'})
    deduped = {}
    for item in out:
        frame = int(item.get('frame') or 0)
        deduped[frame] = item
    return [deduped[key] for key in sorted(deduped)]


def _ltx_valid_frame_count(value, default=233):
    try:
        frames = int(round(float(value)))
    except Exception:
        frames = default
    frames = max(9, min(721, frames))
    return max(9, int(round((frames - 1) / 8)) * 8 + 1)


def _ltx_snap_render_dimensions(width, height, *, single_stage=False):
    """Floor a render size to the grid the selected LTX pipeline can honor.

    The two-stage pipelines (distilled generate and the dev --two-stage
    equivalent) run stage 1 at half resolution, so the ltx-2-mlx runtime floors
    any dimension that is not a multiple of 64 (928 -> 896) AFTER the job
    record is written; single-stage paths floor to the VAE's 32. Snapping
    before the record keeps it, the prepared anchors, and the delivered file
    on one agreed size.
    """
    modulus = 32 if single_stage else 64
    snap = lambda value: max(modulus, (int(value) // modulus) * modulus)
    return snap(width), snap(height)


def _ltx_extension_output_frames(duration_seconds, frame_rate=24.0):
    try:
        duration = float(duration_seconds)
        fps = float(frame_rate)
    except Exception:
        duration, fps = 4.0, 24.0
    if not math.isfinite(duration) or duration <= 0:
        duration = 4.0
    if not math.isfinite(fps) or fps <= 0:
        fps = 24.0
    return max(8, min(720, int(math.ceil(duration * fps / 8.0)) * 8))


def _ltx_extension_latent_frames(duration_seconds, frame_rate=24.0):
    return _ltx_extension_output_frames(duration_seconds, frame_rate) // 8


def _call_comfy_free_before_ltx():
    for _lane, base in lanes.COMFY_LANES.items():
        try:
            req = Request(base.rstrip('/') + '/free', data=json.dumps({'unload_models': True, 'free_memory': True}).encode('utf-8'), headers={'Content-Type': 'application/json'}, method='POST')
            net.urlopen(req, timeout=5).read()
        except Exception:
            pass


def detect_native_mlx_ltx_prompt(body):
    """Return an explicit native MLX LTX video job from a Mobile Comfy prompt."""
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
    except Exception:
        return None
    prompt_graph = data.get('prompt') if isinstance(data, dict) else None
    if not isinstance(prompt_graph, dict):
        return None
    if not config.supports_native_mlx_ltx_route():
        return None

    nodes_by_id = {str(k): v for k, v in prompt_graph.items() if isinstance(v, dict)}
    for key, node in nodes_by_id.items():
        node.setdefault('id', key)
    nodes = list(nodes_by_id.values())
    meta = _native_mlx_ltx_metadata_from_body(data, nodes)
    if not meta:
        return None
    variant = meta.get('variant')
    spec = config.LTX2_MLX_VARIANTS.get(variant)
    if not spec:
        return None

    defaults = meta.get('defaults') or {}
    prompt_text = _first_ltx_prompt_text(nodes_by_id, nodes)
    if not prompt_text:
        return None
    pipeline = str(meta.get('pipeline') or 'generate').strip().lower()
    print(f"[ltx-native] pipeline={pipeline!r} keys={sorted(meta)} head_swap={meta.get('head_swap')}", flush=True)
    if pipeline == 'head-swap':
        # BFS head swap: the face image rides in a reserved strip composed over
        # the source footage, so this needs BOTH inputs and neither is optional.
        head_swap = meta.get('head_swap') if isinstance(meta.get('head_swap'), dict) else {}
        face_name = _prompt_string(head_swap.get('face_image') or defaults.get('image')) or _first_ltx_image_name(nodes)
        video_name = _prompt_string(head_swap.get('source_video') or (meta.get('video') or {}).get('path'))
        if not face_name or not video_name:
            return None
        frame_rate = util.float_quality_option({'frame_rate': head_swap.get('frame_rate', defaults.get('frame_rate', 24))}, 'frame_rate', 24.0)
        raw_frames = head_swap.get('frames', defaults.get('frames', 121))
        frames = _ltx_valid_frame_count(raw_frames, 121)
        seed_value = head_swap.get('seed', defaults.get('seed', 42))
        seed = int(seed_value) if seed_value is not None else 42
        return {
            'variant': variant,
            'operation': 'head-swap',
            'prompt': prompt_text,
            'video_path': video_name,
            'reference_image_path': face_name,
            'images': [],
            'options': {
                # Width/height are deliberately absent: the render is sized from
                # the SOURCE video, not from the studio's aspect/resolution picker,
                # because a head swap re-times existing footage rather than
                # framing a new shot.
                'frames': frames,
                'frame_rate': frame_rate,
                'seed': seed,
                'model': str(spec.get('video_model') or spec.get('model') or ''),
                'title': spec['title'],
                'benchmark_seconds': spec.get('benchmark_seconds'),
                'head_swap_region_px': util.int_option(head_swap, 'region_px', native_mlx.BFS_HEADSWAP_REGION_PX, 32, 2048),
                # 0 = render at the source's own size. Capping the long side is
                # the main speed lever, since cost scales with rendered pixels.
                'head_swap_max_dimension': util.int_option(head_swap, 'max_dimension', 0, 0, 4096),
                # 'fast' = half-res generation + upsample + control-aware refine.
                'head_swap_pipeline': _prompt_string(head_swap.get('pipeline')) or 'single-stage',
                'head_swap_refine_steps': util.int_option(head_swap, 'refine_steps', 3, 1, 8),
                # The author's identity knob: "1.0 -> best motion fidelity;
                # >1.0 -> stronger identity and hair capture, but may distort".
                'head_swap_lora_strength': util.float_quality_option(head_swap, 'lora_strength', 1.0),
                # Which engine runs the swap. 'bfs' regenerates the frame with
                # the IC-LoRA; 'facefusion' swaps the face onto the original.
                'head_swap_backend': _prompt_string(head_swap.get('backend')) or 'bfs',
                'head_swap_face_enhancer': bool(head_swap.get('face_enhancer')),
                'reference_strength': util.float_quality_option(head_swap, 'reference_strength', 1.0),
                'conditioning_strength': util.float_quality_option(head_swap, 'conditioning_strength', 1.0),
                'runtime_timeout_seconds': util.int_option(head_swap, 'runtime_timeout_seconds', 2400, 60, 14400),
                # LoRAs belong INSIDE options — that is where the runner reads
                # them (options.get('loras')). Returning them at the top level
                # left native_loras empty, so head swap rejected its own request
                # claiming the BFS LoRA was not selected.
                'loras': _native_ltx_loras(meta.get('loras') or []),
            },
        }
    if pipeline == 'ic-lora':
        ic_lora = meta.get('ic_lora') if isinstance(meta.get('ic_lora'), dict) else {}
        ingredient_sheet = meta.get('ingredient_sheet') if isinstance(meta.get('ingredient_sheet'), dict) else {}
        image_name = _prompt_string(ic_lora.get('reference_image') or defaults.get('image')) or _first_ltx_image_name(nodes)
        if not image_name:
            return None
        width = util.int_quality_option({'width': _resolve_prompt_number(nodes_by_id, ['809', 0], defaults.get('width', 768))}, 'width', 768)
        height = util.int_quality_option({'height': _resolve_prompt_number(nodes_by_id, ['811', 0], defaults.get('height', 448))}, 'height', 448)
        frame_rate = util.float_quality_option({'frame_rate': _resolve_prompt_number(nodes_by_id, ['5098', 0], defaults.get('frame_rate', 24))}, 'frame_rate', 24.0)
        latent = next((n for n in nodes if str(n.get('class_type') or '') == 'EmptyLTXVLatentVideo'), None)
        latent_inputs = _node_inputs(latent)
        raw_frames = defaults.get('frames') if defaults.get('frames') is not None else _resolve_prompt_number(nodes_by_id, latent_inputs.get('length'), 121)
        frames = _ltx_valid_frame_count(raw_frames, int(defaults.get('frames', 121) or 121))
        seed_value = _resolve_prompt_number(nodes_by_id, ['4832', 0], defaults.get('seed', 42))
        seed = int(seed_value) if seed_value is not None else 42
        loras = _native_ltx_loras(meta.get('loras') or [])
        try:
            conditioning_strength = max(0.0, min(1.0, float(ic_lora.get('conditioning_strength', 1.0))))
        except Exception:
            conditioning_strength = 1.0
        try:
            reference_strength = max(0.0, min(1.0, float(ic_lora.get('reference_strength', 1.0))))
        except Exception:
            reference_strength = 1.0
        reference_min_frames = util.int_option(ic_lora, 'reference_min_frames', 121, 1, 10000)
        target_min_frames = util.int_option(ic_lora, 'target_min_frames', 9, 9, 721)
        frames = max(frames, target_min_frames)
        image_crf = util.int_option(ic_lora, 'image_crf', 33, 0, 63)
        single_stage_value = ic_lora.get('single_stage', True)
        low_ram_value = ic_lora.get('low_ram', False)
        dev_transformer = _prompt_string(ic_lora.get('dev_transformer'))
        distilled_lora = _prompt_string(ic_lora.get('distilled_lora'))
        guided_dev_value = ic_lora.get('guided_dev', False)
        guided_dev = guided_dev_value is not False and str(guided_dev_value).strip().lower() not in {
            '0', 'false', 'off', 'no'
        }
        stage1_steps = util.int_option(ic_lora, 'stage1_steps', 30, 1, 100)
        cfg_scale = util.float_quality_option(ic_lora, 'cfg_scale', 4.0)
        stg_scale = util.float_quality_option(ic_lora, 'stg_scale', 1.0)
        runtime_timeout_seconds = util.int_option(ic_lora, 'runtime_timeout_seconds', 2400, 60, 14400)
        try:
            distilled_lora_strength = float(ic_lora.get('distilled_lora_strength', 0.5))
        except Exception:
            distilled_lora_strength = 0.5
        return {
            'variant': variant,
            'operation': 'ic-lora',
            'prompt': prompt_text,
            'reference_image_path': image_name,
            'images': _native_ltx_keyframes(meta.get('keyframes') or [], frames, frame_rate),
            'options': {
                'width': width,
                'height': height,
                'frames': frames,
                'frame_rate': frame_rate,
                'seed': seed,
                'model': spec['model'],
                'title': spec['title'],
                'benchmark_seconds': spec.get('benchmark_seconds'),
                'conditioning_strength': conditioning_strength,
                'reference_strength': reference_strength,
                'reference_min_frames': reference_min_frames,
                'target_min_frames': target_min_frames,
                **({
                    'ingredient_source_count': util.int_option(ingredient_sheet, 'sourceCount', 0, 0, 12),
                    'ingredient_sheet_columns': util.int_option(ingredient_sheet, 'columns', 0, 0, 12),
                    'ingredient_sheet_rows': util.int_option(ingredient_sheet, 'rows', 0, 0, 12),
                    'ingredient_conditioning_only': bool(ingredient_sheet.get('conditioningOnly', True)),
                } if ingredient_sheet else {}),
                'image_crf': image_crf,
                'single_stage': single_stage_value is not False and str(single_stage_value).strip().lower() not in {'0', 'false', 'off', 'no'},
                'low_ram': low_ram_value is not False and str(low_ram_value).strip().lower() not in {'0', 'false', 'off', 'no'},
                **({'dev_transformer': dev_transformer} if dev_transformer else {}),
                'guided_dev': guided_dev,
                'stage1_steps': stage1_steps,
                'cfg_scale': cfg_scale,
                'stg_scale': stg_scale,
                'runtime_timeout_seconds': runtime_timeout_seconds,
                **({'distilled_lora': distilled_lora, 'distilled_lora_strength': distilled_lora_strength} if distilled_lora else {}),
                **({'loras': loras} if loras else {}),
            },
        }
    video = meta.get('video') if isinstance(meta.get('video'), dict) else None
    video_name = _prompt_string(video.get('path') or video.get('video_path') or video.get('filename')) if video else None
    if video_name:
        mode = str(video.get('mode') or 'extend').strip().lower()
        if mode != 'extend':
            return None
        video_model = str(spec.get('video_model') or '').strip()
        if not video_model or not Path(video_model).expanduser().exists():
            return None
        frame_rate = util.float_quality_option({'frame_rate': video.get('frame_rate', defaults.get('frame_rate', 24))}, 'frame_rate', 24.0)
        duration_seconds = util.float_quality_option({'duration_seconds': video.get('duration_seconds', defaults.get('duration_seconds', 4))}, 'duration_seconds', 4.0)
        extension_output_frames = _ltx_extension_output_frames(duration_seconds, frame_rate)
        extension_latent_frames = extension_output_frames // 8
        seed_value = _resolve_prompt_number(nodes_by_id, ['812', 0], defaults.get('seed', 42))
        seed = int(seed_value) if seed_value is not None else 42
        return {
            'variant': variant,
            'operation': 'extend',
            'prompt': prompt_text,
            'video_path': video_name,
            'images': [],
            'options': {
                'duration_seconds': duration_seconds,
                'extension_output_frames': extension_output_frames,
                'extension_latent_frames': extension_latent_frames,
                'extend_latent_frames': extension_latent_frames,
                'frame_rate': frame_rate,
                'seed': seed,
                'model': video_model,
                'title': spec['title'],
                'benchmark_seconds': spec.get('benchmark_seconds'),
                'distilled': bool(spec.get('video_distilled')),
                'cfg_scale': float(video.get('cfg_scale', 3.0)),
                'stg_scale': float(video.get('stg_scale', 1.0)),
                'steps': int(video.get('steps', 30)),
            },
        }
    image_name = _first_ltx_image_name(nodes)
    width = util.int_quality_option({'width': _resolve_prompt_number(nodes_by_id, ['809', 0], defaults.get('width', 480))}, 'width', 480)
    height = util.int_quality_option({'height': _resolve_prompt_number(nodes_by_id, ['811', 0], defaults.get('height', 832))}, 'height', 832)
    frame_rate = util.float_quality_option({'frame_rate': _resolve_prompt_number(nodes_by_id, ['542', 0], defaults.get('frame_rate', 24))}, 'frame_rate', 24.0)
    latent = next((n for n in nodes if str(n.get('class_type') or '') == 'EmptyLTXVLatentVideo'), None)
    latent_inputs = _node_inputs(latent)
    raw_frames = defaults.get('frames') if defaults.get('frames') is not None else _resolve_prompt_number(nodes_by_id, latent_inputs.get('length'), 233)
    frames = _ltx_valid_frame_count(raw_frames, int(defaults.get('frames', 233) or 233))
    seed_value = _resolve_prompt_number(nodes_by_id, ['812', 0], defaults.get('seed', 42))
    seed = int(seed_value) if seed_value is not None else 42
    keyframes = _native_ltx_keyframes(meta.get('keyframes') or [], frames, frame_rate, image_name)
    cfg_node_inputs = _node_inputs(nodes_by_id.get('583'))
    cfg_scale = _resolve_prompt_number(nodes_by_id, cfg_node_inputs.get('cfg'), defaults.get('cfg'))
    loras = _native_ltx_loras(meta.get('loras') or [])
    if not image_name and keyframes:
        image_name = keyframes[0].get('image_path')
    # image_name may legitimately be empty: LTX 2.3 generate supports text-to-video
    # (no anchor image), so route a prompt-only request to the native generate
    # pipeline all the same instead of bailing out here.

    return {
        'variant': variant,
        'prompt': prompt_text,
        'image_path': image_name or '',
        'images': keyframes,
        'options': {
            'width': width,
            'height': height,
            'frames': frames,
            'frame_rate': frame_rate,
            'seed': seed,
            'model': spec['model'],
            'title': spec['title'],
            'benchmark_seconds': spec.get('benchmark_seconds'),
            **({'cfg_scale': float(cfg_scale)} if cfg_scale is not None else {}),
            **({'denoise': native_mlx.normalize_ltx_denoise_mode(defaults.get('denoise'))}
               if native_mlx.normalize_ltx_denoise_mode(defaults.get('denoise')) else {}),
            # NAG inputs. The runner only acts on these for distilled variants,
            # where cfg=1 makes a CFG negative prompt inert.
            **({'negative_prompt': _prompt_string(defaults.get('negative_prompt'))}
               if _prompt_string(defaults.get('negative_prompt')) else {}),
            **({'nag_scale': float(defaults['nag_scale'])}
               if _prompt_number(defaults.get('nag_scale')) is not None else {}),
            **({'loras': loras} if loras else {}),
        },
    }


def _studio_lane_from_comfy_prompt_body(body):
    try:
        data = json.loads(
            body.decode('utf-8', errors='replace')
            if isinstance(body, (bytes, bytearray)) else body
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        return ''
    if not isinstance(data, dict):
        return ''
    extra_data = data.get('extra_data') if isinstance(data.get('extra_data'), dict) else {}
    extra_pnginfo = extra_data.get('extra_pnginfo') if isinstance(extra_data.get('extra_pnginfo'), dict) else {}
    return str(
        data.get('studio_lane')
        or extra_pnginfo.get('studioLane')
        or extra_pnginfo.get('studio_lane')
        or ''
    ).strip()[:512]


def detect_native_mlx_biglove_prompt(body):
    """Return a native MLX job extracted from a Comfy API prompt, or None.

    Privacy note: this parses prompt/image fields only in memory so the wrapper
    can route away from Comfy/MPS. It does not log or persist raw prompts/images.
    """
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
    except Exception:
        return None
    prompt_graph = data.get('prompt') if isinstance(data, dict) else None
    if not isinstance(prompt_graph, dict):
        return None

    nodes_by_id = {str(k): v for k, v in prompt_graph.items() if isinstance(v, dict)}
    nodes = list(nodes_by_id.values())

    # Do not silently replace a user's Comfy workflow with the native sidecar.
    # The sidecar is a fast approximation; full graph execution is the fidelity
    # path for workflows that rely on Comfy reference-conditioning semantics.
    if os.environ.get("ZIMG_NATIVE_MXFP8_PROMPT_INTERCEPT", "0") != "1":
        return None
    if not config.supports_native_mlx_biglove_route():
        return None
    if os.environ.get("ZIMG_ALLOW_MXFP8_COMFY_FALLBACK", "1") == "1" and _has_exact_comfy_features_required(nodes):
        return None

    model_node = None
    for node in nodes:
        inputs = _node_inputs(node)
        values = list(inputs.values())
        if any(_is_biglove_klein3_model_name(v) for v in values if isinstance(v, str)):
            model_node = node
            break
    if model_node is None:
        return None
    native_loras, unresolved_loras = _loras._native_loras_from_prompt_nodes(nodes_by_id)
    if unresolved_loras and not native_loras:
        print("[native-mlx] BigLove prompt contains LoRAs that could not be resolved locally; routing to exact Comfy", flush=True)
        return None

    sampler = next((n for n in nodes if str(n.get('class_type') or '') in {'KSampler', 'KSamplerAdvanced', 'SamplerCustomAdvanced'}), None)
    sampler_inputs = _node_inputs(sampler)
    image_names = _native_reference_image_names(nodes_by_id, nodes, sampler_inputs)
    if not image_names:
        return None
    image_name = image_names[0]

    pos_node = _find_linked_prompt_node(
        nodes_by_id,
        sampler_inputs.get('positive'),
        lambda n: n.get('class_type') == 'CLIPTextEncode' and bool(_prompt_string(_node_inputs(n).get('text'))),
    ) if sampler else None
    if pos_node is None:
        pos_node = next((n for n in nodes if n.get('class_type') == 'CLIPTextEncode' and _prompt_string(_node_inputs(n).get('text'))), None)
    prompt_text = _prompt_string(_node_inputs(pos_node).get('text') if pos_node else None)
    if not prompt_text:
        return None
    prompt_text = _loras._strip_lora_prompt_tokens(prompt_text)

    neg_node = _find_linked_prompt_node(
        nodes_by_id,
        sampler_inputs.get('negative'),
        lambda n: n.get('class_type') == 'CLIPTextEncode' and bool(_prompt_string(_node_inputs(n).get('text'))),
    ) if sampler else None
    negative_prompt = _prompt_string(_node_inputs(neg_node).get('text') if neg_node else None)

    latent = next((n for n in nodes if str(n.get('class_type') or '') in {'EmptyLatentImage', 'EmptyFlux2LatentImage', 'EmptySD3LatentImage'}), None)
    latent_inputs = _node_inputs(latent)
    scheduler = next((n for n in nodes if str(n.get('class_type') or '') in {'Flux2Scheduler'}), None)
    scheduler_inputs = _node_inputs(scheduler)
    graph_steps = util.int_quality_option({'steps': _resolve_prompt_number(nodes_by_id, sampler_inputs.get('steps'), _resolve_prompt_number(nodes_by_id, scheduler_inputs.get('steps'), 4))}, 'steps', 4)
    steps = normalize_biglove_klein3_steps(graph_steps)
    guidance_default = _resolve_prompt_number(nodes_by_id, sampler_inputs.get('guidance'), 1.0)
    guidance = util.float_quality_option({'guidance': _resolve_prompt_number(nodes_by_id, sampler_inputs.get('cfg'), guidance_default)}, 'guidance', 1.0)
    seed_val = _resolve_prompt_number(nodes_by_id, sampler_inputs.get('seed'), None)
    seed = int(seed_val) if seed_val is not None else None
    width_value = _resolve_prompt_number(nodes_by_id, latent_inputs.get('width'), _resolve_prompt_number(nodes_by_id, scheduler_inputs.get('width'), 512))
    height_value = _resolve_prompt_number(nodes_by_id, latent_inputs.get('height'), _resolve_prompt_number(nodes_by_id, scheduler_inputs.get('height'), 512))
    requested_width = util.int_quality_option({'width': width_value}, 'width', 512)
    requested_height = util.int_quality_option({'height': height_value}, 'height', 512)
    # A graph's latent size is not a resolution request — it is usually the
    # stock 512x512 next to an ImageScaleToTotalPixels node that sets the real
    # canvas. Take the shape from it and the size from the trained bucket.
    bucket_width, bucket_height = orient_biglove_klein3_bucket(requested_width, requested_height)
    width, height = _cap_native_mx_dimensions(bucket_width, bucket_height)

    return {
        'prompt': prompt_text,
        'image_path': image_name,
        'options': {
            'width': width,
            'height': height,
            'requested_width': requested_width,
            'requested_height': requested_height,
            'steps': steps,
            'guidance': guidance,
            **({'seed': seed} if seed is not None else {}),
            **({'negative_prompt': negative_prompt} if negative_prompt else {}),
            **({'loras': native_loras} if native_loras else {}),
            **({'image_paths': image_names} if len(image_names) > 1 else {}),
        },
    }


def poll_swift_flux2_progress(job_id, total_steps, stop_event):
    """Mirror real Swift denoise step callbacks into the wrapper job record."""
    url = config.SWIFT_FLUX2_SERVER_URL.rstrip("/") + "/progress/" + str(job_id)
    while not stop_event.is_set():
        try:
            with net.urlopen(url, timeout=2) as resp:
                rec = json.loads(resp.read().decode("utf-8") or "{}")
            current = int(rec.get("currentStep") or 0)
            total = int(rec.get("totalSteps") or total_steps or 1)
            overall = int(rec.get("overallPercent") or round((current / max(1, total)) * 100))
            step_progress = int(rec.get("currentStepPercent") or (100 if current > 0 else 0))
            with jobs.jobs_lock:
                job = jobs.jobs.get(job_id)
                if job and job.get("status") == "running":
                    job.update({
                        "current_step": current,
                        "total_steps": total,
                        "progress": max(0, min(100, overall)),
                        "step_progress": max(0, min(100, step_progress)),
                        "progress_phase": rec.get("phase") or "denoise",
                    })
                    jobs.jobs[job_id] = job
        except Exception:
            pass
        stop_event.wait(0.25)


def _is_mobile_workflow_metadata(value):
    if not isinstance(value, dict):
        return False
    if isinstance(value.get('nodes'), list):
        return True
    return (
        value.get('encrypted') is True
        and value.get('format') == 'comfyui-mobile-encrypted-workflow'
        and isinstance(value.get('data'), str)
        and isinstance(value.get('iv'), str)
        and isinstance(value.get('salt'), str)
    )


def _mobile_prompt_workflow_from_body(body):
    """Extract only Comfy's workflow metadata from a Mobile /api/prompt body."""
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    extra_data = data.get('extra_data') if isinstance(data.get('extra_data'), dict) else {}
    extra_pnginfo = extra_data.get('extra_pnginfo') if isinstance(extra_data.get('extra_pnginfo'), dict) else {}
    workflow = extra_pnginfo.get('workflow') if isinstance(extra_pnginfo.get('workflow'), dict) else None
    if _is_mobile_workflow_metadata(workflow):
        return workflow
    return None


def _comfy_history_prompt_tuple(job_id, workflow=None, backend='mlx-mxfp8-bigloves-klein3-edit'):
    extra = {'backend': backend}
    if workflow:
        extra['extra_pnginfo'] = {'workflow': history.scrub_workflow_prompt_text(workflow)}
    return [0, job_id, {}, extra, []]


def _png_chunk(chunk_type, payload):
    chunk_type_bytes = chunk_type.encode('ascii')
    return (
        len(payload).to_bytes(4, 'big')
        + chunk_type_bytes
        + payload
        + zlib.crc32(chunk_type_bytes + payload).to_bytes(4, 'big')
    )


def embed_workflow_text_chunk(png_path, workflow):
    """Embed editor workflow metadata in native PNG outputs without storing prompt text."""
    if not workflow:
        return False
    try:
        path = Path(png_path)
        data = path.read_bytes()
        signature = b'\x89PNG\r\n\x1a\n'
        if not data.startswith(signature):
            return False
        payload = b'workflow\x00' + json.dumps(workflow, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        text_chunk = _png_chunk('tEXt', payload)
        pos = data.rfind(b'IEND')
        if pos < 4:
            return False
        chunk_start = pos - 4
        # Replace an existing workflow tEXt chunk if present; otherwise insert before IEND.
        off = len(signature)
        out = bytearray(signature)
        replaced = False
        while off + 8 <= len(data):
            length = int.from_bytes(data[off:off + 4], 'big')
            ctype = data[off + 4:off + 8]
            end = off + 12 + length
            if end > len(data):
                return False
            if ctype == b'tEXt' and data[off + 8:off + 8 + min(length, 9)] == b'workflow\x00':
                if not replaced:
                    out.extend(text_chunk)
                    replaced = True
            else:
                if ctype == b'IEND' and not replaced:
                    out.extend(text_chunk)
                    replaced = True
                out.extend(data[off:end])
            off = end
            if ctype == b'IEND':
                break
        if replaced:
            path.write_bytes(bytes(out))
            return True
    except Exception as e:
        print(f"[workflow-metadata] failed to embed workflow in {png_path}: {e}", file=sys.stderr)
    return False
