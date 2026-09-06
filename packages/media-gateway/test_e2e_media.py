"""Gateway E2E media sealing: output is sealed to the owner vault public key,
the plaintext is removed, and the gateway holds no key to decrypt it."""

import importlib.util
import sys
import json
import sqlite3
from pathlib import Path

import base64
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _load_gateway():
    # A fresh world per load: the gateway's state lives in the modules under
    # gateway/, so a cached one would carry the previous test's caches and
    # threads into this one.
    for _cached in [n for n in sys.modules if n == 'gateway' or n.startswith('gateway.')]:
        del sys.modules[_cached]
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
    gw.config.OUT_DIR = out_dir
    gw.media.VAULT_DB = vault_db
    gw.media.E2E_MEDIA_ENABLED = True
    gw.media._vault_public_key_cache.update(mtime=None, spki=None)

    original = b"\x00\x01\x02fake-mp4-bytes" * 500
    media = out_dir / "clip_00001_.mp4"
    media.write_bytes(original)

    gw.media.encrypt_output_file(media)

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
    assert gw.media.is_encryptable_output(envelope_path) is False
    assert gw.media.logical_path_for_encrypted(envelope_path).name == "clip_00001_.mp4"


def test_exact_output_path_resolves_e2e_only_files(tmp_path):
    gw = _load_gateway()
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    gw.config.OUT_DIR = out_dir
    gw.config.COMFY_OUTPUT_DIR = tmp_path / "absent-comfy"

    # The only on-disk form is the sealed envelope — the logical path must
    # still resolve or history thumbnails 404.
    (out_dir / "anima_00034_.png.e2e").write_text("{}")
    resolved = gw.media.find_exact_output_logical_path(str(out_dir / "anima_00034_.png"))
    assert resolved is not None and resolved.name == "anima_00034_.png"
    # The sealed physical path normalizes to the same logical output.
    via_physical = gw.media.find_exact_output_logical_path(str(out_dir / "anima_00034_.png.e2e"))
    assert via_physical is not None and via_physical.name == "anima_00034_.png"
    assert gw.media.find_exact_output_logical_path(str(out_dir / "missing_00001_.png")) is None


def test_vault_identity_json_returns_wrapped_material_only(tmp_path):
    gw = _load_gateway()
    keypair = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    vault_db = tmp_path / "owner-vault.sqlite3"
    _write_vault_db(vault_db, keypair.public_key())
    gw.media.VAULT_DB = vault_db

    identity = gw.media.vault_identity_json()
    assert identity == json.loads(json.dumps(identity))  # plain JSON
    assert "public_key" in identity
    # The store only ever holds wrapped/public fields; bare secrets are rejected
    # upstream (vault_store), so serving the row verbatim leaks nothing.
    assert "master_key" not in identity and "passphrase" not in identity

    gw.media.VAULT_DB = tmp_path / "absent.sqlite3"
    assert gw.media.vault_identity_json() is None


def test_gateway_falls_back_to_legacy_when_no_vault_exists(tmp_path):
    gw = _load_gateway()
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    gw.config.OUT_DIR = out_dir
    gw.media.VAULT_DB = tmp_path / "absent-vault.sqlite3"  # no vault yet
    gw.media.E2E_MEDIA_ENABLED = True
    gw.media._vault_public_key_cache.update(mtime=None, spki=None)

    assert gw.media.vault_public_key_spki() is None
    media = out_dir / "clip_00002_.png"
    media.write_bytes(b"pngbytes" * 100)
    # seal must decline (no pubkey) so the caller keeps the legacy path available.
    assert gw.media.seal_output_to_e2e(media) is False
    assert media.exists()  # untouched; legacy encryption would handle it


def test_agent_reveal_serves_an_agent_copy_but_never_a_private_clip(tmp_path):
    """Rule: an agent generation is workspace-public and may be served
    decrypted; a private clip, sealed only to the vault, never can. The guard
    is structural -- reveal only ever decrypts <name>.agent-<fp>.e2e, and a
    private clip has no such copy."""
    gw = _load_gateway()
    media = sys.modules["gateway.media"]
    import media_seal

    # An agent key on disk, pointed at by the module's PEM path.
    agent = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = tmp_path / "agent-e2e-key.pem"
    pem.write_bytes(agent.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()))
    media.AGENT_E2E_KEY_PEM = pem
    media._agent_private_key_cache = {"mtime": None, "key": None}
    agent_spki = _b64url(agent.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo))
    fp = sys.modules["gateway.promptroutes"].requester_fingerprint(agent_spki)

    plaintext = b"\x00\x00\x00\x18ftypmp42 agent clip bytes"
    base = tmp_path / "cmf-x-minimax_h3_00001_.mp4"

    # 1) An agent copy exists -> reveal returns the plaintext.
    agent_copy = media.agent_envelope_path_for(base, fp)
    sealed = media_seal.seal(plaintext, media_seal.load_public_key(agent_spki))
    sealed["v"] = 1; sealed["media_type"] = "video/mp4"
    agent_copy.write_text(json.dumps(sealed))
    revealed = media.reveal_agent_plaintext(base)
    assert revealed is not None
    assert revealed[0] == plaintext
    assert revealed[1] == "video/mp4"

    # 2) A different key's copy (an agent key that has since rotated away) is
    #    skipped, not served: the current key cannot open it.
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    other_spki = _b64url(other.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo))
    base2 = tmp_path / "cmf-y-minimax_h3_00001_.mp4"
    stale = media.agent_envelope_path_for(base2, sys.modules["gateway.promptroutes"].requester_fingerprint(other_spki))
    s2 = media_seal.seal(plaintext, media_seal.load_public_key(other_spki)); s2["v"] = 1
    stale.write_text(json.dumps(s2))
    assert media.reveal_agent_plaintext(base2) is None

    # 3) A PRIVATE clip -- only <name>.e2e, no agent copy -- can never reveal.
    owner = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    owner_spki = _b64url(owner.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo))
    base3 = tmp_path / "krea2_private_00001_.png"
    priv = media_seal.seal(b"secret pixels", media_seal.load_public_key(owner_spki)); priv["v"] = 1
    media.e2e_envelope_path_for(base3).write_text(json.dumps(priv))
    assert media.reveal_agent_plaintext(base3) is None
