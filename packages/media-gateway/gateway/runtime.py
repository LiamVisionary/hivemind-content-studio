"""Process lifecycle: the startup self-check, signal handlers, graceful
shutdown of in-flight work, and main()."""
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from gateway import config, history, http, jobs, media, promptroutes, restore, util, workflow_index


JOB_INTERRUPTED_MESSAGE = "The studio restarted before this finished."


def terminate_native_job_processes(timeout=3.0):
    """Stop every native (MLX) render this process started — and its workers.

    The children are started in their own session (start_new_session=True), so
    the whole group goes at once. Killing only the parent leaves its workers
    holding the GPU until they happen to notice a broken pipe, which is not a
    guarantee worth shipping on a machine that is about to start a new render.
    """
    with jobs.jobs_lock:
        running = [(job_id, proc) for job_id, proc in jobs.native_job_procs.items() if proc.poll() is None]
    for _job_id, proc in running:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except OSError:
            try:
                proc.terminate()
            except OSError:
                pass
    deadline = time.monotonic() + timeout
    for _job_id, proc in running:
        try:
            proc.wait(timeout=max(0.1, deadline - time.monotonic()))
        except Exception:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except OSError:
                pass
    return [job_id for job_id, _proc in running]


def _job_is_remote_in_flight(rec):
    """A prompt on a rented lane outlives this process on purpose.

    respawn_remote_comfy_watchers() re-arms its watcher on the next boot and
    harvests the output then, so marking it interrupted would be a lie AND
    would mask the live route record behind a terminal history entry.
    """
    route = promptroutes.comfy_prompt_route(rec.get("comfy_prompt_id"))
    return bool(isinstance(route, dict) and route.get("remote") and route.get("status") == "submitted")


def interrupt_in_flight_jobs():
    """Say what happened to the jobs this process was running when it stopped.

    Without this a restart left them in memory only: the poller asked for a job
    the gateway had never heard of, and the studio guessed — telling the user
    the clip would appear in History, which for a local render it never does.
    The record goes to history because that is where find_job() looks after a
    restart, so the next poll gets a true answer with a retry attached.
    """
    with jobs.jobs_lock:
        candidates = [
            rec for rec in jobs.jobs.values()
            if isinstance(rec, dict) and rec.get("status") in {"queued", "running"}
        ]
    # The route lookup takes its own lock; asking for it while holding jobs_lock
    # would nest two locks that nothing else nests.
    local = [rec for rec in candidates if not _job_is_remote_in_flight(rec)]
    interrupted = []
    with jobs.jobs_lock:
        for rec in local:
            if rec.get("status") not in {"queued", "running"}:
                continue  # finished between the two passes; leave it alone
            rec["status"] = "interrupted"
            rec["error"] = JOB_INTERRUPTED_MESSAGE
            rec["finished_at"] = rec.get("finished_at") or util.now_iso()
            interrupted.append(dict(rec))
    for rec in interrupted:
        try:
            history.append_history(rec)
        except Exception as exc:
            print(f"[shutdown] could not record interrupted job {rec.get('id')}: {exc}", file=sys.stderr)
    return interrupted


def shutdown_gateway(server=None):
    """The one ordering that matters on the way out.

    The job records go first because they are the only step that must reach
    disk: the stack sends SIGTERM and follows with SIGKILL about two seconds
    later, and a killed process writes nothing. Terminating the children is a
    signal plus a short reap, which fits in what is left. Safe to call twice.
    """
    interrupted = interrupt_in_flight_jobs()
    stopped = terminate_native_job_processes(timeout=1.0)
    if stopped or interrupted:
        print(
            f"[shutdown] stopped {len(stopped)} native render(s), "
            f"marked {len(interrupted)} job(s) interrupted",
            flush=True,
        )
    if server is not None:
        # serve_forever() must not be stopped from inside its own thread.
        threading.Thread(target=server.shutdown, daemon=True).start()
    return {"stopped": stopped, "interrupted": [rec.get("id") for rec in interrupted]}


def install_shutdown_handlers(server):
    stopping = threading.Event()

    def handle(signum, _frame):
        if stopping.is_set():
            return
        stopping.set()
        print(f"[shutdown] signal {signum}: stopping", flush=True)
        shutdown_gateway(server)

    for name in ("SIGTERM", "SIGINT"):
        with_signal = getattr(signal, name, None)
        if with_signal is not None:
            try:
                signal.signal(with_signal, handle)
            except (ValueError, OSError):
                pass  # not the main thread (embedded/test import): nothing to install
    return stopping
SUPPORTED_PYTHON = ((3, 11), (3, 13))


def startup_self_check():
    """Refuse to start on an interpreter that cannot do the job.

    The 2026-07-26 outage was this exact gap: the tests ran on the project venv
    and the service ran on whatever `python3` Homebrew had last upgraded to, so
    a stdlib removal took the whole studio down with a traceback nobody read.
    One line naming the fix beats a stack trace in a log file.
    """
    problems = []
    low, high = SUPPORTED_PYTHON
    if not (low <= sys.version_info[:2] < high):
        found = ".".join(str(part) for part in sys.version_info[:3])
        problems.append(f"Python {found} is outside the supported {low[0]}.{low[1]}-{high[0]}.{high[1] - 1} range")
    for module, package in (("cryptography", "cryptography"), ("PIL", "Pillow")):
        try:
            __import__(module)
        except ImportError:
            problems.append(f"{package} is not installed for this interpreter")
    if problems:
        print(
            f"[media-gateway] cannot start: {'; '.join(problems)}. "
            f"Run `uv sync` in the studio folder and start the stack again "
            f"(interpreter: {sys.executable}).",
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(2)


def main():
    startup_self_check()
    config.OUT_DIR.mkdir(parents=True, exist_ok=True)
    config.COMFY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    config.DEBUG_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    config.COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    if media.OUTPUT_ENCRYPTION_ENABLED:
        media.output_encryption_password(create=True)
        migrated = media.encrypt_existing_outputs_once(max_age_seconds=0)
        if migrated:
            print(f"[output-encryption] encrypted {migrated} existing output image(s)", flush=True)
        threading.Thread(target=media.output_encryption_sweeper, daemon=True).start()
    threading.Thread(target=workflow_index.workflow_index_sweeper, daemon=True).start()
    promptroutes.respawn_remote_comfy_watchers()
    media.cleanup_staged_private_inputs_once()
    threading.Thread(target=media.private_input_sweeper, daemon=True).start()
    # Restore projects hold gigabytes of lossless chunk intermediates; without
    # a reaper the feature becomes a disk leak. Anything still running is spared
    # regardless of age.
    try:
        reaped = restore.reap_restore_projects()
        if reaped:
            print(f"[restore] reaped {reaped} project(s) older than {restore.RESTORE_PROJECT_TTL_DAYS} days", flush=True)
        # Sources that were streamed up and then never started. Also swept on
        # every upload, so a machine that stays up for a month does not keep a
        # month of abandoned picks.
        dropped = restore.reap_restore_uploads()
        if dropped:
            print(f"[restore] dropped {dropped} unclaimed upload(s)", flush=True)
    except Exception as exc:
        print(f"[restore] project reap skipped: {exc}", file=sys.stderr)
    with history.download_jobs_lock:
        history.download_jobs.update(history.load_download_jobs())
        # Jobs that were mid-flight during a backend restart cannot be resumed safely.
        # Mark them retryable instead of leaving the UI stuck forever.
        changed = False
        for rec in history.download_jobs.values():
            if rec.get('status') in {'queued', 'running'}:
                rec['status'] = 'error'
                rec['error'] = 'Backend restarted before this download finished. Retry the download.'
                rec['finished_at'] = rec.get('finished_at') or util.now_iso()
                changed = True
        if changed:
            history.save_download_jobs_unlocked()
    print(f"Media Studio endpoint listening on http://{config.HOST}:{config.PORT}", flush=True)
    server = ThreadingHTTPServer((config.HOST, config.PORT), http.Handler)
    install_shutdown_handlers(server)
    try:
        server.serve_forever()
    finally:
        shutdown_gateway()
        server.server_close()
