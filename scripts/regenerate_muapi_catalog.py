#!/usr/bin/env python3
"""Refresh the one MUAPI catalog from the provider's own schemas.

    passbook run --only MUAPI_API_KEY -- \
        .venv/bin/python scripts/regenerate_muapi_catalog.py --report
    passbook run --only MUAPI_API_KEY -- \
        .venv/bin/python scripts/regenerate_muapi_catalog.py --write

`--report` (the default) changes nothing and prints what a refresh would do.
`--write` applies the input updates and re-stamps `generated_at`.

This exists because the browser used to carry the model list as a 12,779-line
vendored module generated once, by hand, from a dump nothing regenerated. There
is now one catalog — src/hivemind_content_studio/catalog/muapi_models.json —
and this is how it goes back to the provider for the truth.

WHAT IT WILL CHANGE ON ITS OWN
    The value of an input a row already declares and has not pinned: a model
    that gained an aspect ratio upstream, a duration whose range moved, a
    default that changed.

WHAT IT ONLY REPORTS, FOR A PERSON TO DECIDE
    Rows the provider no longer lists. Inputs the provider added or dropped.
    Rows whose pinned inputs now differ from upstream. Each of those is a
    curation decision — see the module docstring in muapi_catalog.py for why
    (the studio strips the provider's upload inputs and supplies them from its
    own uploader; some ladders are deliberately ours; and thirteen models the
    studios still offer are already absent from the provider's listing).

It reads through muapi_proxy, the same module the studio's generation calls go
through, so the key is read in exactly one place and never printed. Schema reads
are GETs — this script generates nothing and spends nothing.

After a `--write`, regenerate the browser's offline fallback too:
    cd packages/open-generative-ai && npm run catalog:offline
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from hivemind_content_studio import muapi_catalog, muapi_proxy  # noqa: E402


def listing() -> dict[str, dict]:
    """`{endpoint_url: row}` for everything the provider currently serves."""
    status, payload, _ = muapi_proxy.forward(method="GET", path="api/v1/models", timeout=60.0)
    if status != 200:
        raise SystemExit(f"MUAPI listing answered {status}")
    models = json.loads(payload).get("models") or []
    return {str(m.get("endpoint_url") or ""): m for m in models if m.get("endpoint_url")}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--write", action="store_true", help="apply input updates (default: report only)")
    write = parser.parse_args().write

    if not muapi_proxy.has_server_key():
        raise SystemExit(
            "MUAPI_API_KEY is not in this process's environment. Run this under "
            "`passbook run --only MUAPI_API_KEY -- …`."
        )

    catalog = json.loads(muapi_catalog.CATALOG_PATH.read_text())
    live_rows = listing()
    endpoints = [muapi_catalog.endpoint_for(row) for row in muapi_catalog.rows()]
    schemas = muapi_catalog.fetch_schemas(endpoints)
    print(f"provider lists {len(live_rows)} models; read schemas for {len(schemas)} of our {len(set(endpoints))}")

    updated = added = removed = pin_drift = 0
    gone: list[str] = []
    for bucket, bucket_rows in catalog["buckets"].items():
        for row in bucket_rows:
            endpoint = muapi_catalog.endpoint_for(row)
            if endpoint not in live_rows:
                gone.append(f"{bucket}/{row['id']}")
            live = schemas.get(endpoint)
            declared = row.get("inputs")
            if not live or not isinstance(declared, dict):
                continue
            pinned = set(row.get("pinned") or ())
            for key in sorted(set(live) - set(declared)):
                added += 1
                print(f"  + {bucket}/{row['id']}: provider added input {key!r} (not adopted)")
            for key in sorted(set(declared) - set(live)):
                removed += 1
                print(f"  - {bucket}/{row['id']}: provider dropped input {key!r} (kept)")
            for key in sorted(set(declared) & set(live)):
                if json.dumps(declared[key], sort_keys=True) == json.dumps(live[key], sort_keys=True):
                    continue
                if key in pinned:
                    pin_drift += 1
                    print(f"  = {bucket}/{row['id']}: pinned input {key!r} still differs from upstream (kept)")
                    continue
                updated += 1
                print(f"  * {bucket}/{row['id']}: input {key!r} refreshed")
                if write:
                    declared[key] = live[key]
            if endpoint in live_rows and write:
                row["upstream_fields"] = list(live_rows[endpoint].get("input_fields") or [])
                row["upstream_required"] = list(live_rows[endpoint].get("required_fields") or [])

    print(
        f"\n{updated} input(s) refreshed, {added} provider-added and {removed} provider-dropped "
        f"input(s) reported, {pin_drift} pinned input(s) still deliberately different."
    )
    if gone:
        print(f"{len(gone)} model(s) the provider no longer lists, kept so saved preferences resolve:")
        for name in gone:
            print(f"  ! {name}")

    if not write:
        print("\nReport only. Re-run with --write to apply the refreshed inputs.")
        return 0

    catalog["generated_at"] = date.today().isoformat()
    muapi_catalog.CATALOG_PATH.write_text(json.dumps(catalog, indent=1, ensure_ascii=False) + "\n")
    print(f"\nwrote {muapi_catalog.CATALOG_PATH}")
    print("Now regenerate the browser fallback: "
          "cd packages/open-generative-ai && npm run catalog:offline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
