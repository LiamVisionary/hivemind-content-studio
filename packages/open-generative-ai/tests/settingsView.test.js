// The Settings page, RENDERED with a real /api/settings payload.
//
// hubViewsSmoke.test.js renders every hub view, but only in its empty state:
// the rows exist once the API has answered, and effects never run under a
// static render. So the table, the badges and the restart affordance would all
// be unrendered code. This renders the page with the payload the control API
// actually sends and asserts the three things a person depends on:
//
// 1. a knob that was only an environment variable now has a row;
// 2. a value an environment variable is still pinning says so, and names the
//    variable and where to remove it — a problem is never shown without its fix;
// 3. a restart-required key does not pretend it took effect.
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

const root = path.join(__dirname, '..');
const importView = async () => (await import(pathToFileURL(path.join(root, 'src/hub/views/SettingsView.jsx')).href)).SettingsView;

const setting = (over) => ({
    key: '', section: '', field: '', kind: 'text', value: '', default: '', source: 'default',
    restart_required: false, env: [], env_override: '', summary: '', ...over,
});

const PAYLOAD = {
    version: 1,
    path: '/Users/someone/.hivemindos/media-studio/content-studio/settings.json',
    readable: true,
    settings: [
        setting({
            key: 'paths.models_root', section: 'paths', field: 'models_root', kind: 'path',
            value: '/Volumes/Weights/ComfyUI', default: '/Users/someone/comfy/ComfyUI',
            source: 'file', restart_required: true, env: ['COMFY_DIR'],
            summary: 'The ComfyUI folder whose models/ subtree holds the local weights.',
        }),
        setting({
            key: 'lanes.ltx', section: 'lanes', field: 'ltx', kind: 'bool',
            value: false, default: false, env: ['COMFY_ENABLE_LTX_LANE'], restart_required: true,
            summary: 'Run the dedicated LTX video lane on this machine.',
        }),
        setting({
            key: 'network.gateway_url', section: 'network', field: 'gateway_url', kind: 'url',
            value: 'http://elsewhere:8787', default: 'http://127.0.0.1:8787',
            source: 'env', env: ['ZIMG_GATEWAY_URL'], env_override: 'ZIMG_GATEWAY_URL',
            summary: 'Where the media gateway answers.',
        }),
        setting({
            key: 'reaper.grace_seconds', section: 'reaper', field: 'grace_seconds', kind: 'int',
            value: 60, default: 60, env: ['HIVEMIND_RENTAL_REAP_GRACE'],
            summary: 'How long a failed box is left alone before it is destroyed.',
        }),
        setting({
            key: 'privacy.output_encryption', section: 'privacy', field: 'output_encryption', kind: 'bool',
            value: true, default: true, restart_required: true, env: ['ZIMG_OUTPUT_ENCRYPTION'],
            summary: 'Encrypt finished media at rest.',
        }),
    ],
};

function render(section) {
    const seen = [];
    const original = console.error;
    console.error = (...args) => { seen.push(args.map(String).join(' ')); };
    try {
        return [
            renderToStaticMarkup(React.createElement(View, { active: true, initialSettings: PAYLOAD, initialSection: section })),
            seen,
        ];
    } finally {
        console.error = original;
    }
}

let View;
test('load the view', async () => { View = await importView(); });

test('the knobs that were environment-only have rows', () => {
    const [storage, errors] = render('storage');
    assert.deepEqual(errors, [], 'the page logged during render');
    assert.match(storage, /Models folder/);
    assert.match(storage, /\/Volumes\/Weights\/ComfyUI/, 'the row shows the value in force');
    assert.match(storage, /LTX video lane/);

    const [advanced] = render('advanced');
    assert.match(advanced, /Media gateway/);
    assert.match(advanced, /Grace period/);
    assert.match(advanced, /Export settings/);
    assert.match(advanced, /Import settings/);
    assert.match(advanced, /Reset every preference/);

    const [privacy] = render('privacy');
    assert.match(privacy, /Encrypt finished media/);

    const [about] = render('about');
    assert.match(about, /content-studio\/settings\.json/, 'About says where the document lives');
});

test('a restart-required key is labelled rather than assumed to have taken effect', () => {
    const [storage] = render('storage');
    assert.match(storage, /needs a restart/);
});

test('a value an environment variable is pinning names the variable and the fix', () => {
    const [advanced] = render('advanced');
    assert.match(advanced, /Overridden/, 'the row carries a badge, not a silent wrong value');
    assert.match(advanced, /ZIMG_GATEWAY_URL/, 'and names the variable');
    assert.match(advanced, /stack-local\.env/, 'and where to remove it');
});

test('the generation defaults section offers a reset per studio', () => {
    const [generation] = render('generation');
    assert.match(generation, /Image/);
    assert.match(generation, /Video/);
    assert.match(generation, /Lip sync/);
    assert.match(generation, /Reset/);
});
