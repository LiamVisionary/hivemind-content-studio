from __future__ import annotations

from hivemind_content_studio.cli import build_parser


def test_cli_exposes_complete_ad_production_surfaces() -> None:
    parser = build_parser()

    assert parser.parse_args(["plan", "brief.yaml", "--lane", "first-frame-animation-ad"]).lane == "first-frame-animation-ad"
    assert parser.parse_args(["plan", "brief.yaml", "--lane", "stickman-performance-ad"]).lane == "stickman-performance-ad"
    assert parser.parse_args(["plan", "brief.yaml", "--lane", "static-text-ad"]).lane == "static-text-ad"
    assert parser.parse_args(["run", "execute", "brief.yaml"]).run_command == "execute"
    assert parser.parse_args(["templates"]).template_id == ""
    assert parser.parse_args(["templates", "ugc-product-ad-15s"]).template_id == "ugc-product-ad-15s"
    assert parser.parse_args(["intent", "execute", "run-1", "generate_keyframes"]).intent_command == "execute"
    assert parser.parse_args(["telemetry", "generations"]).telemetry_command == "generations"
    assert parser.parse_args(["script", "attach", "manifest.json", "script.md", "--runtime", "hermes"]).script_command == "attach"
    assert parser.parse_args(["render-stickman", "manifest.json"]).command == "render-stickman"
    assert parser.parse_args(["voice", "elevenlabs", "manifest.json", "--confirm", "PAID_GENERATE"]).voice_command == "elevenlabs"
    assert parser.parse_args(["assemble", "manifest.json"]).command == "assemble"
    assert parser.parse_args(["capcut-handoff", "manifest.json"]).command == "capcut-handoff"
    generation = parser.parse_args(["generate", "higgsfield-cloud", "model", "payload.json", "out.png", "--manifest", "manifest.json", "--role", "keyframe", "--scene", "1", "--confirm", "PAID_GENERATE"])
    assert generation.generation_command == "higgsfield-cloud"
    assert (generation.manifest, generation.role, generation.scene) == ("manifest.json", "keyframe", 1)
    approval = parser.parse_args(["approval", "request-run", "manifest.json"])
    assert approval.approval_command == "request-run"
    approved = parser.parse_args(["approve", "manifest.json", "--reviewer", "owner", "--rights-note", "cleared", "--approval-token", "receipt"])
    assert approved.approval_token == "receipt"
