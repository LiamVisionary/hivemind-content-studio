from __future__ import annotations

import pytest

from auto_clipper import db
from auto_clipper.scheduling import schedule_run


def test_schedule_blocks_without_approval(conn, cfg):
    source_id = db.add_source(
        conn,
        source_ref="/tmp/source.mp4",
        source_type="file",
        creator="Creator",
        title="Source",
        duration_seconds=60,
        local_path="/tmp/source.mp4",
        metadata_path=None,
        thumbnail_path=None,
        transcript_path=None,
        provenance={},
    )
    run_id = db.create_run(
        conn,
        source_id=source_id,
        top_n=1,
        style="branded",
        output_dir=str(cfg.data_dir / "run"),
        podcli_command=None,
    )
    db.add_clip(conn, run_id=run_id, slug="clip-01", output_path="/tmp/clip.mp4", status="rendered")

    with pytest.raises(db.PolicyError, match="rights_status"):
        schedule_run(conn, cfg, run_id=run_id, platforms=["youtube"], times=["09:00"])


def test_schedule_after_approval_creates_planned_drafts(conn, cfg):
    source_id = db.add_source(
        conn,
        source_ref="/tmp/source.mp4",
        source_type="file",
        creator="Creator",
        title="Source",
        duration_seconds=60,
        local_path="/tmp/source.mp4",
        metadata_path=None,
        thumbnail_path=None,
        transcript_path=None,
        provenance={},
    )
    run_id = db.create_run(
        conn,
        source_id=source_id,
        top_n=1,
        style="branded",
        output_dir=str(cfg.data_dir / "run"),
        podcli_command=None,
    )
    clip_id = db.add_clip(conn, run_id=run_id, slug="clip-01", output_path="/tmp/clip.mp4", status="rendered")
    db.approve_run(conn, run_id=run_id, clip_ids=[clip_id], reviewer="liam", rights_note="approved")

    drafts = schedule_run(conn, cfg, run_id=run_id, platforms=["youtube", "x"], times=["09:00"])

    assert len(drafts) == 2
    rows = conn.execute("SELECT postiz_status FROM post_drafts ORDER BY id").fetchall()
    assert [row["postiz_status"] for row in rows] == ["planned", "planned"]

