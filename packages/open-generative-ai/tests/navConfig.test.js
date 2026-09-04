// The nav model and the router contract. Page keys are a wire contract (?page=,
// 'navigate' events), so re-tiering the sidebar must never strand one: every nav
// entry has to resolve, every hub page has to be rendered by HubLayer AND listed
// in HUB_VIEWS (activateHubView silently falls back to 'create' otherwise), and
// STUDIO_PAGES has to match the loader map App.jsx actually keys off.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerHooks } = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

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

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const importSrc = (relative) => import(pathToFileURL(path.join(root, relative)).href);

// i18n reads localStorage at import time through navConfig's label thunks.
if (!globalThis.window) {
    const map = new Map();
    globalThis.window = {
        localStorage: {
            getItem: (key) => (map.has(key) ? map.get(key) : null),
            setItem: (key, value) => map.set(key, String(value)),
            removeItem: (key) => map.delete(key),
        },
        location: { search: '', href: 'http://localhost/', origin: 'http://localhost', port: '' },
        addEventListener() {},
        removeEventListener() {},
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    };
    globalThis.localStorage = globalThis.window.localStorage;
}

test('every nav item is a page the router knows', async () => {
    const { NAV_ITEMS, isKnownPage } = await importSrc('src/app/navConfig.jsx');
    assert.ok(NAV_ITEMS.length > 0, 'the nav is empty');
    for (const item of NAV_ITEMS) {
        assert.ok(isKnownPage(item.page), `nav item '${item.page}' is not a known page`);
        assert.equal(typeof item.label(), 'string');
        assert.ok(item.label().length > 0, `nav item '${item.page}' has no label`);
        assert.ok(item.icon, `nav item '${item.page}' has no icon`);
    }
    // One entry per page — a page listed in two tiers highlights twice.
    const pages = NAV_ITEMS.map((item) => item.page);
    assert.equal(new Set(pages).size, pages.length, 'a page is in the nav twice');
});

test('isKnownPage takes settings and rejects garbage', async () => {
    const { isKnownPage } = await importSrc('src/app/navConfig.jsx');
    // 'settings' used to be a modal the router opened. It is a page now — a
    // packaged app's machine settings do not fit in a dialog — so the key that
    // ⌘, and every old `navigate` event carry has to resolve.
    assert.equal(isKnownPage('settings'), true);
    assert.equal(isKnownPage(''), false);
    assert.equal(isKnownPage(null), false);
    assert.equal(isKnownPage(undefined), false);
    assert.equal(isKnownPage('constructor'), false);
    assert.equal(isKnownPage('toString'), false);
    assert.equal(isKnownPage('image '), false);
});

test('the tiers hold exactly the pages they are meant to', async () => {
    const { NAV_SECTIONS } = await importSrc('src/app/navConfig.jsx');
    const ids = NAV_SECTIONS.map((section) => section.id);
    assert.deepEqual(ids, ['create', 'produce', 'advanced']);

    const create = NAV_SECTIONS.find((section) => section.id === 'create');
    const produce = NAV_SECTIONS.find((section) => section.id === 'produce');
    const advanced = NAV_SECTIONS.find((section) => section.id === 'advanced');

    assert.deepEqual(create.items.map((i) => i.page), ['image', 'video', 'story', 'restore']);
    assert.deepEqual(produce.items.map((i) => i.page), ['planner', 'history', 'runs', 'inspo', 'models']);
    assert.deepEqual(advanced.items.map((i) => i.page), ['machines', 'providers', 'passbook', 'canvas', 'mcp-cli', 'settings']);
    assert.deepEqual(create.labs.items.map((i) => i.page), ['sprite', 'lipsync']);

    // Both folds are collapsed by default and remember what you did with them.
    for (const group of [create.labs, advanced]) {
        assert.equal(group.collapsible, true, `${group.id} must be collapsible`);
        assert.equal(group.defaultOpen, false, `${group.id} must start collapsed`);
        assert.equal(typeof group.storageKey, 'string');
        assert.ok(group.storageKey, `${group.id} needs a storageKey to persist`);
    }
    assert.equal(create.labs.storageKey, 'nav.labs');
    assert.equal(advanced.storageKey, 'nav.advanced');
    // Create and Produce are the mobile strip; nothing else may be flat.
    assert.equal(Boolean(create.collapsible), false);
    assert.equal(Boolean(produce.collapsible), false);
});

test('STUDIO_PAGES is exactly the studio loader map in App.jsx', async () => {
    const { STUDIO_PAGES } = await importSrc('src/app/navConfig.jsx');
    const app = read('src/app/App.jsx');
    const block = app.match(/const STUDIO_LOADERS = \{([\s\S]*?)\n\};/);
    assert.ok(block, 'STUDIO_LOADERS not found in App.jsx');
    const loaders = [...block[1].matchAll(/^\s*'?([\w-]+)'?:\s*\(\)/gm)].map(([, key]) => key);
    assert.deepEqual([...STUDIO_PAGES].sort(), loaders.sort(),
        'a studio page with no loader never mounts; a loader with no page key is unreachable');
});

test('every HUB_PAGES key maps to a view HubLayer renders and HUB_VIEWS lists', async () => {
    const { HUB_PAGES } = await importSrc('src/app/navConfig.jsx');
    // hubData is read as text, not imported: it pulls in react-hot-toast, which
    // touches `document` at module scope and this test has no DOM.
    const listed = read('src/hub/hubData.js').match(/export const HUB_VIEWS = \[([^\]]*)\]/);
    assert.ok(listed, 'HUB_VIEWS not found in hubData.js');
    const HUB_VIEWS = [...listed[1].matchAll(/'([\w-]+)'/g)].map(([, view]) => view);
    const layer = read('src/hub/HubLayer.jsx');
    for (const [page, view] of Object.entries(HUB_PAGES)) {
        assert.ok(
            layer.includes(`current === '${view}'`),
            `HubLayer renders nothing for '${page}' (view '${view}')`,
        );
        // activateHubView/navigateHub fall back to 'create' for a view that is
        // not listed, so an unlisted one opens the Planner instead.
        assert.ok(HUB_VIEWS.includes(view), `HUB_VIEWS is missing '${view}' (page '${page}')`);
    }
});

test('the pages that were renamed kept their keys', async () => {
    const { NAV_ITEMS, isKnownPage } = await importSrc('src/app/navConfig.jsx');
    const labelOf = (page) => NAV_ITEMS.find((item) => item.page === page)?.label();
    assert.equal(labelOf('runs'), 'Productions');
    assert.equal(labelOf('history'), 'Library');
    assert.equal(labelOf('machines'), 'Rented GPUs');
    // Telemetry left the nav but not the router.
    assert.equal(labelOf('telemetry'), undefined);
    for (const page of ['runs', 'history', 'machines', 'telemetry', 'mcp-cli', 'cinema']) {
        assert.ok(isKnownPage(page), `?page=${page} stopped resolving`);
    }
});
