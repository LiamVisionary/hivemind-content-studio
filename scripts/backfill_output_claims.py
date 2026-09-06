#!/usr/bin/env python3
"""Backfill OUTPUT-NAME claims for gateway jobs that were only ever claimed by id.

Why: the studio claimed a rented video job for its workspace by job id at
submit, and the background finisher never claimed the resulting output NAME.
The gateway's machine-wide listing is built partly from a file walk, and a
file-walk record carries no job id -- so once the job's route entry aged out,
the clip surfaced with no matching claim, the OWNER adopted it as unclaimed,
and the workspace that actually made it never listed it. Three of
HivemindOSTest's clips ended up under Owner this way.

This resolves every existing `job:<uuid>` claim to its output names through
the gateway's route store (while those entries still exist) and writes the
matching `output:<name>` claims for the same workspace. Additive only: it
never deletes or reassigns a claim. Jobs whose route entry is already gone
cannot be resolved and are reported, not guessed.

    scripts/backfill_output_claims.py            # report only
    scripts/backfill_output_claims.py --write    # add the claims

Then open each workspace's History once (page 1 re-syncs): the workspace
adopts its clips and the owner's listing forgets them.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from hivemind_content_studio.account_scope import GatewayOutputClaims  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", default=str(ROOT / "data"))
    ap.add_argument("--routes", default=str(Path.home() / ".hivemindos/media-studio/state/media-gateway/comfy-prompt-routes.json"))
    ap.add_argument("--write", action="store_true", help="add the output claims (default: report only)")
    args = ap.parse_args()

    ledger_path = Path(args.data_dir) / "gateway-output-claims.sqlite3"
    if not ledger_path.is_file():
        print(f"no claims ledger at {ledger_path}", file=sys.stderr)
        return 1
    routes = json.loads(Path(args.routes).read_text(encoding="utf-8"))
    entries = routes.items() if isinstance(routes, dict) else enumerate(routes)
    outputs_by_job: dict[str, list[str]] = {}
    for job_id, entry in entries:
        if isinstance(entry, dict):
            outputs_by_job[str(job_id)] = [str(o) for o in (entry.get("outputs") or []) if o]

    ledger = GatewayOutputClaims(ledger_path)
    import sqlite3
    con = sqlite3.connect(f"file:{ledger_path}?mode=ro", uri=True)
    rows = con.execute("SELECT claim_key, account_id FROM gateway_output_claims").fetchall()
    con.close()
    existing = {k for k, _ in rows}

    resolved = unresolved = already = added = 0
    per_account: dict[int, int] = {}
    for key, account_id in rows:
        if not key.startswith("job:"):
            continue
        job_id = key[len("job:"):]
        names = outputs_by_job.get(job_id) or outputs_by_job.get(job_id.replace("-", ""))
        if not names:
            unresolved += 1
            continue
        resolved += 1
        for name in names:
            out_key = ledger.output_key(name)
            if out_key in existing:
                already += 1
                continue
            per_account[account_id] = per_account.get(account_id, 0) + 1
            if args.write:
                ledger.claim_output(name, int(account_id))
                existing.add(out_key)
            added += 1

    print(f"  job: claims                 : {sum(1 for k, _ in rows if k.startswith('job:'))}")
    print(f"    resolved via route store  : {resolved}")
    print(f"    unresolvable (entry gone) : {unresolved}")
    print(f"  output claims already present: {already}")
    print(f"  output claims {'ADDED' if args.write else 'to add'}       : {added}   by workspace: {per_account or '{}'}")
    if not args.write:
        print("\n  report only — nothing written. Add --write to add them.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
