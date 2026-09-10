// The Video studio's composer and the stage's action column, pinned by what a
// person can reach and by where the one press sits.
//
// The markup these tests were written against is gone. There is no chip row and
// no result row: VideoStudio.jsx keeps the state and the wiring and draws almost
// none of the route. The composer is video/VideoComposerBar.jsx — a prompt, a
// recipe sentence ("Make a [5s clip] at [16:9] with [cast] on [where] .
// Advanced →"), round icon-only doors, and ONE ComposerPrimary pinned right by
// ComposerPanel's `ml-auto` group. The finished clip is video/VideoStage.jsx and
// its floating action column.
//
// What is pinned here is the contract, not the classes:
//   - every door the thirteen chips opened is still reachable — as a recipe
//     token, a tool door, or one press deeper behind `more`;
//   - exactly ONE filled press is on the frame, it is Generate, and it never
//     drops under the doors;
//   - the empty state still names the next move, in the same words;
//   - the keyboard, the confirm and the failure paths behave as they did.
//
// Rendered wherever a render can answer the question — the doors are icon-only
// now, so their ACCESSIBLE NAMES are what a person actually has, and a render is
// the only honest test of "you can still get there".
//
// Deliberately textual: the rest. A static render reaches neither the inside of
// a closed popover (every `more` item and every recipe token's menu is one),
// nor the CONDITION that gates a control, nor what a handler does once it
// fires — and those are exactly the three things a chip row's disappearance
// could quietly break.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent, renderStudio, textOf } = require('./helpers/render.js');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const COMPOSER = 'src/studios/video/VideoComposerBar.jsx';
const STAGE = 'src/studios/video/VideoStage.jsx';
const STUDIO = 'src/studios/VideoStudio.jsx';

test("the video composer offers every chip's door and one Generate", async () => {
    const markup = await renderStudio(STUDIO, 'VideoStudio');
    const studio = textOf(markup);
    const composer = read(COMPOSER);

    // The chip row's capabilities, one by one, in the place each one moved to.
    // Icon-only doors are found by their accessible name, because that is all a
    // screen reader — or a person hovering — is given.
    //
    // "Add someone" is the cast, which is now a word in the sentence: it reads
    // the cast out and opens the same CastStrip (whose own button still says
    // Add someone) rather than sitting in the row as a chip.
    assert.match(markup, /aria-label="Who is in the shot"/, 'the composer no longer offers the cast');
    assert.match(studio, /nobody yet/, 'the cast token must read out an empty cast, not go blank');
    assert.match(composer, /aria-label="Who is in the shot"[\s\S]{0,600}?<CastStrip/, 'the cast token must open the cast strip');
    assert.match(read('src/studios/video/CastStrip.jsx'), /'Add someone'/, 'and the strip is still where someone is added');

    // The starting frame keeps its own door and its own words.
    assert.match(markup, /aria-label="Start frame"/, 'the start-frame picker is missing');

    // "Prompts" is the same shelf under the name the design draws for it, and
    // Camera is unchanged. Both still carry visible text, so read them as text.
    assert.match(studio, /Starters/, 'the saved-prompts shelf is missing');
    assert.match(studio, /Camera/, 'the camera-motion door is missing');

    // Refine lost its label to the icon; the name survives on the control.
    assert.match(markup, /aria-label="Refine"/, 'the prompt helper door is missing');

    // "Source video" moved one press deeper rather than away: it is in the
    // `more` panel, which a static render cannot open, so the door is asserted
    // rendered and its contents in the source.
    assert.match(markup, /aria-label="More"/, 'the more door is missing');
    const morePanel = composer.slice(composer.indexOf('{/* MORE.'));
    assert.ok(morePanel, 'VideoComposerBar has no more panel');
    assert.match(morePanel, /\{clipChip\}/, 'the source clip is no longer reachable from the composer');

    // One press, and it says Generate.
    assert.match(markup, /<button[^>]*class="[^"]*bg-honey text-on-honey[^"]*">Generate<\/button>/);

    // The empty state names the next move, verbatim — the one line a first-timer
    // reads before anything exists.
    assert.match(studio, /Describe a shot or drop in a starting picture, then press Generate\./);

    // And the studio says WHERE it runs before anything is typed. It used to be
    // a "Runs on" label over a picker; it is now the last clause of the recipe
    // sentence, and that clause is still the picker — a control with a menu and
    // an accessible name, not a printed word.
    const runOn = studio.match(/ on (.+?) \. Advanced/);
    assert.ok(runOn, 'the recipe sentence does not say where the clip will be made');
    assert.match(
        markup,
        new RegExp(`aria-haspopup="menu"[^>]*aria-label="${escapeRe(runOn[1])}"`),
        'the run target is printed but cannot be changed from the composer',
    );
});

test('the tools stay one row and Generate is a pinned sibling', async () => {
    const markup = await renderStudio(STUDIO, 'VideoStudio');

    // ONE primary per view REGION (DESIGN.md). It used to be Generate plus one
    // leading action under the result; the stage's actions are quiet round doors
    // now, so the whole frame holds exactly one filled press.
    const primaries = markup.match(/<button[^>]*class="[^"]*bg-honey text-on-honey/g) || [];
    assert.equal(primaries.length, 1, 'exactly one filled press belongs on the frame');

    // Pinned right and unsqueezable: the press lives in ComposerPanel's `ml-auto`
    // group, and that group is a sibling of the doors inside a plain
    // `flex items-center` row. No flex-wrap anywhere on that row is what stops
    // Generate dropping to a second line, left-aligned, under the doors — the
    // bug the flex-[1_1_280px] chip group used to hold off.
    const group = markup.indexOf('<div class="ml-auto flex min-w-0 items-center gap-[15px]">');
    assert.ok(group > 0, 'the primary group is no longer pinned right with ml-auto');
    assert.match(
        markup.slice(group, group + 800),
        /<button[^>]*class="inline-flex h-10 shrink-0 items-center[^"]*bg-honey text-on-honey/,
        'Generate must sit inside the pinned group, and must not shrink',
    );
    const row = markup.lastIndexOf('<div class="flex items-center gap-2">', group);
    assert.ok(row > 0, 'the action row must be one non-wrapping flex row holding the doors and the pinned group');

    // The all-studio completion chime rides in the composer's `more` panel — one
    // press from Generate, and still NOT in Advanced, which is where nobody
    // looks for a sound setting. It is the shared component subscribing to the
    // app-wide preference; a studio-local copy is what this forbids.
    const composer = read(COMPOSER);
    assert.match(composer, /<CompletionPingToggle \/>/);
    assert.doesNotMatch(read('src/studios/video/VideoAdvanced.jsx'), /CompletionPingToggle/, 'the chime must not be buried in Advanced');
    assert.doesNotMatch(read(STUDIO), /checked=\{s\.pingWhenComplete\}/);

    // The result row is gone, so its "exactly one leading next step" is now
    // "no primary at all out here": save, full-bleed and More, and the next
    // steps are rows in the menu. Rendered with a clip, because that column
    // renders nothing without one.
    const actions = await renderComponent(STAGE, 'VideoStageActions', {
        clipUrl: 'blob:clip',
        canContinue: true,
        onDownload: () => {},
        onContinueScene: () => {},
        onNewPrompt: () => {},
        onPostToCivitai: () => {},
        videoRef: { current: null },
    });
    assert.doesNotMatch(actions, /bg-honey text-on-honey/, 'the clip actions must not add a second filled press');
    assert.match(actions, /aria-label="Download"/);
    assert.match(actions, /aria-label="More actions for this clip"/);

    // Continue scene still leads where the lane can chain and is absent where it
    // cannot — the same condition the old ternary carried, now gating a row.
    const stage = read(STAGE);
    assert.match(stage, /\{canContinue && onContinueScene \? \(\s*<MenuItem\s+icon="arrowRight"[\s\S]{0,400}?Continue scene/);
    assert.match(stage, /\{onNewPrompt \? \(\s*<MenuItem icon="plus"[\s\S]{0,120}?\{copy\.newPrompt\}/);
    // Saving stays a door of its own — now a SPLIT one: the press still saves the
    // clip, and only the arrow beside it opens the ways of taking it elsewhere.
    // Download must never become a row inside the More menu.
    assert.match(stage, /<StageDownloadAction\s+studio="video"/, 'saving the clip stays a door of its own');
    assert.doesNotMatch(
        stage.slice(stage.indexOf('icon="more"')),
        /MenuItem[^>]*icon="download"/,
        'saving must not be buried in the More menu',
    );
    assert.match(stage, /<MenuItem[\s\S]{0,200}?meta="leaves device"[\s\S]{0,300}?Post to Civitai/, 'publishing is under More, and says it leaves the device');
});

test('one trigger primitive, distinct icons, H3-only grammar controls, nothing prompt-writing on a disabled prompt', () => {
    const studio = read(STUDIO);
    const composer = read(COMPOSER);

    // FrameSlotsPicker and ReferencesMenu triggers are ChipButtons.
    assert.match(read('src/studios/video/FrameSlotsPicker.jsx'), /<ChipButton\s+icon="film"/);
    assert.match(read('src/studios/video/ReferencesMenu.jsx'), /<ChipButton\s+icon=\{persona\?\.name \? 'persona' : 'layers'\}/);

    // The clip chip says which of its two meanings it carries, from the request
    // plan: it CHAINS from a clip, or the clip is this run's source video. The
    // plan is still read in the studio; the chip is drawn in the composer (and
    // again in the drawer, which stays the complete surface).
    assert.match(studio, /const clipChipContinues = videoRequestPlan\(s\.setup\)\.task === 'generate'/);
    assert.match(composer, /const clipLabel = clipChipContinues \? 'Continue from clip' : 'Source video';/);
    assert.match(composer, /icon=\{clipChipContinues \? 'film' : 'upload'\}/);
    assert.match(composer, /Continue from a clip/);

    // Distinct icons, so which press does what is readable without opening one:
    // frames is the film strip, references the layers (or the persona), Refine
    // the wand, Starters the folder, Camera the camera, and `more` the dots.
    assert.match(composer, /<ComposerTool\s+icon="wand"\s+label=\{t\('composer\.refine'\)\}/);
    assert.match(composer, /chip=\{\{ icon: 'folder', label: t\('composer\.starters'\), title: t\('composer\.startersTitle'\) \}\}/);
    assert.match(read('src/studios/video/CameraMotionMenu.jsx'), /icon="camera"\s+label=\{t\('composer\.camera'\)\}/);
    assert.match(composer, /<ComposerTool icon="more" label="More"/);
    // Restyle is the other wand. It does NOT collide with Refine because it is
    // no longer in the row at all: it sits one press deeper, inside `more`.
    assert.match(read('src/studios/video/RestyleMenu.jsx'), /icon="wand"/);

    /* The two gates the row is built from. */
    const writingGate = composer.indexOf('{promptWritable ? (');
    const moreDoor = composer.indexOf('{/* MORE.');
    assert.ok(writingGate > 0 && moreDoor > writingGate, 'the composer no longer separates the prompt-writing doors from `more`');
    const writingDoors = composer.slice(writingGate, moreDoor);
    const morePanel = composer.slice(moreDoor);

    // The prompt-writing doors go with a disabled textarea (a watermark remover
    // has no prompt) — the frame and reference controls do not, so they are
    // mounted before the gate.
    assert.match(composer, /const promptWritable = !promptUi\.disabled;/);
    assert.match(writingDoors, /<ComposerTool\s+icon="wand"[\s\S]{0,700}?<SavedPromptsMenu[\s\S]{0,1200}?<CameraMotionMenu/);
    assert.ok(composer.indexOf('<FrameSlotsPicker') < writingGate, 'the frames picker must not go with the prompt');
    assert.ok(composer.indexOf('<ReferencesMenu') < writingGate, 'the references menu must not go with the prompt');

    // UGC, Style, Shots and Check all write H3 grammar, so they are gated
    // together on the studio's isH3() — handed over as `h3`.
    assert.match(studio, /h3=\{isH3\(\)\}/);
    assert.match(morePanel, /\{h3 \? \(\s*<>\s*<RestyleMenu[\s\S]{0,600}?<UgcMenu[\s\S]{0,900}?<ShotBuilderChip/);
    assert.match(composer, /\{promptWritable && h3 \? \(\s*<PromptCheckMenu/);
    assert.doesNotMatch(writingDoors, /<RestyleMenu|<UgcMenu|<ShotBuilderChip/, 'the H3 grammar controls belong behind `more`, not in the row');
});

test('keyboard, confirms, and the stage actions behave', async () => {
    const studio = read(STUDIO);
    const composer = read(COMPOSER);

    // ⌘/Ctrl+Enter generates from the textarea, behind the same guards as the
    // button — deliberately NOT the button's own `disabled` expression. The
    // handler moved to the composer with the textarea; the studio hands it the
    // same generate() and the same rentedBlocked it guarded with before.
    assert.match(composer, /if \(e\.key !== 'Enter' \|\| !\(e\.metaKey \|\| e\.ctrlKey\)\) return;[\s\S]*?if \(rentedBlocked \|\| s\.generating\) return;\s*void onGenerate\(\);/);
    assert.match(studio, /rentedBlocked=\{rentedBlocked\}\s*onGenerate=\{generate\}/);

    // No native confirm anywhere in the studio or the surfaces it draws; the
    // source-clip switch resolves a ConfirmModal.
    for (const file of [studio, composer, read(STAGE)]) assert.doesNotMatch(file, /window\.confirm/);
    assert.match(studio, /confirmLabel="Switch and attach"/);
    assert.match(studio, /if \(cost && !\(await confirmSourceVideoSwitch\(cost\)\)\) return;/);

    // "Back to setup" only clears the canvas.
    const back = studio.match(/const backToSetup = \(\) => \{[\s\S]*?\n {2}\};/)[0];
    assert.doesNotMatch(back, /restoreGenerationContext/);

    // Sequence and history cards: the card IS a button now (the rail's RailCard),
    // so Enter and Space come from the platform instead of a hand-rolled key
    // handler, and every card carries an accessible name. Its actions door stays
    // mounted and shows on focus as well as hover, which is what made the old
    // hover overlay reachable without a mouse.
    const rail = await renderComponent('src/studios/video/VideoRail.jsx', 'VideoRail', {
        segments: [{ id: 'seg-1', url: 'blob:shot' }],
        history: [{ url: 'blob:clip', model: 'a-model' }],
        secondsFor: () => 5,
        promptFor: () => 'a shot',
    });
    assert.match(rail, /<button[^>]*aria-label="Shot 1 — a shot"/, 'a sequence card must be a real button with a name');
    assert.match(rail, /<button[^>]*aria-label="Clip actions — [^"]*"/, 'a loose clip must keep its actions door');
    assert.match(rail, /group-focus-within:opacity-100 group-hover:opacity-100/);
    assert.match(read('src/studios/video/TimelineStrip.jsx'), /group-focus-within:opacity-100 group-hover:opacity-100/);
    assert.match(read('src/studios/video/TimelineStrip.jsx'), /if \(event\.key !== 'Enter' && event\.key !== ' '\) return;/);

    // Cards draw a poster <img>, not a <video> per entry — the reason the strip
    // stopped decoding a dozen clips at once.
    assert.doesNotMatch(rail, /<video/, 'the rail must not mount a player per card');
    assert.match(read('src/studios/video/VideoRail.jsx'), /useMediaPoster\(url, \{ kind: 'video' \}\)/);
    assert.match(read('src/studios/video/TimelineStrip.jsx'), /useMediaPoster\(url, \{ kind: 'video' \}\)/);

    // The failure callout offers Try again and says it once (no duplicate toast) —
    // and, since the failure is read through describeFailure, the repair it named.
    // It rides StudioFrame's `notices` slot, still owned by the studio.
    assert.match(studio, /s\.generateError = failure\.title \|\| 'Generation failed';/);
    assert.match(studio, /<FailureCallout/);
    assert.match(studio, /remedy=\{s\.generateFailure\?\.remedy \|\| null\}/);
    assert.doesNotMatch(studio, /toast\.error\(e\.message\)/);
    // The "still stopping" notice has a lifetime.
    assert.doesNotMatch(studio, /toast\.loading\('Stopping/);

    // The joined tile: static honey border, animated only while building, no cyan/violet.
    const css = read('src/style.css');
    assert.doesNotMatch(css, /#7dd3fc|#c084fc|#f472b6/);
    assert.match(css, /\.chain-combined-tile--building \{[\s\S]*?animation: chain-cut-spin/);
    assert.doesNotMatch(css.match(/\.chain-combined-tile \{[\s\S]*?\n\}/)[0], /animation/);
});

/* ---------------- clearing: the small door and the big one ---------------- */

// Two presses that were one. The badge in the prompt box empties the box; Start
// fresh empties the composer and asks first. They were the same menu row, and
// the row sat among the settings, so it got pressed for the small job.
test('Start fresh is the last row of `more`, under a rule of its own', () => {
    const composer = read(COMPOSER);
    const morePanel = composer.slice(composer.indexOf('{/* MORE.'));
    const fresh = morePanel.indexOf("{t('common.startFresh')}");
    assert.ok(fresh > 0, 'Start fresh is no longer in the more panel');
    assert.ok(morePanel.indexOf('<CompletionPingToggle />') < fresh,
        'Start fresh must sit BELOW the settings, not between them');
    // A rule between the settings and the act, and nothing after it.
    assert.match(morePanel.slice(0, fresh), /<div className="my-0\.5 h-px bg-line1" \/>\s*<MenuItem icon="x"/);
    assert.doesNotMatch(morePanel.slice(fresh), /<MenuItem|CompletionPingToggle/, 'nothing follows the act');
});

test('the video prompt box carries a clear badge, and Start fresh asks first', () => {
    const composer = read(COMPOSER);
    const studio = read(STUDIO);

    // The box's own badge, wired to the studio's one-field handler.
    assert.match(composer, /<ComposerPrompt[\s\S]*?onClear=\{onClearPrompt\}/);
    assert.match(studio, /onClearPrompt=\{clearPromptOnly\}/);
    const clear = studio.match(/const clearPromptOnly = \(\) => \{[\s\S]*?\n  \};/)[0];
    assert.match(clear, /setPrompt\(''\)/);
    assert.match(clear, /announceWeave\('Cleared the prompt', before\)/, 'and it is offered back');
    assert.doesNotMatch(clear, /newPromptTransition|s\.cast = \[\]|startFreshConfirm/,
        'the frames, the cast and the clip are not its business');

    // The big one goes through the question, from BOTH its doors — the composer
    // menu and the finished clip's action column.
    assert.doesNotMatch(studio, /onNewPrompt=\{newPrompt\}/, 'the raw handler is never wired to a press');
    assert.equal((studio.match(/onNewPrompt=\{requestNewPrompt\}/g) || []).length, 2,
        'both the composer and the stage ask before they clear');
    const request = studio.match(/const requestNewPrompt = \(\) => \{[\s\S]*?\n  \};/)[0];
    assert.match(request, /if \(!startFreshSummary\(s\.setup\)\.length\) \{ newPrompt\(\); return; \}/,
        'nothing to lose means nothing to ask');

    // And the dialog reads the list off the same setup the transition clears,
    // rather than a hand-typed copy that can drift from it.
    const dialog = studio.slice(studio.indexOf('open={s.startFreshConfirm}'));
    assert.match(dialog.slice(0, 1200), /startFreshSummary\(s\.setup\)\.map\(/);
    assert.match(dialog.slice(0, 1200), /title=\{t\('common\.startFreshTitle'\)\}/);
    assert.match(dialog.slice(0, 1200), /cancelLabel=\{t\('common\.keepWhatIHave'\)\}/);
    assert.match(dialog.slice(0, 1200), /tone="primary"/, 'nothing is deleted — History keeps every clip');
});
