const test = require('node:test');
const assert = require('node:assert/strict');

test('lip sync preferences retain input mode, model, and resolution', async () => {
    const { normalizeLipSyncPreferences } = await import('../src/studios/lipSyncPrefs.js');

    assert.deepEqual(normalizeLipSyncPreferences({
        inputMode: 'video',
        modelId: ' sync-model ',
        resolution: ' 720p ',
    }), {
        inputMode: 'video',
        modelId: 'sync-model',
        resolution: '720p',
    });
    assert.equal(normalizeLipSyncPreferences({ inputMode: 'image', modelId: '' }), null);
});

test('cinema preferences retain valid camera-generation settings and discard stale options', async () => {
    const { normalizeCinemaPreferences } = await import('../src/studios/cinemaPrefs.js');
    const { CAMERA_MAP, LENS_MAP } = await import('../src/lib/promptUtils.js');
    const camera = Object.keys(CAMERA_MAP)[1];
    const lens = Object.keys(LENS_MAP)[1];

    assert.deepEqual(normalizeCinemaPreferences({
        aspect_ratio: '9:16',
        resolution: '4K',
        camera,
        lens,
        focal: 50,
        aperture: 'f/4',
    }), {
        aspect_ratio: '9:16',
        resolution: '4K',
        camera,
        lens,
        focal: 50,
        aperture: 'f/4',
    });

    const fallback = normalizeCinemaPreferences({
        aspect_ratio: 'removed',
        resolution: '8K',
        camera: 'removed',
        lens: 'removed',
        focal: 999,
        aperture: 'f/0.2',
    });
    assert.equal(fallback.aspect_ratio, '16:9');
    assert.equal(fallback.resolution, '2K');
    assert.equal(fallback.camera, Object.keys(CAMERA_MAP)[0]);
    assert.equal(fallback.lens, Object.keys(LENS_MAP)[0]);
    assert.equal(fallback.focal, 35);
    assert.equal(fallback.aperture, 'f/1.4');
});

// The studios must keep reading these through the shared modules — an inline copy
// would drift from what this file tests and from what the studio actually persists.
test('cinema and lip sync studios use the shared preference normalizers', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const cinema = fs.readFileSync(path.join(__dirname, '../src/studios/CinemaStudio.jsx'), 'utf8');
    const lipsync = fs.readFileSync(path.join(__dirname, '../src/studios/LipSyncStudio.jsx'), 'utf8');

    assert.match(cinema, /from '\.\/cinemaPrefs\.js'/);
    assert.doesNotMatch(cinema, /function normalizeCinemaPreferences/);
    assert.match(lipsync, /from '\.\/lipSyncPrefs\.js'/);
    assert.doesNotMatch(lipsync, /function normalizeLipSyncPreferences/);
});
