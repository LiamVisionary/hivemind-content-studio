"""The .zenc -> .e2e migration re-seals to the vault public key and (opt-in)
removes the machine-decryptable originals."""

import base64
import json
import sqlite3
import subprocess
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import importlib.util


def _mod(name):
    spec = importlib.util.spec_from_file_location(name, str(Path(__file__).with_name(f"{name}.py")))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64url(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _write_vault(path, public_key):
    spki = public_key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE vault_identity (id INTEGER PRIMARY KEY, identity_json TEXT NOT NULL, created_at TEXT, updated_at TEXT)")
    c.execute("INSERT INTO vault_identity VALUES (1, ?, 'x', 'x')", (json.dumps({"public_key": _b64url(spki)}),))
    c.commit(); c.close()


def _make_zenc_file(path, plaintext, password, iters, tmp):
    src = tmp / "pt.bin"
    src.write_bytes(plaintext)
    subprocess.run(
        ["/usr/bin/openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", str(iters), "-salt",
         "-in", str(src), "-out", str(path), "-pass", "stdin"],
        input=(password + "\n"), text=True, capture_output=True, check=True,
    )


def test_migration_reseals_zenc_to_e2e(tmp_path, monkeypatch):
    migrate = _mod("migrate_media_to_e2e")
    keypair = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    vault_db = tmp_path / "owner-vault.sqlite3"
    _write_vault(vault_db, keypair.public_key())

    out = tmp_path / "out"
    out.mkdir()
    password = "unit-test-keychain-pass"
    iters = 50000
    plaintext = b"legacy video bytes " * 300
    zenc = out / "clip_00001_.mp4.zenc"
    _make_zenc_file(zenc, plaintext, password, iters, tmp_path)

    monkeypatch.setattr(migrate, "keychain_password", lambda service: password)

    counts = migrate.migrate([out], vault_db, delete_originals=False, dry_run=False, service="x", iterations=iters)
    assert counts["migrated"] == 1 and counts["failed"] == 0
    envelope_path = out / "clip_00001_.mp4.e2e"
    assert envelope_path.is_file()
    assert zenc.exists(), "originals kept by default"

    envelope = json.loads(envelope_path.read_text())
    dek_iv = keypair.decrypt(_unb64url(envelope["wrapped_dek"]), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    recovered = AESGCM(dek_iv[12:]).decrypt(dek_iv[:12], _unb64url(envelope["ciphertext"]), None)
    assert recovered == plaintext

    # Idempotent + destructive opt-in removes the machine-decryptable original —
    # including files a prior (non-deleting) run already sealed, once the
    # envelope is structurally sound.
    again = migrate.migrate([out], vault_db, delete_originals=True, dry_run=False, service="x", iterations=iters)
    assert again["skipped_existing"] == 1 and again["originals_deleted"] == 1
    assert not zenc.exists()
    assert envelope_path.is_file()
