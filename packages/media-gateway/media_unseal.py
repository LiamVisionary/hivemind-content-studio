"""Open an enc:v1 envelope with a private key — the read side of media_seal.py.

The gateway seals every output to a public key and deletes the plaintext, so it
can encrypt but never decrypt. The owner's copy is opened in the browser by
e2eVault.js; this is the equivalent for a NON-browser recipient — an agent that
was registered as a second seal recipient and holds its own private key.

Wire format (must match media_seal.seal and e2eVault.js decryptMedia):
  wrapped_dek = RSA-OAEP-SHA256(public, iv(12) || dek(32))
  ciphertext  = AES-GCM(dek, iv, plaintext)          (ct||tag, as WebCrypto emits)
Both unpadded base64url.

Key material never leaves the machine and is never printed: this reads a private
key file and writes plaintext bytes to a path you choose.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path

from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

DEK_LEN = 32
IV_LEN = 12


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64url(text: str) -> bytes:
    padded = text + "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def load_private_key(path: str | Path):
    return serialization.load_pem_private_key(Path(path).read_bytes(), password=None)


def public_spki_b64url(private_key) -> str:
    """The base64url DER SPKI to hand the gateway as X-E2E-Requester-Pub."""
    return _b64url(
        private_key.public_key().public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    )


def unseal(envelope: dict, private_key) -> bytes:
    try:
        wrapped = _unb64url(envelope["wrapped_dek"])
        ciphertext = _unb64url(envelope["ciphertext"])
    except KeyError as exc:
        raise ValueError(f"envelope is missing {exc}") from exc
    opened = private_key.decrypt(
        wrapped,
        padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )
    if len(opened) != IV_LEN + DEK_LEN:
        raise ValueError(f"unwrapped key is {len(opened)} bytes, expected {IV_LEN + DEK_LEN}")
    iv, dek = opened[:IV_LEN], opened[IV_LEN:]
    return AESGCM(dek).decrypt(iv, ciphertext, None)


def generate_keypair(private_out: str | Path) -> str:
    """Write a fresh 2048-bit private key at 0600 and return its public SPKI.

    2048 to match the owner vault's key size and the gateway's SPKI validator.
    """
    private_out = Path(private_out).expanduser()
    private_out.parent.mkdir(parents=True, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    # Create with restrictive permissions before any bytes land on disk.
    fd = os.open(str(private_out), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, pem)
    finally:
        os.close(fd)
    return public_spki_b64url(key)


def _main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Open an enc:v1 envelope, or make an agent keypair")
    sub = parser.add_subparsers(dest="cmd", required=True)

    keygen = sub.add_parser("keygen", help="write a private key and print its public SPKI")
    keygen.add_argument("--private-out", required=True)
    keygen.add_argument("--public-out", help="also write the base64url SPKI here")

    open_cmd = sub.add_parser("open", help="decrypt an envelope to a file")
    open_cmd.add_argument("--key", required=True, help="PEM private key path")
    open_cmd.add_argument("--in", dest="infile", required=True, help="enc:v1 envelope JSON")
    open_cmd.add_argument("--out", dest="outfile", required=True)

    args = parser.parse_args()
    if args.cmd == "keygen":
        spki = generate_keypair(args.private_out)
        if args.public_out:
            Path(args.public_out).expanduser().write_text(spki, encoding="utf-8")
        print(spki)
        return

    envelope = json.loads(Path(args.infile).read_text(encoding="utf-8"))
    plaintext = unseal(envelope, load_private_key(args.key))
    Path(args.outfile).expanduser().write_bytes(plaintext)
    print(f"{len(plaintext)} bytes -> {args.outfile}")


if __name__ == "__main__":
    _main()
