from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest

from auto_clipper import db, rerank, titles
from auto_clipper.config import Config
from auto_clipper.llm import LlmUnavailable
from auto_clipper.podcli import render_run
from auto_clipper.prompts import PromptError, available_categories, resolve_prompt_path
from auto_clipper.scheduling import schedule_run

REPO_PROMPTS = Path(__file__).resolve().parents[2] / "presets" / "prompts"


@pytest.fixture()
def scfg(cfg: Config) -> Config:
    """The shared cfg, pointed at the prompts this repo actually ships."""
    return dataclasses.replace(cfg, prompts_dir=REPO_PROMPTS)


def make_run(conn, cfg: Config, slugs: list[str]) -> tuple[int, list[int]]:
    source_id = db.add_source(
        conn,
        source_ref="/tmp/source.mp4",
        source_type="file",
        creator="Creator",
        title="Source",
        duration_seconds=600,
        local_path="/tmp/source.mp4",
        metadata_path=None,
        thumbnail_path=None,
        transcript_path=None,
        provenance={},
    )
    run_id = db.create_run(
        conn,
        source_id=source_id,
        top_n=len(slugs),
        style="branded",
        output_dir=str(cfg.data_dir / "run"),
        podcli_command=None,
    )
    clip_ids = [
        db.add_clip(
            conn,
            run_id=run_id,
            slug=slug,
            start_seconds=float(index * 60),
            end_seconds=float(index * 60 + 45),
            transcript_excerpt=f"transcript for {slug}",
            output_path=f"/tmp/{slug}.mp4",
            status="rendered",
        )
        for index, slug in enumerate(slugs)
    ]
    return run_id, clip_ids


def scores_caller(payload_scores: dict[str, float]):
    def _call(prompt: str, payload):
        return json.dumps(
            [
                {"id": item["id"], "score": payload_scores[item["id"]], "reason": f"because {item['id']}"}
                for item in payload
                if item["id"] in payload_scores
            ]
        )

    return _call


# -- rerank -----------------------------------------------------------------


def test_rerank_writes_scores_and_reasons(conn, scfg):
    run_id, _ = make_run(conn, scfg, ["clip-01", "clip-02"])

    result = rerank.rerank_run(
        conn, scfg, run_id, caller=scores_caller({"clip-01": 0.4, "clip-02": 0.9})
    )

    assert result["status"] == "ok"
    assert result["scored"] == 2
    rows = {row["slug"]: row for row in db.list_clips(conn, run_id)}
    assert rows["clip-02"]["llm_score"] == pytest.approx(0.9)
    assert rows["clip-01"]["llm_reason"] == "because clip-01"


def test_rerank_orders_best_first_and_puts_unscored_last(conn, scfg):
    run_id, _ = make_run(conn, scfg, ["clip-01", "clip-02", "clip-03"])
    rerank.rerank_run(conn, scfg, run_id, caller=scores_caller({"clip-01": 0.2, "clip-03": 0.8}))

    assert [row["slug"] for row in rerank.ranked_clips(conn, run_id)] == [
        "clip-03",
        "clip-01",
        "clip-02",
    ]


def test_rerank_never_deletes_a_clip(conn, scfg):
    """The donor drops everything under threshold. We do not."""
    run_id, _ = make_run(conn, scfg, ["clip-01", "clip-02"])
    rerank.rerank_run(conn, scfg, run_id, caller=scores_caller({"clip-01": 0.01, "clip-02": 0.02}))

    assert len(db.list_clips(conn, run_id)) == 2


def test_rerank_keeps_good_results_when_one_item_is_malformed(conn, scfg):
    """The donor discards the whole batch on any mismatch; we match by id."""
    run_id, _ = make_run(conn, scfg, ["clip-01", "clip-02"])

    def call(prompt, payload):
        return json.dumps(
            [
                {"id": "clip-01", "score": "not-a-number", "reason": "broken"},
                {"id": "clip-02", "score": 0.7, "reason": "fine"},
                {"id": "clip-99", "score": 0.5, "reason": "hallucinated id"},
            ]
        )

    result = rerank.rerank_run(conn, scfg, run_id, caller=call)

    assert result["status"] == "partial"
    assert result["scored"] == 1
    rows = {row["slug"]: row for row in db.list_clips(conn, run_id)}
    assert rows["clip-02"]["llm_score"] == pytest.approx(0.7)
    assert rows["clip-01"]["llm_score"] is None


@pytest.mark.parametrize(
    ("returned", "expected"),
    [(0.85, 0.85), (8.5, 0.85), (85, 0.85), (1, 1.0), (-3, 0.0), (500, 1.0)],
)
def test_rerank_coerces_off_scale_scores(conn, scfg, returned, expected):
    run_id, _ = make_run(conn, scfg, ["clip-01"])
    rerank.rerank_run(
        conn,
        scfg,
        run_id,
        caller=lambda prompt, payload: json.dumps([{"id": "clip-01", "score": returned, "reason": "r"}]),
    )

    row = db.list_clips(conn, run_id)[0]
    assert row["llm_score"] == pytest.approx(expected)


def test_rerank_fails_open_when_no_llm_is_available(conn, scfg):
    run_id, _ = make_run(conn, scfg, ["clip-01"])

    def dead(prompt, payload):
        raise LlmUnavailable("no model loaded")

    result = rerank.rerank_run(conn, scfg, run_id, caller=dead)

    assert result["status"] == "failed"
    assert "no model loaded" in result["error"]
    row = conn.execute("SELECT semantics_status, semantics_error FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert row["semantics_status"] == "failed"
    assert "no model loaded" in row["semantics_error"]
    assert db.list_clips(conn, run_id)[0]["status"] == "rendered"


def test_rerank_fails_open_on_unparseable_json(conn, scfg):
    run_id, _ = make_run(conn, scfg, ["clip-01"])

    result = rerank.rerank_run(conn, scfg, run_id, caller=lambda prompt, payload: "I cannot do that")

    assert result["status"] == "failed"
    assert db.list_clips(conn, run_id)[0]["llm_score"] is None


def test_rerank_writes_the_raw_response_for_debugging(conn, scfg, tmp_path):
    run_id, _ = make_run(conn, scfg, ["clip-01"])
    out = tmp_path / "run"

    rerank.rerank_run(
        conn,
        scfg,
        run_id,
        output_dir=out,
        caller=lambda prompt, payload: json.dumps([{"id": "clip-01", "score": 0.5, "reason": "r"}]),
    )

    assert (out / "llm" / "rerank-batch-01.txt").is_file()


def test_rerank_batches_large_runs(conn, scfg):
    slugs = [f"clip-{index:02d}" for index in range(1, rerank.BATCH_SIZE + 3)]
    run_id, _ = make_run(conn, scfg, slugs)
    calls: list[int] = []

    def call(prompt, payload):
        calls.append(len(payload))
        return json.dumps([{"id": item["id"], "score": 0.5, "reason": "r"} for item in payload])

    result = rerank.rerank_run(conn, scfg, run_id, caller=call)

    assert calls == [rerank.BATCH_SIZE, 2]
    assert result["scored"] == len(slugs)


# -- titles -----------------------------------------------------------------


def test_titles_write_hook_and_caption(conn, scfg):
    run_id, _ = make_run(conn, scfg, ["clip-01"])

    result = titles.generate_titles(
        conn,
        scfg,
        run_id,
        caller=lambda prompt, payload: json.dumps(
            {"clip-01": {"hook": "The round is priced by your worst month", "caption": "Not your best one."}}
        ),
    )

    assert result["status"] == "ok"
    row = db.list_clips(conn, run_id)[0]
    assert row["hook_title"] == "The round is priced by your worst month"
    assert row["caption"] == "Not your best one."


def test_titles_accept_a_bare_string(conn, scfg):
    run_id, _ = make_run(conn, scfg, ["clip-01"])

    titles.generate_titles(
        conn, scfg, run_id, caller=lambda prompt, payload: json.dumps({"clip-01": "Just a hook"})
    )

    row = db.list_clips(conn, run_id)[0]
    assert row["hook_title"] == "Just a hook"
    assert row["caption"] is None


def test_titles_clamp_to_the_platform_limits(conn, scfg):
    run_id, _ = make_run(conn, scfg, ["clip-01"])

    titles.generate_titles(
        conn,
        scfg,
        run_id,
        caller=lambda prompt, payload: json.dumps(
            {"clip-01": {"hook": "h" * 400, "caption": "c" * 900}}
        ),
    )

    row = db.list_clips(conn, run_id)[0]
    assert len(row["hook_title"]) == titles.HOOK_LIMIT
    assert len(row["caption"]) == titles.CAPTION_LIMIT


def test_titles_do_not_erase_scores(conn, scfg):
    run_id, _ = make_run(conn, scfg, ["clip-01"])
    rerank.rerank_run(conn, scfg, run_id, caller=scores_caller({"clip-01": 0.6}))

    titles.generate_titles(
        conn, scfg, run_id, caller=lambda prompt, payload: json.dumps({"clip-01": {"hook": "H"}})
    )

    row = db.list_clips(conn, run_id)[0]
    assert row["llm_score"] == pytest.approx(0.6)
    assert row["hook_title"] == "H"


def test_titles_fail_open(conn, scfg):
    run_id, _ = make_run(conn, scfg, ["clip-01"])

    def dead(prompt, payload):
        raise LlmUnavailable("no model loaded")

    result = titles.generate_titles(conn, scfg, run_id, caller=dead)

    assert result["status"] == "failed"
    assert db.list_clips(conn, run_id)[0]["hook_title"] is None


# -- caption precedence -----------------------------------------------------


def test_caption_precedence_prefers_the_generated_caption(conn, scfg):
    run_id, clip_ids = make_run(conn, scfg, ["clip-01"])
    db.set_clip_semantics(conn, clip_ids[0], hook_title="A hook", caption="A caption")

    assert titles.caption_for_clip(db.list_clips(conn, run_id)[0]) == "A caption"


def test_caption_precedence_falls_back_to_the_hook(conn, scfg):
    run_id, clip_ids = make_run(conn, scfg, ["clip-01"])
    db.set_clip_semantics(conn, clip_ids[0], hook_title="A hook")

    assert titles.caption_for_clip(db.list_clips(conn, run_id)[0]) == "A hook"


def test_caption_precedence_matches_pre_llm_behaviour_when_nothing_was_generated(conn, scfg):
    run_id, _ = make_run(conn, scfg, ["clip-01"])

    assert titles.caption_for_clip(db.list_clips(conn, run_id)[0]) == "transcript for clip-01"


# -- prompts ----------------------------------------------------------------


def test_category_overlay_overrides_the_rerank_prompt(scfg):
    resolved = resolve_prompt_path(scfg, "clip-rerank.txt", "knowledge")

    assert resolved == REPO_PROMPTS / "knowledge" / "clip-rerank.txt"


def test_category_falls_back_per_file(scfg):
    """`knowledge` ships no title prompt, so that one resolves to the default."""
    resolved = resolve_prompt_path(scfg, "clip-title.txt", "knowledge")

    assert resolved == REPO_PROMPTS / "clip-title.txt"


def test_unknown_category_falls_back_to_defaults(scfg):
    assert resolve_prompt_path(scfg, "clip-rerank.txt", "no-such-category") == (
        REPO_PROMPTS / "clip-rerank.txt"
    )


def test_missing_prompt_dir_raises(cfg, tmp_path):
    empty = dataclasses.replace(cfg, prompts_dir=tmp_path / "nope")

    with pytest.raises(PromptError):
        resolve_prompt_path(empty, "clip-rerank.txt")


def test_shipped_categories_are_discoverable(scfg):
    assert "knowledge" in available_categories(scfg)
    assert "business" in available_categories(scfg)


# -- end to end -------------------------------------------------------------


def test_render_enriches_clips_and_the_caption_reaches_postiz(conn, scfg, monkeypatch):
    """Fake render, stubbed LLM, then the full approval-gated schedule."""
    monkeypatch.setenv("AUTO_CLIPPER_FAKE_RENDER", "1")
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

    def fake_call(prompt: str, payload):
        if "hook" in prompt:
            return json.dumps(
                {item["id"]: {"hook": f"hook {item['id']}", "caption": f"caption {item['id']}"} for item in payload}
            )
        return json.dumps([{"id": item["id"], "score": 0.75, "reason": "solid"} for item in payload])

    monkeypatch.setattr("auto_clipper.llm.call_llm", fake_call)

    run_id = render_run(conn, scfg, source_id, top=2, style="branded", category="business")

    rows = {row["slug"]: row for row in db.list_clips(conn, run_id)}
    assert rows["clip-01"]["llm_score"] == pytest.approx(0.75)
    assert rows["clip-01"]["hook_title"] == "hook clip-01"
    run = conn.execute("SELECT category, semantics_status FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert run["category"] == "business"
    assert run["semantics_status"] == "ok"

    db.approve_run(
        conn,
        run_id=run_id,
        clip_ids=[int(rows["clip-01"]["id"])],
        reviewer="liam",
        rights_note="approved for test",
    )
    schedule_run(conn, scfg, run_id=run_id, platforms=["youtube"], times=["09:00"])

    payload_path = conn.execute("SELECT payload_path FROM post_drafts").fetchone()["payload_path"]
    payload = json.loads(Path(payload_path).read_text(encoding="utf-8"))
    assert "caption clip-01" in json.dumps(payload)


def test_render_still_succeeds_when_the_llm_is_dead(conn, scfg, monkeypatch):
    monkeypatch.setenv("AUTO_CLIPPER_FAKE_RENDER", "1")
    monkeypatch.setenv("AUTO_CLIPPER_LLM", "off")
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

    run_id = render_run(conn, scfg, source_id, top=2, style="branded")

    run = conn.execute("SELECT status, semantics_status FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert run["status"] == "rendered"
    assert run["semantics_status"] == "failed"
    clips = db.list_clips(conn, run_id)
    assert len(clips) == 2
    assert titles.caption_for_clip(clips[0]) == "Placeholder transcript excerpt."


def test_a_high_score_does_not_bypass_the_approval_gate(conn, scfg, monkeypatch):
    """The re-rank orders clips. It has no authority to publish them."""
    monkeypatch.setenv("AUTO_CLIPPER_FAKE_RENDER", "1")
    source_id = db.add_source(
        conn,
        source_ref="https://example.com/someone-elses-video",
        source_type="url",
        creator="Someone Else",
        title="Public creator material",
        duration_seconds=300,
        local_path="/tmp/source.mp4",
        metadata_path=None,
        thumbnail_path=None,
        transcript_path=None,
        provenance={},
    )
    monkeypatch.setattr(
        "auto_clipper.llm.call_llm",
        lambda prompt, payload: json.dumps(
            [{"id": item["id"], "score": 1.0, "reason": "perfect"} for item in payload]
        )
        if "hook" not in prompt
        else json.dumps({item["id"]: {"hook": "H", "caption": "C"} for item in payload}),
    )

    run_id = render_run(conn, scfg, source_id, top=2, style="branded")

    assert all(row["llm_score"] == pytest.approx(1.0) for row in db.list_clips(conn, run_id))
    assert conn.execute("SELECT rights_status FROM sources WHERE id = ?", (source_id,)).fetchone()[0] == "research"
    with pytest.raises(db.PolicyError, match="rights_status"):
        schedule_run(conn, scfg, run_id=run_id, platforms=["tiktok"], times=["09:00"])
