from __future__ import annotations

from auto_clipper import db
from auto_clipper.monetization import list_opportunities, match_run, seed_opportunities, upsert_opportunity


def test_seed_opportunities_lists_where_to_post(conn):
    created = seed_opportunities(conn)

    opportunities = list_opportunities(conn)
    performance = next(item for item in opportunities if item["path"] == "performance_campaign")

    assert created == 5
    assert "tiktok" in performance["platforms"]
    assert "youtube" in performance["platforms"]
    assert "Whop Content Rewards" in performance["content_source"]


def test_match_warns_when_source_is_not_approved(conn):
    source_id = db.add_source(
        conn,
        source_ref="https://example.com/video",
        source_type="url",
        creator="Creator",
        title="Source",
        duration_seconds=300,
        local_path="/tmp/source.mp4",
        metadata_path=None,
        thumbnail_path=None,
        transcript_path=None,
        provenance={},
    )
    run_id = db.create_run(conn, source_id=source_id, top_n=1, style="branded", output_dir="/tmp", podcli_command=None)
    db.add_clip(conn, run_id=run_id, slug="clip-01", score=0.8, output_path="/tmp/clip.mp4", status="rendered")

    seed_opportunities(conn)
    matches = match_run(conn, run_id, niches=["ai"])

    assert matches
    assert any("research" in warning for warning in matches[0]["warnings"])


def test_match_prefers_owned_licensing_for_local_approved_footage(conn):
    source_id = db.add_source(
        conn,
        source_ref="/tmp/liam-owned.mp4",
        source_type="file",
        creator="Liam",
        title="Owned Source",
        duration_seconds=60,
        local_path="/tmp/liam-owned.mp4",
        metadata_path=None,
        thumbnail_path=None,
        transcript_path=None,
        provenance={},
    )
    run_id = db.create_run(conn, source_id=source_id, top_n=1, style="branded", output_dir="/tmp", podcli_command=None)
    clip_id = db.add_clip(conn, run_id=run_id, slug="clip-01", score=0.9, output_path="/tmp/clip.mp4", status="rendered")
    db.approve_run(conn, run_id=run_id, clip_ids=[clip_id], reviewer="liam", rights_note="owned footage")

    seed_opportunities(conn)
    matches = match_run(conn, run_id, niches=["travel"], store=True)
    licensing = next(item for item in matches if item["opportunity"]["path"] == "licensing")
    stored = conn.execute("SELECT COUNT(*) FROM opportunity_clip_matches").fetchone()[0]

    assert licensing["fit_score"] >= 80
    assert "adobe-stock" in licensing["suggested_platforms"]
    assert stored > 0


def test_manual_opportunity_upsert(conn):
    created = upsert_opportunity(
        conn,
        name="AI tool affiliate test",
        path="owned_funnel",
        platforms=["tiktok", "youtube"],
        niches=["ai"],
        rights_requirement="owned content",
        content_source="Liam demos",
        stability="experimental",
    )
    updated = upsert_opportunity(
        conn,
        name="AI tool affiliate test",
        path="owned_funnel",
        platforms=["instagram"],
        niches=["ai"],
        rights_requirement="owned content",
        content_source="Liam demos",
        stability="experimental",
    )

    opportunity = list_opportunities(conn)[0]

    assert created is True
    assert updated is False
    assert opportunity["platforms"] == ["instagram"]
