// The key table's shape, and the surfaces that read from it.
//
// Moving the interface strings onto keys is only worth doing if the table stays
// the place a phrase is DECIDED. Four things break that, and every one of them
// had already happened:
//
//   * Two keys with the same value. 'Download' had four keys, 'Regenerate'
//     three, 'History' three — so "change the word" meant finding all of them,
//     and the studios drifted apart exactly as you would expect. A duplicate
//     value is a collision that has not happened yet.
//   * Two keys with the same value in DIFFERENT WORDS, which the equality check
//     cannot see. 'runOn.freeStaysHere' and 'runOn.freeStaysOnThisMac' shipped
//     side by side for a phase — one sentence, two phrasings, on one chip.
//   * A key whose value is empty (or whitespace). t() renders it as nothing at
//     all, so the control loses its label with no error anywhere.
//   * A key that is REFERENCED and missing. t() falls back to the key itself,
//     so a typo puts "nav.activity" on a button and every render test still
//     passes. That is the one failure a key table introduces on its own.
//
// The covered-surface tests are what keep the table from being bypassed: on a
// file named in COVERED, a user-visible string — between the tags, or in a
// label / hint / placeholder / title — has to come from `t`, never from a
// literal typed in place.
//
// Everything here reads the SOURCE as text where the rule is about what is
// written, and RENDERS where the rule is about what a person sees.
//
// Deliberately textual: several of these are claims about what is WRITTEN, not
// about what renders — that the table holds no duplicate value, no near
// duplicate and no empty one, and that a covered surface carries no bare
// literal. A render shows the string that won; only the source shows whether a
// second way of choosing it grew back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerHooks } = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const read = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full);
    }
    return out;
}

/* ---------------- the table itself ---------------- */

// Read as text on purpose: a key is written as a literal at its call site, and
// the literal is what has to line up. Function values (the handful of keys that
// interpolate) are recognised but not compared by value.
function entries() {
    const lines = read('lib/i18n.js').split('\n');
    const from = lines.findIndex((line) => line.trimEnd() === 'export const STRINGS = {');
    assert.ok(from >= 0, 'i18n.js has no STRINGS table');
    const to = lines.findIndex((line, index) => index > from && line.trimEnd() === '};');
    assert.ok(to > from, 'the STRINGS table is not closed');
    return lines.slice(from + 1, to)
        .map((line) => /^\s*'([^']+)':\s*(.+),$/.exec(line))
        .filter(Boolean)
        .map((match) => ({ key: match[1], raw: match[2] }));
}

test('the key table has no two keys with the same value', async () => {
    const { STRINGS } = await import(pathToFileURL(path.join(SRC, 'lib/i18n.js')).href);
    const byValue = new Map();
    for (const [key, value] of Object.entries(STRINGS)) {
        if (typeof value === 'function') continue;
        const seen = byValue.get(value) || [];
        seen.push(key);
        byValue.set(value, seen);
    }
    const collisions = [...byValue.entries()]
        .filter(([, keys]) => keys.length > 1)
        .map(([value, keys]) => `${JSON.stringify(value)} → ${keys.join(', ')}`);
    assert.deepEqual(
        collisions,
        [],
        'one phrase, one key — a second key holding the same words is how two surfaces drift apart',
    );
});

test('no key in the table is missing its value', async () => {
    const { STRINGS } = await import(pathToFileURL(path.join(SRC, 'lib/i18n.js')).href);
    const empty = Object.entries(STRINGS)
        .filter(([, value]) => (typeof value === 'function' ? false : !String(value ?? '').trim()))
        .map(([key]) => key);
    assert.deepEqual(empty, [], 'an empty value renders as nothing, silently');

    // Every line in the table parses as a key with a value on it: a stray line
    // would drop out of both this test and copyRules' key check.
    const parsed = entries();
    assert.ok(parsed.length > 150, `expected the full table, parsed ${parsed.length} entries`);
    assert.equal(
        parsed.length,
        Object.keys(STRINGS).length,
        'every entry in the table is one key on one line',
    );
    for (const { key, raw } of parsed) {
        assert.ok(key.includes('.'), `${key} is not namespaced`);
        assert.ok(raw.trim().length > 0, `${key} has no value`);
    }
});

/* ---------------- and no two keys hold the same phrase in different words ---- */

// The exact-value check above catches the easy half. The half that actually
// happened is a NEAR-duplicate: 'runOn.freeStaysHere' ("free, stays here") and
// 'runOn.freeStaysOnThisMac' ("free, stays on this Mac") sat in the table
// together for a whole phase and shipped side by side — the Image studio said
// one, the Video studio the other, on the same chip. Two different strings, so
// the equality test was happy.
//
// The shape of a value is its content words, sorted, with the small words that
// only carry grammar removed. Two keys with the same shape are the same
// sentence written twice.
const GRAMMAR = new Set([
    'a', 'an', 'the', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'be', 'it', 'its',
    'on', 'in', 'at', 'of', 'to', 'for', 'from', 'with', 'and', 'or', 'your', 'you', 'my',
    'here', 'there', 'now', 'own',
]);
const contentWords = (value) => String(value)
    .toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9']+/g, ' ')
    .trim().split(/\s+/)
    .filter((word) => word && !GRAMMAR.has(word));

// Reviewed and kept apart on purpose. Each line is a resolution, not a mute:
// the pair was read, and this is why it stays two keys.
const REVIEWED_SHAPES = [
    // The note is BUILT from the place label — `runOn.onYourCredits` is
    // `on your ${HIVEMINDOS_CREDITS}` — so the words repeat because they are
    // literally the same words, decided once in i18n.js.
    'credits hivemindos',
    // A confirm dialog asks the question and then names the act on its button.
    // They are the same words because they are the same decision seen twice —
    // "Cancel this production?" over "Cancel production" — and collapsing them
    // would leave the modal with a title or a button, not both.
    'cancel production',
];

test('no two keys say the same thing in different words', async () => {
    const { STRINGS } = await import(pathToFileURL(path.join(SRC, 'lib/i18n.js')).href);
    const byShape = new Map();
    for (const [key, value] of Object.entries(STRINGS)) {
        if (typeof value === 'function') continue;
        const words = contentWords(value);
        // One content word is a label, not a sentence: "Starting" and
        // "Starting..." are the same word for two different subjects, and
        // collapsing them would be a worse table, not a better one.
        if (words.length < 2) continue;
        const shape = words.slice().sort().join(' ');
        byShape.set(shape, [...(byShape.get(shape) || []), key]);
    }
    // One shape recurs honestly: a chip says "Not connected" and the card
    // underneath says "Not connected." — the label, and a sentence MADE of it.
    // That is allowed only when the table actually builds it: the longer value
    // is the shorter plus a full stop or a colon AND its line in i18n.js is a template
    // reading a shared const. A second hand-typed copy still fails.
    const derived = new Map(entries().map(({ key, raw }) => [key, raw]));
    const builtFromTheOther = (keys) => keys.length === 2 && keys.some((longer) => {
        const shorter = keys.find((key) => key !== longer);
        return ['.', ':'].some((mark) => STRINGS[longer] === `${STRINGS[shorter]}${mark}`)
            && /^`.*\$\{[A-Z_]+\}/.test(derived.get(longer) || '');
    });
    const collisions = [...byShape.entries()]
        .filter(([shape, keys]) => keys.length > 1 && !REVIEWED_SHAPES.includes(shape) && !builtFromTheOther(keys))
        .map(([, keys]) => `${keys.join(' / ')} — ${keys.map((key) => JSON.stringify(STRINGS[key])).join(' vs ')}`);
    assert.deepEqual(
        collisions,
        [],
        'one phrase, one key — reconcile it, or add its shape to REVIEWED_SHAPES with the reason',
    );
});

/* ---------------- and every key a surface asks for exists ---------------- */

test('every t() and tf() call site in src names a key the table holds', async () => {
    const { STRINGS } = await import(pathToFileURL(path.join(SRC, 'lib/i18n.js')).href);
    // A key that is not in the table is not an error anywhere: t() returns the
    // key, so the button reads "nav.activity" and the app looks broken to a
    // person and fine to every test that only renders. This is the test that
    // makes a typo fail here instead of on screen.
    const missing = [];
    for (const file of walk(SRC)) {
        if (path.relative(SRC, file) === 'lib/i18n.js') continue;
        const source = fs.readFileSync(file, 'utf8');
        source.split('\n').forEach((line, index) => {
            for (const match of line.matchAll(/\bt(?:f)?\(\s*'([a-zA-Z0-9_.-]+)'/g)) {
                if (!(match[1] in STRINGS)) missing.push(`${path.relative(SRC, file)}:${index + 1} ${match[1]}`);
            }
        });
    }
    assert.deepEqual(missing, [], 'a missing key renders as its own name');
});

test('the two families reached by a computed key are complete', async () => {
    const { STRINGS, aspectRatioName } = await import(pathToFileURL(path.join(SRC, 'lib/i18n.js')).href);
    // VideoStudio builds `video.progress.${stage}`, so every stage the
    // classifier can return has to be in the table — a stage nobody named
    // would render as "video.progress.queued" inside the progress card.
    const { classifyVideoGenerationStage } = await import(
        pathToFileURL(path.join(SRC, 'lib/videoPreferences.js')).href
    );
    const stages = new Set(['preparing']);
    for (const status of ['loading model', 'encoding', 'queued', 'sampling', '']) {
        stages.add(classifyVideoGenerationStage(status));
    }
    assert.deepEqual([...stages].sort(), ['finishing', 'loading', 'preparing', 'queued', 'rendering']);
    for (const stage of stages) {
        assert.ok(`video.progress.${stage}` in STRINGS, `video.progress.${stage} is not in the table`);
    }
    // And aspectRatioName resolves `ar.*` the same way.
    for (const ar of ['1:1', '16:9', '9:16', '21:9', '4:5', '3:2']) {
        const name = aspectRatioName(ar);
        assert.ok(name && !name.startsWith('ar.'), `${ar} rendered as a key: ${name}`);
    }
});

/* ---------------- the covered surfaces read from the table ---------------- */

// The surfaces that read their words from the table, and the boundary of this
// work. The first pass took the surfaces a first-run user meets — the shell and
// its state, the navigation, the doors out of an empty Model section, the
// failure primitive, the one control that says where work runs. This pass
// worked outward from there, in the order a person meets them: every dialog,
// the hub views, and the two studio panels that hold the deep dials.
//
// STILL INLINE, and honestly so: the studio stages and composers (Image, Video,
// Story, Sprite, Restore, Lip sync and everything under studios/*/), the two
// deepest operator consoles (hub/views/GpuMachinesView.jsx and
// hub/views/PlannerView.jsx), the shared components/ and ui/ widgets, and the
// sentences hub/hubData.js and the lib/ helpers compose. Adding a file here is
// the way to claim it: the two tests below then refuse it until it reads from
// the table.
const COVERED = [
    // The first pass.
    'app/navConfig.jsx',
    'app/statusStore.js',
    'components/RunOnPicker.jsx',
    'hub/components/ConnectComfyCard.jsx',
    'lib/describeFailure.js',
    'lib/failureRemedy.js',
    'lib/videoRestore.js',
    'studios/LocalCatalogNotice.jsx',
    'ui/failureToast.jsx',
    // Every dialog. A modal is where a person is STOPPED and asked something,
    // so its words are the ones that have to be exact.
    'dialogs/AuthModal.jsx',
    'dialogs/CivitaiDownloadDialog.jsx',
    'dialogs/ClipPrepDialog.jsx',
    'dialogs/LocalModelManager.jsx',
    'dialogs/PrivacyPanel.jsx',
    'dialogs/PrivacyVaultPanel.jsx',
    'dialogs/PromptHelperDialog.jsx',
    'dialogs/VideoInpaintDialog.jsx',
    // The hub views, and the Models page's own four.
    'hub/views/AboutView.jsx',
    'hub/views/CanvasView.jsx',
    'hub/views/HistoryView.jsx',
    'hub/views/InspoView.jsx',
    'hub/views/ModelsView.jsx',
    'hub/views/PassBookView.jsx',
    'hub/views/ProvidersView.jsx',
    'hub/views/RunsView.jsx',
    'hub/views/SettingsView.jsx',
    'hub/views/TelemetryView.jsx',
    'hub/views/models/AssetDetail.jsx',
    'hub/views/models/CivitaiBrowser.jsx',
    'hub/views/models/InstalledAssets.jsx',
    'hub/views/models/RunnableModels.jsx',
    // The studios' advanced panels — the dials behind the fold, which is where
    // a hint gets written twice because nobody has both open at once.
    'studios/image/ImageSettingsPanel.jsx',
    'studios/restore/RestoreSettings.jsx',
];

// JSX text position: what sits between an opening and a closing tag. Not
// attributes (a `className` is not copy), not expressions (`{t('…')}` is the
// answer, `{cond ? … : …}` is code), and not the tag names themselves.
//
// A `{/* … */}` comment is prose in JSX position and would read as copy, so the
// scan tracks the block and skips what is inside it.
function bareJsxText(source) {
    const found = [];
    let inComment = false;
    source.split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        const opens = trimmed.includes('{/*') || trimmed.startsWith('/*');
        const closes = trimmed.includes('*/');
        if (inComment) {
            if (closes) inComment = false;
            return;
        }
        if (opens && !closes) { inComment = true; return; }
        if (opens && closes) return;
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        // A multi-line import's member list reads as capitalised words too:
        // `Button, Card, Field, NativeSelect,`. It is code, not copy.
        if (/^[A-Za-z][A-Za-z0-9]*(?:,\s*[A-Za-z][A-Za-z0-9]*)+,?$/.test(trimmed)) return;
        // A line that is nothing but words, sitting inside JSX: `Connect ComfyUI`.
        if (/^[A-Z][A-Za-z0-9 ,.'’—–-]{2,}$/.test(trimmed) && !trimmed.endsWith(';')) {
            found.push(`${index + 1}: ${trimmed}`);
            return;
        }
        // …and the same thing inline: `>Connect ComfyUI<`.
        const inline = /> ?([A-Z][A-Za-z0-9 ,.'’—–-]{2,}?) ?</.exec(line);
        if (inline) found.push(`${index + 1}: ${inline[1]}`);
    });
    return found;
}

// The other half of a covered surface: copy typed into an attribute. A label, a
// hint, a placeholder or a title is read by a person exactly the way the text
// between the tags is, and leaving it out of the rule is how a "covered" dialog
// keeps a second, unreviewed vocabulary in its own Field labels.
const COPY_ATTRIBUTES = /\b(label|hint|placeholder|title|kicker|subtitle|aria-label|confirmLabel|cancelLabel|retryLabel|body)="([^"]{2,})"/g;

function bareAttributeCopy(source) {
    const found = [];
    source.split('\n').forEach((line, index) => {
        if (line.trim().startsWith('//')) return;
        for (const match of line.matchAll(COPY_ATTRIBUTES)) {
            found.push(`${index + 1}: ${match[1]}="${match[2]}"`);
        }
    });
    return found;
}

test('no covered surface still writes a user-visible string in JSX text position', () => {
    const offenders = [];
    for (const file of COVERED) {
        if (!file.endsWith('.jsx')) continue;
        for (const hit of bareJsxText(read(file))) offenders.push(`${file}:${hit}`);
    }
    assert.deepEqual(offenders, [], 'a covered surface reads its words from t(), never from a literal');
});

test('no covered surface hides copy in a label, hint, placeholder or title', () => {
    const offenders = [];
    for (const file of COVERED) {
        if (!file.endsWith('.jsx')) continue;
        for (const hit of bareAttributeCopy(read(file))) offenders.push(`${file}:${hit}`);
    }
    assert.deepEqual(offenders, [], 'an attribute a person reads is copy, and copy comes from the table');
});

test('every covered surface actually imports the table', () => {
    const missing = COVERED.filter((file) => !/from '(?:\.{1,2}\/)*(?:lib\/)?i18n\.js'/.test(read(file)));
    assert.deepEqual(missing, [], 'a covered surface with no t() import is not covered');
});

/* ---------------- and the app renders what it rendered before ---------------- */

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
    style: {}, children: [], firstChild: { data: '' }, innerHTML: '', id: '',
    setAttribute() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
});
globalThis.window = globalThis;
Object.assign(globalThis, eventTarget(), {
    localStorage: globalThis.localStorage || memoryStorage(),
    sessionStorage: globalThis.sessionStorage || memoryStorage(),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '', hash: '' },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
});
globalThis.document = globalThis.document || Object.assign(eventTarget(), {
    body: element(), head: element(),
    documentElement: Object.assign(element(), { classList: { add() {}, remove() {}, contains() { return false; } } }),
    createElement: element,
    createTextNode: (data) => ({ data }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    hidden: false, visibilityState: 'visible', title: '',
});
globalThis.fetch = globalThis.fetch || (() => Promise.reject(new Error('network refused in test')));

test('the Setup doors render the same three sentences and the same three buttons', async () => {
    const { LocalCatalogNotice, localCatalogSentence } = await import(
        pathToFileURL(path.join(SRC, 'studios/LocalCatalogNotice.jsx')).href
    );
    // The sentences, verbatim — this is the "renders identically" half.
    assert.equal(localCatalogSentence('no-comfy'), 'ComfyUI is not connected.');
    assert.equal(localCatalogSentence('unreachable'), 'The local engine is starting — it has not answered yet.');
    assert.equal(localCatalogSentence('empty'), 'No image model installed yet.');
    assert.equal(localCatalogSentence('discovering'), 'Looking at what this machine can run…');
    assert.equal(localCatalogSentence('ready'), '');

    const render = (props) => renderToStaticMarkup(React.createElement(LocalCatalogNotice, {
        onCheckAgain: () => {}, onSwitchToCloud: () => {}, ...props,
    }));

    const noComfy = render({ status: 'empty', comfyConnected: false });
    assert.match(noComfy, /ComfyUI is not connected\./);
    assert.match(noComfy, /Local models run on ComfyUI\./);
    assert.match(noComfy, />Connect ComfyUI</);
    assert.match(noComfy, />Switch to cloud</);

    const empty = render({ status: 'empty', comfyConnected: true });
    assert.match(empty, /No image model installed yet\./);
    assert.match(empty, />Open Models</);

    const unreachable = render({ status: 'unreachable', comfyConnected: true });
    assert.match(unreachable, /The local engine is starting/);
    assert.match(unreachable, />Check again</);

    assert.equal(render({ status: 'ready', comfyConnected: true }), '');
});

test('the failure primitive still says the same sentences and offers the same buttons', async () => {
    const { describeFailure } = await import(pathToFileURL(path.join(SRC, 'lib/describeFailure.js')).href);

    assert.equal(describeFailure(new Error(''), {}).title, 'That did not work');
    assert.equal(describeFailure(new Error(''), { operation: 'Upload' }).title, 'Upload failed');

    const bridge = describeFailure(new Error('Failed to fetch'), { transport: 'local' });
    assert.equal(bridge.title, 'The local engine is not running');
    assert.deepEqual(bridge.remedy, { label: 'Check again', action: 'refresh' });

    const studio = describeFailure(new Error('Failed to fetch'), { transport: 'studio' });
    assert.equal(studio.title, 'The studio is not answering');
    assert.deepEqual(studio.remedy, { label: 'Check again', action: 'refresh' });

    const oom = describeFailure(new Error('CUDA out of memory'), { transport: 'local', canLowerResolution: true });
    assert.equal(oom.title, 'Not enough memory for this size');
    assert.deepEqual(oom.remedy, { label: 'Lower resolution', action: 'lower-resolution' });

    // The Restore studio's own failure reader — its own set of sentences, now
    // in the same table, each still arriving with the step that continues it.
    const { describeRestoreFailure } = await import(pathToFileURL(path.join(SRC, 'lib/videoRestore.js')).href);
    const stopped = describeRestoreFailure('');
    assert.equal(stopped.title, 'That render stopped.');
    assert.equal(stopped.action, 'Resume picks up at the first unfinished chunk.');
    const outOfMemory = describeRestoreFailure('CUDA out of memory');
    assert.equal(outOfMemory.title, 'That machine ran out of memory on this chunk.');
    assert.match(outOfMemory.action, /^Lower the temporal batch/);
});

test('one vocabulary for the three places, in every picker that names them', async () => {
    const { RUN_PLACES, runOnReadout } = await import(pathToFileURL(path.join(SRC, 'lib/runTargets.js')).href);
    const { SECTIONS } = await import(pathToFileURL(path.join(SRC, 'lib/textModels.js')).href);
    const { SOURCE_LABELS } = await import(pathToFileURL(path.join(SRC, 'lib/studioTargets.js')).href);
    const { placeLabelFor } = await import(pathToFileURL(path.join(SRC, 'lib/modelRunner.js')).href);

    assert.deepEqual(RUN_PLACES.map((place) => place.label), ['This Mac', 'HivemindOS credits', 'Your accounts']);
    // The text producer's picker used to call the same box "This machine".
    assert.equal(SECTIONS[0].label, 'This Mac');
    assert.equal(SECTIONS[2].label, 'Your accounts');
    assert.equal(SECTIONS[2].blurb, RUN_PLACES[2].blurb, 'and described it in a second set of words');
    assert.equal(SOURCE_LABELS.local, 'This Mac');
    assert.equal(SOURCE_LABELS.api, 'Your accounts');
    assert.equal(placeLabelFor({ source: 'local' }), 'This Mac');
    assert.equal(runOnReadout(null).place, 'Nowhere yet');
    assert.equal(runOnReadout({ label: 'Z-Image', place: 'this-mac' }).place, 'This Mac');
});

test('the studio names its own state in three words, and the retry is one word everywhere', async () => {
    const { apiStatusLabel, apiOfflineSentence } = await import(pathToFileURL(path.join(SRC, 'app/statusStore.js')).href);
    assert.equal(apiStatusLabel({ tone: 'online' }), 'Ready');
    assert.equal(apiStatusLabel({ tone: 'connecting' }), 'Starting');
    assert.equal(apiStatusLabel({ tone: 'offline' }), 'Not running');
    assert.match(apiOfflineSentence(), /^The studio’s local service is not answering/);

    // "Retry now" in the shell, "Try again" in the callouts and "Check again" in
    // the model section were three spellings of two acts. Now they are two.
    const { STRINGS } = await import(pathToFileURL(path.join(SRC, 'lib/i18n.js')).href);
    assert.equal(STRINGS['common.tryAgain'], 'Try again');
    assert.equal(STRINGS['common.checkAgain'], 'Check again');
    for (const file of ['app/Shell.jsx', 'ui/kit.jsx']) {
        assert.doesNotMatch(read(file), /Retry now/, `${file} still has the third spelling`);
    }
});
