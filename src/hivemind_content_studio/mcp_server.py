"""Agent-first MCP server for durable content creation workflows."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .agent_runtime import attach_script, run_registered_agent_script
from .approval_ledger import ApprovalLedger
from .approval_config import load_approval_ledger
from .asset_store import AssetStore
from .assembly import assemble_run, export_capcut_handoff
from .capability_router import CapabilityPolicy, CapabilityRouter
from .doctor import collect_checks
from .evaluation import record_semantic_evaluation as save_semantic_evaluation
from .evaluation import semantic_preflight
from .experiments import ingest_performance_batch, recommend_next_variant
from .generation import (
    generate_higgsfield_cloud_asset,
    generate_higgsfield_consumer_asset,
    generate_muapi_asset,
    record_generated_asset,
)
from .generation_telemetry import generation_telemetry_snapshot, record_hivemind_generation_metric
from .intent_service import ContentIntentService
from .manifest import approve_manifest, load_manifest
from .machine_privacy import machine_artifact_receipt, machine_next_actions, machine_operation_receipt, machine_run_receipt
from .mcp_http import McpHttpClient
from .media_studio import generate_video as run_media_studio_video
from .media_studio import list_media_studio_tools, media_studio_status
from .metrics import record_metrics, summarize_metrics
from .orchestrator import ContentOrchestrator
from .planner import plan
from .providers import provider_report
from .publishing import dry_run, execute_publish, prepare_publish
from .stickman import render_stickman_frames
from .voice import generate_elevenlabs_lines


def _approval_ledger() -> ApprovalLedger:
    ledger = load_approval_ledger(required=True)
    assert ledger is not None
    return ledger


def _optional_approval_ledger() -> ApprovalLedger | None:
    return load_approval_ledger(required=False)


def _orchestrator() -> ContentOrchestrator:
    return ContentOrchestrator(generation_metric_sink=record_hivemind_generation_metric)


def _manifest_for_run(run_id: str) -> str:
    return str(_orchestrator().store.get_run(run_id)["manifest_path"])


def _policy_for_run(run_id: str, estimated_cost_usd: float | None = None) -> CapabilityPolicy:
    state = _orchestrator().store.get_run(run_id)
    policy = state["policy"]
    budget = state["budget"]
    remaining = max(0.0, float(budget.get("max_cost_usd") or 0) - float(budget.get("spent_usd") or 0))
    return CapabilityPolicy(
        privacy=str(policy.get("privacy") or "local-first"),  # type: ignore[arg-type]
        max_cost_usd=remaining,
        allowed_providers=tuple(policy.get("allowed_providers") or ()),
        allow_unready=bool(policy.get("allow_unready", False)),
        allow_unknown_paid_cost=estimated_cost_usd is not None or bool(policy.get("allow_unknown_paid_cost", False)),
    )


def build_mcp_server():
    """Build the server without starting transport, enabling contract inspection/tests."""
    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("Install MCP support with: python -m pip install -e '.[mcp]'") from exc

    mcp = FastMCP("hivemind-content-studio")

    @mcp.resource("studio://capabilities")
    def capabilities_resource() -> str:
        return json.dumps(
            {
                "intents": sorted({
                    "write_script", "generate_keyframes", "animate_scenes", "generate_voice",
                    "generate_music", "lip_sync_scenes", "generate_product_cutins",
                    "generate_ugc_shots", "assemble_content", "clip_content", "publish_content",
                }),
                "lanes": sorted(__import__("hivemind_content_studio.orchestrator", fromlist=["LANE_STEPS"]).LANE_STEPS),
                "safety": {
                    "paid_generation": "one-time exact-scope operator approval receipt",
                    "publishing": "approved manifest plus separate live-publish gate",
                    "runtime_execution": "operator-registered runtime ids only",
                },
            },
            sort_keys=True,
        )

    @mcp.resource("studio://providers")
    def providers_resource() -> str:
        return json.dumps({"providers": provider_report()}, sort_keys=True)

    @mcp.resource("studio://telemetry/generations")
    def generation_telemetry_resource() -> str:
        return json.dumps(generation_telemetry_snapshot(_orchestrator().store), sort_keys=True)

    @mcp.resource("studio://runs/{run_id}")
    def run_resource(run_id: str) -> str:
        return json.dumps(machine_run_receipt(_orchestrator().get_run(run_id)), sort_keys=True)

    @mcp.resource("studio://runs/{run_id}/artifacts")
    def artifacts_resource(run_id: str) -> str:
        run = _orchestrator().get_run(run_id)
        receipt = machine_run_receipt(run)
        return json.dumps({
            "run_id": run_id,
            "privacy": "machine-redacted",
            "artifact_count": receipt["artifact_count"],
            "artifact_roles": receipt["artifact_roles"],
            "media_redacted": True,
        }, sort_keys=True)

    @mcp.resource("studio://runs/{run_id}/next-actions")
    def next_actions_resource(run_id: str) -> str:
        run = _orchestrator().get_run(run_id)
        return json.dumps({"run_id": run_id, "status": run["status"], "next_actions": machine_next_actions(run["next_actions"])}, sort_keys=True)

    @mcp.tool()
    def studio_doctor() -> dict:
        """Read-only readiness report; secret values are never returned."""
        return collect_checks()

    @mcp.tool()
    def list_content_providers() -> dict:
        """Return the canonical provider capability/readiness matrix."""
        return {"ok": True, "providers": provider_report()}

    @mcp.tool()
    def execute_content_run(brief_path: str, policy: dict | None = None, budget: dict | None = None) -> dict:
        """Create a durable run and advance deterministic steps until an explicit action is needed."""
        return machine_run_receipt(_orchestrator().execute_content_run(brief_path, policy=policy, budget=budget))

    @mcp.tool()
    def get_content_run(run_id: str) -> dict:
        """Get run state, artifacts, evidence, cost, and precise next actions."""
        return machine_run_receipt(_orchestrator().get_run(run_id))

    @mcp.tool()
    def list_content_runs(status: str = "", limit: int = 100) -> dict:
        """List durable runs, optionally filtered by status."""
        return {"ok": True, "privacy": "machine-redacted", "runs": [
            machine_run_receipt(run) for run in _orchestrator().list_runs(status=status or None, limit=limit)
        ]}

    @mcp.tool()
    def get_generation_telemetry(limit: int = 100) -> dict:
        """Read privacy-safe generation success, failure, timing, cost, and provider aggregates."""
        return generation_telemetry_snapshot(_orchestrator().store, limit=limit)

    @mcp.tool()
    def resume_content_run(run_id: str) -> dict:
        """Resume a cancelled or externally-unblocked run from its persisted step."""
        return machine_run_receipt(_orchestrator().resume_run(run_id))

    @mcp.tool()
    def retry_content_step(run_id: str, step_id: str) -> dict:
        """Retry one failed/blocked step within its bounded attempt policy."""
        return machine_run_receipt(_orchestrator().retry_step(run_id, step_id))

    @mcp.tool()
    def cancel_content_run(run_id: str, reason: str) -> dict:
        """Cancel local orchestration and record the reason without claiming upstream cancellation."""
        return machine_run_receipt(_orchestrator().cancel_run(run_id, reason))

    @mcp.tool()
    def route_content_intent(run_id: str, intent: str, provider_override: str = "", estimated_cost_usd: float | None = None) -> dict:
        """Read-only selection with readiness, privacy, budget, rejection evidence, and fallbacks."""
        decision = CapabilityRouter().select(
            intent,
            _policy_for_run(run_id, estimated_cost_usd),
            provider_override=provider_override or None,
        )
        return {"ok": True, "run_id": run_id, "decision": machine_operation_receipt(decision)}

    @mcp.tool()
    def execute_content_intent(run_id: str, intent: str, estimated_cost_usd: float | None = None, provider_override: str = "", approval_token: str = "") -> dict:
        """Route, authorize, and execute a bounded intent; paid calls require a one-time operator receipt."""
        service = ContentIntentService(
            _orchestrator(),
            CapabilityRouter(),
            _optional_approval_ledger(),
            generation_metric_sink=record_hivemind_generation_metric,
        )
        return machine_operation_receipt(service.execute_intent(
            run_id,
            intent,
            estimated_cost_usd=estimated_cost_usd,
            provider_override=provider_override or None,
            approval_token=approval_token or None,
        ))

    @mcp.tool()
    def ingest_content_asset_base64(run_id: str, file_name: str, encoded: str, role: str, provider: str = "mcp-upload", scene: int = 0) -> dict:
        """Ingest a bounded base64 asset for remote agents and record immutable provenance."""
        artifact = AssetStore().ingest_base64(_manifest_for_run(run_id), file_name=file_name, encoded=encoded, role=role, provider=provider, scene=scene or None)
        return {"ok": True, "run_id": run_id, "artifact": machine_artifact_receipt(artifact)}

    @mcp.tool()
    def ingest_content_asset_url(run_id: str, url: str, role: str, provider: str = "remote-import", scene: int = 0) -> dict:
        """Ingest an allowlisted public HTTPS asset with SSRF, size, MIME, and decode checks."""
        artifact = AssetStore().ingest_url(_manifest_for_run(run_id), url, role=role, provider=provider, scene=scene or None)
        return {"ok": True, "run_id": run_id, "artifact": machine_artifact_receipt(artifact)}

    @mcp.tool()
    def ingest_content_asset_local(run_id: str, source_path: str, role: str, provider: str = "agent-upload", scene: int = 0) -> dict:
        """Ingest a file only from operator-configured roots and record provenance."""
        artifact = AssetStore().ingest_local(_manifest_for_run(run_id), source_path, role=role, provider=provider, scene=scene or None)
        return {"ok": True, "run_id": run_id, "artifact": machine_artifact_receipt(artifact)}

    @mcp.tool()
    def request_content_approval(run_id: str, kind: str, provider: str, target: str, reason: str, amount_usd: float = 0.0) -> dict:
        """Request an exact-scope approval. Approval/denial itself is operator-only and not exposed over MCP."""
        approval = _approval_ledger().request(run_id=run_id, kind=kind, provider=provider, amount_usd=amount_usd, target=target, reason=reason)
        return machine_operation_receipt({
            "ok": True,
            "status": "awaiting_approval",
            "approval": approval,
            "next_actions": [{"intent": "operator_decide_approval", "approval_id": approval["id"]}],
        })

    @mcp.tool()
    def apply_content_run_approval(run_id: str, reviewer: str, rights_note: str, approval_token: str) -> dict:
        """Consume an operator-issued run-approval receipt and record rights/claims approval."""
        manifest_path = Path(_manifest_for_run(run_id)).expanduser().resolve()
        consumed = _approval_ledger().consume(
            approval_token,
            run_id=run_id,
            kind="run-approval",
            provider="content-studio",
            amount_usd=0,
            target=str(manifest_path),
        )
        manifest = approve_manifest(manifest_path, reviewer=reviewer, rights_note=rights_note)
        return machine_operation_receipt({"ok": True, "run_id": run_id, "approval": manifest["approval"], "receipt": consumed})

    @mcp.tool()
    def preflight_content_semantics(run_id: str) -> dict:
        """Run deterministic claim and mobile-legibility preflight before semantic evaluation."""
        semantic_preflight(_manifest_for_run(run_id))
        return {"ok": True, "run_id": run_id, "privacy": "machine-redacted", "evaluation_completed": True}

    @mcp.tool()
    def record_semantic_evaluation(run_id: str, evaluator: str, passed: bool, score: float, checks: dict, scene_failures: list[dict], regeneration_instructions: list[dict]) -> dict:
        """Persist structured semantic evidence and scene-level regeneration instructions."""
        evaluation = save_semantic_evaluation(
            _manifest_for_run(run_id), evaluator=evaluator, passed=passed, score=score,
            checks=checks, scene_failures=scene_failures, regeneration_instructions=regeneration_instructions,
        )
        return {"ok": True, "run_id": run_id, "privacy": "machine-redacted", "evaluation_recorded": bool(evaluation)}

    @mcp.tool()
    def ingest_content_metrics(run_id: str, entries: list[dict]) -> dict:
        """Idempotently ingest outcome/spend/retention evidence keyed by external ids."""
        return machine_operation_receipt({"ok": True, "run_id": run_id, **ingest_performance_batch(_manifest_for_run(run_id), entries)})

    @mcp.tool()
    def recommend_content_variant(run_ids: list[str], change_dimension: str, candidate_value: Any) -> dict:
        """Preserve the measured winner and recommend a child varying exactly one dimension."""
        paths = [_manifest_for_run(run_id) for run_id in run_ids]
        recommend_next_variant(paths, change_dimension=change_dimension, candidate_value=candidate_value)
        return {"ok": True, "privacy": "machine-redacted", "run_count": len(run_ids), "recommendation_ready": True}

    # Compatibility tools remain for existing agents, but the preferred contract is
    # execute_content_run -> execute_content_intent -> evidence/approval resources.
    def plan_content(brief_path: str, lane: str = "") -> dict:
        manifest = plan(brief_path, lane=lane or None)
        return {"ok": True, "planned": bool(manifest), "privacy": "machine-redacted"}

    def run_agent_script_generation(manifest_path: str, runtime_id: str, confirm: str = "") -> dict:
        return machine_operation_receipt(run_registered_agent_script(manifest_path, runtime_id=runtime_id, confirm=confirm))

    def attach_agent_script(manifest_path: str, script_path: str, runtime: str = "external-agent") -> dict:
        return machine_operation_receipt(attach_script(manifest_path, script_path, runtime=runtime))

    @mcp.tool()
    def render_stickman_ad_frames(manifest_path: str) -> dict:
        return machine_operation_receipt(render_stickman_frames(manifest_path))

    def generate_higgsfield_consumer_media(kind: str, model: str, prompt: str, output_path: str, **kwargs) -> dict:
        """Internal compatibility executor; agent calls should use execute_content_intent."""
        return generate_higgsfield_consumer_asset(kind=kind, model=model, prompt=prompt, output=output_path, **kwargs)

    def generate_higgsfield_cloud_media(model_id: str, payload_path: str, output_path: str, **kwargs) -> dict:
        return generate_higgsfield_cloud_asset(model_id=model_id, payload=payload_path, output=output_path, **kwargs)

    def generate_muapi_media(endpoint: str, payload_path: str, output_path: str, state_path: str = "", **kwargs) -> dict:
        state = state_path or str(Path(output_path).expanduser().resolve().parent / "muapi-state.json")
        return generate_muapi_asset(endpoint=endpoint, payload=payload_path, output=output_path, state=state, **kwargs)

    def generate_elevenlabs_voice_lines(manifest_path: str, **kwargs) -> dict:
        return generate_elevenlabs_lines(manifest_path, **kwargs)

    @mcp.tool()
    def assemble_content_run(manifest_path: str, output_path: str = "") -> dict:
        return machine_operation_receipt(assemble_run(manifest_path, output=output_path or None))

    @mcp.tool()
    def export_capcut_timeline_handoff(manifest_path: str, output_dir: str = "") -> dict:
        return machine_operation_receipt(export_capcut_handoff(manifest_path, output_dir=output_dir or None))

    @mcp.tool()
    def prepare_social_publish(manifest_path: str, video: str, title: str, caption: str, platforms: list[str], provider: str = "postiz", scheduled_at: str = "") -> dict:
        return machine_operation_receipt(prepare_publish(manifest_path, video=video, title=title, caption=caption, platforms=platforms, provider=provider, scheduled_at=scheduled_at or None))

    @mcp.tool()
    def dry_run_social_publish(manifest_path: str) -> dict:
        return machine_operation_receipt(dry_run(manifest_path))

    @mcp.tool()
    def execute_social_publish(manifest_path: str, confirm: str = "") -> dict:
        return machine_operation_receipt(execute_publish(manifest_path, confirm=confirm))

    @mcp.tool()
    def summarize_content_metrics(manifest_path: str) -> dict:
        return machine_operation_receipt(summarize_metrics(manifest_path))

    return mcp


def main() -> None:
    build_mcp_server().run()


if __name__ == "__main__":
    main()
