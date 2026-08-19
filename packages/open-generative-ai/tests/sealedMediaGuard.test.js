// Sealed media must never be saved or rendered as if it were the real thing.
//
// resolveMediaSrc is fail-open: locked vault, foreign key, damaged envelope — it
// hands back the ORIGINAL url. downloadMedia then fetched that and wrote the
// envelope to disk under the model-derived name, which is how
// ~/Downloads/video-canvas_b83919a031f17b95af0b.mp4 came to be 2 MB of
// {"ciphertext":…,"wrapped_dek":…,"v":1,"media_type":"video/mp4"} — ffprobe said
// "moov atom not found" and the generation looked broken.
//
// These drive the REAL decrypt path (envelopes sealed here exactly as
// media_seal.py seals them) so the assertions are about actual behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

const toB64url = (bytes) => Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ── browser stubs ────────────────────────────────────────────────────────────
let passphrase = null; // null → this tab never unlocked, so the vault has no key
const dispatched = [];
const opened = [];
const clicked = [];
const objectUrls = [];

global.window = {
    __HIVEMIND_STUDIO__: 1,
    location: { search: '' },
    dispatchEvent(event) { dispatched.push(event); return true; },
    open(url) { opened.push(url); },
};
global.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
global.sessionStorage = {
    getItem: () => (passphrase ? JSON.stringify({ password: passphrase, expiresAt: Date.now() + 60_000 }) : null),
    setItem() {}, removeItem() {},
};
global.document = {
    createElement: () => ({ click() { clicked.push(this); } }),
    body: { appendChild() {}, removeChild() {} },
};
global.URL.createObjectURL = (payload) => { objectUrls.push(payload); return `blob:test/${objectUrls.length}`; };
global.URL.revokeObjectURL = () => {};

function resetProbes() {
    dispatched.length = 0;
    opened.length = 0;
    clicked.length = 0;
    objectUrls.length = 0;
}

/** Seal bytes to `publicKeySpkiB64` exactly as media_seal.py does. */
async function sealMedia(publicKeySpkiB64, bytes) {
    const publicKey = await crypto.subtle.importKey(
        'spki', Buffer.from(publicKeySpkiB64, 'base64'), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const dekRaw = crypto.getRandomValues(new Uint8Array(32));
    const dek = await crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, bytes);
    const wrapped = await crypto.subtle.encrypt(
        { name: 'RSA-OAEP' }, publicKey, Buffer.concat([Buffer.from(iv), Buffer.from(dekRaw)]),
    );
    return { ciphertext: toB64url(new Uint8Array(ciphertext)), wrapped_dek: toB64url(new Uint8Array(wrapped)), v: 1, media_type: 'video/mp4' };
}

/** The gateway's sealed-envelope response: custom header + the e2e Content-Type. */
function envelopeResponse(envelope, { cancelled } = {}) {
    return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'X-E2E-Media' ? '1' : 'application/vnd.hivemind.e2e+json') },
        json: async () => envelope,
        blob: async () => { throw new Error('the envelope body must never be read for saving'); },
        body: { cancel() { if (cancelled) cancelled.hit = true; } },
    };
}

const CLIP_URL = '/api/canvas/history/42/media';

// ── the download guard ───────────────────────────────────────────────────────

test('a locked vault refuses the download instead of saving the envelope', async () => {
    const media = await import('../src/lib/e2eMedia.js');
    const { downloadMedia, MEDIA_DOWNLOAD_BLOCKED_EVENT } = await import('../src/lib/downloadMedia.js');
    const vault = await import('../src/lib/e2eVault.js');
    const session = await import('../src/lib/vaultSession.js');

    // This tab holds a valid owner cookie but never ran the lock screen, so no
    // passphrase was stashed and the vault cannot bootstrap.
    passphrase = null;
    session.resetVaultSession();
    assert.equal(vault.isVaultUnlocked(), false);
    media.clearResolvedMediaCache();
    resetProbes();

    // Sealed to somebody's key — irrelevant, we have none to try.
    const stranger = await crypto.subtle.generateKey(
        { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true, ['encrypt', 'decrypt'],
    );
    const spki = Buffer.from(await crypto.subtle.exportKey('spki', stranger.publicKey)).toString('base64');
    const envelope = await sealMedia(spki, Buffer.from('the real mp4 bytes'));
    global.fetch = async () => envelopeResponse(envelope);

    media.registerMediaDownloadName(CLIP_URL, 'video-canvas_b83919a031f17b95af0b.mp4');
    const result = await downloadMedia(CLIP_URL);

    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'locked');
    assert.equal(objectUrls.length, 0, 'no blob was minted, so nothing could be written to disk');
    assert.equal(clicked.length, 0, 'the download anchor was never clicked');
    assert.equal(opened.length, 0, 'and the envelope JSON was not opened in a tab either');

    const [event] = dispatched;
    assert.equal(event.type, MEDIA_DOWNLOAD_BLOCKED_EVENT);
    assert.equal(event.detail.reason, 'locked');
    assert.match(event.detail.message, /encrypted/i, 'the owner is told why, in plain words');
    assert.match(event.detail.message, /unlock/i, 'a locked vault is recoverable, so say how');
});

test('the seal failure is recorded so display code can show a locked tile', async () => {
    const media = await import('../src/lib/e2eMedia.js');
    assert.equal(media.mediaSealFailure(CLIP_URL), 'locked');
    assert.equal(media.isMediaVaultLocked(CLIP_URL), true);
    assert.equal(media.isMediaVaultLocked('/api/canvas/history/43/media'), false, 'only URLs actually probed are flagged');
});

test('an envelope sealed for a different key is refused too, with different words', async () => {
    const media = await import('../src/lib/e2eMedia.js');
    const { downloadMedia } = await import('../src/lib/downloadMedia.js');
    const vault = await import('../src/lib/e2eVault.js');
    const session = await import('../src/lib/vaultSession.js');

    // The owner IS unlocked this time — this is the rental case, where an
    // agent-submitted job sealed its output to the agent's key only.
    passphrase = 'test-only-passphrase';
    session.resetVaultSession();
    await vault.createVaultIdentity(passphrase);
    assert.equal(vault.isVaultUnlocked(), true);
    media.clearResolvedMediaCache();
    resetProbes();

    const agent = await crypto.subtle.generateKey(
        { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true, ['encrypt', 'decrypt'],
    );
    const agentSpki = Buffer.from(await crypto.subtle.exportKey('spki', agent.publicKey)).toString('base64');
    const envelope = await sealMedia(agentSpki, Buffer.from('bytes only the agent can read'));
    global.fetch = async () => envelopeResponse(envelope);

    const result = await downloadMedia('/api/canvas/history/99/media', 'h3-rental-clip.mp4');

    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'undecryptable');
    assert.equal(objectUrls.length, 0);
    assert.equal(clicked.length, 0);
    assert.equal(media.mediaSealFailure('/api/canvas/history/99/media'), 'undecryptable');
    assert.doesNotMatch(dispatched[0].detail.message, /unlock/i, 'unlocking cannot help — do not send the owner after a password');
    assert.match(dispatched[0].detail.message, /different key/i);
});

test('the refusal reads the response, not the bookkeeping', async () => {
    const media = await import('../src/lib/e2eMedia.js');
    const { downloadMedia } = await import('../src/lib/downloadMedia.js');
    media.clearResolvedMediaCache();
    resetProbes();

    // resolveMediaSrc's probe fails (a 503 from the gateway) so nothing is
    // recorded about this URL — and then the download fetch gets the envelope.
    // The header check has to stand on its own, because it is the only thing
    // between ciphertext and a file named .mp4.
    const url = '/api/canvas/history/7/media';
    const envelope = { ciphertext: 'x', wrapped_dek: 'y', v: 1, media_type: 'video/mp4' };
    let call = 0;
    global.fetch = async () => {
        call += 1;
        if (call === 1) return { ok: false, status: 503, headers: { get: () => null }, body: { cancel() {} } };
        return envelopeResponse(envelope);
    };

    assert.equal(media.mediaSealFailure(url), null, 'precondition: the registry knows nothing about this URL');
    const result = await downloadMedia(url, 'clip.mp4');

    assert.equal(result.blocked, true);
    assert.equal(objectUrls.length, 0);
    assert.equal(clicked.length, 0);
    assert.equal(opened.length, 0);
});

test('plaintext and legacy media still download exactly as before', async () => {
    const media = await import('../src/lib/e2eMedia.js');
    const { downloadMedia } = await import('../src/lib/downloadMedia.js');
    media.clearResolvedMediaCache();
    resetProbes();

    const bytes = Buffer.from([137, 80, 78, 71]);
    global.fetch = async () => ({
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'Content-Type' ? 'image/png' : null) },
        blob: async () => new Blob([bytes], { type: 'image/png' }),
        body: { cancel() {} },
    });

    const url = '/image/krea2-out.png?token=abc';
    media.registerMediaDownloadName(url, 'krea2-abc123.png');
    const result = await downloadMedia(url);

    assert.equal(result.ok, true);
    assert.equal(clicked.length, 1, 'the anchor is clicked, i.e. the file is saved');
    assert.equal(objectUrls[0].name, 'krea2-abc123.png', 'still named after the model');
    assert.equal(objectUrls[0].type, 'image/png');
    assert.equal(dispatched.length, 0, 'nothing to warn about');
});

test('a decrypt that succeeds later clears the flag and notifies the tiles', async () => {
    const media = await import('../src/lib/e2eMedia.js');
    const vault = await import('../src/lib/e2eVault.js');
    const session = await import('../src/lib/vaultSession.js');
    media.clearResolvedMediaCache();
    resetProbes();

    const identity = (await vault.createVaultIdentity('test-only-passphrase')).identity;
    const envelope = await sealMedia(identity.public_key, Buffer.from('real frames'));
    const url = '/api/canvas/history/5/media';

    const seen = [];
    const unsubscribe = media.subscribeMediaSealFailures((changed, reason) => seen.push([changed, reason]));

    // First pass: this tab has no key yet, so the tile goes locked.
    passphrase = null;
    session.resetVaultSession();
    global.fetch = async () => envelopeResponse(envelope);
    assert.equal(await media.resolveMediaSrc(url), url, 'still fail-open');
    assert.equal(media.mediaSealFailure(url), 'locked');

    // The owner unlocks; the next resolve decrypts and the tile must come back.
    await vault.unlockWithPassphrase(identity, 'test-only-passphrase');
    const resolved = await media.resolveMediaSrc(url);
    assert.match(resolved, /^blob:/, 'the media decrypts once the key is there');
    assert.equal(media.mediaSealFailure(url), null, 'a stale lock flag would strand the tile');
    unsubscribe();

    assert.deepEqual(seen, [[url, 'locked'], [url, null]], 'subscribers see both transitions');
});

test('media the vault CAN open still saves the decrypted bytes', async () => {
    const media = await import('../src/lib/e2eMedia.js');
    const { downloadMedia } = await import('../src/lib/downloadMedia.js');
    const vault = await import('../src/lib/e2eVault.js');
    media.clearResolvedMediaCache();
    resetProbes();

    const identity = (await vault.createVaultIdentity('test-only-passphrase')).identity;
    const plaintext = Buffer.from('the actual generated video bytes');
    const envelope = await sealMedia(identity.public_key, plaintext);
    const url = '/api/canvas/history/11/media';

    // resolveMediaSrc decrypts to a blob: URL; downloadMedia then fetches THAT,
    // which (as in a real browser) answers with the blob's own media type — the
    // guard must not mistake a decrypted clip for ciphertext.
    global.fetch = async (target) => {
        if (String(target).startsWith('blob:')) {
            const file = objectUrls[Number(String(target).split('/')[1]) - 1];
            return {
                ok: true,
                status: 200,
                headers: { get: (name) => (name === 'Content-Type' ? file.type : null) },
                blob: async () => file,
                body: { cancel() {} },
            };
        }
        return envelopeResponse(envelope);
    };

    media.registerMediaDownloadName(url, 'minimax-h3-clip.mp4');
    const result = await downloadMedia(url);

    assert.equal(result.ok, true);
    assert.equal(clicked.length, 1, 'the decrypted clip is saved');
    assert.equal(dispatched.length, 0, 'and nothing is refused');
    const saved = objectUrls[objectUrls.length - 1];
    assert.equal(saved.name, 'minimax-h3-clip.mp4');
    assert.deepEqual(Buffer.from(await saved.arrayBuffer()), plaintext, 'plaintext frames, not an envelope');
});

// ── the display half (JSX, so asserted on source like the other studio tests) ─

test('sealed media that cannot be opened renders a tile, not a dead player', () => {
    const thumb = read('src/hub/components/MediaThumb.jsx');
    assert.match(thumb, /export function VaultLockedTile/, 'one tile, shared by thumbs and video cards');
    assert.match(thumb, /'vault-locked'/, 'the thumb has a state for it instead of pointing <img> at JSON');

    const history = read('src/hub/views/HistoryView.jsx');
    assert.match(history, /import \{ MediaThumb, VaultLockedTile \}/);
    // The canvas card is where the corrupt download was noticed: the player just
    // sat there. A sync registry read is not enough — useMediaSrc's fail-open
    // setSrc can hand back the value the element already had, and React bails out
    // of that re-render — so the card subscribes.
    assert.match(history, /useMediaSealFailure\(url\)/);
    assert.match(history, /if \(sealFailure\) return <VaultLockedTile reason=\{sealFailure\} \/>;/);

    const hooks = read('src/hooks/hooks.js');
    assert.match(hooks, /export function useMediaSealFailure/);
    assert.match(hooks, /subscribeMediaSealFailures/, 'a render-time read alone would miss the flip');
});

test('a refused download is surfaced to the owner, not swallowed', () => {
    const app = read('src/app/App.jsx');
    assert.match(app, /MEDIA_DOWNLOAD_BLOCKED_EVENT/);
    assert.match(app, /toast\.error/, 'the owner sees the reason instead of a file that never arrives');

    const downloader = read('src/lib/downloadMedia.js');
    assert.match(downloader, /isSealedEnvelopeResponse\(response\)/);
    // The old fallback opened the URL in a tab on any failure; for sealed media
    // that just shows the envelope JSON, so it is skipped for those.
    assert.match(downloader, /if \(mediaSealFailure\(url\)\) return refuseCiphertext\(url\);/);
});
