const test = require('node:test');
const assert = require('node:assert/strict');

// Every "keep this" button in the studio ends up in saveBytes. In a browser that
// is an <a download> click; in the packaged Tauri shell it must NOT be, because
// a WKWebView does not carry out anchor downloads of blob: URLs on its own —
// which is how every Download button in the shipped app would have clicked and
// done nothing at all. These pin the branch in both directions, and pin that a
// cancelled save sheet is reported as the user's decision rather than a failure.

global.window = global.window || {};
global.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };

let objectUrls = 0;
global.URL.createObjectURL = () => `blob:test/${++objectUrls}`;
global.URL.revokeObjectURL = () => {};

function stubDocument() {
    const clicked = [];
    global.document = {
        createElement() {
            const anchor = { click() { clicked.push({ href: anchor.href, download: anchor.download }); } };
            return anchor;
        },
        body: { appendChild() {}, removeChild() {} },
    };
    return clicked;
}

function withoutTauri() {
    delete global.window.__TAURI__;
}

/** A Tauri shell that records what it was asked to save. */
function stubTauri({ path = '/Users/someone/Desktop/kept.png', save, write } = {}) {
    const calls = { save: [], write: [] };
    global.window.__TAURI__ = {
        dialog: {
            save: save || (async (options) => { calls.save.push(options); return path; }),
        },
        fs: {
            writeFile: write || (async (target, bytes) => { calls.write.push({ target, bytes }); }),
        },
    };
    return calls;
}

let instance = 0;
function freshSave() {
    instance += 1;
    return import(`../src/lib/downloadMedia.js?saveBytes=${instance}`);
}

test('under Tauri the bytes go through the native save dialog, not an anchor', async () => {
    const { saveBytes } = await freshSave();
    const clicked = stubDocument();
    const calls = stubTauri();

    const result = await saveBytes(new Blob(['sprite'], { type: 'image/png' }), 'hero-sheet.png');

    assert.equal(result.ok, true);
    assert.equal(result.method, 'tauri');
    assert.equal(result.path, '/Users/someone/Desktop/kept.png');
    // The dialog opens on the name the studio derived, and offers its extension.
    assert.equal(calls.save[0].defaultPath, 'hero-sheet.png');
    assert.deepEqual(calls.save[0].filters, [{ name: 'PNG', extensions: ['png'] }]);
    // The bytes actually reached the disk, at the path the dialog returned.
    assert.equal(calls.write[0].target, '/Users/someone/Desktop/kept.png');
    assert.equal(Buffer.from(calls.write[0].bytes).toString(), 'sprite');
    // And no anchor was clicked, which is the thing that does nothing there.
    assert.equal(clicked.length, 0);
});

test('in a browser the same call clicks a named anchor', async () => {
    const { saveBytes } = await freshSave();
    const clicked = stubDocument();
    withoutTauri();

    const result = await saveBytes(new Blob(['sprite'], { type: 'image/png' }), 'hero-sheet.png');

    assert.equal(result.ok, true);
    assert.equal(result.method, 'anchor');
    assert.equal(clicked.length, 1);
    assert.equal(clicked[0].download, 'hero-sheet.png');
    assert.match(clicked[0].href, /^blob:/);
});

test('a cancelled save sheet is the user saying no, not a failure to route around', async () => {
    const { saveBytes } = await freshSave();
    const clicked = stubDocument();
    const calls = stubTauri({ save: async () => null });

    const result = await saveBytes(new Blob(['x'], { type: 'text/plain' }), 'notes.txt');

    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(calls.write.length, 0);
    // Nothing else fires behind the user's back — no anchor, no second attempt.
    assert.equal(clicked.length, 0);
});

test('a shell whose write refuses still saves through the webview', async () => {
    const { saveBytes } = await freshSave();
    const clicked = stubDocument();
    stubTauri({ write: async () => { throw new Error('fs.writeFile not permitted'); } });

    const result = await saveBytes(new Blob(['x'], { type: 'text/plain' }), 'notes.txt');

    assert.equal(result.ok, true);
    assert.equal(result.method, 'anchor');
    assert.equal(clicked.length, 1);
});

test('half a Tauri API is not a save path', async () => {
    const { saveBytes } = await freshSave();
    const clicked = stubDocument();
    // A dialog with no writer is a save sheet that saves nothing.
    global.window.__TAURI__ = { dialog: { save: async () => '/tmp/x' } };

    const result = await saveBytes(new Blob(['x'], { type: 'text/plain' }), 'notes.txt');

    assert.equal(result.method, 'anchor');
    assert.equal(clicked.length, 1);
});

test('with no way to write a file, a recovery key still reaches the clipboard', async () => {
    const { saveBytes } = await freshSave();
    withoutTauri();
    global.document = {
        createElement() { throw new Error('no DOM here'); },
        body: { appendChild() {}, removeChild() {} },
    };
    let copied = null;
    // Node 22 defines `navigator` as a read-only getter, so a plain assignment
    // is silently dropped and the stub never arrives.
    Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: async (text) => { copied = text; } } },
        configurable: true,
    });

    const result = await saveBytes(new Blob(['recovery-key-here'], { type: 'text/plain' }), 'key.txt');

    assert.equal(result.ok, true);
    assert.equal(result.method, 'clipboard');
    assert.equal(copied, 'recovery-key-here');
});
