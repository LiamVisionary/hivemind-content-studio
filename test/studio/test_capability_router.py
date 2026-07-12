from __future__ import annotations

import pytest

from hivemind_content_studio.capability_router import CapabilityPolicy, CapabilityRouter, NoProviderAvailable


REPORT = [
    {"id": "comfyui", "roles": ["keyframe"], "mode": "local", "cost": "local", "available": True, "side_effects": ["filesystem"], "detail": "ready"},
    {"id": "higgsfield-cloud", "roles": ["keyframe", "image-to-video"], "mode": "cloud", "cost": "paid", "available": True, "side_effects": ["spend"], "detail": "credential present"},
    {"id": "media-studio-mcp", "roles": ["image-to-video"], "mode": "tailnet", "cost": "local/fleet", "available": False, "side_effects": ["generation"], "detail": "offline"},
]


def test_router_selects_local_ready_capability_from_natural_intent() -> None:
    decision = CapabilityRouter(REPORT).select("generate_keyframes", CapabilityPolicy(privacy="local-first", max_cost_usd=5))

    assert decision["provider"] == "comfyui"
    assert decision["role"] == "keyframe"
    assert decision["approval_required"] is False
    assert decision["fallbacks"] == ["higgsfield-cloud"]


def test_router_marks_cloud_spend_as_approval_required() -> None:
    report = [{**row, "available": False} if row["id"] == "comfyui" else row for row in REPORT]

    decision = CapabilityRouter(report).select("generate_keyframes", CapabilityPolicy(privacy="cloud-allowed", max_cost_usd=10))

    assert decision["provider"] == "higgsfield-cloud"
    assert decision["approval_required"] is True
    assert "spend" in decision["evidence"]["side_effects"]


def test_router_fails_closed_when_privacy_or_budget_disallows_every_provider() -> None:
    report = [{**row, "available": False} if row["mode"] == "local" else row for row in REPORT]

    with pytest.raises(NoProviderAvailable, match="privacy"):
        CapabilityRouter(report).select("generate_keyframes", CapabilityPolicy(privacy="local-only", max_cost_usd=0))


def test_explicit_provider_override_is_honored_only_when_allowed_and_capable() -> None:
    router = CapabilityRouter(REPORT)
    decision = router.select("generate_keyframes", CapabilityPolicy(privacy="cloud-allowed", max_cost_usd=5, allowed_providers=("higgsfield-cloud",)), provider_override="higgsfield-cloud")

    assert decision["provider"] == "higgsfield-cloud"
    with pytest.raises(NoProviderAvailable):
        router.select("generate_keyframes", CapabilityPolicy(privacy="cloud-allowed", max_cost_usd=5, allowed_providers=("comfyui",)), provider_override="higgsfield-cloud")
