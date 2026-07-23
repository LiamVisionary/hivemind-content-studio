"""One-time migration of legacy Keychain-encrypted media (.zenc) to the
client-side E2E envelope (.e2e), sealed to the owner vault public key.

Requires that the owner has created a vault in the browser first (so a public
key exists). Runs locally: it decrypts each .zenc with the machine Keychain key
(which this host still has), then re-seals to the public key — after which the
machine can no longer decrypt it. Keeps the .zenc originals by default until you
confirm a migrated file decrypts in your browser; pass --delete-originals to
remove them (destructive, irreversible).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import media_seal  # noqa: E402

DEFAULT_OUTPUT_DIRS = [
    Path.home() / ".comfy-private.noindex/output",
    Path.home() / ".comfy-private.noindex/z_image_outputs",
    Path.home() / ".comfy-private.noindex/output/Eros",
]
KEYCHAIN_SERVICE = "zimage-output-encryption"
ENCRYPTION_ITER = 50000


def keychain_password(service: str) -> str:
    import os

    account = os.environ.get("USER") or "liam"
    proc = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-s", service, "-a", account, "-w"],
        capture_output=True, text=True, timeout=10,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        raise SystemExit("Keychain encryption key unavailable; cannot decrypt legacy .zenc")
    return proc.stdout.strip()


def decrypt_zenc(path: Path, password: str, iterations: int) -> bytes:
    proc = subprocess.run(
        ["/usr/bin/openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", str(iterations),
         "-in", str(path), "-pass", "stdin"],
        input=(password + "\n").encode(), capture_output=True, timeout=300,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"openssl could not decrypt {path.name}")
    return proc.stdout


def _envelope_is_sealed(envelope: Path) -> bool:
    try:
        payload = json.loads(envelope.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return bool(payload.get("wrapped_dek")) and bool(payload.get("ciphertext"))


def migrate(output_dirs, vault_db, *, delete_originals, dry_run, service, iterations) -> dict:
    spki = media_seal.read_vault_public_key(vault_db)
    if not spki:
        raise SystemExit(f"No vault public key in {vault_db}. Unlock the studio in your browser first.")
    public_key = media_seal.load_public_key(spki)
    password = keychain_password(service)
    counts = {"migrated": 0, "skipped_existing": 0, "failed": 0, "originals_deleted": 0}

    for root in output_dirs:
        root = Path(root).expanduser()
        if not root.is_dir():
            continue
        for zenc in sorted(root.rglob("*.zenc")):
            logical = zenc.with_name(zenc.name[:-len(".zenc")])
            envelope = logical.with_name(logical.name + ".e2e")
            if envelope.exists():
                counts["skipped_existing"] += 1
                # A prior run already sealed this file; --delete-originals must
                # still remove the server-decryptable copy once the envelope is
                # structurally sound (valid JSON with the sealed fields).
                if delete_originals and not dry_run and _envelope_is_sealed(envelope):
                    zenc.unlink()
                    counts["originals_deleted"] += 1
                continue
            try:
                plaintext = decrypt_zenc(zenc, password, iterations)
                sealed = media_seal.seal(plaintext, public_key)
                import mimetypes

                sealed["v"] = 1
                sealed["media_type"] = mimetypes.guess_type(logical.name)[0] or "application/octet-stream"
                if dry_run:
                    print(f"[dry-run] would seal {zenc.name} -> {envelope.name}")
                else:
                    tmp = envelope.with_name(envelope.name + ".tmp")
                    tmp.write_text(json.dumps(sealed), encoding="utf-8")
                    tmp.replace(envelope)
                    if delete_originals:
                        zenc.unlink()
                        counts["originals_deleted"] += 1
                counts["migrated"] += 1
            except Exception as exc:  # noqa: BLE001
                counts["failed"] += 1
                print(f"[migrate] FAILED {zenc}: {exc}", file=sys.stderr)
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate legacy .zenc media to the E2E envelope")
    parser.add_argument("--vault-db", default=str(Path(__file__).resolve().parents[2] / "data" / "owner-vault.sqlite3"))
    parser.add_argument("--output-dir", action="append", default=None, help="repeatable; defaults to the private output dirs")
    parser.add_argument("--delete-originals", action="store_true", help="remove .zenc after sealing (destructive)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--keychain-service", default=KEYCHAIN_SERVICE)
    parser.add_argument("--iterations", type=int, default=ENCRYPTION_ITER)
    args = parser.parse_args()
    dirs = [Path(d) for d in args.output_dir] if args.output_dir else DEFAULT_OUTPUT_DIRS
    counts = migrate(
        dirs, Path(args.vault_db),
        delete_originals=args.delete_originals, dry_run=args.dry_run,
        service=args.keychain_service, iterations=args.iterations,
    )
    print(json.dumps(counts, indent=2))


if __name__ == "__main__":
    main()
