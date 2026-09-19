// The turntable capture: the recipe, the angle arithmetic, and the two gates
// that decide where it is offered and whether its loop can close.
//
// Deliberately literal about the composed text. The freeze sentence and the
// no-cuts sentence are the two instructions that turn a performance into a
// capture — a paraphrase of either is a different render — and they double as
// the anchors the block is found by, so a change to their wording that nothing
// checked would silently orphan every already-armed prompt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../src/lib/turntable.js');

/* ---------------- the recipe ---------------- */

test('the composed block carries the freeze, the orbit and the negations', async () => {
    const { blankTurntable, turntableSentence } = await load();
    const text = turntableSentence(blankTurntable());

    // The three load-bearing instructions, in the order the model reads them.
    assert.match(text, /remains completely frozen in place, perfectly still like a statue\./);
    assert.match(text, /The camera smoothly orbits 360 degrees clockwise around the character in one continuous shot/);
    assert.match(text, /No character movement, no pose change, no cuts\.$/);
    // The negation sentence is LAST: H3 weights a trailing constraint more
    // heavily than one buried mid-paragraph.
    assert.ok(text.indexOf('no cuts') > text.indexOf('smoothly orbits'));
});

test('every dial reaches the text', async () => {
    const { blankTurntable, turntableSentence } = await load();
    const text = turntableSentence({
        ...blankTurntable(),
        subject: 'the product',
        arc: 180,
        direction: 'ccw',
        startAngle: 90,
        elevation: 'high',
        framing: 'wide',
        lens: 'telephoto',
        speed: 'at slow speed',
    });
    assert.match(text, /The product remains completely frozen/);
    assert.match(text, /orbits 180 degrees counter-clockwise at slow speed around the product/);
    assert.match(text, /starting on the right profile of the product/);
    assert.match(text, /held high, looking downward/);
    assert.match(text, /holding a wide full shot throughout/);
    assert.match(text, /telephoto/);
});

test('the lighting lock is what a reconstruction needs, and it can be let go', async () => {
    const { blankTurntable, turntableSentence } = await load();
    const locked = turntableSentence(blankTurntable());
    const loose = turntableSentence({ ...blankTurntable(), lockLighting: false });
    assert.match(locked, /The lighting, the background and the distance to the character stay exactly constant/);
    assert.doesNotMatch(loose, /lighting/);
    // The distance still holds either way: an orbit that also dollies is not an
    // orbit, whatever the light is doing.
    assert.match(loose, /distance to the character stays constant/);
});

/* ---------------- arm / re-arm / clear ---------------- */

test('arming is idempotent — five tweaks leave one block, not five', async () => {
    const { applyTurntable, blankTurntable, hasTurntable, stripTurntable } = await load();
    const base = 'A weathered bronze statue in a courtyard.';

    let prompt = applyTurntable(base, blankTurntable());
    assert.equal(hasTurntable(prompt), true);
    assert.ok(prompt.startsWith(base), 'the written prompt keeps its place at the head');

    for (const arc of [270, 180, 90, 360]) {
        prompt = applyTurntable(prompt, { ...blankTurntable(), arc });
    }
    assert.equal((prompt.match(/remains completely frozen in place/g) || []).length, 1);
    assert.equal((prompt.match(/no cuts/g) || []).length, 1);
    assert.match(prompt, /orbits 360 degrees/);
    assert.equal(stripTurntable(prompt), base, 'clearing returns exactly what was there before');
});

test('a block edited by hand still comes out cleanly', async () => {
    const { applyTurntable, blankTurntable, hasTurntable, stripTurntable } = await load();
    const base = 'A lacquered helmet on a plinth.';
    const armed = applyTurntable(base, blankTurntable());
    // Someone rewrote the middle of the block. The anchors are the two ends, so
    // it is still found, and it still comes out in one piece.
    const edited = armed.replace(/The camera smoothly orbits[^.]*\./, 'The camera drifts right round it, slowly.');
    assert.equal(hasTurntable(edited), true);
    assert.equal(stripTurntable(edited), base);
});

test('a prompt that never held a capture is left alone', async () => {
    const { applyTurntable, hasTurntable, stripTurntable } = await load();
    const base = 'A cat asleep on a radiator. No cuts.';
    assert.equal(hasTurntable(base), false, 'the closing anchor alone is not a block');
    assert.equal(stripTurntable(base), base);
    assert.equal(applyTurntable(base, null), base);
});

/* ---------------- the angles ---------------- */

test('the dial and the prose read one convention', async () => {
    const { angleLabel, blankTurntable, turntableAngleAt } = await load();
    // 0 = the camera in front of the face; clockwise seen from above walks it
    // toward the subject's RIGHT, which is why 90 is the right profile.
    assert.equal(angleLabel(0), 'Directly in front');
    assert.equal(angleLabel(90), 'Right profile');
    assert.equal(angleLabel(180), 'Directly behind');
    assert.equal(angleLabel(270), 'Left profile');
    assert.equal(angleLabel(45), 'Front three-quarter — subject’s right');

    const rig = blankTurntable();
    assert.equal(turntableAngleAt(rig, 0), 0);
    assert.equal(turntableAngleAt(rig, 0.25), 90);
    assert.equal(turntableAngleAt(rig, 0.5), 180);
    // A full turn ends where it began — which is the whole point of pinning one
    // picture at both ends.
    assert.equal(turntableAngleAt(rig, 1), 0);

    const ccw = { ...rig, direction: 'ccw' };
    assert.equal(turntableAngleAt(ccw, 0.25), 270);
    const offset = { ...rig, startAngle: 90, arc: 180 };
    assert.equal(turntableAngleAt(offset, 0.5), 180);
    assert.equal(turntableAngleAt(offset, 1), 270);
});

test('an angle the sweep never reaches has no timestamp, rather than a wrong one', async () => {
    const { blankTurntable, turntableFractionFor, turntableTimeFor } = await load();
    const quarter = { ...blankTurntable(), arc: 90, startAngle: 0 };

    assert.equal(turntableFractionFor(quarter, 45), 0.5);
    assert.equal(turntableTimeFor(quarter, 45, 10), 5);
    // Three quarters of the circle was never captured. Answering 0 for it is
    // how a grabbed "frame at 200 degrees" turns out to be the front of
    // someone's head.
    assert.equal(turntableFractionFor(quarter, 200), null);
    assert.equal(turntableTimeFor(quarter, 200, 10), null);

    // A full sweep reaches everything, and its wrap lands at the END.
    const full = blankTurntable();
    assert.equal(turntableFractionFor(full, 0), 0);
    assert.equal(turntableFractionFor(full, 359), 359 / 360);

    // The last frame is a frame short of the duration: seeking to the exact end
    // parks on whatever the decoder had last.
    assert.ok(turntableTimeFor(full, 359.99, 10) <= 9.96);
});

/* ---------------- the export ---------------- */

test('the export samples the whole clip, ends included, at an even step', async () => {
    const { blankTurntable, degreesPerFrame, frameFileName, orbitSampleTimes } = await load();

    const times = orbitSampleTimes(10, 5);
    assert.equal(times.length, 5);
    assert.equal(times[0], 0, 'the first frame is kept — it is half of the loop closure');
    assert.ok(Math.abs(times[4] - 9.96) < 1e-9);
    const gaps = times.slice(1).map((value, index) => value - times[index]);
    for (const gap of gaps) assert.ok(Math.abs(gap - gaps[0]) < 1e-9, 'even spacing');

    assert.deepEqual(orbitSampleTimes(0, 10), []);
    assert.deepEqual(orbitSampleTimes(10, 1), [], 'one frame is not an orbit');

    assert.equal(degreesPerFrame(blankTurntable(), 73), 5);
    // Zero-padded, so a plain alphabetical listing is also the orbit order —
    // which is what COLMAP's sequential matcher assumes.
    assert.equal(frameFileName(0, 120), 'frames/frame_0001.jpg');
    assert.equal(frameFileName(119, 120), 'frames/frame_0120.jpg');
});

test('the README records the settings and says outright when the loop is open', async () => {
    const { blankTurntable, colmapRecipe } = await load();
    const closed = colmapRecipe({ rig: blankTurntable(), frameCount: 72, durationSeconds: 8, modelName: 'MiniMax H3', loopClosed: true });
    assert.match(closed, /SIMPLE_PINHOLE/);
    assert.match(closed, /Frames: 72/);
    assert.match(closed, /one frame every 5\.07°/);
    assert.match(closed, /Model: MiniMax H3/);
    assert.match(closed, /Loop: closed/);
    // A recipe whose failure modes are all silent has to name them.
    assert.match(closed, /warped or bowl-shaped/);

    const open = colmapRecipe({ rig: blankTurntable(), frameCount: 72, durationSeconds: 8, loopClosed: false });
    assert.match(open, /Loop: OPEN/);
    assert.doesNotMatch(open, /^Model:/m, 'an unnamed model leaves no empty line behind');
});

/* ---------------- the two gates ---------------- */

test('the vendor gate follows MiniMax wherever it runs', async () => {
    const { isMinimaxVendorModel } = await load();

    // Local and rented: the workflow registry's family.
    assert.equal(isMinimaxVendorModel({ workflowFamily: 'minimax', id: 'hivemind-media:minimax-h3' }), true);
    assert.equal(isMinimaxVendorModel({ modelFamily: 'minimax-eros', modelId: 'hivemind-media:minimax-h3-eros' }), true);
    // The cloud catalog's own provider field, and its separate family namespace.
    assert.equal(isMinimaxVendorModel({ id: 'minimax-hailuo-02-pro-i2v', family: 'minimax-2', provider: 'minimax' }), true);
    assert.equal(isMinimaxVendorModel({ id: 'minimax-hailuo-2.3-fast', family: 'minimax-2.3' }), true);
    // A setup persisted before either field existed.
    assert.equal(isMinimaxVendorModel({ modelId: 'hivemind-media:minimax-h3-turbo' }), true);

    assert.equal(isMinimaxVendorModel({ workflowFamily: 'ltx-2.3', id: 'hivemind-media:ltx23-eros-fast' }), false);
    assert.equal(isMinimaxVendorModel({ id: 'kling-v2.1-pro-i2v', provider: 'kling' }), false);
    assert.equal(isMinimaxVendorModel(null), false);
    assert.equal(isMinimaxVendorModel('minimax'), false, 'a bare string is not a model row');
});

test('the vendor gate and the graph gate are NOT the same question', async () => {
    const { isMinimaxVendorModel } = await load();
    const { isMinimaxFamilyModel } = await import('../src/lib/videoTasks.js');

    const hailuo = { id: 'minimax-hailuo-02-pro-i2v', family: 'minimax-2', provider: 'minimax' };
    // The graph predicate refuses the cloud row on purpose — handing it the
    // local H3 graph's controls is what that refusal prevents. The capture
    // recipe is a property of the weights, so it holds for the same row.
    assert.equal(isMinimaxFamilyModel(hailuo), false);
    assert.equal(isMinimaxVendorModel(hailuo), true);

    // The cross-reference that keeps the next reader from merging them.
    const source = fs.readFileSync(path.join(__dirname, '../src/lib/videoTasks.js'), 'utf8');
    assert.match(source, /isMinimaxVendorModel/);
});

test('a lane that cannot pin both ends says so, and says what to do instead', async () => {
    const { turntableLoopReadiness } = await load();

    const none = turntableLoopReadiness({ canPin: false, hasStartFrame: true });
    assert.equal(none.ready, false);
    assert.match(none.reason, /takes no end frame/);
    // Never a problem without its fix: the lanes that CAN close the loop are named.
    assert.match(none.fix, /MiniMax H3|Hailuo 02/);

    // The missing picture is reported FIRST, whether or not the lane can pin —
    // a cloud MiniMax row only grows its end-frame slot once a start frame puts
    // it on the image-to-video lane, so leading with the lane told someone
    // standing on Hailuo 02 Standard to go and pick Hailuo 02 Standard.
    for (const canPin of [true, false]) {
        const noPicture = turntableLoopReadiness({ canPin, hasStartFrame: false });
        assert.equal(noPicture.ready, false);
        assert.match(noPicture.fix, /start frame/);
        assert.doesNotMatch(noPicture.fix, /Pick a lane/);
    }

    const ready = turntableLoopReadiness({ canPin: true, hasStartFrame: true });
    assert.deepEqual(ready, { canPin: true, ready: true, reason: '', fix: '' });
});

/* ---------------- the rig survives a bad blob ---------------- */

test('a corrupt rig normalizes to a complete one rather than a half-applied one', async () => {
    const { blankTurntable, normalizeTurntable } = await load();
    assert.deepEqual(normalizeTurntable(null), blankTurntable());
    assert.deepEqual(normalizeTurntable('nonsense'), blankTurntable());

    const salvaged = normalizeTurntable({
        arc: 999, direction: 'sideways', elevation: 'underground',
        framing: 'not-a-framing', lens: 'kaleidoscope', speed: 'briskly',
        startAngle: -45, subject: '  ',
    });
    assert.deepEqual(salvaged, { ...blankTurntable(), startAngle: 315 });

    // A rig that only sets what it means to keeps the rest.
    assert.equal(normalizeTurntable({ arc: 180 }).arc, 180);
    assert.equal(normalizeTurntable({ lockLighting: false }).lockLighting, false);
    assert.equal(normalizeTurntable({}).lockLighting, true);
});

/* ---------------- the wiring, end to end ---------------- */

// Deliberately textual: a gate that has to hold across a registry, a chip and a
// request is a chain of call sites, and a render sees only its last link.
test('the studio gates the panel on the vendor and pins the far end itself', () => {
    const studio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    const bar = fs.readFileSync(path.join(__dirname, '../src/studios/video/VideoComposerBar.jsx'), 'utf8');

    // The chip and the dialog read ONE gate, so a model switch cannot leave an
    // orbit panel open over a run that will not take the recipe.
    assert.match(studio, /const turntableAvailable = isMinimaxVendorModel\(model\) \|\| isMinimaxVendorModel\(s\.setup\)/);
    assert.match(studio, /\{Boolean\(s\.turntableOpen\) && turntableAvailable \? \(/);
    assert.match(bar, /\{turntableAvailable \? \(/);

    // Armed is read off the PROMPT, never from a flag beside it.
    assert.match(studio, /const turntableArmed = hasTurntable\(s\.setup\.prompt\)/);

    // The pin follows the composer's ONE end-frame rule rather than a second
    // copy of it, and it re-pins when the start picture changes underneath.
    assert.match(studio, /canPinEndFrame=\{endFrameVisible\}/);
    assert.match(studio, /if \(!turntableArmed \|\| !endFrameVisible\) return;/);
    assert.match(studio, /s\.setup = \{ \.\.\.s\.setup, endImageUrl: s\.setup\.imageUrl \};/);

    // Removing clears only the pin this feature made.
    assert.match(studio, /if \(s\.setup\.endImageUrl && s\.setup\.endImageUrl === s\.setup\.imageUrl\)/);

    // The armed chip lights the door it lives behind: hidden state that steers
    // a render must never be invisible.
    assert.match(bar, /\|\| Boolean\(turntableArmed\)/);
});

/* ---------------- the panel, actually mounted ---------------- */

// Source greps pass whether or not the file can execute. These render it: every
// import has to resolve and React has to build the tree before an assertion can
// look at it. (tests/helpers/render.js explains the idiom.)
const { renderComponent, textOf } = require('./helpers/render.js');

test('the panel mounts, and the dial draws the angle it names', async () => {
    const { blankTurntable } = await load();
    const markup = await renderComponent('src/studios/video/TurntableDialog.jsx', 'TurntablePanel', {
        open: true,
        rig: { ...blankTurntable(), startAngle: 90 },
        onRigChange() {},
        prompt: 'A bronze statue in a courtyard.',
        canPinEndFrame: true,
        startFrameUrl: 'blob:start',
        durationSeconds: 8,
    });
    const text = textOf(markup);

    // The dial is a real slider a keyboard can reach, and it says where it is.
    assert.match(markup, /role="slider"/);
    assert.match(markup, /aria-valuenow="90"/);
    assert.match(markup, /aria-valuetext="90 degrees — Right profile"/);
    // 90° is the camera at the subject's right, which in this top-down
    // projection is nine o'clock — x = centre - ring, y = centre.
    assert.match(markup, /cx="34"\s+cy="120"\s+r="9"/);

    // The preview shows the exact sentences that will be written.
    assert.match(text, /remains completely frozen in place, perfectly still like a statue/);
    assert.match(text, /no cuts/);
    // With a pinnable lane and a picture attached, the panel explains the pin
    // rather than warning about it.
    assert.match(text, /pins the start picture as the end frame/);
    assert.match(text, /Arm the capture/);
});

test('a lane that cannot close the loop says so in the panel, with the way out', async () => {
    const { blankTurntable } = await load();
    const markup = await renderComponent('src/studios/video/TurntableDialog.jsx', 'TurntablePanel', {
        open: true,
        rig: blankTurntable(),
        onRigChange() {},
        prompt: '',
        canPinEndFrame: false,
        startFrameUrl: '',
        durationSeconds: 6,
    });
    const text = textOf(markup);
    assert.match(text, /nothing to pin at either end/);
    assert.doesNotMatch(text, /Pick a lane/, 'no picture attached: the lane is not the problem yet');
    // No clip yet, so nothing offers to cut frames out of one.
    assert.doesNotMatch(text, /Export frames/);
});

test('an armed panel offers the way back out, and a finished clip opens on Review', async () => {
    const { applyTurntable, blankTurntable } = await load();
    const armed = applyTurntable('A bronze statue.', blankTurntable());
    const markup = await renderComponent('src/studios/video/TurntableDialog.jsx', 'TurntablePanel', {
        open: true,
        rig: blankTurntable(),
        onRigChange() {},
        prompt: armed,
        armed: true,
        canPinEndFrame: true,
        startFrameUrl: 'blob:start',
        resultUrl: 'blob:clip',
        durationSeconds: 8,
    });
    const text = textOf(markup);
    assert.match(text, /Update the capture/);
    assert.match(text, /Remove/);
    // The handoff to COLMAP appears only once there is a clip to cut up.
    assert.match(text, /Export frames/);
    assert.match(text, /One frame every 5\.1°/);
    // A clip in hand opens on the review side, where the dial turns the camera.
    assert.match(text, /drag to turn the camera/);
});
