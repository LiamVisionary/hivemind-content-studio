"""Provider-neutral content planning for every production lane."""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

import yaml

from .config import load_config
from .manifest import add_artifact, create_manifest, write_manifest


DEFAULT_PROVIDERS = {
    "script": "agent-runtime",
    "image": "comfyui",
    "motion": "media-studio-mcp",
    "voice": "universal-tts",
    "music": "ace-step",
    "stock": "pexels",
    "assembly": "moneyprinterturbo",
    "clip": "auto-clipper",
    "publish": "postiz",
}


def load_brief(path: str | Path) -> dict[str, Any]:
    brief_path = Path(path).expanduser().resolve()
    brief = yaml.safe_load(brief_path.read_text(encoding="utf-8")) or {}
    if not isinstance(brief, dict):
        raise ValueError(f"Brief must be a YAML object: {brief_path}")
    return brief


def infer_lane(brief: dict[str, Any]) -> str:
    explicit = str(brief.get("lane") or "").strip().lower()
    if explicit in {"animation", "first-frame-animation-ad", "stickman-performance-ad", "static-text-ad", "faceless", "clip", "social-post"}:
        return explicit
    brief_type = str(brief.get("type") or "").lower()
    if "clip" in brief_type:
        return "clip"
    if brief_type in {"faceless_short", "short", "stock_video"}:
        return "faceless"
    return "animation"


def plan(brief_path: str | Path, *, lane: str | None = None) -> Path:
    cfg = load_config()
    brief = load_brief(brief_path)
    selected_lane = lane or infer_lane(brief)
    provider_overrides = brief.get("providers") if isinstance(brief.get("providers"), dict) else {}
    providers = {**DEFAULT_PROVIDERS, **{str(k): str(v) for k, v in provider_overrides.items()}}
    manifest_path, manifest = create_manifest(lane=selected_lane, brief=brief, runs_dir=cfg.runs_dir, providers=providers)
    run_dir = manifest_path.parent

    brief_snapshot = run_dir / "brief.yaml"
    brief_snapshot.write_text(yaml.safe_dump(brief, sort_keys=False), encoding="utf-8")
    add_artifact(manifest, role="brief", path=brief_snapshot)

    if selected_lane == "animation":
        _plan_animation(run_dir, brief, manifest)
    elif selected_lane == "first-frame-animation-ad":
        _plan_first_frame_animation_ad(run_dir, brief, manifest)
    elif selected_lane == "stickman-performance-ad":
        manifest["providers"]["image"] = str(provider_overrides.get("image") or "stickman-renderer")
        _plan_stickman_performance_ad(run_dir, brief, manifest)
    elif selected_lane == "static-text-ad":
        manifest["providers"]["image"] = str(provider_overrides.get("image") or "static-text-renderer")
        _plan_static_text_ad(run_dir, brief, manifest)
    elif selected_lane == "faceless":
        _plan_faceless(run_dir, brief, manifest)
    elif selected_lane == "clip":
        _plan_clip(run_dir, brief, manifest)
    else:
        _plan_social_post(run_dir, brief, manifest)

    write_manifest(manifest_path, manifest)
    return manifest_path


def _scenes(brief: dict[str, Any]) -> list[dict[str, Any]]:
    raw = brief.get("scenes") or []
    if not isinstance(raw, list):
        raise ValueError("Brief scenes must be a list")
    return [item if isinstance(item, dict) else {"beat": str(item)} for item in raw]


def _plan_animation(run_dir: Path, brief: dict[str, Any], manifest: dict[str, Any]) -> None:
    scenes = _scenes(brief)
    scene_csv = run_dir / "scene_manifest.csv"
    with scene_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["scene", "title", "duration_seconds", "beat", "voice", "image_prompt", "motion_prompt"])
        writer.writeheader()
        for index, scene in enumerate(scenes, start=1):
            beat = str(scene.get("beat") or scene.get("description") or "")
            writer.writerow({
                "scene": index,
                "title": scene.get("title") or f"Scene {index}",
                "duration_seconds": scene.get("duration_seconds") or "",
                "beat": beat,
                "voice": scene.get("voice") or beat,
                "image_prompt": scene.get("image_prompt") or beat,
                "motion_prompt": scene.get("motion_prompt") or f"Animate the scene naturally: {beat}",
            })
    add_artifact(manifest, role="scene-manifest", path=scene_csv)

    prompt_roles = {
        "image-prompts": ("image", "image_prompt"),
        "motion-prompts": ("motion", "motion_prompt"),
        "voice-lines": ("voice", "voice"),
    }
    for artifact_role, (provider_role, scene_key) in prompt_roles.items():
        output = run_dir / f"{artifact_role}.md"
        blocks = []
        for index, scene in enumerate(scenes, start=1):
            value = scene.get(scene_key) or scene.get("beat") or ""
            blocks.append(f"## Scene {index}\n\n{value}")
        output.write_text("\n\n".join(blocks).strip() + "\n", encoding="utf-8")
        add_artifact(manifest, role=artifact_role, path=output, provider=manifest["providers"][provider_role])

    music = run_dir / "music-brief.md"
    music_data = brief.get("music") if isinstance(brief.get("music"), dict) else {}
    music.write_text(str(music_data.get("mood") or brief.get("music_prompt") or "Instrumental score matching the story arc.") + "\n", encoding="utf-8")
    add_artifact(manifest, role="music-brief", path=music, provider=manifest["providers"]["music"])
    _write_publish_metadata(run_dir, brief, manifest)


def _write_script_request(run_dir: Path, brief: dict[str, Any], manifest: dict[str, Any]) -> None:
    request = {
        "title": str(brief.get("title") or brief.get("id") or "Untitled content"),
        "audience": str(brief.get("audience") or ""),
        "goal": str(brief.get("goal") or ""),
        "tone": str(brief.get("tone") or ""),
        "runtime_seconds": brief.get("runtime_seconds"),
        "style_guardrails": brief.get("style_guardrails") or [],
        "scenes": _scenes(brief),
        "output_contract": {
            "format": "markdown",
            "requirements": [
                "Write exact voiceover and on-screen copy for every scene.",
                "Keep claims grounded in the brief; flag any claim requiring approval.",
                "Preserve the requested scene order and duration budget.",
            ],
        },
    }
    output = run_dir / "script-request.json"
    output.write_text(json.dumps(request, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    add_artifact(manifest, role="script-request", path=output, provider=manifest["providers"]["script"])


def _write_generation_requests(run_dir: Path, brief: dict[str, Any], manifest: dict[str, Any], *, keyframes: bool) -> None:
    aspect_ratio = str(brief.get("aspect_ratio") or "9:16")
    scenes = _scenes(brief)
    if keyframes:
        keyframe_requests = [
            {
                "scene": index,
                "title": scene.get("title") or f"Scene {index}",
                "prompt": scene.get("image_prompt") or scene.get("beat") or "",
                "aspect_ratio": aspect_ratio,
                "continuity": brief.get("continuity") or brief.get("style") or {},
            }
            for index, scene in enumerate(scenes, start=1)
        ]
        output = run_dir / "keyframe-requests.json"
        output.write_text(json.dumps(keyframe_requests, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        add_artifact(manifest, role="keyframe-requests", path=output, provider=manifest["providers"]["image"])

    motion_requests = [
        {
            "scene": index,
            "duration_seconds": float(scene.get("duration_seconds") or 4),
            "prompt": scene.get("motion_prompt") or f"Animate naturally: {scene.get('beat') or ''}",
            "aspect_ratio": aspect_ratio,
            "source_role": "keyframe",
        }
        for index, scene in enumerate(scenes, start=1)
    ]
    motion = run_dir / "motion-requests.json"
    motion.write_text(json.dumps(motion_requests, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    add_artifact(manifest, role="motion-requests", path=motion, provider=manifest["providers"]["motion"])


def _write_editor_handoff(run_dir: Path, brief: dict[str, Any], manifest: dict[str, Any]) -> None:
    handoff = {
        "schema_version": 1,
        "aspect_ratio": str(brief.get("aspect_ratio") or "9:16"),
        "timeline": [
            {
                "scene": index,
                "duration_seconds": float(scene.get("duration_seconds") or 4),
                "video_role": "scene-video",
                "voice_role": "voice-line",
                "overlay": scene.get("overlay") or scene.get("title") or "",
            }
            for index, scene in enumerate(_scenes(brief), start=1)
        ],
        "targets": ["ffmpeg", "remotion", "capcut-handoff"],
        "note": "FFmpeg is the deterministic zero-human default; CapCut receives a portable asset/timeline handoff rather than an unstable private project format.",
    }
    output = run_dir / "editor-handoff.json"
    output.write_text(json.dumps(handoff, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    add_artifact(manifest, role="editor-handoff", path=output, provider=manifest["providers"]["assembly"])


def _plan_first_frame_animation_ad(run_dir: Path, brief: dict[str, Any], manifest: dict[str, Any]) -> None:
    _write_script_request(run_dir, brief, manifest)
    _plan_animation(run_dir, brief, manifest)
    _write_generation_requests(run_dir, brief, manifest, keyframes=True)
    _write_editor_handoff(run_dir, brief, manifest)


def _plan_stickman_performance_ad(run_dir: Path, brief: dict[str, Any], manifest: dict[str, Any]) -> None:
    _write_script_request(run_dir, brief, manifest)
    _plan_animation(run_dir, brief, manifest)
    scenes = _scenes(brief)
    output = run_dir / "stickman-scenes.json"
    output.write_text(json.dumps(scenes, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    add_artifact(manifest, role="stickman-scenes", path=output, provider="stickman-renderer")
    _write_generation_requests(run_dir, brief, manifest, keyframes=False)
    _write_editor_handoff(run_dir, brief, manifest)


def _plan_static_text_ad(run_dir: Path, brief: dict[str, Any], manifest: dict[str, Any]) -> None:
    _write_script_request(run_dir, brief, manifest)
    scenes = _scenes(brief)
    output = run_dir / "static-text-scenes.json"
    output.write_text(json.dumps(scenes, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    add_artifact(manifest, role="static-text-scenes", path=output, provider="static-text-renderer")
    _write_publish_metadata(run_dir, brief, manifest)


def _plan_faceless(run_dir: Path, brief: dict[str, Any], manifest: dict[str, Any]) -> None:
    voice = brief.get("voice") if isinstance(brief.get("voice"), dict) else {}
    subtitles = brief.get("subtitles") if isinstance(brief.get("subtitles"), dict) else {}
    payload = {
        "video_subject": brief.get("subject") or brief.get("title") or brief.get("goal") or "",
        "video_script": brief.get("script") or "",
        "video_terms": brief.get("search_terms") or [],
        "video_aspect": brief.get("aspect_ratio") or "9:16",
        "video_source": brief.get("media_source") or "pexels",
        "voice_name": voice.get("voice_id") or "",
        "subtitle_enabled": subtitles.get("enabled", True),
        "video_count": int(brief.get("count") or 1),
        "video_clip_duration": int(brief.get("clip_duration_seconds") or 5),
    }
    params = run_dir / "faceless-params.json"
    params.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    add_artifact(manifest, role="faceless-params", path=params, provider="moneyprinterturbo")
    _write_publish_metadata(run_dir, brief, manifest)


def _plan_clip(run_dir: Path, brief: dict[str, Any], manifest: dict[str, Any]) -> None:
    payload = {
        "source": brief.get("source"),
        "creator": brief.get("creator"),
        "top": int(brief.get("top") or 5),
        "caption_style": brief.get("caption_style") or "branded",
        "rights_status": "research",
    }
    clip_plan = run_dir / "clip-plan.json"
    clip_plan.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    add_artifact(manifest, role="clip-plan", path=clip_plan, provider="auto-clipper")
    _write_publish_metadata(run_dir, brief, manifest)


def _plan_social_post(run_dir: Path, brief: dict[str, Any], manifest: dict[str, Any]) -> None:
    _write_publish_metadata(run_dir, brief, manifest)


def _write_publish_metadata(run_dir: Path, brief: dict[str, Any], manifest: dict[str, Any]) -> None:
    publish = brief.get("publish") if isinstance(brief.get("publish"), dict) else {}
    metadata = {
        "title": publish.get("title") or brief.get("title") or brief.get("subject") or "",
        "caption": publish.get("caption") or brief.get("caption") or "",
        "platforms": publish.get("platforms") or ([publish["platform"]] if publish.get("platform") else []),
        "hashtags": publish.get("hashtags") or brief.get("hashtags") or [],
        "cta": publish.get("cta") or brief.get("cta") or "",
    }
    output = run_dir / "publish-metadata.json"
    output.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    add_artifact(manifest, role="publish-metadata", path=output, provider=manifest["providers"]["publish"])
