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
    // Restore, load, save and cast-apply all shape the label through ONE
    // helper, so a persona saved before gender existed comes back with
    // gender '' everywhere rather than undefined in some places.
    assert.match(logic, /persona: personaIdentity\(context\.persona\)/);

    const studio = read('src/studios/VideoStudio.jsx');
    assert.match(studio, /persona: s\.setup\.persona \? \{ \.\.\.s\.setup\.persona \} : null,/, 'capture carries it');
    assert.match(studio, /persona: personaIdentity\(next\)/, 'the bar\'s change handler shapes it the same way');
    assert.match(studio, /persona: personaIdentity\(persona\)/, 'and so does applying a cast');
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

test('a persona has a gender, set beside its name and read by every generator', () => {
    // Set in two places — the save dialog, and the bar for a loaded character —
    // through one chip row, and written into the persona payload itself.
    const bar = read('src/studios/video/PersonaBar.jsx');
    assert.match(bar, /function GenderChips\(/);
    assert.match(bar, /<GenderChips value=\{saveGender\} onChange=\{setSaveGender\}/, 'the save dialog asks for it');
    assert.match(bar, /<GenderChips compact value=\{gender\} onChange=\{setLoadedGender\}/, 'the bar lets a loaded persona change it');
    assert.match(bar, /const data = \{ \.\.\.current, gender: normalizePersonaGender\(saveGender\) \};/, 'save writes it into the payload');
    assert.match(bar, /personaFromReferences\(\{ images, videos, audios, gender \}\)/, 'the loaded gender is part of what is compared and saved over');
    // The shared save dialog grew a slot for it rather than the bar growing a
    // second dialog.
    assert.match(read('src/ui/SavedLibrary.jsx'), /children = null,/);
    // Every place that writes ABOUT the persona reads the gender: the cast
    // compiler, the reference scaffold, the UGC deal, the prompt helper, the
    // starters.
    assert.match(read('src/lib/castPrompt.js'), /gender: normalizePersonaGender\(persona\?\.gender\)/);
    const studio = read('src/studios/VideoStudio.jsx');
    assert.match(studio, /ugcVariantAt\(index, \{ gender: s\.setup\.persona\?\.gender \}\)/);
    // With pictures attached the UGC brief is about the person in them, so the
    // reference rows (and the persona's name/gender) go to the brief builder,
    // and the menu says who the clip will be about.
    assert.match(studio, /persona: ugcPersona\(\),/);
    assert.match(studio, /subject=\{ugcSubjectLabel\(ugcPersona\(\)\)\}/);
    assert.match(studio, /videoRequestPlan\(s\.setup\)\.sendReferenceImages\) return null;/, 'only pictures that will be SENT count');
    assert.match(studio, /personaGender=\{s\.setup\.persona\?\.gender \|\| ''\}/);
    assert.match(studio, /gender: s\.setup\.persona\?\.gender \|\| '',/, 'the helper result is re-scaffolded with it');
    assert.match(read('src/studios/video/ReferencesMenu.jsx'), /withReferenceTags\(prompt, \{ images, videos, audios, gender: persona\?\.gender \|\| '' \}\)/);
    assert.match(read('src/lib/defaultPrompts.js'), /const gender = source\?\.persona\?\.gender \|\| '';/);
    // Only the gender reaches the helper request — never the persona's name,
    // which is sealed to the owner's vault.
    const dialog = read('src/dialogs/PromptHelperDialog.jsx');
    assert.match(dialog, /personaGender: personaGender \|\| undefined,/);
    assert.doesNotMatch(dialog, /personaName/);
});

// The compact switch on a video row. One rule (referenceVideoCanvas) decides
// both what the row SHOWS and what is SENT, and every carrier of a reference
// video — cast, persona, portable persona, the request itself — keeps the flag
// beside useAudio rather than dropping it on the way through.
test('a video row\'s compact switch reaches the request, and every carrier keeps it beside useAudio', () => {
    // The request: "compact" or "full" per clip, from the shared rule, which
    // also holds it to full while no picture is attached.
    const studioLib = read('src/lib/hivemindStudio.js');
    assert.match(studioLib, /import \{ isSoundOnlyReference, referenceVideoCanvas \} from '\.\/h3References\.js';/);
    assert.match(studioLib, /use_audio: Boolean\(item\.useAudio\),[\s\S]{0,900}canvas: referenceVideoCanvas\(item, \{ images: referenceImages \}\),/);
    // The carriers.
    assert.match(read('src/lib/personaId.js'), /useAudio: Boolean\(item\.useAudio\),[\s\S]{0,400}compact: Boolean\(item\.compact\),/, 'personaFromReferences');
    assert.match(read('src/lib/personaId.js'), /videos: persona\.videos\.map\(\(item\) => \[item\.url, item\.useAudio, item\.compact, item\.motion === false\]\)/, 'an edit worth saving');
    assert.match(read('src/lib/personaTransfer.js'), /useAudio: item\.useAudio,\s*compact: item\.compact,/, 'import re-uploads keep it');
    assert.match(read('src/lib/castPrompt.js'), /useAudio: Boolean\(item\.useAudio\), compact: Boolean\(item\.compact\),/, 'a cast member keeps it');
    // Default OFF on every way a clip reaches the rows from the studio itself.
    const studio = read('src/studios/VideoStudio.jsx');
    assert.match(studio, /\{ url, name, useAudio: false, compact: false \}/);
    assert.match(studio, /\(\{ \.\.\.item, useAudio: false, compact: false \}\)/);
    // The server accepts exactly the two values the MCP does and forwards them.
    const api = read('../../src/hivemind_content_studio/control_api.py');
    assert.match(api, /canvas: Literal\["full", "compact"\] = "full"/);
    assert.match(api, /"use_audio": bool\(video_item\.use_audio\),\s*"canvas": video_item\.canvas,/);
});
