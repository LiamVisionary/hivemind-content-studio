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


# Captured verbatim from a real `podcli process --top 3` run (2026-08-20),
# ANSI codes and all. Podcli writes no manifest, so this printout is the only
# place its picks are described.
REAL_PODCLI_STDOUT = (
    "  [3/4] Scoring clips (fast heuristic mode)...\n"
    "\n"
    "         \x1b[1m3/3 clips selected:\x1b[0m\n"
    "          ✓ 1. [0:00 → +22s] (10pts) Here's the thing nobody tells you about raising mo\n"
    "          ✓ 2. [1:36 → +37s] (14/20) And then you spend seven months pretending you don\n"
    "          ✓ 3. [2:10 → +37s] (14/20) Turns out most people can't choose between eleven.\n"
)


def test_parses_podcli_selection_from_stdout():
    from auto_clipper.podcli import parse_selected_clips

    clips = parse_selected_clips(REAL_PODCLI_STDOUT)

    assert [(c["start_seconds"], c["end_seconds"]) for c in clips] == [
        (0.0, 22.0),
        (96.0, 133.0),
        (130.0, 167.0),
    ]
    assert clips[0]["text"].startswith("Here's the thing")
    # "14/20" carries a scale and normalizes; "10pts" does not and stays None.
    assert clips[1]["score"] == 0.7
    assert clips[0]["score"] is None
    assert clips[0]["raw_score"] == "10pts"


def test_rendered_clip_files_excludes_intermediates_and_thumbnails(tmp_path):
    """A bare glob turned a --top 3 run into nine clip rows.

    Podcli leaves a pre-outro intermediate beside each clip and a thumbnail
    frame per clip. Importing those meant a thumbnail frame could reach the
    approval queue as a postable clip.
    """
    from auto_clipper.podcli import rendered_clip_files

    for name in [
        "Heres_the_thing_short.mp4",
        "Heres_the_thing_short_with_thumb.mp4.outro_scaled.mp4",
        "Turns_out_most_people_short.mp4",
        "Turns_out_most_people_short_with_thumb.mp4.outro_scaled.mp4",
    ]:
        (tmp_path / name).write_bytes(b"x")
    thumbs = tmp_path / "thumbnails" / "clip_1"
    thumbs.mkdir(parents=True)
    (thumbs / "thumb_frame.mp4").write_bytes(b"x")

    assert [p.name for p in rendered_clip_files(tmp_path)] == [
        "Heres_the_thing_short.mp4",
        "Turns_out_most_people_short.mp4",
    ]


def test_import_uses_the_selection_not_a_directory_listing(conn, cfg, tmp_path):
    from auto_clipper import db
    from auto_clipper.podcli import import_podcli_outputs

    source_id = db.add_source(
        conn,
        source_ref="/tmp/source.mp4",
        source_type="file",
        creator="Creator",
        title="Source",
        duration_seconds=180,
        local_path="/tmp/source.mp4",
        metadata_path=None,
        thumbnail_path=None,
        transcript_path=None,
        provenance={},
    )
    run_id = db.create_run(
        conn, source_id=source_id, top_n=3, style="branded",
        output_dir=str(tmp_path), podcli_command=None,
    )
    for name in [
        "Heres_the_thing_nobody_tells_you_about_raising_mon_short.mp4",
        "Heres_the_thing_nobody_tells_you_about_raising_mon_short_with_thumb.mp4.outro_scaled.mp4",
        "And_then_you_spend_seven_months_pretending_you_don_short.mp4",
        "Turns_out_most_people_cant_choose_between_eleven_short.mp4",
    ]:
        (tmp_path / name).write_bytes(b"x")

    created = import_podcli_outputs(conn, run_id, tmp_path, REAL_PODCLI_STDOUT)

    assert created == 3
    rows = db.list_clips(conn, run_id)
    assert [r["slug"] for r in rows] == ["clip-01", "clip-02", "clip-03"]
    # Every row carries a real range and the clip's own opening line, so the
    # semantic pass has something to score.
    assert all(r["start_seconds"] is not None and r["end_seconds"] is not None for r in rows)
    assert rows[0]["transcript_excerpt"].startswith("Here's the thing")
    assert rows[0]["output_path"].endswith("raising_mon_short.mp4")
    assert "outro_scaled" not in " ".join(r["output_path"] for r in rows)


def test_import_still_falls_back_to_files_when_stdout_says_nothing(conn, cfg, tmp_path):
    from auto_clipper import db
    from auto_clipper.podcli import import_podcli_outputs

    source_id = db.add_source(
        conn, source_ref="/tmp/s.mp4", source_type="file", creator="C", title="S",
        duration_seconds=60, local_path="/tmp/s.mp4", metadata_path=None,
        thumbnail_path=None, transcript_path=None, provenance={},
    )
    run_id = db.create_run(
        conn, source_id=source_id, top_n=1, style="branded",
        output_dir=str(tmp_path), podcli_command=None,
    )
    (tmp_path / "clip_short.mp4").write_bytes(b"x")

    created = import_podcli_outputs(conn, run_id, tmp_path, "no selection printed")

    assert created == 1
    assert db.list_clips(conn, run_id)[0]["rationale"] == "Imported from Podcli output directory."


def test_import_recovers_the_clips_real_text_from_the_transcript(conn, cfg, tmp_path):
    """Podcli prints ~50 truncated characters; the hook writer needs the real text."""
    import json as _json

    from auto_clipper import db
    from auto_clipper.podcli import import_podcli_outputs

    transcript = tmp_path / "source.podcli.json"
    transcript.write_text(
        _json.dumps(
            {
                "segments": [
                    {"text": "Here's the thing nobody tells you about raising money.", "start": 0.0, "end": 4.0},
                    {"text": "The round is priced by your worst month.", "start": 4.0, "end": 8.0},
                    {"text": "Not your best one.", "start": 8.0, "end": 12.0},
                    {"text": "Something from much later in the episode.", "start": 300.0, "end": 305.0},
                ]
            }
        ),
        encoding="utf-8",
    )
    source_id = db.add_source(
        conn, source_ref="/tmp/s.mp4", source_type="file", creator="C", title="S",
        duration_seconds=400, local_path="/tmp/s.mp4", metadata_path=None,
        thumbnail_path=None, transcript_path=None, provenance={},
    )
    run_id = db.create_run(
        conn, source_id=source_id, top_n=1, style="branded",
        output_dir=str(tmp_path), podcli_command=None,
    )
    (tmp_path / "Heres_the_thing_nobody_tells_you_about_raising_mon_short.mp4").write_bytes(b"x")
    stdout = "  ✓ 1. [0:00 → +22s] (10pts) Here's the thing nobody tells you about raising mo\n"

    import_podcli_outputs(conn, run_id, tmp_path, stdout, transcript=transcript)

    excerpt = db.list_clips(conn, run_id)[0]["transcript_excerpt"]
    assert "priced by your worst month" in excerpt
    assert "Not your best one." in excerpt
    assert "much later in the episode" not in excerpt


def test_import_keeps_the_printed_line_when_there_is_no_transcript(conn, cfg, tmp_path):
    from auto_clipper import db
    from auto_clipper.podcli import import_podcli_outputs

    source_id = db.add_source(
        conn, source_ref="/tmp/s.mp4", source_type="file", creator="C", title="S",
        duration_seconds=60, local_path="/tmp/s.mp4", metadata_path=None,
        thumbnail_path=None, transcript_path=None, provenance={},
    )
    run_id = db.create_run(
        conn, source_id=source_id, top_n=1, style="branded",
        output_dir=str(tmp_path), podcli_command=None,
    )
    (tmp_path / "Heres_the_thing_short.mp4").write_bytes(b"x")
    stdout = "  ✓ 1. [0:00 → +22s] (10pts) Here's the thing\n"

    import_podcli_outputs(conn, run_id, tmp_path, stdout, transcript=None)

    assert db.list_clips(conn, run_id)[0]["transcript_excerpt"] == "Here's the thing"
