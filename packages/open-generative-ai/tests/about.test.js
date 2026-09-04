// The About surface: one version number, and notices that group without lying.
//
// The app is AGPL-3.0-or-later and showed neither a version nor a licence
// anywhere. What is tested here is the part that can be wrong silently: a chip
// that renders "v" out of an empty version, a licence group that quietly merges
// "MIT License" with something else, and the build-time version constant drifting
// away from pyproject.toml, which is the one place it is allowed to live.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
// The shared render idiom, which also installs the JSX import hook this file
// used to carry its own copy of.
const { renderComponent, textOf } = require('./helpers/render.js');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const importSrc = (relative) => import(pathToFileURL(path.join(root, relative)).href);

test('a version label is never half-rendered', async () => {
    const { versionLabel, shortCommit } = await importSrc('src/lib/appVersion.js');
    assert.equal(versionLabel({ version: '0.1.0', commit: '0a0fd7b1234567' }), 'v0.1.0 · 0a0fd7b');
    assert.equal(versionLabel({ version: 'v0.1.0' }), 'v0.1.0', 'a leading v must not be doubled');
    assert.equal(versionLabel({ commit: '0a0fd7b' }), '0a0fd7b');
    // The failure this exists to prevent: a chip that reads "v" or " · ".
    assert.equal(versionLabel({}), '');
    assert.equal(versionLabel({ version: '', commit: '' }), '');
    assert.equal(versionLabel(), '');

    assert.equal(shortCommit('0A0FD7B1234'), '0A0FD7B');
    assert.equal(shortCommit('unknown'), '', 'a non-commit must not be shown as one');
    assert.equal(shortCommit(''), '');
    assert.equal(shortCommit(null), '');
});

test('outside a vite build the version constant is empty, not the string "undefined"', async () => {
    // node --test does not run vite's define step, so __APP_VERSION__ is absent.
    // The chip must then render nothing and let /api/about answer instead.
    const { APP_VERSION } = await importSrc('src/lib/appVersion.js');
    assert.equal(APP_VERSION, '');
});

test('the frontend version comes from pyproject.toml and nowhere else', () => {
    const config = read('vite.config.mjs');
    assert.ok(config.includes('__APP_VERSION__'), 'vite must define the version constant');
    assert.ok(/pyproject\.toml/.test(config), 'the version must be read from pyproject.toml');
    // The package.json versions were unrelated numbers inherited from the donor
    // (2.0.0 here, 3.0.2 in comfyui-mobile). They are gone; nothing may read one.
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.version, undefined, 'this package must not carry a second version number');
    assert.equal(pkg.private, true);
});

test('notice packages group by licence, biggest first, unstated last', async () => {
    const { groupByLicense, allNoticePackages } = await importSrc('src/hub/views/AboutView.jsx');
    const groups = groupByLicense([
        { name: 'a', version: '1', license: 'MIT' },
        { name: 'b', version: '1', license: 'MIT License' },
        { name: 'c', version: '1', license: 'Apache-2.0' },
        { name: 'd', version: '1', license: 'Apache-2.0' },
        { name: 'e', version: '1', license: 'Apache-2.0' },
        { name: 'f', version: '1', license: null },
        { name: 'g', version: '1', license: 'ISC' },
    ]);
    const byName = Object.fromEntries(groups.map((g) => [g.license, g.packages.map((p) => p.name)]));
    // "MIT License" and "MIT" are one set of terms written by two packaging tools.
    assert.deepEqual(byName.MIT, ['a', 'b']);
    assert.deepEqual(byName['Apache-2.0'], ['c', 'd', 'e']);
    // A single-package licence is folded into Other rather than getting a heading.
    assert.deepEqual(byName.Other, ['g']);
    // A package with no stated licence is the one thing that must stay visible.
    assert.deepEqual(byName.Unstated, ['f']);
    assert.equal(groups[0].license, 'Apache-2.0', 'biggest group first');
    assert.equal(groups[groups.length - 1].license, 'Unstated', 'unstated last');
});

test('the notices payload flattens python, npm, the Rust crates and the bundled binaries', async () => {
    const { allNoticePackages } = await importSrc('src/hub/views/AboutView.jsx');
    const all = allNoticePackages({
        python: { packages: [{ name: 'fastapi', version: '1', license: 'MIT' }] },
        npm: {
            'packages/open-generative-ai': [{ name: 'react', version: '19', license: 'MIT' }],
            'packages/media-gateway': [{ name: 'next', version: '15', license: 'MIT' }],
        },
        // Statically linked into the shipped binary, so their notices have to
        // travel with it — and this page is where they travel.
        rust: { packages: [{ name: 'tauri', version: '2', license: 'Apache-2.0 OR MIT' }] },
        bundled: [{ name: 'Node.js', version: '22', license: 'MIT' }],
    });
    assert.deepEqual(all.map((p) => p.name), ['fastapi', 'react', 'next', 'tauri', 'Node.js']);
    // A build with no generated notices must produce an empty list, not a throw.
    assert.deepEqual(allNoticePackages(null), []);
    assert.deepEqual(allNoticePackages({}), []);
});

test('About is reachable from the nav and from the topbar chip', async () => {
    const { HUB_PAGES, isKnownPage } = await importSrc('src/app/navConfig.jsx');
    assert.equal(isKnownPage('about'), true);
    assert.equal(HUB_PAGES.about, 'about');
    const shell = read('src/app/Shell.jsx');
    assert.ok(shell.includes('<VersionChip onNavigate={onNavigate} />'), 'the topbar needs the version chip');
    assert.ok(/onNavigate\('about'\)/.test(shell), 'the chip must open the About page');
});

test('the About page states the licence, the source offer and the warranty', async () => {
    // AGPL §5(d) asks an interactive program to SHOW these, so they are read
    // off the rendered page rather than out of the file: a licence line inside
    // a section that never opens satisfies a grep and nobody else.
    const page = textOf(await renderComponent('src/hub/views/AboutView.jsx', 'AboutView', { active: true }));
    assert.match(page, /AGPL-3\.0-or-later/, 'the licence must be named on the page');
    assert.match(page, /ABSOLUTELY NO WARRANTY/, 'the no-warranty line is required by the licence');
    assert.match(page, /View source/, 'the source offer must be a link a user can follow');
    assert.match(page, /Report a vulnerability privately/);
});

// Deliberately textual: which endpoint the page asks for its build facts is
// invisible on screen — the render never runs an effect, which is exactly why
// the version and build date are blank above.
test('the About page reads its build facts from the server', () => {
    assert.ok(read('src/hub/views/AboutView.jsx').includes('/api/about'));
});
