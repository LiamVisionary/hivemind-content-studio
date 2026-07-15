from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


os.environ.setdefault("MLX_METAL_FAST_SYNCH", "1")

KREA2_DIR = Path(os.environ.get("KREA2_MLX_DIR", str(Path.home() / "comfy/krea2_alis_mlx_redmix")))
MFLUX_SITE = Path(os.environ.get(
    "KREA2_MFLUX_SITE_PACKAGES",
    str(Path.home() / "comfy/mflux-biglove/.venv/lib/python3.11/site-packages"),
))
TRANSFORMER_PATH = Path(os.environ.get(
    "KREA2_REDMIX_TRANSFORMER",
    str(KREA2_DIR / "redmix_mxfp8_fused.safetensors"),
))
OUTPUT_DIR = Path(os.environ.get(
    "KREA2_MLX_SIDECAR_OUTPUT_DIR",
    str(Path.home() / ".comfy-private.noindex/temp/krea2_mlx_sidecar"),
))
PORT = int(os.environ.get("KREA2_MLX_SIDECAR_PORT", "8796"))
DEFAULT_MLX_CACHE_LIMIT_GB = "0"
DEFAULT_MLX_WIRED_LIMIT_FRACTION = "0.95"

for path in (str(KREA2_DIR), str(MFLUX_SITE)):
    if path not in sys.path:
        sys.path.insert(0, path)


_PIPE = None
_PIPE_KEY = None
_PIPE_LOCK = threading.Lock()
_FAST_PATH_REPORT = None


def _compile_forward_enabled():
    return os.environ.get("KREA2_MLX_COMPILE_FORWARD", "1").lower() in {"1", "true", "yes", "on"}


def _step_timings_enabled():
    return os.environ.get("KREA2_MLX_STEP_TIMINGS", "0").lower() in {"1", "true", "yes", "on"}


def _runtime_settings():
    try:
        cache_limit_gb = max(0, int(os.environ.get("KREA2_MLX_CACHE_LIMIT_GB", DEFAULT_MLX_CACHE_LIMIT_GB)))
    except ValueError:
        cache_limit_gb = int(DEFAULT_MLX_CACHE_LIMIT_GB)
    try:
        wired_limit_fraction = float(os.environ.get("KREA2_MLX_WIRED_LIMIT_FRACTION", DEFAULT_MLX_WIRED_LIMIT_FRACTION))
    except ValueError:
        wired_limit_fraction = float(DEFAULT_MLX_WIRED_LIMIT_FRACTION)
    return {
        "mlx_metal_fast_synch": os.environ.get("MLX_METAL_FAST_SYNCH", "1"),
        "mlx_enable_tf32": os.environ.get("MLX_ENABLE_TF32", ""),
        "mlx_metal_jit": os.environ.get("MLX_METAL_JIT", ""),
        "compile_forward": _compile_forward_enabled(),
        "activation_dtype": os.environ.get("KREA2_MLX_ACTIVATION_DTYPE", "bf16").lower(),
        "rope_precision": os.environ.get("KREA2_MLX_ROPE_PRECISION", "fp32").lower(),
        "text_max_length": os.environ.get("KREA2_MLX_TEXT_MAX_LENGTH", "512"),
        "dynamic_text_length": os.environ.get("KREA2_MLX_DYNAMIC_TEXT_LENGTH", "0").lower()
        in {"1", "true", "yes", "on"},
        "profile_stages": os.environ.get("KREA2_MLX_PROFILE_STAGES", "0").lower() in {"1", "true", "yes", "on"},
        "eval_each_step": os.environ.get("KREA2_MLX_EVAL_EACH_STEP", "0").lower() in {"1", "true", "yes", "on"},
        "step_timings": _step_timings_enabled(),
        "cache_limit_gb": cache_limit_gb,
        "wired_limit_fraction": wired_limit_fraction,
        "background_sidecar": os.environ.get("KREA2_MLX_BACKGROUND_SIDECAR", "0").lower()
        in {"1", "true", "yes", "on"},
    }


def _prepare_mlx_runtime(clear_cache=False):
    import mlx.core as mx

    settings = _runtime_settings()
    info = mx.device_info()
    mx.set_wired_limit(int(info["max_recommended_working_set_size"] * settings["wired_limit_fraction"]))
    mx.set_cache_limit(settings["cache_limit_gb"] * 1024**3)
    if clear_cache:
        mx.clear_cache()


def _fast_path_report(pipe, active_loras):
    blocks = getattr(getattr(pipe, "transformer", None), "blocks", [])
    block0 = blocks[0] if blocks else None
    attn = getattr(block0, "attn", None)
    mlp = getattr(block0, "mlp", None)
    report = _runtime_settings()
    report.update({
        "precision": "mxfp8-fused",
        "transformer": type(getattr(pipe, "transformer", None)).__name__,
        "attention": type(attn).__name__ if attn is not None else None,
        "mlp": type(mlp).__name__ if mlp is not None else None,
        "fused_attention": type(attn).__name__ == "FusedAttention" and hasattr(attn, "qkvgate"),
        "fused_mlp": type(mlp).__name__ == "FusedSwiGLU" and hasattr(mlp, "gate_up"),
        "compiled_forward": type(getattr(pipe.transformer, "forward_prepared_vectors", None)).__name__,
        "lora_count": len(active_loras),
        "lora_names": [Path(str(entry.get("path") or entry.get("name") or "")).name for entry in active_loras],
    })
    return report


def _pipeline(loras=None):
    global _PIPE, _PIPE_KEY, _FAST_PATH_REPORT
    from krea2.lora import active_lora_signature, apply_lora_stack_to_pipeline

    lora_key = active_lora_signature(loras)
    key = (str(TRANSFORMER_PATH), "mxfp8-fused", os.environ.get("KREA2_BASE_DIR"), lora_key)
    with _PIPE_LOCK:
        if _PIPE is not None and _PIPE_KEY == key:
            return _PIPE
        if not TRANSFORMER_PATH.exists():
            raise FileNotFoundError(f"Krea2 Red Mix MXFP8 transformer not found: {TRANSFORMER_PATH}")
        _prepare_mlx_runtime(clear_cache=True)
        from krea2.pipeline import Krea2Pipeline

        _PIPE = Krea2Pipeline(
            transformer_path=str(TRANSFORMER_PATH),
            precision="mxfp8-fused",
            base_dir=os.environ.get("KREA2_BASE_DIR"),
        )
        active_loras = loras or []
        if active_loras:
            applied = apply_lora_stack_to_pipeline(_PIPE, active_loras)
            print(f"[Krea2MLXSidecar] applied Krea2 LoRA stack layer_adapters={applied}", flush=True)
        if _compile_forward_enabled():
            import mlx.core as mx

            try:
                _PIPE.transformer.forward_prepared_vectors = mx.compile(_PIPE.transformer.forward_prepared_vectors)
            except Exception as exc:
                print(f"[Krea2MLXSidecar] forward compile disabled after failure: {exc}", flush=True)
        _PIPE_KEY = key
        _FAST_PATH_REPORT = _fast_path_report(_PIPE, active_loras)
        print(f"[Krea2MLXSidecar] fast_path={json.dumps(_FAST_PATH_REPORT, sort_keys=True)}", flush=True)
        return _PIPE


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    server_version = "Krea2MLXSidecar/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("KREA2_MLX_SIDECAR_ACCESS_LOG", "0").lower() in {"1", "true", "yes", "on"}:
            print(f"[Krea2MLXSidecar] {self.address_string()} {fmt % args}", flush=True)

    def do_GET(self):
        if self.path == "/health":
            _json_response(
                self,
                200,
                {
                    "ok": True,
                    "loaded": _PIPE is not None,
                    "features": ["lora_stack", "mlx_fast_path_report"],
                    "runtime": _runtime_settings(),
                    "fast_path": _FAST_PATH_REPORT,
                },
            )
            return
        _json_response(self, 404, {"error": "not found"})

    def do_HEAD(self):
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path != "/generate":
            _json_response(self, 404, {"error": "not found"})
            return
        try:
            size = int(self.headers.get("Content-Length") or "0")
            payload = json.loads(self.rfile.read(size).decode("utf-8"))
            prompt = str(payload["prompt"]).strip()
            width = int(payload["width"])
            height = int(payload["height"])
            steps = int(payload["steps"])
            seed = int(payload["seed"])
            num_images = int(payload.get("num_images", 1))
            sampler = str(payload.get("sampler") or "flow_euler").strip()
            loras = payload.get("loras") or []
            prefix = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in str(payload.get("prefix") or "krea2"))

            timings = {}
            start = time.perf_counter()
            pipe = _pipeline(loras)
            timings["pipeline"] = time.perf_counter() - start

            step_times = []
            step_callback = None
            if _step_timings_enabled():
                step_mark = [time.perf_counter()]

                def step_callback(step, total):
                    now = time.perf_counter()
                    step_times.append({"step": step, "total": total, "seconds": now - step_mark[0]})
                    step_mark[0] = now

            gen_start = time.perf_counter()
            images = pipe.generate(
                prompt,
                width=width,
                height=height,
                steps=steps,
                seed=seed,
                num_images=num_images,
                sampler=sampler,
                step_callback=step_callback,
            )
            timings["generate"] = time.perf_counter() - gen_start
            timings["steps"] = step_times

            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            paths = []
            save_start = time.perf_counter()
            run_id = uuid.uuid4().hex[:10]
            for i, image in enumerate(images):
                path = OUTPUT_DIR / f"{prefix}_{run_id}_{i:02d}.png"
                image.save(path)
                paths.append(str(path))
            timings["save"] = time.perf_counter() - save_start
            timings["total"] = time.perf_counter() - start
            print(
                f"[Krea2MLXSidecar] generated sampler={sampler} steps={steps} "
                f"size={width}x{height} timings={timings}",
                flush=True,
            )
            _json_response(
                self,
                200,
                {
                    "images": paths,
                    "timings": timings,
                    "profile": getattr(pipe, "last_profile", None),
                    "sampler": sampler,
                    "fast_path": _FAST_PATH_REPORT,
                },
            )
        except Exception as exc:
            traceback.print_exc()
            _json_response(self, 500, {"error": str(exc), "traceback": traceback.format_exc()})


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[Krea2MLXSidecar] listening on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
