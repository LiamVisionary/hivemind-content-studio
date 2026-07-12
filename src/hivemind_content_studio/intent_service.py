"""Intent authorization and provider routing for agent-facing operations."""

from __future__ import annotations

import inspect
import time
from typing import Any, Callable

from .approval_ledger import ApprovalLedger
from .assembly import assemble_run
from .capability_router import CapabilityPolicy, CapabilityRouter
from .generation import PAID_GENERATION_CONFIRMATION
from .generation_telemetry import GenerationAttempt, generation_kind, generation_model
from .manifest import load_manifest
from .local_voice import generate_local_voice_lines
from .orchestrator import ContentOrchestrator
from .static_text import render_static_text_frames
from .stickman import render_stickman_frames
from .voice import generate_elevenlabs_lines


IntentExecutor = Callable[..., dict[str, Any]]


def _default_executors() -> dict[tuple[str, str], IntentExecutor]:
    executors: dict[tuple[str, str], IntentExecutor] = {
        ("generate_keyframes", "static-text-renderer"): render_static_text_frames,
        ("generate_keyframes", "stickman-renderer"): render_stickman_frames,
        ("generate_voice", "universal-tts"): generate_local_voice_lines,
        ("generate_voice", "elevenlabs"): lambda manifest: generate_elevenlabs_lines(
            manifest, confirm=PAID_GENERATION_CONFIRMATION
        ),
        ("assemble_content", "moneyprinterturbo"): assemble_run,
    }
    from .provider_execution import ProviderExecutors

    executors.update(ProviderExecutors().as_intent_executors())
    return executors


class ContentIntentService:
    def __init__(
        self,
        orchestrator: ContentOrchestrator,
        router: CapabilityRouter,
        approvals: ApprovalLedger | None,
        executors: dict[tuple[str, str], IntentExecutor] | None = None,
        *,
        monotonic: Callable[[], float] = time.perf_counter,
        generation_metric_sink: Callable[[dict[str, Any]], None] | None = None,
    ):
        self.orchestrator = orchestrator
        self.router = router
        self.approvals = approvals
        self.executors = dict(executors or _default_executors())
        self.monotonic = monotonic
        self.generation_metric_sink = generation_metric_sink

    def prepare_intent(
        self,
        run_id: str,
        intent: str,
        *,
        estimated_cost_usd: float | None,
        provider_override: str | None = None,
        approval_token: str | None = None,
    ) -> dict[str, Any]:
        state = self.orchestrator.store.get_run(run_id)
        policy_data = state["policy"]
        budget = state["budget"]
        remaining = max(0.0, float(budget.get("max_cost_usd") or 0) - float(budget.get("spent_usd") or 0))
        policy = CapabilityPolicy(
            privacy=str(policy_data.get("privacy") or "local-first"),  # type: ignore[arg-type]
            max_cost_usd=remaining,
            allowed_providers=tuple(policy_data.get("allowed_providers") or ()),
            allow_unready=bool(policy_data.get("allow_unready", False)),
            allow_unknown_paid_cost=estimated_cost_usd is not None or bool(policy_data.get("allow_unknown_paid_cost", False)),
        )
        decision = self.router.select(intent, policy, provider_override=provider_override)
        if not decision["approval_required"]:
            return {"ok": True, "status": "authorized", "execute": True, "decision": decision, "approval": None, "cost": {"estimated_usd": 0.0, "remaining_budget_usd": remaining}}
        if self.approvals is None:
            raise RuntimeError(
                "Paid generation requires configured approval infrastructure; set the approval signing secret and operator token."
            )
        if estimated_cost_usd is None:
            return {
                "ok": False,
                "status": "cost_required",
                "execute": False,
                "decision": decision,
                "approval": None,
                "cost": {"estimated_usd": None, "remaining_budget_usd": remaining},
                "next_actions": [{"intent": "estimate_cost", "reason": "Paid capabilities require a bounded estimate before approval."}],
            }
        estimate = round(float(estimated_cost_usd), 4)
        if estimate < 0 or estimate > remaining:
            raise ValueError(f"Estimated cost ${estimate:.4f} exceeds remaining run budget ${remaining:.4f}")
        target = f"{run_id}:{intent}"
        if approval_token:
            consumed = self.approvals.consume(
                approval_token,
                run_id=run_id,
                kind="paid-generation",
                provider=decision["provider"],
                amount_usd=estimate,
                target=target,
            )
            self.orchestrator.store.append_event(run_id, "approval.consumed", {"approval_id": consumed["id"], "intent": intent, "provider": decision["provider"], "amount_usd": estimate})
            return {"ok": True, "status": "authorized", "execute": True, "decision": decision, "approval": consumed, "cost": {"estimated_usd": estimate, "remaining_budget_usd": remaining}}
        approval = self.approvals.request(
            run_id=run_id,
            kind="paid-generation",
            provider=decision["provider"],
            amount_usd=estimate,
            target=target,
            reason=f"Authorize {intent} through {decision['provider']} for run {run_id}",
        )
        self.orchestrator.store.append_event(run_id, "approval.requested", {"approval_id": approval["id"], "intent": intent, "provider": decision["provider"], "amount_usd": estimate})
        return {
            "ok": True,
            "status": "awaiting_approval",
            "execute": False,
            "decision": decision,
            "approval": approval,
            "cost": {"estimated_usd": estimate, "remaining_budget_usd": remaining},
            "next_actions": [{"intent": "approve_spend", "approval_id": approval["id"], "reason": approval["reason"]}],
        }

    def execute_intent(
        self,
        run_id: str,
        intent: str,
        *,
        estimated_cost_usd: float | None,
        provider_override: str | None = None,
        approval_token: str | None = None,
    ) -> dict[str, Any]:
        """Authorize and execute one bounded provider intent.

        Only providers with an explicit executor are callable here. This keeps the
        agent-facing router from treating provider discovery as authority to run an
        arbitrary command or make an unreviewed paid request.
        """
        prepared = self.prepare_intent(
            run_id,
            intent,
            estimated_cost_usd=estimated_cost_usd,
            provider_override=provider_override,
            approval_token=approval_token,
        )
        if not prepared["execute"]:
            return prepared

        provider = str(prepared["decision"]["provider"])
        state = self.orchestrator.store.get_run(run_id)
        manifest_path = state["manifest_path"]
        executor = self.executors.get((intent, provider))
        if executor is None:
            raise ValueError(f"No bounded executor is registered for {intent!r} through {provider!r}")
        kind = generation_kind(intent)
        manifest = load_manifest(manifest_path)
        estimated = round(float(estimated_cost_usd or 0), 6)
        attempt = GenerationAttempt.start(
            self.orchestrator.store,
            run_id=run_id,
            intent=intent,
            kind=kind,
            provider=provider,
            model=generation_model(manifest, provider, intent),
            estimated_cost_usd=estimated,
            monotonic=self.monotonic,
            metric_sink=self.generation_metric_sink,
        ) if kind else None
        try:
            execution = _invoke_executor(
                executor,
                manifest_path,
                {
                    "maximum_debit_usd": estimated,
                    "approval": prepared["approval"],
                    "provider": provider,
                    "intent": intent,
                },
            )
        except Exception as exc:
            if attempt:
                attempt.fail(exc)
            raise
        artifacts = _execution_artifacts(execution)
        if prepared["decision"]["approval_required"]:
            self.orchestrator.store.record_spend(
                run_id,
                float(prepared["cost"]["estimated_usd"] or 0),
                provider=provider,
                intent=intent,
            )

        self.orchestrator.store.append_event(
            run_id,
            "intent.completed",
            {"intent": intent, "provider": provider, "artifacts": artifacts},
        )
        telemetry: dict[str, Any] | None = None
        if attempt:
            charged = round(float(prepared["cost"]["estimated_usd"] or 0), 6) if prepared["decision"]["approval_required"] else 0.0
            telemetry = attempt.complete(
                model=generation_model(manifest, provider, intent, execution),
                artifact_count=len(artifacts),
                charged_usd=charged,
            )
        return {
            "ok": True,
            "status": "completed",
            "run_id": run_id,
            "intent": intent,
            "provider": provider,
            "artifacts": artifacts,
            "decision": prepared["decision"],
            "approval": prepared["approval"],
            "cost": prepared["cost"],
            "telemetry": telemetry,
        }


def _execution_artifacts(execution: dict[str, Any]) -> list[str]:
    for key in ("artifacts", "frames", "audio_files", "files"):
        value = execution.get(key)
        if isinstance(value, list):
            return [str(item) for item in value]
    for key in ("output", "video"):
        value = execution.get(key)
        if value:
            return [str(value)]
    return []


def _invoke_executor(executor: IntentExecutor, manifest_path: str, authorization: dict[str, Any]) -> dict[str, Any]:
    """Pass bounded spend context only to executors that explicitly accept it."""

    try:
        inspect.signature(executor).bind(manifest_path, authorization)
    except (TypeError, ValueError):
        return executor(manifest_path)
    return executor(manifest_path, authorization)
