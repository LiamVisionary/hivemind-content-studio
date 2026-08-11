"""Hivemind rental privacy node: history/queue prompt redaction, post-harvest
file scrub route, sampler progress readout, and per-instance lane-token auth.
See the provisioning script header in
packages/gpu-rentals/provisioning/comfyui-hivemind.sh."""

import hmac
import os
import time

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def _privacy_enabled():
    return os.environ.get("COMFY_PRIVATE_HISTORY_PROMPTS", "1").lower() in {"1", "true", "yes", "on"}


# --- sampler progress -------------------------------------------------------
# ComfyUI publishes per-node progress over the WEBSOCKET only, and its /history
# entry appears just once, at the end — so a lane polled over HTTP has no way to
# know a job is 6 steps into 15, and the studio's bar can only be a guess.
# Recording it here gives the gateway a pollable view of the real thing.
#
# Patch the registry METHOD rather than registering a ProgressHandler:
# reset_progress_state() builds a NEW ProgressRegistry per prompt and only calls
# reset_handlers() on the old one, so a handler registered at startup goes deaf
# after the first job. The method survives every rebuild.
#
# Counters and node ids only — the same payload shape the redaction above
# allows, so enabling progress cannot walk back the prompt privacy.
_PROGRESS = {"prompt_id": "", "node_id": "", "value": 0.0, "max": 0.0, "updated_at": 0.0}


def _record_progress(prompt_id, node_id, value, max_value):
    try:
        _PROGRESS.update(
            prompt_id=str(prompt_id or ""),
            node_id=str(node_id or ""),
            value=float(value),
            max=float(max_value),
            updated_at=time.time(),
        )
    except (TypeError, ValueError):
        pass


try:
    from comfy_execution import progress as _comfy_progress
except Exception:  # pragma: no cover - older ComfyUI without the registry
    _comfy_progress = None

if _comfy_progress is not None:
    _orig_update_progress = _comfy_progress.ProgressRegistry.update_progress

    def _recording_update_progress(self, node_id, value, max_value, *args, **kwargs):
        _record_progress(getattr(self, "prompt_id", ""), node_id, value, max_value)
        return _orig_update_progress(self, node_id, value, max_value, *args, **kwargs)

    _comfy_progress.ProgressRegistry.update_progress = _recording_update_progress


def _is_encrypted_workflow_envelope(value):
    return (
        isinstance(value, dict)
        and value.get("encrypted") is True
        and value.get("format") == "comfyui-mobile-encrypted-workflow"
        and isinstance(value.get("iterations"), int)
        and isinstance(value.get("salt"), str)
        and isinstance(value.get("iv"), str)
        and isinstance(value.get("data"), str)
    )


def _redact_extra_data(extra_data):
    if not isinstance(extra_data, dict):
        return {}
    redacted = {}
    for key in ("client_id", "create_time", "preview_method", "mobile_hidden_workflow", "comfy_usage_source"):
        value = extra_data.get(key)
        if isinstance(value, (str, int, float, bool)) or value is None:
            redacted[key] = value
    extra_pnginfo = extra_data.get("extra_pnginfo")
    if isinstance(extra_pnginfo, dict):
        workflow = extra_pnginfo.get("workflow")
        if _is_encrypted_workflow_envelope(workflow):
            redacted["extra_pnginfo"] = {"workflow": workflow}
    return redacted


def _redact_prompt_tuple(item):
    if not isinstance(item, (list, tuple)):
        return item
    redacted = list(item[:5])
    if len(redacted) > 2:
        redacted[2] = {}
    if len(redacted) > 3:
        redacted[3] = _redact_extra_data(redacted[3])
    return redacted


def _redact_history_entry(entry):
    if not isinstance(entry, dict):
        return entry
    entry = dict(entry)
    if "prompt" in entry:
        entry["prompt"] = _redact_prompt_tuple(entry["prompt"])
    return entry


import execution  # noqa: E402

_orig_get_history = execution.PromptQueue.get_history


def _private_get_history(self, *args, **kwargs):
    out = _orig_get_history(self, *args, **kwargs)
    if not _privacy_enabled() or not isinstance(out, dict):
        return out
    return {key: _redact_history_entry(value) for key, value in out.items()}


execution.PromptQueue.get_history = _private_get_history

def _wrap_queue_accessor(name):
    """Redact one PromptQueue queue accessor, if this ComfyUI has it.

    ComfyUI serves /queue from get_current_queue_volatile() and the websocket
    status from get_current_queue(); patching only the latter left the running
    prompt readable at /queue for the whole generation (measured on pinned
    e377e263, 2026-08-07). Wrapping every accessor the class exposes keeps a
    future rename from silently reopening that hole — the assertion below turns
    one into a hard startup failure rather than a quiet leak."""
    original = getattr(execution.PromptQueue, name, None)
    if original is None:
        return False

    def _private_accessor(self, *args, **kwargs):
        out = original(self, *args, **kwargs)
        if not _privacy_enabled() or not isinstance(out, tuple) or len(out) != 2:
            return out
        running, pending = out
        return (
            [_redact_prompt_tuple(item) for item in (running or [])],
            [_redact_prompt_tuple(item) for item in (pending or [])],
        )

    setattr(execution.PromptQueue, name, _private_accessor)
    return True


_QUEUE_ACCESSORS = [
    name for name in dir(execution.PromptQueue)
    if name.startswith("get_current_queue")
]
_WRAPPED_QUEUE_ACCESSORS = [name for name in _QUEUE_ACCESSORS if _wrap_queue_accessor(name)]
if not _WRAPPED_QUEUE_ACCESSORS:
    raise RuntimeError(
        "hivemind_privacy: no PromptQueue queue accessor to redact — refusing to "
        "run a rental lane that would serve prompts at /queue"
    )

try:
    from aiohttp import web
    from server import PromptServer
    import folder_paths
except Exception:  # pragma: no cover - import-order safety only
    PromptServer = None

if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    routes = PromptServer.instance.routes

    @routes.post("/hivemind/scrub-files")
    async def hivemind_scrub_files(request):
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)
        deleted, missing, refused = [], [], []
        for ref in list(payload.get("files") or [])[:256]:
            if not isinstance(ref, dict):
                continue
            base = folder_paths.get_directory_by_type(str(ref.get("type") or "output"))
            name = os.path.basename(str(ref.get("filename") or ""))
            subfolder = str(ref.get("subfolder") or "")
            if not base or not name:
                refused.append(ref)
                continue
            base = os.path.abspath(base)
            target = os.path.abspath(os.path.join(base, subfolder, name))
            try:
                inside = os.path.commonpath([base, target]) == base
            except ValueError:
                inside = False
            if not inside:
                refused.append(ref)
                continue
            if os.path.isfile(target):
                try:
                    os.remove(target)
                    deleted.append({"type": ref.get("type"), "subfolder": subfolder, "filename": name})
                except OSError:
                    refused.append(ref)
            else:
                missing.append({"type": ref.get("type"), "subfolder": subfolder, "filename": name})
        return web.json_response({"deleted": deleted, "missing": missing, "refused": refused})

    @routes.get("/hivemind/progress")
    async def hivemind_progress(request):
        """Latest sampler counters, for the gateway's completion watcher."""
        return web.json_response(dict(_PROGRESS))

    _LANE_TOKEN = os.environ.get("HIVEMIND_LANE_TOKEN", "").strip()
    _EXEMPT_PATHS = {"/", "/system_stats"} | {
        p.strip() for p in os.environ.get("HIVEMIND_LANE_TOKEN_EXEMPT", "").split(",") if p.strip()
    }

    if _LANE_TOKEN:

        def _token_ok(supplied):
            return bool(supplied) and hmac.compare_digest(supplied, _LANE_TOKEN)

        @web.middleware
        async def _hivemind_lane_auth(request, handler):
            if request.method == "OPTIONS" or request.path in _EXEMPT_PATHS:
                return await handler(request)
            auth = request.headers.get("Authorization", "")
            if auth.startswith("Bearer ") and _token_ok(auth[len("Bearer "):]):
                return await handler(request)
            if _token_ok(request.query.get("token", "")):
                return await handler(request)
            return web.json_response({"error": "unauthorized"}, status=401)

        PromptServer.instance.app.middlewares.append(_hivemind_lane_auth)
