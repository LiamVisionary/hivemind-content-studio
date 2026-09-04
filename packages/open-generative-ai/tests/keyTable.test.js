// The key table's shape, and the surfaces that read from it.
//
// Moving the interface strings onto keys is only worth doing if the table stays
// the place a phrase is DECIDED. Two things break that, and both had already
// happened before the table was one table:
//
//   * Two keys with the same value. 'Download' had four keys, 'Regenerate'
//     three, 'History' three — so "change the word" meant finding all of them,
//     and the studios drifted apart exactly as you would expect. A duplicate
//     value is a collision that has not happened yet.
//   * A key whose value is empty (or whitespace). t() renders it as nothing at
//     all, so the control loses its label with no error anywhere.
//
// The third test is the one that keeps the table from being bypassed: on the
// surfaces this item covered — the shell, the nav, the Setup doors, the failure
// primitive and the Runs-on control — a user-visible string in JSX text
// position has to come from `t`, not from a literal typed in place.
//
// Everything here reads the SOURCE as text where the rule is about what is
// written, and RENDERS where the rule is about what a person sees.
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

/* ---------------- the covered surfaces read from the table ---------------- */

// The surfaces this item moved onto keys. A file is on this list because a
// first-run user meets it: the shell and its state, the navigation, the doors
// out of an empty Model section, the failure primitive, and the one control
// that says where work runs. Deep advanced panels are NOT here yet.
const COVERED = [
    'app/navConfig.jsx',
    'app/statusStore.js',
    'components/RunOnPicker.jsx',
    'hub/components/ConnectComfyCard.jsx',
    'lib/describeFailure.js',
    'lib/failureRemedy.js',
    'lib/videoRestore.js',
    'studios/LocalCatalogNotice.jsx',
    'ui/failureToast.jsx',
];

// JSX text position: what sits between an opening and a closing tag. Not
// attributes (a `className` is not copy), not expressions (`{t('…')}` is the
// answer, `{cond ? … : …}` is code), and not the tag names themselves.
function bareJsxText(source) {
    const found = [];
    source.split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
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

test('no covered surface still writes a user-visible string in JSX text position', () => {
    const offenders = [];
    for (const file of COVERED) {
        if (!file.endsWith('.jsx')) continue;
        for (const hit of bareJsxText(read(file))) offenders.push(`${file}:${hit}`);
    }
    assert.deepEqual(offenders, [], 'a covered surface reads its words from t(), never from a literal');
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
