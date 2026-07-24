"""Owner sessions and encrypted private fields for the browser studio."""

from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from cryptography.hazmat.primitives import hashes as _hashes, serialization as _serialization
from cryptography.hazmat.primitives.asymmetric import padding as _rsa_padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


OWNER_PASSWORD_HASH = "497fc4936661952e9ed6aec6b3b96030130fbfa716e5edacf118e8e792b46107"
OWNER_COOKIE = "hivemind_content_studio_owner"
OWNER_SESSION_SECONDS = 24 * 60 * 60
ENCRYPTED_PREFIX = "enc:v1:"
ENCRYPTED_BYTES_PREFIX = b"enc-bytes:v1:"
PRIVATE_SECRET_ENV = "CONTENT_STUDIO_PRIVATE_SECRET"
PRIVATE_MEDIA_SUFFIX = ".zenc"
# Client-only E2E envelope: sealed to the owner's vault RSA public key. The
# server can encrypt (public key) but NEVER decrypt — only the browser holding
# the passphrase-derived private key can. Same wire format as media_seal.py and
# packages/open-generative-ai/src/lib/e2eVault.js decryptMedia.
E2E_MEDIA_SUFFIX = ".e2e"
RUN_MEDIA_SCOPE = "run-media"


class PrivateFieldCipher:
    """AES-GCM fields whose key is derived from a Keychain-held secret."""

    def __init__(self, key: bytes):
        if len(key) != 32:
            raise ValueError("Private field key must be 32 bytes")
        self._key = key

    @classmethod
    def from_secret(cls, secret: bytes | str) -> "PrivateFieldCipher":
        value = secret.encode("utf-8") if isinstance(secret, str) else secret
        return cls(hashlib.sha256(b"hivemind-content-studio-private-fields-v1\0" + value).digest())

    @classmethod
    def from_keychain(cls, *, service: str = "zimage-output-encryption", create: bool = True) -> "PrivateFieldCipher":
        account = os.environ.get("USER") or "liam"
        command = ["/usr/bin/security", "find-generic-password", "-s", service, "-a", account, "-w"]
        try:
            result = subprocess.run(command, check=False, capture_output=True, timeout=10)
        except (OSError, subprocess.SubprocessError) as exc:
            raise RuntimeError("macOS Keychain is unavailable for private studio state") from exc
        secret = result.stdout.strip() if result.returncode == 0 else b""
        if not secret and create:
            created = base64.urlsafe_b64encode(os.urandom(48))
            add = subprocess.run(
                ["/usr/bin/security", "add-generic-password", "-U", "-s", service, "-a", account, "-w", created.decode("ascii")],
                check=False,
                capture_output=True,
                timeout=10,
            )
            if add.returncode == 0:
                secret = created
        if not secret:
            raise RuntimeError("Private studio encryption key is unavailable")
        return cls.from_secret(secret)

    def encrypt(self, value: str) -> str:
        if value.startswith(ENCRYPTED_PREFIX):
            return value
        nonce = os.urandom(12)
        ciphertext = AESGCM(self._key).encrypt(nonce, value.encode("utf-8"), None)
        return ENCRYPTED_PREFIX + base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")

    def decrypt(self, value: str) -> str:
        if not value.startswith(ENCRYPTED_PREFIX):
            return value
        raw = base64.urlsafe_b64decode(value.removeprefix(ENCRYPTED_PREFIX).encode("ascii"))
        if len(raw) < 28:
            raise ValueError("Encrypted private field is truncated")
        return AESGCM(self._key).decrypt(raw[:12], raw[12:], None).decode("utf-8")

    def encrypt_bytes(self, value: bytes, *, context: str = "") -> bytes:
        nonce = os.urandom(12)
        aad = context.encode("utf-8") if context else None
        ciphertext = AESGCM(self._key).encrypt(nonce, value, aad)
        return ENCRYPTED_BYTES_PREFIX + base64.urlsafe_b64encode(nonce + ciphertext)

    def decrypt_bytes(self, value: bytes, *, context: str = "") -> bytes:
        if not value.startswith(ENCRYPTED_BYTES_PREFIX):
            raise ValueError("Encrypted private bytes are missing the expected prefix")
        raw = base64.urlsafe_b64decode(value.removeprefix(ENCRYPTED_BYTES_PREFIX))
        if len(raw) < 28:
            raise ValueError("Encrypted private bytes are truncated")
        aad = context.encode("utf-8") if context else None
        return AESGCM(self._key).decrypt(raw[:12], raw[12:], aad)

    def digest(self, value: str) -> str:
        return hmac.new(self._key, value.encode("utf-8"), hashlib.sha256).hexdigest()

    def derive(self, label: str) -> bytes:
        return hmac.new(self._key, label.encode("utf-8"), hashlib.sha256).digest()


_configured_cipher: PrivateFieldCipher | None = None
_cipher_cache: dict[tuple[str, str], PrivateFieldCipher] = {}


def configure_private_cipher(cipher: PrivateFieldCipher | None) -> None:
    """Pin the process-wide cipher (tests and embedding apps)."""
    global _configured_cipher
    _configured_cipher = cipher


def private_state_enabled() -> bool:
    return os.environ.get("ZIMG_OUTPUT_ENCRYPTION", "1") != "0"


def _resolve_private_cipher() -> PrivateFieldCipher:
    if _configured_cipher is not None:
        return _configured_cipher
    secret = os.environ.get(PRIVATE_SECRET_ENV, "").strip()
    service = os.environ.get("ZIMG_OUTPUT_KEYCHAIN_SERVICE", "zimage-output-encryption")
    key = (secret, service)
    cipher = _cipher_cache.get(key)
    if cipher is None:
        cipher = PrivateFieldCipher.from_secret(secret) if secret else PrivateFieldCipher.from_keychain(service=service)
        _cipher_cache[key] = cipher
    return cipher


def runtime_private_cipher() -> PrivateFieldCipher | None:
    """Cipher used for new private writes; None only when encryption is disabled."""
    if not private_state_enabled():
        return None
    return _resolve_private_cipher()


def is_private_text_file(path: str | Path) -> bool:
    try:
        with Path(path).expanduser().open("r", encoding="utf-8") as handle:
            return handle.read(len(ENCRYPTED_PREFIX)) == ENCRYPTED_PREFIX
    except (OSError, UnicodeDecodeError):
        return False


def write_private_text(path: str | Path, text: str) -> Path:
    target = Path(path).expanduser()
    cipher = runtime_private_cipher()
    target.write_text(cipher.encrypt(text) + "\n" if cipher else text, encoding="utf-8")
    return target


def read_private_text(path: str | Path) -> str:
    target = Path(path).expanduser()
    body = target.read_text(encoding="utf-8")
    if not body.startswith(ENCRYPTED_PREFIX):
        return body
    # Reads decrypt even when new-write encryption is disabled.
    return _resolve_private_cipher().decrypt(body.strip())


def write_private_json(path: str | Path, payload: Any) -> Path:
    return write_private_text(path, json.dumps(payload, indent=2, sort_keys=True) + "\n")


def read_private_json(path: str | Path) -> Any:
    return json.loads(read_private_text(path))


def private_media_context(path: str | Path, *, scope: str = RUN_MEDIA_SCOPE) -> str:
    return f"{scope}:{Path(path).name}"


def private_media_sidecar(path: str | Path) -> Path:
    target = Path(path)
    return target.with_name(target.name + PRIVATE_MEDIA_SUFFIX)


def private_media_exists(path: str | Path) -> bool:
    target = Path(path)
    return target.is_file() or private_media_sidecar(target).is_file()


def encrypt_private_media(
    path: str | Path,
    *,
    scope: str = RUN_MEDIA_SCOPE,
    cipher: PrivateFieldCipher | None = None,
) -> bool:
    """Replace a plaintext media file with its encrypted `.zenc` sidecar."""
    if not private_state_enabled():
        return False
    selected = cipher if cipher is not None else _resolve_private_cipher()
    target = Path(path).expanduser().resolve()
    sidecar = private_media_sidecar(target)
    if sidecar.is_file() and not target.exists():
        return True
    if not target.is_file():
        return False
    original_stat = target.stat()
    tmp = sidecar.with_name(f"{sidecar.name}.{os.getpid()}.tmp")
    encrypted = selected.encrypt_bytes(target.read_bytes(), context=private_media_context(target, scope=scope))
    try:
        tmp.write_bytes(encrypted)
        os.replace(tmp, sidecar)
        os.utime(sidecar, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
        target.unlink()
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
    return True


def read_private_media(
    path: str | Path,
    *,
    scope: str = RUN_MEDIA_SCOPE,
    cipher: PrivateFieldCipher | None = None,
) -> bytes:
    target = Path(path).expanduser()
    if target.is_file():
        return target.read_bytes()
    sidecar = private_media_sidecar(target)
    if not sidecar.is_file():
        raise FileNotFoundError(str(target))
    selected = cipher if cipher is not None else _resolve_private_cipher()
    return selected.decrypt_bytes(sidecar.read_bytes(), context=private_media_context(target, scope=scope))


# ---- Client-only E2E sealing (owner vault public key; server can never decrypt) ----

def e2e_media_sidecar(path: str | Path) -> Path:
    target = Path(path)
    return target.with_name(target.name + E2E_MEDIA_SUFFIX)


def e2e_media_exists(path: str | Path) -> bool:
    return e2e_media_sidecar(path).is_file()


def read_vault_public_key(vault_db_path: str | Path) -> str | None:
    """Owner vault RSA public key (SPKI base64url) from the studio vault DB, or None."""
    import sqlite3

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


def seal_bytes_to_vault(plaintext: bytes, spki_b64url: str, *, media_type: str) -> dict:
    """Seal bytes to the vault public key. Returns the {ciphertext, wrapped_dek,
    v, media_type} envelope the browser (e2eVault.js decryptMedia) decrypts."""
    padded = spki_b64url + "=" * (-len(spki_b64url) % 4)
    public_key = _serialization.load_der_public_key(base64.urlsafe_b64decode(padded.encode("ascii")))
    dek = os.urandom(32)
    iv = os.urandom(12)
    ciphertext = AESGCM(dek).encrypt(iv, plaintext, None)
    wrapped_dek = public_key.encrypt(
        iv + dek,
        _rsa_padding.OAEP(mgf=_rsa_padding.MGF1(algorithm=_hashes.SHA256()), algorithm=_hashes.SHA256(), label=None),
    )
    return {
        "ciphertext": base64.urlsafe_b64encode(ciphertext).decode("ascii").rstrip("="),
        "wrapped_dek": base64.urlsafe_b64encode(wrapped_dek).decode("ascii").rstrip("="),
        "v": 1,
        "media_type": media_type,
    }


def seal_private_media_e2e(path: str | Path, spki_b64url: str, *, media_type: str) -> bool:
    """Replace a plaintext media file with its `.e2e` envelope sealed to the vault
    public key, then remove the plaintext. Returns False when no public key."""
    if not spki_b64url:
        return False
    target = Path(path).expanduser().resolve()
    if not target.is_file():
        return e2e_media_exists(target)
    original_stat = target.stat()
    envelope = seal_bytes_to_vault(target.read_bytes(), spki_b64url, media_type=media_type)
    sidecar = e2e_media_sidecar(target)
    tmp = sidecar.with_name(f"{sidecar.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(envelope), encoding="utf-8")
        os.replace(tmp, sidecar)
        os.utime(sidecar, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
        target.unlink()
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
    return True


def read_e2e_envelope(path: str | Path) -> bytes | None:
    """Raw `.e2e` envelope bytes for serving to the browser, or None if absent."""
    sidecar = e2e_media_sidecar(path)
    if not sidecar.is_file():
        return None
    return sidecar.read_bytes()


# Text fields (e.g. stored prompts) sealed to the vault: a `vseal:v1:` prefix +
# the same envelope JSON. The server can produce these but never read them back;
# the browser decrypts with e2eVault.decryptMedia + TextDecoder.
VAULT_TEXT_PREFIX = "vseal:v1:"


def is_vault_sealed_text(value: str) -> bool:
    return isinstance(value, str) and value.startswith(VAULT_TEXT_PREFIX)


def seal_text_to_vault(text: str, spki_b64url: str) -> str:
    envelope = seal_bytes_to_vault((text or "").encode("utf-8"), spki_b64url, media_type="text/plain")
    return VAULT_TEXT_PREFIX + json.dumps(envelope, separators=(",", ":"))


@contextmanager
def staged_private_media(
    path: str | Path,
    *,
    scope: str = RUN_MEDIA_SCOPE,
    directory: str | Path | None = None,
) -> Iterator[Path]:
    """Yield a plaintext path for external tools; staged copies are removed."""
    target = Path(path).expanduser()
    if target.is_file():
        yield target
        return
    body = read_private_media(target, scope=scope)
    staging_dir = Path(directory).expanduser() if directory is not None else target.parent
    staging_dir.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".staged-{target.stem}-", suffix=target.suffix, dir=staging_dir)
    staged = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(body)
        yield staged
    finally:
        staged.unlink(missing_ok=True)


@dataclass(frozen=True)
class OwnerAccess:
    password_hash: str
    signing_secret: bytes
    cookie_name: str = OWNER_COOKIE
    session_seconds: int = OWNER_SESSION_SECONDS

    @classmethod
    def from_runtime(cls, cipher: PrivateFieldCipher) -> "OwnerAccess":
        password_hash = os.environ.get("CONTENT_STUDIO_OWNER_PASSWORD_HASH", OWNER_PASSWORD_HASH).strip().lower()
        if len(password_hash) != 64:
            raise RuntimeError("CONTENT_STUDIO_OWNER_PASSWORD_HASH must be a SHA-256 hex digest")
        return cls(password_hash=password_hash, signing_secret=cipher.derive("owner-session-v1"))

    @classmethod
    def for_testing(cls, *, password: str, cipher: PrivateFieldCipher) -> "OwnerAccess":
        return cls(password_hash=hashlib.sha256(password.encode("utf-8")).hexdigest(), signing_secret=cipher.derive("owner-session-v1"))

    def password_matches(self, password: str) -> bool:
        supplied = hashlib.sha256(password.encode("utf-8")).hexdigest()
        return hmac.compare_digest(supplied, self.password_hash)

    def issue(self, *, now: int | None = None) -> str:
        issued = int(time.time()) if now is None else int(now)
        payload = f"{issued + self.session_seconds}.{secrets.token_urlsafe(18)}"
        signature = hmac.new(self.signing_secret, payload.encode("ascii"), hashlib.sha256).digest()
        return f"{payload}.{base64.urlsafe_b64encode(signature).decode('ascii').rstrip('=')}"

    def valid(self, token: str | None, *, now: int | None = None) -> bool:
        if not token:
            return False
        try:
            expires_text, nonce, encoded_signature = token.split(".", 2)
            payload = f"{expires_text}.{nonce}"
            padding = "=" * (-len(encoded_signature) % 4)
            supplied = base64.urlsafe_b64decode(encoded_signature + padding)
            expected = hmac.new(self.signing_secret, payload.encode("ascii"), hashlib.sha256).digest()
            current = int(time.time()) if now is None else int(now)
            return int(expires_text) > current and hmac.compare_digest(supplied, expected)
        except (TypeError, ValueError, base64.binascii.Error):
            return False


def owner_unlock_html() -> str:
    """Standalone lock screen; protected static assets remain unreachable."""
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Hivemind Content Studio</title>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0c0c0e;color:#f2f2f3;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
    main{width:min(400px,100%);display:grid;gap:14px;padding:32px;border:1px solid rgba(255,255,255,.08);border-radius:14px;background:#111114;box-shadow:0 24px 64px -24px rgba(0,0,0,.75)}
    .mark{width:40px;height:40px;display:grid;place-items:center;border-radius:10px;background:rgba(246,178,27,.12);color:#f6b21b}
    p{margin:0;color:#a3a3ac;font-size:13px;line-height:1.55}.eyebrow{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:#f6b21b}
    h1{margin:0;font-size:20px;font-weight:650;letter-spacing:-0.01em;color:#f2f2f3}
    form{display:grid;gap:10px}label{display:grid;gap:6px;font-size:12px;font-weight:500;color:#a3a3ac}
    input{width:100%;height:44px;padding:0 14px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:#17171b;color:#f2f2f3;font:inherit;font-size:14px;outline:0;transition:border-color .15s}
    input:hover{border-color:rgba(255,255,255,.16)}input:focus{border-color:rgba(246,178,27,.6);box-shadow:0 0 0 3px rgba(246,178,27,.14)}
    button{min-height:44px;border:0;border-radius:10px;background:#f6b21b;color:#1a1205;font:600 14px inherit;cursor:pointer;transition:background .15s}
    button:hover{background:#ffc94a}button:active{transform:translateY(1px)}
    .error{min-height:18px;color:#f26d5f;font-size:12px}
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 20 7v10l-8 4.5L4 17V7l8-4.5z"/><path d="M12 8.2 15.4 10v4L12 15.8 8.6 14v-4L12 8.2z" fill="currentColor" stroke="none"/></svg></div>
    <p class="eyebrow">Private owner access</p>
    <h1>Hivemind Content Studio is locked</h1>
    <p>Enter the same private password used by the image studio. This browser stays unlocked for 24 hours.</p>
    <form id="unlock-form">
      <label>Password<input id="password" type="password" autocomplete="current-password" autofocus required></label>
      <p class="error" id="error" role="alert"></p>
      <button type="submit">Unlock studio</button>
    </form>
  </main>
  <script>
    document.getElementById('unlock-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const password = document.getElementById('password').value;
      const error = document.getElementById('error');
      error.textContent = '';
      const response = await fetch('/api/owner/unlock', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
      if (!response.ok) { error.textContent = response.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'Wrong password. Try again.'; return; }
      sessionStorage.setItem('hivemind.ownerPassphrase.once', JSON.stringify({password, expiresAt: Date.now() + 24 * 60 * 60 * 1000}));
      location.reload();
    });
  </script>
</body>
</html>"""
