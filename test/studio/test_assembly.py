from __future__ import annotations

from pathlib import Path

from hivemind_content_studio.assembly import assemble_run, export_capcut_handoff
from hivemind_content_studio.planner import plan
from hivemind_content_studio.private_access import private_media_sidecar, staged_private_media
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

    final = Path(result["video"])
    assert not final.is_file()  # final video is encrypted at rest
    assert private_media_sidecar(final).is_file()
    with staged_private_media(final, directory=tmp_path) as staged:
        qa = qa_video(staged, require_audio=False)
    assert qa["ok"]
    assert (qa["width"], qa["height"]) == (1080, 1920)
    assert not (Path(manifest).parent / "assembly").exists()  # no plaintext intermediates remain


def test_capcut_handoff_is_a_portable_timeline_not_a_private_project_format(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: handoff\nlane: stickman-performance-ad\nscenes:\n  - beat: One\n", encoding="utf-8")
    manifest = plan(brief)
    render_stickman_frames(manifest)

    result = export_capcut_handoff(manifest)

    assert Path(result["timeline_csv"]).is_file()
    assert Path(result["readme"]).read_text(encoding="utf-8").startswith("# CapCut handoff")
