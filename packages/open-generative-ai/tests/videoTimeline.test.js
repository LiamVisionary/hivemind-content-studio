// The manual timeline model — capture, drop-plan and continuation rules. These
// are the arithmetic behind the strip's feel (where a generation lands, what a
// drop means, which clip the next shot continues from), invisible in a
// screenshot and easy to get subtly wrong.
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderComponent } = require('./helpers/render.js');

const lib = () => import('../src/lib/videoTimeline.js');

const seg = (id, url = '', model = '') => ({ id, url, model });

test('opening seeds shot 1 from the canvas, or an empty slot from nothing', async () => {
    const { openTimeline } = await lib();
    const seeded = openTimeline('/api/x/clip1.mp4', 'minimax-h3');
    assert.equal(seeded.segments.length, 1);
    assert.equal(seeded.segments[0].url, '/api/x/clip1.mp4');
    assert.equal(seeded.segments[0].model, 'minimax-h3');
    assert.equal(seeded.selectedId, seeded.segments[0].id);

    const blank = openTimeline('', '');
    assert.equal(blank.segments.length, 1);
    assert.equal(blank.segments[0].url, '');
    // A model label without a clip would be a lie about what the slot holds.
    const labelled = openTimeline('', 'minimax-h3');
    assert.equal(labelled.segments[0].model, '');
});

test('a finished generation fills the selected empty slot, and never silently replaces', async () => {
    const { captureIntoTimeline } = await lib();
    // Empty selected slot → filled in place, selection unchanged.
    const filled = captureIntoTimeline([seg('a', 'u1'), seg('b')], 'b', { url: 'u2', model: 'm' });
    assert.deepEqual(filled.segments.map((item) => item.url), ['u1', 'u2']);
    assert.equal(filled.selectedId, 'b');
    assert.equal(filled.segment.id, 'b');

    // Filled selected slot → a NEW segment lands right after it, selected.
    const inserted = captureIntoTimeline([seg('a', 'u1'), seg('b', 'u2')], 'a', { url: 'u3', model: 'm' });
    assert.deepEqual(inserted.segments.map((item) => item.url), ['u1', 'u3', 'u2']);
    assert.equal(inserted.selectedId, inserted.segments[1].id);

    // No selection resolvable → appended at the end.
    const appended = captureIntoTimeline([seg('a', 'u1')], 'missing', { url: 'u2', model: 'm' });
    assert.deepEqual(appended.segments.map((item) => item.url), ['u1', 'u2']);
});

test('removing a segment moves the selection to its neighbour', async () => {
    const { removeTimelineSegment } = await lib();
    const three = [seg('a', 'u1'), seg('b', 'u2'), seg('c', 'u3')];
    // The one that slid into its slot…
    assert.equal(removeTimelineSegment(three, 'b', 'b').selectedId, 'c');
    // …or the new last when the last one went…
    assert.equal(removeTimelineSegment(three, 'c', 'c').selectedId, 'b');
    // …and an unrelated selection stays put.
    assert.equal(removeTimelineSegment(three, 'a', 'c').selectedId, 'c');
    assert.equal(removeTimelineSegment([seg('a')], 'a', 'a').selectedId, '');
});

test('the drop plan resolves every gesture, and a no-op drop stays a no-op', async () => {
    const { timelineDropPlan } = await lib();
    const list = [seg('a', 'u1'), seg('b'), seg('c', 'u3')];
    const clip = { kind: 'clip', url: 'uNew', model: 'm' };

    // Onto an empty card → fill; onto a filled card → replace, behind a confirm.
    assert.deepEqual(timelineDropPlan(list, { id: 'b', region: 'on' }, clip), { action: 'fill', id: 'b' });
    assert.deepEqual(timelineDropPlan(list, { id: 'a', region: 'on' }, clip), { action: 'replace', id: 'a', needsConfirm: true });
    // The same clip back onto its own card changes nothing.
    assert.equal(timelineDropPlan(list, { id: 'a', region: 'on' }, { kind: 'clip', url: 'u1' }), null);

    // Into the gaps → insert there; onto the "+" card → append.
    assert.deepEqual(timelineDropPlan(list, { id: 'b', region: 'before' }, clip), { action: 'insert', index: 1 });
    assert.deepEqual(timelineDropPlan(list, { id: 'b', region: 'after' }, clip), { action: 'insert', index: 2 });
    assert.deepEqual(timelineDropPlan(list, { region: 'end' }, clip), { action: 'append' });

    // A card dragged between its siblings moves — with the index measured in
    // the list WITHOUT itself, which is what a gap drop produces.
    assert.deepEqual(timelineDropPlan(list, { id: 'c', region: 'before' }, { kind: 'segment', id: 'a' }), { action: 'move', id: 'a', index: 1 });
    assert.deepEqual(timelineDropPlan(list, { region: 'end' }, { kind: 'segment', id: 'a' }), { action: 'move', id: 'a', index: 2 });
    // Dropped back beside itself → nothing moves, so nothing rebuilds.
    assert.equal(timelineDropPlan(list, { id: 'a', region: 'after' }, { kind: 'segment', id: 'a' }), null);
    assert.equal(timelineDropPlan(list, { id: 'b', region: 'before' }, { kind: 'segment', id: 'a' }), null);
});

test('moving a segment lands where the gap said it would', async () => {
    const { moveTimelineSegment } = await lib();
    const list = [seg('a', 'u1'), seg('b', 'u2'), seg('c', 'u3')];
    assert.deepEqual(moveTimelineSegment(list, 'a', 1).map((item) => item.id), ['b', 'a', 'c']);
    assert.deepEqual(moveTimelineSegment(list, 'c', 0).map((item) => item.id), ['c', 'a', 'b']);
    assert.deepEqual(moveTimelineSegment(list, 'missing', 0), list);
});

test('auto-continue picks the mechanism from the model and the clip from the strip', async () => {
    const { timelineContinuationPlan } = await lib();
    const strip = [seg('a', 'u1'), seg('gap'), seg('b', 'u2'), seg('next')];
    const h3 = { supportsMotionContext: true, supportsStartFrame: true };
    const ltx = { supportsMotionContext: false, supportsStartFrame: true };
    const cloud = {};

    // The source is the last FILLED segment before the selected slot — an
    // empty placeholder between them is skipped, not continued from.
    assert.deepEqual(timelineContinuationPlan(h3, strip, 'next'), { mode: 'chain', fromUrl: 'u2', fromIndex: 2 });
    assert.deepEqual(timelineContinuationPlan(ltx, strip, 'next'), { mode: 'frame', fromUrl: 'u2', fromIndex: 2 });
    assert.deepEqual(timelineContinuationPlan(h3, strip, 'gap'), { mode: 'chain', fromUrl: 'u1', fromIndex: 0 });

    // Nothing before it, a filled selection, or a model with no mechanism →
    // nothing to arm.
    assert.equal(timelineContinuationPlan(h3, [seg('only')], 'only'), null);
    assert.equal(timelineContinuationPlan(h3, strip, 'b'), null);
    assert.equal(timelineContinuationPlan(cloud, strip, 'next'), null);
});

// --- the full cut, on the rail ----------------------------------------------
//
// Asked 2026-09-13, looking at a three-shot sequence: "how can i see them all
// together as one unified clip?" You could — Shot | Full cut has always been in
// TimelineStrip — but the strip is behind the composer's More -> Timeline, two
// levels under the rail that draws the sequence. So the rail now carries the
// same toggle under the shots it joins.
test('the rail carries the full cut, and only when there is a join to make', async () => {
    const { timelineCanCombine } = await lib();
    // The row's own condition, straight off the model the studio passes in.
    assert.equal(timelineCanCombine([seg('a', 'u1')]), false, 'one shot IS the whole sequence');
    assert.equal(timelineCanCombine([seg('a', 'u1'), seg('b', 'u2')]), true);

    const fs = require('node:fs');
    const path = require('node:path');
    const rail = fs.readFileSync(path.join(__dirname, '../src/studios/video/VideoRail.jsx'), 'utf8');
    assert.match(rail, /\{canCombine \? \(\n\s*<FullCutRow/, 'the row must not draw with nothing to join');

    // The studio hands the rail the SAME state the strip reads, so the two
    // surfaces cannot disagree about one scene.
    const studio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    for (const wire of [
        /showCombined=\{s\.timelineShowCombined\}/,
        /canCombine=\{timelineCanCombine\(s\.timelineSegments\)\}/,
        /combineBuilding=\{s\.timelineBuilding\}/,
        /combineError=\{s\.timelineBuildError\}/,
    ]) assert.match(studio, wire);

    // buildTimelineCut refuses a CLOSED scene, and the rail sits outside it: a
    // press that left the scene shut would schedule a build that bails on its
    // first line and leave the toggle spinning.
    assert.match(studio, /if \(view && !s\.timelineOn\) openTimelineView\(\);/,
        'the rail press must open the scene it is asking to join');
    assert.match(studio, /const buildTimelineCut = async \(\) => \{\n\s*if \(!s\.timelineOn\) return;/,
        'the guard this works around is gone — re-check railToggleCombined');
});

test('the full cut row says which state it is in, and refuses a join that cannot be made', async () => {
    const render = (props) => renderComponent('src/studios/video/VideoRail.jsx', 'FullCutRow', props);

    const ready = await render({ seconds: 15.4, showing: false, building: false, error: '', onToggle() {} });
    assert.match(ready, /Full cut/);
    assert.match(ready, /15s/, 'the length is what tells you it is the whole thing');
    assert.doesNotMatch(ready, /disabled/);

    const building = await render({ seconds: 0, showing: false, building: true, error: '', onToggle() {} });
    assert.match(building, /building/);

    // clipJoiner's own sentence, on the control — not a note on a card that is
    // not on screen. And not pressable: there is no blob to put on the stage.
    const broken = await render({
        seconds: 0, showing: false, building: false,
        error: 'clip 2 has a different resolution — cannot join losslessly',
        onToggle() {},
    });
    assert.match(broken, /disabled/);
    assert.match(broken, /clip 2 has a different resolution/);
    assert.doesNotMatch(broken, /15s/);
});

test('the persisted strip survives a round trip and a corrupt blob degrades to nothing', async () => {
    const { serializeTimeline, reviveTimeline, MAX_TIMELINE_SEGMENTS } = await lib();
    const state = {
        on: true,
        segments: [seg('a', 'u1', 'minimax-h3'), seg('b')],
        selectedId: 'b',
        extend: true,
        // Which continuation the last press asked for, where the lane has two.
        // Persisted beside `extend` rather than folded into it: "continue" and
        // "continue with the sound" are both on, and reloading into the wrong
        // one would silently change what the next shot costs.
        withSound: true,
        showCombined: true,
    };
    const revived = reviveTimeline(JSON.parse(JSON.stringify(serializeTimeline(state))));
    assert.deepEqual(revived, {
        on: true,
        segments: [
            { id: 'a', url: 'u1', model: 'minimax-h3', excluded: false },
            { id: 'b', url: '', model: '', excluded: false },
        ],
        selectedId: 'b',
        extend: true,
        withSound: true,
        showCombined: true,
    });
    // Absent in a strip persisted before the choice existed: off, not undefined.
    assert.equal(reviveTimeline({ segments: [seg('a', 'u')], selectedId: 'a' }).withSound, false);

    // A selection pointing at nothing snaps to the first segment; duplicate
    // ids or no segments at all are not a strip.
    assert.equal(reviveTimeline({ segments: [seg('a', 'u')], selectedId: 'zz' }).selectedId, 'a');
    assert.equal(reviveTimeline({ segments: [seg('a'), seg('a')], selectedId: 'a' }), null);
    assert.equal(reviveTimeline({ segments: [] }), null);
    assert.equal(reviveTimeline(null), null);
    assert.equal(reviveTimeline('nonsense'), null);

    // A hostile blob cannot mount hundreds of poster decoders.
    const flood = { segments: Array.from({ length: 200 }, (_, i) => seg(`s${i}`, 'u')), selectedId: 's0' };
    assert.equal(reviveTimeline(flood).segments.length, MAX_TIMELINE_SEGMENTS);
});

test('the combine key is the filled clips in order, and two clips make a cut', async () => {
    const { timelineCombineKey, timelineCanCombine, filledTimelineSegments } = await lib();
    const list = [seg('a', 'u1'), seg('gap'), seg('b', 'u2')];
    assert.equal(timelineCombineKey(list), 'u1 u2');
    assert.equal(timelineCanCombine(list), true);
    assert.equal(timelineCanCombine([seg('a', 'u1'), seg('gap')]), false);
    assert.deepEqual(filledTimelineSegments(list).map((item) => item.id), ['a', 'b']);
    // Reordering changes the key — a built cut for the old order is stale.
    assert.notEqual(timelineCombineKey([list[2], list[0]]), timelineCombineKey(list));
});

// --- the "+" always produces a slot ------------------------------------------
//
// Reported 2026-09-13: "i pressed the add the next shot button and it does
// nothing." Self-inflicted the same day. Once a finished render started landing
// in the strip BEFORE the scene had been opened, the rail's "+" still branched
// on `timelineOn`: with the scene closed it called onOpenTimeline, which set the
// flag and then seeded nothing (seedTimelineSegments returns early when segments
// already exist). Nothing was added and nothing moved on screen.
//
// Deliberately textual for the rail half: the branch under test is one onClick
// in a component whose siblings need a drag-and-drop harness to mount, and the
// claim is about which handler the press reaches.
test('adding the next shot appends a slot and selects it', async () => {
    const { addTimelineSegment } = await lib();
    const before = [seg('a', '/clip-1.mp4', 'ltx')];
    const after = addTimelineSegment(before);
    assert.equal(after.segments.length, 2, 'the next shot must appear as a slot');
    assert.equal(after.segments[1].url, '', 'and it is empty, waiting for the render');
    assert.equal(after.selectedId, after.segments[1].id, 'the new slot is what the next render fills');
});

// Reported 2026-09-13 after the choice landed: pressing "+" over a sequence
// that already ended in an empty slot stacked a second blank card, and the new
// one buried the one the person had just armed.
test('the "+" reuses an empty tail instead of stacking blank cards', async () => {
    const { addTimelineSegment, nextShotIndex } = await lib();
    const withTail = [seg('a', '/clip-1.mp4', 'ltx'), seg('tail')];
    const again = addTimelineSegment(withTail);
    assert.equal(again.segments.length, 2, 'no second blank card');
    assert.equal(again.segments, withTail, 'the list is not even rebuilt');
    assert.equal(again.selectedId, 'tail', 'the empty tail IS the next shot');

    // Only the tail. A gap in the middle is a placeholder somebody made on
    // purpose — the press still appends past it.
    const withGap = [seg('a', '/clip-1.mp4', 'ltx'), seg('gap'), seg('b', '/clip-2.mp4', 'ltx')];
    const appended = addTimelineSegment(withGap);
    assert.equal(appended.segments.length, 4);
    assert.equal(appended.selectedId, appended.segments[3].id);

    // The index the rail titles the menu with, off the same rule.
    assert.equal(nextShotIndex(withTail), 1, 'the tail slot is shot 02, not shot 03');
    assert.equal(nextShotIndex(withGap), 3);
    assert.equal(nextShotIndex([]), 0);
});

test('the rail asks for the next shot whenever the sequence has anything in it', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const rail = fs.readFileSync(path.join(__dirname, '../src/studios/video/VideoRail.jsx'), 'utf8');
    // Not `timelineOn` alone: a strip holding a shot is a started sequence
    // whether or not the scene was ever opened by hand. Written as the inverse
    // since the press grew a second branch — only a sequence that is BOTH
    // closed and empty is sent to onOpenTimeline; everything else produces a
    // slot, through the menu or directly.
    assert.match(rail, /if \(!timelineOn && !segments\.length\) \{ onOpenTimeline\?\.\(\); return; \}/,
        'the "+" branches on the flag again, so a closed-but-filled sequence adds nothing');
    assert.match(rail, /onAdd\?\.\(\);\n/, 'the fall-through press still adds a slot');

    const studio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    const add = studio.slice(studio.indexOf('const timelineAdd = (mode'), studio.indexOf('const timelineAdd = (mode') + 900);
    assert.match(add, /if \(!s\.timelineOn\) \{/, 'timelineAdd no longer opens the scene it is adding to');
    assert.match(add, /addTimelineSegment\(s\.timelineSegments\)/);
});

// --- the "+" asks which kind of next shot this is ----------------------------
//
// Reported 2026-09-13, looking at a two-shot LTX sequence: "so whats this menu
// for? this should be for continuing the scene". It was not. The press made an
// empty slot with nothing carried over — a cut — and on every lane but MiniMax
// H3 that was the only thing it COULD make: Auto-continue defaults to off and
// the one door that turned it on (openSceneAt, behind "Continue scene") is
// gated on motion context, so LTX had a working frame-mode continuation with no
// way to reach it. Both kinds of next shot are real, so the press asks.
//
// Deliberately textual: the claim is which handler a press reaches and what the
// handler writes, on a component whose siblings need a drag-and-drop harness to
// mount. The MECHANISM half — that an LTX-shaped entry yields a 'frame' plan and
// a cloud lane yields none — is a real call, above.
test('the "+" offers continue-or-cut, and only where the lane can continue', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const rail = fs.readFileSync(path.join(__dirname, '../src/studios/video/VideoRail.jsx'), 'utf8');

    // Both conditions, or the menu lies: a lane with no mechanism would offer a
    // continuation it cannot perform, and an empty sequence has no source clip.
    assert.match(rail, /const canOfferContinue = Boolean\(continueMode\) && lastFilled >= 0;/,
        'the choice must need both a mechanism and a clip to continue from');
    assert.match(rail, /if \(canOfferContinue\) \{ openAddMenu\(event\.currentTarget\); return; \}/,
        'the "+" stopped asking and went back to assuming');
    assert.match(rail, /onPick\?\.\('continue'\)/);
    assert.match(rail, /onPick\?\.\('cut'\)/);
    assert.match(rail, /onPick=\{\(mode\) => \{ closeMenu\(\); onAdd\?\.\(mode\); \}\}/,
        'the picked mode must reach timelineAdd');
    // The heading names the slot the press LANDS in. Counting the list would be
    // one ahead of it whenever the tail is already empty.
    assert.match(rail, /const nextShot = shotNumber\(nextShotIndex\(segments\)\);/,
        'the menu must name the slot off the same rule that picks it');

    const studio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    const add = studio.slice(studio.indexOf('const timelineAdd = (mode'), studio.indexOf('const timelineAdd = (mode') + 1600);
    // ONE piece of continuation state. The press writes the same flag the
    // strip's Auto-continue switch shows, so the two can never disagree.
    assert.match(add, /if \(mode === 'continue' \|\| mode === 'sound'\) \{/);
    assert.match(add, /s\.timelineWithSound = mode === 'sound';/);
    assert.match(add, /\} else if \(mode === 'cut'\) \{\n\s*s\.timelineExtend = false;/);
    // A cut TAKES BACK an earlier arming rather than merely skipping one.
    assert.match(add, /if \(mode === 'cut'\) disarmTimelineContinuation\(\);\n\s*else armTimelineContinuation\(\);/);

    // The rail and the strip are told the same mode by the same helper, so the
    // "+" can never offer a mechanism the Auto-continue switch denies.
    // Read with the sound preference OFF: this is what the "Continue the scene"
    // row does, whatever the last press chose.
    assert.match(studio, /const sceneContinueMode = timelineExtendModeFor\(currentModel\(s\.setup, s\.catalogs\), false\);/);
    assert.match(studio, /extendMode=\{sceneContinueMode\}/);
    assert.match(studio, /continueMode=\{sceneContinueMode\}/);
});

// A real render, because the WORDING is the feature: the two rows make the same
// empty slot and differ only in what the previous clip leaves in the composer.
// Rendered rather than grepped so the claim survives a refactor of how the
// sentence is assembled — and so the lane's mechanism is read back, not assumed.
// --- continuing the SOUND -----------------------------------------------------
//
// Asked 2026-09-13 of a three-shot LTX sequence: "the clips had different music,
// does ltx not support proper audio context?" It does — LTX 2.3 denoises a joint
// audio+video latent, and `ltx-2-mlx extend` holds the source's audio latent
// CLEAN while denoising only the new frames, so the soundtrack continues. What
// it could not do was feed a segment strip: extend regenerates the source AND
// the tail as one file, so shot 03's card would have contained shots 01 and 02.
// The gateway trims the source's span back off (extend_return_tail), which is
// what makes the mode usable here at all.
test('a lane that can take a clip back in offers to continue the sound', async () => {
    const { timelineContinuationMode, timelineCanContinueWithSound, timelineContinuationPlan } = await lib();

    // LTX: a start frame (picture only) OR its own extension (sound carries).
    const ltx = { supportsStartFrame: true, supportsVideoInput: true };
    assert.equal(timelineContinuationMode(ltx), 'frame', 'the quiet, fast one is the default');
    assert.equal(timelineContinuationMode(ltx, { withSound: true }), 'extend');
    assert.equal(timelineCanContinueWithSound(ltx), true);

    // H3 chains through Motion Context, which ALREADY carries room tone. Offering
    // a second "with sound" row there would be two names for one thing.
    const h3 = { supportsMotionContext: true, supportsStartFrame: true, supportsVideoInput: false };
    assert.equal(timelineContinuationMode(h3, { withSound: true }), 'chain');
    assert.equal(timelineCanContinueWithSound(h3), false);

    // A lane that cannot take a clip back in has nothing to offer, whatever is
    // asked of it.
    const frameOnly = { supportsStartFrame: true, supportsVideoInput: false };
    assert.equal(timelineContinuationMode(frameOnly, { withSound: true }), 'frame');
    assert.equal(timelineCanContinueWithSound(frameOnly), false);
    assert.equal(timelineCanContinueWithSound(null), false);

    // And the plan arms the mode the choice asked for, off the same clip.
    const strip = [seg('a', 'u1'), seg('next')];
    assert.deepEqual(timelineContinuationPlan(ltx, strip, 'next', { withSound: true }),
        { mode: 'extend', fromUrl: 'u1', fromIndex: 0 });
    assert.deepEqual(timelineContinuationPlan(ltx, strip, 'next'),
        { mode: 'frame', fromUrl: 'u1', fromIndex: 0 });
});

test('continuing with sound arms the clip as the SOURCE, and a cut takes it back', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const studio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');

    // The whole previous clip goes in as the source video, and the request asks
    // for only the frames this run adds — without that, the shot card would
    // hold every shot before it.
    assert.match(studio, /if \(plan\.mode === 'extend'\) \{/);
    assert.match(studio, /videoUrl: plan\.fromUrl,/);
    assert.match(studio, /extendTail: true,/);
    assert.match(studio, /if \(plan\.extendTail\) localParams\.extend_return_tail = true;/);
    // A start frame or an armed chain alongside it would be a second, and
    // contradictory, opening.
    const armExtend = studio.slice(studio.indexOf("if (plan.mode === 'extend') {"), studio.indexOf("if (plan.mode === 'chain') {"));
    assert.match(armExtend, /imageUrl: null,/);
    assert.match(armExtend, /motionContextUrl: null,/);

    // Disarm has to take the extension back too, or "cut to a new shot" would
    // still send the previous clip.
    assert.match(studio, /if \(s\.timelineArmedExtendUrl && s\.setup\.videoUrl === s\.timelineArmedExtendUrl\) \{/);
    assert.match(studio, /videoUrl: null, videoName: null, extendTail: false/);

    // The row and the arming read ONE lane — the one the run reaches — so a row
    // can never arm a mechanism the run cannot use.
    assert.match(studio, /const entry = ingredientsFallback \|\| currentModel\(s\.setup, s\.catalogs\);/);
    assert.match(studio, /ingredientsFallback \|\| currentModel\(s\.setup, s\.catalogs\),\n\s*\);/);
    assert.match(studio, /const videoLane = ingredientsOffTarget \|\| model;/);
});

test('the choice names the shot it continues from, in the lane\'s own mechanism', async () => {
    // The row a label sits in. Splitting on the close tag is enough to tell
    // "inside this button" from "after it", which is the claim below.
    const rowFor = (markup, label) => markup.split('</button>').find((chunk) => chunk.includes(label)) || '';

    const chain = await renderComponent('src/studios/video/VideoRail.jsx', 'NextShotChoice', {
        continueMode: 'chain', fromShot: '02', nextShot: '03',
    });
    assert.match(chain, /Shot 03/, 'the heading names the slot the press would make');
    assert.match(chain, /Continue the scene/);
    assert.match(chain, /Picks up where shot 02 ends/);
    // H3 chains through Motion Context, and room tone is the part a person
    // cannot see coming.
    assert.match(chain, /motion and room tone carry across the cut/);
    assert.match(chain, /Cut to a new shot/);
    assert.match(chain, /nothing carried over from shot 02/);
    // References are NOT what a cut drops — disarmTimelineContinuation clears
    // the armed clip and the seeded frame, and leaves the setup alone.
    assert.match(chain, /same references and settings/);

    const frame = await renderComponent('src/studios/video/VideoRail.jsx', 'NextShotChoice', {
        continueMode: 'frame', fromShot: '02', nextShot: '03',
    });
    // Two rows on a lane with one mechanism: the sound row is not drawn, and
    // the picture row says plainly that the next shot scores itself.
    assert.doesNotMatch(frame, /Continue with the sound/);
    assert.match(frame, /New sound\./);

    // Three where the lane can also continue the sound — and the cost of that
    // is in the row, because the press is where the choice is made.
    const sound = await renderComponent('src/studios/video/VideoRail.jsx', 'NextShotChoice', {
        continueMode: 'frame', withSound: true, fromShot: '02', nextShot: '03',
    });
    assert.match(sound, /Continue with the sound/);
    assert.match(sound, /Keeps shot 02&#x27;s music and room tone running/);
    assert.match(sound, /Slower each shot/);
    assert.match(sound, /the scene has to stay put/);
    // Still its own pressable row, sentence included.
    assert.ok(rowFor(sound, 'Continue with the sound').includes('room tone running'));
    // All three are there; the sound row never replaces a choice.
    for (const label of ['Continue the scene', 'Continue with the sound', 'Cut to a new shot']) {
        assert.ok(rowFor(sound, label).includes('role="menuitem"'), `${label} is not a row`);
    }
    // A start-frame lane carries a PICTURE, not a tail: promising room tone
    // here would be a lie about LTX.
    assert.match(frame, /Opens on shot 02&#x27;s last frame\./);
    assert.doesNotMatch(frame, /room tone/);

    // The sentence is the obvious thing to aim at, so it has to BE the target:
    // drawn beside the row instead of inside it, a press on it did nothing.
    for (const [markup, label, note] of [
        [chain, 'Continue the scene', 'motion and room tone carry across the cut'],
        [chain, 'Cut to a new shot', 'nothing carried over from shot 02'],
        [frame, 'Continue the scene', 'last frame'],
    ]) {
        const row = rowFor(markup, label);
        assert.ok(row.includes('role="menuitem"'), `${label} is not a menu row`);
        assert.ok(row.includes(note), `${label}: its sentence is outside the pressable row`);
    }
    // And a row carrying one wraps rather than truncating to a single line.
    assert.doesNotMatch(chain, /truncate/);
});
