const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The camera rig is what the Cinema studio was: buildNanoBananaPrompt's clause,
// now a composer scaffold in the Image studio. The rule that matters is the same
// one UGC mode has — re-arming REPLACES the block, it never stacks a second one.

const load = () => import('../src/lib/cameraRig.js');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('arming writes the clause Cinema wrote, after the scene', async () => {
    const { applyCameraRig, DEFAULT_CAMERA_RIG, hasCameraRig } = await load();
    const { buildNanoBananaPrompt } = await import('../src/lib/promptUtils.js');
    const rig = DEFAULT_CAMERA_RIG;

    const armed = applyCameraRig('a lighthouse in fog', rig);
    assert.equal(armed, buildNanoBananaPrompt('a lighthouse in fog', rig.camera, rig.lens, rig.focal, rig.aperture));
    assert.ok(hasCameraRig(armed));
    assert.ok(armed.startsWith('a lighthouse in fog, shot on a '));
    assert.ok(armed.endsWith('8K resolution'));
});

test('re-arming replaces the rig clause instead of stacking a second one', async () => {
    const { applyCameraRig, CAMERA_OPTIONS, DEFAULT_CAMERA_RIG, LENS_OPTIONS } = await load();

    const once = applyCameraRig('a lighthouse in fog', DEFAULT_CAMERA_RIG);
    const twice = applyCameraRig(once, { ...DEFAULT_CAMERA_RIG, camera: CAMERA_OPTIONS[2], lens: LENS_OPTIONS[3], focal: 85, aperture: 'f/11' });
    const thrice = applyCameraRig(twice, { ...DEFAULT_CAMERA_RIG, focal: 24 });

    const occurrences = (text, needle) => text.split(needle).length - 1;
    for (const prompt of [twice, thrice]) {
        assert.equal(occurrences(prompt, 'shot on a '), 1, 'exactly one rig clause');
        assert.equal(occurrences(prompt, '8K resolution'), 1);
        assert.equal(occurrences(prompt, 'a lighthouse in fog'), 1, 'the scene survives untouched');
        assert.ok(prompt.startsWith('a lighthouse in fog, '));
    }
    // The newest rig is the one that is left.
    assert.ok(thrice.includes('at 24mm'));
    assert.ok(!thrice.includes('at 85mm'));
});

test('turning the rig off leaves the scene exactly as it was', async () => {
    const { applyCameraRig, DEFAULT_CAMERA_RIG, hasCameraRig } = await load();
    const scene = 'a lighthouse in fog';

    const armed = applyCameraRig(scene, DEFAULT_CAMERA_RIG);
    assert.equal(applyCameraRig(armed, null), scene);
    assert.equal(hasCameraRig(scene), false);
    // Armed over an empty composer, clearing leaves nothing behind.
    assert.equal(applyCameraRig(applyCameraRig('', DEFAULT_CAMERA_RIG), null), '');
});

test('a rig the user edited by hand still comes out cleanly (anchored, not matched whole)', async () => {
    const { applyCameraRig, DEFAULT_CAMERA_RIG } = await load();
    const armed = applyCameraRig('a lighthouse in fog', DEFAULT_CAMERA_RIG)
        .replace('cinematic lighting', 'hard side lighting');

    const rearmed = applyCameraRig(armed, DEFAULT_CAMERA_RIG);
    assert.equal(rearmed.split('shot on a ').length - 1, 1);
    assert.ok(!rearmed.includes('hard side lighting'), 'the edited clause was replaced, not kept beside the new one');
});

test('the rig is bounded — a corrupt blob restores a valid rig, never junk', async () => {
    const { normalizeCameraRig, DEFAULT_CAMERA_RIG, cameraRigSentence } = await load();

    assert.deepEqual(normalizeCameraRig(null), { ...DEFAULT_CAMERA_RIG });
    assert.deepEqual(normalizeCameraRig({
        camera: '<script>', lens: 42, focal: 9999, aperture: 'f/0.2',
    }), { ...DEFAULT_CAMERA_RIG });
    assert.ok(!cameraRigSentence({ camera: '<script>' }).includes('<script>'));
});

test('image preferences persist the rig, bounded by the same normalizer', async () => {
    const { normalizeImagePreferences } = await import('../src/studios/image/imagePrefs.js');
    const { CAMERA_OPTIONS, DEFAULT_CAMERA_RIG } = await load();

    const kept = normalizeImagePreferences({ modelId: 'krea', cameraRig: { camera: CAMERA_OPTIONS[1], lens: 'nope', focal: 85, aperture: 'f/4' } });
    assert.deepEqual(kept.cameraRig, { camera: CAMERA_OPTIONS[1], lens: DEFAULT_CAMERA_RIG.lens, focal: 85, aperture: 'f/4' });
    assert.deepEqual(normalizeImagePreferences({ modelId: 'krea' }).cameraRig, { ...DEFAULT_CAMERA_RIG });
});

test('Cinema is gone as a page, but ?page=cinema still resolves to Image with the Camera menu', () => {
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'src/studios/CinemaStudio.jsx')), false);
    const nav = read('src/app/navConfig.jsx');
    assert.doesNotMatch(nav, /page: 'cinema'/, 'no Cinema tab in the sidebar');
    assert.doesNotMatch(nav, /'cinema',/, 'cinema is not a studio page any more');
    assert.match(nav, /cinema: \{ page: 'image', menu: 'camera' \}/, 'the page key still resolves');
    assert.match(nav, /PAGE_ALIASES\[page\]/, 'isKnownPage accepts the retired key');

    const app = read('src/app/App.jsx');
    assert.doesNotMatch(app, /CinemaStudio/);
    assert.match(app, /requestComposerMenu\(alias\.page, alias\.menu\)/);

    const image = read('src/studios/ImageStudio.jsx');
    assert.match(image, /<CameraMenu/, 'the Image composer has the Camera menu');
    assert.match(image, /takeComposerMenuRequest\('image', 'camera'\)/, 'and the route can open it');

    // Cinema's headline is not lost — the composer placeholder is fixed, so it
    // asks its question from the menu.
    assert.match(read('src/studios/image/CameraMenu.jsx'), /What would you shoot with infinite budget\?/);
    assert.doesNotMatch(read('src/lib/i18n.js'), /'cinema\./, 'the cinema-only strings are gone');
});
