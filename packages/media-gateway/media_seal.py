"""Seal generated media to the owner's vault public key (server-encrypt-only).

The gateway generates the pixels, so it holds plaintext for an instant. Instead
of encrypting under a server-held key, it seals each file to the owner's RSA
public key: a random AES-GCM data key (DEK) encrypts the file, and the DEK is
sealed to the public key. The gateway can encrypt any time (public key) but can
NEVER decrypt — only the browser holding the passphrase-derived private key can.

Wire format matches packages/open-generative-ai/src/lib/e2eVault.js `decryptMedia`:
  ciphertext  = AES-GCM(dek, iv, plaintext)            (ct||tag, as WebCrypto emits)
  wrapped_dek = RSA-OAEP-SHA256(public, iv(12) || dek(32))
Both returned as unpadded base64url.
"""

from __future__ import annotations

import base64
import json
import os
import sqlite3
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives import hashes, serialization


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64url(text: str) -> bytes:
    padded = text + "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def load_public_key(spki_b64url: str):
    return serialization.load_der_public_key(_unb64url(spki_b64url))


def seal(plaintext: bytes, public_key) -> dict[str, str]:
    dek = os.urandom(32)
    iv = os.urandom(12)
    ciphertext = AESGCM(dek).encrypt(iv, plaintext, None)
    wrapped_dek = public_key.encrypt(
        iv + dek,
        padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )
    return {"ciphertext": _b64url(ciphertext), "wrapped_dek": _b64url(wrapped_dek)}


def read_vault_public_key(vault_db_path: str | Path) -> str | None:
    """Read the owner's vault public key from the studio vault DB (opaque)."""
    path = Path(vault_db_path).expanduser()
    if not path.is_file():
        return None
    connection = sqlite3.connect(path, timeout=10)
    try:
        row = connection.execute("SELECT identity_json FROM vault_identity WHERE id = 1").fetchone()
    except sqlite3.OperationalError:
        return None
    finally:
        connection.close()
    if not row:
        return None
    try:
        return json.loads(row[0]).get("public_key")
    except (json.JSONDecodeError, TypeError):
        return None


def _main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Seal a file to the owner vault public key")
    parser.add_argument("--pub", required=True, help="public key spki base64url, or @path to a file containing it")
    parser.add_argument("--in", dest="infile", required=True)
    parser.add_argument("--out", dest="outfile", required=True, help="writes JSON {ciphertext, wrapped_dek}")
    args = parser.parse_args()
    pub_arg = args.pub
    if pub_arg.startswith("@"):
        pub_arg = Path(pub_arg[1:]).read_text(encoding="utf-8").strip()
    sealed = seal(Path(args.infile).read_bytes(), load_public_key(pub_arg))
    Path(args.outfile).write_text(json.dumps(sealed), encoding="utf-8")


if __name__ == "__main__":
    _main()
