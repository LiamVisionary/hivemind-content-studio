import base64
import io
import json
import os
import shutil
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

import pytest
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
MCP_SOURCE = ROOT / "packages" / "media-gateway" / "bin" / "media-studio-mcp.mjs"
WORKFLOW_REGISTRY = ROOT / "packages" / "media-gateway" / "workflow-registry.json"


def _resolved_registry_workflows(registry: dict) -> list[dict]:
    definitions = {item["id"]: item for item in registry["workflows"]}
    resolved: dict[str, dict] = {}

    def merge(base: dict, override: dict) -> dict:
        result = json.loads(json.dumps(base))
        for key, value in override.items():
            if isinstance(value, dict) and isinstance(result.get(key), dict):
                result[key] = merge(result[key], value)
            else:
                result[key] = json.loads(json.dumps(value))
        return result

    def resolve(workflow_id: str) -> dict:
        if workflow_id in resolved:
            return resolved[workflow_id]
        definition = definitions[workflow_id]
        parent_id = str(definition.get("inherits") or "").strip()
        workflow = merge(resolve(parent_id), definition) if parent_id else merge({}, definition)
        workflow.pop("inherits", None)
        resolved[workflow_id] = workflow
        return workflow

    return [resolve(item["id"]) for item in registry["workflows"]]


def test_positive_prompt_schemas_do_not_cap_character_count():
    source = MCP_SOURCE.read_text(encoding="utf-8")
    image_tool = source.split("server.registerTool('media_generate_image'", 1)[1]
    image_tool = image_tool.split("}, tool(async (args) =>", 1)[0]
    video_tool = source.split("server.registerTool('media_generate_video'", 1)[1]
    video_tool = video_tool.split("}, tool(async (args) =>", 1)[0]

    assert "prompt: z.string().min(1).describe(" in image_tool
    assert "prompt: z.string().min(1).optional().describe(" in video_tool
    assert ".max(1200)" not in image_tool
    assert ".max(4000)" not in video_tool


def test_regular_fast_aliases_never_resolve_to_eros():
    source = MCP_SOURCE.read_text()

    for alias in ("fastregular", "fast-regular", "regular-fast", "regular"):
        assert f"{alias}: 'ltx23-regular-fp8'" in source or f"'{alias}': 'ltx23-regular-fp8'" in source

    registry = json.loads(WORKFLOW_REGISTRY.read_text(encoding="utf-8"))
    regular = next(workflow for workflow in registry["workflows"] if workflow["id"] == "ltx23-regular-fp8")
    assert regular["native_mlx"]["variant"] == "regular-q8-distilled"
    assert "never selects an Eros checkpoint" in regular["description"]
    assert regular["prompt_contract"]["native_mlx_distilled_extension"] == "positive-only"


def test_video_tool_accepts_negative_prompt_before_building_workflow():
    source = MCP_SOURCE.read_text(encoding="utf-8")
    video_tool = source.split("server.registerTool('media_generate_video'", 1)[1]
    video_tool = video_tool.split("}, tool(async (args) =>", 1)[0]

    assert "negative_prompt: z.string().max(2000).optional()" in video_tool


def test_video_tool_carries_the_app_tab_lane_to_the_gateway():
    source = MCP_SOURCE.read_text(encoding="utf-8")
    video_tool = source.split("server.registerTool('media_generate_video'", 1)[1]
    video_schema = video_tool.split("}, tool(async (args) =>", 1)[0]

    assert "studio_lane: z.string().max(512).optional()" in video_schema
    assert "...(args.studio_lane ? { studioLane: args.studio_lane } : {})" in source
    assert "if (args.studio_lane) extraPngInfo.studioLane = args.studio_lane" in source


def test_video_loras_have_native_mlx_and_comfy_graph_parity():
    source = MCP_SOURCE.read_text(encoding="utf-8")
    video_tool = source.split("server.registerTool('media_generate_video'", 1)[1]
    video_tool = video_tool.split("}, tool(async (args) =>", 1)[0]
    assert "loras: z.array(z.object({" in video_tool
    assert "injectWorkflowLoras(promptGraph, settings.loras, workflow.lora_injection)" in source
    assert "mergeNativeWorkflowLoras(nativeSpec.loras, settings.loras)" in source

    registry = json.loads(WORKFLOW_REGISTRY.read_text(encoding="utf-8"))
    # Civitai's base-model category per family — what the studio's LoRA panel
    # filters the installed catalog by.
    expected_bases = {"ltx-2.3": ["LTXV"], "minimax": ["MiniMax H3"]}
    checked = 0
    for workflow in (item for item in _resolved_registry_workflows(registry) if item["media_type"] == "video"):
        if not workflow.get("supports_loras"):
            assert "lora_injection" not in workflow
            assert "loras" not in workflow.get("accepts", [])
            continue
        checked += 1
        assert workflow["supports_loras"] is True
        assert workflow["compatible_base_models"] == expected_bases[workflow["family"]]
        assert "loras" in workflow["accepts"]
        injection = workflow["lora_injection"]
        graph_path = Path(workflow["api_workflow"])
        if not graph_path.is_absolute():
            graph_path = ROOT / "packages" / "media-gateway" / graph_path
        graph = json.loads(graph_path.read_text(encoding="utf-8"))["prompt"]
        sources = [graph[target["node"]]["inputs"][target["input"]] for target in injection["targets"]]
        assert all(source_ref == sources[0] for source_ref in sources)
    assert checked, "no LoRA-capable video workflows resolved — registry parse regressed"
    # All three H3 graphs (base, turbo, reference) route the model through the
    # SageAttention patch node the inherited injection contract targets, so the
    # loop above just proved LoRA injection has a live seam in each of them.
    h3 = [w for w in _resolved_registry_workflows(registry) if w.get("family") == "minimax"]
    assert h3 and all(w["supports_loras"] is True for w in h3)


def test_minimax_h3_registry_entry_matches_its_comfy_graph():
    registry = json.loads(WORKFLOW_REGISTRY.read_text(encoding="utf-8"))
    workflow = next(
        item for item in _resolved_registry_workflows(registry) if item["id"] == "minimax-h3"
    )
    assert workflow["media_type"] == "video"
    assert workflow["builder"] == "comfy-api"
    # Comfy lanes reject an empty LoadImage filename, so prompt-only requests
    # must prune the anchor loader instead of blanking it.
    assert workflow["image_clear"] == "prune"
    # H3's frame lattice: length must land on 17k+5 (the LTX 8k+1 snap in the
    # builder would silently misreport what renders).
    assert workflow["frame_grid"] == {"modulus": 17, "offset": 5}
    assert "negative_prompt" not in workflow["accepts"], "H3 has no negative conditioning lane"

    graph_path = Path(workflow["api_workflow"])
    if not graph_path.is_absolute():
        graph_path = ROOT / "packages" / "media-gateway" / graph_path
    graph = json.loads(graph_path.read_text(encoding="utf-8"))["prompt"]

    # Every declared slot must target a real node input in the graph.
    for name, slot in workflow["slots"].items():
        assert slot["node"] in graph, f"slot {name} targets missing node {slot['node']}"
        assert slot["input"] in graph[slot["node"]]["inputs"], (
            f"slot {name} targets missing input {slot['input']}"
        )

    # The accelerator chain must sit on the MODEL edge feeding both the
    # scheduler and the guider, in this order. Sol-Attn and EasyCache are the
    # optional ones — they ship inert (tau 0 / threshold 0) and the MCP lifts
    # them out of the chain entirely unless a run asks for them.
    # (Upstream KJNodes really does register the sage class with that typo.)
    assert _model_chain(graph) == [
        "EasyCache",
        "SpectrumApplyMiniMaxH3",
        "SolAttnPatch",
        "PathchSageAttentionKJ",
        "UNETLoader",
    ]
    spectrum = [nid for nid, node in graph.items() if node["class_type"] == "SpectrumApplyMiniMaxH3"]
    assert len(spectrum) == 1
    for consumer in ("9", "16"):
        assert graph[consumer]["inputs"]["model"] == graph["9"]["inputs"]["model"]

    # Spectrum's optional inputs must be pinned, never inherited: upstream
    # dc6e1b3 flipped bootstrap_first_forecast's default to true and every H3
    # job on a box provisioned after it died in the node's validate(). This
    # mirrors that validate() so a future retune cannot reintroduce the clash.
    tuning = graph[spectrum[0]]["inputs"]
    assert "bootstrap_first_forecast" in tuning, "leaving it to the upstream default breaks H3"
    # validate() on the pinned node rejects a preset that mixes the one-point
    # bootstrap with a higher-order fit; on v0.1.8 that is a hard raise, and it
    # is what took every rental H3 job down on 2026-08-07.
    if tuning["bootstrap_first_forecast"]:
        assert tuning["degree"] == 1
        assert tuning["warmup_steps"] <= 1
    # max_history must clear the fit's minimum point count for its degree.
    assert tuning["max_history"] >= tuning["degree"] + 1
    # v0.2.x: the trajectory modes are mutually exclusive, and every one of them
    # must be stated — inheriting a Spectrum default is what broke H3 once.
    modes = ("offline_smoothing_replay", "anchor_residual_feedback", "selective_rollback_correction")
    assert all(mode in tuning for mode in modes)
    assert sum(bool(tuning[mode]) for mode in modes) <= 1
    # Joint video+audio output: upstream validated that leaving audio to the
    # video blend reproduced degraded speech and stuttering.
    assert tuning["audio_blend_weight"] == 0.0
    assert tuning["offline_smoothing_replay"] is True
    # Measured 2026-08-07 on a 5090: keeping the forecaster's latent history in
    # system RAM shuttles it over PCIe every forecast step and takes sampling
    # from 33s to 133s — worse than running with no forecaster at all.
    assert tuning["history_storage"] == "vram"

    # No model-freeing node between sampler and decode. Benchmarked on a rented
    # 5090 (2026-08-08): unloading after sampling costs the NEXT job its model
    # load and convrot re-init — 110-152s per clip against 104s without it.
    assert not [n for n in graph.values() if n["class_type"] == "VRAM_Debug"], (
        "freeing models after sampling is a measured regression, not an optimisation"
    )
    for decoder in ("10", "23"):
        assert graph[decoder]["inputs"]["samples"] == ["14", 0]

    # euler, not res_multistep: 49s vs 64s sampling at the same seed and shape,
    # comparable frames, and res_multistep is the reported artifact source with
    # the H3 turbo LoRA.
    assert graph["17"]["inputs"]["sampler_name"] == "euler"

    # The Spectrum forecaster is user-switchable per generation: it is an
    # APPROXIMATION (measured 2026-08-08: 50s vs 105s sampling, at visibly
    # softer fine detail), so the slot must reach the node's own enable input
    # and both H3 graphs must put the forecaster on the same node id for the
    # inherited turbo entry to reuse the slot.
    assert "spectrum" in workflow["accepts"]
    assert workflow["slots"]["spectrum"] == {"node": spectrum[0], "input": "enabled"}
    assert workflow["defaults"]["spectrum"] is True

    # t2v prune contract: the anchor image loader feeds only the optional
    # first_frame input, so deleting it leaves a valid text-to-video graph.
    image_node = workflow["slots"]["image_path"]["node"]
    consumers = [
        (nid, key)
        for nid, node in graph.items()
        for key, value in node["inputs"].items()
        if isinstance(value, list) and value and str(value[0]) == image_node
    ]
    assert consumers == [("104", "first_frame")]


def test_minimax_h3_turbo_inherits_and_bakes_the_distill_contract():
    registry = json.loads(WORKFLOW_REGISTRY.read_text(encoding="utf-8"))
    workflow = next(
        item for item in _resolved_registry_workflows(registry) if item["id"] == "minimax-h3-turbo"
    )
    # Experimental preview weights: surfaced as a beta badge, never the default.
    assert workflow["beta"] is True
    assert workflow["default"] is False
    # Inherited contract from minimax-h3.
    assert workflow["builder"] == "comfy-api"
    assert workflow["frame_grid"] == {"modulus": 17, "offset": 5}
    assert workflow["image_clear"] == "prune"
    assert workflow["defaults"]["steps"] == 6
    assert "negative_prompt" not in workflow["accepts"]

    graph_path = Path(workflow["api_workflow"])
    if not graph_path.is_absolute():
        graph_path = ROOT / "packages" / "media-gateway" / graph_path
    graph = json.loads(graph_path.read_text(encoding="utf-8"))["prompt"]

    # MODEL chain: UNETLoader -> UPSTREAM's turbo LoRA loader -> SageAttention
    # -> optional Sol-Attn -> the MANDATORY dual sigma shift -> Spectrum ->
    # optional EasyCache, feeding scheduler+guider.
    assert _model_chain(graph) == [
        "EasyCache",
        "SpectrumApplyMiniMaxH3",
        "MiniMaxH3SigmaShift",
        "SolAttnPatch",
        "PathchSageAttentionKJ",
        "MiniMaxH3TurboLoRA",
        "UNETLoader",
    ]
    spectrum = next(nid for nid, node in graph.items()
                    if node["class_type"] == "SpectrumApplyMiniMaxH3")
    assert graph["16"]["inputs"]["model"] == graph["9"]["inputs"]["model"]
    shift = next(nid for nid, node in graph.items() if node["class_type"] == "MiniMaxH3SigmaShift")
    assert graph[shift]["inputs"]["shift_video"] == 12.0
    assert graph[shift]["inputs"]["shift_audio"] == 6.0
    lora = next(nid for nid, node in graph.items() if node["class_type"] == "MiniMaxH3TurboLoRA")
    # ComfyUI's plain loader CANNOT apply this LoRA to our pruned int8-convrot
    # base: the 51 AdaLN pairs have nowhere to go, which is why we used to ship
    # a conversion with them stripped out. Upstream's loader re-injects the time
    # conditioning instead, so the full weights apply.
    assert graph[lora]["class_type"] == "MiniMaxH3TurboLoRA", (
        "a plain LoRA loader silently drops this LoRA's AdaLN adapters"
    )
    assert graph[lora]["inputs"]["lora_name"] == "minimax_h3_turbo_v4_step600_ema.safetensors"
    assert graph[lora]["inputs"]["strength"] == 1.0
    # Merging rounds the delta away on a quantized base — ours is int8-convrot.
    assert graph[lora]["inputs"]["low_vram"] is False
    assert graph[lora]["inputs"]["model"][0] == "6"
    # NOT upstream's sampler: measured, it bypasses Spectrum's hooks and turns
    # every step into a real eval (61s of sampling against 30s).
    assert graph["17"]["class_type"] == "KSamplerSelect"
    assert graph["17"]["inputs"]["sampler_name"] == "euler"
    assert graph["9"]["inputs"]["steps"] == 6
    # The inherited spectrum slot must land on THIS graph's forecaster too.
    assert workflow["slots"]["spectrum"] == {"node": spectrum, "input": "enabled"}

    # The two H3 workflows must stay DISTINCT: the quality tier carries no LoRA.
    quality = json.loads((ROOT / "packages/media-gateway/workflows/minimax-h3.api.json").read_text())["prompt"]
    assert not [n for n in quality.values() if "Lora" in n["class_type"] or "TurboLoRA" in n["class_type"]], (
        "the full-weight workflow must never gain the turbo LoRA"
    )
    assert quality["9"]["inputs"]["steps"] == 15
    # Slots inherited from minimax-h3 must still target real inputs here.
    for name, slot in workflow["slots"].items():
        assert slot["node"] in graph and slot["input"] in graph[slot["node"]]["inputs"], name


def _free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _ltx_api_workflow():
    return {
        "client_id": "test",
        "prompt": {
            "510": {
                "class_type": "SamplerCustomAdvanced",
                "inputs": {"noise": ["812", 0], "guider": ["653", 0], "sampler": ["520", 0], "sigmas": ["527", 0]},
            },
            "520": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler_ancestral"}},
            "523": {"class_type": "LTXVConditioning", "inputs": {}},
            "527": {"class_type": "ManualSigmas", "inputs": {"sigmas": "1.0,0.5,0.0"}},
            "531": {
                "class_type": "ImageResizeKJv2",
                "inputs": {"image": ["773", 0], "width": ["809", 0], "height": ["811", 0]},
            },
            "542": {"class_type": "PrimitiveFloat", "inputs": {"value": 24}},
            "597": {"class_type": "VHS_VideoCombine", "inputs": {"filename_prefix": "test"}},
            "653": {
                "class_type": "STGGuiderAdvanced",
                "inputs": {"model": ["731", 0], "positive": ["767", 0], "negative": ["767", 1]},
            },
            "583": {
                "class_type": "CFGGuider",
                "inputs": {"model": ["753", 0], "positive": ["523", 0], "negative": ["523", 1], "cfg": 1},
            },
            "868": {
                "class_type": "SamplerCustomAdvanced",
                "inputs": {"noise": ["812", 0], "guider": ["583", 0], "sampler": ["870", 0], "sigmas": ["871", 0]},
            },
            "870": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "lcm"}},
            "871": {"class_type": "ManualSigmas", "inputs": {"sigmas": "0.85,0.725,0.4219,0.0"}},
            "753": {"class_type": "LTXTextAttentionAmplifier", "inputs": {"model": ["723", 0]}},
            "646": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ltx.safetensors"}},
            "617": {"class_type": "LTXVAudioVAELoader", "inputs": {"ckpt_name": "ltx.safetensors"}},
            "731": {
                "class_type": "LTXLatentAnchorAware",
                "inputs": {"model": ["723", 0], "reference_image": ["531", 0], "anchor_frame": 0},
            },
            "723": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["646", 0]}},
            "719": {"class_type": "LTX2LoraLoaderAdvanced", "inputs": {"model": ["646", 0], "lora_name": "distilled.safetensors", "strength_model": 1.0}},
            "722": {"class_type": "LTX2LoraLoaderAdvanced", "inputs": {"model": ["646", 0], "lora_name": "distilled.safetensors", "strength_model": 1.0}},
            "767": {
                "class_type": "LTXVAddGuide",
                "inputs": {
                    "positive": ["523", 0],
                    "negative": ["523", 1],
                    "vae": ["646", 2],
                    "latent": ["772", 0],
                    "image": ["531", 0],
                    "strength": 1,
                    "frame_idx": 0,
                },
            },
            "770": {
                "class_type": "LTXVImgToVideoInplaceKJ",
                "inputs": {
                    "vae": ["646", 2],
                    "latent": ["744", 0],
                    "num_images": "1",
                    "num_images.image_1": ["531", 0],
                    "num_images.index_1": 0,
                    "num_images.strength_1": 1,
                },
            },
            "772": {
                "class_type": "LTXVImgToVideoInplaceKJ",
                "inputs": {
                    "vae": ["646", 2],
                    "latent": ["534", 0],
                    "num_images": "1",
                    "num_images.image_1": ["531", 0],
                    "num_images.index_1": 0,
                    "num_images.strength_1": 1,
                },
            },
            "773": {"class_type": "LoadImage", "inputs": {"image": "start.png"}},
            "809": {"class_type": "PrimitiveInt", "inputs": {"value": 1024}},
            "811": {"class_type": "PrimitiveInt", "inputs": {"value": 576}},
            "812": {"class_type": "RandomNoise", "inputs": {"noise_seed": 42}},
            "824": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": "prompt"}},
        },
    }


def test_machine_private_job_receipt_never_returns_media_urls_even_when_requested():
    class BackendHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/api/job/job-private":
                payload = json.dumps({
                    "id": "job-private",
                    "status": "success",
                    "prompt": "private motion prompt",
                    "outputs": ["/private/private-output.mp4"],
                    "image_urls": ["/image/private-output.mp4?token=test-token"],
                    "media_urls": ["http://127.0.0.1/private-output.mp4?token=test-token"],
                    "result": {
                        "prompt": "nested private prompt",
                        "video_url": "http://127.0.0.1/nested-private-output.mp4?token=test-token",
                    },
                }).encode()
                self.send_response(200)
            else:
                payload = json.dumps({"error": "not found"}).encode()
                self.send_response(404)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    backend = ThreadingHTTPServer(("127.0.0.1", 0), BackendHandler)
    backend_thread = threading.Thread(target=backend.serve_forever, daemon=True)
    backend_thread.start()
    mcp_port = _free_port()
    env = {
        **os.environ,
        "MEDIA_STUDIO_MCP_BACKEND_URL": f"http://127.0.0.1:{backend.server_port}",
        "MEDIA_STUDIO_MCP_STUDIO_URL": f"http://127.0.0.1:{backend.server_port}",
        "MEDIA_STUDIO_TOKEN_FILE": "/dev/null",
        "MEDIA_STUDIO_TOKEN": "test-token",
        "MEDIA_STUDIO_MCP_MACHINE_PRIVATE": "1",
    }
    process = subprocess.Popen(
        ["node", str(MCP_SOURCE), "--http", "--host", "127.0.0.1", "--port", str(mcp_port)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError(process.stderr.read())
            try:
                with socket.create_connection(("127.0.0.1", mcp_port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise AssertionError("Media Studio MCP did not start")

        request = Request(
            f"http://127.0.0.1:{mcp_port}/mcp",
            data=json.dumps({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "media_get_job",
                    "arguments": {"id": "job-private", "include_urls": True},
                },
            }).encode(),
            headers={
                "authorization": "Bearer test-token",
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
            },
            method="POST",
        )
        with urlopen(request, timeout=10) as response:
            body = response.read().decode("utf-8")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        backend.shutdown()
        backend.server_close()

    assert "machine-redacted" in body
    assert "prompts_redacted" in body
    assert "media_redacted" in body
    for forbidden in ("private motion prompt", "nested private prompt", "private-output.mp4", "image_urls", "media_urls", "test-token"):
        assert forbidden not in body


@pytest.mark.parametrize("workflow_id", ["ltx23-regular-fp8", "ltx23-eros-v14-dmd"])
def test_video_mcp_compiles_shared_keyframes_into_comfy_cuda_graph(tmp_path, workflow_id):
    api_workflow = tmp_path / "ltx-api.json"
    api_workflow.write_text(json.dumps(_ltx_api_workflow()), encoding="utf-8")
    mobile_dir = tmp_path / "mobile"
    mobile_dir.mkdir()
    mobile_workflow = {"nodes": [], "extra": {}}
    for name in (
        "LTX 2.3 Eros MLX v1.4 DMD Mobile.json",
        "LTX 2.3 Eros MLX Exact v1 Merged q8 Mobile.json",
        "LTX 2.3 Regular FP8 Mobile.json",
    ):
        (mobile_dir / name).write_text(json.dumps(mobile_workflow), encoding="utf-8")

    registry = tmp_path / "workflow-registry.json"
    registry.write_text(json.dumps({"workflows": [{
        "id": "ltx23-regular-fp8",
        "media_type": "video",
        "title": "LTX regular test",
        "family": "ltx-2.3",
        "builder": "comfy-api",
        "supports_loras": True,
        "compatible_base_models": ["LTXV"],
        "lora_injection": {
            "class_type": "LTX2LoraLoaderAdvanced",
            "targets": [{"node": "719", "input": "model"}, {"node": "722", "input": "model"}],
            "name_input": "lora_name",
            "strength_input": "strength_model",
            "static_inputs": {"video": 1, "video_to_audio": 0, "audio": 0, "audio_to_video": 0, "other": 1},
        },
        "api_workflow": str(api_workflow),
        "mobile_workflow": str(mobile_dir / "LTX 2.3 Regular FP8 Mobile.json"),
        "native_mlx": {"enabled": True, "variant": "regular-q8-distilled"},
        "defaults": {"width": 1024, "height": 576, "frames": 121, "frame_rate": 24, "seed": 42},
        "slots": {
            "prompt": {"node": "824", "input": "value"},
            "image_path": {"node": "773", "input": "image"},
            "width": {"node": "809", "input": "value"},
            "height": {"node": "811", "input": "value"},
            "frame_rate": {"node": "542", "input": "value"},
            "seed": {"node": "812", "input": "noise_seed"},
        },
    }]}), encoding="utf-8")

    reference = tmp_path / "reference.png"
    reference.write_bytes(b"\x89PNG\r\n\x1a\nanchor-test")
    captures = []

    class BackendHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("content-length", "0")))
            if self.path == "/comfy/api/prompt":
                captures.append(json.loads(body))
                payload = json.dumps({"prompt_id": "cuda-parity-test"}).encode()
                self.send_response(200)
            else:
                payload = json.dumps({"error": "not found"}).encode()
                self.send_response(404)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            payload = json.dumps({"error": "not found"}).encode()
            self.send_response(404)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    backend = ThreadingHTTPServer(("127.0.0.1", 0), BackendHandler)
    backend_thread = threading.Thread(target=backend.serve_forever, daemon=True)
    backend_thread.start()
    mcp_port = _free_port()
    env = {
        **os.environ,
        "MEDIA_STUDIO_MCP_BACKEND_URL": f"http://127.0.0.1:{backend.server_port}",
        "MEDIA_STUDIO_MCP_STUDIO_URL": f"http://127.0.0.1:{backend.server_port}",
        "MEDIA_STUDIO_TOKEN_FILE": "/dev/null",
        "MEDIA_STUDIO_TOKEN": "test-token",
        "MEDIA_STUDIO_MCP_MACHINE_PRIVATE": "0",
        "MEDIA_STUDIO_WORKFLOW_REGISTRY": str(registry),
        "MEDIA_STUDIO_LTX_EROS_API_WORKFLOW": str(api_workflow),
        "MEDIA_STUDIO_LTX_EROS_MOBILE_WORKFLOW_DIR": str(mobile_dir),
        "COMFY_INPUT_DIR": str(tmp_path / "input"),
    }
    process = subprocess.Popen(
        ["node", str(MCP_SOURCE), "--http", "--host", "127.0.0.1", "--port", str(mcp_port)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError(process.stderr.read())
            try:
                with socket.create_connection(("127.0.0.1", mcp_port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise AssertionError("Media Studio MCP did not start")

        long_prompt = "shared keyframe parity test " + ("cinematic motion detail " * 220)
        assert len(long_prompt) > 4000
        arguments = {
            "workflow_id": workflow_id,
            "prompt": long_prompt,
            "image_path": str(reference),
            "middle_image_path": str(reference),
            "end_image_path": str(reference),
            "keyframes": [{"image_path": str(reference), "frame": 30, "strength": 0.65}],
            "loras": [{"id": "ltx/test-style.safetensors", "strength": 0.7}],
            "frames": 121,
            "frame_rate": 24,
            "wait": False,
        }
        request = Request(
            f"http://127.0.0.1:{mcp_port}/mcp",
            data=json.dumps({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "media_generate_video", "arguments": arguments},
            }).encode(),
            headers={
                "authorization": "Bearer test-token",
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
            },
            method="POST",
        )
        with urlopen(request, timeout=10) as response:
            assert response.status == 200
            response.read()
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        backend.shutdown()
        backend.server_close()

    assert len(captures) == 1
    graph = captures[0]["prompt"]
    assert graph["824"]["inputs"]["value"].strip() == long_prompt.strip()
    inplace_nodes = [node for node in graph.values() if node.get("class_type") == "LTXVImgToVideoInplaceKJ"]
    guide_nodes = [node for node in graph.values() if node.get("class_type") == "LTXVAddGuide"]
    load_nodes = [node for node in graph.values() if node.get("class_type") == "LoadImage"]

    assert [node["inputs"]["num_images"] for node in inplace_nodes] == ["4", "4"]
    assert all([
        node["inputs"]["num_images.index_1"],
        node["inputs"]["num_images.index_2"],
        node["inputs"]["num_images.index_3"],
        node["inputs"]["num_images.index_4"],
    ] == [0, 30, 60, 120] for node in inplace_nodes)
    assert all(node["inputs"]["num_images.strength_2"] == 0.65 for node in inplace_nodes)
    assert sorted(node["inputs"]["frame_idx"] for node in guide_nodes) == [0, 30, 60, 120]
    assert len(load_nodes) == 4
    user_lora_nodes = [
        node for node in graph.values()
        if node.get("class_type") == "LTX2LoraLoaderAdvanced"
        and node.get("inputs", {}).get("lora_name") == "ltx/test-style.safetensors"
    ]
    assert len(user_lora_nodes) == 1
    assert user_lora_nodes[0]["inputs"]["strength_model"] == 0.7
    assert user_lora_nodes[0]["inputs"]["audio"] == 0
    metadata = captures[0]["extra_data"]["extra_pnginfo"]["workflow"]["extra"]["nativeMlxLtx"]["keyframes"]
    assert [item["frame"] for item in metadata] == [0, 30, 60, 120]
    assert [item["strength"] for item in metadata] == [1, 0.65, 1, 1]
    native_loras = captures[0]["extra_data"]["extra_pnginfo"]["workflow"]["extra"]["nativeMlxLtx"]["loras"]
    assert native_loras == [{"name": "ltx/test-style.safetensors", "strength": 0.7}]


def test_video_mcp_stages_inline_video_and_compiles_ltx_extension_graph(tmp_path):
    api_workflow = tmp_path / "ltx-api.json"
    api_workflow.write_text(json.dumps(_ltx_api_workflow()), encoding="utf-8")
    mobile_workflow = tmp_path / "LTX 2.3 Regular FP8 Mobile.json"
    mobile_workflow.write_text(json.dumps({"nodes": [], "extra": {}}), encoding="utf-8")
    registry = tmp_path / "workflow-registry.json"
    registry.write_text(json.dumps({"workflows": [{
        "id": "ltx23-regular-fp8",
        "media_type": "video",
        "title": "LTX regular test",
        "family": "ltx-2.3",
        "builder": "comfy-api",
        "api_workflow": str(api_workflow),
        "mobile_workflow": str(mobile_workflow),
        "native_mlx": {"enabled": True, "variant": "regular-q8-distilled"},
        "accepts": ["prompt", "video_path", "video_base64", "video_url", "video_mode", "duration_seconds", "frame_rate", "seed"],
        "defaults": {"frames": 121, "frame_rate": 24, "seed": 42},
        "slots": {
            "prompt": {"node": "824", "input": "value"},
            "frame_rate": {"node": "542", "input": "value"},
            "seed": {"node": "812", "input": "noise_seed"},
        },
    }]}), encoding="utf-8")
    captures = []

    class BackendHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("content-length", "0")))
            if self.path == "/comfy/api/prompt":
                captures.append(json.loads(body))
                payload = json.dumps({"prompt_id": "video-extension-test"}).encode()
                self.send_response(200)
            else:
                payload = json.dumps({"error": "not found"}).encode()
                self.send_response(404)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            payload = json.dumps({"error": "not found"}).encode()
            self.send_response(404)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    backend = ThreadingHTTPServer(("127.0.0.1", 0), BackendHandler)
    threading.Thread(target=backend.serve_forever, daemon=True).start()
    mcp_port = _free_port()
    comfy_input = tmp_path / "input"
    env = {
        **os.environ,
        "MEDIA_STUDIO_MCP_BACKEND_URL": f"http://127.0.0.1:{backend.server_port}",
        "MEDIA_STUDIO_MCP_STUDIO_URL": f"http://127.0.0.1:{backend.server_port}",
        "MEDIA_STUDIO_TOKEN_FILE": "/dev/null",
        "MEDIA_STUDIO_TOKEN": "test-token",
        "MEDIA_STUDIO_WORKFLOW_REGISTRY": str(registry),
        "COMFY_INPUT_DIR": str(comfy_input),
    }
    process = subprocess.Popen(
        ["node", str(MCP_SOURCE), "--http", "--host", "127.0.0.1", "--port", str(mcp_port)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError(process.stderr.read())
            try:
                with socket.create_connection(("127.0.0.1", mcp_port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)
        source_path = tmp_path / "mute-source.mp4"
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24",
                "-frames:v", "9", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-an", str(source_path),
            ],
            check=True,
        )
        source_video = source_path.read_bytes()
        arguments = {
            "workflow_id": "ltx23-regular-fp8",
            "prompt": "continue the same shot with smooth forward motion",
            "video_base64": "data:video/mp4;base64," + base64.b64encode(source_video).decode("ascii"),
            "video_mode": "extend",
            "duration_seconds": 2,
            "frame_rate": 24,
            "wait": False,
        }
        request = Request(
            f"http://127.0.0.1:{mcp_port}/mcp",
            data=json.dumps({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "media_generate_video", "arguments": arguments},
            }).encode(),
            headers={
                "authorization": "Bearer test-token",
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
            },
            method="POST",
        )
        with urlopen(request, timeout=10) as response:
            assert response.status == 200
            response_body = response.read().decode("utf-8")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        backend.shutdown()
        backend.server_close()

    assert len(captures) == 1
    graph = captures[0]["prompt"]
    load = next(node for node in graph.values() if node.get("class_type") == "VHS_LoadVideo")
    extend = next(node for node in graph.values() if node.get("class_type") == "LTXVExtendSampler")
    mask = next(node for node in graph.values() if node.get("class_type") == "LTXVSetAudioVideoMaskByTime")
    extension_audio = next(node for node in graph.values() if node.get("class_type") == "LTXVEmptyLatentAudio")
    audio_encode = next(node for node in graph.values() if node.get("class_type") == "LTXVAudioVAEEncode")
    audio_decode = next(node for node in graph.values() if node.get("class_type") == "LTXVAudioVAEDecode")
    audio_merge = next(node for node in graph.values() if node.get("class_type") == "AudioMerge")
    sampler = [node for node in graph.values() if node.get("class_type") == "SamplerCustomAdvanced"][-1]
    audio_guider = next(
        node for node in graph.values()
        if node.get("class_type") == "CFGGuider" and node["inputs"].get("positive") == [next(key for key, value in graph.items() if value is mask), 0]
    )
    separate = next(node for node in graph.values() if node.get("class_type") == "LTXVSeparateAVLatent")
    outputs = [node for node in graph.values() if node.get("class_type") == "VHS_VideoCombine"]
    assert load["inputs"]["video"].startswith("mcp_video_")
    assert (comfy_input / load["inputs"]["video"]).read_bytes() == source_video
    assert extend["inputs"]["num_new_frames"] == 48
    assert extend["inputs"]["frame_overlap"] == 16
    assert extension_audio["inputs"]["frames_number"] == 48
    assert mask["inputs"]["mask_video"] is False
    assert mask["inputs"]["mask_audio"] is True
    assert mask["inputs"]["start_time"] == 0
    assert '"audio_mode":"generate"' in response_body.replace(" ", "")
    assert audio_merge["inputs"]["audio2"] == [next(key for key, value in graph.items() if value is load), 2]
    assert audio_encode["inputs"]["audio"] == [next(key for key, value in graph.items() if value is audio_merge), 0]
    assert sampler["inputs"]["latent_image"] == [next(key for key, value in graph.items() if value is mask), 2]
    assert sampler["inputs"]["sampler"] == ["870", 0]
    assert sampler["inputs"]["sigmas"] == ["871", 0]
    assert audio_guider["inputs"]["model"] == ["753", 0]
    assert separate["inputs"]["av_latent"] == [next(key for key, value in graph.items() if value is sampler), 1]
    assert len(outputs) == 1
    decode_video = graph[str(outputs[0]["inputs"]["images"][0])]
    assert decode_video["inputs"]["samples"] == [next(key for key, value in graph.items() if value is extend), 0]
    assert outputs[0]["inputs"]["audio"] == [next(key for key, value in graph.items() if value is audio_decode), 0]
    metadata = captures[0]["extra_data"]["extra_pnginfo"]["workflow"]["extra"]["nativeMlxLtx"]["video"]
    assert metadata == {
        "mode": "extend",
        "path": load["inputs"]["video"],
        "source_has_audio": False,
        "duration_seconds": 2,
        "frame_rate": 24,
        "steps": 30,
        "cfg_scale": 3,
        "stg_scale": 1,
    }


def test_ltx_continuation_patches_are_installed_on_windows_and_cuda():
    manifest_path = ROOT / "packages" / "unified-studio-launcher" / "manifests" / "civitai" / "ltx23-eros-anchor.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    patches = {item["file"]: item for item in manifest["patches"]}
    shared = {
        "patches/comfyui-ltxvideo/omit-null-noise-mask.patch",
        "patches/comfyui-ltxvideo/align-overlap-latent-device.patch",
    }

    assert shared <= patches.keys()
    assert all("platforms" not in patches[path] for path in shared)
    overlap_patch = ROOT / "packages" / "unified-studio-launcher" / "patches" / "comfyui-ltxvideo" / "align-overlap-latent-device.patch"
    overlap_text = overlap_patch.read_text(encoding="utf-8")
    assert "samples2 = samples2.to(samples1.device)" in overlap_text
    assert "dtype=torch.int64" in overlap_text


def test_ltx_ingredients_workflow_uses_real_ic_reference_conditioning():
    registry_path = ROOT / "packages" / "media-gateway" / "workflow-registry.json"
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    workflow = next(item for item in registry["workflows"] if item["id"] == "ltx23-ic-ingredients-lora")
    graph = json.loads(Path(workflow["api_workflow"]).read_text(encoding="utf-8"))["prompt"]
    mobile = json.loads(Path(workflow["mobile_workflow"]).read_text(encoding="utf-8"))

    assert workflow["requires"] == {"prompt": True, "image": True}
    assert workflow["prompt_contract"]["type"] == "ltx23-ingredients"
    assert "ingredient_images" in workflow["accepts"]
    assert workflow["ingredient_inputs"] == {
        "max_images": 12,
        "layout": "adaptive-pack",
        "conditioning_only": True,
        "preserve_aspect_ratio": True,
        "render_labels": False,
    }
    assert workflow["timeline_anchor_preparation"] == {
        "mode": "generative-outpaint",
        "preserve_source_aspect_ratio": True,
        "preserve_source_pixels": True,
        "apple": "native-preflight",
        "windows_cuda": "embedded-comfy-graph",
        "cache": True,
    }
    assert workflow["aspect_ratios"] == ["16:9", "9:16", "4:3", "3:4", "1:1"]
    assert workflow["defaults"]["duration_seconds"] == 5
    assert workflow["defaults"]["cfg"] == 1.0
    assert workflow["native_mlx"]["pipeline"] == "ic-lora"
    assert workflow["native_mlx"]["variant"] == "regular-q8-dev-ic"
    assert workflow["benchmark_seconds"] == 270.75
    assert workflow["native_mlx"]["ic_lora"]["single_stage"] is True
    assert workflow["native_mlx"]["ic_lora"]["reference_min_frames"] == 121
    assert workflow["native_mlx"]["ic_lora"]["target_min_frames"] == 121
    assert workflow["native_mlx"]["ic_lora"]["image_crf"] == 0
    assert workflow["native_mlx"]["ic_lora"]["dev_transformer"] == "transformer-dev.safetensors"
    assert workflow["native_mlx"]["ic_lora"]["guided_dev"] is False
    assert workflow["native_mlx"]["ic_lora"]["stage1_steps"] == 8
    assert workflow["native_mlx"]["ic_lora"]["cfg_scale"] == 1.0
    assert workflow["native_mlx"]["ic_lora"]["stg_scale"] == 0.0
    assert workflow["native_mlx"]["ic_lora"]["runtime_timeout_seconds"] == 2400
    assert workflow["native_mlx"]["ic_lora"]["distilled_lora"] == "ltx-2.3-22b-distilled-lora-384-1.1.safetensors"
    assert workflow["native_mlx"]["ic_lora"]["distilled_lora_strength"] == 0.5
    assert workflow["native_mlx"]["loras"][0]["strength"] == 1.4
    assert graph["4922"] == {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {
            "model": ["3940", 0],
            "lora_name": "ltx/2.3/ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
            "strength_model": 0.5,
        },
    }
    assert graph["5011"]["class_type"] == "LTXICLoRALoaderModelOnly"
    assert graph["5011"]["inputs"]["model"] == ["4922", 0]
    assert graph["5012"]["class_type"] == "LTXAddVideoICLoRAGuide"
    assert graph["5012"]["inputs"]["image"] == ["5093", 0]
    assert graph["5093"]["class_type"] == "RepeatImageBatch"
    assert graph["5093"]["inputs"]["amount"] == 121
    assert graph["5012"]["inputs"]["latent_downscale_factor"] == ["5011", 1]
    assert graph["4828"]["class_type"] == "CFGGuider"
    assert graph["4828"]["inputs"]["cfg"] == 1.0
    assert graph["5025"] == {
        "class_type": "ManualSigmas",
        "inputs": {"sigmas": "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"},
    }
    assert not any(node["class_type"] == "LTXVAddGuide" for node in graph.values())
    assert mobile["extra"]["nativeMlxLtx"]["pipeline"] == "ic-lora"
    mobile_nodes = {node["id"]: node for node in mobile["nodes"]}
    assert mobile_nodes[4922]["type"] == "LoraLoaderModelOnly"
    assert mobile_nodes[4922]["widgets_values"] == ["ltx/2.3/ltx-2.3-22b-distilled-lora-384-1.1.safetensors", 0.5]
    assert mobile_nodes[4828]["type"] == "CFGGuider"
    assert mobile_nodes[4828]["widgets_values"] == [1]
    assert mobile_nodes[5025]["type"] == "ManualSigmas"

    eros = next(item for item in registry["workflows"] if item["id"] == "ltx23-eros-ic-ingredients-lora")
    assert eros["inherits"] == workflow["id"]
    assert eros["native_mlx"]["variant"] == "eros-q8-dev-ic"
    assert eros["workflow_overrides"]["api_inputs"] == {
        "3940": {"ckpt_name": "ltx/10Eros_v1-fp8mixed_learned.safetensors"},
        "4010": {"ckpt_name": "ltx/10Eros_v1-fp8mixed_learned.safetensors"},
    }
    assert eros["workflow_overrides"]["editor_widgets"] == {
        "3940": ["ltx/10Eros_v1-fp8mixed_learned.safetensors"],
        "4010": ["ltx/10Eros_v1-fp8mixed_learned.safetensors"],
    }
    assert eros["model_dependencies"][0]["relativePath"] == "ltx/10Eros_v1-fp8mixed_learned.safetensors"


def test_ltx_ingredients_mcp_builds_prompt_contract_and_native_metadata(tmp_path):
    captures = []
    square_response = ""

    class BackendHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("content-length", "0")))
            if self.path == "/comfy/api/prompt":
                captures.append(json.loads(body))
                payload = json.dumps({"prompt_id": "ingredients-contract-test"}).encode()
                self.send_response(200)
            else:
                payload = json.dumps({"error": "not found"}).encode()
                self.send_response(404)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            payload = json.dumps({"error": "not found"}).encode()
            self.send_response(404)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    backend = ThreadingHTTPServer(("127.0.0.1", 0), BackendHandler)
    threading.Thread(target=backend.serve_forever, daemon=True).start()
    mcp_port = _free_port()
    comfy_input = tmp_path / "input"
    env = {
        **os.environ,
        "MEDIA_STUDIO_MCP_BACKEND_URL": f"http://127.0.0.1:{backend.server_port}",
        "MEDIA_STUDIO_MCP_STUDIO_URL": f"http://127.0.0.1:{backend.server_port}",
        "MEDIA_STUDIO_TOKEN_FILE": "/dev/null",
        "MEDIA_STUDIO_TOKEN": "test-token",
        "MEDIA_STUDIO_WORKFLOW_REGISTRY": str(ROOT / "packages" / "media-gateway" / "workflow-registry.json"),
        "COMFY_INPUT_DIR": str(comfy_input),
    }
    process = subprocess.Popen(
        ["node", str(MCP_SOURCE), "--http", "--host", "127.0.0.1", "--port", str(mcp_port)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    def image_data_url(color: str) -> str:
        buffer = io.BytesIO()
        Image.new("RGB", (600, 400), color).save(buffer, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")

    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError(process.stderr.read())
            try:
                with socket.create_connection(("127.0.0.1", mcp_port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise AssertionError("Media Studio MCP did not start")

        request = Request(
            f"http://127.0.0.1:{mcp_port}/mcp",
            data=json.dumps({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "media_generate_video",
                    "arguments": {
                        "workflow_id": "ingredients",
                        "prompt": "Character A crosses the location in one continuous shot.",
                        "image_base64": image_data_url("green"),
                        "ingredient_images": [
                            {
                                "image_base64": image_data_url("red"),
                                "description": "Character A front view with exact face and wardrobe.",
                            },
                            {
                                "image_base64": image_data_url("blue"),
                                "description": "Character A right profile with the same face and wardrobe.",
                            },
                        ],
                        "duration_seconds": 1,
                        "frame_rate": 24,
                        "wait": False,
                    },
                },
            }).encode(),
            headers={
                "authorization": "Bearer test-token",
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
            },
            method="POST",
        )
        with urlopen(request, timeout=10) as response:
            assert response.status == 200
            response.read()

        eros_request = Request(
            f"http://127.0.0.1:{mcp_port}/mcp",
            data=json.dumps({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "media_generate_video",
                    "arguments": {
                        "workflow_id": "eros-ingredients",
                        "prompt": "Character A crosses the location in one continuous shot.",
                        "ingredient_images": [{
                            "image_base64": image_data_url("red"),
                            "description": "Character A front view with exact face and wardrobe.",
                        }],
                        "duration_seconds": 1,
                        "frame_rate": 24,
                        "wait": False,
                    },
                },
            }).encode(),
            headers={
                "authorization": "Bearer test-token",
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
            },
            method="POST",
        )
        with urlopen(eros_request, timeout=10) as response:
            assert response.status == 200
            response.read()

        square_request = Request(
            f"http://127.0.0.1:{mcp_port}/mcp",
            data=json.dumps({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "media_generate_video",
                    "arguments": {
                        "workflow_id": "ingredients",
                        "prompt": "One full-frame shot using the references.",
                        "ingredient_images": [{"image_base64": image_data_url("red")}],
                        "width": 576,
                        "height": 576,
                        "wait": False,
                    },
                },
            }).encode(),
            headers={
                "authorization": "Bearer test-token",
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
            },
            method="POST",
        )
        with urlopen(square_request, timeout=10) as response:
            assert response.status == 200
            square_response = response.read().decode("utf-8")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        backend.shutdown()
        backend.server_close()

    assert len(captures) == 3
    assert '"isError":true' not in square_response
    assert "supports ${allowed.join(', ')} output; received ${width}x${height}" in MCP_SOURCE.read_text(encoding="utf-8")
    graph = captures[0]["prompt"]
    prompt = graph["2483"]["inputs"]["text"]
    assert prompt == (
        "### Reference Sheet Description\n"
        "left panel: Character A front view with exact face and wardrobe.\n"
        "right panel: Character A right profile with the same face and wardrobe.\n"
        "### Target Description\n"
        "Character A crosses the location in one continuous shot."
    )
    sheet_name = graph["2004"]["inputs"]["image"]
    assert sheet_name.startswith("mcp_ingredients_")
    with Image.open(comfy_input / sheet_name) as sheet:
        assert sheet.size == (768, 448)
        assert sheet.getpixel((198, 224)) == (255, 0, 0)
        assert sheet.getpixel((570, 224)) == (0, 0, 255)
        assert sheet.getpixel((384, 224)) == (0, 0, 0)
    assert graph["5072"]["inputs"]["value"] == 121
    assert graph["4828"]["inputs"]["cfg"] == 1.0
    reference_repeat = next(node for node in graph.values() if node.get("class_type") == "RepeatImageBatch")
    assert reference_repeat["inputs"]["amount"] == 121
    anchor = next(node for node in graph.values() if node.get("class_type") == "LTXVImgToVideoConditionOnly")
    anchor_id = next(key for key, node in graph.items() if node is anchor)
    prepared_start = graph[str(anchor["inputs"]["image"][0])]
    assert prepared_start["class_type"] == "ImageCompositeMasked"
    outpaint_prompt = next(
        node["inputs"]["prompt"]
        for node in graph.values()
        if node.get("class_type") == "Krea2IdentityOptionalEncode" and node.get("inputs", {}).get("prompt")
    )
    assert "Character A crosses the location" in outpaint_prompt
    assert "front view with exact face" not in outpaint_prompt
    assert "Reference Sheet Description" not in outpaint_prompt
    outpaint_pad = graph[str(prepared_start["inputs"]["source"][0])]
    assert outpaint_pad["class_type"] == "ImagePadForOutpaint"
    assert outpaint_pad["inputs"]["left"] == 48
    assert outpaint_pad["inputs"]["right"] == 48
    start_scale = graph[str(outpaint_pad["inputs"]["image"][0])]
    start_load = graph[str(start_scale["inputs"]["image"][0])]
    assert start_load["class_type"] == "HivemindOptionalLoadImage"
    assert start_load["inputs"]["image"] != sheet_name
    with Image.open(comfy_input / start_load["inputs"]["image"]) as staged_start:
        assert staged_start.size == (600, 400)
        assert staged_start.getpixel((300, 200)) == (0, 128, 0)
    assert not any(
        node.get("class_type") == "SaveImage"
        and str(node.get("inputs", {}).get("filename_prefix", "")).startswith("ltx_anchor")
        for node in graph.values()
    )
    assert anchor["inputs"]["latent"] == ["3059", 0]
    assert anchor["inputs"]["strength"] == 0.9
    assert anchor["inputs"]["bypass"] is False
    assert graph["5012"]["inputs"]["latent"] == [anchor_id, 0]
    assert graph["4528"]["inputs"]["video_latent"] == ["5012", 2]
    create_video = next(node for node in graph.values() if node.get("class_type") == "CreateVideo")
    assert create_video["inputs"]["images"] == ["5065", 0]
    metadata = captures[0]["extra_data"]["extra_pnginfo"]["workflow"]["extra"]["nativeMlxLtx"]
    assert captures[0]["extra_data"]["extra_pnginfo"]["nativeMlxLtx"] == metadata
    assert metadata["pipeline"] == "ic-lora"
    assert metadata["ingredientSheet"] == {
        "sourceCount": 2,
        "columns": 2,
        "rows": 1,
        "conditioningOnly": True,
    }
    assert metadata["keyframes"] == [{
        "image_path": start_load["inputs"]["image"],
        "frame": 0,
        "strength": 0.9,
        "role": "start",
    }]
    assert metadata["icLora"]["reference_image"] == graph["2004"]["inputs"]["image"]
    assert metadata["icLora"]["single_stage"] is True
    assert metadata["icLora"]["reference_min_frames"] == 121
    assert metadata["icLora"]["target_min_frames"] == 121
    assert metadata["variant"] == "regular-q8-dev-ic"
    assert metadata["icLora"]["dev_transformer"] == "transformer-dev.safetensors"
    assert metadata["icLora"]["guided_dev"] is False
    assert metadata["icLora"]["stage1_steps"] == 8
    assert metadata["icLora"]["cfg_scale"] == 1.0
    assert metadata["icLora"]["stg_scale"] == 0.0
    assert metadata["icLora"]["runtime_timeout_seconds"] == 2400
    assert metadata["icLora"]["distilled_lora"] == "ltx-2.3-22b-distilled-lora-384-1.1.safetensors"
    assert metadata["icLora"]["distilled_lora_strength"] == 0.5
    assert metadata["defaults"]["frames"] == 121
    assert metadata["loras"][0]["strength"] == 1.4

    eros_graph = captures[1]["prompt"]
    eros_checkpoint = "ltx/10Eros_v1-fp8mixed_learned.safetensors"
    assert eros_graph["3940"]["inputs"]["ckpt_name"] == eros_checkpoint
    assert eros_graph["4010"]["inputs"]["ckpt_name"] == eros_checkpoint
    eros_metadata = captures[1]["extra_data"]["extra_pnginfo"]["nativeMlxLtx"]
    assert eros_metadata["variant"] == "eros-q8-dev-ic"
    assert eros_metadata["pipeline"] == "ic-lora"
    assert eros_metadata["ingredientSheet"] == {
        "sourceCount": 1,
        "columns": 1,
        "rows": 1,
        "conditioningOnly": True,
    }
    assert eros_metadata["icLora"]["dev_transformer"] == "transformer-dev.safetensors"
    assert eros_metadata["icLora"]["distilled_lora"] == "ltx-2.3-22b-distilled-lora-384-1.1.safetensors"
    eros_mobile_nodes = {
        str(node["id"]): node
        for node in captures[1]["extra_data"]["extra_pnginfo"]["workflow"]["nodes"]
    }
    assert eros_mobile_nodes["3940"]["widgets_values"] == [eros_checkpoint]
    assert eros_mobile_nodes["4010"]["widgets_values"] == [eros_checkpoint]

    square_graph = captures[2]["prompt"]
    assert square_graph["809"]["inputs"]["value"] == 576
    assert square_graph["811"]["inputs"]["value"] == 576
    with Image.open(comfy_input / square_graph["2004"]["inputs"]["image"]) as square_sheet:
        assert square_sheet.size == (576, 576)


def test_ltx_eros_v14_comfy_registry_entry_matches_its_graph():
    """The rented-ready eros v1.4 Comfy variant: same files the GPU-rental
    video tier provisions, multi-target frames slot (video+audio latents)."""
    registry = json.loads(WORKFLOW_REGISTRY.read_text(encoding="utf-8"))
    workflow = next(
        item for item in _resolved_registry_workflows(registry) if item["id"] == "ltx23-eros-v14-comfy"
    )
    assert workflow["media_type"] == "video"
    assert workflow["builder"] == "comfy-api"
    # LTX frame lattice is 8k+1.
    assert workflow["frame_grid"] == {"modulus": 8, "offset": 1}

    graph_path = Path(workflow["api_workflow"])
    if not graph_path.is_absolute():
        graph_path = ROOT / "packages" / "media-gateway" / graph_path
    graph = json.loads(graph_path.read_text(encoding="utf-8"))["prompt"]

    def _assert_slot(name, slot):
        assert slot["node"] in graph, f"slot {name} targets missing node {slot['node']}"
        assert slot["input"] in graph[slot["node"]]["inputs"], (
            f"slot {name} targets missing input {slot['input']}"
        )

    for name, slot in workflow["slots"].items():
        for target in (slot if isinstance(slot, list) else [slot]):
            _assert_slot(name, target)

    # Frames fan out to BOTH latents — a single-target slot here silently
    # desyncs audio length from video length.
    frames = workflow["slots"]["frames"]
    assert isinstance(frames, list) and len(frames) == 2
    assert {(t["node"], t["input"]) for t in frames} == {("7", "length"), ("9", "frames_number")}

    # Rental-provisioning parity: every model file the graph references is in
    # the video tier's serving set (same basenames the box downloads from R2).
    from hivemind_content_studio import gpu_rentals
    tier_files = {key.rsplit("/", 1)[-1] for key, _ in gpu_rentals.TIERS["video"]["models"]}
    graph_files = {
        value for node in graph.values() for value in node["inputs"].values()
        if isinstance(value, str) and value.endswith(".safetensors")
    }
    assert graph_files <= tier_files, f"graph references files the video tier does not provision: {graph_files - tier_files}"

    # The DMD LoRA is mandatory for v1.4 anatomy — assert it sits on the MODEL
    # edge into the sampler.
    sampler_model = graph["13"]["inputs"]["model"][0]
    assert graph[sampler_model]["class_type"] == "LoraLoaderModelOnly"
    assert graph[sampler_model]["inputs"]["lora_name"] == "ltx2310eros_v14_dmd_lora.safetensors"
    assert graph[sampler_model]["inputs"]["strength_model"] == 1.0

    # The sampled audio has to reach the muxer. Paying for a joint AV sample
    # and then decoding only the picture half saves nothing and ships a silent
    # clip, which is exactly what this graph did until 2026-08-10 — the
    # separator's audio output was wired to nothing.
    audio_decode = graph["16"]["inputs"]["audio"][0]
    assert graph[audio_decode]["class_type"] == "LTXVAudioVAEDecode"
    audio_latent = graph[audio_decode]["inputs"]["samples"]
    assert audio_latent == ["14", 1], "audio decode must take LTXVSeparateAVLatent's audio output"
    assert graph[audio_latent[0]]["class_type"] == "LTXVSeparateAVLatent"
    # ...decoded by the AUDIO vae, not the picture one.
    audio_vae = graph[audio_decode]["inputs"]["audio_vae"][0]
    assert graph[audio_vae]["class_type"] == "LTXVAudioVAELoader"


@pytest.mark.parametrize("workflow_id", ["minimax-h3", "minimax-h3-turbo"])
@pytest.mark.parametrize("spectrum", [True, False])
def test_spectrum_toggle_reaches_the_graph(tmp_path, workflow_id, spectrum):
    """The user-facing Fast-sampling switch must actually disable the node.

    Verified by capturing the graph the MCP POSTs, not by timing: on a small
    clip the forecaster's saving is inside the noise, so a wall-clock check
    cannot tell a working toggle from a dropped one.
    """
    registry_src = json.loads(WORKFLOW_REGISTRY.read_text(encoding="utf-8"))
    workflows = _resolved_registry_workflows(registry_src)
    workflow = next(item for item in workflows if item["id"] == workflow_id)
    graph_path = ROOT / "packages" / "media-gateway" / workflow["api_workflow"]

    registry = tmp_path / "workflow-registry.json"
    entry = json.loads(json.dumps(workflow))
    entry["api_workflow"] = str(graph_path)
    registry.write_text(json.dumps({"workflows": [entry]}), encoding="utf-8")

    captures = []

    class BackendHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if "prompt" in body:
                captures.append(body["prompt"])
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"prompt_id": "p-1"}).encode())

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *_args):
            pass

    backend = ThreadingHTTPServer(("127.0.0.1", 0), BackendHandler)
    threading.Thread(target=backend.serve_forever, daemon=True).start()
    mcp_port = _free_port()
    env = {
        **os.environ,
        "MEDIA_STUDIO_MCP_BACKEND_URL": f"http://127.0.0.1:{backend.server_port}",
        "MEDIA_STUDIO_MCP_STUDIO_URL": f"http://127.0.0.1:{backend.server_port}",
        "MEDIA_STUDIO_TOKEN_FILE": "/dev/null",
        "MEDIA_STUDIO_TOKEN": "test-token",
        "MEDIA_STUDIO_MCP_MACHINE_PRIVATE": "0",
        "MEDIA_STUDIO_WORKFLOW_REGISTRY": str(registry),
        "COMFY_INPUT_DIR": str(tmp_path / "input"),
    }
    process = subprocess.Popen(
        ["node", str(MCP_SOURCE), "--http", "--host", "127.0.0.1", "--port", str(mcp_port)],
        cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError(process.stderr.read())
            try:
                with socket.create_connection(("127.0.0.1", mcp_port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)
        request = Request(
            f"http://127.0.0.1:{mcp_port}/mcp",
            data=json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "media_generate_video", "arguments": {
                    "workflow_id": workflow_id,
                    "prompt": "a lighthouse at night",
                    "spectrum": spectrum,
                    "wait": False,
                }},
            }).encode(),
            headers={"authorization": "Bearer test-token", "content-type": "application/json",
                     "accept": "application/json, text/event-stream"},
            method="POST",
        )
        with urlopen(request, timeout=20) as response:
            response.read()
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        backend.shutdown()
        backend.server_close()

    assert captures, "the MCP posted no graph"
    graph = captures[0]
    node = next(n for n in graph.values() if n["class_type"] == "SpectrumApplyMiniMaxH3")
    assert node["inputs"]["enabled"] is spectrum


def _model_chain(graph):
    """Class names along the MODEL edge feeding the scheduler, sampler-first."""
    chain = []
    node = graph["9"]["inputs"]["model"][0]
    while True:
        chain.append(graph[node]["class_type"])
        upstream = graph[node]["inputs"].get("model")
        if not isinstance(upstream, list):
            return chain
        node = upstream[0]


def _capture_video_graph(tmp_path, workflow_id, arguments, *, expect_refusal=False, return_body=False,
                         with_reply=False, extra_workflow_ids=()):
    """Run the real MCP against a capture backend and return the posted graph.

    The MCP is a separate node process with its own registry loading, staging
    and pruning; only a real submission proves what a workflow actually sends.
    The temp registry holds only `workflow_id` unless `extra_workflow_ids`
    names siblings it should be able to route to; `with_reply` also returns
    the raw JSON-RPC reply so a test can read the tool's own result.
    """
    registry_src = json.loads(WORKFLOW_REGISTRY.read_text(encoding="utf-8"))
    resolved = _resolved_registry_workflows(registry_src)
    entries = []
    for wanted in (workflow_id, *extra_workflow_ids):
        workflow = next(item for item in resolved if item["id"] == wanted)
        entry = json.loads(json.dumps(workflow))
        entry["api_workflow"] = str(ROOT / "packages" / "media-gateway" / workflow["api_workflow"])
        entries.append(entry)
    registry = tmp_path / "workflow-registry.json"
    registry.write_text(json.dumps({"workflows": entries}), encoding="utf-8")

    captures = []

    class BackendHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if "prompt" in body:
                captures.append(body)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"prompt_id": "p-1"}).encode())

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *_args):
            pass

    backend = ThreadingHTTPServer(("127.0.0.1", 0), BackendHandler)
    threading.Thread(target=backend.serve_forever, daemon=True).start()
    mcp_port = _free_port()
    env = {
        **os.environ,
        "MEDIA_STUDIO_MCP_BACKEND_URL": f"http://127.0.0.1:{backend.server_port}",
        "MEDIA_STUDIO_MCP_STUDIO_URL": f"http://127.0.0.1:{backend.server_port}",
        "MEDIA_STUDIO_TOKEN_FILE": "/dev/null",
        "MEDIA_STUDIO_TOKEN": "test-token",
        "MEDIA_STUDIO_MCP_MACHINE_PRIVATE": "0",
        "MEDIA_STUDIO_WORKFLOW_REGISTRY": str(registry),
        "COMFY_INPUT_DIR": str(tmp_path / "input"),
    }
    process = subprocess.Popen(
        ["node", str(MCP_SOURCE), "--http", "--host", "127.0.0.1", "--port", str(mcp_port)],
        cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError(process.stderr.read())
            try:
                with socket.create_connection(("127.0.0.1", mcp_port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)
        request = Request(
            f"http://127.0.0.1:{mcp_port}/mcp",
            data=json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "media_generate_video",
                           "arguments": {"workflow_id": workflow_id, "wait": False, **arguments}},
            }).encode(),
            headers={"authorization": "Bearer test-token", "content-type": "application/json",
                     "accept": "application/json, text/event-stream"},
            method="POST",
        )
        with urlopen(request, timeout=25) as response:
            reply = response.read().decode("utf-8", "replace")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        backend.shutdown()
        backend.server_close()
    if expect_refusal:
        # The MCP's own error text, so a refusal is distinguishable from the
        # harness simply never seeing a graph.
        assert not captures, "the MCP submitted a graph it should have refused"
        return reply
    assert captures, "the MCP posted no graph"
    result = captures[0] if return_body else captures[0]["prompt"]
    return (result, reply) if with_reply else result


def _mcp_tool_result(reply: str) -> dict:
    """The tool's structured result out of a JSON-RPC reply, plain JSON or SSE-framed."""
    text = reply.strip()
    if not text.startswith("{"):
        text = next(line[len("data:"):].strip() for line in text.splitlines() if line.startswith("data:"))
    result = json.loads(text)["result"]
    return result.get("structuredContent") or json.loads(result["content"][0]["text"])


def test_video_mcp_submission_preserves_the_app_tab_lane(tmp_path):
    body = _capture_video_graph(
        tmp_path,
        "ltx23-regular-fp8",
        {
            "prompt": "slow camera move",
            "studio_lane": "video:window-a:4",
        },
        return_body=True,
    )

    assert body["extra_data"]["extra_pnginfo"]["studioLane"] == "video:window-a:4"


# A 1x1 PNG: enough for staging, nothing to decode.
_TINY_PNG = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8"
    "z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

# Eight samples of 16 kHz mono silence with a full RIFF/WAVE header: enough for
# the MCP's magic-byte sniff to stage it as .wav, nothing to decode.
_TINY_WAV = (
    "data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YRAAAAAA"
    "AAAAAAAAAAAAAAAAAAAA"
)


@pytest.mark.parametrize("start,end,expect_first,expect_last", [
    (False, False, False, False),   # T2VA
    (True, False, True, False),     # I2VA
    (True, True, True, True),       # FL2VA
    (False, True, False, True),     # L2VA
])
def test_minimax_h3_maps_all_four_frame_modes(tmp_path, start, end, expect_first, expect_last):
    """The checkpoint we serve is the fl2va (first-AND-last) build and
    MiniMaxH3ImageToVideo takes an optional last_frame, so all four documented
    modes are one graph input apart. An unused loader must be PRUNED, not left
    with an empty filename: a real Comfy lane rejects that at submit.
    """
    arguments = {"prompt": "a courier waits on a platform"}
    if start:
        arguments["image_base64"] = _TINY_PNG
    if end:
        arguments["end_image_base64"] = _TINY_PNG

    graph = _capture_video_graph(tmp_path, "minimax-h3", arguments)

    node = next(n for n in graph.values() if n["class_type"] == "MiniMaxH3ImageToVideo")
    assert ("first_frame" in node["inputs"]) is expect_first
    assert ("last_frame" in node["inputs"]) is expect_last
    loaders = [n for n in graph.values() if n["class_type"] == "LoadImage"]
    assert len(loaders) == int(expect_first) + int(expect_last)
    assert all(n["inputs"]["image"] for n in loaders), "a staged loader must carry a filename"


def test_video_workflows_roll_a_fresh_seed_when_the_caller_omits_one(tmp_path):
    """An omitted seed must vary per submission, and -1 must mean the same.

    Every video workflow used to default to a literal 42, so an agent calling
    media_generate_video without a seed got one clip forever. On a remote lane
    it also tripped ComfyUI's result cache, which returns a path the privacy
    sweeper has already deleted — the bare `HTTP Error 404` seen 2026-08-09.
    The Video Studio rolls its own seed client-side, so only agent callers
    ever saw it.
    """
    def seed_of(arguments):
        graph = _capture_video_graph(tmp_path, "minimax-h3", arguments)
        return graph["15"]["inputs"]["noise_seed"]

    omitted = [seed_of({"prompt": "a kite over a harbour"}) for _ in range(3)]
    assert all(isinstance(value, int) and value >= 0 for value in omitted)
    assert len(set(omitted)) > 1, f"omitted seed did not vary across runs: {omitted}"

    explicit_random = [seed_of({"prompt": "a kite over a harbour", "seed": -1}) for _ in range(3)]
    assert all(value >= 0 for value in explicit_random), "-1 must resolve, never reach the graph"
    assert len(set(explicit_random)) > 1, f"-1 did not roll a fresh seed: {explicit_random}"

    # A caller who names a seed still gets exactly that seed.
    assert seed_of({"prompt": "a kite over a harbour", "seed": 4242}) == 4242


def test_minimax_h3_reference_mode_fills_slots_in_order_and_prunes_the_rest(tmp_path):
    """Reference mode conditions through MiniMaxH3ReferenceToVideo's AUTOGROW
    inputs, which serialise as ref_images.ref_image_N. Order is load-bearing:
    the prompt names them <Picture 1>..<Picture N> by the same index, and an
    unfilled slot must take its autogrow key with it when pruned.
    """
    graph = _capture_video_graph(tmp_path, "minimax-h3-reference", {
        "prompt": "a courier in the style of these references",
        "reference_images": [{"image_base64": _TINY_PNG}, {"image_base64": _TINY_PNG}],
    })

    node = next(n for n in graph.values() if n["class_type"] == "MiniMaxH3ReferenceToVideo")
    keys = sorted(k for k in node["inputs"] if k.startswith("ref_images."))
    assert keys == ["ref_images.ref_image_0", "ref_images.ref_image_1"]
    # Combo, not a pixel size — an int here fails validation at submit.
    assert node["inputs"]["ref_image_size"] == "match"
    # Reference mode renders audio too, so the audio VAE has to be wired.
    assert isinstance(node["inputs"]["audio_vae"], list)
    loaders = [n for n in graph.values() if n["class_type"] == "LoadImage"]
    assert len(loaders) == 2, "the seven unused reference loaders must be pruned"
    assert all(n["inputs"]["image"] for n in loaders)


def test_reference_mode_refuses_a_request_with_no_references(tmp_path):
    """Every reference loader pruned would leave the node with nothing to
    condition on — a graph that only fails once it reaches the GPU."""
    reply = _capture_video_graph(
        tmp_path, "minimax-h3-reference", {"prompt": "no references at all"}, expect_refusal=True)
    assert "requires at least one reference picture or reference video" in reply


def test_references_on_a_workflow_with_no_reference_sibling_are_refused(tmp_path):
    """reference_* on a workflow with no reference slots used to be dropped on
    the floor — the staging passes are slot-gated — so the call rendered plain
    text-to-video with no error and no hint. A family with no reference
    workflow cannot honour them at all, so it refuses by name: the workflow,
    and the argument it would have dropped."""
    registry = json.loads(WORKFLOW_REGISTRY.read_text(encoding="utf-8"))
    ltx = next(item for item in _resolved_registry_workflows(registry) if item["id"] == "ltx23-regular-fp8")
    assert not any(
        item.get("reference_image_slots") or item.get("reference_video_slots") or item.get("reference_audio_slots")
        for item in _resolved_registry_workflows(registry) if item.get("family") == ltx["family"]
    ), "this test wants a family with NO reference lane; pick another workflow"

    reply = _capture_video_graph(
        tmp_path, "ltx23-regular-fp8",
        {"prompt": "a kite over a harbour", "reference_images": [{"image_base64": _TINY_PNG}]},
        expect_refusal=True)
    assert "workflow ltx23-regular-fp8 takes no reference_images" in reply
    assert "reference_slots" in reply, "the refusal must point at how to find a reference-capable workflow"


def test_reference_mode_refuses_more_references_than_it_has_slots(tmp_path):
    reply = _capture_video_graph(
        tmp_path, "minimax-h3-reference",
        {"prompt": "x", "reference_images": [{"image_base64": _TINY_PNG}] * 10},
        expect_refusal=True)
    assert "at most 9 reference images" in reply or "Too big" in reply or "max" in reply


def test_minimax_h3_reference_audio_fills_slots_in_order_and_prunes_the_rest(tmp_path):
    """Voice cloning: standalone reference audio rides the same autogrow
    contract as pictures — LoadAudio into ref_audios.ref_audio_N, clip N is the
    prompt's <Audio N> (numbered independently of <Picture N>) — and an
    unfilled audio slot must take its key and loader with it when pruned: a
    real Comfy lane rejects an empty LoadAudio filename at submit.
    """
    graph = _capture_video_graph(tmp_path, "minimax-h3-reference", {
        "prompt": "she speaks new lines in the referenced voice",
        "reference_images": [{"image_base64": _TINY_PNG}],
        "reference_audios": [{"audio_base64": _TINY_WAV}, {"audio_base64": _TINY_WAV}],
    })

    node = next(n for n in graph.values() if n["class_type"] == "MiniMaxH3ReferenceToVideo")
    audio_keys = sorted(k for k in node["inputs"] if k.startswith("ref_audios."))
    assert audio_keys == ["ref_audios.ref_audio_0", "ref_audios.ref_audio_1"]
    loaders = [n for n in graph.values() if n["class_type"] == "LoadAudio"]
    assert len(loaders) == 2, "the unused reference audio loader must be pruned"
    assert all(n["inputs"]["audio"].endswith(".wav") for n in loaders), \
        "staged reference audio must carry a real filename with its sniffed extension"
    # Pictures are untouched by the audio pass.
    assert [k for k in node["inputs"] if k.startswith("ref_images.")] == ["ref_images.ref_image_0"]


def test_reference_audio_cannot_be_the_sole_reference(tmp_path):
    """The model card is explicit: audio must accompany an image or video
    reference and can never be the only conditioning. Without the guard this
    only fails once the graph reaches the GPU."""
    reply = _capture_video_graph(
        tmp_path, "minimax-h3-reference",
        {"prompt": "voice only", "reference_audios": [{"audio_base64": _TINY_WAV}]},
        expect_refusal=True)
    assert "cannot take reference audio alone" in reply


def test_easycache_is_absent_from_the_graph_unless_it_is_asked_for(tmp_path):
    """EasyCache reuses transformer steps whose latent barely moved. At a 0
    threshold nothing ever qualifies, but the wrapper still does per-step
    subsampling bookkeeping — so off has to mean LIFTED OUT, with the sampler
    reconnected to whatever fed it, not left in the chain doing nothing."""
    graph = _capture_video_graph(tmp_path, "minimax-h3", {"prompt": "a kite over a harbour"})

    assert not [n for n in graph.values() if n["class_type"] == "EasyCache"]
    # The model chain closes back up: sampler and scheduler read the Spectrum node.
    spectrum_id = next(k for k, v in graph.items() if v["class_type"] == "SpectrumApplyMiniMaxH3")
    assert graph["9"]["inputs"]["model"] == [spectrum_id, 0]
    assert graph["16"]["inputs"]["model"] == [spectrum_id, 0]


def test_easycache_threshold_wires_the_node_between_spectrum_and_the_sampler(tmp_path):
    graph = _capture_video_graph(tmp_path, "minimax-h3", {
        "prompt": "a kite over a harbour",
        # Choosing the cache means turning the forecaster off — the two refuse
        # to run together, so the caller has to say which one it wants.
        "spectrum": False,
        "params": {"easycache": 0.25},
    })

    cache_id = next(k for k, v in graph.items() if v["class_type"] == "EasyCache")
    cache = graph[cache_id]
    assert cache["inputs"]["reuse_threshold"] == 0.25
    # Applied LAST, outermost of the model wrappers: loader -> sage -> spectrum -> cache.
    spectrum_id = next(k for k, v in graph.items() if v["class_type"] == "SpectrumApplyMiniMaxH3")
    assert cache["inputs"]["model"] == [spectrum_id, 0]
    assert graph["9"]["inputs"]["model"] == [cache_id, 0]
    assert graph["16"]["inputs"]["model"] == [cache_id, 0]


def test_frame_interpolation_is_absent_unless_asked_for(tmp_path):
    graph = _capture_video_graph(tmp_path, "minimax-h3", {"prompt": "a kite over a harbour"})

    assert not [n for n in graph.values() if n["class_type"] == "FrameInterpolate"]
    # The model loader goes with it — it existed only to feed the pruned node.
    assert not [n for n in graph.values() if n["class_type"] == "FrameInterpolationModelLoader"]
    assert graph["91"]["inputs"]["images"] == ["10", 0], "the muxer reads the decode directly"
    assert graph["91"]["inputs"]["fps"] == 24


def test_frame_interpolation_raises_the_mux_rate_but_not_the_sampled_frame_count(tmp_path):
    """Interpolation invents frames AFTER the decode. Folding its multiplier
    into the frame rate any earlier makes the frame-count maths sample the
    longer grid — a 5s request generated 243 frames, ten seconds of content,
    before RIFE had run at all."""
    plain = _capture_video_graph(tmp_path, "minimax-h3", {
        "prompt": "a kite over a harbour", "duration_seconds": 5})
    interpolated = _capture_video_graph(tmp_path, "minimax-h3", {
        "prompt": "a kite over a harbour", "duration_seconds": 5, "params": {"interpolate": 2}})

    assert interpolated["104"]["inputs"]["length"] == plain["104"]["inputs"]["length"]
    assert interpolated["91"]["inputs"]["fps"] == 48
    interp = next(n for n in interpolated.values() if n["class_type"] == "FrameInterpolate")
    assert interp["inputs"]["multiplier"] == 2
    assert interp["inputs"]["images"] == ["10", 0]
    assert interpolated["91"]["inputs"]["images"][1] == 0


def test_solattn_is_opt_in_and_lifts_out_of_the_default_graph(tmp_path):
    """Sol-Attn is an OPT-IN accelerator, not the default path.

    It was made the default on 2026-08-11 on the strength of 34.3s against
    38.6s for Spectrum alone — measured at 5s @ 960x544. Two things broke that
    (2026-08-12), both of which the default hid until a fresh box hit them:

    - Its node was pinned into the standalone provisioning script but never
      into the rental onstart, so EVERY freshly rented H3 box rejected EVERY
      job with "Node 'Sol-Attn (tau 0 = off)' not found" — acceleration or not,
      because ComfyUI validates the whole prompt. The onstart installs it now.
    - Its workspace scales with sequence length. At 8s/16:9 the sparse forward
      asked for a single 14.54 GiB allocation and OOM'd a 31 GiB card, inside
      _morton_h3.py. The measurement that justified the default never covered
      the durations the studio offers.

    So the default is what the workflow's own description always claimed: the
    accelerators are off, and the default path is unchanged. Opting in still
    works for anyone who wants the 11% on a short clip."""
    plain = _capture_video_graph(tmp_path, "minimax-h3", {"prompt": "a kite over a harbour"})
    assert not [n for n in plain.values() if n["class_type"] == "SolAttnPatch"]

    sparse = _capture_video_graph(tmp_path, "minimax-h3", {
        "prompt": "a kite over a harbour", "params": {"solattn_tau": 1.3}})
    node = next(n for n in sparse.values() if n["class_type"] == "SolAttnPatch")
    assert node["inputs"]["tau"] == 1.3
    # The model chain closes back up around it.
    sage_id = next(k for k, v in plain.items() if v["class_type"] == "PathchSageAttentionKJ")
    spectrum = next(v for v in plain.values() if v["class_type"] == "SpectrumApplyMiniMaxH3")
    assert spectrum["inputs"]["model"] == [sage_id, 0]
    # Applied after sage attention, which stays as the dense fallback backend.
    assert node["inputs"]["model"] == ["31", 0]
    # H3 packs its conditioning as extra attention rows; those stay exact or
    # sparsification eats the cloned voice and the reference identity.
    assert node["inputs"]["sink_conditioning"] == "exact_kv_and_rows"


def test_easycache_and_spectrum_cannot_both_be_asked_for(tmp_path):
    """Measured: the Spectrum node disables itself whenever a cache wrapper
    patches the same model, so the pair silently runs as easycache alone."""
    reply = _capture_video_graph(
        tmp_path, "minimax-h3",
        {"prompt": "x", "spectrum": True, "params": {"easycache": 0.3}},
        expect_refusal=True)
    assert "cannot both be on" in reply


def _write_test_video(path, *, seconds=3, fps=30, with_audio=False, size="320x240"):
    """A real, decodable clip — the reference-video path re-encodes through
    ffmpeg, so a fake byte blob proves nothing."""
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg is required to build a reference-video fixture")
    command = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc=size={size}:rate={fps}:duration={seconds}",
    ]
    if with_audio:
        command += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:a", "aac", "-shortest"]
    else:
        command += ["-an"]
    command += ["-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)]
    subprocess.run(command, check=True)
    return path


def _probe(path, stream, entries):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", stream, "-show_entries", entries,
         "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    )
    return result.stdout.strip()


def test_minimax_h3_reference_video_wires_frames_and_resamples_to_24fps(tmp_path):
    """A reference video is a MOTION reference: its frames ride ref_videos.
    ref_video_N through core LoadVideo -> GetVideoComponents. The node reads
    those frames AS 24 fps without asking how fast they were shot, so a 30 fps
    source must be resampled on the way in or every gesture plays 25% slow.
    """
    source = _write_test_video(tmp_path / "motion.mp4", seconds=3, fps=30)
    graph = _capture_video_graph(tmp_path, "minimax-h3-reference", {
        "prompt": "she moves with the manner of the reference",
        "reference_images": [{"image_base64": _TINY_PNG}],
        "reference_videos": [{"video_path": str(source)}],
    })

    node = next(n for n in graph.values() if n["class_type"] == "MiniMaxH3ReferenceToVideo")
    assert [k for k in node["inputs"] if k.startswith("ref_videos.")] == ["ref_videos.ref_video_0"]
    # No use_audio, so the clip's own soundtrack must not claim an <Audio N>.
    assert [k for k in node["inputs"] if k.startswith("ref_video_audios.")] == []
    loaders = [n for n in graph.values() if n["class_type"] == "LoadVideo"]
    components = [n for n in graph.values() if n["class_type"] == "GetVideoComponents"]
    assert len(loaders) == 1, "the two unused reference video loaders must be pruned"
    assert len(components) == 1, "pruning a video loader must take its components node with it"

    staged = tmp_path / "input" / loaders[0]["inputs"]["file"]
    assert staged.is_file(), "the reference video must be staged into the Comfy input dir"
    assert _probe(staged, "v:0", "stream=r_frame_rate") == "24/1"
    assert _probe(staged, "a:0", "stream=index") == "", "audio must be stripped when use_audio is off"


# MiniMaxH3ReferenceToVideo.adapt_canvas puts every reference video on a
# 768-short-edge canvas capped at 768*1344 px, and never upscales. Both ways of
# missing that budget cost something, which is why the cap is that number and
# not a round one.
REF_VIDEO_MAX_PIXELS = 768 * 1344


@pytest.mark.parametrize("size,label", [
    ("3840x2160", "landscape 4K"),
    ("1080x2346", "portrait phone footage"),
    ("1080x1920", "portrait 1080p"),
])
def test_reference_video_is_capped_to_the_nodes_own_frame_budget(tmp_path, size, label):
    """Oversized references are downscaled to the budget the node works to.

    The previous rule capped WIDTH at 1280 while its comment claimed a long
    edge: it fired on landscape 4K and did nothing at all for portrait phone
    footage, where the width is already under 1280 — so the lane encoded and
    shipped frames the node immediately threw away.
    """
    source = _write_test_video(tmp_path / "big.mp4", seconds=3, fps=30, size=size)
    graph = _capture_video_graph(tmp_path, "minimax-h3-reference", {
        "prompt": "she moves with the manner of the reference",
        "reference_images": [{"image_base64": _TINY_PNG}],
        "reference_videos": [{"video_path": str(source)}],
    })
    loader = next(n for n in graph.values() if n["class_type"] == "LoadVideo")
    staged = tmp_path / "input" / loader["inputs"]["file"]
    width = int(_probe(staged, "v:0", "stream=width"))
    height = int(_probe(staged, "v:0", "stream=height"))

    assert width * height <= REF_VIDEO_MAX_PIXELS * 1.01, (
        f"{label} stayed above the node's frame budget at {width}x{height}"
    )
    source_w, source_h = (int(v) for v in size.split("x"))
    assert abs((width / height) - (source_w / source_h)) < 0.02, "aspect must be preserved"
    # Both axes even: yuv420p cannot encode an odd dimension.
    assert width % 2 == 0 and height % 2 == 0


def test_a_small_reference_video_is_never_upscaled(tmp_path):
    """The node keeps OUR frames rather than upscaling to its canvas, so
    inflating a small clip here would only cost bytes — and pre-scaling one
    below the canvas would permanently coarsen the reference."""
    source = _write_test_video(tmp_path / "small.mp4", seconds=3, fps=30, size="640x480")
    graph = _capture_video_graph(tmp_path, "minimax-h3-reference", {
        "prompt": "she moves with the manner of the reference",
        "reference_images": [{"image_base64": _TINY_PNG}],
        "reference_videos": [{"video_path": str(source)}],
    })
    loader = next(n for n in graph.values() if n["class_type"] == "LoadVideo")
    staged = tmp_path / "input" / loader["inputs"]["file"]
    assert int(_probe(staged, "v:0", "stream=width")) == 640
    assert int(_probe(staged, "v:0", "stream=height")) == 480


def test_reference_video_soundtrack_claims_an_audio_label_before_its_video(tmp_path):
    """use_audio conditions on the clip's own soundtrack, which the node labels
    <Audio N> BEFORE its <Video N> — so a standalone voice clip alongside it
    becomes <Audio 2>, not <Audio 1>."""
    source = _write_test_video(tmp_path / "spoken.mp4", seconds=3, fps=24, with_audio=True)
    graph = _capture_video_graph(tmp_path, "minimax-h3-reference", {
        "prompt": "the reference performance drives her delivery",
        "reference_images": [{"image_base64": _TINY_PNG}],
        "reference_videos": [{"video_path": str(source), "use_audio": True}],
        "reference_audios": [{"audio_base64": _TINY_WAV}],
    })

    node = next(n for n in graph.values() if n["class_type"] == "MiniMaxH3ReferenceToVideo")
    assert [k for k in node["inputs"] if k.startswith("ref_video_audios.")] == \
        ["ref_video_audios.ref_video_audio_0"]
    components = next(n for n in graph.values() if n["class_type"] == "GetVideoComponents")
    component_id = next(k for k, v in graph.items() if v is components)
    # frames from output 0, soundtrack from output 1 of the SAME components node.
    assert node["inputs"]["ref_videos.ref_video_0"] == [component_id, 0]
    assert node["inputs"]["ref_video_audios.ref_video_audio_0"] == [component_id, 1]
    staged = tmp_path / "input" / next(
        n for n in graph.values() if n["class_type"] == "LoadVideo")["inputs"]["file"]
    assert _probe(staged, "a:0", "stream=index") != "", "use_audio must keep the soundtrack"


def test_reference_video_alone_is_a_valid_reference(tmp_path):
    """A motion reference with no picture is legitimate conditioning — only
    AUDIO is barred from being the sole reference."""
    source = _write_test_video(tmp_path / "solo.mp4", seconds=3, fps=24)
    graph = _capture_video_graph(tmp_path, "minimax-h3-reference", {
        "prompt": "a dancer moving like the reference",
        "reference_videos": [{"video_path": str(source)}],
    })

    node = next(n for n in graph.values() if n["class_type"] == "MiniMaxH3ReferenceToVideo")
    assert [k for k in node["inputs"] if k.startswith("ref_videos.")] == ["ref_videos.ref_video_0"]
    assert [k for k in node["inputs"] if k.startswith("ref_images.")] == []
    assert not [n for n in graph.values() if n["class_type"] == "LoadImage"]


def test_references_on_the_plain_h3_tier_route_to_its_reference_sibling(tmp_path):
    """minimax-h3 has no reference slots — only minimax-h3-reference (inherits
    it, routing_only) does — and the studio routes between them client-side.
    An agent sending reference_* straight to minimax-h3 used to get plain
    text-to-video with no error and no hint: on a rented lane (2026-08-21) a
    reseeded resubmission still served the reference node from ComfyUI's cache,
    proving no loader was in its ancestry, and several probes were read against
    the wrong graph. The MCP now routes the way the studio does, compiles the
    reference loaders, and the result names both the graph that ran and the
    workflow the call came from."""
    source = _write_test_video(tmp_path / "manner.mp4", seconds=3, fps=24)
    graph, reply = _capture_video_graph(tmp_path, "minimax-h3", {
        "prompt": "a courier who moves in the manner of the reference",
        "reference_images": [{"image_base64": _TINY_PNG}, {"image_base64": _TINY_PNG}],
        "reference_videos": [{"video_path": str(source)}],
    }, extra_workflow_ids=("minimax-h3-reference",), with_reply=True)

    node = next(n for n in graph.values() if n["class_type"] == "MiniMaxH3ReferenceToVideo")
    assert sorted(k for k in node["inputs"] if k.startswith("ref_images.")) == \
        ["ref_images.ref_image_0", "ref_images.ref_image_1"]
    assert [k for k in node["inputs"] if k.startswith("ref_videos.")] == ["ref_videos.ref_video_0"]
    assert len([n for n in graph.values() if n["class_type"] == "LoadImage"]) == 2
    assert len([n for n in graph.values() if n["class_type"] == "LoadVideo"]) == 1
    assert not [n for n in graph.values() if n["class_type"] == "MiniMaxH3ImageToVideo"], \
        "the plain text/image-to-video graph must not be what ran"
    workflow = _mcp_tool_result(reply)["workflow"]
    assert workflow["id"] == "minimax-h3-reference"
    assert workflow["routed_from"] == "minimax-h3"
    assert workflow["routed_for"] == ["reference_images", "reference_videos"]
    # Reached by routing only: the reference tier stays out of the picker.
    assert workflow["routing_only"] is True

    # No references (an empty list counts as none): the plain tier is itself,
    # untouched by the sibling sitting in the registry.
    graph, reply = _capture_video_graph(tmp_path, "minimax-h3", {
        "prompt": "a courier waits on a platform",
        "reference_images": [],
    }, extra_workflow_ids=("minimax-h3-reference",), with_reply=True)
    assert next(n for n in graph.values() if n["class_type"] == "MiniMaxH3ImageToVideo")
    assert not [n for n in graph.values() if n["class_type"] == "MiniMaxH3ReferenceToVideo"]
    workflow = _mcp_tool_result(reply)["workflow"]
    assert workflow["id"] == "minimax-h3"
    assert "routed_from" not in workflow


def test_reference_video_refuses_a_clip_shorter_than_the_model_card_allows(tmp_path):
    source = _write_test_video(tmp_path / "blink.mp4", seconds=1, fps=24)
    reply = _capture_video_graph(
        tmp_path, "minimax-h3-reference",
        {"prompt": "x", "reference_videos": [{"video_path": str(source)}]},
        expect_refusal=True)
    assert "at least 2 seconds" in reply


def test_a_long_clip_with_a_motion_reference_is_refused_before_it_is_staged(tmp_path):
    """The node trims a reference to min(its own length, the clip's length), so
    the budget is spent on that EFFECTIVE length rather than on the clip's.

    Re-measured 2026-08-15 on a rented 5090 (32607MiB) under ComfyUI 0.32.0 with
    the cudaMallocAsync allocator, H3 reference mode at 704x1216 with nine
    pictures and a voice clip: 48, 96, 158 and 243 effective reference frames all
    ran (27.88-30.06GiB); 305 ran out of memory. The failure used to arrive three
    minutes in as a CUDA allocator dump, and the first version of this guard
    over-corrected by capping the CLIP whenever any reference was attached."""
    # A SHORT reference keeps its own length, so it costs only that and leaves
    # the whole duration range open. This 3s clip against a 15s render is the
    # case the first version of this guard refused outright.
    short = _write_test_video(tmp_path / "motion-short.mp4", seconds=3, fps=24)
    _capture_video_graph(
        tmp_path, "minimax-h3-reference",
        {"prompt": "x", "duration_seconds": 15, "width": 1216, "height": 704,
         "reference_videos": [{"video_path": str(short), "duration_seconds": 3}]})

    # A reference at or beyond the clip's length is trimmed down to it, so the
    # CLIP becomes the thing that has to fit — and 15s does not.
    long_clip = _write_test_video(tmp_path / "motion-long.mp4", seconds=15, fps=24)
    reply = _capture_video_graph(
        tmp_path, "minimax-h3-reference",
        {"prompt": "x", "duration_seconds": 15, "width": 1216, "height": 704,
         "reference_videos": [{"video_path": str(long_clip), "duration_seconds": 15}]},
        expect_refusal=True)
    assert "does not fit" in reply
    # The refusal has to name the length that DOES fit, not merely say no — and
    # name the shorter-reference lever, which is the one that keeps the range.
    assert "243" in reply and "10.1s" in reply
    assert "reference video of 10.1s or less" in reply


def test_the_same_long_clip_is_allowed_without_a_motion_reference(tmp_path):
    """The cap is on reference VIDEO, not on duration: nine pictures cost a flat
    amount however long the clip is, so the full range stays available."""
    graph = _capture_video_graph(tmp_path, "minimax-h3-reference", {
        "prompt": "x", "duration_seconds": 15, "width": 1216, "height": 704,
        "reference_images": [{"image_base64": _TINY_PNG}],
    })
    node = next(n for n in graph.values() if n["class_type"] == "MiniMaxH3ReferenceToVideo")
    assert node["inputs"]["length"] == 362, "15s on the 17k+5 grid"


def test_reference_video_refuses_more_clips_than_it_has_slots(tmp_path):
    source = _write_test_video(tmp_path / "many.mp4", seconds=3, fps=24)
    reply = _capture_video_graph(
        tmp_path, "minimax-h3-reference",
        {"prompt": "x", "reference_videos": [{"video_path": str(source)}] * 4},
        expect_refusal=True)
    assert "at most 3 reference videos" in reply or "Too big" in reply or "max" in reply


def test_reference_audio_refuses_more_clips_than_it_has_slots(tmp_path):
    reply = _capture_video_graph(
        tmp_path, "minimax-h3-reference",
        {"prompt": "x",
         "reference_images": [{"image_base64": _TINY_PNG}],
         "reference_audios": [{"audio_base64": _TINY_WAV}] * 4},
        expect_refusal=True)
    assert "at most 3 reference audio clips" in reply or "Too big" in reply or "max" in reply


def _tiny_video_data_url(tmp_path, *, with_audio=True, size="96x64", frames=30):
    path = tmp_path / f"context-{'voiced' if with_audio else 'mute'}.mp4"
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c=gray:s={size}:r=24",
    ]
    if with_audio:
        # 32 kHz on purpose: that is the rate H3 itself emits.
        cmd += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=32000"]
    cmd += ["-frames:v", str(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p"]
    cmd += ["-c:a", "aac", "-shortest"] if with_audio else ["-an"]
    cmd += [str(path)]
    subprocess.run(cmd, check=True)
    return "data:video/mp4;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


@pytest.mark.parametrize("workflow_id", ["minimax-h3", "minimax-h3-turbo"])
def test_minimax_h3_motion_context_grafts_chain_nodes(tmp_path, workflow_id):
    """Scene chaining: the previous clip's tail frames AND audio must reach the
    MiniMaxH3MotionContext node, the guider must consume the context-modified
    conditioning, the trim node must remove the re-rendered context head before
    mux, Spectrum must be forced off (it mispredicts the pinned rows), and the
    canvas must match the context clip (a latent cannot be resized)."""
    graph = _capture_video_graph(tmp_path, workflow_id, {
        "prompt": "the scene continues from the previous shot",
        "motion_context_base64": _tiny_video_data_url(tmp_path),
        "duration_seconds": 5,
    })

    load = next((k, n) for k, n in graph.items() if n["class_type"] == "LoadVideo")
    comps = next((k, n) for k, n in graph.items() if n["class_type"] == "GetVideoComponents")
    context = next((k, n) for k, n in graph.items() if n["class_type"] == "MiniMaxH3MotionContext")
    trim = next((k, n) for k, n in graph.items() if n["class_type"] == "MiniMaxH3MotionContextTrim")
    create = next(n for n in graph.values() if n["class_type"] == "CreateVideo")

    # Staged clip lands in the Comfy input dir under the private prefix, so the
    # input sweeper expires it and remote lanes ship it via the existing push.
    assert load[1]["inputs"]["file"].startswith("mcp_video_")
    assert (tmp_path / "input" / load[1]["inputs"]["file"]).is_file()
    assert comps[1]["inputs"]["video"] == [load[0], 0]

    assert context[1]["inputs"]["conditioning"] == ["104", 0]
    assert context[1]["inputs"]["vae"] == graph["104"]["inputs"]["vae"]
    assert context[1]["inputs"]["latent"] == ["104", 1]
    assert context[1]["inputs"]["context_length"] == "22"
    assert context[1]["inputs"]["audio_context_length"] == 22
    assert context[1]["inputs"]["context_frames"] == [comps[0], 0]
    # Two wires that stop every join from restarting the room tone: the
    # successor clip must HEAR the predecessor's tail.
    assert context[1]["inputs"]["context_audio"] == [comps[0], 1]
    assert context[1]["inputs"]["audio_vae"] == graph["23"]["inputs"]["vae"]

    # The guider consumes the context-modified conditioning.
    assert graph["16"]["inputs"]["conditioning"] == [context[0], 0]
    # The sampler still samples the source latent.
    assert graph["14"]["inputs"]["latent_image"] == ["104", 1]

    # Post-decode trim removes the re-rendered context head from BOTH streams.
    assert trim[1]["inputs"]["images"] == ["10", 0]
    assert trim[1]["inputs"]["audio"] == ["23", 0]
    assert trim[1]["inputs"]["trim_frames"] == [context[0], 1]
    assert trim[1]["inputs"]["fps"] == 24
    assert trim[1]["inputs"]["match_tail"] is True
    assert create["inputs"]["images"] == [trim[0], 0]
    assert create["inputs"]["audio"] == [trim[0], 1]

    # Spectrum forced off on a chained graph even though the default is on.
    assert graph["30"]["inputs"]["enabled"] is False

    # 5s asked + 22 context frames = 142ish -> NEAREST lattice point 141, so
    # the delivered clip (141-22=119 frames) stays within a frame of the ask.
    assert graph["104"]["inputs"]["length"] == 141

    # Canvas locked to the context clip, not the aspect-tier default.
    assert graph["104"]["inputs"]["width"] == 96
    assert graph["104"]["inputs"]["height"] == 64

    # No start-frame anchor: the chain seed provides the opening frames.
    assert not [n for n in graph.values() if n["class_type"] == "LoadImage"]


def test_minimax_h3_motion_context_without_audio_skips_the_audio_wires(tmp_path):
    graph = _capture_video_graph(tmp_path, "minimax-h3", {
        "prompt": "continue the silent scene",
        "motion_context_base64": _tiny_video_data_url(tmp_path, with_audio=False),
        "duration_seconds": 5,
    })
    context = next(n for n in graph.values() if n["class_type"] == "MiniMaxH3MotionContext")
    assert "context_audio" not in context["inputs"]
    assert "audio_vae" not in context["inputs"]
    assert context["inputs"]["audio_context_length"] == 0
    assert "context_frames" in context["inputs"]


def test_minimax_h3_motion_context_refuses_a_start_frame(tmp_path):
    """A first-frame pin at frame 0 and a context head both claim the opening
    frames; H3 renders contradictions as unions, so refuse the combination."""
    reply = _capture_video_graph(tmp_path, "minimax-h3", {
        "prompt": "x",
        "motion_context_base64": _tiny_video_data_url(tmp_path),
        "image_base64": _TINY_PNG,
    }, expect_refusal=True)
    assert "replaces the start frame" in reply


def test_minimax_h3_reference_mode_supports_motion_context(tmp_path):
    """Motion Context v0.2.0 keeps the reference list and adds the continuation
    audio to it, so chaining and reference conditioning compose."""
    graph = _capture_video_graph(tmp_path, "minimax-h3-reference", {
        "prompt": "the referenced courier keeps walking",
        "reference_images": [{"image_base64": _TINY_PNG}],
        "motion_context_base64": _tiny_video_data_url(tmp_path),
    })
    context = next((k, n) for k, n in graph.items() if n["class_type"] == "MiniMaxH3MotionContext")
    node = next(n for n in graph.values() if n["class_type"] == "MiniMaxH3ReferenceToVideo")
    assert context[1]["inputs"]["conditioning"] == ["104", 0]
    assert graph["16"]["inputs"]["conditioning"] == [context[0], 0]
    assert "ref_images.ref_image_0" in node["inputs"]
    assert graph["30"]["inputs"]["enabled"] is False


def test_minimax_h3_motion_context_is_declared_on_every_h3_tier():
    registry = json.loads(WORKFLOW_REGISTRY.read_text(encoding="utf-8"))
    for workflow_id in ("minimax-h3", "minimax-h3-turbo", "minimax-h3-reference"):
        workflow = next(
            item for item in _resolved_registry_workflows(registry) if item["id"] == workflow_id
        )
        for field in ("motion_context_path", "motion_context_base64", "motion_context_url"):
            assert field in workflow["accepts"], f"{workflow_id} must accept {field}"
        # video_* stays LTX-only: it flips extend/head-swap behavior stack-wide.
        assert not any(str(f).startswith("video_") for f in workflow["accepts"])


def test_reference_mode_is_a_routing_target_not_a_tier(tmp_path):
    """There is ONE MiniMax H3 with levers, not a separate Reference model.
    Reference mode is where a run is ROUTED when references are attached, so
    offering it in the picker only strands the user: its graph has no frame
    inputs, so the Frames control vanishes, and it refuses to run at all
    without a reference. A real session reloaded stuck exactly that way."""
    registry = json.loads(WORKFLOW_REGISTRY.read_text(encoding="utf-8"))
    workflows = {item["id"]: item for item in _resolved_registry_workflows(registry)}

    assert workflows["minimax-h3-reference"]["routing_only"] is True
    # The tier the user actually picks stays selectable, and does NOT take
    # references itself — that is what makes the routing necessary.
    assert not workflows["minimax-h3"].get("routing_only")
    assert not workflows["minimax-h3-turbo"].get("routing_only")
    assert "reference_images" not in workflows["minimax-h3"]["accepts"]


def test_autogrow_reference_slots_are_zero_indexed_like_comfyui_names_them() -> None:
    """ComfyUI builds autogrow slot names as [f"{prefix}{i}" for i in range(max)]
    — zero-based. Ours were written 1..N, so 1..max-1 were coincidentally valid
    indices and the LAST slot fell outside the range: with nine pictures
    attached, `ref_images.ref_image_9` was passed to execute() as a literal
    keyword argument instead of being folded into the ref_images dict, and the
    node raised TypeError. It only ever failed at the maximum, which is why it
    survived every test that attached fewer.
    """
    import json

    graph = json.loads((ROOT / "packages/media-gateway/workflows/minimax-h3-reference.api.json").read_text())
    inputs = graph["prompt"]["104"]["inputs"]

    for group, expected in (("ref_images", 9), ("ref_videos", 3), ("ref_video_audios", 3), ("ref_audios", 3)):
        indices = sorted(
            int(key.rsplit("_", 1)[1])
            for key in inputs
            if key.startswith(f"{group}.")
        )
        assert indices == list(range(expected)), f"{group} must be 0..{expected - 1}, got {indices}"

    # And the registry's audio links have to address the same slots, or a clip's
    # soundtrack lands on a different clip than its frames.
    registry = json.loads((ROOT / "packages/media-gateway/workflow-registry.json").read_text())
    workflow = next(w for w in registry["workflows"] if w["id"] == "minimax-h3-reference")
    links = [slot["audio_link"]["input"] for slot in workflow["reference_video_slots"]]
    assert links == [f"ref_video_audios.ref_video_audio_{i}" for i in range(3)]
    # Each video slot's audio link must carry the same ordinal as the video.
    for index, slot in enumerate(workflow["reference_video_slots"]):
        assert slot["audio_link"]["input"].endswith(f"_{index}")


# The motion-reference ceiling exists in two places on purpose: the registry is
# the source of truth, and media_catalog mirrors it so a DEGRADED catalog still
# refuses a length the card cannot render. Two copies can drift, so pin them.
def test_motion_reference_budget_mirror_matches_the_registry():
    from hivemind_content_studio.media_catalog import (
        _H3_FRAME_GRID,
        _H3_FRAME_RATE,
        _H3_MOTION_REFERENCE_PIXEL_FRAMES,
        _built_in_video_models_with_limits,
    )

    registry = json.loads(WORKFLOW_REGISTRY.read_text())
    h3 = next(w for w in registry["workflows"] if w["id"] == "minimax-h3")
    assert h3["motion_reference_budget"]["max_reference_pixel_frames"] == _H3_MOTION_REFERENCE_PIXEL_FRAMES
    assert h3["frame_grid"] == _H3_FRAME_GRID
    assert h3["defaults"]["frame_rate"] == _H3_FRAME_RATE

    # Reference mode is a SEPARATE workflow reached by routing, and it is the
    # one that actually stages motion clips — the budget has to reach it, which
    # it does by inheritance. A tier that lost it would offer 15s again.
    for workflow in _resolved_registry_workflows(registry):
        # VIDEO lanes only: minimax-h3-image shares the id prefix but is a still
        # lane with no motion references, so it carries no budget by design.
        if workflow["id"].startswith("minimax-h3") and workflow.get("media_type") == "video":
            assert workflow["motion_reference_budget"]["max_reference_pixel_frames"] == _H3_MOTION_REFERENCE_PIXEL_FRAMES

    # And the fallback list the studio gets when the registry cannot be read
    # carries the ceiling rather than silently restoring the full range.
    fallback = {model.id: model for model in _built_in_video_models_with_limits()}
    assert fallback["minimax-h3"].motion_reference_max_seconds["high|9:16"] == round(243 / 24, 3)
    # Non-minimax workflows have no measured budget and keep the full range.
    assert fallback["ltx23-eros-dmd-v12"].motion_reference_max_seconds is None


def _call_mcp_tool(name: str, arguments: dict) -> str:
    """Run the real MCP over HTTP with machine-private redaction ON."""
    mcp_port = _free_port()
    env = {
        **os.environ,
        "MEDIA_STUDIO_TOKEN_FILE": "/dev/null",
        "MEDIA_STUDIO_TOKEN": "test-token",
        "MEDIA_STUDIO_MCP_MACHINE_PRIVATE": "1",
    }
    process = subprocess.Popen(
        ["node", str(MCP_SOURCE), "--http", "--host", "127.0.0.1", "--port", str(mcp_port)],
        cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError(process.stderr.read())
            try:
                with socket.create_connection(("127.0.0.1", mcp_port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise AssertionError("Media Studio MCP did not start")
        request = Request(
            f"http://127.0.0.1:{mcp_port}/mcp",
            data=json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }).encode(),
            headers={
                "authorization": "Bearer test-token",
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
            },
            method="POST",
        )
        with urlopen(request, timeout=30) as response:
            return response.read().decode("utf-8")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


# A clip that cannot render must be refused BEFORE its references are staged.
# The authoritative check runs against the built graph, by which point every
# picture and motion clip has been fetched, decoded and re-encoded to 24 fps —
# twenty-odd seconds of work, with a progress bar, for a run that was never
# going to start. The reference path below does not exist: if staging ran first
# the failure would be about the missing file, so getting the capacity message
# back is what proves the ordering.
def test_an_impossible_motion_reference_clip_is_refused_before_anything_is_staged():
    missing = "/nonexistent/never-staged-because-the-preflight-refused-first.mp4"
    body = _call_mcp_tool("media_generate_video", {
        "workflow_id": "minimax-h3-reference",
        "prompt": "x",
        "width": 704,
        "height": 1216,
        "duration_seconds": 15,
        # A reference as long as the clip: the node trims it to the clip, so the
        # clip's own 15s is what has to fit, and it does not.
        "reference_videos": [{"video_path": missing, "use_audio": False, "duration_seconds": 15}],
    })

    # The reason survives machine-private redaction, because it is the card's
    # capacity and the canvas the caller already chose — no prompt, no media.
    assert "does not fit this card" in body, body[:400]
    assert "10.1s" in body
    # Never reached the staging step, so it cannot have complained about the file.
    assert "never-staged-because" not in body


def test_a_short_motion_reference_leaves_the_full_duration_range_open():
    """The bug this rule was rewritten for: a two-second reference on a 15s
    render. The node keeps a short reference at its own length, so it costs only
    that — but the first guard capped the clip whenever ANY reference was
    attached, and refused this outright."""
    body = _call_mcp_tool("media_generate_video", {
        "workflow_id": "minimax-h3-reference",
        "prompt": "x",
        "width": 704,
        "height": 1216,
        "duration_seconds": 15,
        "reference_videos": [{"video_path": "/nonexistent/clip.mp4", "use_audio": False, "duration_seconds": 2}],
    })
    assert "does not fit this card" not in body, body[:400]


def test_an_unmeasured_reference_is_treated_as_long():
    """No duration hint means the pre-flight cannot know the clip is short, and
    guessing short would let an over-budget run through to a three-minute OOM.
    It assumes long; the authoritative check re-runs on the real staged file."""
    body = _call_mcp_tool("media_generate_video", {
        "workflow_id": "minimax-h3-reference",
        "prompt": "x",
        "width": 704,
        "height": 1216,
        "duration_seconds": 15,
        "reference_videos": [{"video_path": "/nonexistent/clip.mp4", "use_audio": False}],
    })
    assert "does not fit this card" in body, body[:400]


def test_a_motion_reference_clip_that_fits_is_not_refused_and_redaction_still_holds():
    # 5s at the same canvas is inside the measured budget, so the guard must let
    # it through — an over-eager cap would be its own bug. It then fails on the
    # missing file, which is both the proof it reached staging AND the proof
    # that machine-private redaction is untouched: an ordinary failure still
    # arrives as a bare MediaStudioError, naming neither the path nor the job.
    body = _call_mcp_tool("media_generate_video", {
        "workflow_id": "minimax-h3-reference",
        "prompt": "x",
        "width": 704,
        "height": 1216,
        "duration_seconds": 5,
        "reference_videos": [{"video_path": "/nonexistent/clip.mp4", "use_audio": False}],
    })
    assert "does not fit this card" not in body, body[:400]
    assert "MediaStudioError" in body
    assert "/nonexistent/clip.mp4" not in body
