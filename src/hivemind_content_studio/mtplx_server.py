"""Supervisor for MTPLX (github.com/youssofal/mtplx) — the native MTP
speculative-decoding server for Qwen3-Next models on Apple Silicon.

A line-for-line port of HivemindOS's runtime adapter
(hivemindos src/lib/services/runtime-adapters/mtplx-server.ts), because that
integration was measured and tuned there over days and the two apps must agree
about the one MTPLX slot on this machine. The STATE FILE IS SHARED:
``~/.hivemindos/mtplx-server.json`` — both apps read and write the same
schema, so a model loaded from either dashboard is adopted by the other.

MTPLX is single-model by design: one ``mtplx.server.openai`` process serves
exactly the checkpoint it was started with, and the server itself exposes no
load/unload endpoint. That does NOT make its models unloadable: like LM Studio
(driven through ``lms``), MTPLX is driven through its own CLI. "Load" here
means start (or replace) the server process with the requested checkpoint via
``mtplx quickstart``; "unload" means ``mtplx stop``. Tuning lives in MTPLX's
own config (``mtplx start`` onboarding, ``mtplx tune``), so the supervisor
deliberately passes no performance flags — quickstart resolves the user's
tuned profile itself.

Which checkpoints are offered is decided by ``mtplx inspect --json``
(passes_primary_gate), never by name heuristics; verdicts are cached in the
state file keyed by model ref so the scan stays cheap.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any

MTPLX_DEFAULT_PORT = 8001
_VERDICT_TTL_SECONDS = 24 * 60 * 60


def _exec(cmd: str, args: list[str], timeout: float = 30.0) -> tuple[bool, str, str]:
    try:
        proc = subprocess.run(
            [cmd, *args], capture_output=True, text=True, timeout=timeout, check=False,
        )
        return proc.returncode == 0, proc.stdout or "", proc.stderr or ""
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, "", str(exc)


def mtplx_cli_path() -> str:
    override = (os.environ.get("MTPLX_BIN") or "").strip()
    if override:
        return override
    local = Path.home() / ".local" / "bin" / "mtplx"
    if local.exists():
        return str(local)
    return "mtplx"


def mtplx_available() -> bool:
    cli = mtplx_cli_path()
    if cli == "mtplx":
        from shutil import which

        return which("mtplx") is not None
    return Path(cli).exists()


def _state_path() -> Path:
    return Path.home() / ".hivemindos" / "mtplx-server.json"


def read_mtplx_state() -> dict[str, Any] | None:
    try:
        parsed = json.loads(_state_path().read_text(encoding="utf-8"))
        if not isinstance(parsed, dict) or not isinstance(parsed.get("modelRef"), str) \
                or not isinstance(parsed.get("modelId"), str):
            return None
        parsed.setdefault("host", "127.0.0.1")
        parsed["host"] = parsed.get("host") or "127.0.0.1"
        parsed["port"] = parsed.get("port") or MTPLX_DEFAULT_PORT
        return parsed
    except (OSError, ValueError):
        return None


def write_mtplx_state(**patch: Any) -> dict[str, Any]:
    current = read_mtplx_state() or {}
    next_state: dict[str, Any] = {
        "port": MTPLX_DEFAULT_PORT,
        "host": "127.0.0.1",
        "modelRef": "",
        "modelId": "",
        **current,
        **patch,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(next_state, indent=2)}\n", encoding="utf-8")
    return next_state


def normalize_mtplx_ref(value: str) -> str:
    """A hand-started server carries the checkpoint as an absolute snapshot
    path in its argv; identity everywhere else is the HF ref. Map cache paths
    back to org/name so the two spellings compare equal."""
    trimmed = (value or "").strip()
    match = re.search(r"models--([^/\\]+)--([^/\\]+)", trimmed)
    if match:
        return f"{match.group(1)}/{match.group(2)}"
    return trimmed


def observe_running_mtplx(port: int = MTPLX_DEFAULT_PORT, served_id: str | None = None) -> dict[str, Any] | None:
    """Sync the state file from a server that is actually running: the served
    id comes from /v1/models and the checkpoint ref from the process argv, so a
    server the user started by hand is adopted instead of fought."""
    try:
        ok, stdout, _ = _exec("lsof", ["-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"], 5.0)
        pid = (stdout.strip().split() or [""])[0]
        if not pid:
            return None
        ok, stdout, _ = _exec("ps", ["-p", pid, "-o", "command="], 5.0)
        argv = stdout.strip()
        if not re.search(r"mtplx", argv, re.IGNORECASE):
            return None
        ref_match = re.search(r"--model\s+(\S+)", argv)
        id_match = re.search(r"--model-id\s+(\S+)", argv)
        profile_match = re.search(r"--profile\s+(\S+)", argv)
        model_ref = normalize_mtplx_ref(ref_match.group(1) if ref_match else "")
        model_id = served_id or (id_match.group(1) if id_match else "")
        if not model_ref and not model_id:
            return None
        current = read_mtplx_state()
        patch: dict[str, Any] = {
            "port": port,
            "modelRef": model_ref or (current or {}).get("modelRef", ""),
            "modelId": model_id or (current or {}).get("modelId", ""),
        }
        if profile_match:
            patch["profile"] = profile_match.group(1)
        return write_mtplx_state(**patch)
    except Exception:
        return None


def _ref_from_cache_dir(dirname: str) -> str:
    if not dirname.startswith("models--"):
        return ""
    return "/".join(dirname[len("models--"):].split("--"))


def _hf_cache_dir() -> Path:
    env_cache = (os.environ.get("HUGGINGFACE_HUB_CACHE") or "").strip()
    if env_cache:
        return Path(env_cache)
    env_home = (os.environ.get("HF_HOME") or "").strip()
    if env_home:
        return Path(env_home) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


_QWEN3_NEXT_RE = re.compile(r"qwen3[_.]?(?:next|5)", re.IGNORECASE)


def _likely_mtplx_family(ref: str, cache_root: Path, dirname: str) -> bool:
    """Cheap prefilter: only Qwen3-Next-family checkpoints are worth inspecting."""
    if re.search(r"mtplx", ref, re.IGNORECASE):
        return True
    try:
        snapshots = cache_root / dirname / "snapshots"
        snapshot = next(iter(sorted(entry.name for entry in snapshots.iterdir())), "")
        if not snapshot:
            return False
        config = json.loads((snapshots / snapshot / "config.json").read_text(encoding="utf-8"))
        architectures = " ".join(config.get("architectures") or [])
        return bool(_QWEN3_NEXT_RE.search(f"{architectures} {config.get('model_type') or ''}"))
    except (OSError, ValueError, StopIteration):
        return False


def mtplx_model_arg_for_ref(ref: str) -> str:
    """MTPLX's quickstart resolves bare refs against ITS OWN cache
    (~/.mtplx/models), not the HF hub cache where these checkpoints actually
    live — passing a ref for an HF-cached model fails with "not cached / mtplx
    pull". The absolute snapshot path bypasses that resolution (it is exactly
    how a hand-started server is invoked), so prefer it whenever the checkpoint
    is in the HF cache. A model dir can hold several snapshots and neither
    directory order nor refs/main is trustworthy — pick the snapshot that
    actually carries weights."""
    normalized = normalize_mtplx_ref(ref)
    try:
        dirname = "models--" + "--".join(normalized.split("/"))
        snapshots = _hf_cache_dir() / dirname / "snapshots"
        best_path, best_weights, best_files = "", -1, -1
        for entry in snapshots.iterdir():
            if entry.name.startswith("."):
                continue
            try:
                files = [item.name for item in entry.iterdir()]
            except OSError:
                files = []
            weights = sum(1 for name in files if name.endswith(".safetensors"))
            if (weights, len(files)) > (best_weights, best_files):
                best_path, best_weights, best_files = str(entry), weights, len(files)
        if best_path and best_weights > 0:
            return best_path
    except OSError:
        pass  # not in the HF cache — let mtplx resolve the ref from its own cache
    return normalized


def snapshot_size_bytes(ref: str) -> int:
    """Rough weight size for the picker's size column (best effort)."""
    arg = mtplx_model_arg_for_ref(ref)
    path = Path(arg)
    if not path.is_dir():
        return 0
    total = 0
    try:
        for item in path.iterdir():
            try:
                total += item.stat().st_size
            except OSError:
                continue
    except OSError:
        return 0
    return total


def list_mtplx_candidates() -> list[str]:
    """MTPLX-loadable checkpoint refs on this machine. The verdict is
    ``mtplx inspect --json`` passes_primary_gate — the tool's own compatibility
    gate — cached per ref for a day so the sweep costs one inspect per new
    model."""
    if not mtplx_available():
        return []
    cli = mtplx_cli_path()
    cache_root = _hf_cache_dir()
    try:
        dirs = [entry.name for entry in cache_root.iterdir() if entry.name.startswith("models--")]
    except OSError:
        return []
    refs = [
        ref for ref in (
            _ref_from_cache_dir(dirname)
            for dirname in dirs
            if _likely_mtplx_family(_ref_from_cache_dir(dirname), cache_root, dirname)
        )
        if ref
    ]
    state = read_mtplx_state()
    verdicts: dict[str, Any] = dict((state or {}).get("verdicts") or {})
    now = time.time()
    verdicts_changed = False
    loadable: list[str] = []
    for ref in refs:
        cached = verdicts.get(ref)
        if isinstance(cached, dict) and cached.get("checkedAt"):
            try:
                checked = time.mktime(time.strptime(str(cached["checkedAt"])[:19], "%Y-%m-%dT%H:%M:%S"))
            except ValueError:
                checked = 0
            if now - checked < _VERDICT_TTL_SECONDS:
                if cached.get("loadable"):
                    loadable.append(ref)
                continue
        ok, stdout, _ = _exec(cli, ["inspect", "--json", "--no-strict-exit-code", ref], 30.0)
        passes = False
        try:
            passes = json.loads(stdout).get("passes_primary_gate") is True
        except (ValueError, AttributeError):
            passes = False
        verdicts[ref] = {
            "loadable": passes,
            "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(now)),
        }
        verdicts_changed = True
        if passes:
            loadable.append(ref)
    if verdicts_changed:
        write_mtplx_state(verdicts=verdicts)
    return loadable


def mtplx_model_id_for_ref(ref: str) -> str:
    """Served-id for a checkpoint: the remembered one, else a short slug."""
    state = read_mtplx_state()
    normalized = normalize_mtplx_ref(ref)
    if state and state.get("modelRef") and normalize_mtplx_ref(state["modelRef"]) == normalized and state.get("modelId"):
        return str(state["modelId"])
    tail = normalized.split("/")[-1].lower()
    slug = re.sub(r"[^a-z0-9._-]+", "-", tail)
    return slug or normalized


def probe_served_model(port: int, timeout: float = 1.5) -> dict[str, Any] | None:
    """The first /v1/models entry of a serving MTPLX, or None. Carries the
    context length MTPLX reports, which the picker shows."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/models", timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None
    entries = data.get("data") if isinstance(data, dict) else None
    entry = entries[0] if isinstance(entries, list) and entries else None
    if not isinstance(entry, dict) or not entry.get("id"):
        return None
    return {
        "id": str(entry["id"]),
        "contextLength": int(entry.get("context_length") or entry.get("max_context_length") or 0),
    }


def _spawn_detached(cmd: str, args: list[str], log_path: Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "a") as log:
        subprocess.Popen([cmd, *args], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                         start_new_session=True)


def mtplx_load_model(ref: str, *, timeout_seconds: float = 300.0) -> dict[str, Any]:
    """Start (or replace) the MTPLX server with ``ref``. Blocking until the
    server answers with the model, mirroring the load contract the UI already
    budgets ~300s for. Never raises."""
    try:
        if not mtplx_available():
            return {"ok": False, "error": "MTPLX CLI is not installed (uv tool install mtplx)."}
        cli = mtplx_cli_path()
        state = read_mtplx_state()
        port = int((state or {}).get("port") or MTPLX_DEFAULT_PORT)
        model_id = mtplx_model_id_for_ref(ref)

        serving = probe_served_model(port)
        if serving and serving["id"] == model_id:
            observe_running_mtplx(port, serving["id"])
            return {"ok": True, "message": f"{model_id} is already serving on MTPLX :{port}."}
        if serving:
            # Single-model server: replacing is the load. mtplx stop handles
            # SIGTERM-then-SIGKILL and frees the port.
            ok, _, stderr = _exec(cli, ["stop", "--port", str(port), "--json"], 60.0)
            if not ok and probe_served_model(port):
                return {"ok": False, "error": f"Could not stop the MTPLX server on :{port}: {stderr.strip() or 'unknown'}"}

        log_path = Path.home() / ".hivemindos" / "logs" / "mtplx-server.log"
        # Restore the profile the user's server was tuned with when reloading
        # the remembered checkpoint; a different checkpoint gets MTPLX's own
        # default.
        remembered_profile = ""
        if state and state.get("profile") and normalize_mtplx_ref(state.get("modelRef", "")) == normalize_mtplx_ref(ref):
            remembered_profile = str(state["profile"])
        _spawn_detached(cli, [
            "quickstart",
            "--model", mtplx_model_arg_for_ref(ref),
            "--model-id", model_id,
            "--port", str(port),
            *(["--profile", remembered_profile] if remembered_profile else []),
            # Tools go through the model's own trained chat template. MTPLX
            # still defaults to the legacy "hybrid" contract; native is what
            # HivemindOS measured as correct (2026-08-22).
            "--tool-prompt-mode", "native",
            # DO NOT add --agent-thinking-budget here. Two independent reasons,
            # both measured/recorded in HivemindOS:
            #   1. A/B on this model (2026-08-23): no effect at all.
            #   2. vLLM #44676 — on Qwen3.5+ the model opens <tool_call> INSIDE
            #      <think> without closing it, so tool-argument tokens are
            #      charged to the thinking budget and the force-close corrupts
            #      the argument JSON (~0.5% of tool calls).
            "--yes",
        ], log_path)

        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            time.sleep(1.5)
            now = probe_served_model(port)
            if now and now["id"] == model_id:
                patch: dict[str, Any] = {"port": port, "modelRef": ref, "modelId": model_id}
                if remembered_profile:
                    patch["profile"] = remembered_profile
                write_mtplx_state(**patch)
                return {"ok": True, "message": f"MTPLX is serving {model_id} on :{port}."}
        return {"ok": False, "error": f"MTPLX did not come up with {model_id} in time; check ~/.hivemindos/logs/mtplx-server.log."}
    except Exception as exc:
        return {"ok": False, "error": str(exc) or "MTPLX load failed."}


def mtplx_unload_model() -> dict[str, Any]:
    """Stop the MTPLX server. The checkpoint stays remembered for the next load."""
    try:
        if not mtplx_available():
            return {"ok": False, "error": "MTPLX CLI is not installed."}
        cli = mtplx_cli_path()
        port = int((read_mtplx_state() or {}).get("port") or MTPLX_DEFAULT_PORT)
        serving = probe_served_model(port)
        observe_running_mtplx(port, serving["id"] if serving else None)
        ok, _, stderr = _exec(cli, ["stop", "--port", str(port), "--json"], 60.0)
        if probe_served_model(port):
            return {"ok": False, "error": f"MTPLX on :{port} is still serving: {stderr.strip() or 'stop did not take'}"}
        return {"ok": True, "message": f"Stopped the MTPLX server on :{port}."}
    except Exception as exc:
        return {"ok": False, "error": str(exc) or "MTPLX stop failed."}


def mtplx_owns_model(model: str) -> bool:
    """Does this model id (or ref) belong to the MTPLX slot?"""
    state = read_mtplx_state()
    if state and (state.get("modelId") == model
                  or normalize_mtplx_ref(state.get("modelRef", "")) == normalize_mtplx_ref(model)):
        return True
    try:
        candidates = list_mtplx_candidates()
    except Exception:
        candidates = []
    return any(ref == model or mtplx_model_id_for_ref(ref) == model for ref in candidates)


def mtplx_ref_for_model(model: str) -> str:
    """Resolve a load request (served id or HF ref) to the checkpoint ref."""
    state = read_mtplx_state()
    if state and state.get("modelId") == model and state.get("modelRef"):
        return normalize_mtplx_ref(state["modelRef"])
    if "/" in model:
        return normalize_mtplx_ref(model)
    try:
        candidates = list_mtplx_candidates()
    except Exception:
        candidates = []
    for ref in candidates:
        if mtplx_model_id_for_ref(ref) == model:
            return ref
    return ""
