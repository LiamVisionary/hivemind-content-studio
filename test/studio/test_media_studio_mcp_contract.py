import base64
import io
import json
import os
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


def test_video_loras_have_native_mlx_and_comfy_graph_parity():
    source = MCP_SOURCE.read_text(encoding="utf-8")
    video_tool = source.split("server.registerTool('media_generate_video'", 1)[1]
    video_tool = video_tool.split("}, tool(async (args) =>", 1)[0]
    assert "loras: z.array(z.object({" in video_tool
    assert "injectWorkflowLoras(promptGraph, settings.loras, workflow.lora_injection)" in source
    assert "mergeNativeWorkflowLoras(nativeSpec.loras, settings.loras)" in source

    registry = json.loads(WORKFLOW_REGISTRY.read_text(encoding="utf-8"))
    for workflow in (item for item in _resolved_registry_workflows(registry) if item["media_type"] == "video"):
        assert workflow["supports_loras"] is True
        assert workflow["compatible_base_models"] == ["LTXV"]
        assert "loras" in workflow["accepts"]
        injection = workflow["lora_injection"]
        graph = json.loads(Path(workflow["api_workflow"]).read_text(encoding="utf-8"))["prompt"]
        sources = [graph[target["node"]]["inputs"][target["input"]] for target in injection["targets"]]
        assert all(source_ref == sources[0] for source_ref in sources)


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


@pytest.mark.parametrize("workflow_id", ["ltx23-regular-fp8", "ltx23-eros-fast"])
def test_video_mcp_compiles_shared_keyframes_into_comfy_cuda_graph(tmp_path, workflow_id):
    api_workflow = tmp_path / "ltx-api.json"
    api_workflow.write_text(json.dumps(_ltx_api_workflow()), encoding="utf-8")
    mobile_dir = tmp_path / "mobile"
    mobile_dir.mkdir()
    mobile_workflow = {"nodes": [], "extra": {}}
    for name in (
        "LTX 2.3 Eros MLX Fast q8 v1.2 Mobile.json",
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
