from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_no_duplicate_publisher_implementations_or_render_auto_upload() -> None:
    assert not (ROOT / "app" / "services" / "upload_post.py").exists()
    assert not (ROOT / "src" / "auto_clipper" / "postiz.py").exists()
    task = (ROOT / "app" / "services" / "task.py").read_text(encoding="utf-8")
    assert "auto_upload" not in task
    assert "cross_post_video" not in task


def test_shared_skill_bundle_is_complete_and_has_canonical_entry() -> None:
    snapshots = sorted((ROOT / "skills" / "shared").glob("*/SKILL.md"))
    assert len(snapshots) == 19
    assert (ROOT / "skills" / "shared" / "higgsfield-generate" / "SKILL.md").is_file()
    assert (ROOT / "skills" / "shared" / "higgsfield-api-quirks" / "SKILL.md").is_file()
    assert (ROOT / "skills" / "shared" / "ai-ugc-production-pipeline" / "SKILL.md").is_file()
    assert (ROOT / "skills" / "hivemind-content-studio" / "SKILL.md").is_file()


def test_mcp_surface_covers_the_two_complete_ad_lanes() -> None:
    source = (ROOT / "src" / "hivemind_content_studio" / "mcp_server.py").read_text(encoding="utf-8")
    for tool_name in (
        "run_agent_script_generation",
        "attach_agent_script",
        "render_stickman_ad_frames",
        "generate_higgsfield_consumer_media",
        "generate_higgsfield_cloud_media",
        "generate_muapi_media",
        "generate_elevenlabs_voice_lines",
        "assemble_content_run",
        "export_capcut_timeline_handoff",
        "get_generation_telemetry",
    ):
        assert f"def {tool_name}(" in source
