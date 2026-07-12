"""Durable intent-first content workflow orchestration."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable

from .assembly import assemble_run
from .config import load_config
from .generation_telemetry import GenerationAttempt
from .manifest import add_artifact, load_manifest, write_manifest
from .lanes import LANE_STEPS
from .planner import plan
from .run_store import RunStore
from .stickman import render_stickman_frames


class ContentOrchestrator:
    def __init__(
        self,
        store: RunStore | None = None,
        *,
        monotonic: Callable[[], float] = time.perf_counter,
        generation_metric_sink: Callable[[dict[str, Any]], None] | None = None,
    ):
        cfg = load_config()
        self.store = store or RunStore(cfg.data_dir / "content-studio.sqlite3")
        self.monotonic = monotonic
        self.generation_metric_sink = generation_metric_sink

    def execute_content_run(
        self,
        brief_path: str | Path,
        *,
        policy: dict[str, Any] | None = None,
        budget: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        manifest_path = plan(brief_path)
        manifest = load_manifest(manifest_path)
        lane = str(manifest["lane"])
        steps = LANE_STEPS.get(lane, LANE_STEPS["animation"])
        self.store.create_run(
            run_id=manifest["run_id"],
            manifest_path=manifest_path,
            lane=lane,
            steps=steps,
            policy={"privacy": "local-first", "require_semantic_evaluation": True, **(policy or {})},
            budget={"max_cost_usd": 0.0, "spent_usd": 0.0, **(budget or {})},
        )
        return self._run_until_blocked(manifest["run_id"])

    def resume_run(self, run_id: str) -> dict[str, Any]:
        state = self.store.get_run(run_id)
        if state["status"] == "cancelled":
            self.store.resume_run(run_id)
        return self._run_until_blocked(run_id)

    def retry_step(self, run_id: str, step_id: str) -> dict[str, Any]:
        self.store.retry_step(run_id, step_id)
        self.store.append_event(run_id, "step.retry", {"step": step_id})
        return self._run_until_blocked(run_id)

    def cancel_run(self, run_id: str, reason: str) -> dict[str, Any]:
        self.store.cancel_run(run_id, reason)
        return self.get_run(run_id)

    def get_run(self, run_id: str) -> dict[str, Any]:
        return self._envelope(self.store.get_run(run_id))

    def list_runs(self, *, status: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        return [self._envelope(state) for state in self.store.list_runs(status=status, limit=limit)]

    def _run_until_blocked(self, run_id: str) -> dict[str, Any]:
        for _ in range(32):
            state = self.store.get_run(run_id)
            if state["status"] in {"cancelled", "completed", "failed"} or not state["current_step"]:
                return self._envelope(state)
            step = str(state["current_step"])
            outcome = self._process_step(state, step)
            if outcome == "blocked":
                return self.get_run(run_id)
        raise RuntimeError("Run exceeded the safe automatic step limit")

    def _process_step(self, state: dict[str, Any], step: str) -> str:
        run_id = state["run_id"]
        manifest_path = state["manifest_path"]
        manifest = load_manifest(manifest_path)
        artifacts = manifest.get("artifacts", [])
        roles = [item.get("role") for item in artifacts]
        scene_count = len(manifest.get("brief", {}).get("scenes") or [])
        try:
            self.store.set_step_status(run_id, step, "running")
            if step == "script":
                if "script" not in roles:
                    return self._block(run_id, step, "awaiting_agent", [{
                        "intent": "attach_script",
                        "tool": "attach_agent_script",
                        "arguments": {"manifest_path": manifest_path},
                        "reason": "A runtime-neutral script is required before production.",
                    }])
            elif step == "keyframes":
                keyframes = [item for item in artifacts if item.get("role") == "keyframe"]
                if state["lane"] == "stickman-performance-ad" and len(keyframes) < scene_count:
                    self._execute_local_generation(
                        run_id,
                        provider="stickman-renderer",
                        executor=lambda: render_stickman_frames(manifest_path),
                    )
                elif state["lane"] == "static-text-ad" and len(keyframes) < scene_count:
                    from .static_text import render_static_text_frames

                    self._execute_local_generation(
                        run_id,
                        provider="static-text-renderer",
                        executor=lambda: render_static_text_frames(manifest_path),
                    )
                elif len(keyframes) < scene_count:
                    return self._block(run_id, step, "awaiting_generation", [{
                        "intent": "generate_keyframes",
                        "tool": "generate_keyframes",
                        "arguments": {"run_id": run_id},
                        "reason": f"{scene_count - len(keyframes)} scene keyframes remain.",
                    }])
            elif step == "motion":
                scene_videos = [item for item in artifacts if item.get("role") == "scene-video"]
                if len(scene_videos) < scene_count:
                    return self._block(run_id, step, "awaiting_generation", [{
                        "intent": "animate_scenes",
                        "tool": "animate_scenes",
                        "arguments": {"run_id": run_id},
                        "reason": f"{scene_count - len(scene_videos)} animated scenes remain.",
                    }])
            elif step == "voice":
                voice = manifest.get("brief", {}).get("voice")
                voice_enabled = not isinstance(voice, dict) or voice.get("enabled", True) is not False
                voice_lines = [item for item in artifacts if item.get("role") == "voice-line"]
                if voice_enabled and len(voice_lines) < scene_count:
                    return self._block(run_id, step, "awaiting_generation", [{
                        "intent": "generate_voice",
                        "tool": "generate_voice",
                        "arguments": {"run_id": run_id},
                        "reason": f"{scene_count - len(voice_lines)} voice lines remain.",
                    }])
            elif step == "assembly":
                if "final-video" not in roles:
                    assemble_run(manifest_path)
            elif step == "evaluation":
                if "semantic-evaluation" not in roles:
                    self._ensure_evaluation_request(manifest_path)
                    return self._block(run_id, step, "awaiting_evaluation", [{
                        "intent": "evaluate_content",
                        "tool": "record_semantic_evaluation",
                        "arguments": {"run_id": run_id},
                        "reason": "Technical QA passed; semantic creative acceptance is still required.",
                    }])
                evaluation = self._artifact_json(artifacts, "semantic-evaluation")
                if not evaluation.get("passed"):
                    return self._block(run_id, step, "awaiting_evaluation", [{
                        "intent": "revise_failed_scenes",
                        "tool": "get_run",
                        "arguments": {"run_id": run_id},
                        "reason": "Semantic evaluation did not pass.",
                    }])
            elif step == "approval":
                if manifest.get("approval", {}).get("status") != "approved":
                    return self._block(run_id, step, "awaiting_approval", [{
                        "intent": "request_run_approval",
                        "tool": "request_content_approval",
                        "arguments": {
                            "run_id": run_id,
                            "kind": "run-approval",
                            "provider": "content-studio",
                            "amount_usd": 0,
                            "target": str(Path(manifest_path).expanduser().resolve()),
                            "reason": "Approve rights, claims, and readiness for this content run",
                        },
                        "reason": "Rights, claims, and outward publication require approval.",
                    }])
            elif step == "publish":
                if not manifest.get("publish", {}).get("receipts"):
                    return self._block(run_id, step, "awaiting_approval", [{
                        "intent": "publish_approved_content",
                        "tool": "execute_social_publish",
                        "arguments": {"manifest_path": manifest_path},
                        "reason": "Publishing remains a separately confirmed outward action.",
                    }])
            elif step == "metrics":
                if not manifest.get("performance"):
                    return self._block(run_id, step, "awaiting_metrics", [{
                        "intent": "ingest_performance_metrics",
                        "tool": "ingest_content_metrics",
                        "arguments": {"run_id": run_id},
                        "reason": "Performance evidence is needed to close the learning loop.",
                    }])
            elif step in {"render", "clip"}:
                return self._block(run_id, step, "awaiting_agent", [{
                    "intent": step,
                    "tool": "render_faceless_content" if step == "render" else "run_clip_pipeline",
                    "arguments": {"manifest_path": manifest_path},
                    "reason": f"The {step} engine must produce its canonical artifact.",
                }])
            self.store.complete_step(run_id, step)
            self.store.append_event(run_id, "step.completed", {"step": step})
            return "advanced"
        except Exception as exc:
            self.store.set_step_status(run_id, step, "failed", error=str(exc))
            self.store.append_event(run_id, "step.failed", {"step": step, "error": str(exc)})
            return "blocked"

    def _execute_local_generation(
        self,
        run_id: str,
        *,
        provider: str,
        executor: Callable[[], dict[str, Any]],
    ) -> dict[str, Any]:
        attempt = GenerationAttempt.start(
            self.store,
            run_id=run_id,
            intent="generate_keyframes",
            kind="image",
            provider=provider,
            model="automatic",
            monotonic=self.monotonic,
            metric_sink=self.generation_metric_sink,
        )
        try:
            result = executor()
        except Exception as exc:
            attempt.fail(exc)
            raise
        frames = result.get("frames") if isinstance(result.get("frames"), list) else []
        attempt.complete(model=str(result.get("model") or "automatic"), artifact_count=len(frames))
        return result

    def _block(self, run_id: str, step: str, status: str, actions: list[dict[str, Any]]) -> str:
        self.store.set_step_status(run_id, step, status, next_actions=actions)
        self.store.append_event(run_id, "step.blocked", {"step": step, "status": status, "next_actions": actions})
        return "blocked"

    @staticmethod
    def _ensure_evaluation_request(manifest_path: str | Path) -> None:
        manifest_file = Path(manifest_path).expanduser().resolve()
        manifest = load_manifest(manifest_file)
        if any(item.get("role") == "evaluation-request" for item in manifest.get("artifacts", [])):
            return
        request = {
            "schema_version": 1,
            "run_id": manifest["run_id"],
            "lane": manifest["lane"],
            "checks": [
                "hook_alignment",
                "claim_grounding",
                "character_product_consistency",
                "text_legibility",
                "voice_exactness",
                "caption_safe_zones",
                "pacing",
                "cta_clarity",
            ],
            "output_contract": {"passed": "boolean", "score": "0-100", "scene_failures": "list", "regeneration_instructions": "list"},
        }
        path = manifest_file.parent / "evaluation-request.json"
        path.write_text(json.dumps(request, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        add_artifact(manifest, role="evaluation-request", path=path, provider="agent-evaluator")
        write_manifest(manifest_file, manifest)

    @staticmethod
    def _artifact_json(artifacts: list[dict[str, Any]], role: str) -> dict[str, Any]:
        item = next((value for value in reversed(artifacts) if value.get("role") == role), None)
        if not item:
            return {}
        try:
            value = json.loads(Path(item["path"]).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    def _envelope(self, state: dict[str, Any]) -> dict[str, Any]:
        manifest = load_manifest(state["manifest_path"])
        current = next((step for step in state["steps"] if step["step_id"] == state["current_step"]), None)
        artifacts: dict[str, str] = {}
        artifact_records: list[dict[str, Any]] = []
        for artifact in manifest.get("artifacts", []):
            key = str(artifact.get("role") or "artifact").replace("-", "_")
            artifacts[key] = str(artifact.get("path") or "")
            artifact_records.append(artifact)
        return {
            "ok": state["status"] != "failed",
            **state,
            "brief": manifest.get("brief", {}),
            "providers": manifest.get("providers", {}),
            "publish": manifest.get("publish", {}),
            "composer": manifest.get("studio", {}).get("composer", {}),
            "user_prompt": manifest.get("studio", {}).get("user_prompt", ""),
            "next_actions": current["next_actions"] if current else [],
            "artifacts": artifacts,
            "artifact_records": artifact_records,
            "approval_required": state["status"] == "awaiting_approval",
            "cost": state["budget"],
        }
