"""Canonical, secret-free-at-rest studio configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .shared_env import apply_shared_hive_env


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PALMIER_MCP_URL = "http://127.0.0.1:19789/mcp"
DEFAULT_UNIVERSAL_TTS_URL = "http://127.0.0.1:8799"
DEFAULT_MEDIA_STATE_ROOT = Path("~/.hivemindos/media-studio")


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class AppDirs:
    """The four places this app is allowed to write.

    One resolver so the launchd stack, the CLI and a packaged sidecar all agree
    on "where state lives" instead of each deriving it from its own idea of the
    install tree. Resources (templates, example config) stay read-only next to
    the code; nothing here points back into it unless this is a git checkout.
    """

    config_dir: Path
    data_dir: Path
    cache_dir: Path
    logs_dir: Path

    def ensure(self) -> "AppDirs":
        for path in (self.config_dir, self.data_dir, self.cache_dir, self.logs_dir):
            path.mkdir(parents=True, exist_ok=True)
        return self


def media_state_root() -> Path:
    """The HivemindOS media-studio root every other module already uses."""
    raw = os.environ.get("HIVEMIND_MEDIA_STATE_DIR") or str(DEFAULT_MEDIA_STATE_ROOT)
    return Path(raw).expanduser().resolve()


def _is_checkout(project_root: Path) -> bool:
    # A worktree's .git is a file, not a directory.
    return (project_root / ".git").exists()


def _migrate_repo_data_dir(legacy: Path, destination: Path) -> None:
    """Move a pre-existing ``<repo>/data`` into the resolved data dir, once.

    Same shape as account_scope.migrate_legacy_state: MOVE rather than copy (a
    copy would leave a second readable original of private state), skip when
    the destination already holds something, and stay silent when there is
    nothing to move so this is safe on every boot.
    """
    if legacy == destination or not legacy.is_dir():
        return
    try:
        if destination.is_dir() and any(destination.iterdir()):
            return
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_dir():
            destination.rmdir()
        legacy.rename(destination)
    except OSError:
        # A cross-device rename or a locked file: keep booting on the legacy
        # path rather than failing to start over a housekeeping move.
        pass


DATA_FORMAT = 1


class DataFormatTooNew(RuntimeError):
    """The data dir was written by a newer build than this one."""


def ensure_data_format(data_dir: Path, *, format_version: int = DATA_FORMAT) -> int:
    """Stamp ``<data_dir>/FORMAT`` on first boot; refuse a newer one.

    An auto-update followed by a downgrade would otherwise open newer stores
    blind. The marker is one integer, and the refusal is a sentence a person can
    act on rather than a traceback out of sqlite three screens later.
    """
    marker = Path(data_dir) / "FORMAT"
    try:
        found = int(marker.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        found = 0
    if found > format_version:
        raise DataFormatTooNew(
            f"This studio folder was written by a newer version of the app (format {found}; "
            f"this build reads {format_version}). Update the app, or point "
            "CONTENT_STUDIO_DATA_DIR at a different folder."
        )
    if found != format_version:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(f"{format_version}\n", encoding="utf-8")
    return format_version


def app_dirs(project_root: Path | None = None) -> AppDirs:
    """Resolve config/data/cache/logs for this install.

    ``CONTENT_STUDIO_DATA_DIR`` wins. Otherwise a git checkout keeps its state
    beside the code (``<repo>/data``, what every existing machine has), and a
    packaged build — which has no writable tree — puts it under
    ``$HIVEMIND_MEDIA_STATE_DIR/content-studio``.
    """
    root = project_root or Path(os.environ.get("CONTENT_STUDIO_ROOT", PROJECT_ROOT)).expanduser().resolve()
    configured = os.environ.get("CONTENT_STUDIO_DATA_DIR")
    if configured:
        data_dir = Path(configured).expanduser().resolve()
    elif _is_checkout(root):
        data_dir = (root / "data").resolve()
    else:
        data_dir = media_state_root() / "content-studio"
        _migrate_repo_data_dir((root / "data").resolve(), data_dir)
    return AppDirs(
        config_dir=data_dir / "config",
        data_dir=data_dir,
        cache_dir=data_dir / "cache",
        logs_dir=data_dir / "logs",
    )


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
    data_dir = app_dirs(project_root).data_dir
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
