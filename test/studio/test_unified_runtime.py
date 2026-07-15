from __future__ import annotations

from hivemind_content_studio.unified_runtime import repository_catalog, unified_runtime_snapshot


def test_repository_catalog_preserves_forks_upstreams_and_component_boundaries() -> None:
    repositories = repository_catalog()

    assert [item["id"] for item in repositories] == [
        "hivemind-content-studio",
        "unified-image-studio-template",
        "Open-Generative-AI",
        "comfyui-mobile-frontend",
        "hive-image-stack",
        "flux-2-swift-mlx",
        "Z-Image.swift",
    ]
    assert next(item for item in repositories if item["id"] == "hivemind-content-studio")["integration"] == "native"
    assert next(item for item in repositories if item["id"] == "unified-image-studio-template")["integration"] == "embedded"
    assert next(item for item in repositories if item["id"] == "Open-Generative-AI")["destination"] == "packages/open-generative-ai"
    assert next(item for item in repositories if item["id"] == "comfyui-mobile-frontend")["destination"] == "packages/comfyui-mobile"
    assert next(item for item in repositories if item["id"] == "hive-image-stack")["destination"] == "packages/media-gateway"
    assert next(item for item in repositories if item["id"] == "flux-2-swift-mlx")["integration"] == "embedded-engine"
    assert next(item for item in repositories if item["id"] == "Open-Generative-AI")["upstream_url"] == "https://github.com/Anil-matcha/Open-Generative-AI"
    assert next(item for item in repositories if item["id"] == "comfyui-mobile-frontend")["upstream_url"] == "https://github.com/cosmicbuffalo/comfyui-mobile-frontend"
    assert next(item for item in repositories if item["id"] == "flux-2-swift-mlx")["upstream_url"] == "https://github.com/VincentGourbin/flux-2-swift-mlx"
    assert next(item for item in repositories if item["id"] == "Z-Image.swift")["upstream_url"] == "https://github.com/zhutao100/Z-Image.swift"


def test_runtime_snapshot_is_safe_and_reports_one_native_surface_with_internal_engine_health() -> None:
    answered = {
        "http://127.0.0.1:8787/healthz",
        "http://127.0.0.1:8188/system_stats",
    }

    snapshot = unified_runtime_snapshot(environ={}, probe=lambda url: url in answered)

    assert snapshot["ok"] is True
    assert snapshot["canonical_app"] == "hivemind-content-studio"
    assert "workspaces" not in snapshot
    assert snapshot["surface"] == {
        "id": "studio",
        "label": "Hivemind Studio",
        "status": "online",
        "modes": ["create", "edit", "animate", "workflow", "explore", "canvas", "models"],
    }
    assert next(item for item in snapshot["engines"] if item["id"] == "comfyui")["status"] == "online"
    assert next(item for item in snapshot["engines"] if item["id"] == "flux-2-swift-mlx")["status"] == "offline"
    assert next(item for item in snapshot["engines"] if item["id"] == "z-image-swift")["status"] == "managed"
    assert snapshot["summary"] == {"online": 3, "offline": 1, "managed": 1, "misconfigured": 0, "total": 5}
    serialized = __import__("json").dumps(snapshot).lower()
    assert "token" not in serialized
    assert "/users/" not in serialized
    assert "tailnet-ip" not in serialized


def test_runtime_snapshot_rejects_non_http_engine_overrides() -> None:
    snapshot = unified_runtime_snapshot(
        environ={"COMFYUI_URL": "javascript:alert(1)"},
        probe=lambda _url: True,
    )

    engine = next(item for item in snapshot["engines"] if item["id"] == "comfyui")
    assert engine["status"] == "misconfigured"
    assert engine["url"] is None
    assert "javascript" not in __import__("json").dumps(snapshot).lower()
