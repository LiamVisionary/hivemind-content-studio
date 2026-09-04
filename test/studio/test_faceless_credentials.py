"""The faceless lane reads the machine's ONE credential store.

The embedded MoneyPrinterTurbo engine keeps its own `config.toml` with its own
`pexels_api_keys` / `pixabay_api_keys` / LLM-key fields, and it reads that file
once, at import. A key is normally saved while the studio is already running —
from its own Settings page, into the shared store this machine already has — so
without a re-read at run start the engine keeps the empty fields it booted with
and refuses the render with "pexels_api_keys is not set ... set it in the
config.toml file", sending the owner to fill in a second credential store for a
key the first one is holding.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hivemind_content_studio import faceless


@pytest.fixture
def engine_config():
    """The live engine config, restored afterwards.

    `refresh_hive_env` mutates process-global state on purpose (that is the
    whole point), so each test puts back what it found.
    """
    from app.config import config

    before = {
        "app": dict(config.app),
        "azure": dict(config.azure),
        "siliconflow": dict(config.siliconflow),
        "elevenlabs": dict(config.elevenlabs),
    }
    try:
        yield config
    finally:
        for name, values in before.items():
            section = getattr(config, name)
            section.clear()
            section.update(values)


def _store(tmp_path: Path, body: str) -> Path:
    env_file = tmp_path / "shared.env"
    env_file.write_text(body, encoding="utf-8")
    return env_file


def test_a_stock_media_key_saved_after_boot_reaches_the_engine(
    tmp_path: Path, monkeypatch, engine_config
) -> None:
    engine_config.app["pexels_api_keys"] = []
    engine_config.app["pixabay_api_keys"] = []

    monkeypatch.setenv(
        "HIVE_ENV_FILES",
        str(_store(tmp_path, "PEXELS_API_KEY=pexels-test-value\nPIXABAY_API_KEY=pixabay-test-value\n")),
    )
    # The engine reads the keys through config.app at call time, so a refresh is
    # all that stands between a saved key and a working render.
    changed = engine_config.refresh_hive_env()

    assert "app" in changed
    assert engine_config.app["pexels_api_keys"] == ["pexels-test-value"]
    assert engine_config.app["pixabay_api_keys"] == ["pixabay-test-value"]


def test_a_render_refreshes_the_engine_credentials_before_it_starts(
    tmp_path: Path, monkeypatch, engine_config
) -> None:
    """The refresh is wired into the render, not just available to it."""
    engine_config.app["pexels_api_keys"] = []
    monkeypatch.setenv("HIVE_ENV_FILES", str(_store(tmp_path, "PEXELS_API_KEY=pexels-test-value\n")))

    faceless._refresh_engine_credentials()

    assert engine_config.app["pexels_api_keys"] == ["pexels-test-value"]


def test_the_refresh_reports_no_change_when_the_store_holds_nothing_new(
    tmp_path: Path, monkeypatch, engine_config
) -> None:
    """An empty store is not an instruction to blank the engine's own settings."""
    engine_config.app["pexels_api_keys"] = ["already-here"]
    monkeypatch.setenv("HIVE_ENV_FILES", str(tmp_path / "no-such.env"))

    assert engine_config.refresh_hive_env() == []
    assert engine_config.app["pexels_api_keys"] == ["already-here"]


def test_the_refresh_never_returns_a_value(tmp_path: Path, monkeypatch, engine_config) -> None:
    """It answers with section NAMES. A secret must not travel in a return value,
    a log line, or an error the studio would go on to show someone."""
    monkeypatch.setenv("HIVE_ENV_FILES", str(_store(tmp_path, "ELEVENLABS_API_KEY=eleven-test-value\n")))

    changed = engine_config.refresh_hive_env()

    assert all(isinstance(name, str) for name in changed)
    assert "eleven-test-value" not in str(changed)
    assert engine_config.elevenlabs["api_key"] == "eleven-test-value"
