"""What a registered workflow needs from the lane that will run it, and the
installers for what is missing.

Liam pressed Generate on MiniMax H3 Turbo on a Mac whose ComfyUI has no
SpectrumApplyMiniMaxH3 node (or any of the H3 weights) and the answer was a
refusal after the fact. A production app checks BEFORE: this module reads the
workflow's own API graph, asks the lane what it has, and names each thing it
lacks together with where it comes from — so the studio can prompt, install
inline with live progress, restart the lane, and re-check.

Two oracles, both the lane's own:

* `/object_info/<class_type>` — empty for a node class the lane has not
  loaded, and for a loaded one it carries every loader input's combo options,
  which is the list of model files that lane can see. No second inventory.
* `/system_stats` — the accelerator the lane runs on, for workflows whose
  weights are built for one kind of card (H3's nvfp4 text encoder needs
  Blackwell), so a Mac is told "this cannot run here, run it rented" instead
  of being offered 43 GB it could never load.

Where a missing thing comes from is data, not code: `custom_node_dependencies`
and `model_dependencies` on the registry entry (inherited down the `inherits`
chain the same way the MCP resolves it), then ComfyUI-Manager's own
extension-node-map for any node class the registry does not name. A node the
map attributes to ComfyUI itself is a core node newer than the lane's
ComfyUI, which is an update, not an install — reported, never attempted.

Installs reuse the download-job records the Civitai downloader already keeps
(history.download_jobs): same persistence, same progress and cancel shape,
same route the browser already polls. Model files land under
ComfyUI/models/<folder> with a resumable .part, sizes and SHA-256 checked
when the registry knows them; custom nodes are cloned from GitHub only,
pinned to the registry's commit, with their requirements installed into the
lane's own venv. New nodes load on restart, which ComfyUI-Manager performs
in place (os.execv, same pid) so the stack supervisor never sees a death.
"""
import hashlib
import json
import os
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from http.client import HTTPException
from urllib.parse import quote, urlparse
from urllib.request import Request

from gateway import config, history, lanes, net, util

REGISTRY_PATH = config.BASE / "workflow-registry.json"
MANAGER_NODE_MAP = config.COMFY / "custom_nodes" / "ComfyUI-Manager" / "extension-node-map.json"
COMFY_CORE_REPO = "https://github.com/comfyanonymous/ComfyUI"
# The one place a model file may be written: a registry entry names a folder
# under it, never a path.
MODEL_FOLDERS = {
    "checkpoints", "diffusion_models", "unet", "text_encoders", "clip", "clip_vision", "vae",
    "loras", "controlnet", "embeddings", "upscale_models", "latent_upscale_models", "SEEDVR2",
    "sam3", "style_models", "photomaker", "gligen", "hypernetworks", "audio_encoders",
}
MODEL_EXTENSIONS = (".safetensors", ".sft", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx")
# Custom nodes are cloned from GitHub only: an install is code the lane will
# import, and this is the one host the registry, the rental manifest and
# ComfyUI-Manager's map all point at.
GIT_HOSTS = {"github.com", "www.github.com"}
# A lane's object_info answers are cached briefly: a preflight asks one
# question per node class and the studio re-asks on every model change.
_OBJECT_INFO_TTL = 30.0
_object_info_cache = {}
_object_info_lock = threading.Lock()


class LaneUnreachable(RuntimeError):
    """The lane did not answer /object_info or /system_stats at all."""


# --- the registry, resolved the way the MCP resolves it ------------------------

def _merge(base, override):
    if not isinstance(base, dict) or not isinstance(override, dict):
        return json.loads(json.dumps(override))
    out = json.loads(json.dumps(base))
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = json.loads(json.dumps(value))
    return out


def load_registry(path=None):
    """id -> definition with `inherits` folded in (child wins, dicts deep-merged)."""
    source = Path(path or REGISTRY_PATH)
    try:
        data = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    items = data.get("workflows") if isinstance(data, dict) else data
    if isinstance(items, dict):
        items = list(items.values())
    definitions = {}
    for item in items or []:
        if isinstance(item, dict) and str(item.get("id") or "").strip():
            definitions[str(item["id"]).strip()] = item
    resolved = {}

    def resolve(workflow_id, trail=()):
        if workflow_id in resolved:
            return resolved[workflow_id]
        item = definitions.get(workflow_id)
        if item is None:
            raise KeyError(workflow_id)
        if workflow_id in trail:
            raise RuntimeError(f"workflow inheritance cycle at {workflow_id}")
        parent = str(item.get("inherits") or "").strip()
        merged = _merge(resolve(parent, trail + (workflow_id,)), item) if parent else json.loads(json.dumps(item))
        merged.pop("inherits", None)
        merged["id"] = workflow_id
        resolved[workflow_id] = merged
        return merged

    for workflow_id in definitions:
        try:
            resolve(workflow_id)
        except (KeyError, RuntimeError):
            continue
    return resolved


def workflow_definition(workflow_id, registry=None):
    return (registry if registry is not None else load_registry()).get(str(workflow_id or "").strip())


def workflow_graph_path(definition):
    """The API graph a registry entry ships: `comfy:<rel>` lives under the
    ComfyUI install, anything else under the gateway's own workflows/."""
    raw = str(definition.get("api_workflow") or definition.get("workflow_file") or "").strip()
    if not raw:
        return None
    if raw.startswith("comfy:"):
        return (config.COMFY / raw[len("comfy:"):]).expanduser()
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (config.BASE / path)


def _graph_roots():
    """Where a registry entry's graph may live: the gateway's own workflows/
    and the ComfyUI install's workflows/ (`comfy:` paths point there). The
    auto-workflow loader only trusts its drop-in folders, and a registered
    `comfy:` graph lives beside the user's workflows rather than in them."""
    return [root.resolve() for root in (config.REGISTRY_WORKFLOW_DIR, config.COMFY / "workflows")]


def load_workflow_graph(definition):
    path = workflow_graph_path(definition)
    if path is None:
        raise RuntimeError(f"workflow {definition.get('id')} ships no API graph")
    resolved = Path(path).expanduser().resolve()
    if resolved.suffix.lower() != ".json" or not any(str(resolved).startswith(f"{root}{os.sep}") for root in _graph_roots()):
        raise RuntimeError(f"workflow graph is outside the workflow folders: {resolved.name}")
    if not resolved.is_file():
        raise RuntimeError(f"workflow graph is missing on this machine: {resolved.name}")
    try:
        data = json.loads(resolved.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise RuntimeError(f"{resolved.name} is not valid JSON") from exc
    graph = data.get("prompt") if isinstance(data, dict) and isinstance(data.get("prompt"), dict) else data
    if not isinstance(graph, dict) or not graph or not all(
        isinstance(node, dict) and node.get("class_type") for node in graph.values()
    ):
        raise RuntimeError(f"{resolved.name} is not an API-format ComfyUI graph")
    return graph


# --- what the graph asks for --------------------------------------------------

def _looks_like_model_file(value):
    return isinstance(value, str) and value.strip() and value.lower().endswith(MODEL_EXTENSIONS)


def graph_requirements(graph):
    """{class_type: [(node_id, input_key, filename), ...]} — every node class the
    graph uses, and for each, the model files its inputs name."""
    wanted = {}
    for node_id, node in (graph or {}).items():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type") or "").strip()
        if not class_type:
            continue
        files = wanted.setdefault(class_type, [])
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        for key, value in inputs.items():
            if _looks_like_model_file(value):
                files.append((str(node_id), str(key), value.strip()))
    return wanted


# --- what the lane has ---------------------------------------------------------

def _lane_json(lane, path, timeout=8.0):
    request = lanes.comfy_lane_request(lane, path)
    try:
        with net.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except HTTPError as exc:
        if exc.code == 404:
            return {}
        raise LaneUnreachable(f"lane {lane} answered {exc.code} to {path}") from exc
    except (URLError, OSError, ValueError, HTTPException) as exc:
        raise LaneUnreachable(f"lane {lane} did not answer {path}: {exc}") from exc


def lane_object_info(lane, class_type):
    """The lane's schema for one node class, or None when it has no such class."""
    key = (lane, class_type)
    now = time.monotonic()
    with _object_info_lock:
        cached = _object_info_cache.get(key)
        if cached and cached[0] > now:
            return cached[1]
    # A node class is a Python identifier almost always, but a pack may name
    # one with spaces or slashes ("Sol-Attn (tau 0 = off)"): quote it, or the
    # request itself is malformed and the whole preflight falls over.
    payload = _lane_json(lane, f"/object_info/{quote(class_type, safe='')}")
    spec = payload.get(class_type) if isinstance(payload, dict) else None
    spec = spec if isinstance(spec, dict) else None
    with _object_info_lock:
        _object_info_cache[key] = (now + _OBJECT_INFO_TTL, spec)
    return spec


def forget_lane_object_info(lane=None):
    with _object_info_lock:
        for key in list(_object_info_cache):
            if lane is None or key[0] == lane:
                _object_info_cache.pop(key, None)


def _combo_options(spec, input_key):
    """The choices a loader input offers, or None when the input is not a combo."""
    for section in ("required", "optional"):
        entry = (spec.get("input") or {}).get(section, {}).get(input_key)
        if entry is None:
            continue
        options = entry[0] if isinstance(entry, (list, tuple)) and entry else entry
        if isinstance(options, list):
            return [str(option) for option in options]
        if isinstance(options, dict) and isinstance(options.get("options"), list):
            return [str(option) for option in options["options"]]
        return None
    return None


def lane_facts(lane):
    """The accelerator and version the lane reports."""
    stats = _lane_json(lane, "/system_stats")
    devices = stats.get("devices") if isinstance(stats, dict) else None
    kinds = []
    for device in devices or []:
        if isinstance(device, dict):
            kind = str(device.get("type") or "").lower()
            if kind and kind not in kinds:
                kinds.append(kind)
    system = stats.get("system") if isinstance(stats, dict) else {}
    return {
        "accelerators": kinds,
        "comfyui_version": str((system or {}).get("comfyui_version") or ""),
        "os": str((system or {}).get("os") or ""),
    }


# --- where a missing thing comes from -------------------------------------------

def _manager_node_map():
    try:
        data = json.loads(MANAGER_NODE_MAP.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    out = {}
    for repo, entry in data.items():
        classes = entry[0] if isinstance(entry, (list, tuple)) and entry else []
        meta = entry[1] if isinstance(entry, (list, tuple)) and len(entry) > 1 and isinstance(entry[1], dict) else {}
        for class_type in classes or []:
            out.setdefault(str(class_type), (str(repo), str(meta.get("title_aux") or "")))
    return out


def _repo_name(repo):
    tail = urlparse(repo).path.rstrip("/").rsplit("/", 1)[-1]
    tail = tail[:-4] if tail.endswith(".git") else tail
    return util.safe_name(tail) if tail else ""


def _github_repo(repo):
    parsed = urlparse(str(repo or "").strip())
    return parsed.scheme == "https" and parsed.hostname in GIT_HOSTS and parsed.path.count("/") >= 2


def _custom_node_source(definition, class_type, node_map):
    # Nodes the registry knows ship inside ComfyUI itself (H3's own nodes
    # landed in core on 2026-08-03): a lane without them is behind, and the
    # Manager map on disk may predate them, so the registry says so first.
    if class_type in (definition.get("core_node_classes") or []):
        return {"core": True, "provenance": "registry"}
    for item in definition.get("custom_node_dependencies") or []:
        if not isinstance(item, dict):
            continue
        if class_type in (item.get("class_types") or []):
            repo = str(item.get("repo") or "").strip()
            return {
                "name": util.safe_name(str(item.get("name") or _repo_name(repo))),
                "repo": repo,
                "commit": str(item.get("commit") or "").strip(),
                "pip": item.get("pip", True) is not False,
                "provenance": "registry",
            }
    mapped = node_map.get(class_type)
    if mapped:
        repo, title = mapped
        if repo.rstrip("/") == COMFY_CORE_REPO:
            return {"core": True, "provenance": "comfyui-manager"}
        return {"name": _repo_name(repo), "repo": repo, "commit": "", "pip": True, "title": title, "provenance": "comfyui-manager"}
    return None


def _model_source(definition, filename):
    wanted = os.path.basename(filename).lower()
    for item in definition.get("model_dependencies") or []:
        if not isinstance(item, dict):
            continue
        relative = str(item.get("relativePath") or item.get("relative_path") or item.get("file") or "")
        if os.path.basename(relative).lower() == wanted:
            folder = str(item.get("folder") or relative.split("/", 1)[0] or "").strip()
            return {
                "url": str(item.get("url") or "").strip(),
                "folder": folder,
                "relative_path": relative or f"{folder}/{filename}",
                "bytes": int(item.get("bytes") or 0),
                "sha256": str(item.get("sha256") or "").strip().lower(),
                "provenance": "registry",
            }
    return None


# --- the preflight -------------------------------------------------------------

def _hardware_verdict(definition, facts):
    hardware = definition.get("hardware") if isinstance(definition.get("hardware"), dict) else {}
    wanted = str(hardware.get("accelerator") or "").strip().lower()
    verdict = {"supported": True, "reason": "", "accelerators": facts.get("accelerators") or []}
    if wanted and facts.get("accelerators") and wanted not in facts["accelerators"]:
        verdict["supported"] = False
        verdict["required"] = wanted
        verdict["reason"] = str(hardware.get("reason") or f"this workflow needs a {wanted} card") 
    return verdict


def check_workflow(workflow_id, lane="default", registry=None):
    """Everything the lane lacks for this workflow, each with its source.

    Never raises for a lane that answers. `ok` is True when nothing is missing
    and the hardware fits; `known` is False for an id the registry does not
    carry (the MCP's synthesized variants), which the studio treats as "no
    preflight" rather than "nothing missing"."""
    definition = workflow_definition(workflow_id, registry)
    checked_at = util.now_iso()
    if definition is None:
        return {"ok": True, "known": False, "workflow_id": workflow_id, "lane": lane, "missing": [], "checked_at": checked_at}
    remote = bool(lanes.comfy_lane_is_remote(lane))
    try:
        graph = load_workflow_graph(definition)
    except RuntimeError as exc:
        return {"ok": True, "known": False, "workflow_id": workflow_id, "lane": lane, "missing": [], "detail": str(exc), "checked_at": checked_at}
    facts = lane_facts(lane)
    hardware = _hardware_verdict(definition, facts)
    node_map = _manager_node_map()
    missing = []
    satisfied = 0
    seen = set()
    for class_type, files in graph_requirements(graph).items():
        spec = lane_object_info(lane, class_type)
        if spec is None:
            source = _custom_node_source(definition, class_type, node_map)
            item = {
                "id": f"node:{class_type}",
                "kind": "custom_node",
                "class_type": class_type,
                "name": (source or {}).get("name") or class_type,
                "installable": bool(source and not source.get("core") and _github_repo(source.get("repo"))) and not remote,
                "source": source,
            }
            if source and source.get("core"):
                item["kind"] = "comfyui"
                item["reason"] = (
                    f"{class_type} is part of ComfyUI itself in a newer release than this lane runs "
                    f"({facts.get('comfyui_version') or 'unknown version'}). Update ComfyUI on this machine, then try again."
                )
            elif not source:
                item["reason"] = f"No known source for the node pack that provides {class_type}."
            elif remote:
                item["reason"] = "Rented machines are provisioned with their node packs; re-provision the machine instead."
            if item["id"] not in seen:
                seen.add(item["id"])
                missing.append(item)
            continue
        satisfied += 1
        for node_id, input_key, filename in files:
            options = _combo_options(spec, input_key)
            if options is None:
                continue
            names = {os.path.basename(option).lower() for option in options} | {option.lower() for option in options}
            if filename.lower() in names or os.path.basename(filename).lower() in names:
                satisfied += 1
                continue
            source = _model_source(definition, filename)
            item_id = f"model:{os.path.basename(filename)}"
            if item_id in seen:
                continue
            seen.add(item_id)
            missing.append({
                "id": item_id,
                "kind": "model",
                "name": os.path.basename(filename),
                "class_type": class_type,
                "input": input_key,
                "node_id": node_id,
                "bytes": (source or {}).get("bytes") or 0,
                "installable": bool(source and source.get("url") and source.get("folder") in MODEL_FOLDERS) and not remote,
                "source": source,
                **({"reason": "Rented machines are provisioned with their models; re-provision the machine instead."} if remote and source else {}),
                **({"reason": f"No known download for {os.path.basename(filename)}. Place it in ComfyUI/models/{_guess_folder(input_key)} yourself."} if not source else {}),
            })
    for item in missing:
        if not hardware["supported"]:
            item["installable"] = False
            item["blocked_by"] = "hardware"
    return {
        "ok": not missing and hardware["supported"],
        "known": True,
        "workflow_id": workflow_id,
        "title": str(definition.get("title") or definition.get("label") or workflow_id),
        "lane": lane,
        "remote": remote,
        "hardware": hardware,
        "comfyui_version": facts.get("comfyui_version"),
        "missing": missing,
        "missing_bytes": sum(int(item.get("bytes") or 0) for item in missing if item.get("kind") == "model"),
        "satisfied": satisfied,
        "checked_at": checked_at,
    }


def _guess_folder(input_key):
    key = str(input_key or "").lower()
    if "lora" in key:
        return "loras"
    if "vae" in key:
        return "vae"
    if "clip" in key or "text_encoder" in key:
        return "text_encoders"
    if "unet" in key or "diffusion" in key:
        return "diffusion_models"
    if "ckpt" in key or "checkpoint" in key:
        return "checkpoints"
    return "<folder>"


# --- installers ------------------------------------------------------------------

def _job(job_id):
    with history.download_jobs_lock:
        rec = history.download_jobs.get(job_id)
        return dict(rec) if rec else None


def _cancel_requested(job_id):
    rec = _job(job_id)
    return bool(rec and rec.get("cancel_requested"))


def _models_root():
    return (config.COMFY / "models").resolve()


def _model_destination(folder, filename):
    if folder not in MODEL_FOLDERS:
        raise RuntimeError(f"refusing to write models into {folder!r}")
    name = util.safe_name(os.path.basename(str(filename or "")))
    if not name or not name.lower().endswith(MODEL_EXTENSIONS):
        raise RuntimeError("refusing a model file without a model extension")
    dest = (_models_root() / folder / name).resolve()
    if not str(dest).startswith(str(_models_root()) + os.sep):
        raise RuntimeError("refusing to write outside ComfyUI models directory")
    return dest


def download_url(url, dest, *, expected_bytes=0, sha256="", progress_cb=None, should_cancel=None):
    """Fetch a public model file to `dest` with a resumable .part, verifying
    size and hash when known. Raises DownloadCancelled on cancel and leaves
    the .part behind so the next attempt resumes it."""
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise RuntimeError("model downloads must be https URLs")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    done = tmp.stat().st_size if tmp.exists() else 0
    headers = {"User-Agent": "hivemind-content-studio/media-gateway"}
    if done:
        headers["Range"] = f"bytes={done}-"
    try:
        response = net.urlopen(Request(url, headers=headers), timeout=60)
    except HTTPError as exc:
        if exc.code == 416 and done and (not expected_bytes or done >= expected_bytes):
            response = None  # the part is already whole
        else:
            raise RuntimeError(f"download refused ({exc.code}) for {dest.name}") from exc
    mode = "ab"
    if response is not None:
        with response:
            status = getattr(response, "status", 200)
            if done and status != 206:
                # The server ignored the range: start over rather than corrupt.
                done = 0
                mode = "wb"
            length = response.headers.get("Content-Length")
            total = done + int(length) if length and str(length).isdigit() else (expected_bytes or 0)
            if progress_cb:
                progress_cb(done, total)
            with tmp.open(mode) as handle:
                while True:
                    if should_cancel and should_cancel():
                        raise DownloadCancelled("Download cancelled")
                    chunk = response.read(4 * 1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    done += len(chunk)
                    if progress_cb:
                        progress_cb(done, total)
    size = tmp.stat().st_size
    if expected_bytes and size != expected_bytes:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"{dest.name} arrived at {size} bytes, expected {expected_bytes}; the partial file was discarded")
    if sha256:
        digest = hashlib.sha256()
        with tmp.open("rb") as handle:
            for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != sha256:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"{dest.name} failed its SHA-256 check; the file was discarded")
    tmp.replace(dest)
    return dest


class DownloadCancelled(Exception):
    pass


def _comfy_python():
    for candidate in (config.COMFY / ".venv" / "bin" / "python", config.COMFY / "venv" / "bin" / "python"):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return ""


def _run(cmd, cwd=None, timeout=1800):
    completed = subprocess.run(cmd, cwd=str(cwd) if cwd else None, capture_output=True, text=True, timeout=timeout, check=False)
    if completed.returncode != 0:
        tail = (completed.stderr or completed.stdout or "").strip().splitlines()[-3:]
        raise RuntimeError(f"{' '.join(cmd[:2])} failed: {' / '.join(tail) or 'no output'}")
    return completed


def install_custom_node(source, *, progress_cb=None, should_cancel=None):
    """Clone a node pack from GitHub into custom_nodes, pin it when the
    registry pins it, and install its requirements into the lane's venv."""
    repo = str(source.get("repo") or "").strip()
    if not _github_repo(repo):
        raise RuntimeError("custom nodes are installed from github.com only")
    name = util.safe_name(str(source.get("name") or _repo_name(repo)))
    if not name:
        raise RuntimeError("the node pack has no usable directory name")
    root = (config.COMFY / "custom_nodes").resolve()
    target = (root / name).resolve()
    if not str(target).startswith(str(root) + os.sep):
        raise RuntimeError("refusing to write outside custom_nodes")
    if progress_cb:
        progress_cb("cloning")
    if not target.exists():
        _run(["git", "clone", "-q", "--depth", "1", repo, str(target)], timeout=900)
    if should_cancel and should_cancel():
        raise DownloadCancelled("Install cancelled")
    commit = str(source.get("commit") or "").strip()
    if commit:
        if progress_cb:
            progress_cb("pinning")
        _run(["git", "-C", str(target), "fetch", "-q", "--depth", "1", "origin", commit], timeout=600)
        _run(["git", "-C", str(target), "checkout", "-q", commit], timeout=120)
    requirements = target / "requirements.txt"
    python = _comfy_python()
    if source.get("pip", True) is not False and requirements.is_file() and python:
        if progress_cb:
            progress_cb("installing requirements")
        _run([python, "-m", "pip", "install", "-q", "-r", str(requirements)], cwd=target, timeout=1800)
    return {"path": str(target), "commit": commit, "requirements": requirements.is_file()}


def _progress_recorder(job_id):
    def bytes_progress(done, total):
        history.update_download_job(job_id, status="running", downloaded_bytes=int(done or 0), total_bytes=int(total or 0), updated_at=util.now_iso())

    def stage_progress(stage):
        history.update_download_job(job_id, status="running", stage=str(stage), updated_at=util.now_iso())

    return bytes_progress, stage_progress


def start_install_job(item, *, workflow_id="", lane="default"):
    """Queue one missing item's install. Returns the public job record. The
    same item is not installed twice: an in-flight job for it is returned."""
    kind = str(item.get("kind") or "")
    source = item.get("source") if isinstance(item.get("source"), dict) else {}
    dep_id = str(item.get("id") or "")
    if not dep_id or kind not in {"custom_node", "model"}:
        raise RuntimeError("only custom nodes and model files can be installed here")
    if lanes.comfy_lane_is_remote(lane):
        raise RuntimeError("rented machines are provisioned with their node packs and models; re-provision the machine instead")
    with history.download_jobs_lock:
        for rec in history.download_jobs.values():
            if rec.get("dependency") == dep_id and rec.get("status") in ("queued", "running"):
                return public_install_job(rec)
    if kind == "model":
        dest = _model_destination(str(source.get("folder") or ""), str(item.get("name") or os.path.basename(source.get("relative_path") or "")))
        if dest.exists():
            raise RuntimeError(f"{dest.name} is already installed")
        if not str(source.get("url") or "").startswith("https://"):
            raise RuntimeError(f"no download known for {dest.name}")
    elif not _github_repo(source.get("repo")):
        raise RuntimeError("custom nodes are installed from github.com only")
    job_id = uuid.uuid4().hex[:12]
    rec = {
        "id": job_id, "kind": "dependency", "dependency": dep_id, "dependency_kind": kind,
        "name": str(item.get("name") or dep_id), "workflow_id": str(workflow_id or ""), "lane": str(lane or "default"),
        "status": "queued", "created_at": util.now_iso(), "downloaded_bytes": 0,
        "total_bytes": int(item.get("bytes") or source.get("bytes") or 0),
        "needs_restart": kind == "custom_node",
    }
    with history.download_jobs_lock:
        history.download_jobs[job_id] = rec
        history.save_download_jobs_unlocked()
    bytes_progress, stage_progress = _progress_recorder(job_id)

    def worker():
        history.update_download_job(job_id, status="running", started_at=util.now_iso())
        try:
            if kind == "model":
                result_path = download_url(
                    source["url"], dest, expected_bytes=int(source.get("bytes") or 0), sha256=str(source.get("sha256") or ""),
                    progress_cb=bytes_progress, should_cancel=lambda: _cancel_requested(job_id),
                )
                result = {"path": str(result_path)}
                # The lane scans model folders at schema time, so a new file
                # needs its next object_info answer to be a fresh one.
                forget_lane_object_info(lane)
            else:
                result = install_custom_node(source, progress_cb=stage_progress, should_cancel=lambda: _cancel_requested(job_id))
                forget_lane_object_info(lane)
            done = _job(job_id) or {}
            history.update_download_job(
                job_id, status="success", finished_at=util.now_iso(), result=result,
                downloaded_bytes=done.get("total_bytes") or done.get("downloaded_bytes", 0),
            )
        except DownloadCancelled:
            history.update_download_job(job_id, status="cancelled", finished_at=util.now_iso(), error="Install cancelled")
        except subprocess.TimeoutExpired:
            history.update_download_job(job_id, status="error", finished_at=util.now_iso(), error="the install step timed out")
        except Exception as exc:  # the record is the report
            history.update_download_job(job_id, status="error", finished_at=util.now_iso(), error=str(exc)[:400])

    threading.Thread(target=worker, daemon=True).start()
    return public_install_job(rec)


def cancel_install_job(job_id):
    with history.download_jobs_lock:
        rec = history.download_jobs.get(job_id)
        if not rec or rec.get("kind") != "dependency":
            return None
        if rec.get("status") in ("queued", "running"):
            rec["cancel_requested"] = True
            rec["updated_at"] = util.now_iso()
            history.download_jobs[job_id] = rec
            history.save_download_jobs_unlocked()
        return dict(rec)


def public_install_job(rec):
    out = dict(rec or {})
    total = int(out.get("total_bytes") or 0)
    done = int(out.get("downloaded_bytes") or 0)
    out["percent"] = int(min(100, max(0, (done / total) * 100))) if total else (100 if out.get("status") == "success" else 0)
    return out


def install_jobs(workflow_id=None):
    with history.download_jobs_lock:
        records = [dict(rec) for rec in history.download_jobs.values() if rec.get("kind") == "dependency"]
    if workflow_id:
        records = [rec for rec in records if rec.get("workflow_id") == workflow_id]
    return [public_install_job(rec) for rec in sorted(records, key=lambda rec: str(rec.get("created_at") or ""))]


# --- reloading the lane ---------------------------------------------------------

def restart_lane(lane="default"):
    """Ask ComfyUI-Manager on the lane to restart ComfyUI in place. Manager
    execv's the same command line under the same pid, so the stack supervisor
    keeps the child it already has. Answers whether the lane accepted it."""
    if lanes.comfy_lane_is_remote(lane):
        return {"accepted": False, "reason": "a rented machine is restarted by re-provisioning it"}
    request = lanes.comfy_lane_request(lane, "/manager/reboot", data=b"{}", method="POST", content_type="application/json")
    try:
        with net.urlopen(request, timeout=10) as response:
            status = getattr(response, "status", 200)
            forget_lane_object_info(lane)
            return {"accepted": status < 400, "status": status}
    except HTTPError as exc:
        if exc.code == 403:
            reason = "ComfyUI-Manager refused the restart (its security level forbids it); restart the studio stack instead"
        elif exc.code == 404:
            reason = "ComfyUI-Manager is not installed on this lane; restart the studio stack instead"
        else:
            reason = f"the lane answered {exc.code} to the restart"
        return {"accepted": False, "status": exc.code, "reason": reason}
    except (URLError, OSError) as exc:
        # A lane that drops the connection mid-execv has, in fact, restarted.
        forget_lane_object_info(lane)
        message = str(exc)
        if "Remote end closed" in message or "Connection reset" in message or "timed out" in message:
            return {"accepted": True, "status": 0, "detail": "the lane dropped the connection while restarting"}
        return {"accepted": False, "reason": f"the lane did not answer the restart: {message}"}


def lane_ready(lane="default", timeout=2.0):
    try:
        with net.urlopen(lanes.comfy_lane_request(lane, "/system_stats"), timeout=timeout) as response:
            return getattr(response, "status", 200) < 400
    except (HTTPError, URLError, OSError):
        return False
