// Camera motion phrase composer — adapted from Mix-Studio's camera-motion tests
// (BlackMixture/Mix-Studio, GPL-3.0). Asset/DOM assertions dropped: we ship the
// motion catalog and composer, not their preview MP4s.
const test = require('node:test');
const assert = require('node:assert/strict');

test('camera motion catalog covers core and handheld/FPV collections', async () => {
    const { CAMERA_MOTIONS } = await import('../src/lib/cameraMotion.js');
    assert.ok(CAMERA_MOTIONS.length >= 24);
    assert.ok(CAMERA_MOTIONS.some((m) => m.id === 'pan-left' && m.collection === 'Core moves'));
    assert.ok(CAMERA_MOTIONS.some((m) => m.id === 'handheld-orbit-cw' && m.collection === 'Handheld & FPV'));
    assert.ok(CAMERA_MOTIONS.some((m) => m.id === 'fpv-zoom-track-right'));
    for (const motion of CAMERA_MOTIONS) {
        assert.ok(motion.clause && motion.step && motion.label, `${motion.id} is fully described`);
    }
});

test('selections preserve order, reject duplicates and unknown ids, cap at three', async () => {
    const { normalizeCameraMotions, cameraMotionPhrase } = await import('../src/lib/cameraMotion.js');
    assert.deepEqual(
        normalizeCameraMotions(['truck-left', 'truck-left', 'zoom-in', 'bad-id', 'tilt-up', 'roll-cw']),
        ['truck-left', 'zoom-in', 'tilt-up'],
    );
    assert.equal(
        cameraMotionPhrase(['truck-left', 'zoom-in', 'tilt-up']),
        'Camera motion: begin with a lateral truck to the left, continue with an optical zoom in, and finish with an upward tilt.',
    );
    assert.equal(cameraMotionPhrase(['pan-left']), 'Camera motion: pan smoothly to the left.');
    assert.equal(cameraMotionPhrase([]), '');
});

test('applying a new selection replaces the previous phrase instead of stacking', async () => {
    const { applyCameraMotionPrompt } = await import('../src/lib/cameraMotion.js');
    const first = applyCameraMotionPrompt('A person crosses the street', '', ['pan-left']);
    assert.match(first.prompt, /Camera motion: pan smoothly to the left\.$/);

    const second = applyCameraMotionPrompt(first.prompt, first.phrase, ['dolly-in', 'nope', 'roll-cw']);
    assert.doesNotMatch(second.prompt, /pan smoothly/);
    assert.match(second.prompt, /begin with a forward dolly toward the subject, then use a clockwise roll/);

    // Clearing removes the phrase (the strip also consumes the separator
    // punctuation that applying added — donor behavior, kept as-is).
    const cleared = applyCameraMotionPrompt(second.prompt, second.phrase, []);
    assert.equal(cleared.prompt, 'A person crosses the street');
    assert.equal(cleared.phrase, '');
});

test('the phrase applies onto an empty prompt and respects ending punctuation', async () => {
    const { applyCameraMotionPrompt } = await import('../src/lib/cameraMotion.js');
    const onlyPhrase = applyCameraMotionPrompt('', '', ['zoom-in']);
    assert.equal(onlyPhrase.prompt, 'Camera motion: zoom in optically.');

    const punctuated = applyCameraMotionPrompt('Night market, rain-soaked streets!', '', ['tilt-up']);
    assert.equal(punctuated.prompt, 'Night market, rain-soaked streets! Camera motion: tilt upward.');
});
