"""Server-side shared Hive environment fallback without secret disclosure."""

from __future__ import annotations

import os
from collections.abc import Iterable, Mapping
from pathlib import Path


DEFAULT_HIVE_ENV_FILES = (Path("~/.hivemindos/.env"),)


def parse_env_file(env_file: str | Path) -> dict[str, str]:
    path = Path(env_file).expanduser()
    if not path.is_file():
        return {}
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        if key and value:
            values[key] = value
    return values


def configured_hive_env_files(environment: Mapping[str, str] | None = None) -> tuple[Path, ...]:
    source = environment or os.environ
    configured = source.get("HIVE_ENV_FILES", "")
    if configured:
        return tuple(Path(item).expanduser() for item in configured.split(os.pathsep) if item.strip())
    return tuple(path.expanduser() for path in DEFAULT_HIVE_ENV_FILES)


def load_shared_hive_env(
    *,
    env_files: Iterable[str | Path] | None = None,
    process_env: Mapping[str, str] | None = None,
) -> dict[str, str]:
    environment = process_env or os.environ
    values: dict[str, str] = {}
    for env_file in env_files or configured_hive_env_files(environment):
        values.update(parse_env_file(env_file))
    values.update({key: value for key, value in environment.items() if value})
    return values


def apply_shared_hive_env() -> set[str]:
    """Fill missing process variables from the shared env and return key names only."""

    shared_values: dict[str, str] = {}
    for env_file in configured_hive_env_files():
        shared_values.update(parse_env_file(env_file))
    loaded_keys: set[str] = set()
    for key, value in shared_values.items():
        if key not in os.environ and value:
            os.environ[key] = value
            loaded_keys.add(key)
    return loaded_keys
