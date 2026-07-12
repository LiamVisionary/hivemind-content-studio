"""Single source of truth for every content-production provider."""

from __future__ import annotations

import os
import shutil
import subprocess
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from typing import Literal

from .config import StudioConfig, load_config


ProviderMode = Literal["local", "tailnet", "cloud", "manual"]


@dataclass(frozen=True)
class Provider:
    id: str
    roles: tuple[str, ...]
    mode: ProviderMode
    requirement: str
    cost: str
    side_effects: tuple[str, ...]
    fallback: str | None = None


PROVIDER_MATRIX: tuple[Provider, ...] = (
    Provider("agent-runtime", ("script", "metadata"), "local", "Any stdin/stdout agent command or agent calling the studio MCP", "local/BYOK", ("filesystem", "agent-generation"), "openai-compatible"),
    Provider("openai-compatible", ("script", "metadata"), "local", "OPENAI_BASE_URL + OPENAI_API_KEY", "local/BYOK", ("network",), "manual"),
    Provider("stickman-renderer", ("image", "keyframe", "stickman"), "local", "Pillow + ffmpeg", "local", ("filesystem",), "comfyui"),
    Provider("static-text-renderer", ("image", "keyframe", "static-ad"), "local", "Pillow", "local", ("filesystem",), "comfyui"),
    Provider("comfyui", ("image", "keyframe", "motion"), "local", "ComfyUI or HivemindOS image/video route", "local", ("filesystem", "network"), "media-studio-mcp"),
    Provider("openai-gpt-image", ("image", "keyframe", "image-editing"), "cloud", "OPENAI_API_KEY", "paid", ("network", "filesystem", "spend"), "openai-gpt-image-oauth"),
    Provider("openai-gpt-image-oauth", ("image", "keyframe", "image-editing"), "cloud", "HivemindOS OpenAI ChatGPT/Codex OAuth (beta)", "paid/subscription", ("network", "filesystem", "spend"), "openai-gpt-image"),
    Provider("xai-imagine-api", ("image", "keyframe", "motion", "video", "image-to-video", "video-editing"), "cloud", "XAI_API_KEY", "paid", ("network", "filesystem", "spend"), "xai-imagine-oauth"),
    Provider("xai-imagine-oauth", ("image", "keyframe", "motion", "video", "image-to-video", "video-editing"), "cloud", "HivemindOS xAI OAuth with api:access", "paid", ("network", "filesystem", "spend"), "xai-imagine-api"),
    Provider("media-studio-mcp", ("motion", "video", "image-to-video"), "tailnet", "HivemindOS Media Studio mcpVideo preference + optional MEDIA_STUDIO_TOKEN", "local/fleet", ("filesystem", "network", "generation"), "comfyui"),
    Provider("palmier-pro", ("assembly", "timeline", "export"), "local", "Palmier Pro open at PALMIER_MCP_URL", "local editor; generation may require upstream plan", ("filesystem", "network", "project-write"), "moneyprinterturbo"),
    Provider("clueso-mcp", ("video-workflow", "video-editing", "localization", "documentation"), "manual", "Authenticated Clueso MCP in the active agent runtime", "provider account/plan; verify before generation", ("network", "external-upload", "project-write", "generation", "unknown-cost"), "local studio providers"),
    Provider("moneyprinterturbo", ("faceless", "assembly", "subtitles"), "local", "ffmpeg + Python dependencies", "local", ("filesystem",), "ffmpeg"),
    Provider("auto-clipper", ("ingest", "transcript", "clip", "rights", "monetization"), "local", "yt-dlp + ffmpeg + optional Podcli", "local", ("filesystem", "network"), "muapi-ai-clipping"),
    Provider("universal-tts", ("voice",), "local", "UNIVERSAL_TTS_URL", "local", ("network", "filesystem"), "edge-tts"),
    Provider("elevenlabs", ("voice", "line-voice", "lip-sync-audio"), "cloud", "ELEVENLABS_API_KEY + per-run voice id", "paid", ("network", "filesystem", "spend"), "universal-tts"),
    Provider("ace-step", ("music",), "local", "ACE_STEP_API_BASE_URL or ace-step executable", "local", ("network", "filesystem"), "muapi"),
    Provider("pexels", ("stock-video", "stock-image"), "cloud", "PEXELS_API_KEY or PEXELS_API_KEYS", "free/BYOK", ("network", "filesystem"), "pixabay"),
    Provider("pixabay", ("stock-video", "stock-image", "music"), "cloud", "PIXABAY_API_KEY or PIXABAY_API_KEYS", "free/BYOK", ("network", "filesystem"), "local-media"),
    Provider("hivemindos-hosted-media", ("image", "keyframe", "motion", "image-to-video"), "cloud", "Local HivemindOS /api/hivemindos/media route + shared hosted credits", "hosted credits + 25%", ("network", "filesystem", "delegated-spend"), "muapi"),
    Provider("muapi", ("image", "keyframe", "motion", "image-to-video", "music", "lip-sync", "clip"), "cloud", "MUAPI_API_KEY or MUAPI_KEY", "paid", ("network", "filesystem", "spend"), "local providers"),
    Provider("higgsfield-cloud", ("image", "keyframe", "motion", "image-to-video", "ugc", "analysis"), "cloud", "HIGGSFIELD_API_KEY_ID + HIGGSFIELD_API_KEY_SECRET", "paid", ("network", "filesystem", "spend"), "higgsfield-consumer"),
    Provider("higgsfield-consumer", ("image", "keyframe", "motion", "image-to-video", "ugc", "analysis"), "cloud", "Authenticated higgsfield CLI session", "paid", ("network", "filesystem", "spend"), "higgsfield-cloud"),
    Provider("postiz", ("publish", "schedule"), "local", "POSTIZ_URL + POSTIZ_API_KEY + platform integration IDs", "self-hosted/BYOK", ("network", "publish"), "upload-post"),
    Provider("upload-post", ("publish", "schedule"), "cloud", "UPLOAD_POST_API_KEY + UPLOAD_POST_USERNAME", "paid", ("network", "publish"), "postiz"),
)


def providers_for(role: str) -> list[Provider]:
    return [provider for provider in PROVIDER_MATRIX if role in provider.roles]


def _http_reachable(url: str, headers: dict[str, str] | None = None) -> bool:
    request = urllib.request.Request(url, method="GET", headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=1.5) as response:
            return response.status < 500
    except urllib.error.HTTPError as exc:
        return exc.code < 500
    except (OSError, urllib.error.URLError):
        return False


def readiness(provider: Provider, cfg: StudioConfig | None = None) -> dict:
    cfg = cfg or load_config()
    available = False
    detail = provider.requirement
    if provider.id == "palmier-pro":
        available = _http_reachable(cfg.palmier_mcp_url)
        detail = f"MCP endpoint {'answered' if available else 'not running'} at {cfg.palmier_mcp_url}"
    elif provider.id == "clueso-mcp":
        available = False
        detail = "Agent-scoped provider: verify authenticated Clueso MCP tools in the active agent runtime before selecting it"
    elif provider.id == "media-studio-mcp":
        from .media_studio import media_studio_status

        status = media_studio_status()
        available = bool(status["configured"] and status["auth_present"] and status["reachable"])
        detail = status["detail"]
    elif provider.id == "universal-tts":
        available = _http_reachable(f"{cfg.universal_tts_url}/health")
        detail = f"TTS health {'answered' if available else 'unavailable'} at {cfg.universal_tts_url}"
    elif provider.id in {"stickman-renderer", "static-text-renderer"}:
        available = True
        detail = "deterministic local renderer ready"
    elif provider.id == "moneyprinterturbo":
        available = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
        detail = "ffmpeg and ffprobe found" if available else "ffmpeg/ffprobe missing"
    elif provider.id == "auto-clipper":
        available = bool(shutil.which("ffmpeg") and shutil.which("yt-dlp"))
        detail = "ffmpeg and yt-dlp found" if available else "ffmpeg or yt-dlp missing"
    elif provider.id == "ace-step":
        available = bool(os.environ.get("ACE_STEP_API_BASE_URL") or shutil.which("ace-step"))
    elif provider.id == "pexels":
        available = bool(os.environ.get("PEXELS_API_KEY") or os.environ.get("PEXELS_API_KEYS"))
    elif provider.id == "pixabay":
        available = bool(os.environ.get("PIXABAY_API_KEY") or os.environ.get("PIXABAY_API_KEYS"))
    elif provider.id == "hivemindos-hosted-media":
        from .hivemindos_hosted_media import hosted_media_status

        status = hosted_media_status()
        available = bool(status["configured"] and status["reachable"])
        detail = f"{status['detail']}; provider keys are not required" if available else status["detail"]
    elif provider.id == "openai-gpt-image":
        available = bool(os.environ.get("OPENAI_API_KEY"))
        detail = "OPENAI_API_KEY is available for the official GPT Image API" if available else "OPENAI_API_KEY is missing; use the separate GPT Image OAuth provider if ChatGPT/Codex is connected"
    elif provider.id == "openai-gpt-image-oauth":
        from .hivemindos_oauth import oauth_provider_status

        status = oauth_provider_status("openai")
        available = bool(status.get("usable"))
        detail = str(status.get("detail") or "OpenAI OAuth is unavailable")
    elif provider.id == "xai-imagine-api":
        available = bool(os.environ.get("XAI_API_KEY"))
        detail = "XAI_API_KEY is available for Grok Imagine image and video" if available else "XAI_API_KEY is missing"
    elif provider.id == "xai-imagine-oauth":
        from .hivemindos_oauth import oauth_provider_status

        status = oauth_provider_status("xai")
        available = bool(status.get("usable"))
        detail = str(status.get("detail") or "xAI OAuth is unavailable")
    elif provider.id == "muapi":
        available = bool(os.environ.get("MUAPI_API_KEY") or os.environ.get("MUAPI_KEY"))
    elif provider.id == "higgsfield-cloud":
        available = bool(os.environ.get("HIGGSFIELD_API_KEY_ID") and os.environ.get("HIGGSFIELD_API_KEY_SECRET"))
    elif provider.id == "higgsfield-consumer":
        executable = shutil.which("higgsfield")
        if not executable:
            available = False
            detail = "higgsfield CLI missing"
        else:
            try:
                status = subprocess.run([executable, "account", "status"], text=True, capture_output=True, timeout=8, check=False)
                available = status.returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                available = False
            detail = "higgsfield consumer session authenticated" if available else "higgsfield CLI found but its consumer session is not authenticated"
    elif provider.id == "elevenlabs":
        available = bool(os.environ.get("ELEVENLABS_API_KEY"))
    elif provider.id == "postiz":
        available = bool(cfg.postiz_url and cfg.postiz_api_key)
    elif provider.id == "upload-post":
        available = bool(cfg.upload_post_api_key and cfg.upload_post_username)
    elif provider.id == "openai-compatible":
        available = bool(os.environ.get("OPENAI_BASE_URL") and os.environ.get("OPENAI_API_KEY"))
    elif provider.id == "agent-runtime":
        available = True
        detail = "Any agent may attach a script; execution is limited to operator-registered CONTENT_STUDIO_RUNTIME_<ID>_COMMAND entries"
    elif provider.mode == "manual":
        available = True
    return {**asdict(provider), "roles": list(provider.roles), "side_effects": list(provider.side_effects), "available": available, "detail": detail}


def provider_report(cfg: StudioConfig | None = None) -> list[dict]:
    return [readiness(provider, cfg) for provider in PROVIDER_MATRIX]
