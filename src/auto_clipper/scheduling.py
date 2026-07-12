"""Approval-gated scheduling."""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from . import db
from .config import Config
from hivemind_content_studio.publishing import PostizPublisher, build_postiz_payload, integration_id_for, write_json


def schedule_run(
    conn,
    cfg: Config,
    *,
    run_id: int,
    platforms: list[str],
    times: list[str],
) -> list[int]:
    clips = db.assert_schedule_allowed(conn, run_id)
    if not platforms:
        raise ValueError("At least one platform is required")
    if not times:
        raise ValueError("At least one HH:MM time is required")

    tz = ZoneInfo(cfg.timezone)
    client = PostizPublisher(cfg.postiz_url, cfg.postiz_api_key)
    draft_ids: list[int] = []
    slot_index = 0
    for clip in clips:
        for platform in platforms:
            scheduled_at = _scheduled_datetime(slot_index, times, tz)
            integration_id = integration_id_for(platform)
            payload = build_postiz_payload(
                platform=platform,
                integration_id=integration_id,
                caption=str(clip["transcript_excerpt"] or clip["rationale"] or "Approved clip"),
                media=[{"path": clip["output_path"]}] if clip["output_path"] else [],
                scheduled_at=scheduled_at.isoformat(),
            )
            payload_path = cfg.data_dir / "postiz-payloads" / f"run-{run_id:04d}-clip-{clip['id']}-{platform}.json"
            write_json(payload_path, payload)
            status = "planned"
            post_id = None
            error = None
            if cfg.postiz_enable_write:
                if not integration_id:
                    status = "blocked_missing_integration"
                    error = f"Missing POSTIZ_INTEGRATION_{platform.upper().replace('-', '_')}"
                else:
                    try:
                        media = client.upload_media(Path(str(clip["output_path"])))
                        payload = build_postiz_payload(
                            platform=platform,
                            integration_id=integration_id,
                            caption=str(clip["transcript_excerpt"] or clip["rationale"] or "Approved clip"),
                            media=[{"id": media["id"], "path": media["path"]}],
                            scheduled_at=scheduled_at.isoformat(),
                        )
                        write_json(payload_path, payload)
                        response = client.create_post(payload)
                        first = response[0] if isinstance(response, list) and response else response
                        post_id = str(first.get("postId") or first.get("id") or "") if isinstance(first, dict) else ""
                        status = "scheduled"
                    except Exception as exc:  # pragma: no cover - network path
                        status = "postiz_error"
                        error = str(exc)
            draft_id = db.add_post_draft(
                conn,
                run_id=run_id,
                clip_id=int(clip["id"]),
                platform=platform,
                scheduled_at=scheduled_at.isoformat(),
                tz=cfg.timezone,
                integration_id=integration_id,
                status=status,
                post_id=post_id,
                payload_path=str(payload_path),
                error=error,
            )
            draft_ids.append(draft_id)
            slot_index += 1
    return draft_ids


def _scheduled_datetime(slot_index: int, times: list[str], tz: ZoneInfo) -> datetime:
    now = datetime.now(tz)
    day_offset = slot_index // len(times)
    hour, minute = _parse_hhmm(times[slot_index % len(times)])
    candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0) + timedelta(days=day_offset)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate


def _parse_hhmm(value: str) -> tuple[int, int]:
    try:
        hour_raw, minute_raw = value.split(":", 1)
        hour, minute = int(hour_raw), int(minute_raw)
    except ValueError as exc:
        raise ValueError(f"Invalid time {value!r}; expected HH:MM") from exc
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        raise ValueError(f"Invalid time {value!r}; expected HH:MM")
    return hour, minute
