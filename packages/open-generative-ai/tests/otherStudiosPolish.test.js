const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Source-shape pins for the Lip sync / shared-dialog fixes. These are
// JSX files node:test cannot import, so the wiring is asserted on the source;
// the behaviour itself was driven in the browser.
const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('Lip sync routes history through the studio helpers, never raw localStorage', () => {
    for (const [relative, key] of [['src/studios/LipSyncStudio.jsx', 'lipsync_history']]) {
        const source = read(relative);
        assert.match(source, /import \{ loadStudioGenerationHistory, saveStudioGenerationHistory \} from '\.\.\/lib\/hivemindStudio\.js';/, `${relative} imports the helpers`);
        assert.match(source, new RegExp(`loadStudioGenerationHistory\\(${key.toUpperCase().replace('_', '_')}_KEY\\)|loadStudioGenerationHistory\\('${key}'\\)`), `${relative} reads through the helper`);
        assert.match(source, /saveStudioGenerationHistory\(/, `${relative} writes through the helper`);
        // The only localStorage use left is the preferences normalizer — never the history.
        const rawHistoryWrites = source.match(/localStorage\.setItem\([^)]*HISTORY/g) || [];
        assert.deepEqual(rawHistoryWrites, [], `${relative} must not write history to localStorage itself`);
        assert.doesNotMatch(source, /localStorage\.getItem\(LIPSYNC_HISTORY_KEY\)/);
        // The storage key names are unchanged so the scrub helper can target them.
        assert.match(source, new RegExp(`'${key}'`));
    }
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
    const picker = read('src/components/ModelSourcePicker.jsx');
    assert.match(dialog, /Checking this machine's RAM and models…/);
    // The rows themselves moved to the shared picker when the prompt helper
    // stopped being local-only, but the rule did not: a row carries a control
    // of its own, so it cannot be a <button>.
    assert.match(picker, /role="radio"/);
    assert.doesNotMatch(picker, /role="button"/, 'no control nested in a button');
    assert.match(dialog, /label=\{model\.provider === 'mtplx' \? 'Stop the local helper' : `Unload \$\{model\.name\}`\}/);
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
    assert.match(read('src/studios/LipSyncStudio.jsx'), /import \{ MetaRow \} from '\.\/lipsync\/MetaRow\.jsx';/);
    assert.doesNotMatch(read('src/studios/LipSyncStudio.jsx'), /function MetaRow/);
});

test('the prompt helper offers Refine with tucked-away controls, not a revision box', () => {
    const dialog = read('src/dialogs/PromptHelperDialog.jsx');
    // The Refine action and its knobs.
    assert.match(dialog, />\s*Refine\s*</);
    assert.match(dialog, /Refinement controls/);
    assert.match(dialog, /'single', label: 'Single still'/);
    assert.match(dialog, /'more', label: 'Add shots'/);
    assert.match(dialog, /focus more on…, add…, remove…, make … more subtle/);
    // The wire shape the backend validates (prompt_profiles.normalize_refine).
    assert.match(dialog, /refine: refine \|\| undefined/);
    assert.match(dialog, /detail: refineDetail/);
    // The old model-mediated revision box is gone; the notes field replaced it.
    assert.doesNotMatch(dialog, /Apply change/);
    assert.doesNotMatch(dialog, /revision: revise/);
    // The model picker is a one-line disclosure, closed once a model is settled.
    assert.match(dialog, /setPickerOpen/);
    // Image mode never sends shot knobs.
    assert.match(dialog, /mediaType === 'video' \? refineShots : 'keep'/);
});

test('every hub page hides itself when another one is open, and scrolls when it is', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '../src/hub/views');
    const views = fs.readdirSync(dir).filter((f) => f.endsWith('View.jsx'));
    assert.ok(views.length >= 8, 'expected the hub to still have its pages');

    for (const file of views) {
        const src = fs.readFileSync(path.join(dir, file), 'utf8');
        // CanvasView is one line that hands the whole page to ToolSurface, which
        // owns both rules for it.
        if (/ToolSurface/.test(src) && src.length < 800) continue;

        // Hub pages stay MOUNTED and are display-toggled, so a page that does
        // not hide itself is painted on top of whichever one is actually open.
        // PassBook shipped without the `active` prop at all and covered
        // Machines, Providers and History (2026-08-26).
        assert.match(
            src,
            /active \? 'flex min-h-0 flex-1 flex-col' : 'hidden'/,
            `${file} must hide itself and size itself like every other hub page`,
        );
        // And the page has to scroll INSIDE itself: `min-h-0 flex-1` with no
        // scroll container anywhere below makes everything past the fold
        // unreachable, which is the same page's second bug the same day.
        // ModelsView delegates that to whichever tab body it renders.
        const delegates = /RunnableModels|InstalledAssets|CivitaiBrowser/.test(src);
        assert.ok(
            /overflow-y-auto/.test(src) || delegates,
            `${file} has no scroll container and does not delegate to one`,
        );
    }
});
