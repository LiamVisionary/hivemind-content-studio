// Client-side decrypt layer for E2E-sealed media (owner vault).
//
// The gateway seals generated outputs to the owner vault's RSA public key and
// serves them as JSON envelopes (Content-Type application/vnd.hivemind.e2e+json,
// X-E2E-Media: 1). The backend cannot decrypt them. This module unlocks the
// vault in-browser from the same passphrase the WorkflowUnlockGate already
// holds, fetches the wrapped vault identity from the token-authed wrapper
// route, and decrypts envelopes to blob URLs for display.
//
// Wire formats must match packages/open-generative-ai/src/lib/e2eVault.js and
// packages/media-gateway/media_seal.py exactly:
//   identity.salt                base64url PBKDF2 salt (600k iterations, SHA-256)
//   identity.wrapped_mk_pass     "<iv-b64url>.<AES-GCM(passKey, MK)-b64url>"
//   identity.wrapped_private_key "<iv-b64url>.<AES-GCM(MK, pkcs8)-b64url>"
//   envelope.wrapped_dek         RSA-OAEP-SHA256(iv(12) || dek(32)), base64url
//   envelope.ciphertext          AES-GCM(dek, iv, media bytes), base64url
//
// Strictly fail-open: legacy plaintext, locked vault, or any error resolves to
// the original URL so display is never worse than before.

import { getWorkflowEncryptionSecret } from './workflowEncryption';
import { comfyRoute } from '@/api/client';

const PBKDF2_ITERATIONS = 600_000;

interface VaultIdentity {
  salt?: string;
  wrapped_mk_pass?: string;
  wrapped_private_key?: string;
}

interface E2EEnvelope {
  ciphertext: string;
  wrapped_dek: string;
  media_type?: string;
}

function fromB64url(text: string): Uint8Array {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '==='.slice((padded.length + 3) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function asBufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

async function fetchVaultIdentity(): Promise<VaultIdentity | null> {
  const response = await fetch('/api/e2e/vault-identity', { credentials: 'same-origin' });
  if (!response.ok) return null;
  const payload = (await response.json()) as { identity?: VaultIdentity | null };
  return payload?.identity ?? null;
}

async function unlockPrivateKey(secret: string): Promise<CryptoKey | null> {
  if (!crypto?.subtle) return null;
  const identity = await fetchVaultIdentity();
  if (!identity?.salt || !identity.wrapped_mk_pass || !identity.wrapped_private_key) return null;
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
  const passKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: asBufferSource(fromB64url(identity.salt)), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['unwrapKey'],
  );
  const [mkIv, mkCt] = identity.wrapped_mk_pass.split('.');
  // A wrong passphrase fails the GCM tag here — no server oracle involved.
  const masterKey = await crypto.subtle.unwrapKey(
    'raw', asBufferSource(fromB64url(mkCt)), passKey, { name: 'AES-GCM', iv: asBufferSource(fromB64url(mkIv)) },
    { name: 'AES-GCM', length: 256 }, false, ['unwrapKey'],
  );
  const [pkIv, pkCt] = identity.wrapped_private_key.split('.');
  return crypto.subtle.unwrapKey(
    'pkcs8', asBufferSource(fromB64url(pkCt)), masterKey, { name: 'AES-GCM', iv: asBufferSource(fromB64url(pkIv)) },
    { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt'],
  );
}

let privateKeyPromise: Promise<CryptoKey | null> | null = null;
let unlockSecretUsed: string | null = null;

function getPrivateKey(): Promise<CryptoKey | null> {
  const secret = getWorkflowEncryptionSecret();
  if (!secret) {
    privateKeyPromise = null;
    unlockSecretUsed = null;
    return Promise.resolve(null);
  }
  if (!privateKeyPromise || unlockSecretUsed !== secret) {
    unlockSecretUsed = secret;
    privateKeyPromise = unlockPrivateKey(secret).catch(() => null);
  }
  return privateKeyPromise;
}

async function decryptEnvelope(envelope: E2EEnvelope, privateKey: CryptoKey): Promise<Blob> {
  const dekRaw = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, asBufferSource(fromB64url(envelope.wrapped_dek))),
  );
  const dek = await crypto.subtle.importKey('raw', asBufferSource(dekRaw.slice(12)), { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const bytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBufferSource(dekRaw.slice(0, 12)) },
    dek,
    asBufferSource(fromB64url(envelope.ciphertext)),
  );
  return new Blob([bytes], { type: envelope.media_type || 'application/octet-stream' });
}

// The mobile preview backend (`/mobile/api/preview`) re-encodes the plaintext
// file on disk, which no longer exists for sealed outputs. Fall back to the
// wrapper's /view route, which serves the E2E envelope for sealed files.
function viewFallbackUrl(url: string): string | null {
  const queryStart = url.indexOf('?');
  if (queryStart < 0 || !url.slice(0, queryStart).endsWith('/mobile/api/preview')) return null;
  const params = new URLSearchParams(url.slice(queryStart + 1));
  params.delete('maxedge');
  params.delete('preview');
  return comfyRoute(`/view?${params.toString()}`);
}

const blobCache = new Map<string, string>(); // original url -> object URL
const inFlight = new Map<string, Promise<string>>();

export function peekResolvedMediaSrc(url: string): string | null {
  return blobCache.get(url) ?? null;
}

async function resolveUncached(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'same-origin' });
  } catch {
    return url; // network error — let the element try normally
  }
  const contentType = response.headers.get('Content-Type') || '';
  const isE2E = response.headers.get('X-E2E-Media') === '1' || contentType.includes('hivemind.e2e');
  if (!response.ok) {
    try { response.body?.cancel(); } catch { /* already consumed */ }
    const fallback = viewFallbackUrl(url);
    if (fallback) {
      const resolved = await resolveMediaSrc(fallback);
      if (resolved !== fallback) {
        blobCache.set(url, resolved);
        return resolved;
      }
    }
    return url;
  }
  if (!isE2E) {
    // Legacy plaintext or non-media: don't buffer it here (videos must stream).
    try { response.body?.cancel(); } catch { /* already consumed */ }
    return url;
  }
  const privateKey = await getPrivateKey();
  if (!privateKey) return url; // locked — can't decrypt now
  const envelope = (await response.json()) as E2EEnvelope;
  const blobUrl = URL.createObjectURL(await decryptEnvelope(envelope, privateKey));
  blobCache.set(url, blobUrl);
  return blobUrl;
}

export async function resolveMediaSrc(url: string): Promise<string> {
  if (!url || typeof url !== 'string' || url.startsWith('blob:') || url.startsWith('data:')) return url;
  const cached = blobCache.get(url);
  if (cached) return cached;
  const pending = inFlight.get(url);
  if (pending) return pending;
  const task = resolveUncached(url)
    .catch(() => url)
    .finally(() => inFlight.delete(url));
  inFlight.set(url, task);
  return task;
}

export function clearResolvedMediaCache(): void {
  for (const blobUrl of blobCache.values()) URL.revokeObjectURL(blobUrl);
  blobCache.clear();
}
