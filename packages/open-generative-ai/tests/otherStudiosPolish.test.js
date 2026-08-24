const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Source-shape pins for the Cinema / Lip sync / shared-dialog fixes. These are
// JSX files node:test cannot import, so the wiring is asserted on the source;
// the behaviour itself was driven in the browser.
const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('Cinema and Lip sync route history through the studio helpers, never raw localStorage', () => {
    for (const [relative, key] of [['src/studios/CinemaStudio.jsx', 'cinema_history'], ['src/studios/LipSyncStudio.jsx', 'lipsync_history']]) {
        const source = read(relative);
        assert.match(source, /import \{ loadStudioGenerationHistory, saveStudioGenerationHistory \} from '\.\.\/lib\/hivemindStudio\.js';/, `${relative} imports the helpers`);
        assert.match(source, new RegExp(`loadStudioGenerationHistory\\(${key.toUpperCase().replace('_', '_')}_KEY\\)|loadStudioGenerationHistory\\('${key}'\\)`), `${relative} reads through the helper`);
        assert.match(source, /saveStudioGenerationHistory\(/, `${relative} writes through the helper`);
        // The only localStorage use left is the preferences normalizer — never the history.
        const rawHistoryWrites = source.match(/localStorage\.setItem\([^)]*HISTORY/g) || [];
        assert.deepEqual(rawHistoryWrites, [], `${relative} must not write history to localStorage itself`);
        assert.doesNotMatch(source, /localStorage\.getItem\((CINEMA|LIPSYNC)_HISTORY_KEY\)/);
        // The storage key names are unchanged so the scrub helper can target them.
        assert.match(source, new RegExp(`'${key}'`));
    }
});

test('Cinema: Generate is disabled with a reason on an empty prompt and downloads use the one helper', () => {
    const cinema = read('src/studios/CinemaStudio.jsx');
    assert.match(cinema, /disabled=\{!hasPrompt\}/);
    assert.match(cinema, /Describe the scene first/);
    assert.match(cinema, /import \{ downloadMedia \} from '\.\.\/lib\/downloadMedia\.js';/);
    assert.match(cinema, /imageDownloadName\(CINEMA_MODEL, entry\.timestamp\)/, 'model-derived names');
    assert.doesNotMatch(cinema, /cinema-shot-\$\{Date\.now\(\)\}\.jpg/, 'the hand-copied downloader is gone');
    assert.doesNotMatch(cinema, /\|\| '1k'/, "the resolution fallback agrees with the default ('2K')");
    assert.match(cinema, /AspectRatioPicker/, 'same aspect control as Image/Video');
    assert.match(cinema, /e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)/, 'Cmd/Ctrl+Enter generates');
});

test('Lip sync: composer drop routes files by kind, sealed portraits are confirmed before upload, errors are described', () => {
    const lip = read('src/studios/LipSyncStudio.jsx');
    assert.match(lip, /composerDrop=\{composerDrop\}/);
    assert.match(lip, /mime\.startsWith\('audio\/'\)[\s\S]*mime\.startsWith\('video\/'\)[\s\S]*mime\.startsWith\('image\/'\)/);
    assert.match(lip, /referencesNeedingApproval\(\[s\.uploadedImageUrl\], s\.cloudRefApproved\)/);
    assert.match(lip, /resolveCloudReferences\(\[s\.uploadedImageUrl\], \{ cache: s\.cloudRefUploads \}\)/);
    assert.match(lip, /Runs on MUAPI \(cloud\) — files you attach are uploaded there\./);
    assert.match(lip, /toastMuapiError\(/);
    assert.doesNotMatch(lip, /toast\.error\(`Error: \$\{e\.message\}`\)/);
    assert.match(lip, /Runs again with the current inputs/);
    assert.match(lip, /toLocaleString\(\)/, 'the viewer shows a readable timestamp');
    assert.match(lip, /getCurrentModel\(\)\?\.hasPrompt/, 'the dock inserter is guarded on hasPrompt');
    assert.match(lip, /videoDownloadName\(entry\.model, entry\.id\)/);
    // The payload contract is untouched.
    assert.match(lip, /if \(prompt && model\?\.hasPrompt\) lipsyncParams\.prompt = prompt;/);
    assert.match(lip, /if \(model\?\.hasSeed\) lipsyncParams\.seed = -1;/);
});

test('the saved library surfaces a failed read and an unreadable blob instead of "nothing saved yet"', () => {
    const hooks = read('src/hooks/hooks.js');
    assert.match(hooks, /error: locked \? '' : \(error\?\.message \|\| 'Could not open your library\.'\)/);
    assert.match(hooks, /unreadable: isLibraryUnreadable\(library\)/);
    const note = read('src/ui/SavedLibrary.jsx');
    assert.match(note, /Couldn't open your library\./);
    assert.match(note, /onRetry \? <Button size="sm" variant="neutral" onClick=\{onRetry\}>Retry<\/Button> : null/);
    assert.match(note, /Saving will ask before replacing it\./);
    const menu = read('src/studios/SavedPromptsMenu.jsx');
    assert.match(menu, /error=\{error\}\s+onRetry=\{retry\}\s+unreadable=\{unreadable\}/);
    assert.match(menu, /if \(error\?\.unreadable\) \{ setConfirmReplace\(name\); return; \}/);
    assert.match(menu, /save\(name, \{ overwriteUnreadable: true \}\)/);
    // Delete keeps the menu open under the confirm; the menu closes after.
    assert.match(menu, /onClick=\{\(\) => setConfirmDelete\(entry\)\}/);
    assert.match(menu, /closeMenuRef\.current\?\.\(\);/);
    assert.match(menu, /searchable \? filterSavedPrompts\(entries, query\) : entries/);
});

test('ClipPrep says which side of the motion budget binds, the right way round', () => {
    const dialog = read('src/dialogs/ClipPrepDialog.jsx');
    // Short reference (limitedByReference): it keeps its own length and opens the full range.
    assert.match(dialog, /budget\.limitedByReference \? \(\s*<>This <strong>\{seconds\(budget\.referenceSeconds\)\}<\/strong> reference keeps its own length — it costs \{seconds\(budget\.referenceSeconds\)\} of motion budget and leaves the full \{seconds\(clipSeconds\)\} range open\.<\/>/);
    // Long reference: trimmed to the shot on the way in.
    assert.match(dialog, /Longer than the \{seconds\(clipSeconds\)\} shot: it is trimmed to \{seconds\(clipSeconds\)\} on the way in\. Trim it below \{seconds\(clipSeconds\)\} to spend less budget\./);
    assert.doesNotMatch(dialog, /the shot will be capped to the reference/);
    assert.doesNotMatch(dialog, /type="checkbox"/, 'the audio switch is the kit Toggle');
    assert.match(dialog, /<Toggle checked=\{dropAudio\}/);
    assert.match(dialog, /onClick=\{\(\) => setAttempt\(\(n\) => n \+ 1\)\}>Retry<\/Button>/);
});

test('the prompt helper waits for the runtime snapshot and keeps Unload out of the row button', () => {
    const dialog = read('src/dialogs/PromptHelperDialog.jsx');
    assert.match(dialog, /Checking this machine's RAM and models…/);
    assert.match(dialog, /role="radio"/);
    assert.doesNotMatch(dialog, /role="button"/, 'no control nested in a button');
    assert.match(dialog, /label=\{`Unload \$\{model\.name\}`\}/);
    assert.match(dialog, /describeWritingFor\(\{ cast, references \}\)/);
    assert.match(dialog, /https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases/);
    assert.match(dialog, /flattenApiDetail\(payload\?\.detail \?\? payload\?\.error\)/);
});

test('the tab strip is a real tablist and caps how many studios it mounts', () => {
    const tabs = read('src/app/StudioTabs.jsx');
    assert.match(tabs, /role="tab"/);
    assert.match(tabs, /aria-selected=\{on\}/);
    assert.match(tabs, /ArrowLeft|ArrowRight/);
    assert.match(tabs, /scrollIntoView\(\{ inline: 'nearest', block: 'nearest' \}\)/);
    assert.match(tabs, /state\.tabs\.length >= MAX_TABS/);
    assert.match(tabs, /cancelLabel=\{TEXT\.cancel\(\)\}/);
});

test('the Agents & API page is truthful about reach and the gate, and a failed copy says so', () => {
    const page = read('src/studios/McpCliStudio.jsx');
    assert.match(page, /Agents & API/);
    assert.match(page, /this machine only — the MCP server listens on 127\.0\.0\.1/);
    assert.doesNotMatch(page, /available without a session on/);
    assert.doesNotMatch(page, /packages\/media-gateway\/bin/);
    assert.match(page, /Copy failed — select the text/);
    assert.match(page, /<IconButton[\s\S]*icon=\{copied \? 'check' : 'copy'\}/);
});

test('the restore drop zone only lights up for image/video drags and has no dead URL tier', () => {
    const zone = read('src/app/OutputRestoreDropZone.jsx');
    assert.doesNotMatch(zone, /text\/uri-list/);
    assert.match(zone, /\/\^\(image\|video\)\\\/\/i\.test\(item\.type\)/);
    assert.match(zone, /Drop an image or video from this studio to restore its settings/);
});

test('the UGC chip wears the persona glyph, not a second camera beside the Camera chip', () => {
    assert.match(read('src/studios/UgcMenu.jsx'), /<ChipButton\s+(?:\/\/[^\n]*\n\s*)*icon="persona"/);
});

test('the dead preference copies are gone and MetaRow lives in one place', () => {
    for (const relative of ['src/studios/cinemaPrefs.js', 'src/studios/cinema/cinemaPrefs.js', 'src/studios/lipSyncPrefs.js', 'src/studios/lipsync/lipsyncPrefs.js']) {
        assert.equal(fs.existsSync(path.join(__dirname, '..', relative)), false, `${relative} should be deleted`);
    }
    assert.match(read('src/studios/CinemaStudio.jsx'), /import \{ MetaRow \} from '\.\/lipsync\/MetaRow\.jsx';/);
    assert.match(read('src/studios/LipSyncStudio.jsx'), /import \{ MetaRow \} from '\.\/lipsync\/MetaRow\.jsx';/);
    assert.doesNotMatch(read('src/studios/CinemaStudio.jsx'), /function MetaRow/);
    assert.doesNotMatch(read('src/studios/LipSyncStudio.jsx'), /function MetaRow/);
});
