"""Secret-free engine diagnostics and source provenance for Hivemind Studio."""

from __future__ import annotations

import os
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Callable, Mapping
from urllib.parse import urljoin, urlparse, urlunparse


Probe = Callable[[str], bool]


@dataclass(frozen=True)
class SourceRepository:
    id: str
    label: str
    repository_url: str
    upstream_url: str | None
    layer: str
    integration: str
    destination: str
    capabilities: tuple[str, ...]


SOURCE_REPOSITORIES: tuple[SourceRepository, ...] = (
    SourceRepository(
        "hivemind-content-studio",
        "Hivemind Content Studio",
        "https://github.com/LiamVisionary/hivemind-content-studio",
        None,
        "product",
        "native",
        ".",
        ("durable-runs", "provider-routing", "approvals", "publishing", "metrics"),
    ),
    SourceRepository(
        "unified-image-studio-template",
        "Unified Media Studio Template",
        "https://github.com/LiamVisionary/unified-image-studio-template",
        None,
        "package",
        "embedded",
        "packages/unified-studio-launcher",
        ("service-catalog", "repository-bootstrap", "desktop-launchers"),
    ),
    SourceRepository(
        "Open-Generative-AI",
        "Open Generative AI",
        "https://github.com/LiamVisionary/Open-Generative-AI",
        "https://github.com/Anil-matcha/Open-Generative-AI",
        "package",
        "embedded",
        "packages/open-generative-ai",
        ("image-studio", "video-studio", "model-exploration", "local-inference"),
    ),
    SourceRepository(
        "comfyui-mobile-frontend",
        "ComfyUI Mobile Frontend",
        "https://github.com/LiamVisionary/comfyui-mobile-frontend",
        "https://github.com/cosmicbuffalo/comfyui-mobile-frontend",
        "package",
        "embedded",
        "packages/comfyui-mobile",
        ("workflow-editor", "queue", "output-browser", "model-manager"),
    ),
    SourceRepository(
        "hive-image-stack",
        "Hive Image Stack",
        "https://github.com/LiamVisionary/hive-image-stack",
        None,
        "engine",
        "embedded-engine",
        "packages/media-gateway",
        ("comfyui-proxy", "generation-api", "media-studio-mcp", "model-manager"),
    ),
    SourceRepository(
        "flux-2-swift-mlx",
        "Flux 2 Swift MLX",
        "https://github.com/LiamVisionary/flux-2-swift-mlx",
        "https://github.com/VincentGourbin/flux-2-swift-mlx",
        "engine",
        "embedded-engine",
        "engines/flux-2-swift-mlx",
        ("apple-silicon", "image-editing", "multi-reference", "lora"),
    ),
    SourceRepository(
        "Z-Image.swift",
        "Z-Image Swift",
        "https://github.com/LiamVisionary/Z-Image.swift",
        "https://github.com/zhutao100/Z-Image.swift",
        "engine",
        "embedded-engine",
        "engines/z-image-swift",
        ("apple-silicon", "text-to-image", "controlnet", "staging-daemon"),
    ),
)


def repository_catalog() -> list[dict]:
    """Return internal donor/upstream provenance without defining product boundaries."""
    return [
        {**asdict(repository), "capabilities": list(repository.capabilities)}
        for repository in SOURCE_REPOSITORIES
    ]


def unified_runtime_snapshot(
    *,
    environ: Mapping[str, str] | None = None,
    probe: Probe | None = None,
) -> dict:
    """Return one native product surface plus bounded internal engine health."""
    env = os.environ if environ is None else environ
    probe_fn = probe or _http_probe

    comfy_url, comfy_error = _configured_url(env, ("COMFYUI_URL", "COMFY_HTTP", "COMFY_HTTP_DEFAULT"), "http://127.0.0.1:8188/")
    flux_url, flux_error = _configured_url(env, ("SWIFT_FLUX2_SERVER_URL", "FLUX2_SERVER_URL"), "http://127.0.0.1:8791/")
    backend_url, backend_error = _configured_url(env, ("MEDIA_STUDIO_BACKEND_URL", "ZIMAGE_API_URL", "ZIMG_BACKEND_URL"), "http://127.0.0.1:8787/")

    surface = {
        "id": "studio",
        "label": "Hivemind Studio",
        "status": "online",
        "modes": ["create", "edit", "animate", "workflow", "explore", "canvas", "models"],
    }
    engines = [
        _remote_component(
            id="hive-image-stack",
            label="Local Media Gateway",
            description="Private image API, output serving, workflow recovery, and native-engine routing.",
            source_repository="hive-image-stack",
            url=backend_url,
            health_path="healthz",
            misconfigured=backend_error,
        ),
        _remote_component(
            id="comfyui",
            label="ComfyUI",
            description="Workflow graph execution and custom-node runtime.",
            source_repository="hive-image-stack",
            url=comfy_url,
            health_path="system_stats",
            misconfigured=comfy_error,
        ),
        _remote_component(
            id="flux-2-swift-mlx",
            label="Flux 2 Swift MLX",
            description="Warm Apple Silicon multi-reference image-editing sidecar.",
            source_repository="flux-2-swift-mlx",
            url=flux_url,
            health_path="health",
            misconfigured=flux_error,
        ),
        {
            "id": "z-image-swift",
            "label": "Z-Image Swift",
            "description": "Apple Silicon Z-Image engine reached through the local media gateway.",
            "source_repository": "Z-Image.swift",
            "url": None,
            "health_url": None,
            "status": "managed",
            "detail": "Lifecycle and health are owned by the local media gateway supervisor.",
        },
    ]

    _apply_probes(engines, probe_fn)
    statuses = [surface["status"], *(component["status"] for component in engines)]
    summary = {
        "online": statuses.count("online"),
        "offline": statuses.count("offline"),
        "managed": statuses.count("managed"),
        "misconfigured": statuses.count("misconfigured"),
        "total": len(statuses),
    }
    return {
        "ok": True,
        "name": "Hivemind Studio",
        "canonical_app": "hivemind-content-studio",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "summary": summary,
        "surface": surface,
        "engines": engines,
        "repositories": repository_catalog(),
    }


def _remote_component(
    *,
    id: str,
    label: str,
    description: str,
    source_repository: str,
    url: str | None,
    health_path: str,
    misconfigured: bool,
) -> dict:
    health_url = urljoin(url, health_path) if url and health_path else url
    return {
        "id": id,
        "label": label,
        "description": description,
        "source_repository": source_repository,
        "url": url,
        "health_url": health_url,
        "status": "misconfigured" if misconfigured else "pending",
        "detail": "The configured URL is invalid." if misconfigured else "Waiting for a bounded health check.",
    }


def _apply_probes(components: list[dict], probe: Probe) -> None:
    pending = [component for component in components if component.get("status") == "pending" and component.get("health_url")]
    if not pending:
        return
    with ThreadPoolExecutor(max_workers=min(6, len(pending))) as executor:
        futures = {executor.submit(_safe_probe, probe, component["health_url"]): component for component in pending}
        for future in as_completed(futures):
            component = futures[future]
            available = future.result()
            component["status"] = "online" if available else "offline"
            component["detail"] = "Health check answered." if available else "The configured service did not answer."


def _safe_probe(probe: Probe, url: str) -> bool:
    try:
        return bool(probe(url))
    except Exception:
        return False


def _http_probe(url: str) -> bool:
    request = urllib.request.Request(url, method="GET", headers={"Accept": "application/json, text/html;q=0.8"})
    try:
        with urllib.request.urlopen(request, timeout=1.5) as response:
            return response.status < 500
    except urllib.error.HTTPError as exc:
        return exc.code < 500
    except (OSError, urllib.error.URLError):
        return False


def _configured_url(env: Mapping[str, str], keys: tuple[str, ...], default: str) -> tuple[str | None, bool]:
    return _safe_url(_first_value(env, keys) or default)


def _first_value(env: Mapping[str, str], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = str(env.get(key) or "").strip()
        if value:
            return value
    return ""


def _safe_url(value: str) -> tuple[str | None, bool]:
    try:
        parsed = urlparse(value.strip())
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("invalid URL")
        _ = parsed.port
        path = parsed.path or "/"
        normalized = urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))
        return normalized, False
    except (TypeError, ValueError):
        return None, True
