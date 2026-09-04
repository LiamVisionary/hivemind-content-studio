"""What the supervisor must say when a health gate fails, as an executable spec.

On 2026-09-04 the stack boot-looped for an hour and every cycle logged exactly
one line: "Z-Image frontend did not become healthy in time". The frontend was
fine. It bound its port and logged "listening" on all 29 attempts, and a
hand-run `curl -fsS --max-time 5 http://127.0.0.1:8788/healthz` answered 200 in
0.02s within about four seconds of each child starting. The message was
byte-identical whether the server never bound, bound and answered, or the
supervisor's own curl could not be executed — three different bugs, one string.

So the gates are exercised here for real: the wait_http block is lifted out of
scripts/hivemind-studio-stack and pointed at ports in the 19000s. Nothing in
this file touches the running stack.

The second half of that incident was an agent's `pkill -f "hosted-server.js"`
matching the owner's live child, because hosted-server.js is one of the three
surfaces the supervisor's Node process loads. The last test keeps name-pattern
reaping out of the tree.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import textwrap
from contextlib import closing
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
STACK = ROOT / "scripts/hivemind-studio-stack"
RUNTIME_MANIFEST = ROOT / "packages/media-gateway/studio.runtime.json"

# The banner the wait_http block opens with and the comment that follows it.
# Lifting between the two is what lets these tests run the real function
# instead of a copy that can drift away from it.
_BLOCK_START = "# ── Health gates that say what actually failed"
_BLOCK_END = "# tailscale_ip() lived here"


def _wait_http_block() -> str:
    lines = STACK.read_text(encoding="utf-8").splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(_BLOCK_START))
    end = next(i for i, line in enumerate(lines) if line.startswith(_BLOCK_END))
    return "\n".join(lines[start:end])


def _free_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _run_gate(body: str, *, path: str | None = None) -> str:
    """Run a snippet with the real wait_http in scope and return its output.

    `body` is expected to end in a `gate` call; `gate` prints exactly the line
    the supervisor logs when a health gate gives up.
    """
    script = f"""
    set -u
    {_wait_http_block()}

    gate() {{  # gate <label> <url> <budget> [pid]
      local label="$1" url="$2" budget="$3" pid="${{4:-}}"
      if ! wait_http "$url" "$budget"; then
        printf '%s did not become healthy in time; %s\\n' "$label" "$(wait_http_why "$pid")"
      else
        printf '%s healthy; last probe: %s\\n' "$label" "$(wait_http_reason)"
      fi
    }}

    {textwrap.dedent(body)}
    """
    env = dict(os.environ)
    if path is not None:
        env["PATH"] = path
    done = subprocess.run(  # noqa: S603 - a bash snippet this file wrote
        ["/bin/bash", "-c", script],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )
    return done.stdout.strip()


@pytest.fixture()
def slow_server():
    """A loopback server whose behaviour the test chooses, on a 19000s port.

    Yields a factory taking the status it should answer with (or a warm-up:
    503 until `warm_after` seconds have passed, then 200).
    """
    started: list[subprocess.Popen] = []

    def start(status: int = 200, warm_after: float = 0.0) -> tuple[int, subprocess.Popen]:
        port = _free_port()
        source = textwrap.dedent(
            f"""
            import http.server, time
            START = time.time()
            class H(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    warming = time.time() - START < {warm_after!r}
                    code = 503 if warming else {status!r}
                    body = b'ok' if code < 400 else b''
                    self.send_response(code)
                    self.send_header('content-length', str(len(body)))
                    self.end_headers()
                    if body:
                        self.wfile.write(body)
                def log_message(self, *a):
                    pass
            http.server.HTTPServer(('127.0.0.1', {port!r}), H).serve_forever()
            """
        )
        proc = subprocess.Popen(  # noqa: S603 - loopback, source written here
            ["python3", "-c", source],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        started.append(proc)
        deadline = 5.0
        step = 0.05
        waited = 0.0
        while waited < deadline:
            with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as probe:
                if probe.connect_ex(("127.0.0.1", port)) == 0:
                    break
            import time as _time

            _time.sleep(step)
            waited += step
        return port, proc

    yield start

    for proc in started:
        # The recorded pid, never a name pattern. See the module docstring.
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


# ── (1) the last probe's verdict ─────────────────────────────────────────────


def test_a_refused_connection_is_named_as_one() -> None:
    """Nothing bound: the report has to say so, not "did not become healthy"."""
    port = _free_port()
    line = _run_gate(f'gate "node services" "http://127.0.0.1:{port}/healthz" 2')

    assert "did not become healthy in time" in line
    assert "connection refused" in line
    assert f"nothing listening on :{port}" in line


def test_an_http_status_the_gate_rejects_is_reported_as_that_status(slow_server) -> None:
    """"…; last probe: HTTP 503" is a different bug report from "refused"."""
    port, proc = slow_server(status=500)
    pid = proc.pid
    line = _run_gate(f'gate "node services" "http://127.0.0.1:{port}/healthz" 2 {pid}')

    assert "HTTP 500" in line
    # And it says the port IS held, which is the half that told today's
    # incident apart: a listener that answers is not a listener that never came.
    assert f":{port} held by pid(s)" in line
    assert f"child pid={pid} still alive" in line


def test_curl_that_cannot_be_executed_is_not_reported_as_a_dead_child() -> None:
    """Exit 127 is the supervisor's own PATH, not the child's fault at all."""
    port = _free_port()
    line = _run_gate(
        f'gate "node services" "http://127.0.0.1:{port}/healthz" 4',
        path="/nonexistent",
    )

    assert "curl exited 127" in line
    assert "check PATH" in line
    # It must not claim the port is free when it had no way to look.
    assert "nothing listening" not in line


def test_a_server_that_is_still_warming_is_waited_for_and_then_passes(slow_server) -> None:
    """A gate whose budget covers the warm-up returns healthy, not a status."""
    port, _proc = slow_server(status=200, warm_after=3.0)
    line = _run_gate(f'gate "node services" "http://127.0.0.1:{port}/healthz" 30')

    assert "healthy; last probe: HTTP 200" in line


# ── (2) the port and the child ───────────────────────────────────────────────


def test_a_child_that_died_is_reported_as_gone(slow_server) -> None:
    """The common case, and the old log never said it."""
    port, proc = slow_server(status=200)
    pid = proc.pid
    # Stop the recorded pid and reap it, which is what bash does for its own
    # background jobs — an unreaped zombie still answers `kill -0`.
    proc.terminate()
    proc.wait(timeout=5)
    line = _run_gate(f'gate "node services" "http://127.0.0.1:{port}/healthz" 2 {pid}')

    assert "connection refused" in line
    assert f"nothing listening on :{port}" in line
    assert f"child pid={pid} is gone" in line


def test_every_boot_gate_logs_the_diagnosis() -> None:
    """No "did not become healthy" line may be left without its cause."""
    lines = STACK.read_text(encoding="utf-8").splitlines()
    logged = [
        line
        for line in lines
        if "did not become healthy in time" in line and line.lstrip().startswith("log ")
    ]
    assert logged, "the supervisor still gates on health"
    for line in logged:
        assert "wait_http_why" in line, line


# ── (3) the budget ───────────────────────────────────────────────────────────


def test_the_node_services_gate_is_wider_than_it_was_and_says_why() -> None:
    """45s was the gate that boot-looped. Widening it silently would be worse
    than leaving it, so the constant carries its reasoning."""
    stack = STACK.read_text(encoding="utf-8")
    match = re.search(r"NODE_SERVICES_TIMEOUT=\"\$\{HIVEMIND_NODE_SERVICES_TIMEOUT:-(\d+)\}\"", stack)
    assert match, "the Node services gate has a named, overridable budget"
    assert int(match.group(1)) >= 90

    preamble = stack[: match.start()].splitlines()[-10:]
    assert any("45" in line for line in preamble), preamble
    assert any("ComfyUI" in line for line in preamble), preamble

    assert '"$NODE_SERVICES_TIMEOUT"' in stack, "and the gate actually uses it"


# ── (4) no reaping by name ───────────────────────────────────────────────────

# Where a stray `pkill -f` would do the most damage, and the extensions worth
# scanning. node_modules and .git are somebody else's code.
_SCANNED_DIRS = ("scripts", "src", "packages", "desktop", "test", "bin")
_SCANNED_SUFFIXES = (".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".rs", ".json", ".plist", "")
_SKIPPED_DIRS = {"node_modules", ".git", "dist", "build", "target", ".venv", "__pycache__"}


def _code_only(line: str) -> str:
    """The line with any trailing comment removed.

    A comment that WARNS about `pkill` is the opposite of the problem, and the
    supervisor carries one; scanning raw text would make writing the warning
    impossible.
    """
    for marker in ("#", "//"):
        index = line.find(marker)
        if index != -1:
            line = line[:index]
    return line


def _scannable_files():
    for name in _SCANNED_DIRS:
        base = ROOT / name
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if not path.is_file():
                continue
            if _SKIPPED_DIRS & set(path.relative_to(ROOT).parts):
                continue
            if path.suffix not in _SCANNED_SUFFIXES:
                continue
            yield path


def test_nothing_in_the_tree_reaps_processes_by_name() -> None:
    """The other half of the 2026-09-04 incident.

    An agent cleaning up its own test servers ran `pkill -f "hosted-server.js"`
    and it matched the owner's running child, because hosted-server.js is one
    of the three surfaces the supervisor's Node process loads. A name pattern
    cannot tell a test server from a supervised one. Every stop in this repo
    goes through a pid that was written down, or through kill_port, which asks
    lsof who holds one of OUR ports.
    """
    offenders = []
    for path in _scannable_files():
        if path == Path(__file__):
            # This file names the pattern in order to forbid it.
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            if re.search(r"\bpkill\b|\bkillall\b", _code_only(line)):
                offenders.append(f"{path.relative_to(ROOT)}:{number}: {line.strip()}")
    assert not offenders, "reap a recorded pid, never a name pattern:\n" + "\n".join(offenders)


def test_the_supervisor_stops_only_pids_it_recorded() -> None:
    stack = STACK.read_text(encoding="utf-8")
    stop = stack[stack.index("stop_children() {") :]
    stop = stop[: stop.index("\n}\n")]
    # Every kill in the stop path names a variable, and the only ports it
    # reaps are lanes this stack started itself.
    for line in stop.splitlines():
        if re.search(r"\bkill\b", line) and "kill_port" not in line:
            assert '"$pid"' in line, line
    assert "comfy_available" in stop, "and it leaves somebody else's ComfyUI alone"


# ── (5) the runtime manifest knows about the collapsed service ───────────────


def test_the_runtime_manifest_describes_the_one_node_service() -> None:
    manifest = json.loads(RUNTIME_MANIFEST.read_text(encoding="utf-8"))

    components = {component["id"]: component for component in manifest["components"]}
    node = components["node-services"]
    assert node["port"] == 8793
    assert node["healthUrl"] == "http://127.0.0.1:8793/healthz"
    assert set(node["legacyPorts"]) == {8788, 8794, 8796}
    assert set(node["mounts"]) == {"canvas", "bridge", "agent-mcp"}

    # The three surfaces point at the process that actually serves them.
    for surface in ("gateway", "mcp", "mobile"):
        assert components[surface]["servedBy"] == "node-services"

    assert manifest["entrypoints"]["nodeServices"] == "http://127.0.0.1:8793"
    assert manifest["entrypoints"]["nodeServicesHealth"] == "http://127.0.0.1:8793/healthz"

    # The Canvas entrypoint is a URL a BROWSER can open, and /canvas on the
    # shared port is not one: every page behind that mount emits absolute asset
    # URLs (/_next/…, /mobile/assets/…) and the mount rewrites paths inbound,
    # never bodies outbound, so the HTML would load and every asset in it would
    # 404. node-services.mjs redirects a navigation there to this port instead.
    assert manifest["entrypoints"]["canvas"] == "http://127.0.0.1:8788/"
    assert "/canvas mount is for API and proxy routes only" in manifest["note"]


def test_the_manifest_keeps_what_its_legacy_readers_read() -> None:
    """bin/image-gen-studio.mjs prints name and components.length; the MCP reads
    entrypoints. Teaching the manifest about 8793 must not move either."""
    manifest = json.loads(RUNTIME_MANIFEST.read_text(encoding="utf-8"))

    assert manifest["name"] == "Media Studio"
    assert isinstance(manifest["components"], list)
    for key, value in {
        "local": "http://127.0.0.1:8765",
        "backend": "http://127.0.0.1:8787",
        "mcp": "http://127.0.0.1:8796/mcp",
        "comfy": "http://127.0.0.1:8188",
        "mobile": "http://127.0.0.1:8788/mobile/",
    }.items():
        assert manifest["entrypoints"][key] == value

    legacy_ports = {component["id"]: component["port"] for component in manifest["components"]}
    assert legacy_ports["gateway"] == 8788
    assert legacy_ports["mcp"] == 8796
    assert legacy_ports["backend"] == 8787


def test_a_prose_entrypoint_is_never_used_as_a_public_studio_base() -> None:
    """`tailnetMcp` reads "configured by the local supervisor" — a note to a
    person. The MCP used to return it as studioBase, and then built every media
    URL on a sentence."""
    mcp = (ROOT / "packages/media-gateway/bin/media-studio-mcp.mjs").read_text(encoding="utf-8")
    body = mcp[mcp.index("function runtimePublicStudioBase()") :]
    body = body[: body.index("\n}\n")]
    assert "isHttpUrl(base)" in body

    node = shutil.which("node")
    if node is None:  # pragma: no cover - node is present in this repo's CI
        pytest.skip("node is not on PATH")
    probe = textwrap.dedent(
        """
        const isHttpUrl = (value) => {
          try {
            const parsed = new URL(value);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
          } catch { return false; }
        };
        process.stdout.write(String(isHttpUrl('configured by the local supervisor')));
        """
    )
    done = subprocess.run(  # noqa: S603 - a snippet this file wrote
        [node, "-e", probe], capture_output=True, text=True, timeout=30
    )
    assert done.stdout == "false"
