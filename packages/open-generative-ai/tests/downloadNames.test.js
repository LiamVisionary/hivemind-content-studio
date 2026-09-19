const test = require('node:test');
const assert = require('node:assert/strict');

test('local image downloads are named after the model, not the app', async () => {
    const { imageDownloadName } = await import('../src/lib/downloadNames.js');
    // The bug: this used to produce 'muapi-1234.jpg' for a purely local generation.
    assert.equal(
        imageDownloadName('local:comfy-auto-wai-anima-native-06b', '1234'),
        'wai-anima-native-06b-1234.jpg',
    );
    assert.equal(imageDownloadName('seedance-v2.0-t2v', 'abc'), 'seedance-v2-0-t2v-abc.jpg');
});

test('video downloads carry the model prefix', async () => {
    const { videoDownloadName } = await import('../src/lib/downloadNames.js');
    // The bug: this used to produce 'video-9.mp4' with no model at all.
    assert.equal(
        videoDownloadName('hivemind-media:ltx23-eros-fast', '9'),
        'ltx23-eros-fast-9.mp4',
    );
    // url-encoded workflow ids decode before slugging
    assert.equal(
        videoDownloadName(`hivemind-media:${encodeURIComponent('ltx23-ic-ingredients-lora')}`, '2'),
        'ltx23-ic-ingredients-lora-2.mp4',
    );
    assert.equal(videoDownloadName('wan2gp:flux-dev', '3'), 'flux-dev-3.mp4');
});

test('decorated and missing model labels degrade gracefully', async () => {
    const { imageDownloadName, videoDownloadName } = await import('../src/lib/downloadNames.js');
    // An upscale entry's decorated label stays readable.
    assert.equal(imageDownloadName('Anima · upscaled (max)', 'x1'), 'anima-upscaled-max-x1.jpg');
    // Legacy entries with no model fall back to the media kind, never the app name.
    assert.equal(imageDownloadName('', '7'), 'image-7.jpg');
    assert.equal(videoDownloadName(undefined, '7'), 'video-7.mp4');
    // No id at all still yields a valid filename.
    assert.equal(videoDownloadName('hivemind-media:ltx23-eros-fast', ''), 'ltx23-eros-fast.mp4');
});

test('filenames stay filesystem-safe', async () => {
    const { mediaDownloadName } = await import('../src/lib/downloadNames.js');
    const name = mediaDownloadName('local:../../etc/passwd', 'a/b c', 'png');
    assert.ok(!name.includes('/'), `expected no path separators, got ${name}`);
    assert.ok(!name.includes('..'), `expected no traversal, got ${name}`);
    assert.equal(name, 'etc-passwd-a-b-c.png');
});
