"""Gateway E2E media sealing: output is sealed to the owner vault public key,
the plaintext is removed, and the gateway holds no key to decrypt it."""

import importlib.util
import json
import sqlite3
from pathlib import Path

import base64
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _load_gateway():
    spec = importlib.util.spec_from_file_location("gwapp", str(Path(__file__).with_name("app.py")))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _write_vault_db(path: Path, public_key) -> None:
    spki = public_key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE vault_identity (id INTEGER PRIMARY KEY, identity_json TEXT NOT NULL, created_at TEXT, updated_at TEXT)")
    connection.execute(
        "INSERT INTO vault_identity(id, identity_json, created_at, updated_at) VALUES(1, ?, 'x', 'x')",
        (json.dumps({"public_key": _b64url(spki)}),),
    )
    connection.commit()
    connection.close()


def test_gateway_seals_output_to_vault_pubkey_and_removes_plaintext(tmp_path):
    gw = _load_gateway()
    keypair = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    out_dir = tmp_path / "out"
    out_dir.mkdir()
    vault_db = tmp_path / "owner-vault.sqlite3"
    _write_vault_db(vault_db, keypair.public_key())

    # Point the gateway at the temp dirs and enable E2E.
    gw.OUT_DIR = out_dir
    gw.VAULT_DB = vault_db
    gw.E2E_MEDIA_ENABLED = True
    gw._vault_public_key_cache.update(mtime=None, spki=None)

    original = b"\x00\x01\x02fake-mp4-bytes" * 500
    media = out_dir / "clip_00001_.mp4"
    media.write_bytes(original)

    gw.encrypt_output_file(media)

    # Plaintext is gone; only the sealed envelope remains.
    assert not media.exists()
    envelope_path = out_dir / "clip_00001_.mp4.e2e"
    assert envelope_path.is_file()
    assert not (out_dir / "clip_00001_.mp4.zenc").exists(), "must NOT fall back to the server-held key"
    envelope = json.loads(envelope_path.read_text())
    assert envelope["v"] == 1 and envelope["media_type"] == "video/mp4"
    assert original not in envelope_path.read_bytes()  # no plaintext leaked into the envelope

    # Only the private key (which the gateway never has) can recover it.
    dek_and_iv = keypair.decrypt(
        _unb64url(envelope["wrapped_dek"]),
        padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )
    iv, dek = dek_and_iv[:12], dek_and_iv[12:]
    recovered = AESGCM(dek).decrypt(iv, _unb64url(envelope["ciphertext"]), None)
    assert recovered == original

    # The logical path resolves to the envelope, and it is not re-encryptable.
    assert gw.is_encryptable_output(envelope_path) is False
    assert gw.logical_path_for_encrypted(envelope_path).name == "clip_00001_.mp4"


def test_exact_output_path_resolves_e2e_only_files(tmp_path):
    gw = _load_gateway()
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    gw.OUT_DIR = out_dir
    gw.COMFY_OUTPUT_DIR = tmp_path / "absent-comfy"

    # The only on-disk form is the sealed envelope — the logical path must
    # still resolve or history thumbnails 404.
    (out_dir / "anima_00034_.png.e2e").write_text("{}")
    resolved = gw.find_exact_output_logical_path(str(out_dir / "anima_00034_.png"))
    assert resolved is not None and resolved.name == "anima_00034_.png"
    # The sealed physical path normalizes to the same logical output.
    via_physical = gw.find_exact_output_logical_path(str(out_dir / "anima_00034_.png.e2e"))
    assert via_physical is not None and via_physical.name == "anima_00034_.png"
    assert gw.find_exact_output_logical_path(str(out_dir / "missing_00001_.png")) is None


def test_vault_identity_json_returns_wrapped_material_only(tmp_path):
    gw = _load_gateway()
    keypair = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    vault_db = tmp_path / "owner-vault.sqlite3"
    _write_vault_db(vault_db, keypair.public_key())
    gw.VAULT_DB = vault_db

    identity = gw.vault_identity_json()
    assert identity == json.loads(json.dumps(identity))  # plain JSON
    assert "public_key" in identity
    # The store only ever holds wrapped/public fields; bare secrets are rejected
    # upstream (vault_store), so serving the row verbatim leaks nothing.
    assert "master_key" not in identity and "passphrase" not in identity

    gw.VAULT_DB = tmp_path / "absent.sqlite3"
    assert gw.vault_identity_json() is None


def test_gateway_falls_back_to_legacy_when_no_vault_exists(tmp_path):
    gw = _load_gateway()
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    gw.OUT_DIR = out_dir
    gw.VAULT_DB = tmp_path / "absent-vault.sqlite3"  # no vault yet
    gw.E2E_MEDIA_ENABLED = True
    gw._vault_public_key_cache.update(mtime=None, spki=None)

    assert gw.vault_public_key_spki() is None
    media = out_dir / "clip_00002_.png"
    media.write_bytes(b"pngbytes" * 100)
    # seal must decline (no pubkey) so the caller keeps the legacy path available.
    assert gw.seal_output_to_e2e(media) is False
    assert media.exists()  # untouched; legacy encryption would handle it
