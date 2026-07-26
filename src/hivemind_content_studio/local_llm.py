"""App-native local LLM runtime behind the prompt helper.

The studio used to refine prompts through a ComfyUI ``prompt_assistant`` node,
which meant the helper only existed for workflows that declared one and always
ran whatever model that node was configured with. This module replaces that: it
finds the GGUF models already on this machine and runs the chosen one through a
``llama-server`` child process this app owns.

Owning the process is the point. LM Studio's REST API is inference-only — it can
report that a model is loaded but offers no load/unload — and the ``lms`` CLI on
this machine fails its own passkey handshake. A child process gives the studio
the things the UI actually needs: load is a spawn, unload is a kill that really
returns the memory, and RAM accounting is answerable at any moment.

Privacy: the owner's idea text goes only to a ``llama-server`` bound to
127.0.0.1 that this process spawned, guarded by a per-process API key so nothing
else on the machine can reach it. Server output is captured to a bounded
in-memory ring for diagnostics and is never written to disk, so no prompt text
outlives the process. Nothing here persists prompt text anywhere.
"""

from __future__ import annotations

import atexit
import contextlib
import json
import os
import re
import secrets
import shutil
import socket
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Where to look for GGUF weights. LM Studio's own directory is the default
# because that is where this machine keeps them; HIVEMIND_LLM_MODEL_ROOTS adds
# more (os.pathsep-separated) without editing code.
DEFAULT_MODEL_ROOTS = (Path.home() / ".lmstudio" / "models",)

_LLAMA_SERVER_CANDIDATES = (
    "/opt/homebrew/bin/llama-server",
    "/usr/local/bin/llama-server",
)

# 8k is plenty for "turn an idea into a prompt" and keeps the KV cache small
# enough that a big model still fits beside a loaded diffusion model.
DEFAULT_CONTEXT_TOKENS = 8192

# Never plan to use the last few GB. Generation work (LTX, Krea) allocates in
# large bursts, and a prompt helper that wins a race against it for the last
# gigabyte has caused an OOM, not prevented one.
SAFETY_MARGIN_BYTES = 4 * 1024**3

LOAD_TIMEOUT_SECONDS = 240
_STDERR_RING_LINES = 60

_GGUF_MAGIC = b"GGUF"
_GGUF_STRING = 8
_GGUF_ARRAY = 9
# GGUF scalar type -> byte width. Anything not here is a string or an array.
_GGUF_SCALAR_WIDTHS = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
_GGUF_INT_TYPES = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 10: "<Q", 11: "<q"}

# Multi-part GGUFs are published as "name-00001-of-00003.gguf". Only the first
# shard is a loadable entry point; llama.cpp opens the siblings itself.
_SHARD_RE = re.compile(r"^(?P<stem>.+)-(?P<index>\d{5})-of-(?P<total>\d{5})\.gguf$", re.IGNORECASE)


@dataclass(frozen=True)
class LocalLlmModel:
    """A GGUF on disk that the prompt helper could run."""

    id: str
    name: str
    path: str
    size_bytes: int
    architecture: str
    quantization: str
    max_context: int
    estimated_load_bytes: int
    measured: bool = False


@dataclass
class LoadedModel:
    """A llama-server this process started and is responsible for killing."""

    model_id: str
    port: int
    process: subprocess.Popen
    api_key: str
    started_at: float
    estimated_bytes: int
    context_tokens: int
    stderr: deque


class LocalLlmError(RuntimeError):
    """A prompt-helper failure with a message safe to show the owner."""


# ---------------------------------------------------------------------------
# GGUF metadata
# ---------------------------------------------------------------------------


def _read_gguf_string(handle) -> str:
    length = struct.unpack("<Q", handle.read(8))[0]
    return handle.read(length).decode("utf-8", "replace")


def _skip_gguf_value(handle, value_type: int) -> None:
    if value_type in _GGUF_SCALAR_WIDTHS:
        handle.seek(_GGUF_SCALAR_WIDTHS[value_type], os.SEEK_CUR)
        return
    if value_type == _GGUF_STRING:
        length = struct.unpack("<Q", handle.read(8))[0]
        handle.seek(length, os.SEEK_CUR)
        return
    if value_type == _GGUF_ARRAY:
        element_type = struct.unpack("<I", handle.read(4))[0]
        count = struct.unpack("<Q", handle.read(8))[0]
        if element_type in _GGUF_SCALAR_WIDTHS:
            handle.seek(_GGUF_SCALAR_WIDTHS[element_type] * count, os.SEEK_CUR)
            return
        for _ in range(count):
            _skip_gguf_value(handle, element_type)
        return
    raise ValueError(f"unknown GGUF value type {value_type}")


def _read_gguf_metadata(path: Path) -> dict[str, Any]:
    """Read the scalar metadata at the head of a GGUF file.

    Only scalars and short strings are kept — the tokenizer arrays are the bulk
    of the header and none of them matter here. Parsing stops at the first huge
    array once the architecture keys are in hand, which keeps this to a few
    milliseconds instead of a walk over a 150k-entry vocabulary.
    """
    wanted_suffixes = ("block_count", "embedding_length", "attention.head_count", "context_length")
    out: dict[str, Any] = {}
    try:
        with open(path, "rb") as handle:
            if handle.read(4) != _GGUF_MAGIC:
                return {}
            version = struct.unpack("<I", handle.read(4))[0]
            if version not in (2, 3):
                return {}
            handle.seek(8, os.SEEK_CUR)  # tensor_count
            kv_count = struct.unpack("<Q", handle.read(8))[0]
            for _ in range(min(kv_count, 8192)):
                key = _read_gguf_string(handle)
                value_type = struct.unpack("<I", handle.read(4))[0]
                if value_type in _GGUF_INT_TYPES:
                    width = _GGUF_SCALAR_WIDTHS[value_type]
                    out[key] = struct.unpack(_GGUF_INT_TYPES[value_type], handle.read(width))[0]
                elif value_type == _GGUF_STRING:
                    text = _read_gguf_string(handle)
                    if len(text) <= 256:
                        out[key] = text
                elif value_type == _GGUF_ARRAY:
                    position = handle.tell()
                    element_type = struct.unpack("<I", handle.read(4))[0]
                    count = struct.unpack("<Q", handle.read(8))[0]
                    handle.seek(position)
                    have_arch = "general.architecture" in out
                    have_dims = sum(any(k.endswith(s) for s in wanted_suffixes) for k in out) >= 3
                    if count > 65536 and have_arch and have_dims:
                        break
                    _skip_gguf_value(handle, value_type)
                else:
                    _skip_gguf_value(handle, value_type)
    except (OSError, ValueError, struct.error):
        return {}
    return out


def _estimate_load_bytes(size_bytes: int, measured_bytes: int | None = None) -> int:
    """Resident memory to expect from loading this model at this context size.

    Deliberately NOT derived from the attention shape in the GGUF header. That
    calculation is only correct for plain full-attention models: gemma4 puts
    most layers on a 1024-token sliding window (key_length 512 but
    key_length_swa 256, with no key naming which layers are which) and qwen35 is
    a hybrid that carries ssm.* state instead of a KV cache on 3 of every 4
    layers. Computing layers x ctx x heads x dims for the 12B here predicted
    12.9 GB of KV against 1.7 GB actually allocated, which would have wrongly
    greyed out models that fit comfortably.

    So: the weights are known exactly (the file is mmapped), and everything else
    is a modest multiplier until the model has been loaded once. After that,
    ``measured_bytes`` from a real load replaces the guess, which is both more
    accurate than any formula and correct for architectures that do not exist
    yet.
    """
    if measured_bytes and measured_bytes > 0:
        # Headroom over the observed peak: RSS is sampled shortly after load and
        # still grows a little as slots warm up.
        return int(measured_bytes * 1.10)
    return int(size_bytes * 1.25) + 1024**3


def _resident_bytes(pid: int) -> int:
    try:
        raw = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return 0
    return int(raw) * 1024 if raw.isdigit() else 0


# ---------------------------------------------------------------------------
# System memory
# ---------------------------------------------------------------------------


def _total_memory_bytes() -> int:
    try:
        return int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5).stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0


def _available_memory_bytes() -> int:
    """Memory a new allocation could actually use, macOS-style.

    Free pages alone badly understate this: macOS keeps most of RAM in the
    inactive/speculative file cache, which is evicted on demand. Counting those
    is why a 21 GB model is correctly reported as loadable on a machine showing
    only 5 GB "free".
    """
    try:
        raw = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return 0
    page_size = 4096
    header = re.search(r"page size of (\d+) bytes", raw)
    if header:
        page_size = int(header.group(1))
    pages = {}
    for line in raw.splitlines():
        match = re.match(r'^"?Pages ([^:"]+)"?:\s+(\d+)\.', line.strip())
        if match:
            pages[match.group(1).strip().lower()] = int(match.group(2))
    reclaimable = sum(pages.get(name, 0) for name in ("free", "inactive", "speculative", "purgeable"))
    return reclaimable * page_size


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def _model_roots() -> list[Path]:
    configured = os.environ.get("HIVEMIND_LLM_MODEL_ROOTS", "").strip()
    roots = [Path(p).expanduser() for p in configured.split(os.pathsep) if p.strip()] if configured else list(DEFAULT_MODEL_ROOTS)
    return [root for root in roots if root.is_dir()]


def _quantization_hint(name: str) -> str:
    match = re.search(r"\b(IQ\d[A-Z_]*|Q\d[A-Z0-9_]*|BF16|F16|F32|MXFP\d)\b", name, re.IGNORECASE)
    return match.group(1).upper() if match else ""


def discover_models(measurements: dict[str, int] | None = None) -> list[LocalLlmModel]:
    """Every runnable GGUF under the configured roots.

    Vision projectors (mmproj) and the 2nd..Nth shard of a split model are
    skipped: neither is something the user can load on its own.

    ``measurements`` maps model id to resident bytes observed on a previous
    load; those replace the size-based guess where present.
    """
    measurements = measurements or {}
    found: list[LocalLlmModel] = []
    for root in _model_roots():
        for path in sorted(root.rglob("*.gguf")):
            name = path.name
            if name.lower().startswith("mmproj"):
                continue
            size_bytes = path.stat().st_size
            shard = _SHARD_RE.match(name)
            if shard:
                if shard.group("index") != "00001":
                    continue
                # Charge the whole split model, not just its first piece.
                size_bytes = sum(
                    sibling.stat().st_size
                    for sibling in path.parent.glob(f"{shard.group('stem')}-*-of-{shard.group('total')}.gguf")
                )
            meta = _read_gguf_metadata(path)
            architecture = meta.get("general.architecture") or ""
            max_context = meta.get(f"{architecture}.context_length") if architecture else 0
            model_id = str(path.relative_to(root))
            found.append(
                LocalLlmModel(
                    id=model_id,
                    name=meta.get("general.name") or path.stem,
                    path=str(path),
                    size_bytes=size_bytes,
                    architecture=str(architecture),
                    quantization=_quantization_hint(name),
                    max_context=int(max_context) if isinstance(max_context, int) else 0,
                    estimated_load_bytes=_estimate_load_bytes(size_bytes, measurements.get(model_id)),
                    measured=model_id in measurements,
                )
            )
    return found


# ---------------------------------------------------------------------------
# External occupants
# ---------------------------------------------------------------------------


def _lmstudio_loaded_models(base_url: str, timeout: float = 1.5) -> list[dict[str, Any]]:
    """Models LM Studio currently holds in RAM.

    Best-effort and deliberately unauthenticated: this is only used to explain
    memory the studio cannot itself reclaim, so a missing LM Studio is normal
    and must never surface as an error.
    """
    try:
        request = urllib.request.Request(f"{base_url}/api/v0/models")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return []
    out = []
    for entry in payload.get("data", []) if isinstance(payload, dict) else []:
        if entry.get("state") == "loaded":
            out.append({"id": str(entry.get("id") or ""), "type": str(entry.get("type") or "")})
    return out


# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _drain(stream, ring: deque) -> None:
    try:
        for line in iter(stream.readline, b""):
            ring.append(line.decode("utf-8", "replace").rstrip())
    except (OSError, ValueError):
        pass


class LocalLlmRuntime:
    """Owns every llama-server this app starts."""

    def __init__(
        self,
        *,
        binary: str | None = None,
        context_tokens: int = DEFAULT_CONTEXT_TOKENS,
        lmstudio_url: str = "http://127.0.0.1:1234",
        state_path: Path | None = None,
    ) -> None:
        self._binary = binary or os.environ.get("HIVEMIND_LLAMA_SERVER") or self._find_binary()
        self._context_tokens = context_tokens
        self._lmstudio_url = lmstudio_url.rstrip("/")
        self._loaded: dict[str, LoadedModel] = {}
        self._lock = threading.RLock()
        self._state_path = state_path
        self._measurements = self._read_measurements()
        atexit.register(self.unload_all)

    # -- measured memory ---------------------------------------------------
    #
    # Model id -> resident bytes observed on a real load. Plain sizing data, no
    # prompt or generation content, so it is safe to keep in the clear.

    def _read_measurements(self) -> dict[str, int]:
        if self._state_path is None or not self._state_path.is_file():
            return {}
        try:
            raw = json.loads(self._state_path.read_text())
        except (OSError, ValueError):
            return {}
        if not isinstance(raw, dict):
            return {}
        return {str(k): int(v) for k, v in raw.items() if isinstance(v, (int, float)) and v > 0}

    def _record_measurement(self, model_id: str, resident_bytes: int) -> None:
        if resident_bytes <= 0:
            return
        # Keep the high-water mark: a later sample can be lower simply because
        # the model has not been asked to fill its context yet.
        if resident_bytes <= self._measurements.get(model_id, 0):
            return
        self._measurements[model_id] = resident_bytes
        if self._state_path is None:
            return
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            self._state_path.write_text(json.dumps(self._measurements, indent=2, sort_keys=True))
        except OSError:
            pass

    @staticmethod
    def _find_binary() -> str:
        found = shutil.which("llama-server")
        if found:
            return found
        for candidate in _LLAMA_SERVER_CANDIDATES:
            if Path(candidate).is_file() and os.access(candidate, os.X_OK):
                return candidate
        return ""

    @property
    def available(self) -> bool:
        return bool(self._binary)

    # -- inspection --------------------------------------------------------

    def _reap(self) -> None:
        """Forget servers that died on their own, so RAM math stays truthful."""
        for model_id, entry in list(self._loaded.items()):
            if entry.process.poll() is not None:
                self._loaded.pop(model_id, None)

    def snapshot(self) -> dict[str, Any]:
        """Everything the picker needs to decide what is safe to load."""
        with self._lock:
            self._reap()
            loaded_ids = set(self._loaded)
            reclaimable = sum(entry.estimated_bytes for entry in self._loaded.values())
            loaded = [
                {
                    "modelId": entry.model_id,
                    "port": entry.port,
                    "pid": entry.process.pid,
                    "startedAt": entry.started_at,
                    "estimatedBytes": entry.estimated_bytes,
                    "contextTokens": entry.context_tokens,
                }
                for entry in self._loaded.values()
            ]

        total = _total_memory_bytes()
        available = _available_memory_bytes()
        external = _lmstudio_loaded_models(self._lmstudio_url)
        models = []
        for model in discover_models(self._measurements):
            need = model.estimated_load_bytes + SAFETY_MARGIN_BYTES
            if model.id in loaded_ids:
                fit = "loaded"
            elif need <= available:
                fit = "fits"
            elif need <= available + reclaimable:
                fit = "needs_unload"
            else:
                fit = "insufficient"
            models.append(
                {
                    "id": model.id,
                    "name": model.name,
                    "sizeBytes": model.size_bytes,
                    "architecture": model.architecture,
                    "quantization": model.quantization,
                    "maxContext": model.max_context,
                    "estimatedLoadBytes": model.estimated_load_bytes,
                    "fit": fit,
                }
            )
        return {
            "available": self.available,
            "binary": self._binary,
            "contextTokens": self._context_tokens,
            "totalBytes": total,
            "availableBytes": available,
            "reclaimableBytes": reclaimable,
            "safetyMarginBytes": SAFETY_MARGIN_BYTES,
            "models": models,
            "loaded": loaded,
            "external": external,
        }

    # -- lifecycle ---------------------------------------------------------

    def _model_by_id(self, model_id: str) -> LocalLlmModel:
        for model in discover_models(self._measurements):
            if model.id == model_id:
                return model
        raise LocalLlmError(f"Unknown local model: {model_id}")

    def load(self, model_id: str, *, unload_others: bool = True) -> dict[str, Any]:
        if not self.available:
            raise LocalLlmError("llama-server was not found on this machine. Install llama.cpp to use the prompt helper.")
        model = self._model_by_id(model_id)
        with self._lock:
            self._reap()
            if model_id in self._loaded:
                return self.snapshot()
            if unload_others:
                for other in list(self._loaded):
                    self._unload_locked(other)

            need = model.estimated_load_bytes + SAFETY_MARGIN_BYTES
            available = _available_memory_bytes()
            if need > available:
                raise LocalLlmError(
                    f"{model.name} needs about {need / 1024**3:.1f} GB but only "
                    f"{available / 1024**3:.1f} GB is available. Unload another model first."
                )

            port = _free_port()
            api_key = secrets.token_urlsafe(32)
            command = [
                self._binary,
                "--model", model.path,
                "--host", "127.0.0.1",
                "--port", str(port),
                "--ctx-size", str(self._context_tokens),
                "--n-gpu-layers", "999",
                "--alias", model_id,
                "--api-key", api_key,
                "--no-webui",
            ]
            ring: deque = deque(maxlen=_STDERR_RING_LINES)
            try:
                process = subprocess.Popen(
                    command,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    start_new_session=True,
                )
            except OSError as exc:
                raise LocalLlmError(f"Could not start llama-server: {exc}") from exc
            threading.Thread(target=_drain, args=(process.stderr, ring), daemon=True).start()

            entry = LoadedModel(
                model_id=model_id,
                port=port,
                process=process,
                api_key=api_key,
                started_at=time.time(),
                estimated_bytes=model.estimated_load_bytes,
                context_tokens=self._context_tokens,
                stderr=ring,
            )
            self._loaded[model_id] = entry

        try:
            self._await_health(entry)
        except LocalLlmError:
            with self._lock:
                self._unload_locked(model_id)
            raise

        # Replace the size-based guess with what this model actually costs, so
        # every later fit decision for it is measured rather than estimated.
        resident = _resident_bytes(process.pid)
        if resident:
            entry.estimated_bytes = resident
            self._record_measurement(model_id, resident)
        return self.snapshot()

    def _await_health(self, entry: LoadedModel) -> None:
        deadline = time.time() + LOAD_TIMEOUT_SECONDS
        url = f"http://127.0.0.1:{entry.port}/health"
        while time.time() < deadline:
            if entry.process.poll() is not None:
                tail = " | ".join(list(entry.stderr)[-4:])
                raise LocalLlmError(f"llama-server exited while loading {entry.model_id}. {tail}".strip())
            try:
                request = urllib.request.Request(url, headers={"Authorization": f"Bearer {entry.api_key}"})
                with urllib.request.urlopen(request, timeout=2) as response:
                    if response.status == 200:
                        return
            except (urllib.error.URLError, OSError, TimeoutError):
                pass
            time.sleep(0.5)
        raise LocalLlmError(f"{entry.model_id} did not become ready within {LOAD_TIMEOUT_SECONDS}s.")

    def _unload_locked(self, model_id: str) -> bool:
        entry = self._loaded.pop(model_id, None)
        if entry is None:
            return False
        process = entry.process
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                with contextlib.suppress(subprocess.TimeoutExpired):
                    process.wait(timeout=5)
        return True

    def unload(self, model_id: str) -> dict[str, Any]:
        with self._lock:
            self._reap()
            self._unload_locked(model_id)
        return self.snapshot()

    def unload_all(self) -> None:
        with self._lock:
            for model_id in list(self._loaded):
                self._unload_locked(model_id)

    # -- inference ---------------------------------------------------------

    def chat(
        self,
        *,
        model_id: str,
        messages: list[dict[str, str]],
        temperature: float = 0.8,
        # Generous because several models here are reasoning models: they spend
        # tokens on reasoning_content before writing any answer, and a tight cap
        # returns finish_reason "length" with content empty. 64 tokens produced
        # exactly that during bring-up.
        max_tokens: int = 2048,
        timeout: float = 180.0,
    ) -> str:
        with self._lock:
            self._reap()
            entry = self._loaded.get(model_id)
        if entry is None:
            raise LocalLlmError(f"{model_id} is not loaded. Load it first.")
        body = json.dumps(
            {
                "model": model_id,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "stream": False,
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{entry.port}/v1/chat/completions",
            data=body,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {entry.api_key}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise LocalLlmError(f"Local model returned HTTP {exc.code}.") from exc
        except (urllib.error.URLError, OSError, ValueError, TimeoutError) as exc:
            raise LocalLlmError(f"Local model did not answer: {exc}") from exc
        choices = payload.get("choices") or []
        if not choices:
            raise LocalLlmError("Local model returned no completion.")
        choice = choices[0]
        content = _strip_reasoning(str(choice.get("message", {}).get("content") or ""))
        if content:
            return content
        # Empty content with a length stop means the whole budget went to
        # reasoning. Say that plainly instead of handing back "".
        if choice.get("finish_reason") == "length":
            raise LocalLlmError(
                "The model spent its whole answer budget reasoning without writing a prompt. "
                "Try a smaller idea, or pick a non-reasoning model."
            )
        raise LocalLlmError("Local model returned an empty prompt.")


_THINK_RE = re.compile(r"<(think|thinking|reasoning)>.*?</\1>", re.IGNORECASE | re.DOTALL)


def _strip_reasoning(text: str) -> str:
    """Drop inline <think> blocks.

    llama-server splits reasoning into reasoning_content when the chat template
    supports it, but models that emit the tags as ordinary text slip through and
    would otherwise land in the owner's prompt box.
    """
    return _THINK_RE.sub("", text).strip()


_RUNTIME: LocalLlmRuntime | None = None
_RUNTIME_LOCK = threading.Lock()


def runtime() -> LocalLlmRuntime:
    """Process-wide runtime, so loaded servers survive across requests."""
    global _RUNTIME
    with _RUNTIME_LOCK:
        if _RUNTIME is None:
            from .config import load_config

            _RUNTIME = LocalLlmRuntime(state_path=load_config().data_dir / "local-llm-memory.json")
        return _RUNTIME
