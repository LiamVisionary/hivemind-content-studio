"""Remote ComfyUI lanes: which requester owns a prompt id, pushing its inputs
to the lane, watching it, fetching outputs back sealed, and scrubbing the
prompt text a remote machine saw."""
import hashlib
import json
import os
import re
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse, urlencode, unquote

from gateway import config, graphs, history as _history, lanes, media, net, util, workflow_index


# --- Remote Comfy lanes: prompt routing, requester-sealed fetch-back, scrub ---
#
# A remote lane (a rented GPU box) is a dumb executor: the prompt goes out over
# the lane's authenticated transport, a server-side watcher polls that SAME
# lane for completion, output bytes come back over the lane's /view and are
# sealed to the REQUESTING client's public key before anything persists, and
# the box is then scrubbed (output + staged input files deleted, prompt dropped
# from its history). Possession of the decrypt key - not machine locality - is
# what grants access to results: nothing colocated with the gateway can read
# another requester's outputs, because no plaintext (and no gateway-decryptable
# form) of a remote result ever lands in a shared directory.
#
# Known limit (documented, not fixable here): while the job RUNS, prompt and
# pixels exist in plaintext on the rented instance. The contract covers
# everything before submit and after harvest - see packages/gpu-rentals/README.md.
COMFY_PROMPT_ROUTES_FILE = config.GATEWAY_STATE_DIR / "comfy-prompt-routes.json"
COMFY_PROMPT_ROUTES_MAX = 512
REQUESTER_PUB_HEADER = "X-E2E-Requester-Pub"
comfy_prompt_routes_lock = threading.Lock()
_comfy_prompt_routes = {}
_comfy_prompt_routes_loaded = False
# base64url DER SPKI; RSA-2048 keys encode to ~392 chars, leave generous room.
_SPKI_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]{100,4000}$")


def normalized_requester_spki(value):
    value = str(value or "").strip()
    return value if _SPKI_B64URL_RE.match(value) else None


def requester_fingerprint(spki):
    spki = normalized_requester_spki(spki)
    if not spki:
        return None
    return hashlib.sha256(spki.encode("ascii")).hexdigest()[:32]


def _ensure_comfy_prompt_routes_loaded():
    global _comfy_prompt_routes_loaded
    with comfy_prompt_routes_lock:
        if _comfy_prompt_routes_loaded:
            return
        _comfy_prompt_routes_loaded = True
        try:
            if COMFY_PROMPT_ROUTES_FILE.is_file():
                data = json.loads(COMFY_PROMPT_ROUTES_FILE.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    _comfy_prompt_routes.update({str(k): v for k, v in data.items() if isinstance(v, dict)})
        except Exception as exc:
            print(f"[comfy-routes] load failed: {exc}", file=sys.stderr)


def _persist_comfy_prompt_routes_locked():
    try:
        while len(_comfy_prompt_routes) > COMFY_PROMPT_ROUTES_MAX:
            _comfy_prompt_routes.pop(next(iter(_comfy_prompt_routes)))
        util.write_json_atomic(COMFY_PROMPT_ROUTES_FILE, _comfy_prompt_routes)
    except Exception as exc:
        print(f"[comfy-routes] persist failed: {exc}", file=sys.stderr)


def record_comfy_prompt_route(prompt_id, lane, requester_spki=None, pushed_inputs=None, client_id=None):
    """Remember which lane runs a Comfy prompt and who may read it back.

    The requester key is public material (an RSA SPKI) - safe to persist; it is
    what remote outputs get sealed to and what history reads are scoped by.

    The submitter's client_id is kept too, because it is the ONLY handle a
    caller still holds when it never received the prompt id: staging a reference
    job's inputs on a remote lane happens inside this request, so a submit can
    outlive the caller's timeout, and the caller then abandons a job that is
    already queued and watched. comfy_prompt_id_for_client() sells it back."""
    prompt_id = str(prompt_id or "")
    if not prompt_id:
        return None
    _ensure_comfy_prompt_routes_loaded()
    spki = normalized_requester_spki(requester_spki)
    entry = {
        "lane": lane,
        "remote": lanes.comfy_lane_is_remote(lane),
        "status": "submitted",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if spki:
        entry["requester_spki"] = spki
        entry["requester_fp"] = requester_fingerprint(spki)
    if pushed_inputs:
        entry["pushed_inputs"] = [str(name) for name in pushed_inputs]
    if client_id:
        entry["client_id"] = str(client_id)
    with comfy_prompt_routes_lock:
        _comfy_prompt_routes[prompt_id] = entry
        _persist_comfy_prompt_routes_locked()
    return dict(entry)


def comfy_prompt_route(prompt_id):
    _ensure_comfy_prompt_routes_loaded()
    with comfy_prompt_routes_lock:
        entry = _comfy_prompt_routes.get(str(prompt_id or ""))
        return dict(entry) if isinstance(entry, dict) else None


def comfy_prompt_id_for_client(client_id):
    """The prompt a given client_id submitted, newest first.

    A client_id is minted per submission by the caller, so this is a lookup of
    its own job - not a way to enumerate anyone else's. Reads stay scoped by
    requester key at the route layer, exactly as history reads are."""
    wanted = str(client_id or "").strip()
    if not wanted:
        return None, None
    _ensure_comfy_prompt_routes_loaded()
    with comfy_prompt_routes_lock:
        matches = [
            (pid, dict(entry))
            for pid, entry in _comfy_prompt_routes.items()
            if isinstance(entry, dict) and str(entry.get("client_id") or "") == wanted
        ]
    if not matches:
        return None, None
    matches.sort(key=lambda item: str(item[1].get("created_at") or ""), reverse=True)
    return matches[0]


def update_comfy_prompt_route(prompt_id, **fields):
    _ensure_comfy_prompt_routes_loaded()
    with comfy_prompt_routes_lock:
        entry = _comfy_prompt_routes.get(str(prompt_id or ""))
        if not isinstance(entry, dict):
            return None
        entry.update(fields)
        _persist_comfy_prompt_routes_locked()
        return dict(entry)


def requester_may_read_prompt(route, presented_spki):
    """Scope history/status reads to the requester that submitted the prompt.

    Prompts recorded with a requester key require the SAME key on reads; legacy
    submissions (no key presented) keep today's token-only behavior. The sealed
    media is safe regardless - this guards status metadata."""
    if not route or not route.get("requester_fp"):
        return True
    presented = normalized_requester_spki(presented_spki)
    return bool(presented) and requester_fingerprint(presented) == route.get("requester_fp")


def sealing_spki_for_route(route):
    """The key remote outputs are sealed to: the requester's, falling back to
    the owner vault key for owner-initiated jobs that present none."""
    return normalized_requester_spki((route or {}).get("requester_spki")) or media.vault_public_key_spki()


def sealing_recipients_for_route(route):
    """(owner, agent) public keys for a remote job's harvested outputs.

    A harvest used to seal to exactly ONE recipient — the requester — so an
    agent-submitted rental job produced media the owner's own studio could
    never open: History failed to decrypt the tile and Download saved the
    enc:v1 JSON. The local path solved this long ago by sealing twice; this is
    that same split for the remote path. The owner's envelope keeps the plain
    <name>.e2e path every existing reader already looks for, and the agent
    keeps its access through <name>.agent-<fp>.e2e.

    Both halves move together under the one flag the local path and
    send_output_file() already use. With dual seal off there is still exactly
    one envelope and it stays sealed to whoever asked for the job — flipping it
    to the owner alone would take the agent's access away without the read side
    ever offering it a copy it could open. With no owner vault yet, likewise:
    one envelope, to the requester, exactly as before.
    """
    owner = media.vault_public_key_spki()
    if not media.AGENT_DUAL_SEAL_ENABLED or not owner:
        return sealing_spki_for_route(route), None
    agent = normalized_requester_spki((route or {}).get("requester_spki"))
    return owner, (agent if agent != owner else None)


def _prompt_input_file_refs(body):
    """Local Comfy input files a prompt graph references (LoadImage-style
    string inputs). These are what must be staged onto a remote lane."""
    refs = []
    try:
        prompt = graphs._prompt_nodes_from_body(body)
    except Exception:
        return refs
    seen = set()
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        if not isinstance(inputs, dict):
            continue
        for value in inputs.values():
            if not isinstance(value, str) or not value.strip():
                continue
            name = re.sub(r"\s*\[(?:input|output|temp)\]$", "", value.strip()).replace("\\", "/")
            if not name or name.startswith(("/", "~")) or ".." in name:
                continue
            try:
                resolved = (config.COMFY_INPUT_DIR / name).resolve()
            except OSError:
                continue
            if not util._is_under(resolved, config.COMFY_INPUT_DIR) or not resolved.is_file():
                continue
            if str(resolved) in seen:
                continue
            seen.add(str(resolved))
            refs.append({"name": name, "path": resolved})
    return refs


def _push_file_to_lane_input(lane, name, path):
    subfolder, _, filename = str(name).rpartition("/")
    boundary = uuid.uuid4().hex
    parts = []
    fields = [("overwrite", "true"), ("type", "input")]
    if subfolder:
        fields.append(("subfolder", subfolder))
    for field_name, field_value in fields:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{field_name}"\r\n\r\n{field_value}\r\n'.encode()
        )
    parts.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{filename}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
        + Path(path).read_bytes()
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    request = lanes.comfy_lane_request(
        lane, "/upload/image", data=b"".join(parts), method="POST",
        content_type=f"multipart/form-data; boundary={boundary}",
    )
    with net.urlopen(request, timeout=120):
        pass


def push_prompt_inputs_to_lane(body, lane):
    """Stage every local input file the graph references onto the remote lane,
    so image-conditioned workflows (e.g. minimax-h3 image-to-video) run there.
    Returns the staged names for the post-harvest scrub."""
    pushed = []
    for ref in _prompt_input_file_refs(body):
        _push_file_to_lane_input(lane, ref["name"], ref["path"])
        pushed.append(ref["name"])
    return pushed


def _comfy_history_output_refs(history):
    refs = []
    for node_out in ((history or {}).get("outputs") or {}).values():
        if not isinstance(node_out, dict):
            continue
        for values in node_out.values():
            if not isinstance(values, list):
                continue
            for item in values:
                if isinstance(item, dict) and item.get("filename"):
                    refs.append({
                        "filename": str(item.get("filename")),
                        "subfolder": str(item.get("subfolder") or ""),
                        "type": str(item.get("type") or "output"),
                    })
    return refs


def _fetch_lane_history(lane, prompt_id):
    request = lanes.comfy_lane_request(lane, f"/history/{prompt_id}")
    with net.urlopen(request, timeout=15) as response:
        data = json.loads(response.read().decode("utf-8") or "{}")
    return data.get(str(prompt_id)) if isinstance(data, dict) else None


def _fetch_lane_view_bytes(lane, ref):
    query = urlencode({
        "filename": ref["filename"],
        "subfolder": ref.get("subfolder") or "",
        "type": ref.get("type") or "output",
    })
    request = lanes.comfy_lane_request(lane, f"/view?{query}")
    with net.urlopen(request, timeout=300) as response:
        return response.read()


def remote_output_logical_name(prompt_id, filename):
    """Remote Comfy instances restart their filename counters per rental, so
    fetched outputs are namespaced by prompt id - a bare z_image_00001_.png
    from a rented box must never collide with (or overwrite) a local output."""
    return f"cmf-{str(prompt_id)[:8]}-{util.safe_name(Path(str(filename)).name)}"


def harvest_remote_comfy_outputs(prompt_id, history):
    """Fetch a finished remote prompt's outputs and seal each to its recipients
    BEFORE anything persists. Plaintext bytes only ever touch a 0600 staging
    file inside the gateway's private state dir - never a shared output dir.
    Returns the logical output names.

    An agent-submitted job seals twice from that one staging file (owner and
    agent, see sealing_recipients_for_route), so both can read the result and
    neither the plaintext nor a second key ever leaves this function."""
    route = comfy_prompt_route(prompt_id) or {}
    spki, agent_spki = sealing_recipients_for_route(route)
    if not spki:
        raise RuntimeError("no sealing key: the requester presented none and no owner vault exists")
    agent_fp = requester_fingerprint(agent_spki)
    lane = route.get("lane") or "default"
    harvested = []
    for ref in _comfy_history_output_refs(history):
        if Path(ref["filename"]).suffix.lower() not in media.OUTPUT_MEDIA_EXTS:
            continue
        data = _fetch_lane_view_bytes(lane, ref)
        logical_name = remote_output_logical_name(prompt_id, ref["filename"])
        envelope = media.e2e_envelope_path_for(config.COMFY_OUTPUT_DIR / logical_name)
        config.COMFY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        config.GATEWAY_STATE_DIR.mkdir(parents=True, exist_ok=True)
        staged = config.GATEWAY_STATE_DIR / f".remote-harvest-{uuid.uuid4().hex}"
        try:
            descriptor = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
            media._seal_file_with_helper(spki, staged, envelope, logical_name)
            if agent_fp:
                # Secondary recipient: never at the cost of the owner's copy,
                # which is already on disk by here. A failure is logged and the
                # harvest carries on, exactly as the local path does.
                try:
                    media._seal_file_with_helper(
                        agent_spki, staged,
                        media.agent_envelope_path_for(config.COMFY_OUTPUT_DIR / logical_name, agent_fp),
                        logical_name,
                    )
                except Exception as exc:
                    print(f"[agent-seal] second recipient failed for {logical_name}: {exc}", file=sys.stderr)
        finally:
            try:
                staged.unlink()
            except FileNotFoundError:
                pass
        harvested.append(logical_name)
    update_comfy_prompt_route(
        prompt_id, status="harvested", outputs=harvested,
        harvested_at=datetime.now(timezone.utc).isoformat(),
    )
    return harvested


def scrub_remote_comfy_prompt(prompt_id, history=None, inputs_only=False):
    """After harvest: delete the prompt's output files AND any inputs we staged
    from the rented box, then drop the prompt from that lane's history. File
    deletion uses the provisioned /hivemind/scrub-files route (installed by
    gpu_rentals provisioning, and by
    packages/gpu-rentals/provisioning/comfyui-hivemind.sh for template boots);
    on a lane without it, history is still dropped and the files die with the
    instance's ephemeral disk.

    inputs_only covers the harvest-failed case: the output is the only copy of
    a paid generation and must survive, but the customer's staged reference
    image has no such claim on the box and goes now."""
    route = comfy_prompt_route(prompt_id) or {}
    lane = route.get("lane") or "default"
    files = [] if inputs_only else [
        {"type": ref.get("type") or "output", "subfolder": ref.get("subfolder") or "", "filename": ref["filename"]}
        for ref in _comfy_history_output_refs(history)
    ]
    for name in route.get("pushed_inputs") or []:
        subfolder, _, filename = str(name).replace("\\", "/").rpartition("/")
        files.append({"type": "input", "subfolder": subfolder, "filename": filename})
    files_scrubbed = None
    if files:
        try:
            request = lanes.comfy_lane_request(
                lane, "/hivemind/scrub-files",
                data=json.dumps({"files": files}).encode("utf-8"),
                method="POST", content_type="application/json",
            )
            with net.urlopen(request, timeout=30):
                files_scrubbed = True
        except Exception as exc:
            files_scrubbed = False
            print(
                f"[remote-comfy] lane '{lane}' file scrub unavailable ({exc}); "
                "remote files persist until the instance is destroyed",
                file=sys.stderr,
            )
    if inputs_only:
        # Leave the history entry: it names the output files, and it is the
        # only record of them once this watcher exits.
        update_comfy_prompt_route(prompt_id, inputs_scrubbed=files_scrubbed)
        return {"files_scrubbed": files_scrubbed, "history_dropped": False}
    history_dropped = False
    try:
        request = lanes.comfy_lane_request(
            lane, "/history",
            data=json.dumps({"delete": [str(prompt_id)]}).encode("utf-8"),
            method="POST", content_type="application/json",
        )
        with net.urlopen(request, timeout=10):
            history_dropped = True
    except Exception as exc:
        print(f"[remote-comfy] could not drop prompt {prompt_id} from lane '{lane}' history: {exc}", file=sys.stderr)
    update_comfy_prompt_route(
        prompt_id, scrubbed=bool(history_dropped),
        files_scrubbed=files_scrubbed, history_dropped=history_dropped,
    )
    return {"files_scrubbed": files_scrubbed, "history_dropped": history_dropped}


# Two or more path segments: enough to catch /workspace/ComfyUI/... without
# rewriting ordinary prose that happens to contain a slash.
_REMOTE_ABSOLUTE_PATH_RE = re.compile(r"(?:/[\w.@+-]+){2,}/?")


def _sanitized_remote_error_text(value):
    text = " ".join(str(value or "").split())
    text = _REMOTE_ABSOLUTE_PATH_RE.sub(
        lambda match: os.path.basename(match.group(0).rstrip("/")) or "…", text
    )
    return text[:400]


def remote_comfy_failure_message(history):
    """Why a remote prompt failed, in the words of the node that raised.

    Comfy reports a failure as an execution_error message carrying the node id,
    its class and the exception. Only those fields are lifted: the SAME payload
    also carries current_inputs (the prompt text) and a traceback of the rented
    box's filesystem, and neither may cross back to us. Absolute paths in the
    exception are reduced to basenames, so 'cannot open /workspace/models/x.pt'
    still names the file without mapping the box. Without this the route (and
    every layer above it) recorded the literal string 'error', which is how a
    one-line node validation failure became a 20-minute SSH dig."""
    status = (history or {}).get("status") or {}
    for message in status.get("messages") or []:
        if not (isinstance(message, (list, tuple)) and len(message) >= 2):
            continue
        kind, payload = message[0], message[1]
        if str(kind) != "execution_error" or not isinstance(payload, dict):
            continue
        node_type = str(payload.get("node_type") or "").strip()
        node_id = str(payload.get("node_id") or "").strip()
        exception = _sanitized_remote_error_text(payload.get("exception_message"))
        # Exception types arrive fully qualified from some nodes.
        exception_type = str(payload.get("exception_type") or "").strip().rsplit(".", 1)[-1]
        detail = exception or exception_type or "failed"
        if exception and exception_type and exception_type.lower() not in exception.lower():
            detail = f"{exception_type}: {exception}"
        where = f"{node_type} (node {node_id})" if node_type and node_id else node_type
        if not where and node_id:
            where = f"node {node_id}"
        return f"{where} failed — {detail}" if where else detail
    return _sanitized_remote_error_text(status.get("status_str")) or "remote generation failed"


REMOTE_SAMPLER_PROGRESS_SHARE = 0.9


def _record_lane_progress(prompt_id, lane):
    """Pull the lane's real sampler counters into this prompt's route record.

    A remote lane's /history entry appears only once, at the very end, so
    without this the studio has nothing but a time estimate for the whole
    generation. The rented box exposes /hivemind/progress (hivemind_privacy);
    a lane that predates it simply keeps the estimate. Counters only - the
    payload carries node ids and step numbers, never graph inputs."""
    try:
        request = lanes.comfy_lane_request(lane, "/hivemind/progress")
        with net.urlopen(request, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except Exception:
        return None
    if not isinstance(payload, dict) or str(payload.get("prompt_id") or "") != str(prompt_id):
        # Counters from a neighbouring prompt say nothing about this one.
        return None
    try:
        value, maximum = float(payload.get("value") or 0), float(payload.get("max") or 0)
    except (TypeError, ValueError):
        return None
    if maximum <= 0:
        return None
    # Sampling is the measurable phase, not the whole job: VAE decode, audio
    # decode, muxing and the sealed fetch-back follow it and report nothing.
    # Measured on a 5s H3 clip, that tail runs ~75s against ~40s of sampling,
    # so reporting the sampler's own 10/10 as 1.0 would park the bar at "done"
    # for longer than it took to sample. Scale into the share sampling actually
    # owns and let the client's time-based smoothing carry the remainder.
    progress = max(0.0, min(1.0, value / maximum)) * REMOTE_SAMPLER_PROGRESS_SHARE
    # Deliberately NOT touching status: respawn_remote_comfy_watchers re-arms
    # on status == "submitted", so a progress update that promoted the prompt
    # to "running" would orphan it across a gateway restart.
    update_comfy_prompt_route(
        prompt_id, progress=progress,
        progress_step=int(value), progress_total=int(maximum),
    )
    return progress


def watch_remote_comfy_prompt(prompt_id, poll_seconds=5, timeout_seconds=7200):
    """Server-side completion watcher for one remote-lane prompt: poll the
    OWNING lane, then harvest (requester-sealed) and scrub the box. Running
    here - not in the client - means results are captured and the rented box
    cleaned even if the submitting client dies mid-generation."""
    route = comfy_prompt_route(prompt_id) or {}
    lane = route.get("lane") or "default"
    deadline = time.monotonic() + timeout_seconds
    history = None
    while True:
        try:
            history = _fetch_lane_history(lane, prompt_id)
        except Exception:
            history = None
        if isinstance(history, dict):
            break
        # A prompt cancelled while still PENDING is deleted from the queue and
        # never reaches history at all, so waiting for one is waiting forever
        # (or until the 2-hour timeout, which then records a spurious error).
        if str((comfy_prompt_route(prompt_id) or {}).get("status") or "") == "cancelled":
            return comfy_prompt_route(prompt_id)
        _record_lane_progress(prompt_id, lane)
        if time.monotonic() >= deadline:
            update_comfy_prompt_route(
                prompt_id, status="error",
                error=f"remote prompt did not finish within {timeout_seconds}s",
            )
            return comfy_prompt_route(prompt_id)
        time.sleep(poll_seconds)
    status = history.get("status") or {}
    failed = str(status.get("status_str") or "").lower() == "error" or not status.get("completed")
    # An interrupted prompt lands in Comfy's history as "error" like any other
    # failure, so the only thing that tells the two apart is our own record of
    # having asked for it. Without this a deliberate cancel reads as a broken
    # generation everywhere downstream.
    was_cancelled = str((comfy_prompt_route(prompt_id) or {}).get("status") or "") == "cancelled"
    # Let the workflow-envelope index record this prompt's sealed workflow
    # before the history entry disappears from the lane.
    try:
        workflow_index._harvest_comfy_workflow_envelopes()
    except Exception:
        pass
    harvest_error = None
    if failed and was_cancelled:
        # Keep the cancelled status; the remote's "error" is the interrupt we
        # asked for. Still falls through to the scrub below — a cancelled job's
        # staged inputs and partial outputs need cleaning up like any other.
        pass
    elif failed:
        failure = remote_comfy_failure_message(history)
        # The card just told us where its limit is. Record it against the card
        # size so every later run on a card like this is held under it — this is
        # the difference between a limit that is measured and one that is
        # guessed, and it is why the same OOM does not arrive twice.
        route = comfy_prompt_route(prompt_id) or {}
        if lanes._looks_like_an_out_of_memory(failure) and route.get("packed_rows"):
            lanes.record_row_observation(route.get("card_vram_gb"), route.get("packed_rows"),
                                   "oom", lane=route.get("lane"))
        update_comfy_prompt_route(prompt_id, status="error", error=failure)
    else:
        # It finished: this many rows are PROVEN on a card this size, which is
        # the only thing allowed to raise a budget.
        route = comfy_prompt_route(prompt_id) or {}
        if route.get("packed_rows"):
            lanes.record_row_observation(route.get("card_vram_gb"), route.get("packed_rows"),
                                   "clean", lane=route.get("lane"))
        try:
            harvest_remote_comfy_outputs(prompt_id, history)
        except Exception as exc:
            harvest_error = exc
            update_comfy_prompt_route(prompt_id, status="error", error=str(exc))
    if harvest_error is None:
        # Scrub only once the sealed envelopes exist locally (or the job
        # failed and there is nothing to recover): a failed harvest must not
        # delete the only copy of a paid generation. Un-scrubbed files still
        # die with the instance's ephemeral disk.
        try:
            scrub_remote_comfy_prompt(prompt_id, history)
        except Exception as exc:
            print(f"[remote-comfy] scrub failed for {prompt_id}: {exc}", file=sys.stderr)
    else:
        # The outputs stay (they are the only copy), but the staged reference
        # image is ours to remove and has no recovery value.
        try:
            scrub_remote_comfy_prompt(prompt_id, history, inputs_only=True)
        except Exception as exc:
            print(f"[remote-comfy] input scrub failed for {prompt_id}: {exc}", file=sys.stderr)
        print(
            f"[remote-comfy] harvest failed for {prompt_id}; leaving remote outputs for instance teardown: {harvest_error}",
            file=sys.stderr,
        )
    return comfy_prompt_route(prompt_id)


def remote_comfy_job_record(prompt_id):
    """A routed remote prompt in /api/job shape, or None if it is not one.

    The studio polls this over its trusted server-side channel, so it is the
    one place a remote generation can report real progress (the lane's sampler
    counters) and, on completion, the sealed output it should fetch. Names the
    output under /image/, which serves the requester-sealed envelope - never a
    /comfy/view path, which only exists for plaintext local files."""
    route = comfy_prompt_route(prompt_id)
    if not route or not route.get("remote"):
        return None
    status = route.get("status")
    outputs = [str(name) for name in route.get("outputs") or []]
    record = {
        "id": str(prompt_id),
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "backend": "comfy-remote",
        "status": {"submitted": "running", "harvested": "success"}.get(status, status or "running"),
        "created_at": route.get("created_at"),
        "lane": route.get("lane"),
    }
    if isinstance(route.get("progress"), (int, float)):
        record["progress"] = float(route["progress"])
        record["progress_step"] = route.get("progress_step")
        record["progress_total"] = route.get("progress_total")
    if route.get("error"):
        record["error"] = str(route["error"])
    if outputs:
        record["outputs"] = [{"filename": name, "subfolder": "", "type": "output"} for name in outputs]
        record["image_urls"] = [f"/image/{name}" for name in outputs]
    return record


def synthetic_comfy_history_for_route(prompt_id, route):
    """History-shaped response for a routed remote prompt, built from the
    gateway's own route record. The lane's history entry is scrubbed after
    harvest (by design), and while a job runs the proxy must not leak the
    lane's live state to non-requesters - so remote history reads are answered
    from here in every phase. Completion is only reported once the sealed
    envelopes exist locally, so a client that resolves output URLs on
    completion always finds them."""
    status_value = (route or {}).get("status")
    if status_value == "error":
        entry = {
            "status": {
                "status_str": "error", "completed": True,
                "messages": [["hivemind_remote_error", {"error": route.get("error") or "remote generation failed"}]],
            },
            "outputs": {},
        }
    elif status_value == "harvested":
        images = [
            {"filename": name, "subfolder": "", "type": "output"}
            for name in route.get("outputs") or []
        ]
        entry = {
            "status": {"status_str": "success", "completed": True},
            "outputs": {"hivemind_remote": {"images": images}},
        }
    else:
        # submitted / in flight: history has no entry yet, same as live Comfy.
        return {}
    return {str(prompt_id): entry}


def respawn_remote_comfy_watchers():
    """Re-arm watchers for remote prompts that were in flight when the gateway
    last stopped, so harvest+scrub still happen after a restart."""
    _ensure_comfy_prompt_routes_loaded()
    with comfy_prompt_routes_lock:
        pending = [
            pid for pid, entry in _comfy_prompt_routes.items()
            if isinstance(entry, dict) and entry.get("remote") and entry.get("status") == "submitted"
        ]
    for pid in pending:
        threading.Thread(target=watch_remote_comfy_prompt, args=(pid,), daemon=True).start()
    return pending
