const test = require('node:test');
const assert = require('node:assert/strict');

// The camera is five decisions H3 reads in a fixed order. The sentences below
// ARE the contract — a shot that reads differently is a different shot.
const load = () => import('../src/lib/h3Camera.js');

test('an unset camera contributes nothing', async () => {
    const { blankCamera, cameraInstruction, cameraIsSet } = await load();
    assert.equal(cameraInstruction(blankCamera()), '');
    assert.equal(cameraIsSet(blankCamera()), false);
    assert.equal(cameraIsSet(null), false);
});

test('framing, viewpoint and composition become one opening sentence', async () => {
    const { blankCamera, cameraSentences } = await load();
    const parts = cameraSentences(
        { ...blankCamera(), framing: 'medium', viewpoint: 'front', composition: 'centered' },
        { subject: '<Subject 1>' },
    );
    assert.equal(
        parts.framing,
        'A medium shot frames <Subject 1> from the waist up, with the camera directly in front of <Subject 1>; <Subject 1> is centred in the frame.',
    );
});

test('a close-up of a person means their face unless a detail says otherwise', async () => {
    const { blankCamera, cameraSentences } = await load();
    const face = cameraSentences({ ...blankCamera(), framing: 'close_up' }, { subject: 'Ada' });
    assert.match(face.framing, /a close-up frames Ada's face and head/i);
    const hands = cameraSentences({ ...blankCamera(), framing: 'close_up', focusArea: 'hands' }, { subject: 'Ada' });
    assert.match(hands.framing, /Ada's hands/);
});

test('the move is third person, and H3 qualifiers land on the verb', async () => {
    const { blankCamera, cameraSentences } = await load();
    const parts = cameraSentences(
        { ...blankCamera(), moveId: 'dolly-in', amplitude: 'with small amplitude', speed: 'at slow speed' },
        { subject: '<Subject 1>' },
    );
    // "dollies", not "dolly" — the camera is the subject of the sentence — and
    // the qualifiers sit before the target, which is where H3 reads them.
    assert.equal(parts.move, 'The camera dollies forward with small amplitude at slow speed toward <Subject 1>.');
});

test('timing decides where in the shot the move is stated', async () => {
    const { blankCamera, cameraSentences } = await load();
    const during = cameraSentences({ ...blankCamera(), moveId: 'pan-left', timing: 'during_dialogue' });
    assert.match(during.move, /^During the dialogue, the camera pans smoothly to the left\./);
    const after = cameraSentences({ ...blankCamera(), moveId: 'pan-left', timing: 'after_opening_action' });
    assert.equal(after.move, 'The camera pans smoothly to the left.');
});

test('stability with no move is a held camera, not a silent field', async () => {
    const { blankCamera, cameraSentences } = await load();
    const held = cameraSentences({ ...blankCamera(), stability: 'locked' });
    assert.equal(held.move, 'The camera holds a locked-off static composition with no shake.');
    const moving = cameraSentences({ ...blankCamera(), moveId: 'zoom-in', stability: 'locked' });
    assert.match(moving.move, /with rigid, shake-free stabilisation\.$/);
});

test('the end frame reads as a noun phrase, never a second clause', async () => {
    const { blankCamera, cameraSentences } = await load();
    const parts = cameraSentences(
        { ...blankCamera(), moveId: 'dolly-in', endFraming: 'close_up', endFocusArea: 'face' },
        { subject: '<Subject 1>' },
    );
    // "ends on a close-up OF …" — "ends on a close-up frames …" is the bug this
    // test exists for.
    assert.equal(parts.endFrame, "The move ends on a close-up of <Subject 1>'s face and head.");
});

test('an end note with no end framing still ends the shot', async () => {
    const { blankCamera, cameraSentences } = await load();
    const parts = cameraSentences({ ...blankCamera(), endNote: 'the door closes behind her' });
    assert.equal(parts.endFrame, 'The shot ends the door closes behind her.');
});

test('a POV viewpoint is stated as a position, not folded into the framing', async () => {
    const { blankCamera, cameraSentences } = await load();
    const parts = cameraSentences({ ...blankCamera(), framing: 'medium', viewpoint: 'pov' }, { subject: 'Ada' });
    assert.ok(!parts.framing.includes('point of view'));
    assert.equal(parts.position, "The shot is seen from Ada's point of view.");
});

test('custom camera text replaces the generated move outright', async () => {
    const { blankCamera, cameraSentences } = await load();
    const parts = cameraSentences({ ...blankCamera(), moveId: 'dolly-in', custom: 'the camera swings wildly, losing her for a moment' });
    assert.equal(parts.move, 'The camera swings wildly, losing her for a moment.');
});

test('the move list is the studio-wide one, plus a hold', async () => {
    const { CAMERA_MOVE_OPTIONS } = await load();
    const { CAMERA_MOTIONS } = await import('../src/lib/cameraMotion.js');
    assert.equal(CAMERA_MOVE_OPTIONS[0][0], '');
    assert.equal(CAMERA_MOVE_OPTIONS.length, CAMERA_MOTIONS.length + 1);
});

test('every shared move carries a third-person form for prose', async () => {
    const { CAMERA_MOTIONS } = await import('../src/lib/cameraMotion.js');
    for (const motion of CAMERA_MOTIONS) {
        assert.equal(typeof motion.moves, 'string', `${motion.id} has no third-person form`);
        assert.ok(motion.moves.length > 0, `${motion.id} has an empty third-person form`);
    }
});
