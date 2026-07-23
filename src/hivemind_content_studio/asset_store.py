"""Scoped asset ingestion for local and remote agents."""

from __future__ import annotations

import base64
import binascii
import ipaddress
import mimetypes
import os
import re
import shutil
import socket
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import load_config
from .manifest import add_artifact, load_manifest, write_manifest
from .private_access import encrypt_private_media
from .qa import qa_asset


ALLOWED_MIME_PREFIXES = ("image/", "video/", "audio/", "text/")
ALLOWED_EXACT_MIME = {"application/json", "application/pdf", "application/octet-stream"}


@dataclass(frozen=True)
class AssetPolicy:
    allowed_roots: tuple[Path, ...]
    max_bytes: int = 250 * 1024 * 1024
    allowed_https_hosts: tuple[str, ...] = ()

    @classmethod
    def default(cls) -> "AssetPolicy":
        cfg = load_config()
        extra = tuple(
            Path(value).expanduser().resolve()
            for value in os.environ.get("CONTENT_STUDIO_IMPORT_ROOTS", "").split(os.pathsep)
            if value.strip()
        )
        return cls(allowed_roots=(cfg.project_root, cfg.data_dir, *extra))


class AssetStore:
    def __init__(self, policy: AssetPolicy | None = None):
        self.policy = policy or AssetPolicy.default()

    def ingest_local(self, manifest_path: str | Path, source_path: str | Path, *, role: str, provider: str = "agent-upload", scene: int | None = None) -> dict[str, Any]:
        source = Path(source_path).expanduser().resolve()
        if not source.is_file():
            raise ValueError("Asset source is missing or is not a file")
        if not any(_within(source, root.expanduser().resolve()) for root in self.policy.allowed_roots):
            raise ValueError("Asset source is outside the operator-configured allowed roots")
        self._validate_size(source.stat().st_size)
        return self._store_file(manifest_path, source, role=role, provider=provider, scene=scene)

    def ingest_base64(self, manifest_path: str | Path, *, file_name: str, encoded: str, role: str, provider: str = "mcp-upload", scene: int | None = None) -> dict[str, Any]:
        try:
            data = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Asset payload is not valid base64") from exc
        self._validate_size(len(data))
        manifest_file = Path(manifest_path).expanduser().resolve()
        destination = self._destination(manifest_file, file_name, data)
        destination.write_bytes(data)
        try:
            return self._record(manifest_file, destination, role=role, provider=provider, scene=scene)
        except Exception:
            destination.unlink(missing_ok=True)
            raise

    def ingest_bytes(self, manifest_path: str | Path, *, file_name: str, data: bytes, role: str, provider: str = "studio-upload", scene: int | None = None) -> dict[str, Any]:
        self._validate_size(len(data))
        manifest_file = Path(manifest_path).expanduser().resolve()
        destination = self._destination(manifest_file, file_name, data[:4096])
        destination.write_bytes(data)
        try:
            return self._record(manifest_file, destination, role=role, provider=provider, scene=scene)
        except Exception:
            destination.unlink(missing_ok=True)
            raise

    def ingest_url(self, manifest_path: str | Path, url: str, *, role: str, provider: str = "remote-import", scene: int | None = None) -> dict[str, Any]:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise ValueError("Remote assets require a public HTTPS URL")
        self._validate_public_host(parsed.hostname)
        request = urllib.request.Request(url, method="GET", headers={"User-Agent": "HivemindContentStudio/1"})
        manifest_file = Path(manifest_path).expanduser().resolve()
        file_name = Path(parsed.path).name or "remote-asset.bin"
        destination = self._destination(manifest_file, file_name, b"")
        try:
            with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as output:
                final = urllib.parse.urlparse(response.geturl())
                if final.scheme != "https" or not final.hostname:
                    raise ValueError("Remote asset redirected away from public HTTPS")
                self._validate_public_host(final.hostname)
                declared = int(response.headers.get("Content-Length") or 0)
                if declared:
                    self._validate_size(declared)
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    self._validate_size(total)
                    output.write(chunk)
            return self._record(manifest_file, destination, role=role, provider=provider, scene=scene)
        except Exception:
            destination.unlink(missing_ok=True)
            raise

    def _store_file(self, manifest_path: str | Path, source: Path, *, role: str, provider: str, scene: int | None) -> dict[str, Any]:
        manifest_file = Path(manifest_path).expanduser().resolve()
        destination = self._destination(manifest_file, source.name, source.read_bytes()[:4096])
        shutil.copyfile(source, destination)
        return self._record(manifest_file, destination, role=role, provider=provider, scene=scene)

    def _record(self, manifest_file: Path, destination: Path, *, role: str, provider: str, scene: int | None) -> dict[str, Any]:
        mime_type = mimetypes.guess_type(destination.name)[0] or "application/octet-stream"
        if not mime_type.startswith(ALLOWED_MIME_PREFIXES) and mime_type not in ALLOWED_EXACT_MIME:
            raise ValueError(f"Asset MIME type is not allowed: {mime_type}")
        if mime_type.startswith(("image/", "video/")):
            qa = qa_asset(destination)
            if not qa["ok"]:
                raise ValueError("Asset failed decode/technical validation: " + "; ".join(qa["failures"]))
        manifest = load_manifest(manifest_file)
        artifact = add_artifact(manifest, role=role, path=destination, provider=provider, scene=scene)
        write_manifest(manifest_file, manifest)
        encrypt_private_media(destination)
        return artifact

    def _destination(self, manifest_file: Path, file_name: str, identity: bytes) -> Path:
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(file_name).name).strip(".-") or "asset.bin"
        prefix = __import__("hashlib").sha256(identity or safe_name.encode()).hexdigest()[:12]
        directory = manifest_file.parent / "assets"
        directory.mkdir(parents=True, exist_ok=True)
        return directory / f"{prefix}-{safe_name}"

    def _validate_size(self, size: int) -> None:
        if size <= 0:
            raise ValueError("Asset is empty")
        if size > self.policy.max_bytes:
            raise ValueError(f"Asset exceeds the maximum size of {self.policy.max_bytes} bytes")

    def _validate_public_host(self, host: str) -> None:
        normalized = host.rstrip(".").lower()
        if self.policy.allowed_https_hosts and normalized not in {value.lower() for value in self.policy.allowed_https_hosts}:
            raise ValueError("Remote asset host is not allowlisted")
        if normalized in {"localhost", "localhost.localdomain"}:
            raise ValueError("Remote assets require a public HTTPS host")
        try:
            addresses = {item[4][0] for item in socket.getaddrinfo(normalized, 443, type=socket.SOCK_STREAM)}
        except socket.gaierror as exc:
            raise ValueError("Remote asset host could not be resolved") from exc
        for address in addresses:
            ip = ipaddress.ip_address(address)
            if not ip.is_global:
                raise ValueError("Remote assets require a public HTTPS host")


def _within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False
