"""Canonical, secret-free-at-rest studio configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .shared_env import apply_shared_hive_env


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PALMIER_MCP_URL = "http://127.0.0.1:19789/mcp"
DEFAULT_UNIVERSAL_TTS_URL = "http://127.0.0.1:8799"


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class StudioConfig:
    project_root: Path
    data_dir: Path
    runs_dir: Path
    palmier_mcp_url: str
    universal_tts_url: str
    postiz_url: str
    postiz_api_key: str | None
    upload_post_api_url: str
    upload_post_api_key: str | None
    upload_post_username: str | None
    live_publish_enabled: bool


def load_config() -> StudioConfig:
    apply_shared_hive_env()
    project_root = Path(os.environ.get("CONTENT_STUDIO_ROOT", PROJECT_ROOT)).expanduser().resolve()
    data_dir = Path(os.environ.get("CONTENT_STUDIO_DATA_DIR", project_root / "data")).expanduser().resolve()
    return StudioConfig(
        project_root=project_root,
        data_dir=data_dir,
        runs_dir=Path(os.environ.get("CONTENT_STUDIO_RUNS_DIR", data_dir / "runs")).expanduser().resolve(),
        palmier_mcp_url=os.environ.get("PALMIER_MCP_URL", DEFAULT_PALMIER_MCP_URL).rstrip("/"),
        universal_tts_url=os.environ.get("UNIVERSAL_TTS_URL", DEFAULT_UNIVERSAL_TTS_URL).rstrip("/"),
        postiz_url=os.environ.get("POSTIZ_URL", "http://127.0.0.1:4007/api").rstrip("/"),
        postiz_api_key=os.environ.get("POSTIZ_API_KEY"),
        upload_post_api_url=os.environ.get("UPLOAD_POST_API_URL", "https://api.upload-post.com/api/upload").rstrip("/"),
        upload_post_api_key=os.environ.get("UPLOAD_POST_API_KEY"),
        upload_post_username=os.environ.get("UPLOAD_POST_USERNAME"),
        live_publish_enabled=env_bool("CONTENT_STUDIO_ENABLE_LIVE_PUBLISH", False),
    )
