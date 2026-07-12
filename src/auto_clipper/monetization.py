"""Local monetization opportunity tracker.

The scoring flow borrows the revenue-opportunity framing from
LiamVisionary/ami-revenue-optimizer: classify the path, flag risks, and produce
plain recommendations before taking action.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from . import db


SEEDED_OPPORTUNITIES: list[dict[str, Any]] = [
    {
        "name": "Performance clipping campaigns",
        "path": "performance_campaign",
        "source": "Liam notes",
        "url": "",
        "payout_model": "Campaign payout, often CPM or per approved view milestone",
        "payout_range": "User-researched rough range: $1-$4 CPM when campaigns are available",
        "platforms": ["tiktok", "youtube", "instagram", "x"],
        "niches": ["ai", "business", "streamers", "podcasts", "dating", "fitness"],
        "rights_requirement": "campaign-approved footage only",
        "content_source": "Whop Content Rewards, Clipping.net, creator Discords, TikTok One",
        "stability": "volatile",
        "notes": "Closest no-client path. Treat like performance marketing: approval, view checks, originality rules, and payout availability can change.",
    },
    {
        "name": "Owned AI founder/app funnel",
        "path": "owned_funnel",
        "source": "Liam notes",
        "url": "",
        "payout_model": "Affiliate, waitlist, app traffic, sponsorship, product sales",
        "payout_range": "Indirect; optimize clicks, signups, installs, paid conversion",
        "platforms": ["tiktok", "youtube", "instagram", "x"],
        "niches": ["ai", "founder", "apps", "agents", "building in public"],
        "rights_requirement": "owned or explicitly approved content",
        "content_source": "screen recordings, voice memos, founder updates, demos, Creative Commons/public-domain support footage",
        "stability": "defensible",
        "notes": "Best fit for Ami/Wyntra/Rizzma-style funnels. Direct ad share is secondary to owned conversion.",
    },
    {
        "name": "Owned dating/charisma funnel",
        "path": "owned_funnel",
        "source": "Liam notes",
        "url": "",
        "payout_model": "App traffic, affiliate, newsletter, paid community, sponsorship",
        "payout_range": "Indirect; optimize follows, clicks, signups, paid conversion",
        "platforms": ["tiktok", "youtube", "instagram"],
        "niches": ["dating", "charisma", "psychology", "relationships"],
        "rights_requirement": "owned or explicitly approved content",
        "content_source": "original commentary, app demos, voiceover, licensed/approved source clips",
        "stability": "defensible",
        "notes": "Use clips as distribution for Rizzma or related offers. Avoid lazy reposts; add commentary and original framing.",
    },
    {
        "name": "Client clipping retainer proof",
        "path": "client_retainer",
        "source": "Liam notes",
        "url": "",
        "payout_model": "Direct service: per clip, hourly, or monthly retainer",
        "payout_range": "User-researched rough range: $20-$100+/clip, $500-$2k+/month retainers",
        "platforms": ["tiktok", "youtube", "instagram", "linkedin", "x"],
        "niches": ["podcasts", "founders", "b2b", "coaches", "real estate", "streamers"],
        "rights_requirement": "client-owned or client-approved content",
        "content_source": "client podcasts, webinars, interviews, founder videos, streams",
        "stability": "reliable",
        "notes": "Not the starting path if there are no clients, but use owned/campaign results as proof later.",
    },
    {
        "name": "Original footage licensing",
        "path": "licensing",
        "source": "Liam notes",
        "url": "",
        "payout_model": "Marketplace licensing royalty",
        "payout_range": "Varies by marketplace/license; user notes mention 30%-50% style royalty structures",
        "platforms": ["newsflare", "jukin", "viralhog", "adobe-stock", "pond5", "shutterstock"],
        "niches": ["travel", "newsworthy", "weather", "b-roll", "unusual-events"],
        "rights_requirement": "original footage you own",
        "content_source": "footage shot or owned by Liam",
        "stability": "occasional",
        "notes": "Different business than clipping internet videos. Only match original footage or clearly owned files.",
    },
]


def seed_opportunities(conn: sqlite3.Connection) -> int:
    created = 0
    for item in SEEDED_OPPORTUNITIES:
        if upsert_opportunity(conn, **item):
            created += 1
    return created


def upsert_opportunity(
    conn: sqlite3.Connection,
    *,
    name: str,
    path: str,
    source: str | None = None,
    url: str | None = None,
    payout_model: str | None = None,
    payout_range: str | None = None,
    platforms: list[str] | None = None,
    niches: list[str] | None = None,
    rights_requirement: str,
    content_source: str,
    stability: str,
    notes: str | None = None,
    status: str = "active",
) -> bool:
    now = db.utc_now()
    existing = conn.execute("SELECT id FROM monetization_opportunities WHERE name = ?", (name,)).fetchone()
    conn.execute(
        """
        INSERT INTO monetization_opportunities
            (name, path, status, source, url, payout_model, payout_range, platforms_json,
             niches_json, rights_requirement, content_source, stability, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            path = excluded.path,
            status = excluded.status,
            source = excluded.source,
            url = excluded.url,
            payout_model = excluded.payout_model,
            payout_range = excluded.payout_range,
            platforms_json = excluded.platforms_json,
            niches_json = excluded.niches_json,
            rights_requirement = excluded.rights_requirement,
            content_source = excluded.content_source,
            stability = excluded.stability,
            notes = excluded.notes,
            updated_at = excluded.updated_at
        """,
        (
            name,
            path,
            status,
            source,
            url,
            payout_model,
            payout_range,
            db.json_dumps(_clean_list(platforms)),
            db.json_dumps(_clean_list(niches)),
            rights_requirement,
            content_source,
            stability,
            notes,
            now,
            now,
        ),
    )
    conn.commit()
    return existing is None


def list_opportunities(conn: sqlite3.Connection, *, active_only: bool = True) -> list[dict[str, Any]]:
    sql = "SELECT * FROM monetization_opportunities"
    params: tuple[Any, ...] = ()
    if active_only:
        sql += " WHERE status = ?"
        params = ("active",)
    sql += " ORDER BY path, name"
    return [_decode_opportunity(row) for row in conn.execute(sql, params).fetchall()]


def match_run(
    conn: sqlite3.Connection,
    run_id: int,
    *,
    niches: list[str] | None = None,
    store: bool = False,
) -> list[dict[str, Any]]:
    bundle = db.get_run_bundle(conn, run_id)
    opportunities = list_opportunities(conn)
    clip_rows = [clip for clip in bundle["clips"] if clip.get("status") in {"rendered", "approved", "scheduled"}]
    requested_niches = set(_clean_list(niches))
    matches: list[dict[str, Any]] = []

    for opportunity in opportunities:
        if requested_niches and not (requested_niches & set(opportunity["niches"])):
            continue
        for clip in clip_rows:
            result = score_match(opportunity, bundle, clip)
            if result["fit_score"] <= 0:
                continue
            result["opportunity"] = opportunity
            result["clip"] = clip
            matches.append(result)
            if store:
                _store_match(conn, opportunity["id"], run_id, int(clip["id"]), result)

    return sorted(matches, key=lambda item: (-item["fit_score"], item["opportunity"]["name"], item["clip"]["id"]))


def score_match(opportunity: dict[str, Any], bundle: dict[str, Any], clip: dict[str, Any]) -> dict[str, Any]:
    source = bundle["source"]
    score = 20
    reasons = [f"path:{opportunity['path']}"]
    warnings: list[str] = []

    if clip.get("status") == "approved":
        score += 30
        reasons.append("clip approved")
    else:
        score -= 15
        warnings.append("clip is not explicitly approved yet")

    if source.get("rights_status") == "approved":
        score += 25
        reasons.append("source rights approved")
    else:
        score -= 20
        warnings.append("source rights_status is research, so posting/scheduling remains blocked")

    source_ref = str(source.get("source_ref") or source.get("local_path") or "").lower()
    creator = str(source.get("creator") or "").lower()
    looks_owned = source.get("source_type") == "file" and ("liam" in creator or not source_ref.startswith("http"))

    path = opportunity["path"]
    if path == "performance_campaign":
        score += 20
        warnings.append("only use campaign-approved footage and follow campaign disclosure/fraud rules")
    elif path == "owned_funnel":
        score += 20 if looks_owned else -5
        if not looks_owned:
            warnings.append("owned funnel works best with original Liam-owned content or strong commentary/transformation")
    elif path == "client_retainer":
        score += 10
        warnings.append("use as proof/case-study unless a client contract grants posting rights")
    elif path == "licensing":
        if looks_owned:
            score += 35
            reasons.append("local/owned source is plausible for licensing")
        else:
            score -= 45
            warnings.append("licensing requires original footage Liam owns; internet clips are a poor fit")

    if clip.get("score") is not None:
        score += min(15, max(0, int(float(clip["score"]) * 10)))
        reasons.append("clip has a score")
    if clip.get("output_path"):
        score += 5
        reasons.append("rendered output exists")

    return {
        "fit_score": max(0, min(100, score)),
        "reasons": reasons,
        "warnings": warnings,
        "suggested_platforms": opportunity["platforms"],
    }


def _store_match(
    conn: sqlite3.Connection,
    opportunity_id: int,
    run_id: int,
    clip_id: int,
    result: dict[str, Any],
) -> None:
    conn.execute(
        """
        INSERT INTO opportunity_clip_matches
            (opportunity_id, run_id, clip_id, fit_score, reasons_json, warnings_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(opportunity_id, run_id, clip_id) DO UPDATE SET
            fit_score = excluded.fit_score,
            reasons_json = excluded.reasons_json,
            warnings_json = excluded.warnings_json,
            created_at = excluded.created_at
        """,
        (
            opportunity_id,
            run_id,
            clip_id,
            int(result["fit_score"]),
            db.json_dumps(result["reasons"]),
            db.json_dumps(result["warnings"]),
            db.utc_now(),
        ),
    )
    conn.commit()


def _decode_opportunity(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["platforms"] = json.loads(item.pop("platforms_json") or "[]")
    item["niches"] = json.loads(item.pop("niches_json") or "[]")
    return item


def _clean_list(values: list[str] | None) -> list[str]:
    return sorted({value.strip().lower() for value in values or [] if value.strip()})
