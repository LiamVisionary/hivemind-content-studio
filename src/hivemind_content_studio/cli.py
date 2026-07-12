"""Unified command-line entry point for agents and operators."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .agent_runtime import attach_script, run_registered_agent_script
from .approval_config import load_approval_ledger, operator_token
from .assembly import assemble_run, export_capcut_handoff
from .capability_router import CapabilityPolicy, CapabilityRouter
from .config import load_config
from .doctor import collect_checks
from .intent_service import ContentIntentService
from .manifest import approve_manifest, load_manifest
from .metrics import record_metrics, summarize_metrics
from .media_studio import generate_video as generate_media_studio_video, list_media_studio_tools, media_studio_status
from .generation import generate_higgsfield_cloud_asset, generate_higgsfield_consumer_asset, generate_muapi_asset, record_generated_asset
from .generation_telemetry import generation_telemetry_snapshot, record_hivemind_generation_metric
from .mcp_http import McpHttpClient
from .planner import plan
from .orchestrator import ContentOrchestrator
from .providers import provider_report
from .publishing import dry_run, execute_publish, prepare_publish
from .qa import qa_video
from .stickman import render_stickman_frames
from .template_catalog import template_by_id, template_report
from .voice import generate_elevenlabs_lines


MCP_WRITE_CONFIRMATION = "MCP_WRITE"


def _orchestrator() -> ContentOrchestrator:
    return ContentOrchestrator(generation_metric_sink=record_hivemind_generation_metric)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="content-studio", description="Unified local-first content creation and publishing studio")
    sub = parser.add_subparsers(dest="command", required=True)

    doctor = sub.add_parser("doctor", help="Report core and provider readiness without exposing secret values")
    doctor.set_defaults(func=cmd_doctor)

    providers = sub.add_parser("providers", help="Show the canonical provider capability matrix")
    providers.set_defaults(func=cmd_providers)

    templates = sub.add_parser("templates", help="List production templates or show one template's prompt")
    templates.add_argument("template_id", nargs="?", default="", help="Template id to show in full; omit to list the catalog")
    templates.set_defaults(func=cmd_templates)

    telemetry = sub.add_parser("telemetry", help="Inspect privacy-safe generation performance and reliability")
    telemetry_sub = telemetry.add_subparsers(dest="telemetry_command", required=True)
    generation_telemetry = telemetry_sub.add_parser("generations", help="Summarize run-associated image, video, voice, and music generation")
    generation_telemetry.add_argument("--limit", type=int, default=100)
    generation_telemetry.set_defaults(func=cmd_generation_telemetry)

    planner = sub.add_parser("plan", help="Create a canonical run from a YAML brief")
    planner.add_argument("brief")
    planner.add_argument("--lane", choices=["animation", "first-frame-animation-ad", "stickman-performance-ad", "static-text-ad", "faceless", "clip", "social-post"])
    planner.set_defaults(func=cmd_plan)

    run = sub.add_parser("run", help="Create, inspect, resume, retry, or cancel durable agent runs")
    run_sub = run.add_subparsers(dest="run_command", required=True)
    run_execute = run_sub.add_parser("execute")
    run_execute.add_argument("brief")
    run_execute.add_argument("--privacy", choices=["local-only", "local-first", "cloud-allowed"], default="local-first")
    run_execute.add_argument("--max-cost-usd", type=float, default=0.0)
    run_execute.set_defaults(func=cmd_run_execute)
    run_get = run_sub.add_parser("get")
    run_get.add_argument("run_id")
    run_get.set_defaults(func=cmd_run_get)
    run_list = run_sub.add_parser("list")
    run_list.add_argument("--status")
    run_list.add_argument("--limit", type=int, default=100)
    run_list.set_defaults(func=cmd_run_list)
    run_resume = run_sub.add_parser("resume")
    run_resume.add_argument("run_id")
    run_resume.set_defaults(func=cmd_run_resume)
    run_retry = run_sub.add_parser("retry")
    run_retry.add_argument("run_id")
    run_retry.add_argument("step_id")
    run_retry.set_defaults(func=cmd_run_retry)
    run_cancel = run_sub.add_parser("cancel")
    run_cancel.add_argument("run_id")
    run_cancel.add_argument("--reason", required=True)
    run_cancel.set_defaults(func=cmd_run_cancel)

    intent = sub.add_parser("intent", help="Route or execute a provider-neutral content capability")
    intent_sub = intent.add_subparsers(dest="intent_command", required=True)
    for name, handler in (("route", cmd_intent_route), ("execute", cmd_intent_execute)):
        intent_command = intent_sub.add_parser(name)
        intent_command.add_argument("run_id")
        intent_command.add_argument("intent")
        intent_command.add_argument("--provider")
        intent_command.add_argument("--estimated-cost-usd", type=float)
        if name == "execute":
            intent_command.add_argument("--approval-token")
        intent_command.set_defaults(func=handler)

    script = sub.add_parser("script", help="Generate or attach a script through a vendor-neutral agent contract")
    script_sub = script.add_subparsers(dest="script_command", required=True)
    script_run = script_sub.add_parser("run")
    script_run.add_argument("manifest")
    script_run.add_argument("--runtime", required=True, help="Operator-registered runtime id")
    script_run.add_argument("--confirm", default="")
    script_run.set_defaults(func=cmd_script_run)
    script_attach = script_sub.add_parser("attach")
    script_attach.add_argument("manifest")
    script_attach.add_argument("script")
    script_attach.add_argument("--runtime", default="external-agent")
    script_attach.set_defaults(func=cmd_script_attach)

    stickman = sub.add_parser("render-stickman", help="Render deterministic black-line keyframes for a stickman ad run")
    stickman.add_argument("manifest")
    stickman.set_defaults(func=cmd_render_stickman)

    generation = sub.add_parser("generate", help="Execute an explicit paid media-provider request")
    generation_sub = generation.add_subparsers(dest="generation_command", required=True)
    higgs_consumer = generation_sub.add_parser("higgsfield-consumer")
    higgs_consumer.add_argument("kind", choices=["keyframe", "motion"])
    higgs_consumer.add_argument("model")
    higgs_consumer.add_argument("prompt")
    higgs_consumer.add_argument("output")
    higgs_consumer.add_argument("--aspect-ratio", default="9:16")
    higgs_consumer.add_argument("--source")
    higgs_consumer.add_argument("--duration", type=float)
    higgs_consumer.add_argument("--confirm", default="")
    _add_manifest_recording_args(higgs_consumer)
    higgs_consumer.set_defaults(func=cmd_generate_higgsfield_consumer)
    higgs_cloud = generation_sub.add_parser("higgsfield-cloud")
    higgs_cloud.add_argument("model")
    higgs_cloud.add_argument("payload")
    higgs_cloud.add_argument("output")
    higgs_cloud.add_argument("--confirm", default="")
    _add_manifest_recording_args(higgs_cloud)
    higgs_cloud.set_defaults(func=cmd_generate_higgsfield_cloud)
    muapi = generation_sub.add_parser("muapi")
    muapi.add_argument("endpoint")
    muapi.add_argument("payload")
    muapi.add_argument("output")
    muapi.add_argument("--state")
    muapi.add_argument("--confirm", default="")
    _add_manifest_recording_args(muapi)
    muapi.set_defaults(func=cmd_generate_muapi)

    voice = sub.add_parser("voice", help="Generate exact line-level voice assets")
    voice_sub = voice.add_subparsers(dest="voice_command", required=True)
    elevenlabs = voice_sub.add_parser("elevenlabs")
    elevenlabs.add_argument("manifest")
    elevenlabs.add_argument("--confirm", default="")
    elevenlabs.set_defaults(func=cmd_voice_elevenlabs)

    assemble = sub.add_parser("assemble", help="Assemble scene videos or keyframes with FFmpeg")
    assemble.add_argument("manifest")
    assemble.add_argument("--output")
    assemble.set_defaults(func=cmd_assemble)

    capcut = sub.add_parser("capcut-handoff", help="Export a portable CapCut asset/timeline package")
    capcut.add_argument("manifest")
    capcut.add_argument("--output-dir")
    capcut.set_defaults(func=cmd_capcut_handoff)

    render = sub.add_parser("render-faceless", help="Render a faceless manifest with the embedded MoneyPrinterTurbo engine")
    render.add_argument("manifest")
    render.set_defaults(func=cmd_render_faceless)

    qa = sub.add_parser("qa", help="Probe a rendered video and extract a representative frame")
    qa.add_argument("video")
    qa.add_argument("--allow-silent", action="store_true")
    qa.add_argument("--output-dir")
    qa.set_defaults(func=cmd_qa)

    clip = sub.add_parser("clip", help="Run the embedded Auto Clipper compatibility CLI")
    clip.add_argument("clip_args", nargs=argparse.REMAINDER)
    clip.set_defaults(func=cmd_clip)

    approve = sub.add_parser("approve", help="Approve a run and record rights review")
    approve.add_argument("manifest")
    approve.add_argument("--reviewer", required=True)
    approve.add_argument("--rights-note", required=True)
    approve.add_argument("--approval-token", required=True, help="One-time exact-scope receipt from an operator decision")
    approve.set_defaults(func=cmd_approve)

    approval = sub.add_parser("approval", help="Request and decide exact-scope operator approvals")
    approval_sub = approval.add_subparsers(dest="approval_command", required=True)
    approval_request = approval_sub.add_parser("request-run")
    approval_request.add_argument("manifest")
    approval_request.add_argument("--reason", default="Approve rights, claims, and readiness for this content run")
    approval_request.set_defaults(func=cmd_approval_request_run)
    approval_list = approval_sub.add_parser("list")
    approval_list.add_argument("--run-id")
    approval_list.add_argument("--status")
    approval_list.set_defaults(func=cmd_approval_list)
    approval_decide = approval_sub.add_parser("decide")
    approval_decide.add_argument("approval_id")
    approval_decide.add_argument("--decision", choices=["approve", "deny"], required=True)
    approval_decide.add_argument("--decided-by", default="owner")
    approval_decide.set_defaults(func=cmd_approval_decide)

    mcp_tools = sub.add_parser("mcp-tools", help="List tools from Palmier Pro or another Streamable HTTP MCP")
    mcp_tools.add_argument("--url", default=None)
    mcp_tools.set_defaults(func=cmd_mcp_tools)

    mcp_call = sub.add_parser("mcp-call", help="Call a write-capable local media MCP tool with an explicit mutation gate")
    mcp_call.add_argument("tool")
    mcp_call.add_argument("--arguments", default="{}", help="JSON object")
    mcp_call.add_argument("--url", default=None)
    mcp_call.add_argument("--confirm", default="")
    mcp_call.set_defaults(func=cmd_mcp_call)

    media_studio = sub.add_parser("media-studio", help="Use the HivemindOS-configured Media Studio image-to-video MCP")
    media_sub = media_studio.add_subparsers(dest="media_studio_command", required=True)
    media_status = media_sub.add_parser("status")
    media_status.set_defaults(func=cmd_media_studio_status)
    media_tools = media_sub.add_parser("tools")
    media_tools.set_defaults(func=cmd_media_studio_tools)
    media_generate = media_sub.add_parser("generate-video")
    media_generate.add_argument("image")
    media_generate.add_argument("--prompt", required=True)
    media_generate.add_argument("--duration", type=float, default=4)
    media_generate.add_argument("--workflow-id")
    media_generate.add_argument("--output-dir")
    media_generate.add_argument("--confirm", default="")
    media_generate.set_defaults(func=cmd_media_studio_generate)

    publish = sub.add_parser("publish", help="Prepare, validate, or execute approval-gated social publishing")
    publish_sub = publish.add_subparsers(dest="publish_command", required=True)
    prepare = publish_sub.add_parser("prepare")
    prepare.add_argument("manifest")
    prepare.add_argument("--video")
    prepare.add_argument("--media", action="append", default=[], help="Image/video path; repeat for image carousels")
    prepare.add_argument("--text-only", action="store_true")
    prepare.add_argument("--title", required=True)
    prepare.add_argument("--caption", default="")
    prepare.add_argument("--platforms", required=True)
    prepare.add_argument("--provider", choices=["postiz", "upload-post"], default="postiz")
    prepare.add_argument("--scheduled-at")
    prepare.set_defaults(func=cmd_publish_prepare)
    validate = publish_sub.add_parser("dry-run")
    validate.add_argument("manifest")
    validate.set_defaults(func=cmd_publish_dry_run)
    execute = publish_sub.add_parser("execute")
    execute.add_argument("manifest")
    execute.add_argument("--confirm", default="")
    execute.set_defaults(func=cmd_publish_execute)

    metrics = sub.add_parser("metrics", help="Record and summarize per-run distribution outcomes")
    metrics_sub = metrics.add_subparsers(dest="metrics_command", required=True)
    record = metrics_sub.add_parser("record")
    record.add_argument("manifest")
    record.add_argument("--platform", required=True)
    record.add_argument("--views", type=int, default=0)
    record.add_argument("--completed-views", type=int, default=0)
    record.add_argument("--clicks", type=int, default=0)
    record.add_argument("--conversions", type=int, default=0)
    record.add_argument("--revenue", type=float, default=0.0)
    record.set_defaults(func=cmd_metrics_record)
    summary = metrics_sub.add_parser("summary")
    summary.add_argument("manifest")
    summary.set_defaults(func=cmd_metrics_summary)
    return parser


def _add_manifest_recording_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--manifest", help="Canonical manifest to receive the generated asset")
    parser.add_argument("--role", choices=["keyframe", "scene-video", "music", "voice-line"], help="Artifact role when --manifest is used")
    parser.add_argument("--scene", type=int, help="One-based scene number for the artifact")


def _record_if_requested(args: argparse.Namespace, result: dict) -> None:
    if not args.manifest:
        return
    if not args.role:
        raise ValueError("--role is required with --manifest")
    record_generated_asset(args.manifest, result, role=args.role, scene=args.scene)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, indent=2), file=sys.stderr)
        return 1


def cmd_doctor(_args: argparse.Namespace) -> int:
    report = collect_checks()
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


def cmd_providers(_args: argparse.Namespace) -> int:
    print(json.dumps(provider_report(), indent=2, sort_keys=True))
    return 0


def cmd_templates(args: argparse.Namespace) -> int:
    if args.template_id:
        print(json.dumps(template_by_id(args.template_id).as_dict(), indent=2, sort_keys=True))
        return 0
    listing = [
        {key: row[key] for key in ("id", "category", "title", "lane", "aspect_ratio", "duration_seconds", "description")}
        for row in template_report()
    ]
    print(json.dumps(listing, indent=2, sort_keys=True))
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    manifest = plan(args.brief, lane=args.lane)
    print(json.dumps({"ok": True, "manifest": str(manifest)}, indent=2))
    return 0


def cmd_run_execute(args: argparse.Namespace) -> int:
    result = _orchestrator().execute_content_run(
        args.brief,
        policy={"privacy": args.privacy},
        budget={"max_cost_usd": args.max_cost_usd, "spent_usd": 0.0},
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def cmd_run_get(args: argparse.Namespace) -> int:
    print(json.dumps(_orchestrator().get_run(args.run_id), indent=2, sort_keys=True))
    return 0


def cmd_run_list(args: argparse.Namespace) -> int:
    print(json.dumps({"ok": True, "runs": _orchestrator().list_runs(status=args.status, limit=args.limit)}, indent=2, sort_keys=True))
    return 0


def cmd_run_resume(args: argparse.Namespace) -> int:
    print(json.dumps(_orchestrator().resume_run(args.run_id), indent=2, sort_keys=True))
    return 0


def cmd_run_retry(args: argparse.Namespace) -> int:
    print(json.dumps(_orchestrator().retry_step(args.run_id, args.step_id), indent=2, sort_keys=True))
    return 0


def cmd_run_cancel(args: argparse.Namespace) -> int:
    print(json.dumps(_orchestrator().cancel_run(args.run_id, args.reason), indent=2, sort_keys=True))
    return 0


def _intent_policy(orchestrator: ContentOrchestrator, run_id: str, estimated_cost: float | None) -> CapabilityPolicy:
    state = orchestrator.store.get_run(run_id)
    policy = state["policy"]
    budget = state["budget"]
    remaining = max(0.0, float(budget.get("max_cost_usd") or 0) - float(budget.get("spent_usd") or 0))
    return CapabilityPolicy(
        privacy=str(policy.get("privacy") or "local-first"),  # type: ignore[arg-type]
        max_cost_usd=remaining,
        allowed_providers=tuple(policy.get("allowed_providers") or ()),
        allow_unready=bool(policy.get("allow_unready", False)),
        allow_unknown_paid_cost=estimated_cost is not None or bool(policy.get("allow_unknown_paid_cost", False)),
    )


def cmd_intent_route(args: argparse.Namespace) -> int:
    orchestrator = _orchestrator()
    decision = CapabilityRouter().select(
        args.intent,
        _intent_policy(orchestrator, args.run_id, args.estimated_cost_usd),
        provider_override=args.provider,
    )
    print(json.dumps({"ok": True, "run_id": args.run_id, "decision": decision}, indent=2, sort_keys=True))
    return 0


def cmd_intent_execute(args: argparse.Namespace) -> int:
    orchestrator = _orchestrator()
    service = ContentIntentService(
        orchestrator,
        CapabilityRouter(),
        load_approval_ledger(required=False),
        generation_metric_sink=record_hivemind_generation_metric,
    )
    result = service.execute_intent(
        args.run_id,
        args.intent,
        estimated_cost_usd=args.estimated_cost_usd,
        provider_override=args.provider,
        approval_token=args.approval_token,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def cmd_generation_telemetry(args: argparse.Namespace) -> int:
    print(json.dumps(generation_telemetry_snapshot(_orchestrator().store, limit=args.limit), indent=2, sort_keys=True))
    return 0


def cmd_script_run(args: argparse.Namespace) -> int:
    print(json.dumps({"ok": True, "result": run_registered_agent_script(args.manifest, runtime_id=args.runtime, confirm=args.confirm)}, indent=2))
    return 0


def cmd_script_attach(args: argparse.Namespace) -> int:
    print(json.dumps({"ok": True, "result": attach_script(args.manifest, args.script, runtime=args.runtime)}, indent=2))
    return 0


def cmd_render_stickman(args: argparse.Namespace) -> int:
    print(json.dumps({"ok": True, "result": render_stickman_frames(args.manifest)}, indent=2))
    return 0


def cmd_generate_higgsfield_consumer(args: argparse.Namespace) -> int:
    result = generate_higgsfield_consumer_asset(kind=args.kind, model=args.model, prompt=args.prompt, aspect_ratio=args.aspect_ratio, output=args.output, source=args.source, duration_seconds=args.duration, confirm=args.confirm)
    _record_if_requested(args, result)
    print(json.dumps({"ok": True, "result": result}, indent=2))
    return 0


def cmd_generate_higgsfield_cloud(args: argparse.Namespace) -> int:
    result = generate_higgsfield_cloud_asset(model_id=args.model, payload=args.payload, output=args.output, confirm=args.confirm)
    _record_if_requested(args, result)
    print(json.dumps({"ok": True, "result": result}, indent=2))
    return 0


def cmd_generate_muapi(args: argparse.Namespace) -> int:
    state = args.state or str(Path(args.output).expanduser().resolve().parent / "muapi-state.json")
    result = generate_muapi_asset(endpoint=args.endpoint, payload=args.payload, output=args.output, state=state, confirm=args.confirm)
    _record_if_requested(args, result)
    print(json.dumps({"ok": True, "result": result}, indent=2))
    return 0


def cmd_voice_elevenlabs(args: argparse.Namespace) -> int:
    print(json.dumps({"ok": True, "result": generate_elevenlabs_lines(args.manifest, confirm=args.confirm)}, indent=2))
    return 0


def cmd_assemble(args: argparse.Namespace) -> int:
    print(json.dumps({"ok": True, "result": assemble_run(args.manifest, output=args.output)}, indent=2))
    return 0


def cmd_capcut_handoff(args: argparse.Namespace) -> int:
    print(json.dumps({"ok": True, "result": export_capcut_handoff(args.manifest, output_dir=args.output_dir)}, indent=2))
    return 0


def cmd_render_faceless(args: argparse.Namespace) -> int:
    from .faceless import render_faceless

    print(json.dumps({"ok": True, "result": render_faceless(args.manifest)}, indent=2, default=str))
    return 0


def cmd_qa(args: argparse.Namespace) -> int:
    result = qa_video(args.video, output_dir=args.output_dir, require_audio=not args.allow_silent)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


def cmd_clip(args: argparse.Namespace) -> int:
    from auto_clipper.cli import main as auto_clipper_main

    return auto_clipper_main(args.clip_args)


def cmd_approve(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest).expanduser().resolve()
    manifest = load_manifest(manifest_path)
    ledger = load_approval_ledger(required=True)
    assert ledger is not None
    ledger.consume(
        args.approval_token,
        run_id=manifest["run_id"],
        kind="run-approval",
        provider="content-studio",
        amount_usd=0,
        target=str(manifest_path),
    )
    manifest = approve_manifest(args.manifest, reviewer=args.reviewer, rights_note=args.rights_note)
    print(json.dumps({"ok": True, "approval": manifest["approval"]}, indent=2))
    return 0


def cmd_approval_request_run(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest).expanduser().resolve()
    manifest = load_manifest(manifest_path)
    ledger = load_approval_ledger(required=True)
    assert ledger is not None
    approval = ledger.request(
        run_id=manifest["run_id"],
        kind="run-approval",
        provider="content-studio",
        amount_usd=0,
        target=str(manifest_path),
        reason=args.reason,
    )
    print(json.dumps({"ok": True, "status": "awaiting_approval", "approval": approval}, indent=2, sort_keys=True))
    return 0


def cmd_approval_list(args: argparse.Namespace) -> int:
    ledger = load_approval_ledger(required=True)
    assert ledger is not None
    print(json.dumps({"ok": True, "approvals": ledger.list(run_id=args.run_id, status=args.status)}, indent=2, sort_keys=True))
    return 0


def cmd_approval_decide(args: argparse.Namespace) -> int:
    ledger = load_approval_ledger(required=True)
    assert ledger is not None
    token = operator_token()
    if args.decision == "approve":
        approval = ledger.approve(args.approval_id, operator_token=token, decided_by=args.decided_by)
    else:
        approval = ledger.deny(args.approval_id, operator_token=token, decided_by=args.decided_by)
    print(json.dumps({"ok": True, "approval": approval}, indent=2, sort_keys=True))
    return 0


def _mcp_client(url: str | None) -> McpHttpClient:
    return McpHttpClient(url or load_config().palmier_mcp_url)


def cmd_mcp_tools(args: argparse.Namespace) -> int:
    print(json.dumps({"ok": True, "tools": _mcp_client(args.url).list_tools()}, indent=2))
    return 0


def cmd_mcp_call(args: argparse.Namespace) -> int:
    if args.confirm != MCP_WRITE_CONFIRMATION:
        raise ValueError(f"Refusing MCP mutation without --confirm {MCP_WRITE_CONFIRMATION}")
    arguments = json.loads(args.arguments)
    if not isinstance(arguments, dict):
        raise ValueError("--arguments must be a JSON object")
    print(json.dumps({"ok": True, "result": _mcp_client(args.url).call_tool(args.tool, arguments)}, indent=2))
    return 0


def cmd_media_studio_status(_args: argparse.Namespace) -> int:
    status = media_studio_status()
    print(json.dumps(status, indent=2, sort_keys=True))
    return 0 if status["configured"] and status["auth_present"] and status["reachable"] else 1


def cmd_media_studio_tools(_args: argparse.Namespace) -> int:
    print(json.dumps({"ok": True, "tools": list_media_studio_tools()}, indent=2))
    return 0


def cmd_media_studio_generate(args: argparse.Namespace) -> int:
    if args.confirm != "MEDIA_GENERATE":
        raise ValueError("Refusing Media Studio generation without --confirm MEDIA_GENERATE")
    result = generate_media_studio_video(image_path=args.image, prompt=args.prompt, duration_seconds=args.duration, workflow_id=args.workflow_id, output_dir=args.output_dir)
    print(json.dumps({"ok": True, "result": result}, indent=2))
    return 0


def cmd_publish_prepare(args: argparse.Namespace) -> int:
    draft = prepare_publish(args.manifest, video=args.video, media=args.media, text_only=args.text_only, title=args.title, caption=args.caption, platforms=args.platforms.split(","), provider=args.provider, scheduled_at=args.scheduled_at)
    print(json.dumps({"ok": True, "published": False, "draft": draft}, indent=2))
    return 0


def cmd_publish_dry_run(args: argparse.Namespace) -> int:
    result = dry_run(args.manifest)
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


def cmd_publish_execute(args: argparse.Namespace) -> int:
    print(json.dumps(execute_publish(args.manifest, confirm=args.confirm), indent=2))
    return 0


def cmd_metrics_record(args: argparse.Namespace) -> int:
    entry = record_metrics(args.manifest, platform=args.platform, views=args.views, completed_views=args.completed_views, clicks=args.clicks, conversions=args.conversions, revenue=args.revenue)
    print(json.dumps({"ok": True, "entry": entry}, indent=2))
    return 0


def cmd_metrics_summary(args: argparse.Namespace) -> int:
    print(json.dumps(summarize_metrics(args.manifest), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
