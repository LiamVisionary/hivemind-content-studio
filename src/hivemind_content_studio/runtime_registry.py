"""Operator-configured allowlist of agent runtimes."""

from __future__ import annotations

import os
import re
import shlex
from dataclasses import asdict, dataclass


PREFIX = "CONTENT_STUDIO_RUNTIME_"
SUFFIX = "_COMMAND"


@dataclass(frozen=True)
class RuntimeSpec:
    id: str
    command: tuple[str, ...]
    source: str = "environment"


class RuntimeRegistry:
    def __init__(self, runtimes: list[RuntimeSpec] | tuple[RuntimeSpec, ...]):
        self._runtimes = {runtime.id: runtime for runtime in runtimes}

    @classmethod
    def from_environment(cls) -> "RuntimeRegistry":
        runtimes: list[RuntimeSpec] = []
        for key, value in os.environ.items():
            if not key.startswith(PREFIX) or not key.endswith(SUFFIX) or not value.strip():
                continue
            raw_id = key[len(PREFIX) : -len(SUFFIX)].lower().replace("_", "-")
            runtime_id = re.sub(r"[^a-z0-9-]+", "-", raw_id).strip("-")
            command = tuple(shlex.split(value))
            if runtime_id and command:
                runtimes.append(RuntimeSpec(id=runtime_id, command=command))
        return cls(runtimes)

    def get(self, runtime_id: str) -> RuntimeSpec:
        normalized = runtime_id.strip().lower()
        runtime = self._runtimes.get(normalized)
        if not runtime:
            raise ValueError(f"Agent runtime '{normalized}' is not registered by the operator")
        return runtime

    def list(self) -> list[dict]:
        return [asdict(runtime) | {"command": [runtime.command[0], "<operator-configured-args>"]} for runtime in sorted(self._runtimes.values(), key=lambda item: item.id)]
