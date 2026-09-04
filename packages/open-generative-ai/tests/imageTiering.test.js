// The Image panel and composer, re-tiered.
//
// The panel used to be split by where a value was SENT (local payload vs cloud
// request), which buried Style, "how many" and LoRAs under a disclosure called
// Advanced while leaving Warm/Unload, the app-wide chime and a per-card rental
// registry control in the same panel. The composer carried nine chips, three of
// which all meant "improve my prompt".
//
// These are source-shape guarantees — the same kind the rest of this suite
// makes — plus one behavioural check: a picked photo becomes a data: URL, so
// the bytes reach MUAPI only after the Generate-time confirm.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));

const PANEL = 'src/studios/image/ImageSettingsPanel.jsx';
const COMPOSER = 'src/studios/image/ImageComposer.jsx';
const STUDIO_PANELS = [
    PANEL,
    COMPOSER,
    'src/studios/ImageStudio.jsx',
    'src/studios/VideoStudio.jsx',
];

/* ---------------- housekeeping is out of the studios ---------------- */

test('no Warm, Unload or completion-chime control is left in a studio panel', () => {
    for (const file of STUDIO_PANELS) {
        const source = read(file);
        assert.doesNotMatch(source, /warmIdeogram4|unloadIdeogram4/, `${file} still warms/unloads a model`);
        assert.doesNotMatch(source, /Warm model|Unload<\/Button>/, `${file} still draws a Warm/Unload button`);
        // The chime is one app-wide value: a studio may PLAY it, never own a toggle.
        assert.doesNotMatch(source, /setCompletionPingEnabled|subscribeCompletionPing/, `${file} still owns the chime`);
        assert.doesNotMatch(source, /checked=\{s\.pingWhenComplete\}/, `${file} still renders the chime toggle`);
    }
    // Warm / free memory is machine housekeeping and lives on the Models page.
    const models = read('src/hub/views/models/RunnableModels.jsx');
    assert.match(models, /localAI\.warmIdeogram4\(\)/);
    assert.match(models, /localAI\.unloadIdeogram4\(\)/);
    // …and the one toggle every studio can render sits beside Generate.
    const toggle = read('src/ui/CompletionPingToggle.jsx');
    assert.match(toggle, /subscribeCompletionPing/);
    assert.match(read(COMPOSER), /<CompletionPingToggle \/>/);
    assert.match(read('src/studios/VideoStudio.jsx'), /<CompletionPingToggle \/>/);
});

test('nothing gates a control on a ?dev=1 URL any more', () => {
    assert.equal(exists('src/lib/devMode.js'), false, 'lib/devMode.js is gone');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
    });
    const offenders = walk(path.join(root, 'src'))
        .filter((file) => /\.jsx?$/.test(file))
        .filter((file) => /devMode|isDevMode/.test(fs.readFileSync(file, 'utf8')))
        // The comment that records why the flag is gone is allowed to name it.
        .filter((file) => !/LoraRentalControl\.jsx$/.test(file));
    assert.deepEqual(offenders, [], 'a dev-mode gate came back');
    // The rental affordance is gated on relevance instead: the registry answered.
    const section = read('src/studios/image/LoraSection.jsx');
    assert.match(section, /const canManageRentals = rentalRegistry\.status === 'ready'/);
    assert.match(read('src/studios/image/LoraRentalControl.jsx'), /canManage/);
});

/* ---------------- the panel's tiers ---------------- */

test('the default panel is Model, Aspect, Style, How many and LoRAs — the rest is behind two disclosures', () => {
    const panel = read(PANEL);
    const basic = panel.slice(0, panel.indexOf('<CollapsibleSection'));
    // One control names the place AND the model: the segmented Local / API /
    // Rented triad and the model menu beside it asked the same question twice.
    assert.match(basic, /<RunOnPicker/, 'Runs on — place and model — is always visible');
    assert.doesNotMatch(panel, /<Segmented[\s\S]{0,120}image\.local/, 'the source triad is gone');
    assert.match(basic, /<AspectRatioPicker/, 'Aspect is always visible');
    assert.match(basic, /\{t\('image\.stylePreset'\)\}/, 'Style is always visible');
    assert.match(basic, /label="How many"/, 'the batch count is always visible');
    assert.match(basic, /<LoraSection \{\.\.\.loraProps\} \/>/, 'the adapters are always visible');

    // Exactly two disclosures, and each names what is armed inside it.
    const sections = panel.match(/<CollapsibleSection[\s\S]{0,220}?>/g) || [];
    assert.equal(sections.length, 2, 'one Advanced, one Modes — no third disclosure');
    assert.match(sections[0], /title=\{t\('common\.advanced'\)\} hint=\{advancedHint\}/);
    assert.match(sections[1], /title="Modes" hint=\{modesHint\}/);
    // Tuning lives in Advanced; the modes that change what the composer MEANS
    // live in Modes.
    const advanced = panel.slice(panel.indexOf('<CollapsibleSection'), panel.indexOf('title="Modes"'));
    for (const control of [/t\('image\.steps'\)/, /t\('image\.guidanceScale'\)/, /t\('image\.seed'\)/, /label="Sampler"/, /label="Scheduler"/, /t\('image\.negPromptLabel'\)/, /LOCAL_BASE_SIZES/, /t\('image\.width'\)/]) {
        assert.match(advanced, control, `Advanced is missing ${control}`);
    }
    const modes = panel.slice(panel.indexOf('title="Modes"'));
    for (const control of [/Region boxes/, /Couple mode/, /Character sheet/, /Strength Hunt/]) {
        assert.match(modes, control, `Modes is missing ${control}`);
    }
    // Both hints read the live state rather than a stored flag.
    assert.match(panel, /const advancedHint = \[/);
    assert.match(panel, /const modesHint = \[/);
    assert.match(panel, /huntArmedCount \? `hunt ×\$\{huntArmedCount\}` : ''/);
});

test('the Krea-2 timing sentence is replaced by the measured ETA', () => {
    const panel = read(PANEL);
    assert.doesNotMatch(panel, /Krea 2 @ 8 steps/);
    assert.match(panel, /about \$\{etaLabel\} at these settings/);
    // The ETA comes from the same store the progress bar reads.
    const studio = read('src/studios/ImageStudio.jsx');
    assert.match(studio, /const etaLabel = \(\) => \{|const etaLabel = \(\(\) => \{/);
    assert.match(studio, /estimateGenerationSeconds\(\s*profile\.key,\s*profile\.work,/);
});

/* ---------------- the composer's five chips ---------------- */

test('the composer is five chips and one door for improving a prompt', () => {
    const composer = read(COMPOSER);
    const row = composer.slice(composer.indexOf('<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">'));
    // Attach, Starters, Improve, Start fresh, Model.
    assert.match(row, /<UploadPicker/);
    assert.match(row, /label=\{t\('composer\.attach'\)\}/);
    // Starters is loaded on press (its shipped prompt library is the heaviest
    // thing on this page), so the row holds the lazy component plus the chip
    // that stands in for it while the chunk arrives — both named by the same
    // descriptor, so the two can never drift apart.
    assert.match(row, /<SavedPromptsMenuLazy/);
    assert.match(row, /chip=\{startersChip\}/);
    assert.match(row, /\{\.\.\.startersChip\}/);
    assert.match(composer, /label: t\('composer\.starters'\)/);
    assert.match(row, /label=\{t\('composer\.improve'\)\}/);
    assert.match(row, /label=\{t\('common\.startFresh'\)\}/);
    assert.match(row, /<RunOnPicker/);
    // The three separate "make my prompt better" doors are one menu now.
    assert.doesNotMatch(row, /<UgcMenu/);
    assert.doesNotMatch(row, /<ReferenceRolesMenu[\s\S]{0,80}\/>\s*<Menu/);
    assert.match(composer, /Refine with the prompt helper/);
    assert.match(composer, /Add style tags/);
    // Quick starters and UGC are sections of the Starters menu.
    assert.match(composer, /extraSections=\{\(close\) => \(/);
    assert.match(composer, /\{t\('image\.quickStarters'\)\}/);
    assert.match(composer, /<MenuHeading>UGC first frame<\/MenuHeading>/);
    // The enhancer's copy-to-clipboard flow is gone: "Use in generator" is the
    // only action, because the box is right there.
    assert.doesNotMatch(composer, /navigator\.clipboard\.writeText/);
    assert.doesNotMatch(composer, /enhanceCopied/);
    assert.match(composer, /\{t\('common\.useInGenerator'\)\}/);
});

test('a freshly picked photo never leaves the machine before Generate is confirmed', () => {
    const studio = read('src/studios/ImageStudio.jsx');
    // Both attach paths — the picker and the composer drop — read the file
    // locally. The old code sent it to MUAPI's CDN on the cloud source.
    assert.match(studio, /uploadFn=\{fileToDataUrl\}/);
    assert.match(studio, /upload: referenceUploader\(fileToDataUrl\),/);
    assert.doesNotMatch(studio, /muapi\.uploadFile/);
    // The Generate-time path that DOES upload is still the guarded one.
    assert.match(studio, /referencesNeedingApproval/);
    assert.match(studio, /resolveCloudReferences/);
    // fileToDataUrl really is a local read.
    const fn = studio.match(/function fileToDataUrl\(file\) \{[\s\S]*?\n\}/)[0];
    assert.match(fn, /new FileReader\(\)/);
    assert.match(fn, /readAsDataURL\(file\)/);
    assert.doesNotMatch(fn, /fetch\(/);
});

/* ---------------- preferences keep loading ---------------- */

test('the normalizer still loads a preferences blob written before this change', async () => {
    const { normalizeImagePreferences } = await import('../src/studios/image/imagePrefs.js');
    const old = normalizeImagePreferences({
        modelId: 'flux',
        useLocalModel: true,
        localModelId: 'krea2-turbo',
        // Dead since nothing read it; an old blob still carries it.
        referenceStrength: 73,
        style: 'Cinematic',
        batchCount: 3,
        steps: 8,
        seed: 12,
    });
    assert.equal(old.modelId, 'flux');
    assert.equal(old.localModelId, 'krea2-turbo');
    assert.equal(old.style, 'Cinematic');
    assert.equal(old.batchCount, 3);
    assert.equal(old.steps, 8);
    assert.equal(old.seed, 12);
    assert.ok(!('referenceStrength' in old), 'the dead field is dropped, not carried forward');
    // …and a blob with nothing in it still produces a usable setup.
    const empty = normalizeImagePreferences({});
    assert.equal(empty, null, 'an empty object has no model, so there is nothing to restore');
    const { IMAGE_TAB_FIELDS } = await import('../src/lib/studioTabs.js');
    assert.ok(!IMAGE_TAB_FIELDS.includes('referenceStrength'));
});
