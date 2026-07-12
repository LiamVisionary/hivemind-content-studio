"""Durable job operations for providers with asynchronous APIs."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

from .generation import MUAPI_HELPER
from .manifest import utc_now


class MuapiJobClient:
    def __init__(
        self,
        *,
        state_path: str | Path,
        runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    ):
        self.state_path = Path(state_path).expanduser().resolve()
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.runner = runner

    def upload(self, source: str | Path) -> dict[str, Any]:
        result = self._run([sys.executable, str(MUAPI_HELPER), "--state", str(self.state_path), "upload", str(Path(source).expanduser().resolve())])
        if not isinstance(result, list) or not result or not isinstance(result[0], dict) or not result[0].get("url"):
            raise RuntimeError("MUAPI upload returned no media URL")
        return result[0]

    def status(self, request_id: str) -> dict[str, Any]:
        result = self._run([sys.executable, str(MUAPI_HELPER), "--state", str(self.state_path), "result", request_id, "--urls"])
        return result if isinstance(result, dict) else {"result": result}

    def wait(self, request_id: str) -> dict[str, Any]:
        result = self._run([sys.executable, str(MUAPI_HELPER), "--state", str(self.state_path), "result", request_id, "--wait", "--urls"])
        return result if isinstance(result, dict) else {"result": result}

    def cancel(self, request_id: str) -> dict[str, Any]:
        # The reviewed MUAPI contract currently has no general cancellation endpoint.
        # Record local cancellation intent so orchestration stops polling, while being
        # explicit that the upstream job may continue and incur its submitted cost.
        cancellation = {
            "request_id": request_id,
            "status": "cancellation-requested",
            "provider_cancel_supported": False,
            "requested_at": utc_now(),
        }
        path = self.state_path.with_name(self.state_path.stem + "-cancellations.jsonl")
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(cancellation, sort_keys=True) + "\n")
        return cancellation

    def _run(self, command: list[str]) -> Any:
        completed = self.runner(command, text=True, capture_output=True, timeout=1800, check=False)
        if completed.returncode != 0:
            raise RuntimeError(f"MUAPI job operation failed with exit code {completed.returncode}")
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError("MUAPI job operation returned non-JSON output") from exc
