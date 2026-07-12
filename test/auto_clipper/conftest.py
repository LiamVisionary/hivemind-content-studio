from __future__ import annotations

import os
from pathlib import Path

import pytest

from auto_clipper.config import Config
from auto_clipper.db import init_db


@pytest.fixture()
def cfg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    vault = tmp_path / "vault"
    vault.mkdir()
    data = tmp_path / "data"
    monkeypatch.setenv("AUTO_CLIPPER_DATA_DIR", str(data))
    monkeypatch.setenv("OBSIDIAN_VAULT_PATH", str(vault))
    monkeypatch.setenv("AUTO_CLIPPER_OBSIDIAN_FOLDER", "Notes/Podcast Clips")
    monkeypatch.setenv("CONTENT_STUDIO_ENABLE_LIVE_PUBLISH", "false")
    return Config(
        project_root=tmp_path,
        data_dir=data,
        db_path=data / "auto_clipper.sqlite3",
        vault_path=vault,
        obsidian_folder="Notes/Podcast Clips",
        timezone="Asia/Makassar",
        podcli_bin=str(tmp_path / "podcli"),
        podcli_command_template="{podcli} process {input} --top {top} --caption-style {style} --output {output_dir}",
        postiz_url="http://localhost:4007/api",
        postiz_api_key=None,
        postiz_enable_write=False,
    )


@pytest.fixture()
def conn(cfg: Config):
    return init_db(cfg.db_path)


@pytest.fixture(autouse=True)
def clean_fake_render(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("AUTO_CLIPPER_FAKE_RENDER", raising=False)
