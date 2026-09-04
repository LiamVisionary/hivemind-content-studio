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

from . import mtplx_server
from .settings import settings

# Where to look for GGUF weights. LM Studio's own directory is the default
# because that is where this machine keeps them; HIVEMIND_LLM_MODEL_ROOTS adds
# more (os.pathsep-separated) without editing code.
DEFAULT_MODEL_ROOTS = (
    Path.home() / ".lmstudio" / "models",
    # The studio ships its own small instruct model with the local-AI runtime.
    # Leaving this root out meant the picker's only offers were 18-36GB loads
    # while a 2.4GB Qwen3-4B sat inside the app's own data directory.
    Path.home() / "Library" / "Application Support" / "open-generative-ai" / "local-ai" / "models",
)

_LLAMA_SERVER_CANDIDATES = (
    "/opt/homebrew/bin/llama-server",
    "/usr/local/bin/llama-server",
    # Hand-built checkouts, tried only when a packaged binary cannot parse a
    # model's vision projector. Newer projector types land in llama.cpp well
    # before they reach Homebrew: measured 2026-08-09, Homebrew's b9430
    # rejects Swarm Scout's "gemma4uv" projector that the b9553 build loads.
    str(Path.home() / "src/llama.cpp-b9553/build/bin/llama-server"),
    str(Path.home() / "src/llama.cpp/build/bin/llama-server"),
)


def free_comfy_memory(timeout: float = 20.0) -> dict[str, Any]:
    """Ask the local ComfyUI to drop its models, and report what that freed.

    On a unified-memory Mac ComfyUI is the helper's real competitor: it can sit
    on tens of GB of diffusion weights long after a generation finished, and
    the picker's answer was "this model does not fit" with no way to act on it.
    ComfyUI's own /free does the unload without touching the queue, the loaded
    workflow, or cached node results.
    """
    base = settings().network.comfy_url
    before = _available_memory_bytes()
    request = urllib.request.Request(
        f"{base}/free",
        data=json.dumps({"unload_models": True, "free_memory": True}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read()
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise LocalLlmError(f"Could not reach ComfyUI at {base}: {exc}") from None
    # Freeing is asynchronous on Comfy's side; a moment's wait makes the
    # reported number the one the user will actually see in the picker.
    time.sleep(1.5)
    after = _available_memory_bytes()
    return {"freedBytes": max(0, after - before), "availableBytes": after}


def _llama_binaries() -> list[str]:
    """Every runnable llama-server, best-known first."""
    override = os.environ.get("HIVEMIND_LLAMA_SERVER", "").strip()
    candidates = ([override] if override else []) + list(_LLAMA_SERVER_CANDIDATES)
    return [c for c in candidates if Path(c).is_file() and os.access(c, os.X_OK)]

# 8k is plenty for "turn an idea into a prompt" and keeps the KV cache small
# enough that a big model still fits beside a loaded diffusion model.
DEFAULT_CONTEXT_TOKENS = 8192

# Never plan to use the last few GB. Generation work (LTX, Krea) allocates in
# large bursts, and a prompt helper that wins a race against it for the last
# gigabyte has caused an OOM, not prevented one.
SAFETY_MARGIN_BYTES = 4 * 1024**3

LOAD_TIMEOUT_SECONDS = 240
_STDERR_RING_LINES = 60
# How long one disk scan of the model roots stands in for the next.
SCAN_CACHE_SECONDS = 10.0

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
class UnavailableModel:
    """A GGUF on disk the helper cannot offer, and why.

    Reported rather than dropped: "my model is missing from the list" is a
    question the picker should answer itself.
    """

    id: str
    path: str
    reason: str


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
    # Started with a projector, so an image sent to it is actually read.
    vision: bool = False
    # True from spawn until /health answers. A load takes up to
    # LOAD_TIMEOUT_SECONDS, and during it the entry is already registered (so
    # a second load does not start a second server) — but it is not LOADED:
    # the picker must not say so, and chat must not try it.
    loading: bool = False


class LocalLlmError(RuntimeError):
    """A prompt-helper failure with a message safe to show the owner."""


class LocalLlmEmptyAnswer(LocalLlmError):
    """The model answered, but with nothing in it once reasoning is stripped.

    Its own type so a caller can tell "try again" apart from "not loaded" or
    "did not answer" without reading the message; still a LocalLlmError, so
    every existing ``except`` keeps catching it."""


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
                    handle.read(4)  # element type; _skip_gguf_value re-reads it
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


def _projector_for(model_path: Path) -> Path | None:
    """The multimodal projector shipped beside a model, if any.

    Discovery skips mmproj files because they are not loadable on their own —
    but that is exactly what makes them invisible here, and without one the
    helper writes about a reference image it has never seen."""
    try:
        candidates = sorted(
            path for path in model_path.parent.glob("*.gguf")
            if path.name.lower().startswith("mmproj") and path.is_file()
        )
    except OSError:
        return None
    return candidates[0] if candidates else None


def scan_models(
    measurements: dict[str, int] | None = None,
) -> tuple[list[LocalLlmModel], list[UnavailableModel]]:
    """Every GGUF under the configured roots, split into runnable and not.

    Vision projectors (mmproj) and the 2nd..Nth shard of a split model are
    skipped silently: neither is something the user can load on its own, and
    neither is a model they think they have.

    Everything else that cannot be run is REPORTED rather than dropped. A model
    directory is mostly symlinks into build dirs that come and go, and a
    vanished one used to be invisible twice over — first it crashed the whole
    scan (one dead link blanked the entire picker), then, once that was caught,
    it silently disappeared from a list the user reads as "what I have".

    ``measurements`` maps model id to resident bytes observed on a previous
    load; those replace the size-based guess where present.
    """
    measurements = measurements or {}
    found: list[LocalLlmModel] = []
    missing: list[UnavailableModel] = []
    for root in _model_roots():
        for path in sorted(root.rglob("*.gguf")):
            name = path.name
            if name.lower().startswith("mmproj"):
                continue
            try:
                size_bytes = path.stat().st_size
            except OSError:
                missing.append(UnavailableModel(
                    id=str(path.relative_to(root)),
                    path=str(path),
                    reason=("broken link — its target is gone" if path.is_symlink()
                            else "file cannot be read"),
                ))
                continue
            shard = _SHARD_RE.match(name)
            if shard:
                if shard.group("index") != "00001":
                    continue
                # Charge the whole split model, not just its first piece.
                size_bytes = 0
                for sibling in path.parent.glob(f"{shard.group('stem')}-*-of-{shard.group('total')}.gguf"):
                    with contextlib.suppress(OSError):
                        size_bytes += sibling.stat().st_size
            meta = _read_gguf_metadata(path)
            architecture = meta.get("general.architecture") or ""
            max_context = meta.get(f"{architecture}.context_length") if architecture else 0
            model_id = str(path.relative_to(root))
            if not architecture:
                # Not every .gguf is a language model: the local-AI runtime
                # keeps a quantized DIFFUSION model in the same directory, and
                # its header carries no architecture at all. llama-server
                # cannot serve one, so offering it would only produce a load
                # that fails a minute later.
                missing.append(UnavailableModel(
                    id=model_id, path=str(path),
                    reason="no readable model architecture — not a text model",
                ))
                continue
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
    return found, missing


def discover_models(measurements: dict[str, int] | None = None) -> list[LocalLlmModel]:
    """The runnable models only — the common case."""
    return scan_models(measurements)[0]


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


_LLAMA_PATH_RE = re.compile(r"(?<![\w/])/(?:[\w.@+%~-]+/)+[\w.@+%~-]+")


def _llama_stderr_summary(lines: list[str], *, limit: int = 240) -> str:
    """What llama-server said before it died, fit for a toast.

    It is launched with ``--model <absolute path>`` and its loader echoes that
    path, so the raw last lines named the GGUF under the owner's home. Prefer
    the one line that says "error"; reduce every path to its basename."""
    cleaned = [" ".join(str(line).split()) for line in lines if str(line).strip()]
    if not cleaned:
        return ""
    chosen = next((line for line in reversed(cleaned) if "error" in line.lower()), cleaned[-1])
    chosen = _LLAMA_PATH_RE.sub(lambda match: Path(match.group(0)).name, chosen)
    return chosen[: limit - 1].rstrip() + "…" if len(chosen) > limit else chosen


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
        # MTPLX (the shared single-model Qwen3-Next server, see mtplx_server.py):
        # probed at most every 10 s so snapshot stays cheap; candidates carry
        # their own TTL because a fresh ref costs an `mtplx inspect`.
        self._mtplx_probe: tuple[float, dict[str, Any] | None] = (0.0, None)
        self._mtplx_candidates: tuple[float, list[str]] = (0.0, [])
        self._mtplx_loading: str = ""  # model id a quickstart is bringing up
        self._loaded: dict[str, LoadedModel] = {}
        # projector path -> the llama-server build that could actually parse it.
        self._projector_binary: dict[str, str] = {}
        self._lock = threading.RLock()
        self._state_path = state_path
        self._measurements = self._read_measurements()
        # The disk scan behind snapshot(): (root mtimes, taken at, result).
        self._scan_cache: tuple[tuple[tuple[str, float], ...], float, tuple] | None = None
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
        # The scan carries each model's measured size, so it is stale now.
        self._scan_cache = None
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
        binaries = _llama_binaries()
        return binaries[0] if binaries else ""

    @property
    def available(self) -> bool:
        return bool(self._binary)

    # -- inspection --------------------------------------------------------

    def _reap(self) -> None:
        """Forget servers that died on their own, so RAM math stays truthful."""
        for model_id, entry in list(self._loaded.items()):
            if entry.process.poll() is not None:
                self._loaded.pop(model_id, None)

    def _scan_models_cached(self) -> tuple[list[LocalLlmModel], list[UnavailableModel]]:
        """scan_models(), remembered for a few seconds.

        Every runtime poll re-walked each model root with rglob and read each
        GGUF header, so the picker felt slow to open on a big model directory.
        The cache is keyed on the roots' mtimes (a model added or removed at
        the top level invalidates it at once) and expires on its own, so a
        new file deeper in the tree still shows within the TTL. Fit and the
        loaded set are NOT cached — those are recomputed on every call."""
        roots = _model_roots()
        stamps = []
        for root in roots:
            try:
                stamps.append((str(root), root.stat().st_mtime))
            except OSError:
                stamps.append((str(root), 0.0))
        key = tuple(stamps)
        now = time.monotonic()
        cached = self._scan_cache
        if cached is not None and cached[0] == key and now - cached[1] < SCAN_CACHE_SECONDS:
            return cached[2]
        result = scan_models(self._measurements)
        self._scan_cache = (key, now, result)
        return result

    def _mtplx_serving(self) -> dict[str, Any] | None:
        """The serving MTPLX model ({id, contextLength}) — cached ~10 s."""
        at, value = self._mtplx_probe
        if time.time() - at < 10.0:
            return value
        state = mtplx_server.read_mtplx_state()
        port = int((state or {}).get("port") or mtplx_server.MTPLX_DEFAULT_PORT)
        value = mtplx_server.probe_served_model(port) if mtplx_server.mtplx_available() or state else None
        if value is not None:
            value = {**value, "port": port}
        self._mtplx_probe = (time.time(), value)
        return value

    def _mtplx_candidate_refs(self) -> list[str]:
        """Loadable MTPLX checkpoints — cached 60 s (inspect verdicts persist
        for a day in the shared state file, so this is usually a dir listing)."""
        at, refs = self._mtplx_candidates
        if time.time() - at < 60.0:
            return refs
        try:
            refs = mtplx_server.list_mtplx_candidates()
        except Exception:
            refs = []
        self._mtplx_candidates = (time.time(), refs)
        return refs

    def _mtplx_models(self) -> list[dict[str, Any]]:
        """Picker rows for the MTPLX slot: the serving model first, then every
        other loadable checkpoint. MTPLX owns its own memory (quickstart
        resolves the user's tuned profile), so rows are offered as "fits" —
        the fit ladder here budgets llama-server RAM, not MTPLX's."""
        if not mtplx_server.mtplx_available() and not self._mtplx_serving():
            return []
        serving = self._mtplx_serving()
        rows: list[dict[str, Any]] = []
        seen: set[str] = set()

        def row(model_id: str, ref: str, fit: str, context: int) -> dict[str, Any]:
            name = (ref.split("/")[-1] if ref else model_id).replace("-", " ")
            return {
                "id": model_id,
                "name": name,
                "sizeBytes": mtplx_server.snapshot_size_bytes(ref) if ref else 0,
                "architecture": "Qwen3-Next",
                "quantization": "MTPLX",
                "maxContext": context,
                "estimatedLoadBytes": mtplx_server.snapshot_size_bytes(ref) if ref else 0,
                "fit": fit,
                "vision": False,
                "provider": "mtplx",
            }

        state = mtplx_server.read_mtplx_state() or {}
        if serving:
            ref = str(state.get("modelRef") or "") if state.get("modelId") == serving["id"] else ""
            rows.append(row(serving["id"], ref, "loaded", int(serving.get("contextLength") or 0)))
            seen.add(serving["id"])
        if self._mtplx_loading and self._mtplx_loading not in seen:
            ref = mtplx_server.mtplx_ref_for_model(self._mtplx_loading)
            rows.append(row(self._mtplx_loading, ref, "loading", 0))
            seen.add(self._mtplx_loading)
        for ref in self._mtplx_candidate_refs():
            model_id = mtplx_server.mtplx_model_id_for_ref(ref)
            if model_id in seen:
                continue
            rows.append(row(model_id, ref, "fits", 0))
            seen.add(model_id)
        return rows

    def _mtplx_model_ids(self) -> set[str]:
        serving = self._mtplx_serving()
        ids = {serving["id"]} if serving else set()
        if self._mtplx_loading:
            ids.add(self._mtplx_loading)
        for ref in self._mtplx_candidate_refs():
            ids.add(mtplx_server.mtplx_model_id_for_ref(ref))
        return ids

    def snapshot(self) -> dict[str, Any]:
        """Everything the picker needs to decide what is safe to load."""
        with self._lock:
            self._reap()
            loaded_ids = {model_id for model_id, entry in self._loaded.items() if not entry.loading}
            loading_ids = {model_id for model_id, entry in self._loaded.items() if entry.loading}
            reclaimable = sum(entry.estimated_bytes for entry in self._loaded.values())
            loaded = [
                {
                    "modelId": entry.model_id,
                    "port": entry.port,
                    "pid": entry.process.pid,
                    "startedAt": entry.started_at,
                    "estimatedBytes": entry.estimated_bytes,
                    "contextTokens": entry.context_tokens,
                    "loading": bool(entry.loading),
                }
                for entry in self._loaded.values()
            ]

        total = _total_memory_bytes()
        available = _available_memory_bytes()
        external = _lmstudio_loaded_models(self._lmstudio_url)
        models = []
        runnable, unavailable = self._scan_models_cached()
        for model in runnable:
            need = model.estimated_load_bytes + SAFETY_MARGIN_BYTES
            if model.id in loaded_ids:
                fit = "loaded"
            elif model.id in loading_ids:
                # Its server is up but not answering /health yet. Not
                # "loaded" — a Write against it would be refused — and not
                # "fits" either, or the picker would offer to load it again.
                fit = "loading"
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
                    # Ships a projector, so it can look at a start frame. Once
                    # loaded the running server's answer replaces the guess.
                    "vision": (self._loaded[model.id].vision if model.id in loaded_ids | loading_ids
                               else _projector_for(Path(model.path)) is not None),
                }
            )
        models.extend(self._mtplx_models())
        return {
            "available": self.available or bool(models),
            "binary": self._binary,
            "contextTokens": self._context_tokens,
            "totalBytes": total,
            "availableBytes": available,
            "reclaimableBytes": reclaimable,
            "safetyMarginBytes": SAFETY_MARGIN_BYTES,
            "models": models,
            # What is on disk but cannot be offered, so "where did my model go"
            # is answered in the picker instead of over the shoulder.
            "unavailable": [
                {"id": entry.id, "path": entry.path, "reason": entry.reason}
                for entry in unavailable
            ],
            "loaded": loaded,
            "external": external,
        }

    # -- lifecycle ---------------------------------------------------------

    def loaded_model_ids(self) -> list[str]:
        """Ids of the llama-servers this process has up right now.

        The cheap answer to "is anything loaded?": ``snapshot()`` also says so,
        but it rescans the model roots and probes LM Studio on the way, which a
        request that only needs to pick a loaded model should not pay for."""
        with self._lock:
            self._reap()
            ids = [model_id for model_id, entry in self._loaded.items() if not entry.loading]
        serving = self._mtplx_serving()
        if serving and serving["id"] not in ids:
            ids.append(serving["id"])
        return ids

    def model_sees_images(self, model_id: str) -> bool:
        """Whether an image sent to this model is actually read.

        Authoritative once loaded: a projector file sitting beside a model is
        only a promise, and it is broken whenever the running llama-server
        cannot parse that projector type."""
        with self._lock:
            entry = self._loaded.get(model_id)
        if entry is not None:
            return entry.vision
        if model_id in self._mtplx_model_ids():
            return False
        try:
            return _projector_for(Path(self._model_by_id(model_id).path)) is not None
        except LocalLlmError:
            return False

    def _model_by_id(self, model_id: str) -> LocalLlmModel:
        for model in discover_models(self._measurements):
            if model.id == model_id:
                return model
        raise LocalLlmError(f"Unknown local model: {model_id}")

    def load(self, model_id: str, *, unload_others: bool = True) -> dict[str, Any]:
        if model_id in self._mtplx_model_ids() or mtplx_server.mtplx_owns_model(model_id):
            return self._load_mtplx(model_id)
        if not self.available:
            raise LocalLlmError("llama-server was not found on this machine. Install llama.cpp to use the prompt helper.")
        model = self._model_by_id(model_id)
        with self._lock:
            self._reap()
            current = self._loaded.get(model_id)
            if current is not None:
                # A second load while the first is still coming up (another
                # tab, a double click) says "loading" and starts nothing.
                return {**self.snapshot(), "status": "loading" if current.loading else "loaded"}
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

        # Vision is a bonus, never a precondition. A projector the available
        # llama-server cannot parse used to take the whole load down with
        # "unknown projector type: gemma4uv" — Scout's projector needs b9553
        # and Homebrew ships b9430 — so each capable binary is tried with the
        # projector, and the last attempt always drops it.
        projector = _projector_for(Path(model.path))
        attempts: list[tuple[str, Path | None]] = []
        if projector is not None:
            binaries = _llama_binaries()
            # A binary already proven against this projector goes first, so the
            # ~2s rejection is paid once per session rather than on every load.
            known = self._projector_binary.get(str(projector))
            if known in binaries:
                binaries = [known] + [b for b in binaries if b != known]
            attempts += [(binary, projector) for binary in binaries]
        attempts.append((self._binary, None))

        last_error: LocalLlmError | None = None
        for binary, mmproj in attempts:
            with self._lock:
                entry = self._spawn_locked(model_id, model, binary, mmproj)
            try:
                self._await_health(entry)
            except LocalLlmError as exc:
                last_error = exc
                with self._lock:
                    self._unload_locked(model_id)
                continue

            # Replace the size-based guess with what this model actually costs,
            # so every later fit decision for it is measured, not estimated.
            if mmproj is not None:
                self._projector_binary[str(mmproj)] = binary
            resident = _resident_bytes(entry.process.pid)
            if resident:
                entry.estimated_bytes = resident
                self._record_measurement(model_id, resident)
            return {**self.snapshot(), "status": "loaded"}

        raise last_error or LocalLlmError(f"Could not start llama-server for {model_id}.")

    def _spawn_locked(
        self, model_id: str, model: LocalLlmModel, binary: str, projector: Path | None,
    ) -> LoadedModel:
        port = _free_port()
        api_key = secrets.token_urlsafe(32)
        command = [
            binary,
            "--model", model.path,
            "--host", "127.0.0.1",
            "--port", str(port),
            "--ctx-size", str(self._context_tokens),
            "--n-gpu-layers", "999",
            "--alias", model_id,
            "--api-key", api_key,
            "--no-webui",
            # Reasoning fine-tunes (swarm-sovereign-12b measured) burn the
            # entire max_tokens budget on reasoning_content and return an
            # empty prompt; the helper only ever wants the direct answer.
            "--reasoning", "off",
        ]
        if projector is not None:
            # llama-server only auto-detects a projector for -hf downloads,
            # and we load by path.
            command += ["--mmproj", str(projector)]
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
            vision=projector is not None,
            loading=True,
        )
        self._loaded[model_id] = entry
        return entry

    def _await_health(self, entry: LoadedModel) -> None:
        deadline = time.time() + LOAD_TIMEOUT_SECONDS
        url = f"http://127.0.0.1:{entry.port}/health"
        while time.time() < deadline:
            if entry.process.poll() is not None:
                tail = _llama_stderr_summary(list(entry.stderr)[-6:])
                raise LocalLlmError(f"llama-server exited while loading {entry.model_id}. {tail}".strip())
            try:
                request = urllib.request.Request(url, headers={"Authorization": f"Bearer {entry.api_key}"})
                with urllib.request.urlopen(request, timeout=2) as response:
                    if response.status == 200:
                        entry.loading = False
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

    def _load_mtplx(self, model_id: str) -> dict[str, Any]:
        """Start (or adopt) the MTPLX server for this checkpoint. Blocking,
        like the llama path — the dialog budgets minutes for a load. The
        "unload others" sweep never touches MTPLX: it may be serving another
        app's chat, and stopping it is an explicit act (the row's Unload)."""
        serving = self._mtplx_serving()
        if serving and serving["id"] == model_id:
            return {**self.snapshot(), "status": "loaded"}
        ref = mtplx_server.mtplx_ref_for_model(model_id)
        if not ref:
            raise LocalLlmError(f"Unknown MTPLX model: {model_id}")
        self._mtplx_loading = model_id
        self._mtplx_probe = (0.0, None)
        try:
            result = mtplx_server.mtplx_load_model(ref)
            if not result.get("ok"):
                raise LocalLlmError(str(result.get("error") or "MTPLX load failed."))
        finally:
            self._mtplx_loading = ""
            self._mtplx_probe = (0.0, None)
        return {**self.snapshot(), "status": "loaded"}

    def unload(self, model_id: str) -> dict[str, Any]:
        serving = self._mtplx_serving()
        if serving and serving["id"] == model_id:
            result = mtplx_server.mtplx_unload_model()
            self._mtplx_probe = (0.0, None)
            if not result.get("ok"):
                raise LocalLlmError(str(result.get("error") or "MTPLX stop failed."))
            return {**self.snapshot(), "freedBytes": 0}
        return self._unload_llama(model_id)

    def _unload_llama(self, model_id: str) -> dict[str, Any]:
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
        image: str | None = None,
        # Several pictures in ONE turn (the persona look is read from up to
        # three photos of the same person). ``image`` stays for the single
        # start-frame callers; both land on the same user message, in order.
        images: list[str] | None = None,
    ) -> str:
        with self._lock:
            self._reap()
            entry = self._loaded.get(model_id)
        if entry is None:
            serving = self._mtplx_serving()
            if serving and serving["id"] == model_id:
                return self._chat_mtplx(
                    port=int(serving["port"]), model_id=model_id, messages=messages,
                    max_tokens=max_tokens, timeout=timeout,
                )
            raise LocalLlmError(f"{model_id} is not loaded. Load it first.")
        if entry.loading:
            # Asking now gets "Connection refused" in urlopen's words; say
            # what is actually happening.
            raise LocalLlmError(f"{model_id} is still loading — try again in a moment.")
        attached = [url for url in ([image] if image else []) + list(images or []) if url]
        if attached:
            # Attach to the LAST user turn, so a corrective follow-up does not
            # re-send the image and double the vision cost.
            messages = [dict(message) for message in messages]
            for message in reversed(messages):
                if message.get("role") == "user":
                    message["content"] = [
                        {"type": "text", "text": message.get("content") or ""},
                        *({"type": "image_url", "image_url": {"url": url}} for url in attached),
                    ]
                    break
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
        raise LocalLlmEmptyAnswer("Local model returned an empty prompt.")

    def _chat_mtplx(
        self, *, port: int, model_id: str, messages: list[dict[str, str]],
        max_tokens: int, timeout: float,
    ) -> str:
        """One completion against the MTPLX server.

        Deliberately NO sampling fields: HivemindOS measured that the server's
        launch defaults mirror the model's own generation_config (Qwen3.8:
        temperature 1.0), which is the vendor's setting for general/creative
        turns — exactly what prompt writing is. The coding/agent profile
        (0.6/0.95/20) only applies to tool-calling turns, which this is not.
        Qwen3.8 reasons before answering; the budget stays generous and the
        <think> block is stripped like every other reasoning model here."""
        body = json.dumps({
            "model": model_id,
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": False,
        }).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/v1/chat/completions",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise LocalLlmError(f"MTPLX returned HTTP {exc.code}.") from exc
        except (urllib.error.URLError, OSError, ValueError, TimeoutError) as exc:
            raise LocalLlmError(f"MTPLX did not answer: {exc}") from exc
        choices = payload.get("choices") or []
        if not choices:
            raise LocalLlmError("MTPLX returned no completion.")
        choice = choices[0]
        content = _strip_reasoning(str(choice.get("message", {}).get("content") or ""))
        if content:
            return content
        if choice.get("finish_reason") == "length":
            raise LocalLlmError(
                "The model spent its whole answer budget reasoning without writing a prompt. "
                "Try a smaller idea."
            )
        raise LocalLlmEmptyAnswer("Local model returned an empty prompt.")


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


def runtime_if_started() -> LocalLlmRuntime | None:
    """The runtime only if something already asked for one.

    Shutdown uses this: `runtime()` would CREATE a runtime (and read state off
    disk) on the way out of a process that never loaded a model.
    """
    with _RUNTIME_LOCK:
        return _RUNTIME
