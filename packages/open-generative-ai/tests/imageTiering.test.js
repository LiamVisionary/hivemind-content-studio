// The Image drawer and composer, re-tiered.
//
// The panel used to be split by where a value was SENT (local payload vs cloud
// request), which buried Style, "how many" and LoRAs under a disclosure called
// Advanced while leaving Warm/Unload, the app-wide chime and a per-card rental
// registry control in the same panel. The composer carried nine chips, three of
// which all meant "improve my prompt".
//
// 2026-09-10 — the route's presentation was replaced whole. The 320px settings
// column is now the frame's Advanced DRAWER, which is not in the tree at all
// until it is asked for; its two shut CollapsibleSections flattened into plain
// DrawerSections (RUNS ON · OUTPUT · LOOK · CONTROL · SAMPLING · MEMORY ·
// AVOID), because the drawer itself is the disclosure. The chip toolbar became
// one sentence — Make [1 image] at [1:1] in [photoreal] with [2 references] on
// [this Mac · Z-Image] . Advanced → — plus round icon doors on the action row.
// Every assertion below moved with them; none was relaxed on the way.
//
// What a person SEES — what the studio opens on, what the drawer holds once it
// is open, which doors the composer carries — is rendered. What is left textual
// is either a shape the render cannot reach (a control that only paints for a
// local model, on a machine with weights; a menu whose children do not exist
// until it is pressed) or a promise that something stays deleted; each of those
// carries its reason above it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderStudio, textOf } = require('./helpers/render.js');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));

// The Image studio, mounted (renderStudio loads the catalog first, the way
// App.jsx does before the studio chunk). `props` is how a test mounts the
// studio in a state a press would have produced — effects never run under a
// static render, so an interaction is asserted by rendering its outcome.
const renderImageMarkup = (props = {}) => renderStudio('src/studios/ImageStudio.jsx', 'ImageStudio', { active: true, ...props });
const renderImageStudio = async (props) => textOf(await renderImageMarkup(props));

// An attribute value, as a pattern that matches the same value in the markup:
// React escapes `&` on the way out, and textOf unescapes it on the way back.
const attrPattern = (value) => value.replace(/&/g, '&amp;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PANEL = 'src/studios/image/ImageSettingsPanel.jsx';
const COMPOSER = 'src/studios/image/ImageComposer.jsx';
// The Video route's composer moved out of VideoStudio.jsx the same way this one
// moved out of ImageStudio.jsx, so the chime toggle is asserted where each
// studio's composer now lives.
const VIDEO_COMPOSER = 'src/studios/video/VideoComposerBar.jsx';
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
    // …and the one toggle every studio can render sits beside Generate — in
    // both composers, which are their own modules now (the frame's action row
    // carries it in the `more` menu, where its outcome is felt).
    const toggle = read('src/ui/CompletionPingToggle.jsx');
    assert.match(toggle, /subscribeCompletionPing/);
    assert.match(read(COMPOSER), /<CompletionPingToggle \/>/);
    assert.match(read(VIDEO_COMPOSER), /<CompletionPingToggle \/>/);
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

/* ---------------- the tiers, after the frame ---------------- */

// Progressive disclosure, re-pinned. The panel used to tier its controls three
// deep — basics, a shut "Advanced", a shut "Modes" — and this pair asserted the
// two doors: shut, nothing behind them paints; open, it does. The frame keeps
// that promise and makes it harder to satisfy — the settings column is gone
// entirely, and the drawer holding every tuning control is not in the tree at
// all until it is asked for — so the pair now reads the frame instead.
//
// Rendered, because a source position proves nothing about what paints: this
// replaced a grep that asserted "How many" and LoRAs were above the first
// <CollapsibleSection> — both true of the file, and neither on screen, because
// they belong to a local model and the studio opens on a cloud one.
test('the studio opens on the recipe sentence, with every tuning control behind Advanced', async () => {
    const markup = await renderImageMarkup();
    const shown = textOf(markup);
    // The whole of the settings UI a person meets on arrival: five values,
    // written as a sentence, with the door to the rest at the end of it.
    const sentence = shown.slice(shown.indexOf('Make '));
    assert.match(sentence, /^Make .+ at .+ in .+ with .+ on .+ \. Advanced/, 'the recipe sentence is the composer\'s settings row');
    assert.match(sentence, /\bno style\b/, 'the style token reads its own default rather than a placeholder');
    assert.match(sentence, /\bno references\b/, 'and so does the reference count');
    // Where it runs is a CONTROL in the sentence, not a readout beside one:
    // this is the old panel's always-visible "Runs on" block, moved into words.
    const runOn = /\bon (.+?) \. Advanced/.exec(sentence);
    assert.ok(runOn && runOn[1].trim(), 'the sentence names where it runs');
    assert.match(
        markup,
        new RegExp(`<button[^>]*aria-label="${attrPattern(runOn[1].trim())}"`),
        'where it runs opens a menu — it is not a label',
    );
    // Advanced is SHUT, which now means the drawer does not exist: no dialog
    // over the stage, and the door says so to a screen reader.
    assert.doesNotMatch(markup, /role="dialog"/, 'nothing is open over the stage on arrival');
    assert.match(markup, /<button[^>]*aria-expanded="false"[^>]*>Advanced</, 'the Advanced door reports itself shut');
    // Each of these paints unconditionally ONCE the drawer opens (the test
    // below proves it), so their absence here is the disclosure working.
    for (const inside of ['Runs on', 'Seed', 'Region boxes']) {
        assert.doesNotMatch(shown, new RegExp(inside), `${inside} lives in the drawer and must not paint before it is opened`);
    }
});

test('opening Advanced paints what it holds', async () => {
    // `advancedOpen` is view state on the studio's engine and effects never run
    // under a static render, so the studio is mounted holding the engine an
    // Advanced press would have left behind. `seed` is the studio's own door
    // onto that: it is how StudioTabs hands a duplicated tab its start.
    const markup = await renderImageMarkup({ seed: { boot: 'clone', snapshot: { advancedOpen: true } } });
    assert.match(markup, /role="dialog" aria-label="Advanced"/, 'the drawer is a dialog with a name');
    // Read the DRAWER, not the page: everything below has to be inside it, not
    // merely somewhere on screen.
    const shown = textOf(markup.slice(markup.indexOf('role="dialog"')));
    // The sections that do not depend on a local model, in the order the drawer
    // declares them — the complete surface, and one flat list of it.
    let at = -1;
    for (const heading of ['Runs on', 'Output', 'Look', 'Control', 'Sampling']) {
        const next = shown.indexOf(heading, at + 1);
        assert.ok(next > at, `${heading} is missing from the drawer, or out of order`);
        at = next;
    }
    // The two controls the shut state promised were behind this door.
    assert.match(shown, /Seed/, 'Advanced holds the seed');
    assert.match(shown, /Region boxes/, 'and the region boxes');
    // A recipe token is only ever a shortcut: the aspect the sentence names is
    // also the full picker in here, so the drawer stays the complete surface.
    assert.match(shown, /Aspect ratio/, 'the drawer keeps the control the sentence shortcuts');
});

// Deliberately textual. Steps, Guidance, Sampler, Scheduler, the negative
// prompt, "How many", the adapters and the width/height pair only paint for a
// LOCAL model — a machine with weights on disk — so which section declares them
// is a source fact a render on a bare machine cannot reach. The same for the
// promise that nothing inside the drawer is collapsed, and for the hints, which
// are about the file's shape.
//
// The two disclosures this used to count are gone: the drawer IS the
// disclosure, so what is asserted now is that the tiers survived the flatten —
// tuning in SAMPLING, the modes that change what the prompt MEANS in CONTROL —
// and that no second door grew back inside it.
test('tuning is declared in SAMPLING, the meaning-changing modes in CONTROL, and nothing inside the drawer is collapsed', () => {
    const panel = read(PANEL);
    // One control names the place AND the model: the segmented Local / API /
    // Rented triad and the model menu beside it asked the same question twice.
    assert.doesNotMatch(panel, /<Segmented[\s\S]{0,120}image\.local/, 'the source triad is gone');
    // A control behind two doors is a control nobody finds. The drawer is the
    // one door; there is nothing collapsed inside it.
    assert.doesNotMatch(panel, /<CollapsibleSection/, 'no disclosure inside the disclosure');

    // The sections, in the order they are declared. RUNS ON heads the drawer
    // because it is the question every other section's answer depends on.
    const heading = panel.indexOf("<DrawerHeading>{t('runOn.label')}</DrawerHeading>");
    assert.ok(heading > 0, 'RUNS ON is the drawer\'s first heading');
    const declared = (label) => {
        const open = panel.indexOf(`<DrawerSection label={${label}}`);
        assert.ok(open > 0, `${label} is not a section of the drawer`);
        const next = panel.indexOf('<DrawerSection', open + 1);
        return { open, source: panel.slice(open, next === -1 ? panel.length : next) };
    };
    const order = ["t('restorePanel.output')", "t('imagePanel.look')", "t('imagePanel.control')", "t('imagePanel.sampling')", "t('imagePanel.memory')", "t('imagePanel.avoid')"];
    const sections = order.map(declared);
    sections.reduce((previous, section, index) => {
        assert.ok(section.open > previous, `${order[index]} is out of order`);
        return section.open;
    }, heading);

    const [output, look, control, sampling, , avoid] = sections.map((section) => section.source);
    // OUTPUT — shape and size. Every one of these used to be split across the
    // basics and the Advanced disclosure.
    for (const shape of [/<AspectRatioPicker/, /t\('image\.width'\)/, /LOCAL_BASE_SIZES/, /label=\{t\('imagePanel\.howMany'\)\}/]) {
        assert.match(output, shape, `OUTPUT is missing ${shape}`);
    }
    // LOOK — the style presets, then the adapters, whole.
    assert.match(look, /aria-label=\{t\('image\.stylePreset'\)\}/, 'LOOK is missing the style presets');
    assert.match(look, /<LoraSection \{\.\.\.loraProps\} \/>/, 'LOOK is missing the adapters');
    // CONTROL — everything that changes what the prompt MEANS.
    for (const mode of [/imagePanel\.regionBoxes/, /imagePanel\.coupleMode/, /imagePanel\.characterSheet/, /imagePanel\.strengthHunt/]) {
        assert.match(control, mode, `CONTROL is missing ${mode}`);
    }
    // SAMPLING — the dials, and only the dials.
    for (const dial of [/t\('image\.steps'\)/, /t\('image\.guidanceScale'\)/, /t\('image\.seed'\)/, /t\('imagePanel\.sampler'\)/, /t\('imagePanel\.scheduler'\)/]) {
        assert.match(sampling, dial, `SAMPLING is missing ${dial}`);
    }
    assert.match(avoid, /t\('image\.negPromptLabel'\)/, 'AVOID is missing the negative prompt');
    // …and the tiers did not smear into each other on the way.
    assert.doesNotMatch(output, /t\('image\.seed'\)/, 'a dial leaked into OUTPUT');
    assert.doesNotMatch(control, /t\('image\.steps'\)/, 'a dial leaked into CONTROL');
    assert.doesNotMatch(sampling, /imagePanel\.regionBoxes/, 'a mode leaked into SAMPLING');

    // The hints still read live state rather than a stored flag — they simply
    // ride on the section that owns the control each one names now.
    assert.match(panel, /const outputHint = customDimsActive \?/);
    assert.match(panel, /const samplingHint = \[/);
    assert.match(panel, /const controlHint = \[/);
    assert.match(panel, /huntArmedCount \? `hunt ×\$\{huntArmedCount\}` : ''/);
    assert.match(output, /hint=\{outputHint\}/);
    assert.match(control, /hint=\{controlHint\}/);
    assert.match(sampling, /hint=\{samplingHint\}/);
});

test('the Krea-2 timing sentence is replaced by the measured ETA', async () => {
    const panel = read(PANEL);
    assert.doesNotMatch(panel, /Krea 2 @ 8 steps/);
    // The sentence is the table's now; the panel has to ASK for it, and the
    // table has to still say it.
    assert.match(panel, /tf\('imagePanel\.aboutAtTheseSettings', etaLabel\)/);
    const { STRINGS } = await import('../src/lib/i18n.js');
    assert.equal(STRINGS['imagePanel.aboutAtTheseSettings']('12s'), ' — about 12s at these settings');
    // The ETA comes from the same store the progress bar reads.
    const studio = read('src/studios/ImageStudio.jsx');
    assert.match(studio, /const etaLabel = \(\) => \{|const etaLabel = \(\(\) => \{/);
    assert.match(studio, /estimateGenerationSeconds\(\s*profile\.key,\s*profile\.work,/);
});

/* ---------------- the composer's sentence and its doors ---------------- */

test('the composer renders its sentence, its doors and one way to improve a prompt', async () => {
    // The action row, as a person meets it. The grep this replaced sliced the
    // source at a className and asserted on the slice — it stayed green through
    // a chip that rendered under a condition nobody could satisfy.
    //
    // Scoped to the composer: the drawer is shut, so everything from the panel's
    // wire attribute to the end of the markup is the floating composer.
    const markup = await renderImageMarkup();
    const composer = markup.slice(markup.indexOf('data-studio-composer'));
    assert.ok(composer.length > 0, 'the composer keeps its drop-zone wire contract');
    const shown = textOf(composer);
    // Attach and Starters carry their names on screen. Improve and More are the
    // design's round icon-only doors, so the aria-label is the ONLY name a
    // screen reader gets — a door without one is a door nobody can announce.
    for (const door of ['Attach', 'Improve', 'More']) {
        const named = (composer.match(new RegExp(`aria-label="${door}"`, 'g')) || []).length;
        assert.equal(named, 1, `the composer should carry exactly one ${door} door`);
    }
    assert.match(shown, /Starters/, 'and the starters shelf');
    // One primary press, and it is pinned in the right-hand group rather than
    // wrapping under the doors — the doors are in a different flex group, so it
    // cannot. (ComposerPanel owns that shape; imageStudioFixes pins it there.)
    assert.equal((composer.match(/bg-honey text-on-honey/g) || []).length, 1, 'exactly one primary press');
    const rightGroup = composer.indexOf('ml-auto flex');
    assert.ok(rightGroup > 0, 'the action row has a right-hand group');
    assert.ok(composer.indexOf('aria-label="Improve"') < rightGroup, 'the doors sit left of it');
    assert.ok(composer.indexOf('bg-honey text-on-honey') > rightGroup, 'and Generate sits inside it');
    assert.match(shown, /Generate/, 'the button the whole page is for');
    // Cancel is not on screen while nothing is running — it appears beside
    // Generate only once a run is out (see imageStudioFixes).
    assert.doesNotMatch(shown, /Cancel/, 'nothing to cancel yet');
});

// Deliberately textual: a shut popover renders no children, so only the source
// can say WHICH menu a door lives in — and the render sees the Starters chip
// whether or not it is the same descriptor as the menu it stands in for.
//
// What is pinned here: the retired doors stay retired, the three "improve my
// prompt" routes are items of ONE menu, and the two chips the design's three
// round doors had no room for were recorded in `more` rather than dropped.
test('the improve-my-prompt doors stayed merged into one menu', () => {
    const composer = read(COMPOSER);
    const tools = composer.slice(composer.indexOf('const tools = ('), composer.indexOf('\n  return ('));
    assert.ok(tools.length > 0, 'the action row still declares its doors');
    // Attach keeps its own trigger rather than riding in a popover: it is more
    // than a door (the attached thumbnails, its own file input, and the
    // data-upload-picker attribute the frame's drop guard checks), and it has
    // to stay MOUNTED for that guard to see it.
    assert.match(tools, /<UploadPicker/);
    assert.match(tools, /label=\{t\('composer\.attach'\)\}/);
    // Starters is loaded on press (its shipped prompt library is the heaviest
    // thing on this page), so the row holds the lazy component plus the chip
    // that stands in for it while the chunk arrives — both named by the same
    // descriptor, so the two can never drift apart.
    assert.match(tools, /<SavedPromptsMenuLazy/);
    assert.match(tools, /chip=\{startersChip\}/);
    assert.match(tools, /\{\.\.\.startersChip\}/);
    assert.match(composer, /label: t\('composer\.starters'\)/);
    // The three separate "make my prompt better" doors are one menu now: one
    // door, and the three routes as items behind it.
    const improve = tools.slice(tools.indexOf('{/* Improve:'), tools.indexOf('{/* Starters:'));
    assert.ok(improve.length > 0, 'the Improve door is still declared');
    assert.match(improve, /label=\{t\('composer\.improve'\)\}/);
    assert.match(improve, /Refine with the prompt helper/);
    assert.match(improve, /helper \? \(/, "and the model's own helper, when it ships one");
    assert.match(improve, /Add style tags/);
    assert.equal((tools.match(/label=\{t\('composer\.improve'\)\}/g) || []).length, 1, 'one improve door, not three');
    assert.doesNotMatch(composer, /<UgcMenu/);
    assert.doesNotMatch(composer, /<ReferenceRolesMenu[\s\S]{0,80}\/>\s*<Menu/);
    // Quick starters and UGC are sections of the Starters menu.
    assert.match(composer, /extraSections=\{\(close\) => \(/);
    assert.match(composer, /\{t\('image\.quickStarters'\)\}/);
    assert.match(composer, /<MenuHeading>UGC first frame<\/MenuHeading>/);
    // Nothing was dropped when eight chips became three round doors: the camera
    // rig, Start fresh and the app-wide chime are items of `more`.
    const more = tools.slice(tools.indexOf('{/* More:'), tools.indexOf("{/* The camera rig's own popover"));
    assert.ok(more.length > 0, 'the more menu is still declared');
    assert.match(more, /\{t\('composer\.camera'\)\}/, 'the camera rig kept a home');
    assert.match(more, /\{t\('common\.startFresh'\)\}/, 'and so did Start fresh');
    assert.match(more, /<CompletionPingToggle \/>/, 'and the chime, which belongs where its outcome is felt');
    // Where it runs moved into the sentence, and took RunOnPicker's contract
    // with it — page / pinned / onPin adjacent and in that order, which
    // rentedMachines.test.js reads off these three lines.
    const recipe = composer.slice(composer.indexOf('const recipeParts = ['), composer.indexOf('const tools = ('));
    assert.match(recipe, /<RunOnPicker/);
    assert.match(recipe, /page="image"\n\s+pinned=\{runOn\.pinned\}\n\s+onPin=\{runOn\.onPin\}/);
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
