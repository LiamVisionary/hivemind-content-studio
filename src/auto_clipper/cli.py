"""Command line interface."""

from __future__ import annotations

import argparse
import json
import sys

from . import db
from .config import load_config
from .doctor import checks_json, collect_checks, format_checks
from .ingest import ingest_source
from .monetization import list_opportunities, match_run, seed_opportunities, upsert_opportunity
from .obsidian import write_run_note, write_source_note
from .podcli import render_run
from .scheduling import schedule_run


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not hasattr(args, "func"):
        parser.print_help()
        return 2
    try:
        return int(args.func(args) or 0)
    except db.PolicyError as exc:
        print(f"Policy error: {exc}", file=sys.stderr)
        return 3
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="auto-clipper")
    sub = parser.add_subparsers(dest="command")

    doctor = sub.add_parser("doctor", help="Check local tools and configuration")
    doctor.add_argument("--json", action="store_true", help="Print machine-readable checks")
    doctor.set_defaults(func=cmd_doctor)

    ingest = sub.add_parser("ingest", help="Ingest a URL or local source file")
    ingest.add_argument("source")
    ingest.add_argument("--creator", required=True)
    ingest.add_argument("--metadata-only", action="store_true", help="For URLs, store metadata without downloading video")
    ingest.set_defaults(func=cmd_ingest)

    render = sub.add_parser("render", help="Render clip candidates for a source")
    render.add_argument("source_id", type=int)
    render.add_argument("--top", type=int, default=5)
    render.add_argument("--style", default="branded")
    render.set_defaults(func=cmd_render)

    approve = sub.add_parser("approve", help="Approve selected clips and mark rights as approved")
    approve.add_argument("run_id", type=int)
    approve.add_argument("--clips", required=True, help="Comma-separated clip ids or slugs")
    approve.add_argument("--reviewer", default="liam")
    approve.add_argument("--rights-note", default="Manual approval recorded before scheduling.")
    approve.set_defaults(func=cmd_approve)

    schedule = sub.add_parser("schedule", help="Schedule approved clips through the Postiz planning layer")
    schedule.add_argument("run_id", type=int)
    schedule.add_argument("--platforms", required=True, help="Comma-separated platform names")
    schedule.add_argument("--times", required=True, help="Comma-separated HH:MM times in config timezone")
    schedule.set_defaults(func=cmd_schedule)

    opportunities = sub.add_parser("opportunities", help="Track monetization paths and campaign opportunities")
    opp_sub = opportunities.add_subparsers(dest="opportunities_command")

    opp_seed = opp_sub.add_parser("seed", help="Seed Liam's starter money paths")
    opp_seed.set_defaults(func=cmd_opportunities_seed)

    opp_list = opp_sub.add_parser("list", help="List active monetization opportunities")
    opp_list.add_argument("--all", action="store_true", help="Include paused and closed opportunities")
    opp_list.add_argument("--json", action="store_true", help="Print machine-readable opportunities")
    opp_list.set_defaults(func=cmd_opportunities_list)

    opp_add = opp_sub.add_parser("add", help="Add or update a monetization opportunity")
    opp_add.add_argument("--name", required=True)
    opp_add.add_argument("--path", required=True, choices=["performance_campaign", "owned_funnel", "client_retainer", "licensing"])
    opp_add.add_argument("--platforms", required=True, help="Comma-separated posting or marketplace destinations")
    opp_add.add_argument("--niches", default="", help="Comma-separated niche tags")
    opp_add.add_argument("--rights-requirement", required=True)
    opp_add.add_argument("--content-source", required=True)
    opp_add.add_argument("--stability", default="unknown")
    opp_add.add_argument("--source", default="manual")
    opp_add.add_argument("--url", default="")
    opp_add.add_argument("--payout-model", default="")
    opp_add.add_argument("--payout-range", default="")
    opp_add.add_argument("--notes", default="")
    opp_add.set_defaults(func=cmd_opportunities_add)

    opp_match = opp_sub.add_parser("match", help="Match a rendered run to monetization opportunities")
    opp_match.add_argument("run_id", type=int)
    opp_match.add_argument("--niches", default="", help="Optional comma-separated niche filter")
    opp_match.add_argument("--store", action="store_true", help="Persist match scores in SQLite")
    opp_match.add_argument("--json", action="store_true", help="Print machine-readable matches")
    opp_match.set_defaults(func=cmd_opportunities_match)

    return parser


def cmd_doctor(args) -> int:
    cfg = load_config()
    checks = collect_checks(cfg)
    print(checks_json(checks) if args.json else format_checks(checks))
    return 0 if checks["overall_ok"] else 1


def cmd_ingest(args) -> int:
    cfg = load_config()
    conn = db.init_db(cfg.db_path)
    source_id = ingest_source(conn, cfg, args.source, creator=args.creator, metadata_only=args.metadata_only)
    source = conn.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
    if source:
        note = write_source_note(cfg, dict(source))
        print(f"ingested source_id={source_id}")
        print(f"obsidian_note={note}")
    return 0


def cmd_render(args) -> int:
    cfg = load_config()
    conn = db.init_db(cfg.db_path)
    run_id = render_run(conn, cfg, args.source_id, top=args.top, style=args.style)
    note = write_run_note(conn, cfg, run_id)
    print(f"rendered run_id={run_id}")
    print(f"obsidian_note={note}")
    return 0


def cmd_approve(args) -> int:
    cfg = load_config()
    conn = db.init_db(cfg.db_path)
    clip_ids = db.resolve_clip_ids(conn, args.run_id, args.clips.split(","))
    approval_id = db.approve_run(
        conn,
        run_id=args.run_id,
        clip_ids=clip_ids,
        reviewer=args.reviewer,
        rights_note=args.rights_note,
    )
    note = write_run_note(conn, cfg, args.run_id)
    print(f"approved approval_id={approval_id}")
    print(f"clips={','.join(str(v) for v in clip_ids)}")
    print(f"obsidian_note={note}")
    return 0


def cmd_schedule(args) -> int:
    cfg = load_config()
    conn = db.init_db(cfg.db_path)
    platforms = [value.strip() for value in args.platforms.split(",") if value.strip()]
    times = [value.strip() for value in args.times.split(",") if value.strip()]
    draft_ids = schedule_run(conn, cfg, run_id=args.run_id, platforms=platforms, times=times)
    note = write_run_note(conn, cfg, args.run_id)
    print(f"scheduled_drafts={','.join(str(v) for v in draft_ids)}")
    print(f"obsidian_note={note}")
    return 0


def cmd_opportunities_seed(args) -> int:
    cfg = load_config()
    conn = db.init_db(cfg.db_path)
    created = seed_opportunities(conn)
    print(f"seeded_opportunities={created}")
    return 0


def cmd_opportunities_list(args) -> int:
    cfg = load_config()
    conn = db.init_db(cfg.db_path)
    opportunities = list_opportunities(conn, active_only=not args.all)
    if args.json:
        print(json.dumps(opportunities, indent=2, sort_keys=True))
        return 0
    if not opportunities:
        print("No monetization opportunities yet. Run: auto-clipper opportunities seed")
        return 0
    for opportunity in opportunities:
        platforms = ",".join(opportunity["platforms"])
        niches = ",".join(opportunity["niches"])
        print(
            f"{opportunity['id']}: {opportunity['name']} "
            f"[{opportunity['path']}; {opportunity['stability']}]"
        )
        print(f"  post_to={platforms}")
        print(f"  niches={niches}")
        print(f"  payout={opportunity.get('payout_model') or ''} {opportunity.get('payout_range') or ''}".strip())
        print(f"  rights={opportunity['rights_requirement']}")
    return 0


def cmd_opportunities_add(args) -> int:
    cfg = load_config()
    conn = db.init_db(cfg.db_path)
    created = upsert_opportunity(
        conn,
        name=args.name,
        path=args.path,
        source=args.source,
        url=args.url,
        payout_model=args.payout_model,
        payout_range=args.payout_range,
        platforms=_csv(args.platforms),
        niches=_csv(args.niches),
        rights_requirement=args.rights_requirement,
        content_source=args.content_source,
        stability=args.stability,
        notes=args.notes,
    )
    print("created" if created else "updated")
    return 0


def cmd_opportunities_match(args) -> int:
    cfg = load_config()
    conn = db.init_db(cfg.db_path)
    seed_opportunities(conn)
    matches = match_run(conn, args.run_id, niches=_csv(args.niches), store=args.store)
    if args.json:
        print(json.dumps(matches, indent=2, sort_keys=True))
        return 0
    if not matches:
        print("No matching opportunities found.")
        return 0
    for match in matches[:20]:
        opportunity = match["opportunity"]
        clip = match["clip"]
        print(f"{match['fit_score']:>3} clip={clip['slug']} -> {opportunity['name']}")
        print(f"    post_to={','.join(match['suggested_platforms'])}")
        if match["warnings"]:
            print(f"    warnings={'; '.join(match['warnings'])}")
    return 0


def _csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


if __name__ == "__main__":
    raise SystemExit(main())
