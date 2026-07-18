"""Owner sessions and encrypted private fields for the browser studio."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import subprocess
import time
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


OWNER_PASSWORD_HASH = "497fc4936661952e9ed6aec6b3b96030130fbfa716e5edacf118e8e792b46107"
OWNER_COOKIE = "hivemind_content_studio_owner"
OWNER_SESSION_SECONDS = 24 * 60 * 60
ENCRYPTED_PREFIX = "enc:v1:"
ENCRYPTED_BYTES_PREFIX = b"enc-bytes:v1:"


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
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#10110e;color:#f7f6f1;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(430px,100%);display:grid;gap:16px;padding:28px;border:1px solid #34362f;border-radius:8px;background:#191a16;box-shadow:0 28px 80px rgba(0,0,0,.38)}
    .mark{width:42px;height:42px;display:grid;place-items:center;border:1px solid #a8ef3f;background:#25271f;color:#a8ef3f;font-weight:800}p{margin:0;color:#b8baaf;line-height:1.5}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#a8ef3f}h1{margin:0;font-size:28px;letter-spacing:0}label{display:grid;gap:7px;font-size:12px;color:#d8d9d2}input{width:100%;padding:13px 14px;border:1px solid #42443b;border-radius:6px;background:#11120f;color:#fff;font:inherit;outline:0}input:focus{border-color:#a8ef3f;box-shadow:0 0 0 3px rgba(168,239,63,.14)}button{min-height:44px;border:0;border-radius:6px;background:#a8ef3f;color:#171811;font:700 13px inherit;cursor:pointer}.error{min-height:18px;color:#ff9b82;font-size:12px}
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">H</div>
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
