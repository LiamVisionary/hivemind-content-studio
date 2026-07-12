"""Configuration loading.

Adapted from MaximSinyaev/obsidian-trading-tracker's cwd/home TOML config
lookup, with environment overrides added for Hermes jobs.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

CONFIG_FILENAME = ".auto-clipper.toml"
DEFAULT_VAULT = Path.home() / "Documents" / "Obsidian" / "hivemindos-vault"


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Config:
    project_root: Path
    data_dir: Path
    db_path: Path
    vault_path: Path
    obsidian_folder: str
    timezone: str
    podcli_bin: str
    podcli_command_template: str
    postiz_url: str
    postiz_api_key: str | None
    postiz_enable_write: bool

    @property
    def obsidian_output_dir(self) -> Path:
        return self.vault_path / self.obsidian_folder


def find_config(start: Path | None = None) -> Path | None:
    """Search for a project config in cwd, then the home directory."""
    root = start or Path.cwd()
    candidates = [root / CONFIG_FILENAME, Path.home() / CONFIG_FILENAME]
    for path in candidates:
        if path.is_file():
            return path
    return None


def load_config(path: Path | None = None) -> Config:
    _load_env_file(Path.cwd() / ".env")
    raw: dict = {}
    if path is None:
        path = find_config()
    if path is not None and path.is_file():
        with path.open("rb") as handle:
            raw = tomllib.load(handle)

    project_root = Path(raw.get("project_root") or Path.cwd()).expanduser().resolve()
    data_dir = Path(os.environ.get("AUTO_CLIPPER_DATA_DIR") or raw.get("data_dir") or project_root / "data")
    if not data_dir.is_absolute():
        data_dir = project_root / data_dir
    db_path = Path(os.environ.get("AUTO_CLIPPER_DB") or raw.get("db_path") or data_dir / "auto_clipper.sqlite3")
    if not db_path.is_absolute():
        db_path = project_root / db_path

    vault_raw = os.environ.get("OBSIDIAN_VAULT_PATH") or raw.get("vault_path") or DEFAULT_VAULT
    vault_path = Path(vault_raw).expanduser()
    obsidian_folder = os.environ.get("AUTO_CLIPPER_OBSIDIAN_FOLDER") or raw.get(
        "obsidian_folder", "Notes/Podcast Clips"
    )

    return Config(
        project_root=project_root,
        data_dir=data_dir.expanduser(),
        db_path=db_path.expanduser(),
        vault_path=vault_path,
        obsidian_folder=obsidian_folder,
        timezone=os.environ.get("AUTO_CLIPPER_TIMEZONE") or raw.get("timezone", "Asia/Makassar"),
        podcli_bin=os.environ.get("PODCLI_BIN") or raw.get("podcli_bin", str(project_root / "vendor/podcli/podcli")),
        podcli_command_template=os.environ.get("AUTO_CLIPPER_PODCLI_COMMAND")
        or raw.get(
            "podcli_command_template",
            "{podcli} process {input} {transcript_arg} --top {top} --caption-style {style} --output {output_dir}",
        ),
        postiz_url=(os.environ.get("POSTIZ_URL") or raw.get("postiz_url", "http://localhost:4007/api")).rstrip("/"),
        postiz_api_key=os.environ.get("POSTIZ_API_KEY") or raw.get("postiz_api_key"),
        postiz_enable_write=_bool_env("CONTENT_STUDIO_ENABLE_LIVE_PUBLISH", False),
    )


def _load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value
