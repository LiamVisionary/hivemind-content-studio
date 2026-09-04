// ComfyUI is optional: what a local-only surface says when there is none.
//
// The blocker (startup-02) was that the studio could not come up at all without
// an external ComfyUI checkout. With the boot order inverted, a machine with no
// ComfyUI is an ordinary machine — so the failure has to move from "Generate
// blew up" to a section that says "Connect ComfyUI" and carries the button.
//
// The local section is RENDERED here rather than grepped. The whole point is
// which of the three empty states wins: "no image model installed" with an Open
// Models button is the wrong answer on a machine with no engine to install
// into, and that difference is invisible in the source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerHooks } = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

registerHooks({
    load(url, context, nextLoad) {
        if (!url.startsWith('file:') || !url.endsWith('.jsx')) return nextLoad(url, context);
        const file = fileURLToPath(url);
        const { code } = esbuild.transformSync(fs.readFileSync(file, 'utf8'), {
            loader: 'jsx', jsx: 'automatic', format: 'esm', sourcefile: file,
        });
        return { format: 'module', shortCircuit: true, source: code };
    },
});

function memoryStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key),
        clear: () => map.clear(),
        key: () => null,
        get length() { return map.size; },
    };
}
const eventTarget = () => ({ addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
const element = () => ({
    ...eventTarget(),
    style: {},
    children: [],
    firstChild: { data: '' },
    innerHTML: '',
    id: '',
    setAttribute() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
});

globalThis.window = globalThis;
Object.assign(globalThis, eventTarget(), {
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    location: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '', hash: '' },
    localAI: {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    innerWidth: 1280,
    innerHeight: 800,
});
globalThis.document = Object.assign(eventTarget(), {
    body: element(),
    head: element(),
    documentElement: Object.assign(element(), { classList: { add() {}, remove() {}, contains() { return false; } } }),
    createElement: element,
    createTextNode: (data) => ({ data }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    hidden: false,
    visibilityState: 'visible',
    title: '',
});
globalThis.fetch = () => Promise.reject(new Error('network refused in test'));
if (typeof globalThis.CustomEvent !== 'function') {
    globalThis.CustomEvent = class CustomEvent extends Event {
        constructor(type, options = {}) { super(type, options); this.detail = options.detail; }
    };
}

const root = path.join(__dirname, '..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const notice = () => load('src/studios/LocalCatalogNotice.jsx');
const connection = () => load('src/lib/comfyConnection.js');

test('the local section renders the Connect state when no ComfyUI is attached', async () => {
    const { LocalCatalogNotice } = await notice();
    const html = renderToStaticMarkup(React.createElement(LocalCatalogNotice, {
        status: 'empty',
        onCheckAgain() {},
        comfyConnected: false,
    }));

    assert.match(html, /ComfyUI is not connected\./);
    assert.match(html, /Connect ComfyUI/, 'the fix is a button in the same component');
    // The cloud and rented paths still work, so the sentence has to say so
    // rather than reading as "this studio is broken".
    assert.match(html, /cloud or rented model/);
    // The wrong answer for a machine with no engine: nothing downloaded into
    // an absent ComfyUI can run.
    assert.doesNotMatch(html, /Open Models/);
    assert.doesNotMatch(html, /No image model installed/);
});

test('the Connect state wins over "starting" too — there is no engine to wait for', async () => {
    const { LocalCatalogNotice } = await notice();
    const html = renderToStaticMarkup(React.createElement(LocalCatalogNotice, {
        status: 'unreachable',
        onCheckAgain() {},
        comfyConnected: false,
    }));

    assert.match(html, /Connect ComfyUI/);
    assert.doesNotMatch(html, /has not answered yet/);
});

test('a connected machine keeps the model-shaped sentences', async () => {
    const { LocalCatalogNotice } = await notice();
    const empty = renderToStaticMarkup(React.createElement(LocalCatalogNotice, {
        status: 'empty', onCheckAgain() {}, comfyConnected: true,
    }));
    assert.match(empty, /No image model installed yet\./);
    assert.match(empty, /Open Models/);
    assert.doesNotMatch(empty, /Connect ComfyUI/);

    const starting = renderToStaticMarkup(React.createElement(LocalCatalogNotice, {
        status: 'unreachable', onCheckAgain() {}, comfyConnected: true,
    }));
    assert.match(starting, /has not answered yet/);
    assert.doesNotMatch(starting, /Connect ComfyUI/);
});

test('a studio that cannot ask never claims ComfyUI is missing', async () => {
    // `connected: null` is "not known". Sending someone to set up an engine they
    // may already have, because one fetch failed, is worse than saying nothing.
    const { LocalCatalogNotice } = await notice();
    const html = renderToStaticMarkup(React.createElement(LocalCatalogNotice, {
        status: 'empty', onCheckAgain() {}, comfyConnected: null,
    }));

    assert.doesNotMatch(html, /Connect ComfyUI/);
    assert.match(html, /No image model installed yet\./);
});

test('the ready section still renders nothing at all', async () => {
    const { LocalCatalogNotice } = await notice();
    const html = renderToStaticMarkup(React.createElement(LocalCatalogNotice, {
        status: 'ready', onCheckAgain() {}, comfyConnected: false,
    }));
    assert.equal(html, '');
});

test('the Connect card offers the three doors: what is answering, an address, and where to get one', async () => {
    const { ConnectComfyCard } = await load('src/hub/components/ConnectComfyCard.jsx');
    const html = renderToStaticMarkup(React.createElement(ConnectComfyCard, {
        state: {
            connected: false,
            lanes: [{ id: 'default', label: 'Image lane', url: 'http://127.0.0.1:8188', attached: false, reachable: false, detail: 'nothing answered there' }],
            detected: [],
            running: [{ url: 'http://127.0.0.1:8000' }],
            installUrl: 'https://docs.comfy.org/installation/comfyui_desktop/macos',
        },
    }));

    assert.match(html, /Connect ComfyUI/);
    assert.match(html, /Use this one/, 'a ComfyUI that is already answering is one press');
    assert.match(html, /http:\/\/127\.0\.0\.1:8188/, 'the lane is listed, unreachable — never absent');
    assert.match(html, /Not connected/);
    assert.match(html, /docs\.comfy\.org/, 'no installer in v1 — link to ComfyUI’s own instructions');
    // The promise the whole item rests on, said to the user rather than only
    // kept in the code.
    assert.match(html, /never changes a ComfyUI you installed yourself/);
});

test('the connection client refuses to guess when the studio will not answer', async () => {
    const { fetchComfyConnection, resetComfyConnection } = await connection();
    resetComfyConnection();
    const state = await fetchComfyConnection({ force: true });
    assert.equal(state.connected, null, 'a refused fetch is "not known", never a confident false');
    assert.deepEqual(state.lanes, []);
    resetComfyConnection();
});

test('connecting surfaces the server’s own sentence, not a status code', async () => {
    const { connectComfy, resetComfyConnection } = await connection();
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ detail: 'Nothing is serving ComfyUI at http://127.0.0.1:9999 — nothing answered there. Start ComfyUI first, then attach it.' }),
    });
    try {
        await assert.rejects(
            connectComfy('http://127.0.0.1:9999'),
            /Start ComfyUI first/,
        );
    } finally {
        globalThis.fetch = original;
        resetComfyConnection();
    }
});
