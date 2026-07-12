"""Intent-first provider selection under privacy, readiness, and spend policy."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal

from .providers import provider_report


PrivacyPolicy = Literal["local-only", "local-first", "cloud-allowed"]


INTENT_ROLES = {
    "write_script": "script",
    "generate_keyframes": "keyframe",
    "animate_scenes": "image-to-video",
    "generate_voice": "voice",
    "generate_music": "music",
    "lip_sync_scenes": "lip-sync",
    "generate_product_cutins": "image",
    "generate_ugc_shots": "ugc",
    "assemble_content": "assembly",
    "clip_content": "clip",
    "publish_content": "publish",
}


class NoProviderAvailable(RuntimeError):
    pass


@dataclass(frozen=True)
class CapabilityPolicy:
    privacy: PrivacyPolicy = "local-first"
    max_cost_usd: float = 0.0
    allowed_providers: tuple[str, ...] = ()
    allow_unready: bool = False
    allow_unknown_paid_cost: bool = True


class CapabilityRouter:
    def __init__(self, report: list[dict[str, Any]] | None = None):
        self.report = list(report if report is not None else provider_report())

    def select(self, intent: str, policy: CapabilityPolicy, *, provider_override: str | None = None) -> dict[str, Any]:
        role = INTENT_ROLES.get(intent)
        if not role:
            raise ValueError(f"Unknown content capability intent: {intent}")
        allowed = set(policy.allowed_providers)
        candidates: list[dict[str, Any]] = []
        rejected: list[dict[str, str]] = []
        for provider in self.report:
            provider_id = str(provider.get("id") or "")
            reason = self._rejection_reason(provider, role, policy, allowed, provider_override)
            if reason:
                rejected.append({"provider": provider_id, "reason": reason})
                continue
            candidates.append(provider)
        candidates.sort(key=lambda item: self._rank(item, policy))
        if not candidates:
            reasons = "; ".join(f"{item['provider']}: {item['reason']}" for item in rejected) or "no providers advertise the capability"
            raise NoProviderAvailable(f"No provider available for {intent} under privacy/budget/readiness policy: {reasons}")
        selected = candidates[0]
        paid = "spend" in selected.get("side_effects", []) or str(selected.get("cost")) == "paid"
        return {
            "intent": intent,
            "role": role,
            "provider": selected["id"],
            "approval_required": paid,
            "fallbacks": [str(item["id"]) for item in candidates[1:]],
            "policy": asdict(policy),
            "evidence": {
                "available": bool(selected.get("available")),
                "mode": selected.get("mode"),
                "cost": selected.get("cost"),
                "side_effects": list(selected.get("side_effects", [])),
                "detail": selected.get("detail"),
            },
            "rejected": rejected,
        }

    @staticmethod
    def _rejection_reason(
        provider: dict[str, Any],
        role: str,
        policy: CapabilityPolicy,
        allowed: set[str],
        provider_override: str | None,
    ) -> str | None:
        provider_id = str(provider.get("id") or "")
        if role not in provider.get("roles", []):
            return "capability not supported"
        if provider_override and provider_id != provider_override:
            return "not the explicit provider override"
        if allowed and provider_id not in allowed:
            return "not in allowed_providers"
        if not provider.get("available") and not policy.allow_unready:
            return "provider is not ready"
        mode = str(provider.get("mode") or "")
        if policy.privacy == "local-only" and mode != "local":
            return "privacy policy permits local providers only"
        paid = "spend" in provider.get("side_effects", []) or str(provider.get("cost")) == "paid"
        if paid and policy.max_cost_usd <= 0:
            return "budget does not permit paid generation"
        if paid and provider.get("estimated_cost_usd") is None and not policy.allow_unknown_paid_cost:
            return "paid cost is unknown"
        estimate = provider.get("estimated_cost_usd")
        if estimate is not None and float(estimate) > policy.max_cost_usd:
            return "estimated cost exceeds budget"
        return None

    @staticmethod
    def _rank(provider: dict[str, Any], policy: CapabilityPolicy) -> tuple[int, int, str]:
        mode_rank = {"local": 0, "tailnet": 1, "cloud": 2, "manual": 3}
        if policy.privacy == "cloud-allowed":
            mode_rank = {"local": 0, "tailnet": 1, "cloud": 2, "manual": 3}
        paid_rank = 1 if ("spend" in provider.get("side_effects", []) or str(provider.get("cost")) == "paid") else 0
        return mode_rank.get(str(provider.get("mode")), 9), paid_rank, str(provider.get("id"))
