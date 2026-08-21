"""Adapter for HivemindOS's configured Media Studio image-to-video MCP."""

from __future__ import annotations

import contextlib
import json
import math
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode, urljoin, urlparse, urlunparse

from PIL import Image

from .config import load_config
from .mcp_http import PROTOCOL_VERSION, McpHttpClient
from .publishing import encode_multipart

# How long to wait for the MCP to hand back a queued video job. Sized against
# the two slow stretches inside that call - staging references on the target
# lane, then ComfyUI accepting the prompt once its executor frees up - and kept
# under the 190s Hivemind Link proxy leg so a phone gets the answer too.
_VIDEO_START_TIMEOUT_SECONDS = 180.0
from .qa import qa_video


_VIDEO_ASPECT_DIMENSIONS = {
    "16:9": (768, 448),
    "9:16": (448, 768),
    "4:3": (640, 480),
    "3:4": (480, 640),
    "1:1": (576, 576),
}

# The high tier (~2.5x the pixels) trades render time for detail. It also
# sharpens IC-LoRA identity transfer: reference sheets are re-encoded at
# output resolution, so reference faces gain latent tokens 1:1 with output.
# All buckets stay divisible by 32 (LTX VAE alignment) and within the
# workflows' 5% aspect-ratio tolerance.
_VIDEO_ASPECT_DIMENSIONS_HIGH = {
    "16:9": (1216, 704),
    "9:16": (704, 1216),
    "4:3": (1024, 768),
    "3:4": (768, 1024),
    "1:1": (896, 896),
}

# The max tier targets ~1.0MP — MiniMax H3's trained canvas (768px short edge at
# 16:9). Capped here on purpose: community testing puts H3's quality knee at
# 0.8-1.0MP and reports the model getting less coherent above it, so no bucket
# goes past ~1.05MP. Divisible by 32 like the other tiers.
_VIDEO_ASPECT_DIMENSIONS_MAX = {
    "16:9": (1344, 768),
    "9:16": (768, 1344),
    "4:3": (1152, 864),
    "3:4": (864, 1152),
    "1:1": (1024, 1024),
}

# Pixel budgets + long-side caps per tier for start-frame-matched dimensions.
_VIDEO_TIER_AREAS = {
    "standard": (768 * 448, 1024),
    "high": (1216 * 704, 1216),
    "max": (1344 * 768, 1344),
}


@dataclass(frozen=True)
class MediaStudioDescriptor:
    app_id: str
    app_name: str
    mcp_url: str
    upload_base: str
    auth_env_key: str | None
    tool: str
    job_tool: str
    workflow_id: str | None


def discover_media_studio() -> MediaStudioDescriptor | None:
    direct_url = os.environ.get("MEDIA_STUDIO_MCP_URL", "").strip()
    direct_upload = os.environ.get("MEDIA_STUDIO_UPLOAD_BASE", "").strip() or _local_upload_base()
    if direct_url:
        return MediaStudioDescriptor(
            app_id="env:media-studio",
            app_name="Media Studio",
            mcp_url=_http_url(direct_url, "MEDIA_STUDIO_MCP_URL"),
            upload_base=_http_url(direct_upload, "MEDIA_STUDIO_UPLOAD_BASE").rstrip("/"),
            auth_env_key=os.environ.get("MEDIA_STUDIO_AUTH_ENV_KEY", "MEDIA_STUDIO_TOKEN").strip() or None,
            tool=os.environ.get("MEDIA_STUDIO_VIDEO_TOOL", "media_generate_video").strip(),
            job_tool=os.environ.get("MEDIA_STUDIO_JOB_TOOL", "media_get_job").strip(),
            workflow_id=os.environ.get("MEDIA_STUDIO_WORKFLOW_ID", "").strip() or None,
        )

    preferences = Path(os.environ.get("HIVEMINDOS_APP_PREFERENCES", Path.home() / ".hivemindos" / "app-preferences.json")).expanduser()
    try:
        data = json.loads(preferences.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _local_managed_descriptor()
    for preference in data.get("preferences", []):
        if not isinstance(preference, dict):
            continue
        mcp = preference.get("mcpVideo")
        if not isinstance(mcp, dict) or not mcp.get("url") or not mcp.get("uploadBase"):
            continue
        name = str(preference.get("appName") or "")
        capabilities = {str(value).lower() for value in preference.get("capabilities", [])}
        if "media studio" not in name.lower() and not ({"video", "image-to-video"} & capabilities):
            continue
        return MediaStudioDescriptor(
            app_id=str(preference.get("appId") or "media-studio"),
            app_name=name or "Media Studio",
            mcp_url=_http_url(str(mcp["url"]), "mcpVideo.url"),
            upload_base=_http_url(str(mcp["uploadBase"]), "mcpVideo.uploadBase").rstrip("/"),
            auth_env_key=str(mcp.get("authEnvKey") or "").strip() or None,
            tool=str(mcp.get("tool") or "media_generate_video").strip(),
            job_tool=str(mcp.get("jobTool") or "media_get_job").strip(),
            workflow_id=str(mcp.get("workflowId") or "").strip() or None,
        )
    return _local_managed_descriptor()


def media_studio_status() -> dict[str, Any]:
    descriptor = discover_media_studio()
    if not descriptor:
        return {"configured": False, "auth_present": False, "reachable": False, "detail": "No Media Studio mcpVideo preference or environment override was found."}
    token = _token(descriptor)
    reachable = _reachable(descriptor.mcp_url, token)
    return {
        "configured": True,
        "auth_present": not descriptor.auth_env_key or bool(token),
        "reachable": reachable,
        "app_name": descriptor.app_name,
        "tool": descriptor.tool,
        "job_tool": descriptor.job_tool,
        "workflow_configured": bool(descriptor.workflow_id),
        "detail": "Media Studio MCP is reachable." if reachable else "Media Studio is configured but its MCP endpoint did not answer.",
    }


def list_media_studio_tools() -> list[dict[str, Any]]:
    descriptor = _required_descriptor()
    return _client(descriptor).list_tools()


def list_media_studio_workflows(media_type: str = "video") -> list[dict[str, Any]]:
    descriptor = _required_descriptor()
    payload = _result_json(_client(descriptor).call_tool("media_list_workflows", {"media_type": media_type}))
    workflows = payload.get("workflows", [])
    return [item for item in workflows if isinstance(item, dict)]


def start_video(
    *,
    image_path: str | Path | None = None,
    middle_image_path: str | Path | None = None,
    end_image_path: str | Path | None = None,
    video_path: str | Path | None = None,
    motion_context_path: str | Path | None = None,
    video_mode: str = "extend",
    task: str = "generate",
    prompt: str,
    reference_description: str = "",
    ingredient_images: list[dict[str, Any]] | None = None,
    # MiniMax H3 Reference mode: discrete pictures carried into the clip, in
    # order — reference N is the prompt's <Picture N>. Distinct from
    # ingredient_images, which LTX stitches into one conditioning sheet.
    reference_images: list[str | Path] | None = None,
    # Voice/timbre clips (<Audio N>) and motion references (<Video N>) for the
    # same Reference mode. Each reference video is {"video_path", "use_audio",
    # "canvas"}; use_audio also conditions on that clip's own soundtrack, which
    # then takes an <Audio N> label of its own ahead of its <Video N>, and
    # canvas "compact" stages the clip inside a 384x1152 box (a third of the
    # sequence rows, the same motion — motion references only; "full", the
    # default, keeps the node's own canvas).
    reference_audios: list[str | Path] | None = None,
    reference_videos: list[dict[str, Any]] | None = None,
    duration_seconds: float = 4,
    aspect_ratio: str = "",
    resolution: str = "",
    workflow_id: str | None = None,
    studio_lane: str = "",
    seed: int | None = None,
    denoise: str = "",
    negative_prompt: str = "",
    nag_scale: float | None = None,
    head_swap_lora_strength: float | None = None,
    head_swap_backend: str | None = None,
    head_swap_face_enhancer: bool = False,
    spectrum: bool | None = None,
    fast_high_res: bool | None = None,
    steps: int | None = None,
    loras: list[dict[str, Any]] | None = None,
    requester_pub: str = "",
) -> dict[str, Any]:
    """Validate + upload the inputs and enqueue the generation, returning as
    soon as the gateway hands back a job id. High-resolution runs can take tens
    of minutes, so callers poll check_video / call finish_video instead of
    holding one blocking request open. The uploaded input names are returned so
    finish_video can delete them from the gateway once the job completes.

    `requester_pub` is the E2E public key the finished media is sealed to. It
    belongs to whoever ASKED for the generation — the browser that clicked
    generate, not this process — and every later call about this job must
    present the same key to be allowed to read it."""
    descriptor = _required_descriptor()
    # "workflow-default" is a catalog placeholder meaning "use the MCP's default/
    # selected workflow" (media_catalog.BUILT_IN_MEDIA_STUDIO_VIDEO_MODELS), not a
    # real workflow id. Forwarding it verbatim makes the MCP reject the job with
    # "unknown video workflow_id: workflow-default", which the machine-private
    # redaction then hides as a generic MediaStudioError. Drop it so the MCP falls
    # back to its configured default (e.g. ltx23-eros-fast, which takes a reference).
    if str(workflow_id or "").strip().lower() == "workflow-default":
        workflow_id = None
    video = Path(video_path).expanduser().resolve() if video_path else None
    motion_context = Path(motion_context_path).expanduser().resolve() if motion_context_path else None
    image = Path(image_path).expanduser().resolve() if image_path else None
    # First/middle/end keyframes only apply to image-driven generation, never to
    # video extension (which continues an existing clip rather than anchoring one).
    middle = Path(middle_image_path).expanduser().resolve() if (middle_image_path and video is None) else None
    end = Path(end_image_path).expanduser().resolve() if (end_image_path and video is None) else None
    ingredients = [
        {
            "image_path": Path(str(item.get("image_path") or "")).expanduser().resolve(),
            "description": str(item.get("description") or "").strip()[:1000],
        }
        for item in (ingredient_images or [])
    ]
    if len(ingredients) > 12:
        raise ValueError("At most 12 ingredient reference images are supported")
    references = [Path(str(item)).expanduser().resolve() for item in (reference_images or [])]
    if len(references) > 9:
        raise ValueError("At most 9 reference images are supported")
    for reference in references:
        if not reference.is_file():
            raise FileNotFoundError(f"Reference image not found: {reference}")
    audio_references = [Path(str(item)).expanduser().resolve() for item in (reference_audios or [])]
    if len(audio_references) > 3:
        raise ValueError("At most 3 reference audio clips are supported")
    for reference in audio_references:
        if not reference.is_file():
            raise FileNotFoundError(f"Reference audio not found: {reference}")
    video_references = [
        {
            "video_path": Path(str(item.get("video_path") or "")).expanduser().resolve(),
            "use_audio": bool(item.get("use_audio")),
            "canvas": "compact" if str(item.get("canvas") or "").strip().lower() == "compact" else "full",
        }
        for item in (reference_videos or [])
    ]
    if len(video_references) > 3:
        raise ValueError("At most 3 reference videos are supported")
    for reference in video_references:
        if not reference["video_path"].is_file():
            raise FileNotFoundError(f"Reference video not found: {reference['video_path']}")
    if video is not None and not video.is_file():
        raise FileNotFoundError(f"Input video not found: {video}")
    if motion_context is not None and not motion_context.is_file():
        raise FileNotFoundError(f"Motion-context clip not found: {motion_context}")
    if motion_context is not None and video is not None:
        raise ValueError("A motion-context clip seeds a new shot and cannot be combined with a source video")
    if image is not None and not image.is_file():
        raise FileNotFoundError(f"Input image not found: {image}")
    if middle is not None and not middle.is_file():
        raise FileNotFoundError(f"Middle keyframe image not found: {middle}")
    if end is not None and not end.is_file():
        raise FileNotFoundError(f"End keyframe image not found: {end}")
    missing_ingredient = next((item["image_path"] for item in ingredients if not item["image_path"].is_file()), None)
    if missing_ingredient is not None:
        raise FileNotFoundError(f"Ingredient reference not found: {missing_ingredient}")
    if video is None and image is None and not ingredients and not prompt.strip():
        raise FileNotFoundError("An input image, source video, ingredient reference, or prompt is required")
    head_swap = task == "head-swap"
    if video is not None and not head_swap and video_mode != "extend":
        raise ValueError("video_mode must be extend")
    if head_swap and (video is None or image is None):
        raise FileNotFoundError("Head swap needs both a source video and a face image")
    uploaded_names: list[str] = []
    try:
        # Upload each medium under its own name. These used to share one variable,
        # so a request carrying BOTH (head swap) uploaded only the video and then
        # passed the video's filename as image_path.
        uploaded_video_name = _upload_video(descriptor, video) if video is not None else ""
        if uploaded_video_name:
            uploaded_names.append(uploaded_video_name)
        uploaded_motion_context_name = _upload_video(descriptor, motion_context) if motion_context is not None else ""
        if uploaded_motion_context_name:
            uploaded_names.append(uploaded_motion_context_name)
        uploaded_image_name = _upload_image(descriptor, image) if image is not None else ""
        if uploaded_image_name:
            uploaded_names.append(uploaded_image_name)
        middle_name = _upload_image(descriptor, middle) if middle is not None else ""
        if middle_name:
            uploaded_names.append(middle_name)
        end_name = _upload_image(descriptor, end) if end is not None else ""
        if end_name:
            uploaded_names.append(end_name)
        reference_names = [_upload_image(descriptor, reference) for reference in references]
        uploaded_names.extend(name for name in reference_names if name)
        reference_audio_names = [_upload_audio(descriptor, reference) for reference in audio_references]
        uploaded_names.extend(name for name in reference_audio_names if name)
        reference_video_entries = [
            {
                "video_path": _upload_video(descriptor, reference["video_path"]),
                "use_audio": reference["use_audio"],
                "canvas": reference["canvas"],
            }
            for reference in video_references
        ]
        uploaded_names.extend(item["video_path"] for item in reference_video_entries if item["video_path"])
        uploaded_ingredients = []
        for item in ingredients:
            name = _upload_image(descriptor, item["image_path"])
            uploaded_names.append(name)
            uploaded_ingredients.append({"image_path": name, "description": item["description"]})
        duration = max(1 / 24, min(30.0, float(duration_seconds)))
        frame_rate = 24
        frames = max(9, min(721, round(duration * frame_rate) + 1))
        client = _client(descriptor, requester_pub)
        arguments: dict[str, Any] = {
            **({"workflow_id": workflow_id or descriptor.workflow_id} if workflow_id or descriptor.workflow_id else {}),
            **({"studio_lane": studio_lane.strip()[:512]} if studio_lane.strip() else {}),
            **({"video_path": uploaded_video_name} if video is not None else {}),
            **({"motion_context_path": uploaded_motion_context_name} if motion_context is not None else {}),
            **({"video_mode": video_mode} if video is not None and not head_swap else {}),
            **({"task": task} if task != "generate" else {}),
            **({"head_swap": True} if head_swap else {}),
            **({"ingredient_images": uploaded_ingredients} if uploaded_ingredients else {}),
            **({"image_path": uploaded_image_name} if image is not None else {}),
            **({"middle_image_path": middle_name} if middle_name else {}),
            **({"end_image_path": end_name} if end_name else {}),
            **({"reference_images": [{"image_path": name} for name in reference_names]}
               if reference_names else {}),
            **({"reference_audios": [{"audio_path": name} for name in reference_audio_names]}
               if reference_audio_names else {}),
            **({"reference_videos": reference_video_entries} if reference_video_entries else {}),
            # Forward a concrete seed so each run differs; a missing/-1 seed makes the
            # runner fall back to its FIXED default (42), which is why "every video
            # looked the same". Callers send a fresh random seed for random mode.
            **({"seed": int(seed)} if isinstance(seed, int) and seed >= 0 else {}),
            # Optional post-generation grain cleanup on the native MLX LTX path.
            **({"denoise": denoise} if denoise in {"light", "strong"} else {}),
        **({"negative_prompt": negative_prompt.strip()} if negative_prompt.strip() else {}),
        **({"nag_scale": float(nag_scale)} if nag_scale is not None else {}),
        # The BFS adapter itself is supplied by the head-swap task server-side;
        # this is the only part of it a caller sets.
        **({"head_swap_lora_strength": float(head_swap_lora_strength)}
           if head_swap and head_swap_lora_strength is not None else {}),
        **({"head_swap_backend": str(head_swap_backend)} if head_swap and head_swap_backend else {}),
        **({"head_swap_face_enhancer": True} if head_swap and head_swap_face_enhancer else {}),
        # Tri-state on purpose: None leaves the workflow's own default alone,
        # so only an explicit user choice overrides the registered graph.
        **({"spectrum": bool(spectrum)} if spectrum is not None else {}),
        # Fast high-res (MiniMax H3 two-pass latent upscale). Tri-state for the
        # same reason as spectrum: None leaves the registered graph alone.
        **({"fast_high_res": bool(fast_high_res)} if fast_high_res is not None else {}),
        # Sampling steps override, forwarded through the MCP's registry-slot
        # params record. None keeps the workflow's registered default.
        **({"params": {"steps": int(steps)}} if isinstance(steps, int) and steps > 0 else {}),
            "frames": frames,
            "frame_rate": frame_rate,
            "duration_seconds": duration,
            "wait": False,
            "include_urls": True,
        }
        dimensions = (
            video_dimensions_for_request(image=image, aspect_ratio=aspect_ratio, resolution=resolution)
            if video is None
            else None
        )
        if dimensions:
            width, height = dimensions
            arguments.update({"width": width, "height": height})
        if prompt.strip():
            arguments["prompt"] = prompt.strip()
        if reference_description.strip():
            arguments["reference_description"] = reference_description.strip()
        if loras:
            arguments["loras"] = [
                {"id": str(item.get("id") or "").strip(), "strength": float(item.get("strength", 1.0))}
                for item in loras
                if str(item.get("id") or "").strip()
            ]
        queued = _result_json(
            client.call_tool(
                descriptor.tool,
                arguments,
                # Queueing is not instant and giving up does not cancel it: the
                # references are staged on the target lane inside this call, and
                # ComfyUI only answers once its executor is free, so a submit
                # behind a running render routinely passed the old 30s default.
                # The studio then reported "timed out" for a job that went on to
                # render with nobody holding its id. The MCP recovers the id
                # itself now; this waits long enough to be told about it, while
                # staying inside the 190s Hivemind Link proxy leg.
                timeout=_VIDEO_START_TIMEOUT_SECONDS,
            )
        )
        job_id = _job_id(queued)
        if not job_id:
            # Surface the backend's real reason instead of an opaque failure — the
            # tool answered but with no job id, which almost always carries an
            # error/status field explaining why (bad workflow, model not ready…).
            reason = ""
            if isinstance(queued, dict):
                job = queued.get("job") if isinstance(queued.get("job"), dict) else {}
                reason = str(
                    queued.get("error")
                    or queued.get("detail")
                    or queued.get("message")
                    or job.get("error")
                    or _generation_status(queued)
                    or ""
                ).strip()[:400]
            raise RuntimeError(
                f"Media Studio did not return a job id{f': {reason}' if reason else ' (backend returned no id and no error detail)'}"
            )
        return {"job_id": job_id, "uploaded_names": list(uploaded_names), "provider": descriptor.app_name}
    except BaseException:
        for uploaded_name in uploaded_names:
            with contextlib.suppress(Exception):
                _delete_uploaded_image(descriptor, uploaded_name)
        raise


def _looks_like_e2e_envelope(path: Path) -> bool:
    """True when a downloaded 'video' is actually the gateway's client-only E2E
    envelope (JSON sealed to the owner vault): this process holds no key for it."""
    try:
        with path.open("rb") as handle:
            if handle.read(1) != b"{":
                return False
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    return bool(payload.get("wrapped_dek")) and bool(payload.get("ciphertext"))


def _job_step_counts(payload: Any) -> tuple[int | None, int | None]:
    candidates = (payload, payload.get("job"), payload.get("result")) if isinstance(payload, dict) else ()
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        step, total = candidate.get("progress_step"), candidate.get("progress_total")
        if isinstance(step, int) and isinstance(total, int) and total > 0:
            return max(0, min(step, total)), total
    return None, None


def _job_progress(payload: Any) -> float | None:
    candidates = (payload, payload.get("job"), payload.get("result")) if isinstance(payload, dict) else ()
    for candidate in candidates:
        if isinstance(candidate, dict) and isinstance(candidate.get("progress"), (int, float)):
            return max(0.0, min(1.0, float(candidate["progress"])))
    return None


_TERMINAL_STATUS_RE = re.compile(r"\b(success|succeeded|complete|completed|error|failed|cancelled|canceled|running|queued)\b")


def check_video(job_id: str, *, requester_pub: str = "") -> dict[str, Any]:
    """One non-blocking status poll for a started job.

    The key must be the SAME one the job was started with: the gateway scopes
    reads on a keyed job to its requester, so polling as anyone else answers as
    though the job did not exist."""
    descriptor = _required_descriptor()
    client = _client(descriptor, requester_pub)
    payload = _result_json(client.call_tool(descriptor.job_tool, {"id": job_id, "include_urls": True}))

    cached: dict[str, Any] = {}

    def private_job() -> dict[str, Any]:
        """The gateway's own record, over the trusted channel. MCP receipts are
        machine-redacted (no progress, no error, no URLs), and for a prompt on a
        remote lane the MCP has nothing at all until the job ends — it answers
        404 for the entire generation. This is what the studio actually runs on."""
        if not cached:
            with contextlib.suppress(Exception):
                cached.update(_private_json(descriptor, f"/api/job/{quote(job_id, safe='')}", requester_pub) or {})
        return cached

    status = _generation_status(payload)
    if not _TERMINAL_STATUS_RE.search(status):
        # e.g. the MCP's '404' for an in-flight remote prompt.
        status = _generation_status(private_job()) or status
    failed = bool(re.search(r"\b(error|failed|cancelled|canceled)\b", status))
    error = ""
    if failed:
        error = _generation_error(payload) or _generation_error(private_job())
        if not error:
            with contextlib.suppress(Exception):
                error = _comfy_history_error(
                    _private_json(descriptor, f"/comfy/api/history/{quote(job_id, safe='')}")
                )
    video_url = _first_video_url(payload)
    if not video_url and re.search(r"\b(success|succeeded|complete|completed)\b", status):
        with contextlib.suppress(Exception):
            video_url = _private_video_url(descriptor, job_id)
    progress = _job_progress(payload)
    if progress is None:
        progress = _job_progress(private_job())
    state = {
        "status": status or "running",
        "failed": failed,
        "error": error,
        "video_url": video_url,
        "progress": progress,
    }
    # Step counters when the backend has them: a bar that says "step 6 of 15"
    # is legible in a way a percentage alone is not, especially across the
    # long tail after the last step where the bar stops moving.
    step, total = _job_step_counts(private_job())
    if step is not None and total:
        state["progress_step"], state["progress_total"] = step, total
    return state


def finish_video(
    job_id: str,
    *,
    uploaded_names: list[str] | None = None,
    output_dir: str | Path | None = None,
    poll_interval_seconds: float = 6,
    max_polls: int = 450,
    requester_pub: str = "",
) -> dict[str, Any]:
    """Wait for a started job to complete, then download + QA the result and
    delete the uploaded inputs from the gateway."""
    descriptor = _required_descriptor()
    try:
        video_url = ""
        for index in range(max_polls):
            state = check_video(job_id, requester_pub=requester_pub)
            if state["failed"]:
                raise RuntimeError(state["error"] or "Media Studio reported a failed generation")
            if state["video_url"]:
                video_url = state["video_url"]
                break
            if index < max_polls - 1:
                time.sleep(max(0.1, poll_interval_seconds))
        if not video_url:
            raise TimeoutError("Media Studio did not return a finished video before the poll limit")

        reachable_url = _rewrite_local_url(video_url, descriptor.upload_base)
        destination_root = Path(output_dir).expanduser().resolve() if output_dir else load_config().data_dir / "generated" / "media-studio"
        destination_root.mkdir(parents=True, exist_ok=True)
        destination = destination_root / f"media-studio-{job_id}-{int(time.time())}.mp4"
        local_token = _token(descriptor) if _same_origin(reachable_url, descriptor.upload_base) else ""
        _download(reachable_url, destination, token=local_token)
        if _looks_like_e2e_envelope(destination):
            # The gateway sealed the output to the owner vault and served the
            # envelope. Server-side QA and a local re-encrypted copy are
            # impossible BY DESIGN — return the gateway output name so the
            # studio proxies the envelope and the browser decrypts it.
            with contextlib.suppress(OSError):
                destination.unlink()
            return {
                "job_id": job_id,
                "provider": descriptor.app_name,
                "gateway_output": Path(urlparse(video_url).path).name,
                "qa": {"ok": True, "visual_inspection_required": True},
            }
        qa = qa_video(destination, output_dir=destination_root / "qa", require_audio=False)
        qa = _remove_qa_frame(qa, destination_root)
        if not qa["ok"]:
            raise RuntimeError("Media Studio output failed technical QA: " + "; ".join(qa["failures"]))
        return {"job_id": job_id, "output": str(destination), "qa": qa, "provider": descriptor.app_name}
    finally:
        for uploaded_name in (uploaded_names or []):
            with contextlib.suppress(Exception):
                _delete_uploaded_image(descriptor, uploaded_name)


def cancel_video(job_id: str, *, requester_pub: str = "") -> dict[str, Any]:
    """Ask the backend to stop a running video job, and report how far that got.

    Two different facts come back, and conflating them is what made cancelling
    feel broken:
      interrupted — the backend ACCEPTED the request to stop.
      stopped     — the job is verifiably no longer holding the backend.

    A Comfy prompt inside a long non-interruptible stretch (loading a video
    model) stays on the GPU until it reaches a checkpoint, so `interrupted`
    can be True while `stopped` is False for minutes. The next generation
    queues behind it during that window, which the caller needs to be able to
    say out loud rather than reporting a clean cancel.
    """
    unavailable = {"interrupted": False, "stopped": False, "backend_state": None}
    descriptor = discover_media_studio()
    if descriptor is None:
        return dict(unavailable)
    token = _token(descriptor)
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    headers.update(_requester_headers(requester_pub))
    base = descriptor.upload_base.rstrip("/")
    for path in (f"/api/job/{quote(job_id, safe='')}/cancel", f"/api/cancel/{quote(job_id, safe='')}"):
        try:
            request = urllib.request.Request(f"{base}{path}", data=b"{}", method="POST", headers=headers)
            # Longer than the gateway's own verification window, so the honest
            # "did it actually stop" answer gets back instead of timing out and
            # being reported as a failed cancel.
            with urllib.request.urlopen(request, timeout=30) as response:
                if not 200 <= int(getattr(response, "status", 200)) < 300:
                    continue
                try:
                    payload = json.loads(response.read().decode("utf-8") or "{}")
                except Exception:
                    return {"interrupted": True, "stopped": True, "backend_state": None}
                if not isinstance(payload, dict):
                    return {"interrupted": True, "stopped": True, "backend_state": None}
                # Older gateways answer with a bare 200 and no `stopped` field;
                # only a reply that explicitly says nothing happened counts as
                # False, and an unstated `stopped` follows `interrupted` so an
                # old backend keeps behaving exactly as it used to.
                interrupted = bool(payload.get("interrupted", True))
                return {
                    "interrupted": interrupted,
                    "stopped": bool(payload.get("stopped", interrupted)),
                    "backend_state": payload.get("backend_state"),
                }
        except Exception:
            continue
    return dict(unavailable)


def generate_video(
    *,
    image_path: str | Path | None = None,
    middle_image_path: str | Path | None = None,
    end_image_path: str | Path | None = None,
    video_path: str | Path | None = None,
    motion_context_path: str | Path | None = None,
    video_mode: str = "extend",
    task: str = "generate",
    prompt: str,
    reference_description: str = "",
    ingredient_images: list[dict[str, Any]] | None = None,
    reference_images: list[str | Path] | None = None,
    reference_audios: list[str | Path] | None = None,
    reference_videos: list[dict[str, Any]] | None = None,
    duration_seconds: float = 4,
    aspect_ratio: str = "",
    resolution: str = "",
    workflow_id: str | None = None,
    studio_lane: str = "",
    loras: list[dict[str, Any]] | None = None,
    head_swap_lora_strength: float | None = None,
    head_swap_backend: str | None = None,
    head_swap_face_enhancer: bool = False,
    output_dir: str | Path | None = None,
    poll_interval_seconds: float = 6,
    # 45 minutes at the default interval — high-resolution LTX runs regularly
    # exceed the old 9-minute budget (a 13-minute job hit the cap live).
    max_polls: int = 450,
    spectrum: bool | None = None,
    fast_high_res: bool | None = None,
    steps: int | None = None,
    requester_pub: str = "",
) -> dict[str, Any]:
    started = start_video(
        requester_pub=requester_pub,
        task=task,
        image_path=image_path,
        middle_image_path=middle_image_path,
        end_image_path=end_image_path,
        video_path=video_path,
        motion_context_path=motion_context_path,
        video_mode=video_mode,
        prompt=prompt,
        reference_description=reference_description,
        ingredient_images=ingredient_images,
        reference_images=reference_images,
        reference_audios=reference_audios,
        reference_videos=reference_videos,
        duration_seconds=duration_seconds,
        aspect_ratio=aspect_ratio,
        resolution=resolution,
        workflow_id=workflow_id,
        studio_lane=studio_lane,
        loras=loras,
        head_swap_lora_strength=head_swap_lora_strength,
        head_swap_backend=head_swap_backend,
        head_swap_face_enhancer=head_swap_face_enhancer,
        spectrum=spectrum,
        fast_high_res=fast_high_res,
        steps=steps,
    )
    return finish_video(
        started["job_id"],
        uploaded_names=started["uploaded_names"],
        output_dir=output_dir,
        poll_interval_seconds=poll_interval_seconds,
        max_polls=max_polls,
        requester_pub=requester_pub,
    )


def generate_image(
    *,
    prompt: str,
    workflow_id: str | None = None,
    backend: str = "",
    width: int | None = None,
    height: int | None = None,
    aspect_ratio: str = "",
    resolution: str = "",
    negative_prompt: str = "",
    seed: int | None = None,
    steps: int | None = None,
    loras: list[dict[str, Any]] | None = None,
    image_path: str | Path | None = None,
    output_dir: str | Path | None = None,
    timeout_seconds: float = 180,
    poll_interval_seconds: float = 4,
    max_polls: int = 150,
    requester_pub: str = "",
) -> dict[str, Any]:
    """Render one still through the Media Studio MCP and return its local path.

    The video tools split start/check/finish because a clip can run for tens of
    minutes. A still does not need that: the MCP can wait on the job itself, so
    the common case is one call. `timeout_seconds` stays inside the 190s
    Hivemind Link proxy leg, and anything still running when the wait returns
    falls back to polling `media_get_job` the same way check_video does — a
    cold local model loading weights is slow once, not broken.
    """
    if not str(prompt or "").strip():
        raise ValueError("Image generation requires a prompt")
    descriptor = _required_descriptor()
    client = _client(descriptor, requester_pub)

    # "workflow-default" is a catalog placeholder, not a registered workflow id;
    # forwarding it makes the MCP reject the job (same trap as start_video).
    if str(workflow_id or "").strip().lower() == "workflow-default":
        workflow_id = None

    arguments: dict[str, Any] = {
        "prompt": str(prompt).strip(),
        "wait": True,
        "timeout_s": int(max(1, min(1800, timeout_seconds))),
        "include_urls": True,
    }
    if workflow_id:
        arguments["workflow_id"] = str(workflow_id).strip()
    if backend.strip():
        arguments["backend"] = backend.strip()
    dimensions = (width, height) if width and height else image_dimensions_for_request(
        aspect_ratio=aspect_ratio, resolution=resolution
    )
    if dimensions:
        arguments["width"], arguments["height"] = int(dimensions[0]), int(dimensions[1])
    if negative_prompt.strip():
        arguments["negative_prompt"] = negative_prompt.strip()[:2000]
    if isinstance(seed, int):
        arguments["seed"] = seed
    if isinstance(steps, int) and steps > 0:
        arguments["steps"] = steps
    if image_path:
        arguments["image_path"] = str(Path(image_path).expanduser().resolve())
    if loras:
        arguments["loras"] = [
            {"id": str(item.get("id") or "").strip(), "strength": float(item.get("strength", 1.0))}
            for item in loras
            if str(item.get("id") or "").strip()
        ]

    payload = _result_json(
        client.call_tool(
            os.environ.get("MEDIA_STUDIO_IMAGE_TOOL", "media_generate_image").strip(),
            arguments,
            timeout=_VIDEO_START_TIMEOUT_SECONDS,
        )
    )
    job_id = _job_id(payload)
    image_url = _first_image_url(payload)

    if not image_url and job_id:
        for index in range(max_polls):
            state = _result_json(client.call_tool(descriptor.job_tool, {"id": job_id, "include_urls": True}))
            status = _generation_status(state)
            if re.search(r"\b(error|failed|cancelled|canceled)\b", status):
                raise RuntimeError(_generation_error(state) or "Media Studio reported a failed image generation")
            image_url = _first_image_url(state)
            if not image_url and re.search(r"\b(success|succeeded|complete|completed)\b", status):
                with contextlib.suppress(Exception):
                    image_url = _private_image_url(descriptor, job_id)
            if image_url:
                break
            if index < max_polls - 1:
                time.sleep(max(0.1, poll_interval_seconds))
    if not image_url and job_id:
        with contextlib.suppress(Exception):
            image_url = _private_image_url(descriptor, job_id)
    if not image_url:
        raise TimeoutError("Media Studio did not return a finished image before the poll limit")

    reachable_url = _rewrite_local_url(image_url, descriptor.upload_base)
    destination_root = (
        Path(output_dir).expanduser().resolve()
        if output_dir
        else load_config().data_dir / "generated" / "media-studio"
    )
    destination_root.mkdir(parents=True, exist_ok=True)
    suffix = Path(urlparse(reachable_url).path).suffix.lower() or ".png"
    destination = destination_root / f"media-studio-{job_id or 'image'}-{int(time.time())}{suffix}"
    local_token = _token(descriptor) if _same_origin(reachable_url, descriptor.upload_base) else ""
    _download(reachable_url, destination, token=local_token)
    if _looks_like_e2e_envelope(destination):
        # Sealed to a vault this process holds no key for. Unlike a video result,
        # there is no useful degraded mode here: the caller wants the pixels.
        with contextlib.suppress(OSError):
            destination.unlink()
        raise RuntimeError(
            "Media Studio sealed this image to an end-to-end vault, so the server cannot read it. "
            "Generate with the requester key that owns the run, or disable sealing for this lane."
        )
    return {
        "job_id": job_id,
        "output": str(destination),
        "provider": descriptor.app_name,
        "model": str(workflow_id or backend or ""),
    }


def _remove_qa_frame(qa: dict[str, Any], destination_root: Path) -> dict[str, Any]:
    sanitized = dict(qa)
    raw = sanitized.get("representative_frame")
    if raw:
        frame = Path(str(raw)).expanduser().resolve()
        qa_root = (destination_root / "qa").resolve()
        if frame.is_relative_to(qa_root):
            with contextlib.suppress(FileNotFoundError):
                frame.unlink()
            with contextlib.suppress(OSError):
                frame.parent.rmdir()
    sanitized["representative_frame"] = None
    return sanitized


def _delete_uploaded_image(descriptor: MediaStudioDescriptor, name: str) -> None:
    body = json.dumps({"filename": Path(name).name}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    token = _token(descriptor)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"{descriptor.upload_base}/api/delete-input",
        data=body,
        method="POST",
        headers=headers,
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status >= 400:
            raise RuntimeError(f"Media Studio private input cleanup failed with HTTP {response.status}")


# base64url DER SPKI, mirroring the gateway's validator. A malformed key is
# dropped here rather than travelling on to be rejected at the far end.
_SPKI_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]{100,4000}$")


def normalized_requester_pub(value: str | None) -> str:
    text = str(value or "").strip()
    return text if _SPKI_B64URL_RE.match(text) else ""


def _requester_headers(requester_pub: str = "") -> dict[str, str]:
    """The caller's own E2E public key, forwarded verbatim.

    This is what makes a generation belong to the browser that asked for it:
    the MCP sidecar and gateway seal remote outputs to the presented key, and
    scope status reads on a keyed job to the same presenter. Omitting it means
    "seal to whoever this process is", which for a browser-initiated job is the
    wrong identity entirely.
    """
    pub = normalized_requester_pub(requester_pub)
    return {"X-E2E-Requester-Pub": pub} if pub else {}


def _client(descriptor: MediaStudioDescriptor, requester_pub: str = "") -> McpHttpClient:
    token = _token(descriptor)
    if descriptor.auth_env_key and not token:
        raise RuntimeError(f"Missing {descriptor.auth_env_key} for Media Studio")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    headers.update(_requester_headers(requester_pub))
    return McpHttpClient(descriptor.mcp_url, headers=headers)


def _required_descriptor() -> MediaStudioDescriptor:
    descriptor = discover_media_studio()
    if not descriptor:
        raise RuntimeError("Media Studio is not configured in HivemindOS app preferences or environment")
    return descriptor


def _token(descriptor: MediaStudioDescriptor) -> str:
    if not descriptor.auth_env_key:
        return ""
    direct = os.environ.get(descriptor.auth_env_key, "").strip()
    if direct:
        return direct
    if descriptor.auth_env_key in {"MEDIA_STUDIO_TOKEN", "ZIMG_TOKEN"}:
        for path in _token_paths():
            try:
                value = path.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if value:
                return value
    return ""


def _reachable(url: str, token: str) -> bool:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    if token:
        headers.update({
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": PROTOCOL_VERSION,
        })
        body = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "hivemind-content-studio", "version": "0.1.0"},
            },
        }).encode("utf-8")
        request = urllib.request.Request(url, data=body, method="POST", headers=headers)
    else:
        request = urllib.request.Request(url, method="GET", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status < 500
    except urllib.error.HTTPError as exc:
        return exc.code < 500 and exc.code not in {401, 403}
    except OSError:
        return False


def _upload_image(descriptor: MediaStudioDescriptor, image: Path) -> str:
    return _upload_input(descriptor, image, "image")


def _upload_video(descriptor: MediaStudioDescriptor, video: Path) -> str:
    return _upload_input(descriptor, video, "video")


def _upload_audio(descriptor: MediaStudioDescriptor, audio: Path) -> str:
    return _upload_input(descriptor, audio, "audio")


def _upload_input(descriptor: MediaStudioDescriptor, media: Path, label: str) -> str:
    token = _token(descriptor)
    body, content_type = encode_multipart([("overwrite", "true")], [("image", media)])
    headers = {"Content-Type": content_type}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(f"{descriptor.upload_base}/upload/image", data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Media Studio {label} upload failed with HTTP {exc.code}") from None
    name = str(payload.get("name") or "").strip()
    if not name:
        raise RuntimeError(f"Media Studio {label} upload returned no input filename")
    return name


def _video_dimensions(image: Path, tier: str = "standard") -> tuple[int, int]:
    # Derive LTX-valid output dimensions that preserve the source image's exact
    # aspect ratio (so a start frame is never cropped to a fixed tier). Targets the
    # same pixel budget as the aspect tiers so render time stays comparable.
    with Image.open(image) as opened:
        width, height = opened.size
    ratio = width / max(1, height)
    target_area, max_dim = _VIDEO_TIER_AREAS.get(tier, _VIDEO_TIER_AREAS["standard"])
    target_width = math.sqrt(target_area * ratio)
    target_height = target_width / ratio
    if max(target_width, target_height) > max_dim:
        scale = max_dim / max(target_width, target_height)
        target_width *= scale
        target_height *= scale
    # Multiples of 64, not 32: the two-stage LTX pipelines generate stage 1 at
    # half resolution, so a 32-aligned request such as 928 is silently floored
    # to 896 by the runtime after the job is recorded. Snapping to 64 keeps the
    # requested size equal to what actually renders.
    snap = lambda value: max(256, min(max_dim, round(value / 64) * 64))
    return snap(target_width), snap(target_height)


def video_dimensions_for_request(
    *,
    image: Path | None = None,
    aspect_ratio: str = "",
    resolution: str = "",
) -> tuple[int, int] | None:
    tier_name = str(resolution or "").strip().lower()
    if tier_name not in _VIDEO_TIER_AREAS:
        tier_name = "standard"
    tier = {
        "high": _VIDEO_ASPECT_DIMENSIONS_HIGH,
        "max": _VIDEO_ASPECT_DIMENSIONS_MAX,
    }.get(tier_name, _VIDEO_ASPECT_DIMENSIONS)
    selected = tier.get(str(aspect_ratio or "").strip())
    if selected:
        return selected
    # No fixed aspect requested: match the source frame's aspect ratio exactly.
    return _video_dimensions(image, tier=tier_name) if image is not None else None


_VIDEO_TIER_DIMENSIONS = {
    "standard": _VIDEO_ASPECT_DIMENSIONS,
    "high": _VIDEO_ASPECT_DIMENSIONS_HIGH,
    "max": _VIDEO_ASPECT_DIMENSIONS_MAX,
}

# Stills are cheap next to a clip, and a faceless short upscales them into a
# 1080x1920 timeline, so the default tier here is deliberately larger than the
# video default — a 448px still would visibly soften once MPT scales it.
_IMAGE_ASPECT_DIMENSIONS = {
    "16:9": (1344, 768),
    "9:16": (768, 1344),
    "4:3": (1152, 864),
    "3:4": (864, 1152),
    "1:1": (1024, 1024),
}
_IMAGE_ASPECT_DIMENSIONS_DRAFT = {
    "16:9": (896, 512),
    "9:16": (512, 896),
    "4:3": (768, 576),
    "3:4": (576, 768),
    "1:1": (704, 704),
}


def image_dimensions_for_request(
    *,
    aspect_ratio: str = "",
    resolution: str = "",
) -> tuple[int, int] | None:
    """Pixel dimensions for a still, or None to let the workflow decide."""
    tier = (
        _IMAGE_ASPECT_DIMENSIONS_DRAFT
        if str(resolution or "").strip().lower() in {"draft", "low"}
        else _IMAGE_ASPECT_DIMENSIONS
    )
    return tier.get(str(aspect_ratio or "").strip())


def _grid_frames_at_most(grid: dict[str, Any] | None, value: float) -> int | None:
    """Largest frame count the graph can sample without exceeding `value`.

    Mirrors gridFrameCountAtMost in media-studio-mcp.mjs: the graph only accepts
    counts on a `modulus * k + offset` lattice (MiniMax H3 is 17k+5), and a CAP
    has to snap DOWN — snapping up would quote a length that does not fit.
    Returns None when nothing on the lattice fits, so the caller can say the
    canvas is unusable rather than quoting a ceiling that still fails.
    """
    try:
        modulus = int(round(float((grid or {}).get("modulus"))))
    except (TypeError, ValueError):
        return None
    if modulus <= 0:
        return None
    try:
        offset = int(round(float((grid or {}).get("offset", 1)))) % modulus
    except (TypeError, ValueError):
        offset = 1 % modulus
    first = offset if offset > 0 else modulus
    if value < first:
        return None
    return first + int((int(value) - first) // modulus) * modulus


def motion_reference_duration_limits(workflow: dict[str, Any]) -> dict[str, float]:
    """Longest stretch of MOTION REFERENCE each canvas can carry.

    The node trims a reference video to min(its own length, the clip's length)
    — `frames[:frame_count]` in comfy_extras/nodes_minimax_h3.py — so the budget
    is spent on that effective length, not on the clip's. Two consequences the
    studio has to model: a reference at or beyond the clip's length makes the
    CLIP the expensive thing, and a reference shorter than the clip costs only
    its own length, leaving the full duration range open. Reference PICTURES
    cost a flat amount however long the clip is and never narrow anything.

    Published as a capability keyed "<tier>|<aspect>" so the studio can drop the
    unreachable durations from its picker. This is machine capacity — a budget,
    a canvas, a frame count — and describes no job: it is computed from the
    registry and the tier tables alone, with nothing about what anyone rendered.
    """
    budget = workflow.get("motion_reference_max_reference_pixel_frames")
    try:
        budget = float(budget)
    except (TypeError, ValueError):
        return {}
    if budget <= 0:
        return {}
    grid = workflow.get("frame_grid") if isinstance(workflow.get("frame_grid"), dict) else None
    defaults = workflow.get("defaults") if isinstance(workflow.get("defaults"), dict) else {}
    try:
        rate = float(defaults.get("frame_rate") or 24)
    except (TypeError, ValueError):
        rate = 24.0
    if rate <= 0:
        rate = 24.0
    limits: dict[str, float] = {}
    for tier_name, dimensions in _VIDEO_TIER_DIMENSIONS.items():
        for aspect, (width, height) in dimensions.items():
            frames = _grid_frames_at_most(grid, budget / (width * height))
            if frames is None:
                # No legal frame count fits: the canvas cannot take a motion
                # reference at all. Zero says that plainly; omitting the key
                # would read as "unlimited".
                limits[f"{tier_name}|{aspect}"] = 0.0
                continue
            # Rounded to whole frames at the workflow's rate, so the studio and
            # the guard quote the same lattice point.
            limits[f"{tier_name}|{aspect}"] = round(frames / rate, 3)
    return limits


def _result_json(result: dict[str, Any]) -> dict[str, Any]:
    for part in result.get("content", []):
        if part.get("type") != "text":
            continue
        try:
            parsed = json.loads(part.get("text") or "")
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    structured = result.get("structuredContent")
    return structured if isinstance(structured, dict) else result


def _job_id(payload: dict[str, Any]) -> str:
    job = payload.get("job") if isinstance(payload.get("job"), dict) else {}
    submission = payload.get("submission") if isinstance(payload.get("submission"), dict) else {}
    for value in (job.get("id"), payload.get("id"), payload.get("job_id"), payload.get("jobId"), submission.get("prompt_id"), payload.get("prompt_id")):
        if isinstance(value, (str, int)) and str(value).strip():
            return str(value).strip()
    return ""


def _generation_status(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    job = payload.get("job") if isinstance(payload.get("job"), dict) else {}
    for source in (payload, job):
        value = source.get("status") or source.get("state")
        if value:
            return str(value).lower()
    return ""


def _comfy_history_error(payload: Any) -> str:
    """The failure reason a Comfy-shaped history carries in status.messages.

    MCP receipts are machine-redacted (machineOperationReceipt keeps only an
    allow-list, and a failure reason is not on it), so a remote-lane failure
    reaches this process as a bare status with no text. Read it the same way
    output URLs are read: over the trusted server-side channel. Only the
    gateway's already-sanitised hivemind_remote_error and the node identity
    from a native execution_error are taken — never current_inputs, which
    carries the prompt."""
    record = payload if isinstance(payload, dict) else {}
    if not isinstance(record.get("status"), dict):
        record = next((value for value in record.values() if isinstance(value, dict)), {})
    for message in (record.get("status") or {}).get("messages") or []:
        if not (isinstance(message, (list, tuple)) and len(message) >= 2):
            continue
        kind, detail = message[0], message[1]
        if not isinstance(detail, dict):
            continue
        if kind == "hivemind_remote_error":
            text = str(detail.get("error") or "").strip()
            if text:
                return text[:400]
        if kind == "execution_error":
            where = " ".join(
                part for part in (
                    str(detail.get("node_type") or "").strip(),
                    f"node {detail.get('node_id')}" if detail.get("node_id") else "",
                ) if part
            )
            reason = " ".join(
                str(detail.get("exception_message") or detail.get("exception_type") or "failed").split()
            )
            translated = _out_of_memory_advice(reason)
            if translated:
                return translated
            return (f"{where} failed — {reason}" if where else reason)[:400]
    return ""


def _out_of_memory_advice(reason: str) -> str:
    """Turn a CUDA allocator dump into the thing the user can actually change.

    The raw text is a wall of allocator bookkeeping that gets truncated at 400
    characters mid-sentence, and its own advice ("you might have accidentally
    set the batch_size to a large number") is about a control this studio does
    not expose. What actually blows the budget is clip LENGTH: measured
    2026-08-13 on a 5090 in MiniMax H3 reference mode at 1216x704 with nine
    pictures, a motion clip and a voice clip, 141 frames (5.9s) peaked at
    29.63GiB of 31.36 and 158 frames (6.6s) ran out — while the studio offers
    the duration slider all the way to 15s.
    """
    if "out of memory" not in reason.lower():
        return ""
    wanted = re.search(r"Requested\s*:\s*([\d.]+\s*[KMG]iB)", reason)
    short = f" It needed another {wanted.group(1)}." if wanted else ""
    return (
        "The GPU ran out of memory part-way through this generation." + short
        + " Longer clips cost the most, and in reference mode every picture, motion clip and"
        " voice clip adds to the same budget — a motion clip is trimmed to the clip's own"
        " length, so it grows as the clip does. Try a shorter duration first, then a lower"
        " resolution, then fewer references."
    )


def _generation_error(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    job = payload.get("job") if isinstance(payload.get("job"), dict) else {}
    for source in (payload, job):
        value = source.get("error") or source.get("detail") or source.get("message")
        if value:
            return str(value)
    return ""


def _first_video_url(payload: Any) -> str:
    match = re.search(r"https?://[^\"'\s]+\.(?:mp4|m4v|mov|webm)(?:\?[^\"'\s]*)?", json.dumps(payload), re.IGNORECASE)
    return match.group(0) if match else ""


def _private_video_url(descriptor: MediaStudioDescriptor, job_id: str) -> str:
    """Resolve output only inside the trusted server process, never through MCP receipts."""
    job = _private_json(descriptor, f"/api/job/{quote(job_id, safe='')}")
    reference = _first_video_reference(job)
    if reference:
        return urljoin(descriptor.upload_base.rstrip("/") + "/", reference)

    history = _private_json(descriptor, f"/comfy/api/history/{quote(job_id, safe='')}")
    record = history.get(job_id) if isinstance(history.get(job_id), dict) else next(
        (value for value in history.values() if isinstance(value, dict)),
        {},
    )
    for item in _comfy_output_items(record):
        filename = str(item.get("filename") or "").strip()
        if not _is_video_reference(filename):
            continue
        query = urlencode({
            "filename": filename,
            "subfolder": str(item.get("subfolder") or ""),
            "type": str(item.get("type") or "output"),
        })
        return f"{descriptor.upload_base.rstrip('/')}/comfy/view?{query}"
    return ""


def _private_json(descriptor: MediaStudioDescriptor, path: str, requester_pub: str = "") -> dict[str, Any]:
    headers = {"Accept": "application/json"}
    token = _token(descriptor)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    headers.update(_requester_headers(requester_pub))
    request = urllib.request.Request(
        urljoin(descriptor.upload_base.rstrip("/") + "/", path.lstrip("/")),
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return {}
        raise RuntimeError(f"Media Studio private output lookup failed with HTTP {exc.code}") from None
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("Media Studio private output lookup failed") from exc
    return payload if isinstance(payload, dict) else {}


def _first_video_reference(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""
    for key in ("video_urls", "media_urls", "image_urls", "output_urls"):
        values = payload.get(key)
        if not isinstance(values, list):
            continue
        for value in values:
            if isinstance(value, str) and _is_video_reference(value):
                return value
    for key in ("video_url", "media_url", "output_url", "url"):
        value = payload.get(key)
        if isinstance(value, str) and _is_video_reference(value):
            return value
    return ""


def _comfy_output_items(value: object):
    if isinstance(value, dict):
        if value.get("filename"):
            yield value
        for child in value.values():
            yield from _comfy_output_items(child)
    elif isinstance(value, list):
        for child in value:
            yield from _comfy_output_items(child)


def _is_video_reference(value: str) -> bool:
    return Path(urlparse(value).path).suffix.lower() in {".mp4", ".m4v", ".mov", ".webm"}


def _is_image_reference(value: str) -> bool:
    return Path(urlparse(value).path).suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}


def _first_image_url(payload: Any) -> str:
    match = re.search(
        r"https?://[^\"'\s]+\.(?:png|jpg|jpeg|webp)(?:\?[^\"'\s]*)?",
        json.dumps(payload),
        re.IGNORECASE,
    )
    return match.group(0) if match else ""


def _private_image_url(descriptor: MediaStudioDescriptor, job_id: str) -> str:
    """Image twin of _private_video_url — resolve the output inside the trusted
    server process rather than from a machine-redacted MCP receipt."""
    job = _private_json(descriptor, f"/api/job/{quote(job_id, safe='')}")
    for key in ("image_urls", "media_urls", "output_urls"):
        values = job.get(key) if isinstance(job, dict) else None
        for value in values if isinstance(values, list) else []:
            if isinstance(value, str) and _is_image_reference(value):
                return urljoin(descriptor.upload_base.rstrip("/") + "/", value)
    for key in ("image_url", "media_url", "output_url", "url"):
        value = job.get(key) if isinstance(job, dict) else None
        if isinstance(value, str) and _is_image_reference(value):
            return urljoin(descriptor.upload_base.rstrip("/") + "/", value)

    history = _private_json(descriptor, f"/comfy/api/history/{quote(job_id, safe='')}")
    record = history.get(job_id) if isinstance(history.get(job_id), dict) else next(
        (value for value in history.values() if isinstance(value, dict)),
        {},
    )
    for item in _comfy_output_items(record):
        filename = str(item.get("filename") or "").strip()
        if not _is_image_reference(filename):
            continue
        query = urlencode({
            "filename": filename,
            "subfolder": str(item.get("subfolder") or ""),
            "type": str(item.get("type") or "output"),
        })
        return f"{descriptor.upload_base.rstrip('/')}/comfy/view?{query}"
    return ""


def _rewrite_local_url(url: str, upload_base: str) -> str:
    parsed = urlparse(url)
    if parsed.hostname not in {"127.0.0.1", "localhost", "0.0.0.0", "::1"}:
        return url
    base = urlparse(upload_base)
    return urlunparse((base.scheme, base.netloc, parsed.path, parsed.params, parsed.query, parsed.fragment))


def _same_origin(left: str, right: str) -> bool:
    first = urlparse(left)
    second = urlparse(right)
    return first.scheme == second.scheme and first.netloc == second.netloc


def _download(url: str, destination: Path, *, token: str = "") -> None:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            data = response.read()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Media Studio output download failed with HTTP {exc.code}") from None
    if not data:
        raise RuntimeError("Media Studio output download was empty")
    destination.write_bytes(data)


def _http_url(value: str, label: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{label} must be an HTTP(S) URL")
    return value.strip()


def _local_managed_descriptor() -> MediaStudioDescriptor:
    port = os.environ.get("MEDIA_STUDIO_MCP_PORT", "8796").strip() or "8796"
    return MediaStudioDescriptor(
        app_id="managed:media-studio-mcp",
        app_name="Managed Media Studio MCP",
        mcp_url=_http_url(f"http://127.0.0.1:{port}/mcp", "MEDIA_STUDIO_MCP_PORT"),
        upload_base=_http_url(_local_upload_base(), "MEDIA_STUDIO_UPLOAD_BASE").rstrip("/"),
        auth_env_key=os.environ.get("MEDIA_STUDIO_AUTH_ENV_KEY", "ZIMG_TOKEN").strip() or None,
        tool=os.environ.get("MEDIA_STUDIO_VIDEO_TOOL", "media_generate_video").strip(),
        job_tool=os.environ.get("MEDIA_STUDIO_JOB_TOOL", "media_get_job").strip(),
        workflow_id=os.environ.get("MEDIA_STUDIO_WORKFLOW_ID", "").strip() or None,
    )


def _local_upload_base() -> str:
    return (
        os.environ.get("MEDIA_STUDIO_UPLOAD_BASE")
        or os.environ.get("MEDIA_STUDIO_MCP_STUDIO_URL")
        or os.environ.get("MEDIA_STUDIO_STUDIO_URL")
        or os.environ.get("ZIMG_STUDIO_URL")
        or "http://127.0.0.1:8788"
    ).strip()


def _token_paths() -> list[Path]:
    media_state = Path(os.environ.get("HIVEMIND_MEDIA_STATE_DIR", Path.home() / ".hivemindos" / "media-studio")).expanduser()
    candidates = [
        os.environ.get("MEDIA_STUDIO_TOKEN_FILE", ""),
        os.environ.get("ZIMG_TOKEN_FILE", ""),
        str(media_state / "secure" / "zimg-token"),
    ]
    return [Path(value).expanduser() for value in candidates if value.strip()]
