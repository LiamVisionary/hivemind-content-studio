"""Optional MCP wrapper for Hermes.

Install with `python -m pip install -e '.[mcp]'`, then run
`auto-clipper-mcp` as a stdio MCP server.
"""

from __future__ import annotations

from . import db
from .config import load_config
from .doctor import collect_checks
from .ingest import ingest_source
from .monetization import list_opportunities, match_run, seed_opportunities
from .obsidian import write_run_note, write_source_note
from .podcli import render_run
from .scheduling import schedule_run


def main() -> None:
    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError as exc:  # pragma: no cover - optional dependency
        raise SystemExit("Install MCP support with: python -m pip install -e '.[mcp]'") from exc

    mcp = FastMCP("auto-clipper")

    @mcp.tool()
    def doctor() -> dict:
        return collect_checks(load_config())

    @mcp.tool()
    def ingest(source: str, creator: str, metadata_only: bool = False) -> dict:
        cfg = load_config()
        conn = db.init_db(cfg.db_path)
        source_id = ingest_source(conn, cfg, source, creator=creator, metadata_only=metadata_only)
        row = conn.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
        note = write_source_note(cfg, dict(row)) if row else None
        return {"source_id": source_id, "obsidian_note": str(note) if note else None}

    @mcp.tool()
    def render(source_id: int, top: int = 5, style: str = "branded") -> dict:
        cfg = load_config()
        conn = db.init_db(cfg.db_path)
        run_id = render_run(conn, cfg, source_id, top=top, style=style)
        note = write_run_note(conn, cfg, run_id)
        return {"run_id": run_id, "obsidian_note": str(note)}

    @mcp.tool()
    def approve(run_id: int, clips: str, reviewer: str = "liam", rights_note: str = "Manual approval.") -> dict:
        cfg = load_config()
        conn = db.init_db(cfg.db_path)
        clip_ids = db.resolve_clip_ids(conn, run_id, clips.split(","))
        approval_id = db.approve_run(
            conn,
            run_id=run_id,
            clip_ids=clip_ids,
            reviewer=reviewer,
            rights_note=rights_note,
        )
        note = write_run_note(conn, cfg, run_id)
        return {"approval_id": approval_id, "clip_ids": clip_ids, "obsidian_note": str(note)}

    @mcp.tool()
    def schedule(run_id: int, platforms: str, times: str) -> dict:
        cfg = load_config()
        conn = db.init_db(cfg.db_path)
        draft_ids = schedule_run(
            conn,
            cfg,
            run_id=run_id,
            platforms=[value.strip() for value in platforms.split(",") if value.strip()],
            times=[value.strip() for value in times.split(",") if value.strip()],
        )
        note = write_run_note(conn, cfg, run_id)
        return {"draft_ids": draft_ids, "obsidian_note": str(note)}

    @mcp.tool()
    def seed_opportunity_paths() -> dict:
        cfg = load_config()
        conn = db.init_db(cfg.db_path)
        return {"seeded": seed_opportunities(conn)}

    @mcp.tool()
    def list_opportunity_paths() -> dict:
        cfg = load_config()
        conn = db.init_db(cfg.db_path)
        return {"opportunities": list_opportunities(conn)}

    @mcp.tool()
    def match_opportunity_paths(run_id: int, niches: str = "", store: bool = False) -> dict:
        cfg = load_config()
        conn = db.init_db(cfg.db_path)
        seed_opportunities(conn)
        niche_list = [value.strip() for value in niches.split(",") if value.strip()]
        return {"matches": match_run(conn, run_id, niches=niche_list, store=store)}

    mcp.run()


if __name__ == "__main__":
    main()
