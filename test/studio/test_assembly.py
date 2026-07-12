from __future__ import annotations

from pathlib import Path

from hivemind_content_studio.assembly import assemble_run, export_capcut_handoff
from hivemind_content_studio.planner import plan
from hivemind_content_studio.qa import qa_video
from hivemind_content_studio.stickman import render_stickman_frames


def test_stickman_frames_assemble_into_a_vertical_video(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text(
        """id: assembled-stickman
lane: stickman-performance-ad
aspect_ratio: 9:16
scenes:
  - beat: Hook
    overlay: Cheap creative can hold attention
    duration_seconds: 1
  - beat: Payoff
    overlay: Make the idea obvious
    duration_seconds: 1
""",
        encoding="utf-8",
    )
    manifest = plan(brief)
    render_stickman_frames(manifest)

    result = assemble_run(manifest)

    qa = qa_video(result["video"], require_audio=False)
    assert qa["ok"]
    assert (qa["width"], qa["height"]) == (1080, 1920)


def test_capcut_handoff_is_a_portable_timeline_not_a_private_project_format(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: handoff\nlane: stickman-performance-ad\nscenes:\n  - beat: One\n", encoding="utf-8")
    manifest = plan(brief)
    render_stickman_frames(manifest)

    result = export_capcut_handoff(manifest)

    assert Path(result["timeline_csv"]).is_file()
    assert Path(result["readme"]).read_text(encoding="utf-8").startswith("# CapCut handoff")
