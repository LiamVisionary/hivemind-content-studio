from __future__ import annotations

import json
import threading
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from hivemind_content_studio.mcp_http import McpHttpClient


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:  # noqa: N802
        size = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(size))
        method = payload["method"]
        if method == "notifications/initialized":
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if method == "initialize":
            result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "fake-palmier", "version": "1"}}
        elif method == "tools/list":
            result = {"tools": [{"name": "create_project", "inputSchema": {"type": "object"}}]}
        else:
            result = {"content": [{"type": "text", "text": "ok"}], "isError": False}
        body = json.dumps({"jsonrpc": "2.0", "id": payload["id"], "result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Mcp-Session-Id", "session-1")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:
        pass


def test_streamable_http_initialize_list_and_call() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = McpHttpClient(f"http://127.0.0.1:{server.server_port}/mcp")
        assert client.list_tools()[0]["name"] == "create_project"
        assert client.session_id == "session-1"
        assert client.call_tool("create_project", {"name": "demo"})["isError"] is False
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_waiting_tool_uses_declared_timeout_plus_transport_margin() -> None:
    client = McpHttpClient("http://127.0.0.1:1/mcp")
    client.initialized = True
    with patch.object(client, "_rpc", return_value={}) as rpc:
        client.call_tool("media_generate_image", {"wait": True, "timeout_s": 300})

    assert rpc.call_args.kwargs["timeout"] == 330.0
