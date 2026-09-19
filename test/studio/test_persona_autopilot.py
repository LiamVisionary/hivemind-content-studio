"""The persona autopilot plans a day and opens runs. It never publishes."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from hivemind_content_studio import persona_autopilot as autopilot
from hivemind_content_studio.config import load_config
from hivemind_content_studio.manifest import load_manifest
from hivemind_content_studio.metrics import upsert_post_metrics
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import read_private_json
from hivemind_content_studio.run_store import RunStore

PERSONA = {
    "id": "sophia", "name": "Sophia", "appearance": "23-year-old tennis player, brown ponytail, white visor",
    "niche": "tennis lifestyle", "platforms": ["TikTok", "instagram"], "posts_per_day": 2, "review_in": "hivemindos",
    "accounts": {"tiktok": "tiktok:sophia"},
}

POSTS = [
    {"hook": "Six a.m. serves hit different", "caption": "Empty court, full basket.", "image_prompt": "sunlit hard court, mid ball toss, low angle", "motion_prompt": "a serve, ball leaves frame", "hashtags": ["tennis"]},
    {"hook": "The drill nobody films", "caption": "Footwork first.", "image_prompt": "baseline ladder drill, side view", "motion_prompt": "quick lateral steps", "hashtags": []},
]


class _Runtime:
    """Stands in for a text model one layer down: the real ``produce`` builds the prompt and parses the answer."""

    def __init__(self, answer: dict):
        self.answer = answer
        self.calls: list[dict] = []

    def chat(self, *, model_id, messages, temperature, max_tokens, timeout):
        self.calls.append({"model_id": model_id, "messages": messages})
        return json.dumps(self.answer)


@pytest.fixture()
def cfg(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    return replace(load_config(), data_dir=tmp_path / "data", runs_dir=tmp_path / "runs")


def test_a_persona_is_validated_and_defaults_to_labelled_as_ai(cfg) -> None:
    saved = autopilot.save_persona(PERSONA, cfg=cfg)
    assert saved["platforms"] == ["instagram", "tiktok"] and saved["disclosed_as_ai"] is True
    assert autopilot.load_persona("sophia", cfg=cfg)["accounts"] == {"tiktok": "tiktok:sophia"}
    assert [item["id"] for item in autopilot.list_personas(cfg=cfg)] == ["sophia"]
    with pytest.raises(autopilot.PersonaError, match="cannot keep a character consistent"):
        autopilot.save_persona({"id": "bare", "name": "Bare", "platforms": ["x"]}, cfg=cfg)
    with pytest.raises(autopilot.PersonaError, match="between 1 and 6"):
        autopilot.save_persona({**PERSONA, "posts_per_day": 40}, cfg=cfg)
    with pytest.raises(autopilot.PersonaError, match="persona id"):
        autopilot.save_persona({**PERSONA, "id": "../escape"}, cfg=cfg)
    with pytest.raises(autopilot.PersonaError, match="Create it with"):
        autopilot.load_persona("nobody", cfg=cfg)


def test_the_day_plan_carries_trend_notes_and_asks_for_the_personas_count(cfg) -> None:
    autopilot.save_persona(PERSONA, cfg=cfg)
    runtime = _Runtime({"posts": [*POSTS, {**POSTS[0], "hook": "one too many"}]})
    plan = autopilot.plan_persona_day("sophia", trend_notes="slow-motion serves are up this week", model_id="test-model", runtime=runtime, cfg=cfg)
    assert [post["hook"] for post in plan["posts"]] == [POSTS[0]["hook"], POSTS[1]["hook"]], "never more than the persona's daily count"
    sent = json.dumps(runtime.calls[0]["messages"])
    assert "slow-motion serves are up this week" in sent and "exactly 2 posts" in sent
    assert "white visor" not in sent, "the appearance is fixed elsewhere; the writer is never handed it to restate or drift"


def test_a_plan_missing_a_shot_is_refused_with_the_field_named(cfg) -> None:
    autopilot.save_persona(PERSONA, cfg=cfg)
    broken = _Runtime({"posts": [{"hook": "h", "caption": "c", "image_prompt": "i"}]})
    with pytest.raises(Exception, match="motion_prompt"):
        autopilot.plan_persona_day("sophia", model_id="test-model", runtime=broken, cfg=cfg)


def test_starting_a_day_opens_runs_that_stop_for_generation_and_publish_nothing(cfg, tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("hivemind_content_studio.orchestrator.load_config", lambda: cfg)
    autopilot.save_persona(PERSONA, cfg=cfg)
    engine = ContentOrchestrator(RunStore(tmp_path / "runs.sqlite3"))
    result = autopilot.start_persona_day("sophia", POSTS, orchestrator=engine, cfg=cfg)

    assert len(result["started"]) == 2
    first = result["started"][0]
    assert first["status"] == "awaiting_generation", "the day plan is the script, so the run goes straight to the keyframe"
    assert first["next"][0]["tool"] == "generate_keyframes"
    manifest = load_manifest(first["manifest_path"])
    assert manifest["lane"] == "persona-series"
    assert manifest["publish"] == {"drafts": [], "receipts": []}
    assert manifest["approval"]["status"] == "pending"
    requests = read_private_json(next(Path(item["path"]) for item in manifest["artifacts"] if item["role"] == "keyframe-requests"))
    assert "white visor" in requests[0]["continuity"]["persona"]["appearance"], "every keyframe is asked for the same character"
    metadata = read_private_json(next(Path(item["path"]) for item in manifest["artifacts"] if item["role"] == "publish-metadata"))
    assert metadata["platforms"] == ["instagram", "tiktok"] and "AI" in metadata["hashtags"]
    assert manifest["brief"]["publish"]["review_in"] == "hivemindos"
    assert autopilot.load_persona("sophia", cfg=cfg)["runs"] == [item["manifest_path"] for item in result["started"]]


def test_tomorrows_plan_is_told_what_was_actually_watched(cfg, tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("hivemind_content_studio.orchestrator.load_config", lambda: cfg)
    autopilot.save_persona(PERSONA, cfg=cfg)
    started = autopilot.start_persona_day("sophia", POSTS, orchestrator=ContentOrchestrator(RunStore(tmp_path / "runs.sqlite3")), cfg=cfg)["started"]
    upsert_post_metrics(started[1]["manifest_path"], platform="tiktok", external_id="tt_2", metrics={"views": 9000, "likes": 300}, source="hivemindos-socials")
    upsert_post_metrics(started[0]["manifest_path"], platform="tiktok", external_id="tt_1", metrics={"views": 1200}, source="hivemindos-socials")
    board = autopilot.persona_scoreboard(autopilot.load_persona("sophia", cfg=cfg))
    assert [row["hook"] for row in board] == [POSTS[1]["hook"], POSTS[0]["hook"]]
    runtime = _Runtime({"posts": POSTS})
    autopilot.plan_persona_day("sophia", model_id="test-model", runtime=runtime, cfg=cfg)
    assert "The drill nobody films" in json.dumps(runtime.calls[0]["messages"])
