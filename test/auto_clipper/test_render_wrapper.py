from __future__ import annotations

from auto_clipper import db
from auto_clipper.podcli import render_run


def test_fake_render_creates_clip_candidates(conn, cfg, monkeypatch):
    source_id = db.add_source(
        conn,
        source_ref="/tmp/source.mp4",
        source_type="file",
        creator="Creator",
        title="Source",
        duration_seconds=300,
        local_path="/tmp/source.mp4",
        metadata_path=None,
        thumbnail_path=None,
        transcript_path=None,
        provenance={},
    )
    monkeypatch.setenv("AUTO_CLIPPER_FAKE_RENDER", "1")

    run_id = render_run(conn, cfg, source_id, top=3, style="branded")

    clips = conn.execute("SELECT slug, status FROM clips WHERE run_id = ? ORDER BY id", (run_id,)).fetchall()
    assert [(row["slug"], row["status"]) for row in clips] == [
        ("clip-01", "rendered"),
        ("clip-02", "rendered"),
        ("clip-03", "rendered"),
    ]


def test_build_command_includes_converted_transcript(conn, cfg, tmp_path, monkeypatch):
    video = tmp_path / "source.mp4"
    video.write_bytes(b"placeholder")
    transcript = tmp_path / "source.vtt"
    transcript.write_text("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello there\n", encoding="utf-8")
    source_id = db.add_source(
        conn,
        source_ref=str(video),
        source_type="file",
        creator="Creator",
        title="Source",
        duration_seconds=1,
        local_path=str(video),
        metadata_path=None,
        thumbnail_path=None,
        transcript_path=str(transcript),
        provenance={},
    )
    monkeypatch.setenv("AUTO_CLIPPER_FAKE_RENDER", "1")

    run_id = render_run(conn, cfg, source_id, top=1, style="branded")

    row = conn.execute("SELECT podcli_command FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert "--transcript" in row["podcli_command"]
    assert ".podcli.json" in row["podcli_command"]


def test_legacy_branded_style_is_supported(conn, cfg, monkeypatch):
    source_id = db.add_source(
        conn,
        source_ref="/tmp/source.mp4",
        source_type="file",
        creator="Creator",
        title="Source",
        duration_seconds=300,
        local_path="/tmp/source.mp4",
        metadata_path=None,
        thumbnail_path=None,
        transcript_path=None,
        provenance={},
    )
    monkeypatch.setenv("AUTO_CLIPPER_FAKE_RENDER", "1")

    run_id = render_run(conn, cfg, source_id, top=1, style="branded-legacy")

    row = conn.execute("SELECT style, podcli_command FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert row["style"] == "branded-legacy"
    assert "--caption-style branded-legacy" in row["podcli_command"]
