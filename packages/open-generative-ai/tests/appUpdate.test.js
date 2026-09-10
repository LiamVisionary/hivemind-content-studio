// The update check: one manifest, correct ordering, and silence on failure.
//
// This is the newest outward-facing thing in the app — it fetches a URL derived
// from the server's own identity and, in the packaged shell, that answer leads
// to replacing the binary. So the ordering is pinned by value (a bad compare
// either hides a real release or offers a downgrade), and the failure paths are
// pinned to "return null", because the UI has no error state and a thrown
// promise here would surface as an unhandled rejection on every boot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');

// sessionStorage-backed cache; each test gets its own so the 6h window does not
// leak between them.
function stubWindow() {
    const store = new Map();
    globalThis.window = {
        sessionStorage: {
            getItem: (key) => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, String(value)),
        },
    };
    return store;
}

test('compareVersions orders releases the way a person expects', async () => {
    const { compareVersions } = await import('../src/lib/appUpdate.js');
    // The bug a string compare has: 10 sorts before 9.
    assert.ok(compareVersions('0.10.0', '0.9.0') > 0, '0.10.0 is newer than 0.9.0');
    assert.ok(compareVersions('0.9.0', '0.10.0') < 0);
    assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
    assert.equal(compareVersions('v0.1.0', '0.1.0'), 0, 'a leading v is not part of the version');
    assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
    // Shorter cores compare as trailing zeros, not as missing.
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
    assert.ok(compareVersions('1.2.1', '1.2') > 0);
    // A prerelease is OLDER than the release it leads to — otherwise promoting
    // 0.2.0 would read as a downgrade to everyone running the beta.
    assert.ok(compareVersions('0.2.0-beta.1', '0.2.0') < 0);
    assert.ok(compareVersions('0.2.0', '0.2.0-beta.1') > 0);
    assert.ok(compareVersions('0.2.0-beta.2', '0.2.0-beta.1') > 0, 'numeric prerelease parts compare as numbers');
    assert.ok(compareVersions('0.2.0-beta.10', '0.2.0-beta.9') > 0);
    // Garbage must not throw and must not claim to be newer.
    assert.equal(compareVersions('', ''), 0);
    assert.ok(compareVersions('', '0.1.0') < 0);
});

test('the manifest URL is derived from the repository, never hard-coded', async () => {
    const { updateManifestUrl, releasesUrl, UPDATE_MANIFEST_PATH } = await import('../src/lib/appUpdate.js');
    assert.equal(
        updateManifestUrl('https://github.com/owner/repo'),
        `https://github.com/owner/repo${UPDATE_MANIFEST_PATH}`,
    );
    // A trailing slash from the server must not double up.
    assert.equal(
        updateManifestUrl('https://github.com/owner/repo/'),
        `https://github.com/owner/repo${UPDATE_MANIFEST_PATH}`,
    );
    assert.equal(releasesUrl('https://github.com/owner/repo'), 'https://github.com/owner/repo/releases/latest');
    // No repository means no check, not a request to a relative path.
    assert.equal(updateManifestUrl(''), '');
    assert.equal(updateManifestUrl(null), '');
    // The literal host is not written down here — it comes from /api/version.
    assert.doesNotMatch(read('lib/appUpdate.js'), /github\.com\/LiamVisionary/, 'the repository must not be hard-coded');
});

test('a newer promoted release is reported, and nothing else is', async () => {
    stubWindow();
    const { checkForUpdate } = await import('../src/lib/appUpdate.js');
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ version: '0.2.0', notes: 'Faster' }) };
    };
    const found = await checkForUpdate({ sourceUrl: 'https://github.com/owner/repo', current: '0.1.0', now: 1 });
    assert.deepEqual(found, {
        version: '0.2.0',
        notes: 'Faster',
        url: 'https://github.com/owner/repo/releases/latest',
    });
    // The studio's cookies must not travel to the release host.
    assert.equal(calls[0].options.credentials, 'omit');
    assert.match(calls[0].url, /\/releases\/latest\/download\/latest\.json$/);
});

test('the same or an older manifest version reports nothing', async () => {
    stubWindow();
    const { checkForUpdate } = await import('../src/lib/appUpdate.js');
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: '0.1.0' }) });
    assert.equal(await checkForUpdate({ sourceUrl: 'https://github.com/o/r', current: '0.1.0', now: 1 }), null);
    stubWindow();
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: '0.0.9' }) });
    assert.equal(await checkForUpdate({ sourceUrl: 'https://github.com/o/r', current: '0.1.0', now: 2 }), null);
});

test('an unreachable, unreleased or malformed manifest is silence, not an error', async () => {
    const { checkForUpdate } = await import('../src/lib/appUpdate.js');
    // No release promoted yet: 404 is the ordinary answer.
    stubWindow();
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    assert.equal(await checkForUpdate({ sourceUrl: 'https://github.com/o/r', current: '0.1.0', now: 1 }), null);
    // Offline.
    stubWindow();
    globalThis.fetch = async () => { throw new Error('network'); };
    assert.equal(await checkForUpdate({ sourceUrl: 'https://github.com/o/r', current: '0.1.0', now: 2 }), null);
    // A manifest that is not JSON.
    stubWindow();
    globalThis.fetch = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
    assert.equal(await checkForUpdate({ sourceUrl: 'https://github.com/o/r', current: '0.1.0', now: 3 }), null);
    // Missing version field.
    stubWindow();
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ notes: 'hi' }) });
    assert.equal(await checkForUpdate({ sourceUrl: 'https://github.com/o/r', current: '0.1.0', now: 4 }), null);
});

test('the answer is cached, so navigating does not re-ask GitHub every mount', async () => {
    stubWindow();
    const { checkForUpdate } = await import('../src/lib/appUpdate.js');
    let hits = 0;
    globalThis.fetch = async () => { hits += 1; return { ok: true, json: async () => ({ version: '0.2.0' }) }; };
    const args = { sourceUrl: 'https://github.com/o/r', current: '0.1.0' };
    await checkForUpdate({ ...args, now: 1000 });
    await checkForUpdate({ ...args, now: 2000 });
    assert.equal(hits, 1, 'the second check inside the window reuses the cached answer');
    // Past the window it asks again...
    await checkForUpdate({ ...args, now: 1000 + 7 * 60 * 60 * 1000 });
    assert.equal(hits, 2);
    // ...and `force` ignores the window entirely.
    await checkForUpdate({ ...args, now: 1000 + 7 * 60 * 60 * 1000, force: true });
    assert.equal(hits, 3);
});

test('the install path is the shell, and a browser is sent to the release instead', () => {
    // Deliberately textual: `installUpdate` reaches Tauri's IPC, which no render
    // and no node test can exercise. What matters is the branch — a page must
    // never mutate the server that serves it — and the reason vocabulary the
    // sidebar turns into a sentence.
    const bridge = read('lib/desktopShell.js');
    assert.match(bridge, /export async function installUpdate\(\)/);
    assert.match(bridge, /if \(!shell\) return \{ ok: false, reason: 'no-shell' \}/, 'no shell means no self-mutation');
    assert.match(bridge, /invoke\('install_update'\)/);
    for (const reason of ['unsigned-channel', 'no-update', 'failed']) {
        assert.ok(bridge.includes(`'${reason}'`), `the bridge must pass through the '${reason}' reason`);
    }

    const shell = read('app/Shell.jsx');
    assert.match(shell, /if \(!inDesktopShell\(\)\) \{/, 'the browser branch comes first');
    assert.match(shell, /window\.open\(update\.url/, 'a browser opens the release rather than installing');
    assert.match(shell, /await installUpdate\(\)/);

    // Every reason the bridge can return has a sentence. A missing key would
    // render the key itself into the sidebar.
    const table = read('lib/i18n.js');
    for (const reason of ['unsigned-channel', 'no-update', 'failed', 'no-shell']) {
        assert.ok(table.includes(`'app.update.${reason}'`), `app.update.${reason} needs a sentence`);
    }
});

test('the update strings resolve to sentences, not to their own keys', async () => {
    // The one failure a source grep cannot see: `t()` and `tf()` RETURN THE KEY
    // when it is missing or when a function key is read with `t()`. Either
    // mistake puts "app.updateReady" in the sidebar instead of words, and this
    // affordance is only visible once a release is promoted — so nobody would
    // find it by looking.
    const { t, tf } = await import('../src/lib/i18n.js');
    assert.equal(tf('app.updateReady', '0.2.0'), 'Update to v0.2.0');
    assert.equal(tf('app.updateTitle', '0.2.0'), 'Install v0.2.0 and relaunch');
    for (const reason of ['unsigned-channel', 'no-update', 'failed', 'no-shell']) {
        const key = `app.update.${reason}`;
        const sentence = t(key);
        assert.notEqual(sentence, key, `${key} resolved to its own key`);
        assert.match(sentence, /[a-z]\s|\.$/, `${key} does not read as a sentence: ${sentence}`);
    }
});

test('the shell command, its manifest entry and its capability all exist', () => {
    // Deliberately textual: this is the three-way agreement Tauri needs and that
    // no JS test can reach. A command missing from build.rs breaks it EVERYWHERE
    // (build.rs says so itself); missing from the studio capability breaks it
    // only on the studio page, which is the one that calls it.
    const root = path.join(__dirname, '..', '..', '..', 'desktop', 'src-tauri');
    const rust = fs.readFileSync(path.join(root, 'src', 'update.rs'), 'utf8');
    assert.match(rust, /#\[tauri::command\]\s*\npub async fn install_update/);
    // The reasons the JS branches on, spelled the same way on both sides.
    for (const reason of ['unsigned-channel', 'no-update', 'failed']) {
        assert.ok(rust.includes(`"${reason}"`), `update.rs must return the '${reason}' reason`);
    }
    assert.match(fs.readFileSync(path.join(root, 'src', 'lib.rs'), 'utf8'), /update::install_update/);
    assert.match(fs.readFileSync(path.join(root, 'build.rs'), 'utf8'), /"install_update"/);
    const capability = JSON.parse(fs.readFileSync(path.join(root, 'capabilities', 'studio.json'), 'utf8'));
    assert.ok(
        capability.permissions.includes('allow-install-update'),
        'the studio page is a remote origin: without this permission the call is denied',
    );
});
