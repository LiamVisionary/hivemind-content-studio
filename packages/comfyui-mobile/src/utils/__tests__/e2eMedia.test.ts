// E2E media decrypt interop: the gateway seals with media_seal.py (Python,
// RSA-OAEP-SHA256 + AES-GCM) against the owner vault public key; this suite
// proves the mobile client unlocks the vault from the WorkflowUnlockGate
// passphrase and decrypts the sealed bytes — and stays fail-open otherwise.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PY = '/Users/liam/comfy/hivemind-content-studio/.venv/bin/python';
const SEAL = '/Users/liam/comfy/hivemind-content-studio/packages/media-gateway/media_seal.py';
const PASSPHRASE = 'mobile-vault-pass';
const PBKDF2_ITERATIONS = 600_000;

function toB64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface TestVault {
  identity: Record<string, string>;
  publicKeyB64url: string;
}

// Mirror e2eVault.createVaultIdentity (open-generative-ai) — the studio is
// what really creates identities; the mobile app only ever unlocks them.
async function buildVaultIdentity(passphrase: string): Promise<TestVault> {
  const subtle = crypto.subtle;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const mk = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['wrapKey']);
  const keyPair = await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const passKey = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey'],
  );
  const mkIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedMk = await subtle.wrapKey('raw', mk, passKey, { name: 'AES-GCM', iv: mkIv });
  const pkIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedPriv = await subtle.wrapKey('pkcs8', keyPair.privateKey, mk, { name: 'AES-GCM', iv: pkIv });
  const publicKeyB64url = toB64url(await subtle.exportKey('spki', keyPair.publicKey));
  return {
    publicKeyB64url,
    identity: {
      kdf: `PBKDF2-SHA256-${PBKDF2_ITERATIONS}`,
      salt: toB64url(salt),
      wrapped_mk_pass: `${toB64url(mkIv)}.${toB64url(wrappedMk)}`,
      public_key: publicKeyB64url,
      wrapped_private_key: `${toB64url(pkIv)}.${toB64url(wrappedPriv)}`,
    },
  };
}

function sealWithPython(publicKeyB64url: string, plaintext: Buffer): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-e2e-'));
  try {
    fs.writeFileSync(path.join(dir, 'pub.txt'), publicKeyB64url);
    fs.writeFileSync(path.join(dir, 'in.bin'), plaintext);
    execFileSync(PY, [SEAL, '--pub', `@${path.join(dir, 'pub.txt')}`, '--in', path.join(dir, 'in.bin'), '--out', path.join(dir, 'out.json')]);
    return { ...JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')), media_type: 'video/mp4' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function envelopeResponse(envelope: Record<string, string>) {
  return {
    ok: true,
    headers: { get: (name: string) => (name === 'Content-Type' ? 'application/vnd.hivemind.e2e+json' : name === 'X-E2E-Media' ? '1' : null) },
    json: async () => envelope,
    body: { cancel() {} },
  };
}

const createdBlobs: Blob[] = [];

// jsdom's Blob has no arrayBuffer(); FileReader is the portable read path.
function blobBytes(blob: Blob): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(Buffer.from(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

beforeEach(() => {
  vi.resetModules();
  createdBlobs.length = 0;
  URL.createObjectURL = ((blob: Blob) => {
    createdBlobs.push(blob);
    return `blob:mock/${createdBlobs.length - 1}`;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  window.sessionStorage.clear();
});

async function loadModules() {
  const workflowEncryption = await import('@/utils/workflowEncryption');
  const e2eMedia = await import('@/utils/e2eMedia');
  return { workflowEncryption, e2eMedia };
}

describe('mobile E2E media decrypt', () => {
  it('decrypts a Python-sealed envelope after the WorkflowUnlockGate unlock', async () => {
    const vault = await buildVaultIdentity(PASSPHRASE);
    const plaintext = Buffer.from('sealed mobile canvas video bytes '.repeat(48));
    const envelope = sealWithPython(vault.publicKeyB64url, plaintext);

    const { workflowEncryption, e2eMedia } = await loadModules();
    workflowEncryption.setWorkflowEncryptionKey(PASSPHRASE);

    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/e2e/vault-identity') {
        return { ok: true, json: async () => ({ ok: true, exists: true, identity: vault.identity }) } as unknown as Response;
      }
      if (url === '/comfy/view?filename=clip.mp4&type=output') {
        return envelopeResponse(envelope) as unknown as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as unknown as typeof fetch;

    const resolved = await e2eMedia.resolveMediaSrc('/comfy/view?filename=clip.mp4&type=output');
    expect(resolved).toMatch(/^blob:mock\//);
    const recovered = await blobBytes(createdBlobs[0]);
    expect(recovered.equals(plaintext)).toBe(true);
    expect(createdBlobs[0].type).toBe('video/mp4');

    // Cached: a second resolve returns the same blob URL without refetching.
    const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(await e2eMedia.resolveMediaSrc('/comfy/view?filename=clip.mp4&type=output')).toBe(resolved);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fetchCalls);
  }, 30_000);

  it('falls back from the mobile preview endpoint to the /view envelope', async () => {
    const vault = await buildVaultIdentity(PASSPHRASE);
    const plaintext = Buffer.from('preview-fallback bytes '.repeat(24));
    const envelope = sealWithPython(vault.publicKeyB64url, plaintext);

    const { workflowEncryption, e2eMedia } = await loadModules();
    workflowEncryption.setWorkflowEncryptionKey(PASSPHRASE);

    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/e2e/vault-identity') {
        return { ok: true, json: async () => ({ ok: true, exists: true, identity: vault.identity }) } as unknown as Response;
      }
      if (String(url).startsWith('/mobile/api/preview?')) {
        return { ok: false, status: 404, headers: { get: () => null }, body: { cancel() {} } } as unknown as Response;
      }
      if (url === '/comfy/view?filename=sealed.png&type=output&subfolder=') {
        return envelopeResponse(envelope) as unknown as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as unknown as typeof fetch;

    const resolved = await e2eMedia.resolveMediaSrc('/mobile/api/preview?filename=sealed.png&type=output&subfolder=&preview=webp;90&maxedge=2048');
    expect(resolved).toMatch(/^blob:mock\//);
    expect((await blobBytes(createdBlobs[0])).equals(plaintext)).toBe(true);
  }, 30_000);

  it('fails open: locked vault and plaintext media resolve to the original URL', async () => {
    const vault = await buildVaultIdentity(PASSPHRASE);
    const envelope = sealWithPython(vault.publicKeyB64url, Buffer.from('locked bytes'));

    const { e2eMedia } = await loadModules(); // no unlock — vault stays locked
    let bodyCancelled = false;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/comfy/view?filename=locked.mp4') {
        return envelopeResponse(envelope) as unknown as Response;
      }
      if (url === '/comfy/view?filename=plain.png') {
        return {
          ok: true,
          headers: { get: (name: string) => (name === 'Content-Type' ? 'image/png' : null) },
          body: { cancel() { bodyCancelled = true; } },
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as unknown as typeof fetch;

    expect(await e2eMedia.resolveMediaSrc('/comfy/view?filename=locked.mp4')).toBe('/comfy/view?filename=locked.mp4');
    expect(await e2eMedia.resolveMediaSrc('/comfy/view?filename=plain.png')).toBe('/comfy/view?filename=plain.png');
    expect(bodyCancelled).toBe(true);
    expect(await e2eMedia.resolveMediaSrc('blob:already/resolved')).toBe('blob:already/resolved');
  }, 30_000);
});
