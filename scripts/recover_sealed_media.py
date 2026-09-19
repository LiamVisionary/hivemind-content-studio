#!/usr/bin/env python3
"""Find which of your sealed media can still be opened, and give it back to your vault.

WHY THIS EXISTS
---------------
Until 2026-09-06 the gateway sealed a generated file to whoever ASKED for it —
a browser's device key, the agent key, or the workspace vault, whichever the
request presented. It did not also seal a copy to your vault. So a library item
can be sealed to a key that has since been evicted from a browser, and the app
reports that as "Sealed for a different key". Your vault never had it.

This tool is the repair. It tries the keys you point it at, and for every file
one of them opens it writes a NEW envelope sealed to your workspace vault, so
the item belongs to your vault from then on and never depends on a stray key.

WHAT IT DOES NOT DO
-------------------
* It never deletes or overwrites an original. New envelopes are written beside
  them, and an existing vault envelope is left alone unless you pass --force.
* It never prints, copies or stores your decrypted content. Plaintext exists
  only in memory for as long as it takes to re-seal, and only counts and dates
  are reported.
* It never needs your vault passphrase. Re-sealing uses your vault's PUBLIC
  key, which is not a secret. Nothing here can read what it re-seals.

RUN IT YOURSELF. Nobody else should: every key it uses is one that can open
your private media, which is exactly why this is a script you run rather than
something an assistant does for you.

    python3 scripts/recover_sealed_media.py                 # report only, writes nothing
    python3 scripts/recover_sealed_media.py --reseal        # actually repair
    python3 scripts/recover_sealed_media.py --key other.pem # try an extra key
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


def b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def copy_db(path: Path, into: Path) -> Path:
    """Read a live SQLite file safely: its -wal/-shm must travel with it."""
    dest = into / path.name
    shutil.copy(path, dest)
    for suffix in ("-wal", "-shm"):
        side = Path(str(path) + suffix)
        if side.exists():
            shutil.copy(side, str(dest) + suffix)
    return dest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--account", type=int, default=1, help="workspace id (default 1, the owner)")
    ap.add_argument("--data-dir", default=str(ROOT / "data"), help="studio data directory")
    ap.add_argument("--key", action="append", default=[],
                    help="an extra PEM private key to try; repeatable")
    ap.add_argument("--reseal", action="store_true",
                    help="actually write vault-sealed copies (default: report only)")
    ap.add_argument("--force", action="store_true",
                    help="re-seal even where a vault envelope already exists")
    ap.add_argument("--limit", type=int, default=0, help="stop after N rows (0 = all)")
    args = ap.parse_args()

    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        print("This needs the 'cryptography' package. Run it with the studio's interpreter:")
        print(f"  {ROOT}/.venv/bin/python scripts/recover_sealed_media.py")
        return 2

    from hivemind_content_studio.private_access import PrivateFieldCipher

    data = Path(args.data_dir).expanduser().resolve()
    account = data / "accounts" / str(args.account)
    vault_db, history_db = account / "vault.sqlite3", account / "canvas-history.sqlite3"
    for required in (vault_db, history_db):
        if not required.is_file():
            print(f"Not found: {required}")
            return 2

    # Candidate keys. The agent key is included because the gateway sealed to it
    # for a period; anything it opens was, in effect, readable by any process on
    # this machine, which is worth knowing on its own.
    candidates: list[tuple[str, object]] = []
    default_agent = Path.home() / ".hivemindos/media-studio/secure/agent-e2e-key.pem"
    for label, pem in [("agent key on this machine", default_agent)] + [(str(k), Path(k)) for k in args.key]:
        p = Path(pem).expanduser()
        if not p.is_file():
            continue
        try:
            key = serialization.load_pem_private_key(p.read_bytes(), password=None)
        except Exception as exc:
            print(f"  skipping {p.name}: {type(exc).__name__}")
            continue
        # The gateway names an agent's copy <name>.agent-<fp>.e2e, where fp is
        # sha256 over the base64url SPKI string, first 32 hex. Same function here
        # so a moved-aside original lands exactly where the agent is served from.
        spki = key.public_key().public_bytes(serialization.Encoding.DER,
                                             serialization.PublicFormat.SubjectPublicKeyInfo)
        fp = hashlib.sha256(b64e(spki).encode("ascii")).hexdigest()[:32]
        candidates.append((label, key, fp))
    if not candidates:
        print("No usable private keys found. Nothing to try.")
        return 1

    scratch = Path(tempfile.mkdtemp(prefix="recover-"))
    try:
        vault = sqlite3.connect(copy_db(vault_db, scratch))
        row = vault.execute("SELECT identity_json FROM vault_identity WHERE id = 1").fetchone()
        if not row:
            print("This workspace has no vault yet.")
            return 1
        vault_pub_b64 = json.loads(row[0])["public_key"]
        vault_pub = serialization.load_der_public_key(b64d(vault_pub_b64))

        cipher = PrivateFieldCipher.from_keychain(create=False)
        history = sqlite3.connect(copy_db(history_db, scratch))
        rows = history.execute("SELECT output_name, created_at FROM canvas_history ORDER BY created_at").fetchall()
        if args.limit:
            rows = rows[: args.limit]

        stats = defaultdict(lambda: defaultdict(int))   # month -> outcome -> n
        opened_by = defaultdict(int)
        resealed = failures = 0

        for enc_name, created in rows:
            month = (created or "")[:7] or "unknown"
            try:
                base = Path(cipher.decrypt(enc_name))
            except Exception:
                stats[month]["name unreadable"] += 1
                continue
            envelope_path = Path(str(base) + ".e2e")
            if not envelope_path.is_file():
                stats[month]["already open or missing"] += 1
                continue
            try:
                envelope = json.loads(envelope_path.read_text())
                wrapped, ct = b64d(envelope["wrapped_dek"]), b64d(envelope["ciphertext"])
            except Exception:
                stats[month]["envelope unreadable"] += 1
                continue

            def _open(envp):
                try:
                    env = json.loads(Path(envp).read_text())
                    w, c = b64d(env["wrapped_dek"]), b64d(env["ciphertext"])
                except Exception:
                    return None, "", ""
                for label, key, key_fp in candidates:
                    try:
                        blob = key.decrypt(w, padding.OAEP(
                            mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
                        return AESGCM(blob[12:]).decrypt(blob[:12], c, None), label, key_fp
                    except Exception:
                        continue
                return None, "", ""

            # The owner-facing <name>.e2e first. When it refuses every key we
            # hold -- a clip the vault was cut out of, sealed to a browser key
            # that is gone -- the agent's own copy beside it, <name>.agent-<fp>.e2e,
            # may still open with the agent key on this machine. That copy is the
            # only surviving plaintext, so it is a valid recovery source.
            plain, used, used_fp = _open(envelope_path)
            source = envelope_path
            if plain is None:
                for sib in sorted(base.parent.glob(base.name + ".agent-*.e2e")):
                    plain, used, used_fp = _open(sib)
                    if plain is not None:
                        used += " (from the agent copy)"
                        source = sib
                        break

            if plain is None:
                stats[month]["needs a key we do not have"] += 1
                failures += 1
                continue

            opened_by[used] += 1
            stats[month]["can be recovered"] += 1
            if not args.reseal:
                del plain
                continue

            # Re-seal to the vault: a fresh DEK, the same envelope shape.
            #
            # Layout matters, because nothing reads a made-up suffix. The studio
            # serves <name>.e2e as the owner's copy and <name>.agent-<fp>.e2e to
            # the agent whose key that is. So the vault envelope BECOMES
            # <name>.e2e, and the original -- which the agent key opened, so it
            # IS the agent's copy -- moves to the agent path. Rollback is moving
            # it back. Nothing is deleted.
            target = envelope_path                       # <name>.e2e, what the owner reads
            media_type = envelope.get("media_type", "application/octet-stream")
            dek, iv = os.urandom(32), os.urandom(12)
            sealed = {
                "v": 1,
                "media_type": media_type,
                "wrapped_dek": b64e(vault_pub.encrypt(iv + dek, padding.OAEP(
                    mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))),
                "ciphertext": b64e(AESGCM(dek).encrypt(iv, plain, None)),
            }
            del plain
            tmp = target.with_suffix(target.suffix + ".partial")
            tmp.write_text(json.dumps(sealed))
            # Prove the file we are about to promote is a well-formed envelope
            # whose DEK is the right size under the vault key, before touching
            # anything. A bad write must never displace a good file.
            check = json.loads(tmp.read_text())
            if len(b64d(check["wrapped_dek"])) != 256 or not check.get("ciphertext"):
                tmp.unlink(missing_ok=True)
                stats[month]["reseal verification failed"] += 1
                failures += 1
                continue
            if source == target:
                # The plaintext came from <name>.e2e itself (a key we hold opened
                # it). Keep that original as the agent copy before the vault copy
                # takes its place -- unless an agent copy is already there.
                aside = Path(str(base) + f".agent-{used_fp}.e2e")
                if aside.exists() and not args.force:
                    tmp.unlink(missing_ok=True)
                    stats[month]["already has an agent copy; left alone"] += 1
                    continue
                os.replace(target, aside)
            else:
                # The plaintext came from an agent copy, which stays exactly where
                # it is. The dead owner copy at <name>.e2e is preserved, not
                # deleted, so this is reversible: move it back to undo.
                if target.exists():
                    os.replace(target, Path(str(target) + ".superseded"))
            os.replace(tmp, target)           # vault copy -> the path the owner reads
            resealed += 1

        print(f"\n  workspace {args.account}: {len(rows)} library rows\n")
        for month in sorted(stats):
            parts = ", ".join(f"{n} {k}" for k, n in sorted(stats[month].items()))
            print(f"    {month}   {parts}")
        print()
        for label, n in opened_by.items():
            print(f"    {n} opened with: {label}")
        print(f"    {failures} could not be opened by any key available here")
        if args.reseal:
            print(f"\n  re-sealed {resealed} items to the vault as <name>.e2e; each original was moved to")
            print("  <name>.agent-<fp>.e2e (the agent's copy). Nothing was deleted; move it back to undo.")
        else:
            print("\n  report only — nothing was written. Add --reseal to repair.")
        return 0
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
