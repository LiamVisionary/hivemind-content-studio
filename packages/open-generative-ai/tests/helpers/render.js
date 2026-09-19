// The render idiom, in one place.
//
// Most of this suite used to assert on SOURCE TEXT — read the .jsx, run a regex
// — which passes whether or not the file can execute. A missing import took a
// studio down for a week and every grep test stayed green. A render does not:
// the module has to load, every import has to resolve, and React has to build
// the tree before an assertion can look at it.
//
// Three lines is the whole idiom:
//
//     const { renderComponent } = require('./helpers/render.js');
//     const markup = await renderComponent('src/hub/views/AboutView.jsx', 'AboutView', { active: true });
//     assert.match(markup, /Third-party notices/);
//
// react-dom/server's renderToStaticMarkup does the structure. There is no jsdom
// or testing-library here and there must not be — the DOM below is the minimal
// surface the app modules actually touch at import and first render (storage,
// matchMedia, a head for react-hot-toast's stylesheet, a refused fetch), which
// is the same stub hubViewsSmoke/modelStoreCard/settingsView grew independently
// and now share. Effects never run under a server render, so nothing reaches
// the network; behaviour that only exists after an effect belongs in a
// logic-level test, and interaction is asserted by rendering again with the
// props the interaction would have produced.
const fs = require('node:fs');
const path = require('node:path');
const { registerHooks } = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const root = path.join(__dirname, '..', '..');

// JSX → ESM at import time. esbuild is already here as vite's compiler; the
// automatic runtime matches vite.config's plugin-react.
let hookRegistered = false;
function registerJsxHook() {
    if (hookRegistered) return;
    hookRegistered = true;
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
}

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

// One node of the minimal DOM. Enough for a stylesheet insert, a measurement
// and a class toggle; deliberately not a document model.
const element = () => ({
    ...eventTarget(),
    style: {},
    children: [],
    firstChild: { data: '' },
    innerHTML: '',
    id: '',
    className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child) { this.children.push(child); return child; },
    removeChild() {},
    contains: () => false,
    focus() {},
    blur() {},
    click() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
});

const fetchCalls = [];
let fetchImpl = () => Promise.reject(new Error('network refused in test'));

// Installed once, at require time, so it is in place before any component
// module is imported — several of them read storage or matchMedia while their
// module body runs.
let installed = false;
function installBrowserSurface() {
    if (installed) return;
    installed = true;
    registerJsxHook();
    globalThis.window = globalThis;
    Object.assign(globalThis, eventTarget(), {
        localStorage: memoryStorage(),
        sessionStorage: memoryStorage(),
        matchMedia: () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
        location: { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost', pathname: '/', search: '', hash: '', reload() {}, assign() {}, replace() {} },
        localAI: {},
        requestAnimationFrame: (fn) => setTimeout(fn, 0),
        cancelAnimationFrame: clearTimeout,
        requestIdleCallback: (fn) => setTimeout(() => fn({ timeRemaining: () => 0, didTimeout: true }), 0),
        cancelIdleCallback: clearTimeout,
        innerWidth: 1280,
        innerHeight: 800,
        devicePixelRatio: 1,
        scrollTo() {},
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
    });
    // Node ships its own read-only `navigator`; the app only reads it from
    // handlers, so borrow it rather than fighting the getter.
    if (!globalThis.navigator) {
        Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', language: 'en-US' }, configurable: true });
    }
    globalThis.document = Object.assign(eventTarget(), {
        body: element(),
        head: element(),
        documentElement: element(),
        createElement: element,
        createElementNS: element,
        createTextNode: (data) => ({ data }),
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        activeElement: null,
        hidden: false,
        visibilityState: 'visible',
        title: '',
    });
    globalThis.fetch = (...args) => { fetchCalls.push(args); return fetchImpl(...args); };
    if (typeof globalThis.CustomEvent !== 'function') {
        globalThis.CustomEvent = class CustomEvent extends Event {
            constructor(type, options = {}) { super(type, options); this.detail = options.detail; }
        };
    }
    if (typeof globalThis.ResizeObserver !== 'function') {
        globalThis.ResizeObserver = class ResizeObserver { observe() {} unobserve() {} disconnect() {} };
    }
    if (typeof globalThis.IntersectionObserver !== 'function') {
        globalThis.IntersectionObserver = class IntersectionObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
    }
}

installBrowserSurface();

// What the app is running on, for a test that needs a different machine: an
// Electron bridge, a fetch that answers, a preference already stored.
const browser = {
    fetchCalls,
    setFetch(fn) { fetchImpl = fn; },
    refuseFetch() { fetchImpl = () => Promise.reject(new Error('network refused in test')); },
    setLocalAI(bridge) { globalThis.localAI = bridge; },
    storage: () => globalThis.localStorage,
    element,
    memoryStorage,
};

// Import a component out of the shipping tree by its path from the package
// root, asserting the named export is really a component.
async function importComponent(relativePath, exportName) {
    const mod = await import(pathToFileURL(path.join(root, relativePath)).href);
    const Component = mod[exportName];
    if (typeof Component !== 'function') {
        throw new Error(`${relativePath} does not export a component named ${exportName} (exports: ${Object.keys(mod).join(', ') || 'none'})`);
    }
    return Component;
}

// Render, capturing React's own complaints. react-dom warns through
// console.error about unknown DOM props, invalid nesting, missing keys and bad
// hook usage — a silent render that logged is not a passing render.
function renderElement(Component, props = {}) {
    const logged = [];
    const original = console.error;
    console.error = (...args) => { logged.push(args.map(String).join(' ')); };
    try {
        return { markup: renderToStaticMarkup(React.createElement(Component, props)), logged };
    } finally {
        console.error = original;
    }
}

// The three-line idiom: import it, render it, get the markup. Throws on a
// render that logged, so a test only has to assert on what it cares about.
async function renderComponent(relativePath, exportName, props = {}) {
    const Component = await importComponent(relativePath, exportName);
    const { markup, logged } = renderElement(Component, props);
    if (logged.length) throw new Error(`${exportName} logged during render:\n${logged.join('\n')}`);
    return markup;
}

// A STUDIO, mounted the way App.jsx mounts one: the cloud catalog is loaded
// first, because Image, Video and Lip sync boot their default model off its
// first row and a studio with no models cannot render at all. The fetch is
// refused here unless a test answers it, so this is the offline catalog.
let catalogReady = null;
async function renderStudio(relativePath, exportName, props = { active: true }) {
    if (!catalogReady) catalogReady = import(pathToFileURL(path.join(root, 'src/lib/cloudCatalog.js')).href).then((m) => m.cloudCatalogReady());
    await catalogReady;
    return renderComponent(relativePath, exportName, props);
}

// Text of the rendered markup with tags removed and entities unescaped — for
// asserting on what a person reads rather than on how it is marked up.
function textOf(markup) {
    return markup
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

module.exports = {
    React,
    browser,
    importComponent,
    installBrowserSurface,
    renderComponent,
    renderElement,
    renderStudio,
    renderToStaticMarkup,
    root,
    textOf,
};
