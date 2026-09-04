"""Opening the studio on the owner's other devices — as an explicit choice.

The stack used to do this at boot, unasked: if a Tailscale address existed it
bound a hand-rolled Node HTTPS proxy to it, and when `tailscale cert` was not
available it generated a **self-signed** certificate with openssl so the proxy
had something to present. Two things were wrong with that. The proxy fronted the
Canvas port, which authenticated nothing, so every device on the tailnet could
queue ComfyUI graphs and read the library. And a self-signed certificate on a
tailnet address is a full-screen browser warning with no way to fix it from
inside the app — the exact "problem with no fix" this product does not ship.

Both are replaced by this module:

* `tailscale serve` does the publishing. It terminates TLS with a real
  Let's Encrypt certificate for the machine's MagicDNS name, so there is no
  certificate to generate, no key on disk, and no warning to explain.
* It publishes **only** the control API's port. The Canvas port stays on
  loopback, where the account gate in `packages/media-gateway/lib/canvas-gate.js`
  is the second lock rather than the only one.
* Nothing happens until someone turns it on, and the answer says in plain words
  who can reach the URL once they have.

Every shell-out goes through the injected `run` seam so the decision table is
testable without a tailnet.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any, Callable

# Where the CLI actually lives. The App Store build hides it inside the bundle
# and never puts it on PATH, which is the common case on a Mac; PATH is checked
# too because Homebrew and the standalone package do use it.
_CLI_CANDIDATES = (
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
)

# The HTTPS port `tailscale serve` publishes on. Not 443: a machine that already
# publishes something else there (a dev server, another Hive app) would have its
# existing share silently replaced, and taking over a port the owner already
# spent is not this switch's business. Mirroring the studio's own port keeps the
# address memorable — same number, https instead of http.
DEFAULT_TAILNET_HTTPS_PORT = 8765

_TIMEOUT_SECONDS = 20


class RemoteAccessError(RuntimeError):
    """A failure with something the person reading it can do about it."""

    def __init__(self, message: str, remedy: str) -> None:
        super().__init__(message)
        self.message = message
        self.remedy = remedy


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


def _run(argv: list[str]) -> CommandResult:
    completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
        argv,
        capture_output=True,
        text=True,
        timeout=_TIMEOUT_SECONDS,
        check=False,
    )
    return CommandResult(completed.returncode, completed.stdout or "", completed.stderr or "")


def tailscale_cli() -> str:
    """The Tailscale CLI on this machine, or '' when it is not installed."""
    override = (os.environ.get("TAILSCALE_CLI") or "").strip()
    if override:
        return override if os.path.exists(override) else ""
    for candidate in _CLI_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    return shutil.which("tailscale") or ""


def studio_port() -> int:
    try:
        return int(os.environ.get("CONTENT_STUDIO_CONTROL_PORT", "8765"))
    except ValueError:
        return 8765


def tailnet_https_port() -> int:
    try:
        return int(os.environ.get("CONTENT_STUDIO_TAILNET_PORT", str(DEFAULT_TAILNET_HTTPS_PORT)))
    except ValueError:
        return DEFAULT_TAILNET_HTTPS_PORT


def _json_or_none(text: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(text or "")
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _tailnet_identity(cli: str, run: Callable[[list[str]], CommandResult]) -> dict[str, Any]:
    result = run([cli, "status", "--json"])
    payload = _json_or_none(result.stdout) or {}
    self_node = payload.get("Self") if isinstance(payload.get("Self"), dict) else {}
    tailnet = payload.get("CurrentTailnet") if isinstance(payload.get("CurrentTailnet"), dict) else {}
    peers = payload.get("Peer") if isinstance(payload.get("Peer"), dict) else {}
    return {
        "state": str(payload.get("BackendState") or ""),
        "dns_name": str(self_node.get("DNSName") or "").rstrip("."),
        "device": str(self_node.get("HostName") or ""),
        "tailnet": str(tailnet.get("Name") or ""),
        "device_count": len(peers) + (1 if self_node else 0),
    }


def _served_target(cli: str, run: Callable[[list[str]], CommandResult], host: str, https_port: int) -> str:
    """What `tailscale serve` currently proxies for our host:port, if anything."""
    result = run([cli, "serve", "status", "--json"])
    payload = _json_or_none(result.stdout) or {}
    web = payload.get("Web") if isinstance(payload.get("Web"), dict) else {}
    entry = web.get(f"{host}:{https_port}") if isinstance(web, dict) else None
    handlers = entry.get("Handlers") if isinstance(entry, dict) else None
    root = handlers.get("/") if isinstance(handlers, dict) else None
    return str(root.get("Proxy") or "") if isinstance(root, dict) else ""


def _audience(identity: dict[str, Any]) -> str:
    tailnet = identity.get("tailnet") or "your tailnet"
    count = int(identity.get("device_count") or 0)
    devices = f"all {count} devices" if count > 1 else "every device"
    return (
        f"Anyone signed in to the {tailnet} tailnet can open this URL — {devices} currently "
        "on it, plus any device shared into it. It is not on the public internet, and each "
        "person still has to sign in to a workspace."
    )


def remote_access_status(
    *,
    port: int | None = None,
    https_port: int | None = None,
    run: Callable[[list[str]], CommandResult] = _run,
) -> dict[str, Any]:
    """What the toggle should show, including what to do when it cannot work."""
    port = port or studio_port()
    https_port = https_port or tailnet_https_port()
    base = {
        "enabled": False,
        "supported": False,
        "url": "",
        "audience": "",
        "tailnet": "",
        "device": "",
        "https_port": https_port,
        "studio_port": port,
    }
    cli = tailscale_cli()
    if not cli:
        return {
            **base,
            "detail": "Tailscale is not installed on this Mac.",
            "remedy": "Install Tailscale and sign in, then turn this on. Nothing is published until you do.",
        }
    try:
        identity = _tailnet_identity(cli, run)
    except (OSError, subprocess.SubprocessError):
        return {
            **base,
            "detail": "Tailscale is installed but did not answer.",
            "remedy": "Open the Tailscale app and sign in, then try again.",
        }
    if identity["state"] != "Running" or not identity["dns_name"]:
        return {
            **base,
            "detail": "Tailscale is installed but this Mac is not connected to a tailnet.",
            "remedy": "Open the Tailscale app and sign in, then turn this on.",
        }
    try:
        proxied = _served_target(cli, run, identity["dns_name"], https_port)
    except (OSError, subprocess.SubprocessError):
        proxied = ""
    enabled = proxied == f"http://127.0.0.1:{port}"
    host = identity["dns_name"] if https_port == 443 else f"{identity['dns_name']}:{https_port}"
    url = f"https://{host}/"
    return {
        **base,
        "supported": True,
        "enabled": enabled,
        "url": url if enabled else "",
        "audience": _audience(identity) if enabled else "",
        "tailnet": identity["tailnet"],
        "device": identity["device"],
        "detail": (
            f"The studio is published on your tailnet at {url}"
            if enabled
            else "The studio is only reachable on this Mac."
        ),
        "remedy": (
            "Turn this off to stop publishing it."
            if enabled
            else "Turn this on to open it on your phone and your other Macs, over your tailnet only."
        ),
        # Named so the UI can say what stays behind: the Canvas port is never
        # published, so a tailnet device reaches the studio and nothing else.
        "published_ports": [port] if enabled else [],
    }


def set_remote_access(
    enabled: bool,
    *,
    port: int | None = None,
    https_port: int | None = None,
    run: Callable[[list[str]], CommandResult] = _run,
) -> dict[str, Any]:
    """Publish (or stop publishing) ONLY the control API port on the tailnet."""
    port = port or studio_port()
    https_port = https_port or tailnet_https_port()
    cli = tailscale_cli()
    if not cli:
        raise RemoteAccessError(
            "Tailscale is not installed on this Mac.",
            "Install Tailscale and sign in, then turn this on.",
        )
    status = remote_access_status(port=port, https_port=https_port, run=run)
    if enabled and not status["supported"]:
        raise RemoteAccessError(status["detail"], status["remedy"])
    argv = (
        [cli, "serve", "--bg", f"--https={https_port}", f"http://127.0.0.1:{port}"]
        if enabled
        else [cli, "serve", f"--https={https_port}", "off"]
    )
    try:
        result = run(argv)
    except (OSError, subprocess.SubprocessError) as exc:  # pragma: no cover - defensive
        raise RemoteAccessError(
            "Tailscale did not answer.",
            "Open the Tailscale app, make sure it is signed in, and try again.",
        ) from exc
    if result.returncode != 0:
        # Never the raw CLI text: it names flags and node ids the reader did not
        # type. The one useful branch is HTTPS certificates being off for the
        # tailnet, which is a setting only an admin can flip.
        combined = f"{result.stdout}\n{result.stderr}".lower()
        if "https" in combined and ("disabled" in combined or "not enabled" in combined):
            raise RemoteAccessError(
                "This tailnet has HTTPS certificates turned off, so there is no way to publish "
                "the studio with a real certificate.",
                "Turn on HTTPS Certificates for the tailnet in the Tailscale admin console, then try again.",
            )
        raise RemoteAccessError(
            "Tailscale could not publish the studio.",
            "Open the Tailscale app, confirm this Mac is connected, and try again.",
        )
    return remote_access_status(port=port, https_port=https_port, run=run)
