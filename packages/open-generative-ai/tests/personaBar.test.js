// Hive Persona ID — the wiring the pure logic in personaId.test.js cannot see.
//
// PersonaBar.jsx, ReferencesMenu.jsx and VideoStudio.jsx are JSX, which
// node:test cannot import, so these assert the shape of the source the same way
// the other studio tests do (see framePickerInteractions.test.js). The flow
// itself — save, load, edit a row, overwrite — was driven in the browser
// against the running studio and the sealed blob it wrote.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('personas are their own sealed library, not a corner of an existing one', () => {
    const store = read('src/lib/savedLibraryStore.js');
    assert.match(store, /personas: 'personas'/);
    assert.match(store, /\[LIBRARIES\.personas\]: 'personas_v1'/, 'personas get their own vault blob key');
});

test('the persona bar lives in the References panel and owns no media of its own', () => {
    const menu = read('src/studios/video/ReferencesMenu.jsx');
    assert.match(menu, /<PersonaBar/);
    // It reads the same three lists the rows do and writes back through the same
    // setters — a persona is a NAME for those rows, never a fourth source.
    assert.match(menu, /onLoad=\{\(next\) => \{\s*emit\('images', next\.images\);\s*emit\('videos', next\.videos\);\s*emit\('audios', next\.audios\);/);
    const bar = read('src/studios/video/PersonaBar.jsx');
    assert.doesNotMatch(bar, /uploadFileToHivemindStudio|fetchHivemindReferences/, 'the bar never uploads or lists media itself');
});

test('loading checks the persona against references that still exist', () => {
    const menu = read('src/studios/video/ReferencesMenu.jsx');
    // Null until the listing has been read, and null again when the listing is
    // empty (standalone mode) — "could not check" must not read as "all gone".
    assert.match(menu, /const \[known, setKnown\] = useState\(null\)/);
    assert.match(menu, /setKnown\(refs\.length\s*\?\s*new Set\(/);
    assert.match(menu, /known=\{known\}/);
});

test('the studio carries which persona the references are, and drops it with them', () => {
    const logic = read('src/studios/video/videoLogic.js');
    // Every place the reference rows are emptied also puts the character down:
    // a fresh setup, a "+ New", and attaching a source video (which reference
    // mode never combines with).
    const clears = logic.split('referenceVideos: [],');
    assert.equal(clears.length - 1, 3, 'the three reference-clearing sites are still three');
    assert.equal((logic.match(/persona: null,/g) || []).length, 3, 'each of them clears the persona too');
    // A restored run says which character it ran with, even if it was deleted.
    assert.match(logic, /persona: context\.persona\?\.name \? \{ id: context\.persona\.id \|\| '', name: context\.persona\.name \} : null/);

    const studio = read('src/studios/VideoStudio.jsx');
    assert.match(studio, /persona: s\.setup\.persona \? \{ \.\.\.s\.setup\.persona \} : null,/, 'capture carries it');
    assert.match(studio, /persona=\{s\.setup\.persona \|\| null\}/);
    assert.match(studio, /onPersonaChange=\{onPersonaChange\}/);
});

test('the persona name never reaches localStorage', () => {
    // Settings persist in the clear; anything the owner wrote does not. A
    // character's name is theirs — it lives only in the sealed library.
    const prefs = read('src/lib/videoPreferences.js');
    assert.doesNotMatch(prefs, /persona/i);
});

test('a dialog raised from a popover does not dismiss the popover under it', () => {
    // Modals portal to document.body, so they are never inside the panel that
    // opened them: the capture-phase pointerdown closed the panel, React
    // unmounted the dialog with it, and the click that would have saved never
    // landed. Reproduced in the browser — the first Save persona did nothing.
    const menu = read('src/ui/Menu.jsx');
    assert.match(menu, /const inModal = \(node\) => Boolean\(node\?\.closest\?\.\('\[role="dialog"\]'\)\)/);
    assert.match(menu, /if \(inModal\(e\.target\)\) return;/);
    // Escape belongs to the topmost layer, which is the dialog.
    assert.match(menu, /if \(e\.key === 'Escape' && !modalOpen\(\)\) close\(\)/);
    // Every modal in the app is that one portal, so the guard covers all of them.
    assert.match(read('src/ui/Modal.jsx'), /role="dialog"/);
});
