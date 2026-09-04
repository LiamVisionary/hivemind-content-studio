// The store card is RENDERED here, not grepped.
//
// Source assertions caught the wiring; they cannot catch a fit line that paints
// nothing because the doctor's shape moved, a "Try it" button that shows on a
// model nobody has downloaded, or an install button that stays pressable when
// there is no room on the disk. Those are the three things a person meets first
// on an empty machine, so they are rendered against a real hardware payload.
//
// Same harness as hubViewsSmoke: esbuild transforms the JSX at import, the
// browser surface the module touches is stubbed, and effects never run under a
// server render — which is exactly why LocalModelManager carries its test seam.
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
    // The bridge shim's own contract name: `isElectron` is what marks a machine
    // that can hold weights at all. Without it the manager renders the
    // "web build" notice instead of a store.
    localAI: { isElectron: true },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
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
globalThis.fetch = () => Promise.reject(new Error('the network is refused in this test'));

const MAC = {
    platform: 'Darwin',
    arch: 'arm64',
    ram_gb: 36,
    accelerator: { class: 'apple-silicon', label: 'Apple M5 Max', unified_memory: true, vram_gb: 36 },
    models_root: '/Users/owner/comfy/ComfyUI',
    free_disk_gb: 400,
};

const FULL_DISK = { ...MAC, free_disk_gb: 3 };

const CATALOG = [
    {
        id: 'z-image-turbo',
        name: 'Z-Image Turbo',
        description: 'Ultra-fast 8-step generation.',
        type: 'z-image',
        provider: 'sdcpp',
        sizeGB: 3.4,
        state: 'not-downloaded',
        tags: ['turbo', 'fast'],
        featured: true,
    },
    {
        id: 'realistic-vision-v51',
        name: 'Realistic Vision v5.1',
        description: 'Photorealistic people and scenes.',
        type: 'sd1',
        provider: 'sdcpp',
        sizeGB: 2.1,
        state: 'downloaded',
        tags: ['photorealistic'],
    },
];

const MATRIX = {
    ratings: ['good', 'workable', 'unmeasured', 'poor', 'unsupported'],
    features: [
        {
            id: 'story_character_sheet',
            label: 'Draw a character reference sheet',
            rules: [{ match: 'model:realistic-vision-v51', rating: 'good', reason: '', evidence: 'reasoned' }],
        },
    ],
};

function withConsoleErrors(run) {
    const seen = [];
    const original = console.error;
    console.error = (...args) => { seen.push(args.map(String).join(' ')); };
    try { return [run(), seen]; } finally { console.error = original; }
}

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'src/dialogs/LocalModelManager.jsx')).href);

function paint(props) {
    return withConsoleErrors(() => renderToStaticMarkup(React.createElement(Manager, props)));
}

let Manager;
test.before(async () => { Manager = (await load()).LocalModelManager; });

test('an installable card prints what it is for, its size and whether it fits', () => {
    const [html, errors] = paint({ initialModels: CATALOG, initialHardware: MAC, initialMatrix: MATRIX });
    assert.deepEqual(errors, [], 'the store painted without React complaining');

    assert.match(html, /Z-Image Turbo/);
    assert.match(html, /Everyday images, fast enough to iterate on\./, 'the "what it is for" line');
    assert.match(html, /3\.4 GB/, 'the download size');
    assert.match(html, /Fits your 36 GB Mac\./, 'the hardware-fit line, from /api/doctor');
    // Z-Image Turbo is the recommendation on Apple Silicon, and it says so.
    assert.match(html, /Start here/);
});

test('a downloaded model offers Try it; one that is not offers Download', () => {
    const [html] = paint({ initialModels: CATALOG, initialHardware: MAC, initialMatrix: MATRIX });
    assert.match(html, /Try it/, 'the installed model can be tried');
    assert.match(html, /Download/, 'the uninstalled one can be installed');
    // Exactly one of each: "Try it" on a model with no weights on disk is a
    // button that opens a studio onto nothing.
    assert.equal((html.match(/Try it/g) || []).length, 1);
    assert.equal((html.match(/>Download</g) || []).length, 1);
});

test('the capability badges are the server’s verdicts, not the browser’s', () => {
    const [withMatrix] = paint({ initialModels: CATALOG, initialHardware: MAC, initialMatrix: MATRIX });
    assert.match(withMatrix, /Draw a character reference sheet/);
    // No matrix yet: the badges are absent, never invented.
    const [withoutMatrix] = paint({ initialModels: CATALOG, initialHardware: MAC });
    assert.doesNotMatch(withoutMatrix, /Draw a character reference sheet/);
});

test('a full disk disables the install and says where to go instead', () => {
    const [html, errors] = paint({ initialModels: CATALOG, initialHardware: FULL_DISK, initialMatrix: MATRIX });
    assert.deepEqual(errors, []);
    assert.match(html, /Needs 3\.4 GB and the models disk has 3\.0 GB left/);
    assert.match(html, /Change the models folder/, 'the fit line never leaves a dead end');
    // The Download button carries `disabled` and the reason as its title.
    assert.match(html, /disabled="" title="Needs 3\.4 GB and the models disk has 3\.0 GB left\."/);
    // Nothing is recommended when nothing can be installed — "Start here" on a
    // model the disk has no room for is worse than no recommendation.
    assert.doesNotMatch(html, /Start here/);
    // And the model ALREADY on disk is not told it is too big to download.
    assert.doesNotMatch(html, /Needs 2\.1 GB/);
    assert.match(html, /Fits your 36 GB Mac\./);
});

test('before the doctor answers, the card says it is still checking', () => {
    const [html, errors] = paint({ initialModels: CATALOG });
    assert.deepEqual(errors, []);
    assert.match(html, /Checking what this machine can run/);
    // And it is not a refusal: the install button is still live.
    assert.doesNotMatch(html, /needs a rented GPU/);
});
