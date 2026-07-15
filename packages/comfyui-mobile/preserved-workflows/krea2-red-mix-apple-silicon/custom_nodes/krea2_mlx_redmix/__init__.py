import gc
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import torch

import comfy.utils
import folder_paths


KREA2_DIR = Path(os.environ.get("KREA2_MLX_DIR", str(Path.home() / "comfy/krea2_alis_mlx_redmix")))
MFLUX_SITE = Path(os.environ.get(
    "KREA2_MFLUX_SITE_PACKAGES",
    str(Path.home() / "comfy/mflux-biglove/.venv/lib/python3.11/site-packages"),
))
TRANSFORMER_PATH = Path(os.environ.get(
    "KREA2_REDMIX_TRANSFORMER",
    str(KREA2_DIR / "redmix_mxfp8_fused.safetensors"),
))

for path in (str(KREA2_DIR), str(MFLUX_SITE)):
    if path not in sys.path:
        sys.path.insert(0, path)


_PIPE = None
_PIPE_KEY = None
_PIPE_LOCK = threading.Lock()
_SIDECAR_PROC = None
_SIDECAR_LOCK = threading.Lock()
_SIDECAR_PORT = int(os.environ.get("KREA2_MLX_SIDECAR_PORT", "8796"))
_SIDECAR_URL = f"http://127.0.0.1:{_SIDECAR_PORT}"
_SIDECAR_LOG = Path(os.environ.get(
    "KREA2_MLX_SIDECAR_LOG",
    str(Path.home() / ".comfy-private.noindex/krea2-mlx-sidecar.log"),
))
_SIDECAR_OUTPUT_DIR = Path(os.environ.get(
    "KREA2_MLX_SIDECAR_OUTPUT_DIR",
    str(Path.home() / ".comfy-private.noindex/temp/krea2_mlx_sidecar"),
))
_DEFAULT_MLX_CACHE_LIMIT_GB = "0"
_DEFAULT_MLX_WIRED_LIMIT_FRACTION = "0.95"


def _prepare_mlx_runtime(clear_cache=False):
    try:
        import mlx.core as mx
        info = mx.device_info()
        wired_fraction = _desired_wired_limit_fraction()
        cache_limit_gb = _desired_cache_limit_gb()
        mx.set_wired_limit(int(info["max_recommended_working_set_size"] * wired_fraction))
        mx.set_cache_limit(cache_limit_gb * 1024**3)
        if clear_cache:
            mx.clear_cache()
    except Exception:
        pass


def _desired_cache_limit_gb():
    try:
        return max(0, int(os.environ.get("KREA2_MLX_CACHE_LIMIT_GB", _DEFAULT_MLX_CACHE_LIMIT_GB)))
    except ValueError:
        return int(_DEFAULT_MLX_CACHE_LIMIT_GB)


def _desired_wired_limit_fraction():
    try:
        return float(os.environ.get("KREA2_MLX_WIRED_LIMIT_FRACTION", _DEFAULT_MLX_WIRED_LIMIT_FRACTION))
    except ValueError:
        return float(_DEFAULT_MLX_WIRED_LIMIT_FRACTION)


def _desired_activation_dtype():
    return os.environ.get("KREA2_MLX_ACTIVATION_DTYPE", "bf16").lower()


def _desired_rope_precision():
    return os.environ.get("KREA2_MLX_ROPE_PRECISION", "fp32").lower()


def _desired_text_max_length():
    return os.environ.get("KREA2_MLX_TEXT_MAX_LENGTH", "512")


def _desired_dynamic_text_length():
    return _desired_bool_env("KREA2_MLX_DYNAMIC_TEXT_LENGTH", "0")


def _desired_bool_env(name: str, default: str = "0"):
    return os.environ.get(name, default).lower() in {"1", "true", "yes", "on"}


def _clear_cache_before_each_run():
    return os.environ.get("KREA2_MLX_CLEAR_CACHE_PER_RUN", "0").lower() in {"1", "true", "yes", "on"}


def _timings_enabled():
    return os.environ.get("KREA2_MLX_TIMINGS", "0").lower() in {"1", "true", "yes", "on"}


def _recycle_sidecar_after_run():
    return os.environ.get("KREA2_MLX_RECYCLE_SIDECAR_AFTER_RUN", "1").lower() in {"1", "true", "yes", "on"}


def _focus_mode_enabled():
    return os.environ.get("KREA2_MLX_FOCUS_MODE", "1").lower() in {"1", "true", "yes", "on"}


def _focus_pause_ports():
    raw = os.environ.get("KREA2_MLX_FOCUS_PAUSE_PORTS", "8198")
    ports = []
    for item in raw.replace(",", " ").split():
        try:
            port = int(item)
        except ValueError:
            continue
        if port > 0 and port not in ports:
            ports.append(port)
    return ports


def _focus_pause_raw_ports():
    raw = os.environ.get("KREA2_MLX_FOCUS_PAUSE_RAW_PORTS", "")
    ports = []
    for item in raw.replace(",", " ").split():
        try:
            port = int(item)
        except ValueError:
            continue
        if port > 0 and port not in ports:
            ports.append(port)
    return ports


def _listener_pids(port):
    try:
        result = subprocess.run(
            ["/usr/sbin/lsof", f"-tiTCP:{int(port)}", "-sTCP:LISTEN"],
            capture_output=True,
            text=True,
            check=False,
            timeout=2,
        )
    except Exception:
        return []
    pids = []
    for raw_pid in result.stdout.split():
        try:
            pid = int(raw_pid)
        except ValueError:
            continue
        if pid > 0 and pid not in pids:
            pids.append(pid)
    return pids


def _pid_stat(pid):
    try:
        result = subprocess.run(
            ["/bin/ps", "-o", "stat=", "-p", str(int(pid))],
            capture_output=True,
            text=True,
            check=False,
            timeout=2,
        )
    except Exception:
        return ""
    return result.stdout.strip()


def _comfy_lane_queue_idle(port):
    try:
        request = urllib.request.Request(f"http://127.0.0.1:{int(port)}/queue", method="GET")
        with urllib.request.urlopen(request, timeout=1) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return False
    return not payload.get("queue_running") and not payload.get("queue_pending")


class _KreaFocusGuard:
    def __init__(self):
        self._paused = []

    def __enter__(self):
        if not _focus_mode_enabled():
            return self
        self_pid = os.getpid()
        sidecar_pid = _SIDECAR_PROC.pid if _SIDECAR_PROC is not None and _SIDECAR_PROC.poll() is None else None
        for port in _focus_pause_ports():
            if not _comfy_lane_queue_idle(port):
                print(f"[Krea2MLX] focus skip port={port}: lane not idle or queue unavailable", flush=True)
                continue
            for pid in _listener_pids(port):
                if pid in {self_pid, sidecar_pid}:
                    continue
                stat = _pid_stat(pid)
                if "T" in stat:
                    continue
                try:
                    os.kill(pid, signal.SIGSTOP)
                    self._paused.append((pid, port))
                except ProcessLookupError:
                    continue
                except Exception as exc:
                    print(f"[Krea2MLX] focus could not pause pid={pid} port={port}: {exc}", flush=True)
        for port in _focus_pause_raw_ports():
            for pid in _listener_pids(port):
                if pid in {self_pid, sidecar_pid}:
                    continue
                stat = _pid_stat(pid)
                if "T" in stat:
                    continue
                try:
                    os.kill(pid, signal.SIGSTOP)
                    self._paused.append((pid, port))
                except ProcessLookupError:
                    continue
                except Exception as exc:
                    print(f"[Krea2MLX] focus could not pause raw pid={pid} port={port}: {exc}", flush=True)
        if self._paused:
            print(f"[Krea2MLX] focus paused idle sibling lanes={self._paused}", flush=True)
        return self

    def __exit__(self, exc_type, exc, tb):
        for pid, port in reversed(self._paused):
            try:
                os.kill(pid, signal.SIGCONT)
                print(f"[Krea2MLX] focus resumed pid={pid} port={port}", flush=True)
            except ProcessLookupError:
                continue
            except Exception as resume_exc:
                print(f"[Krea2MLX] focus could not resume pid={pid} port={port}: {resume_exc}", flush=True)
        self._paused = []
        return False


def _request_json(path, payload=None, timeout=10):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{_SIDECAR_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _sidecar_status():
    try:
        return _request_json("/health", timeout=1)
    except Exception:
        return None


def _status_is_fast_path_healthy(payload):
    if not (payload and payload.get("ok")):
        return False
    features = set(payload.get("features") or [])
    runtime = payload.get("runtime") or {}
    return (
        "lora_stack" in features
        and "mlx_fast_path_report" in features
        and runtime.get("compile_forward") is True
        and str(runtime.get("activation_dtype")) == _desired_activation_dtype()
        and str(runtime.get("rope_precision", "fp32")) == _desired_rope_precision()
        and str(runtime.get("text_max_length")) == _desired_text_max_length()
        and bool(runtime.get("dynamic_text_length")) is _desired_dynamic_text_length()
        and runtime.get("profile_stages") is _desired_bool_env("KREA2_MLX_PROFILE_STAGES", "0")
        and runtime.get("eval_each_step") is False
        and runtime.get("step_timings") is False
        and str(runtime.get("mlx_metal_fast_synch")) == "1"
        and str(runtime.get("mlx_enable_tf32", "")) == os.environ.get("MLX_ENABLE_TF32", "")
        and str(runtime.get("mlx_metal_jit", "")) == os.environ.get("MLX_METAL_JIT", "")
        and int(runtime.get("cache_limit_gb") or 0) == _desired_cache_limit_gb()
        and abs(float(runtime.get("wired_limit_fraction") or 0.0) - _desired_wired_limit_fraction()) < 1e-6
        and bool(runtime.get("background_sidecar")) is False
    )


def _sidecar_healthy():
    payload = _sidecar_status()
    return _status_is_fast_path_healthy(payload)


def _stop_sidecar_listener():
    global _SIDECAR_PROC
    if _SIDECAR_PROC is not None and _SIDECAR_PROC.poll() is None:
        _SIDECAR_PROC.terminate()
    try:
        result = subprocess.run(
            ["/usr/sbin/lsof", f"-tiTCP:{_SIDECAR_PORT}", "-sTCP:LISTEN"],
            capture_output=True,
            text=True,
            check=False,
        )
        for raw_pid in result.stdout.split():
            try:
                os.kill(int(raw_pid), signal.SIGTERM)
            except Exception:
                pass
    except Exception:
        pass
    deadline = time.time() + 5
    while time.time() < deadline:
        if _sidecar_status() is None:
            break
        time.sleep(0.1)
    _SIDECAR_PROC = None


def _ensure_sidecar():
    global _SIDECAR_PROC
    if _sidecar_healthy():
        return
    with _SIDECAR_LOCK:
        if _sidecar_healthy():
            return
        status = _sidecar_status()
        if status and status.get("ok") and not _status_is_fast_path_healthy(status):
            _stop_sidecar_listener()
        _SIDECAR_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        _SIDECAR_LOG.parent.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env.update({
            "KREA2_MLX_DIR": str(KREA2_DIR),
            "KREA2_MFLUX_SITE_PACKAGES": str(MFLUX_SITE),
            "KREA2_REDMIX_TRANSFORMER": str(TRANSFORMER_PATH),
            "KREA2_MLX_SIDECAR_PORT": str(_SIDECAR_PORT),
            "KREA2_MLX_SIDECAR_OUTPUT_DIR": str(_SIDECAR_OUTPUT_DIR),
            "PYTHONUNBUFFERED": "1",
            "MLX_METAL_FAST_SYNCH": os.environ.get("MLX_METAL_FAST_SYNCH", "1"),
            "KREA2_MLX_COMPILE_FORWARD": os.environ.get("KREA2_MLX_COMPILE_FORWARD", "1"),
            "KREA2_MLX_ACTIVATION_DTYPE": _desired_activation_dtype(),
            "KREA2_MLX_ROPE_PRECISION": _desired_rope_precision(),
            "KREA2_MLX_TEXT_MAX_LENGTH": _desired_text_max_length(),
            "KREA2_MLX_DYNAMIC_TEXT_LENGTH": os.environ.get("KREA2_MLX_DYNAMIC_TEXT_LENGTH", "0"),
            "KREA2_MLX_PROFILE_STAGES": os.environ.get("KREA2_MLX_PROFILE_STAGES", "0"),
            "KREA2_MLX_EVAL_EACH_STEP": os.environ.get("KREA2_MLX_EVAL_EACH_STEP", "0"),
            "KREA2_MLX_STEP_TIMINGS": os.environ.get("KREA2_MLX_STEP_TIMINGS", "0"),
            "KREA2_MLX_CACHE_LIMIT_GB": str(_desired_cache_limit_gb()),
            "KREA2_MLX_WIRED_LIMIT_FRACTION": str(_desired_wired_limit_fraction()),
        })
        if "MLX_ENABLE_TF32" in os.environ:
            env["MLX_ENABLE_TF32"] = os.environ["MLX_ENABLE_TF32"]
        if "MLX_METAL_JIT" in os.environ:
            env["MLX_METAL_JIT"] = os.environ["MLX_METAL_JIT"]
        log = open(_SIDECAR_LOG, "ab", buffering=0)
        _SIDECAR_PROC = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("sidecar.py"))],
            stdout=log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env=env,
            close_fds=True,
            start_new_session=True,
        )
        if os.environ.get("KREA2_MLX_BACKGROUND_SIDECAR", "0").lower() in {"1", "true", "yes", "on"}:
            try:
                subprocess.run(["/usr/sbin/taskpolicy", "-B", "-p", str(_SIDECAR_PROC.pid)], check=False)
            except Exception:
                pass
        deadline = time.time() + 20
        while time.time() < deadline:
            if _sidecar_healthy():
                return
            if _SIDECAR_PROC.poll() is not None:
                raise RuntimeError(f"Krea2 MLX sidecar exited early; see {_SIDECAR_LOG}")
            time.sleep(0.25)
        raise TimeoutError(f"Krea2 MLX sidecar did not become healthy; see {_SIDECAR_LOG}")


def _pipeline():
    global _PIPE, _PIPE_KEY
    key = (str(TRANSFORMER_PATH), "mxfp8-fused", os.environ.get("KREA2_BASE_DIR"))
    with _PIPE_LOCK:
        if _PIPE is not None and _PIPE_KEY == key:
            return _PIPE
        if not TRANSFORMER_PATH.exists():
            raise FileNotFoundError(f"Krea2 Red Mix MXFP8 transformer not found: {TRANSFORMER_PATH}")
        _PIPE = None
        _PIPE_KEY = None
        gc.collect()
        _prepare_mlx_runtime(clear_cache=True)
        from krea2.pipeline import Krea2Pipeline
        _PIPE = Krea2Pipeline(
            transformer_path=str(TRANSFORMER_PATH),
            precision="mxfp8-fused",
            base_dir=os.environ.get("KREA2_BASE_DIR"),
        )
        _PIPE_KEY = key
        return _PIPE


def _pil_to_tensor(images):
    tensors = []
    for image in images:
        arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        tensors.append(torch.from_numpy(arr))
    return torch.stack(tensors, dim=0)


def _image_paths_to_tensor(paths):
    from PIL import Image

    tensors = []
    for path in paths:
        with Image.open(path) as image:
            arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        tensors.append(torch.from_numpy(arr))
    return torch.stack(tensors, dim=0)


def _parse_lora_stack(lora_stack):
    if not lora_stack:
        return []
    if isinstance(lora_stack, str):
        text = lora_stack.strip()
        if not text:
            return []
        try:
            raw_entries = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError("Krea2 LoRA stack must be valid JSON.") from exc
    elif isinstance(lora_stack, list):
        raw_entries = lora_stack
    else:
        raise ValueError(f"Krea2 LoRA stack must be JSON text or a list, got {type(lora_stack).__name__}.")

    if not isinstance(raw_entries, list):
        raise ValueError("Krea2 LoRA stack must be a JSON list.")

    active = []
    for index, entry in enumerate(raw_entries):
        if not isinstance(entry, dict):
            continue
        if not bool(entry.get("on", entry.get("active", False))):
            continue
        lora_name = str(entry.get("lora") or entry.get("name") or entry.get("lora_name") or "").strip()
        if not lora_name or lora_name.lower() == "none":
            continue
        try:
            strength = float(entry.get("strength", entry.get("model_strength", 1.0)))
        except (TypeError, ValueError):
            raise ValueError(f"Krea2 LoRA stack entry {index + 1} has invalid strength: {entry.get('strength')!r}") from None
        if strength == 0:
            continue
        lora_path = Path(lora_name).expanduser() if os.path.isabs(lora_name) else None
        if lora_path is None or not lora_path.exists():
            resolved = folder_paths.get_full_path("loras", lora_name)
            if not resolved:
                raise ValueError(f"Krea2 LoRA not found: {lora_name}")
            lora_path = Path(resolved)
        active.append({
            "name": lora_name,
            "path": str(lora_path),
            "strength": strength,
        })
    return active


def _serialize_lora_stack(lora_stack):
    if isinstance(lora_stack, str):
        text = lora_stack.strip()
        if not text:
            return "[]"
        json.loads(text)
        return text
    if isinstance(lora_stack, list):
        return json.dumps(lora_stack)
    return "[]"


class Krea2MLXMultiLoRAStack:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lora_stack": ("STRING", {
                    "multiline": True,
                    "default": "[]",
                    "forceInput": False,
                }),
            }
        }

    RETURN_TYPES = ("KREA2_LORA_STACK",)
    RETURN_NAMES = ("lora_stack",)
    FUNCTION = "stack"
    CATEGORY = "Krea2/MLX"

    def stack(self, lora_stack="[]"):
        return (_serialize_lora_stack(lora_stack),)


class Krea2MLXRedMixSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"multiline": True, "default": "portrait photo, natural light, detailed skin, realistic"}),
                "width": ("INT", {"default": 960, "min": 256, "max": 2048, "step": 16}),
                "height": ("INT", {"default": 1440, "min": 256, "max": 2048, "step": 16}),
                "steps": ("INT", {"default": 10, "min": 1, "max": 50}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**64 - 1, "control_after_generate": True}),
                "num_images": ("INT", {"default": 1, "min": 1, "max": 4}),
                "sampler": (["flow_euler", "er_sde"], {"default": "flow_euler"}),
            },
            "optional": {
                "lora_stack": ("KREA2_LORA_STACK",),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "generate"
    CATEGORY = "Krea2/MLX"

    def generate(self, prompt, width, height, steps, seed, num_images, sampler="flow_euler", lora_stack=None):
        run_start = time.perf_counter()
        last_mark = [run_start]

        def mark(label):
            if not _timings_enabled():
                return
            now = time.perf_counter()
            print(f"[Krea2MLX] {label}: total={now - run_start:.3f}s delta={now - last_mark[0]:.3f}s", flush=True)
            last_mark[0] = now

        pbar = comfy.utils.ProgressBar(int(steps))

        def callback(step, total):
            mark(f"step {step}/{total}")
            pbar.update_absolute(step, total)

        _ensure_sidecar()
        mark("pipeline")
        active_loras = _parse_lora_stack(lora_stack)
        with _KreaFocusGuard():
            response = _request_json("/generate", {
                "prompt": str(prompt).strip(),
                "width": int(width),
                "height": int(height),
                "steps": int(steps),
                "seed": int(seed),
                "num_images": int(num_images),
                "sampler": str(sampler),
                "loras": active_loras,
                "prefix": "Krea2_RedMix_sidecar",
            }, timeout=max(600, int(steps) * 120))
        mark(f"sidecar_generate timings={response.get('timings')}")
        paths = response.get("images") or []
        if not paths:
            raise RuntimeError(f"Krea2 MLX sidecar returned no images: {response}")
        tensors = _image_paths_to_tensor(paths)
        mark("pil_to_tensor")
        pbar.update_absolute(int(steps), int(steps))
        if _recycle_sidecar_after_run():
            _stop_sidecar_listener()
        return (tensors,)


class Krea2MLXFreeCache:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"drop_model": ("BOOLEAN", {"default": False})}}

    RETURN_TYPES = ()
    FUNCTION = "free"
    OUTPUT_NODE = True
    CATEGORY = "Krea2/MLX"

    def free(self, drop_model):
        global _PIPE, _PIPE_KEY
        if drop_model:
            with _PIPE_LOCK:
                _PIPE = None
                _PIPE_KEY = None
        gc.collect()
        try:
            import mlx.core as mx
            mx.clear_cache()
        except Exception:
            pass
        return {}


NODE_CLASS_MAPPINGS = {
    "Krea2MLXMultiLoRAStack": Krea2MLXMultiLoRAStack,
    "Krea2MLXRedMixSampler": Krea2MLXRedMixSampler,
    "Krea2MLXFreeCache": Krea2MLXFreeCache,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Krea2MLXMultiLoRAStack": "Krea2 MLX Multi LoRA Stack",
    "Krea2MLXRedMixSampler": "Krea2 Red Mix MLX Sampler",
    "Krea2MLXFreeCache": "Krea2 MLX Free Cache",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
