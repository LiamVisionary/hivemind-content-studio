// Every hub view is RENDERED here, not grepped. The pages stay mounted and
// display-toggled, so a view that paints outside its `active` gate lands under
// whichever page is open, and a prop handed to HubToolbar or StatusPill under
// the wrong name is dropped without a sound — React only warns about unknown
// props on DOM elements, never on components. PassBook shipped both ways
// (2026-08 / 09): a spinner strip under every hub page while /api/passbook was
// failing, and a kicker, a Refresh button and seven status tones that never
// rendered. The source-shape test in otherStudiosPolish.test.js only saw the
// main return's wrapper and let it through twice.
//
// react-dom/server renders each view at active=true and active=false with the
// network refused and the Electron bridge stubbed. Effects never run under a
// server render, so nothing here reaches the API; the load gate itself is
// asserted on the source.
//
// The one textual assertion left in this file is deliberate: the load GATE —
// that a page never opened never fetches — is about an effect that a server
// render does not run. Everything else here is rendered.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerHooks } = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// JSX → ESM at import time. esbuild is already here as vite's compiler; the
// automatic runtime matches vite.config's plugin-react.
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

// The minimum browser surface the hub modules touch at import or first render:
// storage for the language and filter prefs, matchMedia for the hover hints,
// a document with a head for react-hot-toast's stylesheet, and a refused fetch.
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

const fetchCalls = [];
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
globalThis.fetch = (...args) => { fetchCalls.push(args); return Promise.reject(new Error('network refused in test')); };
if (typeof globalThis.CustomEvent !== 'function') {
    globalThis.CustomEvent = class CustomEvent extends Event {
        constructor(type, options = {}) { super(type, options); this.detail = options.detail; }
    };
}

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const layerSource = read('src/hub/HubLayer.jsx');

// [{ name: 'PassBookView', file: 'src/hub/views/PassBookView.jsx', key: 'passbook' }, …]
// straight from HubLayer's imports and render list, so a view added there is
// covered here without registering it twice.
const views = [...layerSource.matchAll(/import \{ (\w+View) \} from '\.\/views\/(\w+\.jsx)'/g)].map(([, name, file]) => {
    const rendered = layerSource.match(new RegExp(`<${name} active=\\{current === '([a-z]+)'\\}`));
    return { name, file: `src/hub/views/${file}`, key: rendered ? rendered[1] : null };
});

async function importView({ name, file }) {
    const mod = await import(pathToFileURL(path.join(root, file)).href);
    assert.equal(typeof mod[name], 'function', `${file} exports ${name}`);
    return mod[name];
}

function withConsoleErrors(run) {
    const seen = [];
    const original = console.error;
    console.error = (...args) => { seen.push(args.map(String).join(' ')); };
    try { return [run(), seen]; } finally { console.error = original; }
}

test('HubLayer renders at least the ten hub pages and every one has a HUB_VIEWS key', async () => {
    const { HUB_VIEWS } = await import(pathToFileURL(path.join(root, 'src/hub/hubData.js')).href);
    assert.ok(views.length >= 10, `expected the hub's pages, saw ${views.length}`);
    for (const view of views) {
        assert.ok(view.key, `${view.name} is imported by HubLayer but never rendered`);
        // navigateHub/activateHubView fall back to 'create' for a key that is
        // not listed, so a page missing here is reachable from the rail but
        // not from anything that routes by name.
        assert.ok(HUB_VIEWS.includes(view.key), `HUB_VIEWS is missing '${view.key}' (${view.name})`);
    }
});

test('every hub view paints when active and hides itself when it is not', async () => {
    for (const view of views) {
        const View = await importView(view);
        const [inactive, inactiveErrors] = withConsoleErrors(() => renderToStaticMarkup(React.createElement(View, { active: false })));
        const [active, activeErrors] = withConsoleErrors(() => renderToStaticMarkup(React.createElement(View, { active: true })));

        // The inactive render is ONE hidden root — never a spinner, a callout,
        // or a card outside the gate.
        assert.match(inactive, /^<div class="[^"]*\bhidden\b[^"]*">/, `${view.name} inactive render must be a hidden root, got: ${inactive.slice(0, 160)}`);
        assert.doesNotMatch(active, /^<div class="[^"]*\bhidden\b/, `${view.name} active render is hidden`);
        assert.ok(active.length > inactive.length - 40, `${view.name} active render is emptier than its hidden one`);

        // react-dom warns (console.error) about unknown DOM props, invalid
        // nesting, missing keys and bad hook usage during a server render.
        assert.deepEqual([...inactiveErrors, ...activeErrors], [], `${view.name} logged during render`);
    }
    // Effects never run under a server render, so this is a sanity check on the
    // harness rather than on the gate: nothing rendered above talked to the API.
    assert.equal(fetchCalls.length, 0);
});

// A component's props are its destructured first parameter; a view that hands
// it anything else is dropped silently, which is how PassBook lost its kicker
// and its Refresh button.
function declaredProps(source, name) {
    const match = source.match(new RegExp(`export function ${name}\\(\\{([^}]*)\\}`));
    assert.ok(match, `${name} destructures its props`);
    return new Set(match[1].split(',').map((part) => part.trim().split(/[\s=:]/)[0]).filter(Boolean));
}

// Attribute names of every <Name …> usage in a source file. The opening tag is
// scanned with brace depth so `onClick={() => x}` cannot end it early; balanced
// `{…}` values are then dropped so only the attribute names remain.
function usedProps(source, name) {
    const uses = [];
    const open = new RegExp(`<${name}\\b`, 'g');
    let match;
    while ((match = open.exec(source))) {
        let depth = 0;
        let i = match.index + match[0].length;
        for (; i < source.length; i += 1) {
            const ch = source[i];
            if (ch === '{') depth += 1;
            else if (ch === '}') depth -= 1;
            else if (depth === 0 && ch === '>') break;
        }
        let tag = source.slice(match.index + match[0].length, i);
        // Strip balanced braces (innermost first) and quoted strings.
        let previous;
        do { previous = tag; tag = tag.replace(/\{[^{}]*\}/g, ' '); } while (tag !== previous);
        tag = tag.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, ' ').replace(/\/\s*$/, '');
        uses.push([...tag.matchAll(/(?:^|\s)([A-Za-z][\w-]*)(?=\s*=|\s|$)/g)].map(([, prop]) => prop));
    }
    return uses;
}

test('hub views only pass props HubToolbar and StatusPill actually declare', () => {
    const components = {
        HubToolbar: declaredProps(read('src/hub/components/HubToolbar.jsx'), 'HubToolbar'),
        StatusPill: declaredProps(read('src/hub/components/StatusPill.jsx'), 'StatusPill'),
    };
    assert.ok(components.HubToolbar.has('kicker') && components.HubToolbar.has('right'), 'HubToolbar still takes kicker/right');
    assert.ok(components.StatusPill.has('status'), 'StatusPill still takes status');

    let usages = 0;
    for (const view of views) {
        const source = read(view.file);
        for (const [name, allowed] of Object.entries(components)) {
            for (const props of usedProps(source, name)) {
                usages += 1;
                for (const prop of props) {
                    assert.ok(allowed.has(prop) || prop === 'key', `${view.name} passes ${name} an unknown prop '${prop}' (it takes ${[...allowed].join(', ')})`);
                }
            }
        }
    }
    assert.ok(usages >= 10, `expected the views to use the shared toolbar and pills, saw ${usages}`);
});

test('PassBook waits to be opened before reading the store, and shows its toolbar and tones', async () => {
    const source = read('src/hub/views/PassBookView.jsx');
    // Same gate as ModelsView: the first activation loads, the topbar Refresh
    // re-loads, and a page that was never opened never fetches.
    assert.match(source, /if \(!active \|\| loadedRef\.current\) return;\s*loadedRef\.current = true;\s*void load\(\);/);
    assert.match(source, /addEventListener\('hivemind-hub-refresh', onRefresh\)/);
    assert.doesNotMatch(source, /useEffect\(\(\) => \{ load\(\); \}, \[\]\)/, 'the unconditional mount-time load is gone');
    // Nothing returns above the gated root. Component-level returns are the
    // ones at four spaces; an effect's cleanup `return () => …` is deeper.
    const body = source.slice(source.indexOf('export function PassBookView'));
    const returns = [...body.matchAll(/\n {4}return \(/g)];
    assert.equal(returns.length, 1, 'PassBookView has exactly one return, and it is the gated root');
    assert.match(
        body.slice(returns[0].index),
        /^\n {4}return \(\n {8}<div className=\{active \? 'flex min-h-0 flex-1 flex-col' : 'hidden'\}>/,
        'PassBookView returns nothing before its gated root',
    );
    // A failed load ends in a callout with a way back in, never a bare spinner.
    assert.match(source, /setFailed\(!store\)/);
    assert.match(source, /bg-danger-tint[\s\S]{0,400}Try again/);

    // Per-pill semantics, on the kit Pill (StatusPill's status vocabulary has no
    // word for "stored" or "plaintext").
    for (const tone of [
        /<Pill tone=\{configured \? 'ok' : 'neutral'\} dot>/,
        /<Pill tone="honey" dot>/,
        /<Pill tone=\{broker\.running \? 'ok' : 'warn'\} dot>/,
        /<Pill tone=\{row\.active \? 'ok' : row\.revoked \? 'neutral' : 'warn'\} dot>/,
        /<Pill tone=\{sealing\.fully_sealed \? 'ok' : 'warn'\} dot>/,
        /<Pill tone=\{ledger\.intact \? 'ok' : 'danger'\} dot>/,
    ]) assert.match(source, tone);
    assert.doesNotMatch(source, /StatusPill/);
    // Only real design tokens: line1 has no alpha scale and rose is not a colour here.
    assert.doesNotMatch(source, /border-line\/|border-rose/);
    assert.match(source, /border-danger\/40/);

    const View = await importView(views.find((view) => view.name === 'PassBookView'));
    const markup = renderToStaticMarkup(React.createElement(View, { active: true }));
    assert.match(markup, /Shared on this machine/, 'the kicker renders');
    assert.match(markup, />PassBook</, 'the title renders');
    assert.match(markup, />Refresh</, 'the Refresh button renders');
});
