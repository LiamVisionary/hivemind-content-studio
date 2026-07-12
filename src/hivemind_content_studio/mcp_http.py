"""Small MCP Streamable HTTP client for local creative tools such as Palmier Pro."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any


PROTOCOL_VERSION = "2025-06-18"


class McpError(RuntimeError):
    """Sanitized MCP transport or protocol failure."""


@dataclass
class McpHttpClient:
    endpoint: str
    headers: dict[str, str] = field(default_factory=dict)
    session_id: str | None = None
    request_id: int = field(default=0, init=False)
    initialized: bool = field(default=False, init=False)

    def initialize(self) -> dict[str, Any]:
        if self.initialized:
            return {}
        result = self._rpc(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "hivemind-content-studio", "version": "0.1.0"},
            },
        )
        self._notify("notifications/initialized", {})
        self.initialized = True
        return result

    def list_tools(self) -> list[dict[str, Any]]:
        self.initialize()
        result = self._rpc("tools/list", {})
        tools = result.get("tools", [])
        if not isinstance(tools, list):
            raise McpError("MCP tools/list returned an invalid tools field")
        return tools

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        return self._rpc("tools/call", {"name": name, "arguments": arguments})

    def _rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.request_id += 1
        payload = {"jsonrpc": "2.0", "id": self.request_id, "method": method, "params": params}
        response = self._post(payload)
        if "error" in response:
            error = response.get("error") or {}
            raise McpError(f"MCP {method} failed: {error.get('message', 'unknown protocol error')}")
        result = response.get("result", {})
        if not isinstance(result, dict):
            raise McpError(f"MCP {method} returned an invalid result")
        return result

    def _notify(self, method: str, params: dict[str, Any]) -> None:
        self._post({"jsonrpc": "2.0", "method": method, "params": params}, expect_body=False)

    def _post(self, payload: dict[str, Any], *, expect_body: bool = True) -> dict[str, Any]:
        headers = {
            **self.headers,
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": PROTOCOL_VERSION,
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        request = urllib.request.Request(self.endpoint, data=json.dumps(payload).encode("utf-8"), method="POST", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                session = response.headers.get("Mcp-Session-Id")
                if session:
                    self.session_id = session
                raw = response.read().decode("utf-8", errors="replace")
                content_type = response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as exc:
            raise McpError(f"MCP HTTP {exc.code}") from None
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", exc).__class__.__name__
            raise McpError(f"MCP connection failed ({reason})") from None
        if not expect_body or not raw.strip():
            return {}
        if "text/event-stream" in content_type or raw.lstrip().startswith("data:"):
            return _parse_sse(raw)
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            raise McpError("MCP response was not valid JSON or SSE") from None
        if not isinstance(parsed, dict):
            raise McpError("MCP response must be a JSON object")
        return parsed


def _parse_sse(raw: str) -> dict[str, Any]:
    for line in reversed(raw.splitlines()):
        if not line.startswith("data:"):
            continue
        value = line[5:].strip()
        if value == "[DONE]":
            continue
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise McpError("MCP SSE response did not contain a JSON-RPC event")
