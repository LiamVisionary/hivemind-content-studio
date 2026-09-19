#!/usr/bin/env python3
"""Write a workspace's vault PUBLIC key where the media-studio MCP can find it.

Why this exists: an agent can generate PRIVATELY (`private: true` on
media_generate_image / media_generate_video), which seals the output to the
workspace owner's vault only -- like the owner's own private generations. To
do that the MCP needs the owner's public key. This is public material (it can
only encrypt TO the owner; it opens nothing), read out of the workspace vault
and written beside the agent key file the stack already configures.

    scripts/export_owner_pub.py --account 1
    -> ~/.hivemindos/media-studio/secure/owner-e2e-pub

The MCP looks for MEDIA_STUDIO_OWNER_PUB, then MEDIA_STUDIO_OWNER_PUB_FILE,
then this conventional sibling of MEDIA_STUDIO_E2E_PUB_FILE. Re-run after
creating or rotating a vault. Nothing secret is read or written.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--account", type=int, default=1, help="workspace id (default 1, the owner)")
    ap.add_argument("--data-dir", default=str(ROOT / "data"))
    ap.add_argument("--out", default=str(Path.home() / ".hivemindos/media-studio/secure/owner-e2e-pub"))
    args = ap.parse_args()

    vault = Path(args.data_dir) / "accounts" / str(args.account) / "vault.sqlite3"
    if not vault.is_file():
        print(f"no vault for workspace {args.account} at {vault}", file=sys.stderr)
        return 1
    con = sqlite3.connect(f"file:{vault}?immutable=1", uri=True)
    try:
        row = con.execute("SELECT identity_json FROM vault_identity WHERE id = 1").fetchone()
    finally:
        con.close()
    if not row:
        print(f"workspace {args.account} has no vault identity yet", file=sys.stderr)
        return 1
    pub = json.loads(row[0]).get("public_key")
    if not isinstance(pub, str) or len(pub) < 200:
        print("vault identity carries no usable public key", file=sys.stderr)
        return 1

    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(pub + "\n", encoding="utf-8")
    out.chmod(0o644)  # public key: readable is the point
    import hashlib
    print(f"wrote {out}")
    print(f"  workspace {args.account} vault public key, fingerprint {hashlib.sha256(pub.encode()).hexdigest()[:16]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
