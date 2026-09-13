"""Make this machine's ComfyUI sampler counters readable over HTTP.

ComfyUI knows exactly how far a generation has got — it counts sampler steps —
but it publishes that ONLY over the websocket, and only to the client id that
submitted the prompt (comfy_execution/progress.py, WebUIProgressHandler sends
with `sid=server.client_id`). The studio's local runs are submitted by
~/comfy/ComfyUI/run_z_image_turbo.py, which never opens that socket, so those
counters were dropped on the floor and the studio's bar had nothing but a time
estimate to go on. A short estimate then ran the bar to its cap while the
render was barely half done — which is the bug this exists to end.

/history is no help either: a prompt's entry appears once, at the very end.

So record the counters here and serve them. This is the SAME mechanism the
rented lanes already use (packages/gpu-rentals/provisioning/hivemind_privacy.py,
polled by gateway/promptroutes.py `_record_lane_progress`) — local and remote
now answer the same question at the same path, and the gateway has one way to
ask it rather than two.

Patch the registry METHOD rather than registering a ProgressHandler:
reset_progress_state() builds a NEW ProgressRegistry per prompt and only calls
reset_handlers() on the old one, so a handler registered at startup goes deaf
after the first job. The method survives every rebuild.

Counters and node ids only. Nothing here can see, keep or serve a prompt.
"""

from __future__ import annotations

import time
from collections import OrderedDict

# A handful of recent prompts, so a poller that asks about ITS prompt is never
# answered with a neighbour's counters — and a finished prompt can still be
# read for the moment between its last step and its history entry.
_MAX_TRACKED_PROMPTS = 8
_PROGRESS: "OrderedDict[str, dict]" = OrderedDict()
_LATEST = {"prompt_id": "", "node_id": "", "value": 0.0, "max": 0.0, "updated_at": 0.0}


def _record_progress(prompt_id, node_id, value, max_value):
    try:
        entry = {
            "prompt_id": str(prompt_id or ""),
            "node_id": str(node_id or ""),
            "value": float(value),
            "max": float(max_value),
            "updated_at": time.time(),
        }
    except (TypeError, ValueError):
        return
    _LATEST.update(entry)
    key = entry["prompt_id"]
    if not key:
        return
    _PROGRESS[key] = entry
    _PROGRESS.move_to_end(key)
    while len(_PROGRESS) > _MAX_TRACKED_PROMPTS:
        _PROGRESS.popitem(last=False)


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


try:
    from aiohttp import web
    from server import PromptServer
except Exception:  # pragma: no cover - import-order safety only
    PromptServer = None

if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:

    @PromptServer.instance.routes.get("/hivemind/progress")
    async def hivemind_progress(request):
        """Latest sampler counters, for the gateway's progress mirror.

        `?prompt_id=` answers about ONE prompt and 404s when this server has
        no counters for it, so a caller never mistakes a neighbouring
        generation's progress for its own. Without it, the latest — the shape
        the rented lanes have always returned."""
        wanted = str(request.query.get("prompt_id") or "").strip()
        if not wanted:
            return web.json_response(dict(_LATEST))
        entry = _PROGRESS.get(wanted)
        if entry is None:
            return web.json_response({"prompt_id": wanted, "pending": True}, status=404)
        return web.json_response(dict(entry))


# No nodes: this pack is a readout, not a graph component.
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
