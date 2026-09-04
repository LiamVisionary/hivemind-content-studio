"""ComfyUI lanes: where a graph runs. Parsing the lane maps, folding in live
rental and local attachments, health and launch-flag probes, and the
first-match routing rules that pick a lane for a prompt."""
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse, urlencode, unquote
from urllib.request import Request, urlopen

from gateway import config, graphs, net


def parse_comfy_lanes():
    raw = os.environ.get("COMFY_LANES", "")
    lanes = {"default": config.COMFY_HTTP_DEFAULT}
    for part in raw.split(','):
        part = part.strip()
        if not part or '=' not in part:
            continue
        name, url = part.split('=', 1)
        name = re.sub(r"[^a-z0-9_-]", "", name.strip().lower())
        url = url.strip().rstrip('/')
        if name and url:
            lanes[name] = url
    return lanes


def parse_comfy_lane_rules():
    raw = os.environ.get("COMFY_LANE_RULES", "anima=anima,qwen35,qwen3.5")
    rules = []
    for spec in raw.split(';'):
        spec = spec.strip()
        if not spec or '=' not in spec:
            continue
        lane, terms = spec.split('=', 1)
        lane = re.sub(r"[^a-z0-9_-]", "", lane.strip().lower())
        needles = [t.strip().lower() for t in terms.split(',') if t.strip()]
        if lane and needles:
            rules.append((lane, needles))
    return rules


def parse_comfy_lane_tokens():
    """Per-lane auth tokens, e.g. COMFY_LANE_TOKENS="h3=abc123,krea=def".

    Sent as `Authorization: Bearer <token>` on every request the gateway makes
    to that lane (the rented-instance auth proxy in front of :8188 checks it).
    Kept out of COMFY_LANES so lane URLs never carry credentials into logs."""
    raw = os.environ.get("COMFY_LANE_TOKENS", "")
    tokens = {}
    for part in raw.split(','):
        part = part.strip()
        if not part or '=' not in part:
            continue
        name, value = part.split('=', 1)
        name = re.sub(r"[^a-z0-9_-]", "", name.strip().lower())
        value = value.strip()
        if name and value:
            tokens[name] = value
    return tokens


def parse_remote_comfy_lanes():
    """Lanes whose Comfy runs on a machine that is NOT this gateway host, e.g.
    COMFY_REMOTE_LANES="h3". Remote lanes get the requester-sealed fetch-back
    flow (outputs never resolve on local disk). An SSH-tunneled lane LOOKS like
    loopback, so remoteness must be declarable, not only inferred."""
    raw = os.environ.get("COMFY_REMOTE_LANES", "")
    return {re.sub(r"[^a-z0-9_-]", "", part.strip().lower()) for part in raw.split(',') if part.strip()}
COMFY_LANES = parse_comfy_lanes()
COMFY_LANE_RULES = parse_comfy_lane_rules()
COMFY_LANE_TOKENS = parse_comfy_lane_tokens()
COMFY_REMOTE_LANES = parse_remote_comfy_lanes()

# Rented machines attach and detach while this process runs. Their lanes used to
# arrive only through the launcher's env overlay, which meant every attach had to
# RESTART THE WHOLE STACK to take effect — killing in-flight generations to add a
# routing rule. The attachment registry is read live instead: gpu_rentals writes
# the file, the next request here picks it up. The env overlay is still written,
# but only so an attachment survives a restart, never to cause one.
RENTAL_LANES_FILE = config.MEDIA_STATE_ROOT / "rental-lanes.json"

# The same live-read trick for the LOCAL engine. ComfyUI is optional: the studio
# boots without one and the owner attaches theirs from the Connect card
# (control_api /api/comfy/connect -> comfy_connect.py), which writes this file.
# Read live for the same reason rentals are: attaching a ComfyUI must not mean
# restarting the stack and killing whatever is in flight.
LOCAL_LANES_FILE = config.MEDIA_STATE_ROOT / "comfy-attachments.json"

# The lane map as the environment configured it. An attachment overwrites an
# entry and a detach restores it from here — never deletes it. ~30 read sites
# assume `default` exists, so "no ComfyUI" has to be a lane that does not
# answer, not a lane that is gone.
_ENV_COMFY_LANES = dict(COMFY_LANES)

_rental_lanes_lock = threading.Lock()
_rental_lanes_state = {"mtime": None, "lanes": {}}


def _read_rental_attachments():
    try:
        stamp = RENTAL_LANES_FILE.stat().st_mtime_ns
    except OSError:
        return {}
    with _rental_lanes_lock:
        if _rental_lanes_state["mtime"] == stamp:
            return _rental_lanes_state["lanes"]
        try:
            data = json.loads(RENTAL_LANES_FILE.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"[comfy-lanes] rental attachment registry unreadable: {exc}", file=sys.stderr)
            return _rental_lanes_state["lanes"]
        lanes = {}
        # Highest priority first: lane rules are first-match, so this ordering
        # is what makes "run generations on THAT machine" work when two
        # attached machines serve the same models. gpu_rentals writes the file
        # in this order too; sorting here means a hand-edited or older
        # registry still routes deterministically.
        entries = sorted(
            ((k, e) for k, e in (data or {}).items() if isinstance(e, dict)),
            key=lambda item: -(item[1].get("priority") or 0),
        )
        for rental_id, entry in entries:
            if not isinstance(entry, dict):
                continue
            lane = re.sub(r"[^a-z0-9_-]", "", str(entry.get("lane") or "").strip().lower())
            port = entry.get("local_port")
            if not lane or not isinstance(port, int):
                continue
            lanes[lane] = {
                "url": f"http://127.0.0.1:{port}",
                "needles": [str(n).strip().lower() for n in entry.get("needles") or [] if str(n).strip()],
                # The registry key is the rental id the studio shows (e.g.
                # "vast:48352597") — what a per-tab "Run on" pin names.
                "rental_id": str(rental_id),
            }
        _rental_lanes_state.update(mtime=stamp, lanes=lanes)
        return lanes


_local_lanes_lock = threading.Lock()
_local_lanes_state = {"mtime": None, "lanes": {}, "applied": set()}


def _read_local_attachments():
    """{lane: url} the owner attached from the Connect card. {} when there is
    no file, which is the normal state on a machine with no ComfyUI."""
    try:
        stamp = LOCAL_LANES_FILE.stat().st_mtime_ns
    except OSError:
        with _local_lanes_lock:
            _local_lanes_state["mtime"] = None
            _local_lanes_state["lanes"] = {}
        return {}
    with _local_lanes_lock:
        if _local_lanes_state["mtime"] == stamp:
            return _local_lanes_state["lanes"]
        try:
            data = json.loads(LOCAL_LANES_FILE.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"[comfy-lanes] ComfyUI attachment registry unreadable: {exc}", file=sys.stderr)
            return _local_lanes_state["lanes"]
        lanes = {}
        for lane, entry in (data or {}).items():
            if not isinstance(entry, dict):
                continue
            name = re.sub(r"[^a-z0-9_-]", "", str(lane).strip().lower())
            url = str(entry.get("url") or "").strip().rstrip("/")
            if name and url:
                lanes[name] = url
        _local_lanes_state.update(mtime=stamp, lanes=lanes)
        return lanes


def refresh_comfy_lanes():
    """Fold the live rental attachments into the lane maps, in place.

    In place so the ~15 module-level read sites (routing, the proxy, the queue
    sweepers) keep seeing one source of truth without threading a config object
    through all of them. Cheap: one stat() unless the registry actually changed.

    Scoped to the lanes this function itself added: it adds and retires rental
    entries and touches nothing else, so env-configured lanes (and anything a
    test or operator injects) survive a refresh untouched."""
    rentals = _read_rental_attachments()
    previous = set(_rental_lanes_state.get("applied") or ())
    current = set(rentals)

    for lane in previous - current:
        COMFY_LANES.pop(lane, None)
        COMFY_REMOTE_LANES.discard(lane)
    for lane, spec in rentals.items():
        COMFY_LANES[lane] = spec["url"]
        COMFY_REMOTE_LANES.add(lane)

    retired = previous - current
    if retired or current:
        kept = [rule for rule in COMFY_LANE_RULES if rule[0] not in previous | current]
        # Rental rules go FIRST, matching what the stack launcher does when it
        # builds COMFY_LANE_RULES at boot. Appending them instead made an
        # attach a no-op for any model a local lane also claims: routing is
        # first-match, so the local `ltx` lane kept every LTX generation on
        # this machine and the rented video box sat idle. That failed loudly
        # only because the local lane lacks the eros checkpoint; on a workload
        # both lanes can serve it would have silently ignored the rental the
        # user is paying for.
        rented = [(lane, spec["needles"]) for lane, spec in rentals.items() if spec["needles"]]
        COMFY_LANE_RULES[:] = rented + kept
    _rental_lanes_state["applied"] = current

    # Local ComfyUI attachments last, and never over a rented lane: a rental the
    # owner is paying for outranks a local engine that happens to share a name.
    attached = {lane: url for lane, url in _read_local_attachments().items() if lane not in current}
    applied_local = set(_local_lanes_state.get("applied") or ())
    for lane in applied_local - set(attached):
        if lane in current:
            continue
        if lane in _ENV_COMFY_LANES:
            COMFY_LANES[lane] = _ENV_COMFY_LANES[lane]
        else:
            COMFY_LANES.pop(lane, None)
    for lane, url in attached.items():
        COMFY_LANES[lane] = url
    _local_lanes_state["applied"] = set(attached)
    return COMFY_LANES
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def comfy_lane_is_remote(lane):
    """A lane is remote when declared in COMFY_REMOTE_LANES or when its URL
    points off-host. Remote means: output files do not exist on this gateway's
    disk, and results must be fetched back and sealed to the requester."""
    if lane in COMFY_REMOTE_LANES:
        return True
    base = COMFY_LANES.get(lane)
    if not base:
        return False
    host = (urlparse(base).hostname or "").lower()
    return bool(host) and host not in _LOOPBACK_HOSTS


def comfy_lane_token(lane):
    return COMFY_LANE_TOKENS.get(lane)


def comfy_lane_transport_error(lane):
    """The security contract for remote lanes: reachable only through an
    authenticated channel. Loopback URLs declared remote are SSH tunnels (the
    tunnel is the auth). Anything off-host needs a per-lane token for the
    instance's auth proxy. Returns an error string, or None when acceptable."""
    if not comfy_lane_is_remote(lane):
        return None
    base = COMFY_LANES.get(lane) or ""
    host = (urlparse(base).hostname or "").lower()
    if host in _LOOPBACK_HOSTS:
        return None  # declared-remote loopback = SSH tunnel; the tunnel authenticates
    if comfy_lane_token(lane):
        return None
    return (
        f"remote Comfy lane '{lane}' has no authenticated transport: front :8188 with the "
        f"per-instance token proxy and set COMFY_LANE_TOKENS={lane}=<token>, or reach it "
        f"over an SSH tunnel and declare it in COMFY_REMOTE_LANES"
    )


def comfy_lane_liveness_error(lane, timeout=4.0):
    """Is the lane ANSWERING, right now, before we commit work to it?

    comfy_lane_transport_error() above settles whether the lane is allowed to be
    reached; it cannot tell whether anything is still there. A tunnelled lane
    always passes it - "the tunnel is the auth" - so a rental that has been
    destroyed, preempted, or has simply lost its tunnel still reads as healthy.
    Submits then went ahead and staged references into a dead socket: uploads
    hung, ComfyUI logged a lost connection for a client that had gone away, and
    two minutes later the caller reported a timeout for a machine that no longer
    existed (2026-08-11, rental 47471037 - destroyed mid-session while the lane
    stayed attached, and every attempt hung instead of saying so).

    One cheap probe before staging turns that into an immediate, true sentence.

    Local lanes are asked too, through the five-second health cache rather than
    a fresh knock. ComfyUI is OPTIONAL now - the studio boots without one - so
    "there is no local ComfyUI" is an ordinary state that has to name its fix
    (attach one from the Connect card, or run this on a cloud or rented model)
    instead of surfacing as a connection refused from somewhere deep in a
    submit. The cache is what keeps that off the hot path: a burst of local
    submits costs one knock per five seconds, not one per prompt.
    """
    if not comfy_lane_is_remote(lane):
        if comfy_lane_health(lane, timeout=min(timeout, 2.0)).get("alive"):
            return None
        return (
            f"ComfyUI is not answering on lane '{lane}'. Connect ComfyUI from the Machines "
            f"page - attach the address it is serving on - or pick a cloud or rented model "
            f"for this one."
        )
    detail = comfy_lane_probe_detail(lane, timeout)
    if detail is None:
        return None
    return (
        f"the machine behind lane '{lane}' is not answering ({detail}). Its tunnel has "
        f"dropped or the instance is gone - re-attach it in Machines, and detach it if the "
        f"rental has ended."
    )


def comfy_lane_probe_detail(lane, timeout=4.0):
    """One /system_stats knock at a lane, remote or not. None when it answers.

    comfy_lane_liveness_error() above stays remote-only: probing the local lane
    before every prompt would be a round trip on the hot path for the one lane
    whose absence the submit itself reports immediately. /health is the other
    case - it is asked precisely so the studio can say "Local ComfyUI is off"
    BEFORE the user composes a prompt - so it probes every lane through here.
    """
    try:
        with net.urlopen(comfy_lane_request(lane, "/system_stats"), timeout=timeout) as response:
            if response.status < 400:
                return None
            return f"answered HTTP {response.status}"
    except Exception as exc:
        return f"{exc.__class__.__name__}: {exc}"


_LANE_HEALTH_TTL_S = 5.0
_lane_health_cache = {}
_lane_health_lock = threading.Lock()


def comfy_lane_health(lane, timeout=2.0):
    """Is this lane there, right now — cached for five seconds.

    /health is polled by the supervisor, the MCP status tool and the studio's
    catalog liveness, so the probe is cached: a burst of callers costs one knock
    per lane, and five seconds is short enough that a crashed ComfyUI is news
    almost immediately.
    """
    now = time.monotonic()
    with _lane_health_lock:
        cached = _lane_health_cache.get(lane)
        if cached and now - cached[0] < _LANE_HEALTH_TTL_S:
            return dict(cached[1])
    remote = comfy_lane_is_remote(lane)
    detail = comfy_lane_probe_detail(lane, timeout)
    entry = {"remote": remote, "alive": detail is None}
    if detail is not None:
        entry["error"] = (
            f"the machine behind lane '{lane}' is not answering. Re-attach it in Machines, "
            f"and detach it if the rental has ended."
            if remote else
            # Never "start it": this app does not own that process and a button
            # that cannot do what it says is worse than no button. ComfyUI is
            # optional, so the fix is to attach one - or to use a lane that is
            # already there.
            f"ComfyUI is not answering on lane '{lane}'. Connect ComfyUI from the Machines "
            f"page, or use a cloud or rented model instead."
        )
    with _lane_health_lock:
        _lane_health_cache[lane] = (now, dict(entry))
    return dict(entry)


def comfy_lane_health_snapshot(timeout=1.5):
    """Every lane's state, probed in parallel and bounded.

    /health is the supervisor's readiness gate, so the endpoint must not take
    one dead lane's timeout after another: probing serially with two dead
    rentals attached would push the response past several seconds and make
    readiness itself flap. One thread per lane, one join deadline for all.
    """
    lanes = sorted(COMFY_LANES)
    results = {}
    threads = []
    for lane in lanes:
        def probe(name=lane):
            try:
                results[name] = comfy_lane_health(name, timeout)
            except Exception as exc:
                results[name] = {"remote": comfy_lane_is_remote(name), "alive": False,
                                 "error": f"lane '{name}' could not be checked ({exc.__class__.__name__})"}
        thread = threading.Thread(target=probe, daemon=True)
        thread.start()
        threads.append(thread)
    deadline = time.monotonic() + timeout + 0.5
    for thread in threads:
        thread.join(max(0.05, deadline - time.monotonic()))
    return {
        lane: results.get(lane, {
            "remote": comfy_lane_is_remote(lane),
            "alive": False,
            "error": f"lane '{lane}' did not answer in time",
        })
        for lane in lanes
    }


# ---- Lane launch flags ------------------------------------------------------
#
# The MiniMax H3 motion-reference budget (workflow-registry.json,
# motion_reference_budget.max_packed_rows) was measured on a lane launched with
# `--vram-headroom 12`. Comfy's planner is blind to every reference row —
# comfy/model_base.py's MiniMaxH3 sets no memory_usage_factor_conds — so WITHOUT
# the flag the loader keeps the whole int8 DiT resident and the same card holds
# roughly half the rows: a 142,366-row job that samples with the flag died in
# block 0's qkv_proj without it (2026-08-21, job 34a722c2, 26.47GiB + 6.21GiB on
# a 31.36GiB 5090). The rental provisioning passes the flag, but a lane attached
# by hand, or whose ComfyUI was relaunched on the box, may not carry it, and the
# budget must not be granted on a promise. ComfyUI publishes its own argv on
# /system_stats (`system.argv`), so the lane itself is the source of truth: the
# MCP guard asks POST /api/lanes/resolve below before pricing a reference job
# and holds a lane without the flag to the registry's smaller ceiling.
_LANE_LAUNCH_ARGS_TTL_S = 60.0
_lane_launch_args_cache = {}
_lane_launch_args_lock = threading.Lock()


def vram_headroom_gb_from_argv(argv):
    """`--vram-headroom N` (or `--vram-headroom=N`) from a ComfyUI argv, in GB.

    0.0 when the flag is absent — ComfyUI's own default — and None when argv is
    not a list. The two must stay distinct: "launched without" is a fact that
    shrinks the budget, "unknown" is not. The last occurrence wins, as argparse
    would have it."""
    if not isinstance(argv, (list, tuple)):
        return None
    items = [str(item) for item in argv]
    value = 0.0
    for index, item in enumerate(items):
        raw = None
        if item == "--vram-headroom" and index + 1 < len(items):
            raw = items[index + 1]
        elif item.startswith("--vram-headroom="):
            raw = item.split("=", 1)[1]
        if raw is None:
            continue
        try:
            value = float(raw)
        except ValueError:
            continue
    return max(0.0, value)


def _comfy_lane_system_probe(lane, timeout=4.0):
    """One cached read of a lane's /system_stats: (argv, vram_total_gb).

    Cached per lane for a minute: a lane's flags and its card change only when
    its ComfyUI is relaunched or the lane is re-attached, and a reference job
    asks twice (pre-flight, then the check on the staged files). Raises when the
    lane does not answer or does not publish its argv — the caller decides what
    an unknown is worth. vram_total_gb is the first device's total VRAM in GiB
    (None when the lane publishes no device)."""
    base = COMFY_LANES.get(lane, config.COMFY_HTTP_DEFAULT).rstrip('/')
    now = time.monotonic()
    with _lane_launch_args_lock:
        cached = _lane_launch_args_cache.get(lane)
        if cached and cached[0] == base and cached[1] > now:
            return list(cached[2]), (cached[3] if len(cached) > 3 else None)
    with net.urlopen(comfy_lane_request(lane, "/system_stats"), timeout=timeout) as response:
        if response.status >= 400:
            raise RuntimeError(f"answered HTTP {response.status}")
        payload = json.loads(response.read().decode("utf-8"))
    payload = payload if isinstance(payload, dict) else {}
    argv = (payload.get("system") or {}).get("argv")
    if not isinstance(argv, list):
        raise RuntimeError("/system_stats carries no system.argv")
    argv = [str(item) for item in argv]
    vram_total_gb = None
    devices = payload.get("devices")
    if isinstance(devices, list) and devices and isinstance(devices[0], dict):
        try:
            total = float(devices[0].get("vram_total"))
        except (TypeError, ValueError):
            total = 0.0
        if total > 0:
            vram_total_gb = round(total / (1024 ** 3), 2)
    with _lane_launch_args_lock:
        _lane_launch_args_cache[lane] = (base, now + _LANE_LAUNCH_ARGS_TTL_S, list(argv), vram_total_gb)
    return argv, vram_total_gb


def comfy_lane_launch_args(lane, timeout=4.0):
    """The argv ComfyUI on `lane` was launched with, read from its /system_stats."""
    return _comfy_lane_system_probe(lane, timeout=timeout)[0]


def comfy_lane_vram_headroom(lane, timeout=4.0):
    """What the lane's ComfyUI was launched with, and on what card, in the terms
    the motion-reference budget needs.

    Returns {"lane", "remote", "vram_headroom_gb", "vram_total_gb", "probed",
    "error"}: vram_headroom_gb is the flag's value (0.0 = launched without it)
    once probed, vram_total_gb the lane's card in GiB (None when it publishes
    no device), and both None with an error string when the lane could not be
    asked. Never raises — a lane that will not answer is the liveness probe's
    problem to name at submit, not this one's."""
    record = {
        "lane": lane,
        "remote": comfy_lane_is_remote(lane),
        "vram_headroom_gb": None,
        "vram_total_gb": None,
        "row_observations": None,
        "probed": False,
        "error": None,
    }
    try:
        argv, vram_total_gb = _comfy_lane_system_probe(lane, timeout=timeout)
    except Exception as exc:
        record["error"] = f"{exc.__class__.__name__}: {exc}"
        return record
    record["vram_headroom_gb"] = vram_headroom_gb_from_argv(argv)
    record["vram_total_gb"] = vram_total_gb
    # What this card size has actually done, so the guard can bound a predicted
    # budget by observed reality in both directions.
    record["row_observations"] = row_observations_for(vram_total_gb)
    record["probed"] = True
    return record


def comfy_lane_request(lane, path, data=None, method=None, headers=None, content_type=None):
    """Build a urllib Request to a lane, attaching the lane's auth token."""
    base = COMFY_LANES.get(lane, config.COMFY_HTTP_DEFAULT).rstrip('/')
    all_headers = dict(headers or {})
    if content_type:
        all_headers['Content-Type'] = content_type
    token = comfy_lane_token(lane)
    if token:
        all_headers['Authorization'] = f"Bearer {token}"
    return Request(base + path, data=data, method=method, headers=all_headers)


class ComfyLanePinError(RuntimeError):
    """A "Run on" pin named a rented machine the gateway cannot route to."""


# --- what the card itself has proven ------------------------------------------
# A packed-row budget is a PREDICTION of a physical limit, and predictions have
# been wrong in both directions: 85,000 was interpolated between a clean run and
# a failure, and a job inside that gap died (2026-08-23). So the gateway records
# what actually happens on each card and the guard is bounded by it — never
# above a run that OOM'd, never below one that finished. The card is the
# authority; the registry number is only where it starts.
#
# Keyed by the card's VRAM in whole GiB, because that is what decides capacity
# and it survives a machine being destroyed and re-rented. Free VRAM is NOT read
# for this: under cudaMallocAsync an idle healthy box already reports ~6 GiB
# "used" that belongs to no model, so a live reading would shrink budgets on a
# card that is perfectly empty.
H3_ROW_OBSERVATIONS_FILE = config.GATEWAY_STATE_DIR / "h3-row-observations.json"
_row_observations_lock = threading.Lock()
# A card that OOM'd at N rows is not asked to do N again: the guard is held a
# little under it, because the failure point is not exactly reproducible (the
# allocator's fragmentation moves it).
OOM_OBSERVATION_SAFETY = 0.95


def _read_row_observations():
    try:
        data = json.loads(H3_ROW_OBSERVATIONS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return {k: v for k, v in (data or {}).items() if isinstance(v, dict)}


def _card_key(vram_total_gb):
    try:
        card = int(round(float(vram_total_gb)))
    except (TypeError, ValueError):
        return None
    return str(card) if card > 0 else None


def record_row_observation(vram_total_gb, rows, outcome, *, lane=None):
    """Remember that a run of `rows` packed rows finished, or ran out of memory,
    on a card of this size. Never raises: bookkeeping must not take a generation
    down with it."""
    key = _card_key(vram_total_gb)
    try:
        rows = int(rows)
    except (TypeError, ValueError):
        return None
    if not key or rows <= 0 or outcome not in ("clean", "oom"):
        return None
    try:
        with _row_observations_lock:
            data = _read_row_observations()
            entry = data.get(key) or {}
            if outcome == "clean":
                # The largest run PROVEN to finish. Only ever grows, and only
                # from a run that really completed.
                entry["clean_rows"] = max(int(entry.get("clean_rows") or 0), rows)
            else:
                seen = entry.get("oom_rows")
                entry["oom_rows"] = min(int(seen), rows) if seen else rows
            entry[f"{outcome}_at"] = datetime.now(timezone.utc).isoformat()
            if lane:
                entry[f"{outcome}_lane"] = str(lane)
            entry["samples"] = int(entry.get("samples") or 0) + 1
            data[key] = entry
            H3_ROW_OBSERVATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
            H3_ROW_OBSERVATIONS_FILE.write_text(json.dumps(data, indent=1), encoding="utf-8")
            return dict(entry)
    except Exception as exc:
        print(f"[comfy-lanes] could not record a row observation: {exc}", file=sys.stderr)
        return None


def row_observations_for(vram_total_gb):
    """What this card size has proven, for the guard to bound itself by."""
    key = _card_key(vram_total_gb)
    if not key:
        return None
    entry = _read_row_observations().get(key)
    return dict(entry) if entry else None


def _looks_like_an_out_of_memory(message):
    text = str(message or "").lower()
    return "outofmemory" in text or "out of memory" in text


def _packed_rows_from_comfy_prompt_body(body):
    """The row count the MCP priced this graph at, if it said. Sent alongside
    `run_on` and stripped before the graph reaches ComfyUI — it is our
    bookkeeping, not a node input."""
    try:
        data = json.loads(
            body.decode("utf-8", errors="replace")
            if isinstance(body, (bytes, bytearray)) else body
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        rows = int(data.get("packed_rows"))
    except (TypeError, ValueError):
        return None
    return rows if rows > 0 else None


def _run_on_from_comfy_prompt_body(body):
    """The rented machine a /prompt body asks to run on — the studio's per-tab
    "Run on" pin. Top-level `run_on`, or `extra_data.extra_pnginfo.runOn` for
    callers that carry everything in the PNG info the way studioLane rides."""
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
        data.get('run_on')
        or extra_pnginfo.get('runOn')
        or extra_pnginfo.get('run_on')
        or ''
    ).strip()[:128]


def comfy_lane_for_pin(run_on):
    """The attached rental lane a "Run on" pin names; None when nothing is pinned.

    The pin is the rental id the studio shows (the attachment registry's key,
    e.g. "vast:48352597"); a lane name is accepted too. A pin naming a machine
    that is no longer attached RAISES instead of falling back: the tab asked
    for that box, and quietly spending another box's hours (or a local lane's
    minutes) is exactly the surprise the pin exists to prevent. The studio
    drops a stale pin on its next machine refresh; an agent gets the reason.
    """
    pin = str(run_on or '').strip()
    if not pin:
        return None
    refresh_comfy_lanes()
    for lane, spec in _read_rental_attachments().items():
        if (spec.get('rental_id') == pin or lane == pin) and lane in COMFY_LANES:
            return lane
    raise ComfyLanePinError(
        f"the rented machine this job is pinned to ({pin}) is no longer attached — "
        "pick another machine under Run on, or send no run_on to follow the default routing"
    )


def comfy_lane_for_prompt_body(body, run_on=None):
    """Pick a configured Comfy lane from graph class/model names only.

    Rules are data-driven via COMFY_LANE_RULES, e.g.
    "anima=anima,qwen35,qwen3.5;sdxl=sdxl,pony". Prompt text is intentionally
    ignored; only class names and model-ish input values are inspected.

    `run_on` is the studio's per-tab "Run on" pin: the pinned machine's rule
    is tried FIRST, ahead of the priority order — the same thing the global
    /select does, scoped to this one request. A pin whose machine does not
    serve the graph falls through to the normal order (the pin settles which
    of several capable boxes runs a job; it never sends a model to a box that
    lacks it), and a pin naming a detached machine raises ComfyLanePinError.
    """
    pinned = comfy_lane_for_pin(run_on)
    # Pick up a machine attached since this process started, so routing a
    # generation to a fresh rental needs no restart.
    refresh_comfy_lanes()
    prompt = graphs._prompt_nodes_from_body(body)
    haystack = []
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        haystack.append(str(node.get('class_type') or '').lower())
        inputs = node.get('inputs') or {}
        if not isinstance(inputs, dict):
            continue
        for key, value in inputs.items():
            key_l = str(key).lower()
            if _is_modelish_input_key(key_l):
                if isinstance(value, str):
                    haystack.append(value.lower())
    text = ' '.join(haystack)
    if pinned is not None:
        pinned_needles = next((needles for lane, needles in COMFY_LANE_RULES if lane == pinned), [])
        if any(needle in text for needle in pinned_needles):
            return pinned
    for lane, needles in COMFY_LANE_RULES:
        if lane in COMFY_LANES and any(needle in text for needle in needles):
            return lane
    return 'default'


def comfy_http_for_prompt_body(body, run_on=None):
    return COMFY_LANES.get(comfy_lane_for_prompt_body(body, run_on=run_on), config.COMFY_HTTP_DEFAULT)


def _is_modelish_input_key(key):
    key_l = str(key).lower()
    return key_l in graphs.COMFY_MODELISH_INPUT_KEYS or any(part in key_l for part in ('model', 'ckpt', 'unet', 'vae', 'clip', 'encoder'))
