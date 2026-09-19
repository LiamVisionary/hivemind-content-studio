// The reference picker opens on its SOURCES, not on one grid.
//
// Two rows — Previous uploads (this browser's history merged with the owner's
// saved server references) and Library (every output the studios have made) —
// each showing the four most recent images in it, and pressing one drills into
// the grid the panel has always had.
//
// The rows themselves are RENDERED here (SourceCard is exported for it). The
// panel they live in is behind `panelOpen`, which a static render never
// reaches, so the wiring around them is asserted on source text instead.
// Deliberately textual: which source a press opens, that a Library pick is
// promoted before it is selected, and that selection reads a ref rather than
// the `values` prop are all a control flow between handlers — there is no
// rendered form of "the second pick added to the first", and the browser run
// that found it is recorded in CHANGELOG.md rather than reproducible here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent, textOf } = require('./helpers/render.js');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

// The render helper owns the browser surface; hivemindStudio reads the studio
// marker off it at call time.
global.window.__HIVEMIND_STUDIO__ = 1;

async function loadStudio() {
    return import('../src/lib/hivemindStudio.js');
}

// A reference entry as the picker holds one. Plain https URLs: a same-origin
// /api/ source renders as a decrypting skeleton rather than an <img>, which is
// the picker's E2E behaviour and not what these rows are about.
const entry = (n) => ({ id: `e${n}`, name: `shot-${n}.png`, uploadedUrl: `https://example.invalid/shot-${n}.png` });

function canvasRow(id, overrides = {}) {
    return {
        history_id: id,
        media_type: 'image/png',
        file_format: 'png',
        created_at: 1_700_000_000,
        output_basename: `${id}.png`,
        media_url: `/api/canvas/history/${id}/media`,
        ...overrides,
    };
}

function stubFetch(handler) {
    const original = global.fetch;
    global.fetch = handler;
    return () => { global.fetch = original; };
}

/* ---------------- reading the Library ---------------- */

test('the Library reads the output index and comes back shaped like upload history', async () => {
    const { fetchHivemindLibraryOutputs } = await loadStudio();
    const seen = [];
    const restore = stubFetch(async (url) => {
        seen.push(url);
        return {
            ok: true,
            json: async () => ({ history: [canvasRow('out-1'), canvasRow('out-2')] }),
        };
    });
    try {
        const rows = await fetchHivemindLibraryOutputs();
        assert.equal(rows.length, 2);
        assert.deepEqual(rows[0], {
            id: 'library:out-1',
            name: 'out-1.png',
            uploadedUrl: '/api/canvas/history/out-1/media',
            thumbnail: null,
            timestamp: new Date(1_700_000_000 * 1000).toISOString(),
            libraryOutput: true,
        });
        // Page 1 only, and the page size is clamped to what the route accepts.
        assert.match(seen[0], /^\/api\/canvas\/history\?/);
        assert.match(seen[0], /page=1/);
        assert.match(seen[0], /page_size=60/);
    } finally { restore(); }
});

test('a clip never reaches a picture grid — these rows carry no poster, so a tile decrypts the whole file', async () => {
    const { fetchHivemindLibraryOutputs } = await loadStudio();
    const restore = stubFetch(async () => ({
        ok: true,
        json: async () => ({
            history: [
                canvasRow('img', { media_type: 'image/png' }),
                canvasRow('clip', { media_type: 'video/mp4', file_format: 'mp4' }),
                canvasRow('voice', { media_type: 'audio/mpeg', file_format: 'mp3' }),
            ],
        }),
    }));
    try {
        assert.deepEqual((await fetchHivemindLibraryOutputs({ kind: 'image' })).map((r) => r.id), ['library:img']);
        assert.deepEqual((await fetchHivemindLibraryOutputs({ kind: 'video' })).map((r) => r.id), ['library:clip']);
    } finally { restore(); }
});

test('an unreadable Library is a missing row in a menu, never a broken picker', async () => {
    const { fetchHivemindLibraryOutputs } = await loadStudio();
    let restore = stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    try { assert.deepEqual(await fetchHivemindLibraryOutputs(), []); } finally { restore(); }

    restore = stubFetch(async () => { throw new Error('offline'); });
    try { assert.deepEqual(await fetchHivemindLibraryOutputs(), []); } finally { restore(); }

    // …and the route is not called at all outside studio mode.
    global.window.__HIVEMIND_STUDIO__ = 0;
    let called = false;
    restore = stubFetch(async () => { called = true; return { ok: true, json: async () => ({}) }; });
    try {
        assert.deepEqual(await fetchHivemindLibraryOutputs(), []);
        assert.equal(called, false);
    } finally {
        restore();
        global.window.__HIVEMIND_STUDIO__ = 1;
    }
});

/* ---------------- the picker's opening list ---------------- */

test('a source row says what it holds and shows its four most recent', async () => {
    const entries = [1, 2, 3, 4, 5, 6].map(entry);
    const markup = await renderComponent('src/studios/UploadPicker.jsx', 'SourceCard', {
        title: 'Previous uploads', noun: 'images', entries, onOpen() {},
    });
    assert.match(textOf(markup), /Previous uploads 6 images/);
    const shown = [...markup.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    // Four, and the four at the FRONT of the list — these arrive newest first.
    assert.deepEqual(shown, entries.slice(0, 4).map((e) => e.uploadedUrl));
});

test('a source still being read draws a skeleton, and one with nothing in it does not open', async () => {
    // null entries = not read yet. A static "Loading…" is banned; the face and
    // the count are both skeletons until the answer lands.
    const loading = await renderComponent('src/studios/UploadPicker.jsx', 'SourceCard', {
        title: 'Library', noun: 'images', entries: null, onOpen() {},
    });
    assert.equal((loading.match(/animate-pulse/g) || []).length, 5, 'four tiles and the count');
    assert.doesNotMatch(textOf(loading), /Loading|Reading/);
    assert.doesNotMatch(loading, /disabled/, 'a source being read is not yet refused');

    // Read, and empty: the row still says where references come from, but it
    // does not open onto an empty grid.
    const empty = await renderComponent('src/studios/UploadPicker.jsx', 'SourceCard', {
        title: 'Library', noun: 'images', entries: [], onOpen() {},
    });
    assert.match(textOf(empty), /Library Nothing yet/);
    assert.match(empty, /disabled=""/);
    assert.match(empty, /title="Nothing in library yet"/);

    // One image is "1 image", not "1 images".
    const one = await renderComponent('src/studios/UploadPicker.jsx', 'SourceCard', {
        title: 'Previous uploads', noun: 'images', entries: [entry(1)], onOpen() {},
    });
    assert.match(textOf(one), /Previous uploads 1 image$/);
});

test('the panel opens on the two sources, and a press drills into one', () => {
    const picker = read('src/studios/UploadPicker.jsx');
    // null section = the opening list; a press drills in, the trigger resets it.
    assert.match(picker, /const \[section, setSection\] = useState\(null\)/);
    assert.match(picker, /\{section === null \? \(/);
    assert.match(picker, /title="Previous uploads"[\s\S]*?entries=\{mergedHistory\}[\s\S]*?onOpen=\{\(\) => setSection\('uploads'\)\}/);
    assert.match(picker, /title="Library"[\s\S]*?entries=\{library\}[\s\S]*?onOpen=\{\(\) => setSection\('library'\)\}/);
    // Opening the panel always lands on the list of sources.
    assert.match(picker, /onClick=\{\(\) => \{ setPanelOpen\(\(v\) => !v\); setSection\(null\); \}\}/);
});

test('the Library is read when the panel opens, not when the picker mounts', () => {
    const picker = read('src/studios/UploadPicker.jsx');
    // Several pickers mount at once in the video studio; none should cost a
    // history page until someone actually looks.
    assert.match(picker, /if \(!panelOpen\) return undefined;[\s\S]*?fetchHivemindLibraryOutputs/);
    assert.match(picker, /\}, \[panelOpen, accept\]\);/);
});

test('a Library pick is promoted into a reference before it is selected', () => {
    const picker = read('src/studios/UploadPicker.jsx');
    // The same path "use this generation as an input" already takes, so what
    // reaches onChange is an ordinary reference URL and every studio downstream
    // sees exactly what an upload gives it.
    assert.match(picker, /import \{ promoteOutputToReference \} from '\.\.\/lib\/outputToReference\.js';/);
    assert.match(picker, /const url = await promoteOutputToReference\(entry\.uploadedUrl, \{/);
    // Picked twice, promoted once: the session remembers the copy it made.
    assert.match(picker, /const already = promoted\[entry\.uploadedUrl\];/);
    assert.match(picker, /if \(already\) \{ toggleFromHistory\(\{ \.\.\.entry, uploadedUrl: already \}\); return; \}/);
    // Two tiles can be promoting at once, so the busy mark is a set: the first
    // to finish must not clear the other's spinner.
    assert.match(picker, /const \[promoting, setPromoting\] = useState\(\(\) => new Set\(\)\)/);
    assert.match(picker, /const busy = promoting\.has\(entry\.uploadedUrl\)/);
});

test('two Library picks at once keep both, rather than the last one winning', () => {
    const picker = read('src/studios/UploadPicker.jsx');
    // A Library pick selects only after its upload finishes, so two picks can
    // resolve in the same tick — before either render commits. Reading the
    // `values` PROP there made the second pick replace the first: measured in
    // the browser as three picks uploaded and one kept. Selection reads the ref,
    // every change writes it on the way out, and the prop takes it back once the
    // parent has re-rendered.
    assert.match(picker, /const valuesRef = useRef\(values\);/);
    assert.match(picker, /useEffect\(\(\) => \{ valuesRef\.current = values; \}, \[values\]\);/);
    assert.match(picker, /const onChange = useCallback\(\(next\) => \{\s*\n\s*valuesRef\.current = next;\s*\n\s*onSelectionChange\?\.\(next\);/);
    assert.match(picker, /const current = valuesRef\.current;\s*\n\s*const idx = current\.indexOf\(url\);/);
    assert.doesNotMatch(picker, /if \(values\.length >= maxImages\) return;/);
});

test('the X on a tile deletes a reference, so a Library output never carries one', () => {
    const picker = read('src/studios/UploadPicker.jsx');
    // Pointing that button at a generation would make a reference picker a place
    // the owner's work can be destroyed from. The Library page owns that.
    assert.match(picker, /\{entry\.libraryOutput \? null : \(/);
    assert.match(picker, /aria-label="Remove from history"/);
});
