"""Video generation: staging the inputs, starting a job and finishing it.

The largest single subject in the control API, and the reason the file it
came out of was 6,227 lines. Moved unchanged (2026-09-04); the three
unresponsive-backend ceilings are read off the control_api module at call
time, because that is where a test shortens them.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import mimetypes
import time
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import comfy_lanes
from ..account_scope import GatewayOutputClaims
from ..machine_privacy import machine_operation_receipt
from ..media_studio import sanitize_error_detail
from ..observability import frame_list
from ..private_access import e2e_media_exists, seal_private_media_e2e
from .media_common import (
    _encrypt_private_media,
    _private_media_exists,
    _public_media_studio_qa,
    _public_media_studio_result,
    _remove_media_studio_qa_artifacts,
    _requester_pub,
)
from .models import _MAX_DESCRIPTION_CHARS, _StagedVideoInputs, MediaStudioVideoBody
from .timings import (
    _DEFAULT_VIDEO_SECONDS_PER_WORK_UNIT,
    _VIDEO_BACKEND_GONE,
    _video_timing_signature,
)

log = logging.getLogger("hivemind.studio.control")


def register(app, ctx) -> None:
    """Register the media-studio video routes and their background finisher."""
    router = APIRouter()
    cp = ctx.control_api
    _forget_canvas_sync = ctx._forget_canvas_sync
    _vault_public_key = ctx._vault_public_key
    cipher = ctx.cipher
    current_account = ctx.current_account
    gateway_claims = ctx.gateway_claims
    generation_timings = ctx.generation_timings
    media_studio_finishers = ctx.media_studio_finishers
    media_studio_input_root = ctx.media_studio_input_root
    media_studio_video_jobs = ctx.media_studio_video_jobs
    outputs_root = ctx.outputs_root
    require_owner_or_control = ctx.require_owner_or_control
    stage_media_studio_reference = ctx.stage_media_studio_reference
    _write_inline_audio = cp._write_inline_audio
    _write_inline_image = cp._write_inline_image
    _write_inline_video = cp._write_inline_video

    def _staged_media_studio_video_inputs(
        body: MediaStudioVideoBody, request: Request
    ) -> _StagedVideoInputs:
        image: Path | None = None
        middle: Path | None = None
        end: Path | None = None
        video: Path | None = None
        motion_context: Path | None = None
        ingredient_images: list[dict[str, Any]] = []
        reference_images: list[Path] = []
        reference_audios: list[Path] = []
        reference_videos: list[dict[str, Any]] = []
        inpaint_source: Path | None = None
        inpaint_mask: Path | None = None
        inpaint_mask_video: Path | None = None
        warnings: list[str] = []
        has_private_reference = body.image_reference or body.video_reference or body.source_video_reference or any(
            item.image_reference for item in [*body.ingredient_images, *body.reference_images]
        ) or any(item.audio_reference for item in body.reference_audios) or any(
            item.video_reference for item in body.reference_videos
        )
        if has_private_reference and not bool(getattr(request.state, "is_owner", False)):
            raise HTTPException(status_code=403, detail="Private media references require an owner session")
        try:
            if len(body.ingredient_images) > 12:
                raise ValueError("At most 12 ingredient reference images are supported")
            for index, item in enumerate(body.ingredient_images):
                if item.image_base64:
                    source = _write_inline_image(
                        item.image_base64, media_studio_input_root, label=f"Ingredient {index + 1}")
                elif item.image_reference:
                    source = stage_media_studio_reference(item.image_reference)
                else:
                    raise ValueError(f"Ingredient reference {index + 1} has no image")
                description = item.description.strip()
                if len(description) > _MAX_DESCRIPTION_CHARS:
                    description = description[:_MAX_DESCRIPTION_CHARS]
                    warnings.append(
                        f"Ingredient {index + 1}'s note was shortened to {_MAX_DESCRIPTION_CHARS} characters."
                    )
                ingredient_images.append({
                    "image_path": source,
                    "description": description,
                })
            # Reference-mode pictures: order is load-bearing (<Picture N> in the
            # prompt is the Nth entry), so stage them in the order received.
            if len(body.reference_images) > 9:
                raise ValueError("At most 9 reference images are supported")
            for index, item in enumerate(body.reference_images):
                if item.image_base64:
                    reference_images.append(_write_inline_image(
                        item.image_base64, media_studio_input_root, label=f"Picture {index + 1}"))
                elif item.image_reference:
                    reference_images.append(stage_media_studio_reference(item.image_reference))
                else:
                    raise ValueError(f"Reference image {index + 1} has no image")
            # Voice clips and motion references ride the same order-is-load-bearing
            # contract as the pictures: clip N is the prompt's <Audio N>, video N
            # its <Video N>.
            if len(body.reference_audios) > 3:
                raise ValueError("At most 3 reference audio clips are supported")
            for index, audio_item in enumerate(body.reference_audios):
                if audio_item.audio_base64:
                    reference_audios.append(_write_inline_audio(
                        audio_item.audio_base64, media_studio_input_root, label=f"Voice clip {index + 1}"))
                elif audio_item.audio_reference:
                    reference_audios.append(stage_media_studio_reference(audio_item.audio_reference))
                else:
                    raise ValueError(f"Reference audio {index + 1} has no clip")
            if len(body.reference_videos) > 3:
                raise ValueError("At most 3 reference videos are supported")
            for index, video_item in enumerate(body.reference_videos):
                if video_item.video_base64:
                    staged_reference = _write_inline_video(
                        video_item.video_base64, media_studio_input_root, label=f"Motion clip {index + 1}")
                elif video_item.video_reference:
                    staged_reference = stage_media_studio_reference(video_item.video_reference)
                else:
                    raise ValueError(f"Reference video {index + 1} has no clip")
                reference_videos.append({
                    "video_path": staged_reference,
                    "use_audio": bool(video_item.use_audio),
                    "canvas": video_item.canvas,
                })
            # Video and image are decoded INDEPENDENTLY. They used to share one
            # if/elif chain, so a request carrying both — the only kind head swap
            # can make — silently lost the image and failed downstream claiming
            # the face was never supplied.
            if body.video_reference:
                video = stage_media_studio_reference(body.video_reference)
            elif body.video_base64:
                video = _write_inline_video(body.video_base64, media_studio_input_root, label="The source video")
            if body.motion_context_base64:
                if video is not None:
                    raise ValueError("A motion-context clip seeds a new shot and cannot be combined with a source video")
                motion_context = _write_inline_video(
                    body.motion_context_base64, media_studio_input_root, label="The previous shot's clip")
            # Head replacement. The clip usually arrives as a sealed reference
            # (it is already attached in the references panel), so both routes
            # exist; the mask is always inline, because the browser just painted it.
            if body.source_video_reference:
                inpaint_source = stage_media_studio_reference(body.source_video_reference)
            elif body.source_video_base64:
                inpaint_source = _write_inline_video(
                    body.source_video_base64, media_studio_input_root, label="The clip being inpainted")
            if inpaint_source is not None and video is not None:
                raise ValueError(
                    "Head replacement rewrites an existing clip and cannot be combined with a source video"
                )
            if body.mask_image_base64:
                inpaint_mask = _write_inline_image(
                    body.mask_image_base64, media_studio_input_root, label="The painted mask")
            if body.mask_video_base64:
                inpaint_mask_video = _write_inline_video(
                    body.mask_video_base64, media_studio_input_root, label="The tracked mask clip")
            if body.image_base64:
                image = _write_inline_image(body.image_base64, media_studio_input_root, label="The start image")
            elif body.image_reference:
                image = stage_media_studio_reference(body.image_reference)
            if video is None and image is None and not ingredient_images and not body.prompt.strip():
                # LTX 2.3 supports text-to-video, so a prompt alone is a valid
                # request; only reject a truly empty submission.
                raise ValueError("An image, video, or prompt is required")
            # First/middle/end keyframes are image anchors that only apply to
            # image-driven generation. The client sends them inline (any E2E
            # reference is decrypted in-browser before upload), so there is no
            # server-side reference path to stage here.
            if video is None:
                if body.middle_image_base64:
                    middle = _write_inline_image(
                        body.middle_image_base64, media_studio_input_root, label="The middle keyframe")
                if body.end_image_base64:
                    end = _write_inline_image(body.end_image_base64, media_studio_input_root, label="The end keyframe")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        return _StagedVideoInputs(
            image=image,
            middle=middle,
            end=end,
            video=video,
            motion_context=motion_context,
            ingredient_images=ingredient_images,
            reference_images=reference_images,
            reference_audios=reference_audios,
            reference_videos=reference_videos,
            inpaint_source=inpaint_source,
            inpaint_mask=inpaint_mask,
            inpaint_mask_video=inpaint_mask_video,
            warnings=warnings,
        )

    def _validated_media_studio_loras(body: MediaStudioVideoBody) -> list[dict[str, Any]]:
        loras: list[dict[str, Any]] = []
        for item in body.loras:
            lora_id = item.id.strip()
            if not lora_id or len(lora_id) > 512 or "\0" in lora_id:
                raise HTTPException(status_code=400, detail="LoRA id is invalid")
            if item.strength < -10 or item.strength > 10:
                raise HTTPException(status_code=400, detail=f"LoRA strength for {lora_id} must be between -10 and 10")
            loras.append({"id": lora_id, "strength": item.strength})
        return loras

    def _unlink_staged_media_studio_sources(staged: _StagedVideoInputs) -> None:
        for source in staged.paths():
            with contextlib.suppress(FileNotFoundError):
                source.unlink()

    def _finalize_media_studio_video(result: dict[str, Any], started: float) -> dict[str, Any]:
        # A finished clip must show in History on the next open, not after the
        # sync cache's TTL — whichever way it is stored below.
        _forget_canvas_sync()
        gateway_output = Path(str(result.get("gateway_output") or "")).name
        if gateway_output:
            # Client-only E2E output: the gateway holds the sealed envelope and
            # no server can decrypt it. Serve it through the owner-gated proxy;
            # the browser's vault does the decryption (same as the History tab).
            # Stamp whose clip it is while someone still knows: the gateway's
            # listing is machine-wide, and this name is how the workspace's
            # History finds the clip again (see GatewayOutputClaims).
            scope = current_account.get()
            if scope is not None:
                gateway_claims.claim_output(gateway_output, scope.id)
            url = f"/api/media-studio/gateway/{urllib.parse.quote(gateway_output)}"
            return {
                "ok": True,
                **_public_media_studio_result(result),
                "output": gateway_output,
                "qa": _public_media_studio_qa(result.get("qa")),
                "encrypted_at_rest": True,
                "elapsed_seconds": round(time.perf_counter() - started, 3),
                "url": url,
                "media_url": url,
            }
        _remove_media_studio_qa_artifacts(result.get("qa"), outputs_root())
        output = Path(str(result.get("output") or "")).expanduser().resolve()
        root = outputs_root().resolve()
        if not output.is_relative_to(root) or not _private_media_exists(output):
            raise RuntimeError("Media Studio returned an unavailable output")
        # Prefer client-only E2E sealing (vault public key) so this host holds no
        # decrypt key; fall back to the legacy Keychain .zenc only with no vault.
        spki = _vault_public_key()
        if spki and output.is_file():
            media_type = mimetypes.guess_type(output.name)[0] or "video/mp4"
            seal_private_media_e2e(output, spki, media_type=media_type)
            encrypted_at_rest = True
        else:
            encrypted_at_rest = _encrypt_private_media(output, cipher)
        if not (_private_media_exists(output) or e2e_media_exists(output)):
            raise RuntimeError("Media Studio output could not be secured")
        elapsed = round(time.perf_counter() - started, 3)
        url = f"/api/media-studio/generated/{urllib.parse.quote(output.name)}"
        return {
            "ok": True,
            **_public_media_studio_result(result),
            "output": output.name,
            "qa": _public_media_studio_qa(result.get("qa")),
            "encrypted_at_rest": encrypted_at_rest,
            "elapsed_seconds": elapsed,
            "url": url,
            "media_url": url,
        }

    def _media_studio_start_failure(exc: Exception, request: Request) -> HTTPException:
        """The HTTP shape of a failed start. A client mistake (a missing input,
        an impossible combination — ValueError/FileNotFoundError) is a 400 the
        studio can act on; the gateway or lane not answering (RuntimeError,
        TimeoutError) stays a 503. Either way the text is sanitized: a raw
        runner message carries staged paths under the owner's home and, on a
        traceback, whatever argv the runner echoed."""
        owner = bool(getattr(request.state, "is_owner", False))
        detail = sanitize_error_detail(str(exc)) if owner else "Media generation failed"
        status = 400 if isinstance(exc, (FileNotFoundError, ValueError)) else 503
        return HTTPException(status_code=status, detail=detail or "Media generation failed")

    @router.post("/api/media-studio/video", dependencies=[Depends(require_owner_or_control)])
    async def generate_media_studio_video(body: MediaStudioVideoBody, request: Request) -> dict:
        # Decoding up to 3x100 MB of inline clips (plus HEIC transcodes and
        # reference decrypts) happens in a worker thread, not on the loop.
        staged = await asyncio.to_thread(_staged_media_studio_video_inputs, body, request)
        loras = _validated_media_studio_loras(body)
        started = time.perf_counter()
        try:
            result = await asyncio.to_thread(
                cp.run_media_studio_video,
                image_path=staged.image,
                middle_image_path=staged.middle,
                end_image_path=staged.end,
                video_path=staged.video,
                motion_context_path=staged.motion_context,
                video_mode=body.video_mode,
                task=body.task,
                prompt=body.prompt.strip(),
                reference_description=body.reference_description.strip(),
                ingredient_images=staged.ingredient_images,
                reference_images=staged.reference_images,
                reference_audios=staged.reference_audios,
                reference_videos=staged.reference_videos,
                source_video_path=staged.inpaint_source,
                mask_image_path=staged.inpaint_mask,
                mask_video_path=staged.inpaint_mask_video,
                mask_source=body.mask_source,
                inpaint_options=body.inpaint.model_dump() if body.inpaint else None,
                duration_seconds=body.duration_seconds,
                aspect_ratio=body.aspect_ratio,
                resolution=body.resolution,
                workflow_id=body.workflow_id.strip() or None,
                studio_lane=body.studio_lane.strip(),
                run_on=body.run_on.strip(),
                loras=loras,
                output_dir=outputs_root(),
                requester_pub=_requester_pub(request),
            )
        except (FileNotFoundError, RuntimeError, TimeoutError, ValueError) as exc:
            raise _media_studio_start_failure(exc, request) from None
        finally:
            _unlink_staged_media_studio_sources(staged)
        try:
            response = _finalize_media_studio_video(result, started)
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=sanitize_error_detail(str(exc))) from None
        if staged.warnings:
            response = {**response, "warnings": list(staged.warnings)}
        return response if bool(getattr(request.state, "is_owner", False)) else machine_operation_receipt(response)

    def _prune_media_studio_video_jobs() -> None:
        cutoff = time.time() - 6 * 3600
        for key in [key for key, entry in media_studio_video_jobs.items() if entry.get("created", 0.0) < cutoff]:
            media_studio_video_jobs.pop(key, None)

    def _readopt_media_studio_video_job(job_id: str, requester_pub: str) -> dict[str, Any] | None:
        """Rebuild the registry entry for a job this workspace already started.

        The registry dies with the process; the claim ledger and the gateway's
        own record do not, and the browser re-presents the device key the job
        was started with on every poll. That is everything the finisher needs,
        so a poll that arrives after a restart re-arms it instead of reporting a
        failure for a clip that is still rendering (or already rendered).

        Returns the entry, or None when the job is not this workspace's to
        adopt or the gateway knows nothing about it.
        """
        scope = current_account.get()
        claimed = gateway_claims.account_for(GatewayOutputClaims.job_key(job_id))
        if claimed is not None and (scope is None or claimed != scope.id):
            return None  # another workspace's job; it is not ours to report on
        entry: dict[str, Any] = {
            "status": "running",
            "created": time.time(),
            "started": time.perf_counter(),
            "last_progress_at": time.time(),
            "readopted": True,
            # The inputs were deleted from the gateway by the finisher that died
            # with the old process, or will be by this one; either way this
            # registry entry has no list of its own to clean up.
            "uploaded_names": [],
            "requester_pub": requester_pub,
        }
        media_studio_video_jobs[job_id] = entry
        if claimed is None and scope is not None:
            # An unclaimed job polled by a workspace is that workspace's: without
            # this the finished clip files under the owner instead of them.
            gateway_claims.claim_job(job_id, scope.id)
        return entry

    # A backend that has stopped answering has to be said out loud, not left to
    # a bar parked at 98%. The thresholds live at module scope above.
    def _video_silent_seconds(entry: dict[str, Any]) -> float:
        return time.time() - float(entry.get("last_progress_at") or time.time())

    async def _confirm_media_studio_video_backend(job_id: str, entry: dict[str, Any]) -> None:
        """Once a job has gone quiet, ask the gateway whether anything still has it.

        Throttled, and only ever reached after the silence window, so a healthy
        render costs one extra call every ten seconds at most. An empty answer
        is the honest signal: /api/job/<id> serves live jobs, history and remote
        route records, so nothing there means no lane, no watcher, no record.
        """
        now = time.time()
        if now - float(entry.get("record_probed_at") or 0.0) < cp._VIDEO_RECORD_PROBE_SECONDS:
            return
        entry["record_probed_at"] = now
        record = await asyncio.to_thread(
            cp.run_media_studio_video_record, job_id,
            requester_pub=str(entry.get("requester_pub") or ""),
        )
        entry["record_misses"] = 0 if record else int(entry.get("record_misses") or 0) + 1

    def _video_backend_stopped_responding(entry: dict[str, Any]) -> bool:
        """Has the thing that was rendering this job gone away?

        Two independent symptoms, both needing the same silence window before
        they count: the status check keeps raising (the gateway is unreachable),
        or the gateway answers but no longer has a record of the job at all
        (it restarted, or the lane it was routed to is gone). A local Comfy lane
        that is still busy vetoes both — that is a render in progress whatever
        the gateway is doing.
        """
        if _video_silent_seconds(entry) < cp._VIDEO_UNRESPONSIVE_SECONDS:
            return False
        gone = (
            int(entry.get("check_failures") or 0) >= cp._VIDEO_UNRESPONSIVE_CHECKS
            or int(entry.get("record_misses") or 0) >= 2
        )
        return bool(gone and not _video_lane_still_working(entry))

    def _video_lane_still_working(entry: dict[str, Any]) -> bool:
        """Is the local Comfy lane this job was sent to still holding work?

        Only ever consulted as a veto. A lane that answers /queue with work in
        flight is proof the render survived whatever the gateway is doing; a
        lane that cannot be asked (a rented run, a native MLX run, a lane that
        is genuinely gone) proves nothing and is not allowed to keep a dead job
        alive.
        """
        lane = str(entry.get("run_on") or "").strip() or "default"
        url = comfy_lanes.configured_lanes().get(lane)
        if not url:
            return False
        return comfy_lanes._is_busy(url) is True

    async def _finish_media_studio_video_job(job_id: str) -> None:
        """Drive a running job to its terminal state. Kicked off as a background
        task at start and re-entered (idempotently, via the finalizing flag) by
        the poll route, so a lost event loop can never strand a finished job."""
        entry = media_studio_video_jobs.get(job_id)
        if entry is None or entry.get("status") != "running":
            return
        # The finalizing flag is scoped to the event loop that set it: if that
        # loop died mid-finalize (its tasks are cancelled but the flag would
        # stay set), a caller on a NEW loop may reclaim the job.
        loop_id = id(asyncio.get_running_loop())
        if entry.get("finalizing") and entry.get("finalizing_loop") == loop_id:
            return
        entry["finalizing"] = True
        entry["finalizing_loop"] = loop_id
        try:
            result = await asyncio.to_thread(
                cp.run_media_studio_video_finish,
                job_id,
                uploaded_names=list(entry.get("uploaded_names") or []),
                output_dir=outputs_root(),
                # Poll as the browser that started it: a keyed job is readable
                # only by its own requester, so the key is part of the job's
                # identity here, not a per-request detail.
                requester_pub=str(entry.get("requester_pub") or ""),
            )
            # A cancel that landed while the finisher was blocked in the thread
            # is terminal — don't resurrect the entry as done or error.
            if entry.get("status") == "cancelled":
                return
            entry.update(status="done", response=_finalize_media_studio_video(result, float(entry.get("started") or time.perf_counter())))
            # Record the real duration so future runs of the same shape get a
            # sharper elapsed/expected estimate.
            with contextlib.suppress(Exception):
                duration = time.perf_counter() - float(entry.get("started") or time.perf_counter())
                if entry.get("signature") and duration > 0:
                    generation_timings.record(
                        entry["signature"],
                        entry.get("workflow") or "",
                        float(entry.get("work_units") or 0),
                        duration,
                    )
        except Exception as exc:
            if entry.get("status") != "cancelled":
                # One sanitizer between a lane's failure text and the toast: a
                # native-LTX or local-Comfy failure used to arrive as 4 KB of
                # runner output with absolute paths (and, via argv echoes,
                # possibly the prompt) — against the privacy boundary.
                detail = sanitize_error_detail(str(exc)) or "Media generation failed"
                # The toast keeps one sentence; the log keeps the frame list, so
                # a lane that fails the same way every time is diagnosable.
                log.error(
                    "video job %s failed: %s | %s",
                    job_id,
                    detail,
                    frame_list(exc),
                )
                entry.update(status="error", detail=detail)

    @router.post("/api/media-studio/video/start", dependencies=[Depends(require_owner_or_control)])
    async def start_media_studio_video(body: MediaStudioVideoBody, request: Request) -> dict:
        staged = await asyncio.to_thread(_staged_media_studio_video_inputs, body, request)
        loras = _validated_media_studio_loras(body)
        started = time.perf_counter()
        try:
            queued = await asyncio.to_thread(
                cp.run_media_studio_video_start,
                image_path=staged.image,
                middle_image_path=staged.middle,
                end_image_path=staged.end,
                video_path=staged.video,
                motion_context_path=staged.motion_context,
                video_mode=body.video_mode,
                task=body.task,
                prompt=body.prompt.strip(),
                reference_description=body.reference_description.strip(),
                ingredient_images=staged.ingredient_images,
                reference_images=staged.reference_images,
                reference_audios=staged.reference_audios,
                reference_videos=staged.reference_videos,
                source_video_path=staged.inpaint_source,
                mask_image_path=staged.inpaint_mask,
                mask_video_path=staged.inpaint_mask_video,
                mask_source=body.mask_source,
                inpaint_options=body.inpaint.model_dump() if body.inpaint else None,
                duration_seconds=body.duration_seconds,
                aspect_ratio=body.aspect_ratio,
                resolution=body.resolution,
                workflow_id=body.workflow_id.strip() or None,
                studio_lane=body.studio_lane.strip(),
                run_on=body.run_on.strip(),
                seed=body.seed,
                denoise=body.denoise,
                negative_prompt=body.negative_prompt,
                nag_scale=body.nag_scale,
                head_swap_lora_strength=body.head_swap_lora_strength,
                head_swap_backend=body.head_swap_backend,
                head_swap_face_enhancer=body.head_swap_face_enhancer,
                spectrum=body.spectrum,
                fast_high_res=body.fast_high_res,
                steps=body.steps,
                loras=loras,
                requester_pub=_requester_pub(request),
            )
        except (FileNotFoundError, RuntimeError, TimeoutError, ValueError) as exc:
            raise _media_studio_start_failure(exc, request) from None
        finally:
            # start_video uploads the inputs to the gateway before returning,
            # so the staged control-api copies are no longer needed either way.
            _unlink_staged_media_studio_sources(staged)
        job_id = str(queued["job_id"])
        # The output name is only known at finish; the job id is the earlier
        # handle, and the one that survives a studio restart mid-run.
        scope = current_account.get()
        if scope is not None:
            gateway_claims.claim_job(job_id, scope.id)
        _prune_media_studio_video_jobs()
        signature, workflow, work_units = _video_timing_signature(body)
        estimate_seconds = generation_timings.estimate(
            signature, workflow, work_units, fallback_rate=_DEFAULT_VIDEO_SECONDS_PER_WORK_UNIT
        )
        media_studio_video_jobs[job_id] = {
            "status": "running",
            "created": time.time(),
            "started": started,
            "signature": signature,
            "workflow": workflow,
            "work_units": work_units,
            "estimate_seconds": estimate_seconds,
            # When the backend last said anything at all, and which lane to ask
            # about before declaring it dead.
            "last_progress_at": time.time(),
            "run_on": body.run_on.strip(),
            "uploaded_names": list(queued.get("uploaded_names") or []),
            # Held for the life of the job: the background finisher polls long
            # after this request is gone, and a keyed job only answers to the
            # requester that started it.
            "requester_pub": _requester_pub(request),
        }
        finisher = asyncio.get_running_loop().create_task(_finish_media_studio_video_job(job_id))
        media_studio_finishers.add(finisher)
        finisher.add_done_callback(media_studio_finishers.discard)
        return {
            "ok": True,
            "job_id": job_id,
            "status": "running",
            **({"estimate_seconds": estimate_seconds} if estimate_seconds else {}),
            **({"warnings": list(staged.warnings)} if staged.warnings else {}),
        }

    @router.get("/api/media-studio/video/job/{job_id}", dependencies=[Depends(require_owner_or_control)])
    async def media_studio_video_job(job_id: str, request: Request) -> dict:
        entry = media_studio_video_jobs.get(job_id)
        if entry is None:
            # The registry is gone (the studio restarted) but the run may not be.
            # Ask the gateway before calling this unknown.
            requester_pub = _requester_pub(request)
            record = await asyncio.to_thread(
                cp.run_media_studio_video_record, job_id, requester_pub=requester_pub,
            )
            if record is None:
                raise HTTPException(
                    status_code=404,
                    detail="Unknown media job. If the studio restarted mid-generation, the finished video still appears in History.",
                )
            status = str(record.get("status") or "").strip().lower()
            if status == "interrupted":
                # Written by the gateway as it shut down: nothing is rendering
                # this any more, and saying so with a retry is the whole fix.
                return {
                    "ok": False,
                    "status": "error",
                    "detail": "The studio restarted before this finished. Try again.",
                    "retryable": True,
                }
            entry = _readopt_media_studio_video_job(job_id, requester_pub)
            if entry is None:
                raise HTTPException(
                    status_code=404,
                    detail="Unknown media job. If the studio restarted mid-generation, the finished video still appears in History.",
                )
            # Re-arm the finisher the dead process was running: the download, QA,
            # sealing and output claim all still have to happen.
            asyncio.get_running_loop().create_task(_finish_media_studio_video_job(job_id))
        progress = None
        steps: dict[str, int] = {}
        queued_behind = 0
        if entry["status"] == "running":
            state = None
            check_raised = False
            try:
                # Progress for a keyed job is readable only by its requester —
                # taken from the registry, not this request, so a poll from a
                # second tab still reports the job it started.
                state = await asyncio.to_thread(
                    cp.run_media_studio_video_check, job_id,
                    requester_pub=str(entry.get("requester_pub") or ""),
                )
            except Exception:
                check_raised = True
            if state:
                entry["check_failures"] = 0
                progress = state.get("progress")
                queued_behind = int(state.get("queue_position") or 0)
                if state.get("progress_total"):
                    steps = {
                        "progress_step": int(state.get("progress_step") or 0),
                        "progress_total": int(state["progress_total"]),
                    }
                # Silence is measured from the last time the backend said
                # something NEW: a check that keeps answering "running, no
                # progress" is exactly what a dead lane looks like from here.
                marker = (progress, steps.get("progress_step"))
                if marker != entry.get("last_marker"):
                    entry["last_marker"] = marker
                    entry["last_progress_at"] = time.time()
                # The background finisher normally lands the job; if its event
                # loop was lost, adopt the finished (or failed) job right here.
                if state.get("failed") or state.get("video_url"):
                    await _finish_media_studio_video_job(job_id)
            elif check_raised:
                entry["check_failures"] = int(entry.get("check_failures") or 0) + 1
            if entry["status"] == "running" and _video_silent_seconds(entry) >= cp._VIDEO_UNRESPONSIVE_SECONDS:
                await _confirm_media_studio_video_backend(job_id, entry)
                if _video_backend_stopped_responding(entry):
                    entry.update(status="error", detail=_VIDEO_BACKEND_GONE, retryable=True)
        if entry["status"] == "done":
            response = entry["response"]
            return response if bool(getattr(request.state, "is_owner", False)) else machine_operation_receipt(response)
        if entry["status"] in ("error", "cancelled"):
            # HTTP 200 with ok:false on purpose: a cancel is terminal but not an
            # error, and the studio's poller reads this shape (hivemindStudio.js).
            detail = (
                sanitize_error_detail(entry.get("detail")) if bool(getattr(request.state, "is_owner", False))
                else "Media generation failed"
            )
            return {
                "ok": False,
                "status": entry["status"],
                "detail": detail or "Generation cancelled",
                # A failure the studio may offer to run again, as opposed to one
                # that would just fail the same way.
                **({"retryable": True} if entry.get("retryable") else {}),
            }
        elapsed_seconds = round(max(0.0, time.perf_counter() - float(entry.get("started") or time.perf_counter())), 1)
        return {
            "ok": True,
            "status": "running",
            "elapsed_seconds": elapsed_seconds,
            **({"progress": progress} if progress is not None else {}),
            **steps,
            # Holding for the machine's GPU slot behind another render. The
            # studio says how many are ahead rather than showing a frozen bar.
            **({"queue_position": queued_behind} if queued_behind > 0 else {}),
            **({"estimate_seconds": entry["estimate_seconds"]} if entry.get("estimate_seconds") else {}),
        }

    @router.post("/api/media-studio/video/job/{job_id}/cancel", dependencies=[Depends(require_owner_or_control)])
    def cancel_media_studio_video_job(job_id: str) -> dict:
        """Cancel/reset a video job. Marks the tracked job terminal so its finalizer
        stops and further polls return a cancelled state, and forwards a best-effort
        interrupt to the backend. Always succeeds (even for an unknown or already-
        finished job) so the studio can unblock the UI regardless — this is also the
        escape hatch for a job whose output never resolved a URL and hung 'running'."""
        entry = media_studio_video_jobs.get(job_id)
        outcome: dict[str, Any] = {"interrupted": False, "stopped": False, "backend_state": None}
        with contextlib.suppress(Exception):
            # Cancel as the job's own requester — the gateway will not act on a
            # keyed job for anyone else.
            result = cp.run_media_studio_video_cancel(
                job_id, requester_pub=str((entry or {}).get("requester_pub") or ""),
            )
            # A bool is what older builds of cancel_video returned.
            outcome = result if isinstance(result, dict) else {
                "interrupted": bool(result), "stopped": bool(result), "backend_state": None,
            }
        if entry is not None:
            entry["status"] = "cancelled"
            entry["detail"] = "Cancelled by the owner."
        stopped = bool(outcome.get("stopped"))
        return {
            "ok": True,
            "status": "cancelled",
            "known": entry is not None,
            "interrupted": bool(outcome.get("interrupted")),
            # The job is off the UI either way, but the BACKEND may still be
            # winding down — and while it is, the next generation queues behind
            # it. Saying so is the difference between "cancelled" and a studio
            # that looks like it ignored the cancel.
            "stopped": stopped,
            **({"backend_state": outcome["backend_state"]} if outcome.get("backend_state") else {}),
            **({} if stopped else {
                "detail": "Still stopping: the backend finishes its current step before it can let go. "
                          "A new generation will queue behind it until then.",
            }),
        }

    app.include_router(router)
