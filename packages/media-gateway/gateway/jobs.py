"""The in-flight job registry: the GPU slot semaphore, the Klein memory
budget, cancellation, and permanent deletion of an output everywhere."""
import contextlib
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import shutil
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse, urlencode, unquote

from gateway import config, history, lanes, media as _media, native_mlx, net, promptroutes, util, workflow_index


jobs = {}
jobs_lock = threading.Lock()
# Native/gateway generation bypasses ComfyUI's own executor, so it needs the
# same queue contract here: one worker at a time in an app-tab lane, with image
# and video kept as independent media domains. Different tabs retain distinct
# lanes and may overlap. Klein adds duplicate coalescing and a memory admission
# check on top of this shared scheduler.
studio_generation_lanes = {}
studio_generation_lanes_lock = threading.Lock()
# Above the lanes: how many jobs may hold the accelerator at once, across every
# tab and both media types. See gpu_slot_capacity().
gpu_slot_condition = threading.Condition()
gpu_slots_in_use = 0
gpu_slot_waiters = []  # job ids, arrival order — the queue position shown to the studio
klein_inflight_jobs = {}
klein_memory_condition = threading.Condition()
klein_reserved_memory_bytes = 0
# Live subprocess handles for native (MLX) generation jobs, so a cancel request
# can terminate the render instead of letting it burn the GPU to completion.
native_job_procs = {}


def _record_without_output(record, name):
    if not isinstance(record, dict):
        return record, False
    changed = False
    result = dict(record)
    for key in ("outputs", "image_urls", "video_urls", "files"):
        values = result.get(key)
        if not isinstance(values, list):
            continue
        kept = [value for value in values if Path(urlparse(str(value)).path).name.removesuffix(_media.OUTPUT_ENCRYPTION_SUFFIX) != name]
        if len(kept) != len(values):
            result[key] = kept
            changed = True
    return result, changed


def _rewrite_one_history_file_without_output(path, name):
    if not path.exists():
        return 0
    records = []
    changed = 0
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                cleaned, record_changed = _record_without_output(record, name)
                changed += int(record_changed)
                if isinstance(cleaned, dict):
                    records.append(cleaned)
        if changed:
            util._atomic_write_jsonl(path, records)
    except OSError as exc:
        raise RuntimeError("failed to purge durable generation history") from exc
    return changed


def _rewrite_gateway_history_without_output(name):
    # Both generations: rotation keeps the older log, and a delete that skipped
    # it would leave the reference it promises to remove sitting on disk.
    return sum(
        _rewrite_one_history_file_without_output(path, name)
        for path in (history.HISTORY_FILE, history.HISTORY_PREVIOUS_FILE)
    )


def _rewrite_workflow_index_without_output(name):
    removed_prompt_ids = set()
    touched_prompt_ids = set()
    records = []
    changed = 0
    with workflow_index.workflow_index_lock:
        if workflow_index.WORKFLOW_INDEX_FILE.exists():
            try:
                with workflow_index.WORKFLOW_INDEX_FILE.open("r", encoding="utf-8") as handle:
                    for line in handle:
                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        filenames = record.get("filenames") if isinstance(record.get("filenames"), list) else []
                        kept = [value for value in filenames if Path(str(value)).name != name]
                        if len(kept) != len(filenames):
                            changed += 1
                            if record.get("prompt_id"):
                                touched_prompt_ids.add(str(record["prompt_id"]))
                            if not kept and record.get("prompt_id"):
                                removed_prompt_ids.add(str(record["prompt_id"]))
                        if kept:
                            records.append({**record, "filenames": kept})
                if changed:
                    util._atomic_write_jsonl(workflow_index.WORKFLOW_INDEX_FILE, records)
            except OSError as exc:
                raise RuntimeError("failed to purge encrypted workflow history") from exc
        workflow_index._workflow_index.pop(name, None)
        index_record = workflow_index._workflow_index_records.pop(name, None)
        if isinstance(index_record, dict) and index_record.get("prompt_id"):
            prompt_id = str(index_record["prompt_id"])
            if not any(str(value.get("prompt_id") or "") == prompt_id for value in workflow_index._workflow_index_records.values()):
                removed_prompt_ids.add(prompt_id)
        for prompt_id in removed_prompt_ids:
            workflow_index._workflow_index_prompts.discard(prompt_id)
    return changed, touched_prompt_ids


def _purge_queue_metadata(prompt_ids):
    changed = 0
    for cache_file in config.QUEUE_METADATA_FILES:
        if not cache_file.exists():
            continue
        try:
            data = json.loads(cache_file.read_text(encoding="utf-8"))
            prompts = data.get("prompts") if isinstance(data, dict) else None
            if not isinstance(prompts, dict):
                continue
            for prompt_id in prompt_ids:
                if prompts.pop(prompt_id, None) is not None:
                    changed += 1
            if changed:
                temporary = cache_file.with_name(f".{cache_file.name}.{os.getpid()}.tmp")
                temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                os.replace(temporary, cache_file)
        except (OSError, json.JSONDecodeError):
            continue
    return changed


def _delete_prompt_ids_from_comfy(prompt_ids):
    failures = []
    if not prompt_ids:
        return failures
    body = json.dumps({"delete": sorted(prompt_ids)}).encode("utf-8")
    for lane, base in lanes.COMFY_LANES.items():
        try:
            request = lanes.comfy_lane_request(
                lane, "/history", data=body, method="POST",
                content_type="application/json",
            )
            with net.urlopen(request, timeout=10):
                pass
        except Exception:
            failures.append(lane)
    return failures


def _queue_entry_ids(entries):
    # Queue entries are [number, prompt_id, prompt, extra, outputs] tuples;
    # only the id is read, so prompt redaction does not matter here.
    return {str(item[1]) for item in (entries or []) if isinstance(item, (list, tuple)) and len(item) > 1}


def _lane_queue_state(lane, prompt_id):
    """Where `prompt_id` sits on one lane: 'pending', 'running', or None."""
    try:
        with net.urlopen(lanes.comfy_lane_request(lane, "/queue"), timeout=10) as response:
            state = json.loads(response.read().decode("utf-8") or "{}")
    except Exception:
        return None
    if prompt_id in _queue_entry_ids(state.get("queue_pending")):
        return "pending"
    if prompt_id in _queue_entry_ids(state.get("queue_running")):
        return "running"
    return None


# How long a cancel waits for the backend to actually let go before answering.
# Kept under the studio's own cancel timeout so the honest verdict gets back
# rather than the caller giving up and inventing one.
CANCEL_VERIFY_SECONDS = float(os.environ.get("ZIMG_CANCEL_VERIFY_SECONDS", "8") or 8)
CANCEL_VERIFY_POLL_SECONDS = 0.5


def interrupt_comfy_prompt(prompt_id, verify_seconds=None):
    """Stop one Comfy prompt across every lane, and report whether it ACTUALLY
    stopped.

    A pending prompt is deleted from the queue and is gone immediately. A
    running one can only be asked: Comfy checks for an interrupt at node and
    sampler-step boundaries, so a prompt still inside a long non-interruptible
    stretch — loading a 17k-step video model, say — keeps the GPU until it
    reaches the next checkpoint. That can be minutes.

    This used to return True the moment a lane ACCEPTED the /interrupt POST,
    which is a receipt, not a death certificate. The studio showed "cancelled"
    instantly, the next generation queued behind a job that was still running,
    and the wait looked like the cancel had done nothing. So after asking, poll
    the lane until the prompt leaves its queue.

    Returns {'acknowledged', 'stopped', 'lane', 'state'} where `stopped` means
    the prompt is verifiably off the queue and `state` is where it was last
    seen ('pending', 'running', or None for never-found).
    """
    pid = str(prompt_id or "")
    result = {"acknowledged": False, "stopped": False, "lane": "", "state": None}
    if not pid:
        return result
    deadline = time.monotonic() + (CANCEL_VERIFY_SECONDS if verify_seconds is None else float(verify_seconds))

    seen_bases = set()
    for lane, base in lanes.COMFY_LANES.items():
        if base in seen_bases:
            continue
        seen_bases.add(base)
        state = _lane_queue_state(lane, pid)
        if state is None:
            continue
        result.update(lane=lane, state=state)
        try:
            if state == "pending":
                body = json.dumps({"delete": [pid]}).encode("utf-8")
                with net.urlopen(lanes.comfy_lane_request(lane, "/queue", data=body, method="POST", content_type="application/json"), timeout=10):
                    result["acknowledged"] = True
            else:
                with net.urlopen(lanes.comfy_lane_request(lane, "/interrupt", data=b"{}", method="POST", content_type="application/json"), timeout=10):
                    result["acknowledged"] = True
        except Exception:
            continue
        # Verify: a delete is effective at once, an interrupt may not be.
        while True:
            if _lane_queue_state(lane, pid) is None:
                result["stopped"] = True
                break
            if time.monotonic() >= deadline:
                break
            time.sleep(CANCEL_VERIFY_POLL_SECONDS)
        return result

    # Never found on any lane: nothing of ours is holding a GPU, which is the
    # same end state the caller wanted. Distinguished from a verified stop by
    # `acknowledged` staying False.
    result["stopped"] = True
    return result


def cancel_generation_job(jid):
    """Cancel one generation job wherever it runs. Native (MLX) jobs get their
    live subprocess terminated plus a cancel flag the runner checks between
    stages; Comfy-routed jobs (the job id is the Comfy prompt id) are removed
    from the queue or interrupted mid-execution. Cancelling an unknown or
    already-finished job is a no-op, not an error, so the studio can always
    unblock its UI."""
    jid = str(jid)
    with jobs_lock:
        rec = jobs.get(jid)
        active = rec is not None and rec.get("status") in ("queued", "running")
        if active:
            rec["cancel_requested"] = True
        proc = native_job_procs.get(jid)
        comfy_prompt_id = str((rec or {}).get("comfy_prompt_id") or "")
    interrupted = False
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
            interrupted = True
        except Exception:
            pass
    stopped = interrupted
    state = None
    if active and not interrupted and not comfy_prompt_id:
        # A native job between subprocess stages: no live process to kill right
        # now, but the runner aborts at its next cancel-flag checkpoint. Asked,
        # not confirmed — same distinction the Comfy path makes below.
        interrupted = True
        stopped = False
    if not interrupted:
        pid = comfy_prompt_id or jid
        outcome = interrupt_comfy_prompt(pid)
        interrupted = bool(outcome["acknowledged"])
        stopped = bool(outcome["stopped"])
        state = outcome["state"]
        # A deliberate cancel is not a failure. Recording it as one leaves the
        # route (and everything downstream that reads it) claiming the
        # generation broke, which is both wrong and alarming in History.
        # No-ops for an id with no route (a local job), so no guard needed.
        promptroutes.update_comfy_prompt_route(
            pid, status="cancelled", cancelled_at=datetime.now(timezone.utc).isoformat(),
        )
    return {
        "ok": True,
        "id": jid,
        "known": rec is not None,
        # Receipt: the backend accepted the request to stop.
        "interrupted": bool(interrupted),
        # Verdict: the job is verifiably no longer holding the backend. False
        # means it is still winding down and the next job WILL queue behind it.
        "stopped": bool(stopped),
        **({"backend_state": state} if state else {}),
    }


def delete_output_everywhere(value):
    name = util.safe_name(value)
    if not name or Path(name).suffix.lower() not in _media.OUTPUT_MEDIA_EXTS:
        raise ValueError("valid media filename required")

    history_records = _rewrite_gateway_history_without_output(name)
    workflow_records, prompt_ids = _rewrite_workflow_index_without_output(name)
    queue_metadata = _purge_queue_metadata(prompt_ids)

    with jobs_lock:
        live_records = 0
        for job_id, record in list(jobs.items()):
            cleaned, changed = _record_without_output(record, name)
            if changed:
                jobs[job_id] = cleaned
                live_records += 1

    deleted_files = 0
    for root in (config.OUT_DIR, config.COMFY_OUTPUT_DIR):
        try:
            if not root.exists():
                continue
            for candidate in list(root.rglob("*")):
                if not candidate.is_file():
                    continue
                logical = _media.logical_path_for_encrypted(candidate)
                if logical.name != name:
                    continue
                candidate.unlink(missing_ok=True)
                deleted_files += 1
        except OSError as exc:
            raise RuntimeError("failed to remove every private media copy") from exc

    preview_files = 0
    for cache_root in config.PREVIEW_CACHE_ROOTS:
        try:
            if not cache_root.exists():
                continue
            for candidate in list(cache_root.rglob("*")):
                if candidate.is_file():
                    candidate.unlink(missing_ok=True)
                    preview_files += 1
            for candidate in sorted(cache_root.rglob("*"), reverse=True):
                if candidate.is_dir():
                    candidate.rmdir()
        except OSError:
            continue

    lane_failures = _delete_prompt_ids_from_comfy(prompt_ids)
    return {
        "ok": True,
        "deleted_files": deleted_files,
        "history_records": history_records,
        "workflow_records": workflow_records,
        "live_records": live_records,
        "queue_metadata": queue_metadata,
        "preview_files": preview_files,
        "lane_cleanup_deferred": len(lane_failures),
    }


def mirror_output_to_comfy_output(path, job_id=None):
    src = Path(path).resolve()
    if not src.exists() or not src.is_file():
        return src
    if _media.OUTPUT_ENCRYPTION_ENABLED:
        # Do not duplicate native outputs into a second plaintext directory.
        return _media.encrypt_output_file(src, agent_spki=_media.agent_seal_recipient_for(job_id))
    config.COMFY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    dst = (config.COMFY_OUTPUT_DIR / util.safe_name(src.name)).resolve()
    if str(dst).startswith(str(config.COMFY_OUTPUT_DIR.resolve())) and dst != src:
        try:
            shutil.copy2(src, dst)
            return dst
        except OSError as e:
            print(f"[native-mlx] failed to mirror output to Comfy output dir: {e}", file=sys.stderr)
    return src


def active_jobs():
    with jobs_lock:
        return [history.public_record(r) for r in jobs.values() if r.get("status") in {"queued", "running"}]


def all_records(limit=200):
    seen = set()
    recs = []
    for r in active_jobs() + [history.public_record(r) for r in history.load_history(limit)] + [history.public_record(r) for r in _media.output_file_records(limit)]:
        rid = r.get("id")
        output_key = tuple(Path(p).name for p in r.get("outputs", []) if p)
        key = output_key or (rid,)
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        recs.append(r)
    recs.sort(key=lambda r: r.get("finished_at") or r.get("created_at") or "", reverse=True)
    return recs[:limit]


def _klein_request_fingerprint(prompt, image_paths, options=None, *, mode='edit', extra=None):
    """Hash the inputs that affect a Klein render without retaining the prompt.

    Inline uploads receive a fresh staged filename for every HTTP request, so
    paths cannot identify retries. Hashing the bytes is what lets a 27-request
    retry storm collapse back into the one render the caller intended.
    """
    digest = hashlib.sha256()

    def add_part(label, value):
        payload = str(value).encode('utf-8', errors='surrogatepass')
        digest.update(label.encode('ascii') + b'\0' + len(payload).to_bytes(8, 'big') + payload)

    add_part('version', 'klein-admission-v1')
    add_part('mode', mode)
    add_part('prompt', prompt or '')
    canonical_options = {
        key: value for key, value in dict(options or {}).items()
        if key != 'image_paths'
    }
    add_part(
        'options',
        json.dumps(canonical_options, sort_keys=True, separators=(',', ':'), default=str),
    )
    if extra is not None:
        add_part('extra', json.dumps(extra, sort_keys=True, separators=(',', ':'), default=str))
    for image_path in image_paths:
        path = Path(str(image_path)).expanduser()
        try:
            with path.open('rb') as handle:
                image_digest = hashlib.sha256()
                for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                    image_digest.update(chunk)
            add_part('image', image_digest.hexdigest())
        except OSError:
            # Validation and the user-facing error still happen in the runner.
            # Including the unresolved input in the private digest keeps two
            # different missing paths from incorrectly sharing one job.
            add_part('missing-image', str(path.resolve()))
    return digest.hexdigest()


def _register_klein_job(job_id, fingerprint, record):
    """Register one job or return the equivalent job already in flight."""
    with jobs_lock:
        existing_job_id = klein_inflight_jobs.get(fingerprint)
        existing = jobs.get(existing_job_id) if existing_job_id else None
        if existing and existing.get('status') in {'queued', 'running'}:
            existing['coalesced_requests'] = int(existing.get('coalesced_requests') or 0) + 1
            jobs[existing_job_id] = existing
            return existing_job_id
        if existing_job_id:
            klein_inflight_jobs.pop(fingerprint, None)
        jobs[job_id] = record
        klein_inflight_jobs[fingerprint] = job_id
    return job_id


def _studio_generation_lane_key(media_type, options=None):
    media = str(media_type or '').strip().lower()
    if media not in {'image', 'video'}:
        raise ValueError(f'unsupported generation media type: {media_type}')
    raw = str(dict(options or {}).get('studio_lane') or 'legacy-clients').strip()
    # Callers choose this value, so keep the scheduler key bounded and opaque.
    scoped = f'{media}:{raw[:512]}'
    return hashlib.sha256(scoped.encode('utf-8', errors='replace')).hexdigest()


def gpu_slot_capacity():
    """How many generations may hold the accelerator at once.

    Lanes are per app tab on purpose, so one tab's queue never blocks another's
    — but nothing above them limited how many models were loaded at the same
    time, and two tabs generating at once on unified memory is a stall or an
    out-of-memory rather than parallelism. One slot is the honest default for a
    machine with one GPU; `lanes.gpu_slots` in the settings document raises it
    for someone with the headroom.
    """
    raw = str(os.environ.get('ZIMG_GPU_SLOTS', '') or '').strip()
    try:
        value = int(raw) if raw else 1
    except ValueError:
        value = 1
    return max(1, min(value, 8))


def _set_job_queue_state(job_id, position):
    """Say, on the job record, that this one is waiting for the accelerator.

    `queue_position` is how many renders are ahead of it, so the studio can show
    "Waiting behind 1 render" instead of a bar that never moves. Only a job that
    has not started is touched — a runner that has already claimed the record
    owns its own status from then on.
    """
    if not job_id:
        return
    with jobs_lock:
        rec = jobs.get(job_id)
        if not isinstance(rec, dict) or rec.get('status') not in (None, 'queued'):
            return
        updated = dict(rec)
        updated['status'] = 'queued'
        updated['queue_position'] = int(position)
        updated['progress_phase'] = 'waiting for the GPU'
        jobs[job_id] = updated


def _clear_job_queue_state(job_id):
    if not job_id:
        return
    with jobs_lock:
        rec = jobs.get(job_id)
        if not isinstance(rec, dict) or 'queue_position' not in rec:
            return
        updated = dict(rec)
        updated.pop('queue_position', None)
        if updated.get('progress_phase') == 'waiting for the GPU':
            updated.pop('progress_phase', None)
        jobs[job_id] = updated


def _acquire_gpu_slot(job_id):
    """Wait for a free accelerator slot, reporting the wait on the job record."""
    global gpu_slots_in_use
    # A ticket rather than the job id: identity has to be unique even for a
    # caller that had no job id to give.
    ticket = object()
    with gpu_slot_condition:
        gpu_slot_waiters.append(ticket)
        try:
            while True:
                ahead = gpu_slot_waiters.index(ticket)
                if ahead == 0 and gpu_slots_in_use < gpu_slot_capacity():
                    gpu_slots_in_use += 1
                    break
                _set_job_queue_state(job_id, gpu_slots_in_use + ahead)
                gpu_slot_condition.wait(timeout=2.0)
        finally:
            with contextlib.suppress(ValueError):
                gpu_slot_waiters.remove(ticket)
        gpu_slot_condition.notify_all()
    _clear_job_queue_state(job_id)


def _release_gpu_slot():
    global gpu_slots_in_use
    with gpu_slot_condition:
        gpu_slots_in_use = max(0, gpu_slots_in_use - 1)
        gpu_slot_condition.notify_all()


def _drain_studio_generation_lane(lane_key):
    """Run one tab's submitted jobs in FIFO order, then discard the lane."""
    while True:
        with studio_generation_lanes_lock:
            lane = studio_generation_lanes.get(lane_key)
            if not lane or not lane['pending']:
                studio_generation_lanes.pop(lane_key, None)
                return
            runner, args = lane['pending'].pop(0)
        # Every caller passes the job id first; without one the slot is still
        # taken, the wait just cannot be reported anywhere.
        job_id = args[0] if args and isinstance(args[0], str) else ''
        _acquire_gpu_slot(job_id)
        try:
            runner(*args)
        except Exception as error:
            # Generation runners normally persist their own terminal error. An
            # unexpected escape must not kill the lane and strand every job
            # queued behind it.
            print(
                f"[studio-queue] {getattr(runner, '__name__', 'generation')} failed: {error}",
                file=sys.stderr,
            )
        finally:
            _release_gpu_slot()


def start_studio_generation_thread(media_type, options, runner, args):
    """Start one queued generation worker in the caller's app-tab lane."""
    lane_key = _studio_generation_lane_key(media_type, options)
    with studio_generation_lanes_lock:
        lane = studio_generation_lanes.get(lane_key)
        if lane is None:
            lane = {'pending': [], 'worker': None}
            studio_generation_lanes[lane_key] = lane
        lane['pending'].append((runner, args))
        if lane['worker'] is None:
            lane['worker'] = threading.Thread(
                target=_drain_studio_generation_lane,
                args=(lane_key,),
                daemon=True,
            )
            lane['worker'].start()
        return lane['worker']


def _record_klein_admission_error(job_id, error):
    with jobs_lock:
        rec = dict(jobs.get(job_id) or {'id': job_id, 'created_at': util.now_iso()})
        cancelled = isinstance(error, native_mlx.NativeJobCancelled)
        rec.update({
            'prompt': history.PRIVATE_PROMPT_LABEL,
            'status': 'cancelled' if cancelled else 'error',
            'finished_at': util.now_iso(),
            'error': 'Cancelled by the owner' if cancelled else str(error),
            'progress_phase': 'cancelled' if cancelled else 'error',
        })
        jobs[job_id] = rec
    history.append_history(rec)


def _run_admitted_klein_job(job_id, fingerprint, runner, args):
    """Queue within one tab lane, then reserve global memory before model load."""
    reservation = 0
    try:
        reservation = _acquire_klein_memory_reservation(job_id)
        runner(*args)
    except Exception as error:
        _record_klein_admission_error(job_id, error)
    finally:
        _release_klein_memory_reservation(reservation)
        with jobs_lock:
            if klein_inflight_jobs.get(fingerprint) == job_id:
                klein_inflight_jobs.pop(fingerprint, None)


def _available_memory_bytes():
    """Best-effort memory available for a new model load.

    macOS's `memory_pressure` accounts for reclaimable/compressed unified
    memory more accurately than raw free pages. Other platforms use POSIX
    available pages when exposed; an unknown reading does not reject a job.
    """
    if sys.platform == 'darwin':
        try:
            output = subprocess.check_output(
                ['memory_pressure', '-Q'], text=True, timeout=5,
                stderr=subprocess.DEVNULL,
            )
            total_match = re.search(r'The system has\s+(\d+)', output)
            free_match = re.search(r'memory free percentage:\s*(\d+(?:\.\d+)?)%', output, re.I)
            if total_match and free_match:
                return int(int(total_match.group(1)) * float(free_match.group(1)) / 100.0)
        except (OSError, subprocess.SubprocessError, ValueError):
            return None
        return None
    try:
        return int(os.sysconf('SC_PAGE_SIZE')) * int(os.sysconf('SC_AVPHYS_PAGES'))
    except (OSError, TypeError, ValueError):
        return None


def _klein_memory_limits():
    try:
        headroom_gb = float(os.environ.get('ZIMG_KLEIN_MIN_AVAILABLE_MEMORY_GB', '24'))
    except ValueError:
        headroom_gb = 24.0
    try:
        job_gb = float(os.environ.get('ZIMG_KLEIN_JOB_MEMORY_GB', '24'))
    except ValueError:
        job_gb = 24.0
    # Do not allow a typo or stale environment override to silently remove the
    # safety margin. Klein 9B reached ~16.6 GiB RSS in the incident snapshot.
    headroom_gb = max(20.0, min(headroom_gb, 64.0))
    job_gb = max(20.0, min(job_gb, 64.0))
    return int(headroom_gb * 1024 ** 3), int(job_gb * 1024 ** 3)


def _acquire_klein_memory_reservation(job_id):
    """Atomically reserve memory across tab lanes, waiting instead of overloading.

    The reservation closes the race where two tabs both observe ample memory
    before either child process has allocated its model. If macOS cannot report
    pressure, only one unknown-size Klein reservation is admitted at a time.
    """
    global klein_reserved_memory_bytes
    headroom, reservation = _klein_memory_limits()
    try:
        wait_seconds = float(os.environ.get('ZIMG_KLEIN_MEMORY_WAIT_SECONDS', '600'))
    except ValueError:
        wait_seconds = 600.0
    deadline = time.monotonic() + max(30.0, min(wait_seconds, 3600.0))
    while True:
        if native_mlx.native_job_cancel_requested(job_id):
            raise native_mlx.NativeJobCancelled(f'job {job_id} was cancelled while queued')
        available = _available_memory_bytes()
        with klein_memory_condition:
            safe = (
                klein_reserved_memory_bytes == 0
                if available is None
                else available - klein_reserved_memory_bytes >= headroom + reservation
            )
            if safe:
                klein_reserved_memory_bytes += reservation
                return reservation
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                available_text = 'unknown' if available is None else f'{available / 1024 ** 3:.1f} GiB'
                raise RuntimeError(
                    'timed out waiting for safe unified-memory headroom for Klein 9B '
                    f'(available: {available_text})'
                )
            klein_memory_condition.wait(timeout=min(2.0, remaining))


def _release_klein_memory_reservation(reservation):
    global klein_reserved_memory_bytes
    if not reservation:
        return
    with klein_memory_condition:
        klein_reserved_memory_bytes = max(0, klein_reserved_memory_bytes - int(reservation))
        klein_memory_condition.notify_all()
