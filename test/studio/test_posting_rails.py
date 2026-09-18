"""Where a finished post goes, and what comes back.

No network: every HivemindOS and hosted call is replaced at the seam
``posting_rails`` exposes, one layer below the function under test, so a change
to a real signature breaks these tests instead of hiding behind a loose fake.
"""

from __future__ import annotations

import stat
from dataclasses import replace
from pathlib import Path

import pytest

from hivemind_content_studio import posting_rails, publishing
from hivemind_content_studio.config import load_config
from hivemind_content_studio.manifest import approve_manifest, create_manifest, load_manifest, write_manifest
from hivemind_content_studio.metrics import summarize_metrics, upsert_post_metrics
from hivemind_content_studio.planner import plan
from hivemind_content_studio.private_access import read_private_json
from hivemind_content_studio.publishing import PublishError, handoff_to_hivemindos, prepare_publish, sync_hivemindos_posts

QA_OK = {"kind": "video", "ok": True, "failures": [], "visual_inspection_required": False}

FEED = {
    "base_url": "http://127.0.0.1:5020",
    "ok": True,
    "accounts": [
        {"id": "tiktok:sophia", "platform": "tiktok", "handle": "sophia", "status": "connected"},
        {"id": "x:sophia", "platform": "x", "handle": "sophia", "status": "connected"},
    ],
    "platforms": [
        {"platform": "tiktok", "capabilities": {"post": "supported"}, "media": {"kinds": ["video"], "maxItems": 1, "requires": "video"}},
        {"platform": "x", "capabilities": {"post": "supported"}, "media": {"kinds": [], "maxItems": 0}},
        {"platform": "facebook", "capabilities": {"post": "unsupported"}, "media": {"kinds": [], "maxItems": 0}},
    ],
    "queue": [],
}


def _cfg(tmp_path: Path, **overrides):
    return replace(load_config(), data_dir=tmp_path / "data", **overrides)


def _run(tmp_path: Path, monkeypatch, *, brief: dict | None = None, platforms=("tiktok",)) -> tuple[Path, Path]:
    manifest, _ = create_manifest(lane="social-post", brief={"id": "rail-test", **(brief or {})}, runs_dir=tmp_path / "runs", providers={"publish": "auto"})
    video = tmp_path / "final.mp4"
    video.write_bytes(b"clip-bytes")
    monkeypatch.setattr("hivemind_content_studio.publishing.qa_asset", lambda *_a, **_k: dict(QA_OK))
    prepare_publish(manifest, video=video, title="Serve practice", caption="Morning serves", platforms=list(platforms), provider="hivemindos")
    return manifest, video


# --- the resolver -------------------------------------------------------------

def _rails(monkeypatch, tmp_path, *, feed, health, credits="", **cfg):
    monkeypatch.setattr(posting_rails, "hivemindos_socials", lambda **_k: feed)
    monkeypatch.setattr(posting_rails, "managed_socials_health", lambda **_k: health)
    monkeypatch.setattr(posting_rails, "_credit_token", lambda: credits)
    return posting_rails.posting_rails(_cfg(tmp_path, **{"upload_post_api_key": None, "upload_post_username": None, "postiz_api_key": None, **cfg}))


def test_hivemindos_wins_when_it_is_running_with_a_connected_account(tmp_path, monkeypatch) -> None:
    result = _rails(monkeypatch, tmp_path, feed=FEED, health={"reachable": True, "configured": True, "media": True}, credits="tok",
                    upload_post_api_key="k", upload_post_username="u")
    assert result["rail"] == "hivemindos"


def test_standalone_falls_back_to_the_owners_own_keys(tmp_path, monkeypatch) -> None:
    result = _rails(monkeypatch, tmp_path, feed=None, health={"reachable": True, "configured": False, "media": False}, credits="tok",
                    upload_post_api_key="k", upload_post_username="u")
    assert result["rail"] == "upload-post"
    by_id = {rail["id"]: rail for rail in result["rails"]}
    assert "Install and open HivemindOS" in by_id["hivemindos"]["fix"]
    # The hosted service answers /health before it can publish; only `configured` counts.
    assert by_id["managed-socials"]["available"] is False
    assert "not switched on" in by_id["managed-socials"]["fix"]


def test_hosted_rail_needs_media_support_for_a_media_post(tmp_path, monkeypatch) -> None:
    health = {"reachable": True, "configured": True, "media": False}
    assert _rails(monkeypatch, tmp_path, feed=None, health=health, credits="tok")["rail"] is None
    monkeypatch.setattr(posting_rails, "hivemindos_socials", lambda **_k: None)
    assert posting_rails.posting_rails(_cfg(tmp_path, upload_post_api_key=None, upload_post_username=None, postiz_api_key=None), needs_media=False)["rail"] == "managed-socials"


def test_nothing_available_names_every_fix(tmp_path, monkeypatch) -> None:
    result = _rails(monkeypatch, tmp_path, feed=None, health={"reachable": False, "configured": False, "media": False})
    assert result["rail"] is None
    assert all(rail.get("fix") for rail in result["rails"]), "an unavailable rail always says what would make it available"


def test_auto_provider_refuses_with_the_fixes_not_a_bare_no(tmp_path, monkeypatch) -> None:
    manifest, _ = create_manifest(lane="social-post", brief={"id": "auto"}, runs_dir=tmp_path / "runs", providers={})
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    monkeypatch.setattr("hivemind_content_studio.publishing.qa_asset", lambda *_a, **_k: dict(QA_OK))
    monkeypatch.setattr(posting_rails, "posting_rails", lambda **_k: {"rail": None, "rails": [{"id": "hivemindos", "available": False, "fix": "Install and open HivemindOS."}]})
    with pytest.raises(PublishError, match="Install and open HivemindOS"):
        prepare_publish(manifest, video=video, title="T", caption="", platforms=["tiktok"], provider="auto")


# --- the handoff --------------------------------------------------------------

def test_handoff_refuses_an_unapproved_run_and_exports_nothing(tmp_path, monkeypatch) -> None:
    manifest, _ = _run(tmp_path, monkeypatch)
    cfg = _cfg(tmp_path)
    monkeypatch.setattr(posting_rails, "hivemindos_socials", lambda **_k: FEED)
    with pytest.raises(PublishError, match="Approve this run first"):
        handoff_to_hivemindos(manifest, cfg=cfg)
    assert not posting_rails.handoff_root(cfg).exists(), "no unencrypted copy is written for a run nobody approved"


def test_handoff_refuses_a_platform_hivemindos_cannot_attach_media_to(tmp_path, monkeypatch) -> None:
    manifest, _ = _run(tmp_path, monkeypatch, platforms=("x",))
    approve_manifest(manifest, reviewer="owner", rights_note="Owned.")
    cfg = _cfg(tmp_path)
    monkeypatch.setattr(posting_rails, "hivemindos_socials", lambda **_k: FEED)
    with pytest.raises(PublishError, match="cannot attach a video to a x post"):
        handoff_to_hivemindos(manifest, cfg=cfg)
    assert not posting_rails.handoff_root(cfg).exists(), "every platform is checked before the first file is exported"


def test_handoff_exports_privately_and_queues_a_review_suggestion(tmp_path, monkeypatch) -> None:
    manifest, _ = _run(tmp_path, monkeypatch)
    approve_manifest(manifest, reviewer="owner", rights_note="Owned.")
    cfg = _cfg(tmp_path)
    calls: list[dict] = []

    def fake_suggest(feed, *, account_id, text, media, suggested_for=None, **_k):
        calls.append({"account_id": account_id, "text": text, "media": media})
        return {"id": "social_1", "state": "suggested"}

    monkeypatch.setattr(posting_rails, "hivemindos_socials", lambda **_k: FEED)
    monkeypatch.setattr(posting_rails, "suggest_to_hivemindos", fake_suggest)
    result = handoff_to_hivemindos(manifest, cfg=cfg)

    assert result["published"] is False and result["handed_off"] is True
    assert calls[0]["account_id"] == "tiktok:sophia" and calls[0]["text"] == "Morning serves"
    exported = calls[0]["media"][0]
    assert exported.read_bytes() == b"clip-bytes"
    assert exported.is_absolute() and posting_rails.handoff_root(cfg) in exported.parents
    assert stat.S_IMODE(exported.stat().st_mode) == 0o600
    assert stat.S_IMODE(exported.parent.stat().st_mode) == 0o700
    saved = load_manifest(manifest)
    assert saved["publish"]["drafts"][0]["status"] == "handed-off"
    assert saved["publish"]["receipts"][0]["queue_item_id"] == "social_1"
    with pytest.raises(PublishError, match="No prepared HivemindOS drafts"):
        handoff_to_hivemindos(manifest, cfg=cfg)  # a second press does not queue the post twice


def test_a_persona_reviewed_in_hivemindos_hands_off_without_a_studio_approval(tmp_path, monkeypatch) -> None:
    manifest, _ = _run(tmp_path, monkeypatch, brief={"publish": {"review_in": "hivemindos"}})
    monkeypatch.setattr(posting_rails, "hivemindos_socials", lambda **_k: FEED)
    monkeypatch.setattr(posting_rails, "suggest_to_hivemindos", lambda *_a, **_k: {"id": "social_2", "state": "suggested"})
    assert handoff_to_hivemindos(manifest, cfg=_cfg(tmp_path))["handed_off"] is True


def test_handoff_says_what_to_do_when_hivemindos_is_not_running(tmp_path, monkeypatch) -> None:
    manifest, _ = _run(tmp_path, monkeypatch)
    approve_manifest(manifest, reviewer="owner", rights_note="Owned.")
    monkeypatch.setattr(posting_rails, "hivemindos_socials", lambda **_k: None)
    with pytest.raises(PublishError, match="Open it, or prepare this draft with your own"):
        handoff_to_hivemindos(manifest, cfg=_cfg(tmp_path))


def test_several_accounts_on_one_platform_must_be_named() -> None:
    feed = {**FEED, "accounts": [*FEED["accounts"], {"id": "tiktok:other", "platform": "tiktok", "status": "connected"}]}
    with pytest.raises(posting_rails.PostingRailError, match="Name the one to post from"):
        posting_rails.hivemindos_account_for(feed, "tiktok")
    assert posting_rails.hivemindos_account_for(feed, "tiktok", "tiktok:other")["id"] == "tiktok:other"


def test_live_execute_never_publishes_a_hivemindos_draft(tmp_path, monkeypatch) -> None:
    manifest, _ = _run(tmp_path, monkeypatch)
    approve_manifest(manifest, reviewer="owner", rights_note="Owned.")
    with pytest.raises(PublishError, match="reviewed and published in HivemindOS"):
        publishing.execute_publish(manifest, confirm="LIVE_PUBLISH", cfg=_cfg(tmp_path, live_publish_enabled=True))


# --- what comes back ----------------------------------------------------------

def _handed_off(tmp_path, monkeypatch):
    manifest, _ = _run(tmp_path, monkeypatch)
    approve_manifest(manifest, reviewer="owner", rights_note="Owned.")
    cfg = _cfg(tmp_path)
    monkeypatch.setattr(posting_rails, "hivemindos_socials", lambda **_k: FEED)
    monkeypatch.setattr(posting_rails, "suggest_to_hivemindos", lambda *_a, **_k: {"id": "social_1", "state": "suggested"})
    handoff_to_hivemindos(manifest, cfg=cfg)
    return manifest, cfg


def test_sync_keeps_the_export_while_the_post_is_still_waiting(tmp_path, monkeypatch) -> None:
    manifest, cfg = _handed_off(tmp_path, monkeypatch)
    waiting = {**FEED, "queue": [{"id": "social_1", "state": "approved"}]}
    monkeypatch.setattr(posting_rails, "hivemindos_socials", lambda **_k: waiting)
    refreshed: list[str] = []
    monkeypatch.setattr(posting_rails, "refresh_hivemindos_analytics", lambda _feed, account_id, **_k: refreshed.append(account_id))
    result = sync_hivemindos_posts(manifest, cfg=cfg)
    assert result["posted"] == 0 and result["cleaned"] is False
    assert refreshed == [], "a metered analytics read is not spent on an account with nothing live"
    assert any(posting_rails.handoff_root(cfg).rglob("final.mp4")), "HivemindOS still needs the file"


def test_sync_lands_metrics_once_and_removes_the_export_when_posted(tmp_path, monkeypatch) -> None:
    manifest, cfg = _handed_off(tmp_path, monkeypatch)

    def posted(views):
        return {**FEED, "queue": [{"id": "social_1", "state": "posted", "result": {
            "externalId": "tt_99", "url": "https://tiktok.example/tt_99", "postedAt": "2026-09-19T01:00:00.000Z",
            "metrics": {"views": views, "likes": 40, "shares": 3},
        }}]}

    monkeypatch.setattr(posting_rails, "refresh_hivemindos_analytics", lambda *_a, **_k: {})
    monkeypatch.setattr(posting_rails, "hivemindos_socials", lambda **_k: posted(1000))
    first = sync_hivemindos_posts(manifest, cfg=cfg)
    assert first == {**first, "posted": 1, "measured": 1, "cleaned": True}
    assert not any(posting_rails.handoff_root(cfg).rglob("final.mp4")), "the unencrypted copy is gone once the post is live"

    monkeypatch.setattr(posting_rails, "hivemindos_socials", lambda **_k: posted(2500))
    sync_hivemindos_posts(manifest, cfg=cfg)
    summary = summarize_metrics(manifest)
    assert len(summary["entries"]) == 1, "a post's growing numbers replace the last read instead of summing with it"
    assert summary["totals"]["views"] == 2500
    assert summary["entries"][0]["engagement"] == {"likes": 40, "shares": 3}
    saved = load_manifest(manifest)
    assert saved["publish"]["drafts"][0]["status"] == "published"
    assert saved["publish"]["receipts"][0]["url"] == "https://tiktok.example/tt_99"


def test_a_deleted_suggestion_is_final_and_cleans_up(tmp_path, monkeypatch) -> None:
    manifest, cfg = _handed_off(tmp_path, monkeypatch)
    monkeypatch.setattr(posting_rails, "hivemindos_socials", lambda **_k: {**FEED, "queue": []})
    result = sync_hivemindos_posts(manifest, cfg=cfg)
    assert result["states"] == {"social_1": "deleted"} and result["cleaned"] is True


def test_a_counter_refresh_never_erases_hand_entered_revenue(tmp_path) -> None:
    manifest, _ = create_manifest(lane="social-post", brief={"id": "money"}, runs_dir=tmp_path / "runs", providers={})
    upsert_post_metrics(manifest, platform="tiktok", external_id="p1", metrics={"views": 10}, source="hivemindos-socials")
    data = load_manifest(manifest)
    data["performance"][0].update({"revenue": 12.5, "conversions": 2})
    write_manifest(manifest, data)
    entry = upsert_post_metrics(manifest, platform="tiktok", external_id="p1", metrics={"impressions": 90, "clicks": 500}, source="hivemindos-socials")
    assert (entry["revenue"], entry["conversions"]) == (12.5, 2)
    assert entry["views"] == 90 and entry["clicks"] == 90, "a platform that reports more clicks than views is clamped, not rejected"


# --- the lane -----------------------------------------------------------------

PERSONA_BRIEF = """id: sophia-day-1
lane: persona-series
title: Morning serves
persona:
  id: sophia
  name: Sophia
  appearance: 23-year-old tennis player, brown ponytail, white visor
scenes:
  - title: Serve
    beat: She tosses the ball and serves on a sunlit court.
    duration_seconds: 10
publish:
  review_in: hivemindos
  platforms: [tiktok]
  caption: Morning serves.
"""


def test_persona_series_carries_the_character_into_every_keyframe_request(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text(PERSONA_BRIEF, encoding="utf-8")
    manifest_path = plan(brief)
    manifest = load_manifest(manifest_path)
    assert manifest["lane"] == "persona-series"
    requests = read_private_json(next(Path(item["path"]) for item in manifest["artifacts"] if item["role"] == "keyframe-requests"))
    persona = requests[0]["continuity"]["persona"]
    assert persona["name"] == "Sophia" and "white visor" in persona["appearance"]
    assert persona["disclosed_as_ai"] is True, "a persona is labelled as AI unless the brief says otherwise"
    assert manifest["brief"]["voice"] == {"enabled": False}, "a persona clip is a silent loop unless asked"


def test_a_persona_needs_more_than_a_name(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: bare\nlane: persona-series\npersona:\n  name: Sophia\nscenes:\n  - beat: serve\n", encoding="utf-8")
    with pytest.raises(ValueError, match="cannot keep a character consistent"):
        plan(brief)


# --- the wire -----------------------------------------------------------------
# The tests above replace posting_rails' functions; these exercise those
# functions for real against a fake network, so the request HivemindOS actually
# receives is pinned too.

class _Response:
    def __init__(self, payload: dict, status: int = 200):
        import json as _json

        self.status = status
        self._raw = _json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> bool:
        return False


def test_suggest_sends_the_review_forcing_action_with_absolute_media_paths(tmp_path, monkeypatch) -> None:
    import json as _json

    monkeypatch.setattr("hivemind_content_studio.hivemindos_hosted_media._dashboard_token", lambda: "device-token")
    seen: list = []

    def opener(request, timeout):
        seen.append(request)
        return _Response({"ok": True, "item": {"id": "social_9", "state": "suggested"}})

    clip = tmp_path / "clip.mp4"
    item = posting_rails.suggest_to_hivemindos(FEED, account_id="tiktok:sophia", text="Morning serves", media=[clip], suggested_for="2026-09-20T01:00:00Z", opener=opener)
    assert item["id"] == "social_9"
    request = seen[0]
    assert request.full_url == "http://127.0.0.1:5020/api/socials/queue" and request.get_method() == "POST"
    assert request.get_header("X-hivemindos-device-token") == "device-token"
    assert _json.loads(request.data) == {
        "action": "suggest", "accountId": "tiktok:sophia", "text": "Morning serves",
        "suggestedFor": "2026-09-20T01:00:00Z", "media": [{"path": str(clip)}],
    }


def test_a_refusal_from_hivemindos_is_passed_on_in_its_own_words(monkeypatch) -> None:
    monkeypatch.setattr("hivemind_content_studio.hivemindos_hosted_media._dashboard_token", lambda: "device-token")

    def opener(request, timeout):
        return _Response({"ok": False, "error": "tiktok accepts at most 1 attached file per post."}, status=400)

    with pytest.raises(posting_rails.PostingRailError, match="at most 1 attached file"):
        posting_rails.suggest_to_hivemindos(FEED, account_id="tiktok:sophia", text="x", media=[], opener=opener)


def test_the_feed_is_found_on_the_dev_port_when_the_packaged_one_is_silent(monkeypatch) -> None:
    monkeypatch.delenv("HIVEMINDOS_URL", raising=False)
    monkeypatch.setattr("hivemind_content_studio.hivemindos_hosted_media._dashboard_token", lambda: "device-token")

    def opener(request, timeout):
        if ":5020" in request.full_url:
            raise OSError("connection refused")
        return _Response({"ok": True, "accounts": [], "platforms": [], "queue": []})

    feed = posting_rails.hivemindos_socials(opener=opener)
    assert feed is not None and feed["base_url"] == "http://127.0.0.1:5021"


def test_the_rail_is_chosen_for_this_post_not_for_the_machine(tmp_path, monkeypatch) -> None:
    # HivemindOS is up with TikTok and X connected, and the owner also has Upload-Post.
    ready = dict(feed=FEED, health={"reachable": False, "configured": False, "media": False}, upload_post_api_key="k", upload_post_username="u")
    monkeypatch.setattr(posting_rails, "hivemindos_socials", lambda **_k: FEED)
    monkeypatch.setattr(posting_rails, "managed_socials_health", lambda **_k: ready["health"])
    monkeypatch.setattr(posting_rails, "_credit_token", lambda: "")
    cfg = _cfg(tmp_path, upload_post_api_key="k", upload_post_username="u", postiz_api_key=None)
    assert posting_rails.posting_rails(cfg, platforms=["tiktok"], media_kind="video")["rail"] == "hivemindos"
    # X is connected there, but its adapter is text only: a video goes out on the owner's keys instead.
    x_video = posting_rails.posting_rails(cfg, platforms=["x"], media_kind="video")
    assert x_video["rail"] == "upload-post"
    assert "cannot attach a video to a x post" in x_video["rails"][0]["fix"]
    # Instagram is not connected in HivemindOS at all.
    instagram = posting_rails.posting_rails(cfg, platforms=["tiktok", "instagram"], media_kind="video")
    assert instagram["rail"] == "upload-post" and "Connect a instagram account" in instagram["rails"][0]["fix"]


def test_a_read_only_connection_is_not_a_rail(tmp_path, monkeypatch) -> None:
    # Seen on the owner's machine 2026-09-18: only Facebook connected, which HivemindOS cannot post to.
    feed = {**FEED, "accounts": [{"id": "facebook:primary", "platform": "facebook", "status": "connected"}]}
    result = _rails(monkeypatch, tmp_path, feed=feed, health={"reachable": False, "configured": False, "media": False}, upload_post_api_key="k", upload_post_username="u")
    assert result["rail"] == "upload-post"
    assert "can post from" in result["rails"][0]["fix"]
