// No dead ends: a state that says something is wrong carries the way out.
//
// This is the project's first rule (DESIGN.md §4, CLAUDE.md) written down as a
// test, because ten separate states had broken it at once — a status banner
// whose only remedy was `scripts/hivemind-studio-stack restart` (a path that
// exists in a checkout and nowhere near a .dmg), a Planner chip whose
// explanation lived in a `title` on a DISABLED button, a PassBook panel that
// reported a failed request as an absent feature, an Image studio that answered
// an empty catalog with a raw TypeError.
//
// HOW FAR THIS REACHES, said honestly, because a sweep that claims more than it
// checks is worse than none:
//
//  * The source rule (first test) is repo-wide over `src/`. It reads every
//    string a person can see and refuses one that hands out a command from THIS
//    repository. It cannot judge prose, so it catches the specific shape that
//    went wrong rather than dead ends in general.
//  * The rendered states (the rest) are the ones this change touched, mounted
//    with react-dom/server: the restart remedy in both of its shapes, the Image
//    studio on an empty catalog, and the Planner with a catalog that named no
//    brain. Each asserts an ACTION (a button) or an INSTRUCTION (a sentence
//    naming what to do), never a bare statement of the problem.
//  * Three states this change also fixed are asserted on their SOURCE, not
//    rendered, and the reason is the same in each case: they are reached only
//    through an effect, and a server render runs no effects — the studio
//    offline banner and the Settings restart strip (both now delegate to
//    `StudioRestartAction`), and PassBook's four sub-panels. The account gate is
//    server-rendered HTML and is covered in `test/studio/test_account_gate.py`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { importComponent, renderElement, root, textOf } = require('./helpers/render.js');

const SRC = path.join(root, 'src');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full);
    }
    return out;
}

// Comments are where an engineer legitimately names a command — "run
// `zimage-stack restart` and this picks it up" is a note to the next engineer,
// not an instruction to a user. Only what can reach a screen is checked.
function stripComments(source) {
    return source
        .replace(/^[ \t]*\/\/.*$/gm, ' ')
        .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ')
        .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, ' ')
        .replace(/^\s*\*.*$/gm, ' ');
}

/* ---------------- the rule, over the whole shipping tree ---------------- */

// A command belonging to THIS repository: the stack CLI under either of its
// names, and any `scripts/…` path. PassBook's own CLI (`passbook broker start`)
// is deliberately NOT here — it is a separate machine-level tool the owner
// installed, and naming its command is naming a product, not sending someone
// into this checkout for a script they do not have.
const REPO_COMMAND = /(zimage-stack|hivemind-studio-stack|scripts\/[a-z0-9-]+\.(?:sh|py|mjs|js)|scripts\/hivemind)/i;

test('no string the app can show hands the user a command from this repository', () => {
    const offenders = [];
    for (const file of walk(SRC)) {
        const relative = path.relative(root, file);
        stripComments(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, index) => {
            // Only string literals: an import specifier or a fetch path is not
            // copy, and neither is a variable named after a script.
            for (const match of line.matchAll(/'([^'\n]{4,})'|"([^"\n]{4,})"|`([^`\n]{4,})`/g)) {
                const value = match[1] || match[2] || match[3] || '';
                if (REPO_COMMAND.test(value)) offenders.push(`${relative}:${index + 1} ${value}`);
            }
        });
    }
    assert.deepEqual(offenders, [], [
        'a remedy that is a command from this checkout is not a remedy for anyone who',
        'installed the app. Put the action in the app (ui/kit.jsx StudioRestartAction),',
        'and say plainly what to do when the app cannot perform it.',
    ].join('\n'));
});

/* ---------------- the remedy itself, in both of its shapes ---------------- */

test('the restart remedy is a button in the desktop shell and an instruction in a browser', async () => {
    const { StudioRestartAction } = await importComponent('src/ui/kit.jsx', 'StudioRestartAction')
        .then((component) => ({ StudioRestartAction: component }));

    delete globalThis.__TAURI__;
    const browserMarkup = renderElement(StudioRestartAction, {});
    assert.deepEqual(browserMarkup.logged, []);
    const browserText = textOf(browserMarkup.markup);
    assert.match(browserText, /start the studio the way you started it before/,
        'a browser tab cannot restart the services, so it says what to do instead');
    assert.doesNotMatch(browserText, REPO_COMMAND, 'and never by naming a script in this checkout');

    globalThis.__TAURI__ = { core: { invoke: () => Promise.resolve({}) } };
    try {
        const shellMarkup = renderElement(StudioRestartAction, {});
        assert.deepEqual(shellMarkup.logged, []);
        assert.match(shellMarkup.markup, /<button/, 'the shell supervises the services: it gets a button');
        assert.match(textOf(shellMarkup.markup), /Restart studio/);
    } finally {
        delete globalThis.__TAURI__;
    }
});

test('every surface that explains the offline state carries that one remedy', () => {
    // Asserted on the source because all three are reached through an effect —
    // a heartbeat verdict, a save that needs a restart — and a server render
    // runs no effects. What matters is that none of them grew a second answer.
    for (const file of ['src/ui/kit.jsx', 'src/app/Shell.jsx', 'src/hub/views/SettingsView.jsx']) {
        assert.match(read(file), /<StudioRestartAction/, `${file} explains the restart without offering it`);
    }
    // And the sentence beside it states the problem only — the fix is the
    // component above, not a trailing "by running:" with nothing after it.
    const table = read('src/lib/i18n.js');
    assert.match(table, /'app\.offlineSentence': 'The studio’s local service is not answering, so nothing can generate\.'/);
});

/* ---------------- an empty catalog is a sentence, not a crash ---------------- */

test('the Image studio renders and says so when the catalog is empty', async () => {
    const catalog = await load('src/lib/cloudCatalog.js');
    await catalog.cloudCatalogReady();
    assert.ok(catalog.t2iModels.length > 0, 'the offline fallback loaded nothing');

    // The one reachable route to empty arrays: the catalog fetch failed AND the
    // offline chunk could not be imported, which is `applyCloudCatalog({}, '')`.
    catalog.applyCloudCatalog({}, '');
    try {
        const ImageStudio = await importComponent('src/studios/ImageStudio.jsx', 'ImageStudio');
        const { markup, logged } = renderElement(ImageStudio, { active: true });
        assert.deepEqual(logged, [], 'the Image studio logged while rendering an empty catalog');
        assert.ok(markup.length > 200, 'the Image studio rendered almost nothing');
        const text = textOf(markup);
        assert.match(text, /model catalog could not be loaded/, 'an empty studio has to say why it is empty');
        assert.match(text, /Reload/, 'and carry the one thing that repairs it');
    } finally {
        catalog.resetCloudCatalog();
        await catalog.cloudCatalogReady();
    }
});

test('a served catalog with no t2i models falls through to the offline list', async () => {
    const catalog = await load('src/lib/cloudCatalog.js');
    catalog.resetCloudCatalog();
    const { browser } = require('./helpers/render.js');
    browser.setFetch(() => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ buckets: { t2i: [], t2v: [] } }),
    }));
    try {
        await catalog.cloudCatalogReady();
        assert.equal(catalog.catalogSource, 'offline', 'a 200 with no models is a failed catalog wearing a success code');
        assert.ok(catalog.t2iModels.length > 0);
    } finally {
        browser.refuseFetch();
        catalog.resetCloudCatalog();
        await catalog.cloudCatalogReady();
    }
});

/* ---------------- the Planner's no-brain state ---------------- */

test('a Planner with no brain says so on the page, with the door to Providers', async () => {
    const hub = await load('src/hub/hubData.js');
    const before = hub.hubState.simpleCatalog;
    // The catalog answered and named no LLM provider. This is the state whose
    // only explanation used to be a `title` attribute on a disabled button.
    hub.hubState.simpleCatalog = { brains: [], media: {} };
    try {
        const PlannerView = await importComponent('src/hub/views/PlannerView.jsx', 'PlannerView');
        const { markup, logged } = renderElement(PlannerView, { active: true });
        assert.deepEqual(logged, [], 'the Planner logged while rendering');
        const text = textOf(markup);
        assert.match(text, /No brain is connected/, 'the problem, on the page rather than in a tooltip');
        assert.match(text, /Open Providers/, 'and the button that repairs it');
        assert.doesNotMatch(markup, /title="No LLM brain/, 'a disabled control cannot carry its own explanation');
    } finally {
        hub.hubState.simpleCatalog = before;
    }
});

/* ---------------- PassBook tells an absent part from a failed read -------- */

test('PassBook never reports a failed request as a missing component', () => {
    const source = read('src/hub/views/PassBookView.jsx');
    // Effect-driven, so this is a source claim: the three "it is not here"
    // sentences are only ever reached through PanelAbsent (which adds "nothing
    // to fix"), and a null payload — a request that FAILED — reaches
    // PanelUnreadable, which carries the retry.
    for (const key of ['passbook.notInstalled', 'passbook.linkingNotSetUp', 'passbook.noAccessRecord']) {
        const uses = [...source.matchAll(new RegExp(`t\\('${key.replace('.', '\\.')}'\\)`, 'g'))];
        assert.ok(uses.length > 0, `${key} is no longer used at all`);
        for (const use of uses) {
            const line = source.slice(source.lastIndexOf('\n', use.index) + 1, source.indexOf('\n', use.index));
            assert.match(line, /fallback=\{/, `${key} is rendered outside PanelAbsent: ${line.trim()}`);
        }
    }
    assert.match(source, /if \(!access\) return <PanelUnreadable/);
    assert.match(source, /if \(!broker\) return <PanelUnreadable/);
    assert.match(source, /if \(!links\) return <PanelUnreadable/);
    // The orphan: a lowercase, subjectless line about a control in another card.
    assert.doesNotMatch(stripComments(source), /copy\.ask\.hint/, 'the Ask-me hint belongs beside the Ask-me button');
});

/* ---------------- an advertised affordance that does nothing ---------------- */

// The palette prints ⌘1..⌘9 beside the first nine pages; App.jsx's keydown
// handler is what makes those keys do anything. They used to be derived from
// two different lists — the palette from the flat NAV_ITEMS, the handler from
// NAV_SECTIONS[0].items, which holds four rows — so ⌘5..⌘9 were advertised
// beside Sprite, Lip sync, Planner, Library and Productions and did nothing at
// all (in a browser they fell through to the browser's own tab switching).
// One list now, and this is what holds them to it.
test('every shortcut the palette advertises is one the app actually binds', async () => {
    const { NAV_ITEMS, SHORTCUT_ITEMS } = await load('src/app/navConfig.jsx');
    const { buildPaletteEntries } = await load('src/lib/commandPalette.js');

    const advertised = buildPaletteEntries({ navItems: NAV_ITEMS })
        .filter((entry) => entry.kind === 'page' && entry.hint)
        .map((entry) => entry.payload.page);
    assert.deepEqual(advertised, SHORTCUT_ITEMS.map((item) => item.page),
        'the hints and the bound list are the same nine pages, in the same order');
    assert.equal(SHORTCUT_ITEMS.length, 9, '⌘1..⌘9 is nine keys');

    // And the handler reads that list rather than a tier of its own.
    const app = read('src/app/App.jsx');
    assert.match(app, /const target = SHORTCUT_ITEMS\[Number\(e\.key\) - 1\]/);
});
