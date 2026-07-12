from __future__ import annotations

from auto_clipper import db
from auto_clipper.obsidian import write_run_note, write_source_note


def test_obsidian_notes_do_not_store_secrets(conn, cfg):
    source_id = db.add_source(
        conn,
        source_ref="https://example.com/video",
        source_type="url",
        creator="Creator",
        title="Interesting Episode",
        duration_seconds=120,
        local_path="/tmp/source.mp4",
        metadata_path="/tmp/metadata.json",
        thumbnail_path=None,
        transcript_path=None,
        provenance={"token": "not-a-real-secret"},
    )
    source = conn.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
    source_note = write_source_note(cfg, dict(source))
    run_id = db.create_run(
        conn,
        source_id=source_id,
        top_n=1,
        style="branded",
        output_dir=str(cfg.data_dir / "run"),
        podcli_command=None,
    )
    run_note = write_run_note(conn, cfg, run_id)

    combined = source_note.read_text() + run_note.read_text()
    assert "not-a-real-secret" not in combined
    assert "Scheduling allowed: no" in combined
    assert "Interesting Episode" in combined

