// Every page the nav can reach is MOUNTED here.
//
// This is the test that would have caught the missing `rememberModelUse`
// import: the studio was down for a week and the whole suite stayed green
// because nothing in it ever executed the module — the assertions read the
// .jsx as text. A render does not have that hole. The module has to load,
// every import has to resolve, and React has to build the tree before an
// assertion can look at anything.
//
// The page list is DERIVED, not written down here: the studios come from
// App.jsx's lazy registry and the hub pages from HubLayer's render list, both
// checked against navConfig's STUDIO_PAGES/HUB_PAGES. A page added to the nav
// without a component, or a component wired to a key nothing routes to, fails
// here rather than being quietly uncovered.
//
// Two machine states, because most of what a page shows on a cold machine and
// on the owner's own machine is decided before the first effect runs: signed
// out (nothing stored, no desktop bridge, the API refusing) and owner (an
// unlocked session, the bridge present, preferences already on disk).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { browser, importComponent, renderElement, root } = require('./helpers/render.js');

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);

// { image: { file: 'src/studios/ImageStudio.jsx', export: 'ImageStudio' }, … }
// straight out of App.jsx's STUDIO_LOADERS.
function studioRegistry() {
    const source = read('src/app/App.jsx');
    const block = source.slice(source.indexOf('STUDIO_LOADERS'));
    const entries = [...block.matchAll(/(\w[\w-]*): (?:withCloudCatalog\()?\(\) => import\('([^']+)'\)\.then\(\(m\) => m\.(\w+)\)/g)];
    return new Map(entries.map(([, page, specifier, exported]) => [page, {
        file: path.posix.join('src', path.posix.normalize(path.posix.join('app', specifier))),
        export: exported,
    }]));
}

// { create: { file: 'src/hub/views/PlannerView.jsx', export: 'PlannerView' }, … }
// straight out of HubLayer's render list and its own import lines.
function hubRegistry() {
    const source = read('src/hub/HubLayer.jsx');
    const rendered = [...source.matchAll(/<(\w+) active=\{current === '([a-z]+)'\}/g)];
    const registry = new Map();
    for (const [, name, view] of rendered) {
        const imported = source.match(new RegExp(`import \\{ ${name} \\} from '([^']+)'`));
        assert.ok(imported, `HubLayer renders <${name}> but never imports it`);
        registry.set(view, {
            file: path.posix.join('src', path.posix.normalize(path.posix.join('hub', imported[1]))),
            export: name,
        });
    }
    return registry;
}

const studios = studioRegistry();
const hubViews = hubRegistry();

// The machine the page is rendered on. Nothing here talks to a real service —
// the owner's fetch answers from a table and every other path is refused.
const OWNER_RESPONSES = {
    '/api/owner/session': { unlocked: true, account_id: 'owner' },
    '/api/settings': { sections: [], settings: [] },
};

function signedOutMachine() {
    globalThis.localStorage.clear();
    globalThis.sessionStorage.clear();
    browser.setLocalAI({});
    browser.refuseFetch();
}

function ownerMachine() {
    globalThis.localStorage.clear();
    globalThis.sessionStorage.clear();
    globalThis.localStorage.setItem('nav.advanced', '1');
    globalThis.localStorage.setItem('nav.labs', '1');
    browser.setLocalAI({ isElectron: true });
    browser.setFetch((input) => {
        const url = String(input?.url || input || '');
        const body = OWNER_RESPONSES[url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]];
        if (!body) return Promise.reject(new Error('network refused in test'));
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
    });
}

const MACHINES = [['signed out', signedOutMachine], ['owner', ownerMachine]];

// The catalog is applied before any studio module is imported, exactly as
// App.jsx does it — a studio with no models boots off `t2iModels[0]` and there
// is no such thing. The fetch is refused here, so this is the offline list.
test('the cloud catalog loads before a studio mounts', async () => {
    const catalog = await load('src/lib/cloudCatalog.js');
    await catalog.cloudCatalogReady();
    assert.ok(catalog.t2iModels.length > 0, 'the offline catalog fell back to nothing');
});

test('every studio page in the nav has a component App.jsx can load', async () => {
    const { STUDIO_PAGES } = await load('src/app/navConfig.jsx');
    for (const page of STUDIO_PAGES) {
        assert.ok(studios.has(page), `STUDIO_PAGES lists '${page}' but App.jsx has no loader for it`);
    }
    for (const page of studios.keys()) {
        assert.ok(STUDIO_PAGES.includes(page), `App.jsx loads a studio for '${page}' but the nav cannot reach it`);
    }
});

test('every hub page in the nav has a view HubLayer renders', async () => {
    const { HUB_PAGES } = await load('src/app/navConfig.jsx');
    for (const [page, view] of Object.entries(HUB_PAGES)) {
        assert.ok(hubViews.has(view), `?page=${page} routes to hub view '${view}' and HubLayer renders no such view`);
    }
});

// The smoke itself. Non-empty markup and a clean console, on both machines.
for (const [machine, prepare] of MACHINES) {
    test(`every studio renders on a ${machine} machine`, async () => {
        for (const [page, entry] of studios) {
            prepare();
            const Studio = await importComponent(entry.file, entry.export);
            const { markup, logged } = renderElement(Studio, { active: true });
            assert.deepEqual(logged, [], `the ${page} studio logged while rendering (${machine})`);
            assert.ok(markup.length > 200, `the ${page} studio rendered almost nothing (${machine}): ${markup.slice(0, 120)}`);
        }
    });

    test(`every hub page renders on a ${machine} machine`, async () => {
        for (const [view, entry] of hubViews) {
            prepare();
            const View = await importComponent(entry.file, entry.export);
            const { markup, logged } = renderElement(View, { active: true });
            assert.deepEqual(logged, [], `the ${view} page logged while rendering (${machine})`);
            assert.ok(markup.length > 200, `the ${view} page rendered almost nothing (${machine}): ${markup.slice(0, 120)}`);
        }
    });

    test(`the hub layer paints the requested page on a ${machine} machine`, async () => {
        prepare();
        const HubLayer = await importComponent('src/hub/HubLayer.jsx', 'HubLayer');
        const { HUB_PAGES } = await load('src/app/navConfig.jsx');
        for (const view of new Set(Object.values(HUB_PAGES))) {
            const { markup, logged } = renderElement(HubLayer, { visible: true, view });
            assert.deepEqual(logged, [], `the hub layer logged while showing '${view}' (${machine})`);
            assert.ok(markup.length > 200, `the hub layer rendered almost nothing for '${view}' (${machine})`);
        }
        // A studio page is showing: the whole layer is hidden and no view is current.
        const { markup } = renderElement(HubLayer, { visible: false, view: null });
        assert.match(markup, /^<div class="[^"]*\bhidden\b/, 'the hub layer must hide itself while a studio is on screen');
    });
}

test('a studio whose module cannot load fails the smoke rather than passing it', async () => {
    // The guard on the guard: importComponent is what turns a missing import
    // into a failure, so prove it actually throws instead of resolving to
    // undefined and rendering nothing.
    await assert.rejects(
        () => importComponent('src/studios/ImageStudio.jsx', 'NoSuchExport'),
        /does not export a component named NoSuchExport/,
    );
});
