// Work that used to evaporate.
//
// Two losses, one item: a sprite pipeline — the longest multi-step job in the
// app, a rented-GPU animation plus a matte at ~20 seconds a frame — was plain
// useState and did not survive a reload; and every MUAPI result (Image, Video,
// Lip Sync) was a CDN link this browser remembered and nothing else, so a
// relaunch emptied the gallery with nothing having said it would.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// A minimal server-side vault: an in-memory blob map behind the same endpoints
// the browser uses. It only ever sees the ciphertext strings the client sends.
function stubStudioBrowser({ password = 'owner-pass' } = {}) {
    const local = new Map();
    const session = new Map([['hivemind.ownerPassphrase.once', JSON.stringify({ password, expiresAt: Date.now() + 1e6 })]]);
    global.window = { location: { search: '?hivemindStudio=1' }, dispatchEvent: () => {} };
    global.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
    global.localStorage = {
        getItem: (k) => (local.has(k) ? local.get(k) : null),
        setItem: (k, v) => local.set(k, String(v)),
        removeItem: (k) => local.delete(k),
    };
    global.sessionStorage = { getItem: (k) => (session.has(k) ? session.get(k) : null) };

    const vault = { identity: null, blobs: new Map() };
    global.fetch = async (url, options = {}) => {
        const method = options.method || 'GET';
        if (url === '/api/vault/identity' && method === 'GET') {
            return { ok: true, json: async () => ({ ok: true, exists: !!vault.identity, identity: vault.identity }) };
        }
        if (url === '/api/vault/identity' && method === 'PUT') {
            vault.identity = JSON.parse(options.body).identity;
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        const blobMatch = String(url).match(/^\/api\/vault\/blob\/([^/]+)\/([^/]+)$/);
        if (blobMatch && method === 'GET') {
            return { ok: true, json: async () => ({ ok: true, ciphertext: vault.blobs.get(url) || null }) };
        }
        if (blobMatch && method === 'PUT') {
            vault.blobs.set(url, JSON.parse(options.body).ciphertext);
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
    return vault;
}

const SPRITE_SECTION = {
    subject: 'a copper dragon',
    style: '16bit',
    background: 'chroma',
    action: 'walk',
    customBeat: 'it turns to camera',
    customAction: 'a slow tail flick',
    soundscape: 'wingbeats',
    seconds: 8,
    frameCount: 12,
    matteSubject: 'dragon',
    columns: 4,
    cellSize: 256,
    sheetFps: 12,
    spriteUrl: '/api/media-studio/references/sprite-abc.png',
    clipUrl: '/api/media-studio/generated/cloud-123.mp4',
};

test('a sprite pipeline survives a relaunch: every dial, the sprite and the clip come back', async () => {
    const vault = stubStudioBrowser();
    let mod = await import(`../src/lib/composerState.js?case=${Date.now()}-sprite`);
    await mod.hydrateComposerState();
    mod.updateComposerSection('sprite', SPRITE_SECTION);
    await new Promise((resolve) => setTimeout(resolve, 750));

    // The section left the browser as ciphertext, like every other draft: the
    // subject of a sprite is a prompt and has no business on a server.
    const stored = JSON.stringify([...vault.blobs.values()]);
    assert.ok(stored.length, 'the sprite section was persisted');
    assert.ok(!stored.includes('copper dragon'), 'the sprite subject never leaves the browser in cleartext');

    // Relaunch: same server vault and passphrase, a fresh module instance.
    const reloaded = stubStudioBrowser();
    reloaded.identity = vault.identity;
    reloaded.blobs = vault.blobs;
    mod = await import(`../src/lib/composerState.js?case=${Date.now()}-sprite-reload`);
    await mod.hydrateComposerState();
    assert.deepEqual(mod.getComposerSection('sprite'), SPRITE_SECTION);
});

test('a section the sprite studio has never written reads as empty rather than undefined', async () => {
    stubStudioBrowser();
    const mod = await import(`../src/lib/composerState.js?case=${Date.now()}-sprite-empty`);
    await mod.hydrateComposerState();
    assert.deepEqual(mod.getComposerSection('sprite'), {});
});

test('the sprite studio persists the whole pipeline, and only after it has hydrated', () => {
    const source = fs.readFileSync(require.resolve('../src/studios/SpriteStudio.jsx'), 'utf8');
    assert.match(source, /hydrateComposerState\(\)/);
    assert.match(source, /getComposerSection\('sprite'\)/);
    assert.match(source, /updateComposerSection\('sprite', \{/);
    // A write before hydration would persist the blank defaults over a pipeline
    // that had not finished loading — the trap the Story studio names too.
    assert.match(source, /if \(!hydrated\) return;\s*\n\s*updateComposerSection\('sprite'/);
    for (const field of [
        'subject', 'style', 'background', 'action', 'customBeat', 'customAction', 'soundscape',
        'seconds', 'frameCount', 'matteSubject', 'columns', 'cellSize', 'sheetFps', 'spriteUrl', 'clipUrl',
    ]) {
        assert.match(source, new RegExp(`saved\\.${field}`), `${field} rehydrates`);
    }
    // One download path for the whole studio: the sheet and the atlas are blobs
    // made in this browser, but they still go out through downloadMedia.
    assert.match(source, /import \{ downloadMedia \} from '\.\.\/lib\/downloadMedia\.js'/);
    assert.match(source, /async function saveBlob[\s\S]*await downloadMedia\(url, filename\)/);
    assert.doesNotMatch(source, /link\.download = filename/, 'the hand-rolled anchor download is gone');
});

test('a cloud result is adopted into this workspace, never into the reference picker', () => {
    const source = fs.readFileSync(require.resolve('../src/lib/cloudAdopt.js'), 'utf8');
    assert.match(source, /'\/api\/media-studio\/adopt'/);
    // The references store is the reference PICKER's: an output filed there is
    // offered as an input and never listed as work.
    assert.doesNotMatch(source, /media-studio\/references/);
    // Never blocks a generation and never throws — a keep that failed is said
    // out loud next to Download instead.
    assert.match(source, /return '';/);
});

test('every MUAPI lane keeps its result, and says so when it could not', () => {
    const runner = fs.readFileSync(require.resolve('../src/lib/modelRunner.js'), 'utf8');
    // Both lanes: a still and a clip.
    assert.equal((runner.match(/adoptCloudOutput\(result\.url/g) || []).length, 2);
    assert.match(runner, /kind: 'image', model: row\.id, provider: 'muapi'/);
    assert.match(runner, /kind: 'video', model: row\.id, provider: 'muapi'/);
    // `url` stays the provider's: it is what a later call hands BACK to the
    // provider, and a sealed envelope is not something MUAPI can fetch.
    assert.match(runner, /savedUrl, saved: Boolean\(savedUrl\)/);

    const image = fs.readFileSync(require.resolve('../src/studios/ImageStudio.jsx'), 'utf8');
    assert.match(image, /const kept = res\.savedUrl \|\| res\.url;/);
    assert.match(image, /saved: Boolean\(res\.savedUrl\)/);
    // The crash-safe resume adopts too, or a recovered run would be the one
    // result still living on a soon-dead link.
    assert.match(image, /const \{ url, saved \} = await pollJob\(/);

    const lipsync = fs.readFileSync(require.resolve('../src/studios/LipSyncStudio.jsx'), 'utf8');
    assert.match(lipsync, /const kept = res\.savedUrl \|\| res\.url;/);
    assert.match(lipsync, /adoptCloudOutput\(url, \{\s*\n?\s*kind: 'video'/);

    // The honest interim, on both result surfaces.
    const viewer = fs.readFileSync(require.resolve('../src/studios/image/GalleryAndViewer.jsx'), 'utf8');
    for (const source of [viewer, lipsync]) {
        assert.match(source, /entry\?\.saved === false/);
        assert.match(source, /Not saved — download to keep/);
        assert.match(source, /<Pill tone="warn">/);
    }
});

test('the story studio records an approval and no longer claims to ship', () => {
    const stage = fs.readFileSync(require.resolve('../src/studios/story/ShipStage.jsx'), 'utf8');
    assert.match(stage, /<StageHead title="Approve">/);
    assert.match(stage, /approved \? 'Approved — undo' : 'Approve'/);
    assert.match(stage, /Record that this production passed its checks/);
    // The label, the button and the date line — the copy, not the component's
    // own name, which is a module identity rather than something anyone reads.
    assert.doesNotMatch(stage, /: 'Ship'|'Shipped — undo'|title="Ship it"|`Shipped \$\{/);

    const rail = fs.readFileSync(require.resolve('../src/studios/story/StageRail.jsx'), 'utf8');
    assert.match(rail, /\{ id: 'ship', label: 'Sign-off' \}/);

    const qa = fs.readFileSync(require.resolve('../src/studios/story/qa.js'), 'utf8');
    assert.match(qa, /block\$\{blocking\.length === 1 \? 's' : ''\} approval\./);
    assert.doesNotMatch(qa, /publishing/);

    const studio = fs.readFileSync(require.resolve('../src/studios/StoryStudio.jsx'), 'utf8');
    assert.match(studio, /onApprove=\{approve\}/);
    assert.match(studio, /'Approved\. Finish in order/);
    assert.doesNotMatch(studio, /`Shipped with|'Shipped'/);
});
