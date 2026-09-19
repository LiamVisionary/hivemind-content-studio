import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_FRAME_COUNT, cellSignature, sampleTimes, sheetLayout } from '../src/lib/contactSheet.js';

test('sample times skip the first and last frames', () => {
    // Both are routinely black or a fade, and on a six-cell sheet that wastes
    // a third of what the model gets to look at.
    const times = sampleTimes(6, 6);
    assert.equal(times.length, 6);
    assert.ok(times[0] > 0, 'never samples frame zero');
    assert.ok(times[times.length - 1] < 6, 'never samples the final frame');
    // Evenly spaced and strictly increasing, so the sheet reads as a timeline.
    const gaps = times.slice(1).map((t, i) => Number((t - times[i]).toFixed(4)));
    assert.equal(new Set(gaps).size, 1, `expected even spacing, got ${gaps}`);
});

test('a clip shorter than the sample window still yields ordered frames', () => {
    const times = sampleTimes(0.2, 6);
    assert.equal(times.length, 6);
    assert.deepEqual([...times].sort((a, b) => a - b), times);
    assert.ok(times.every((t) => t >= 0 && t <= 0.2));
});

test('an undecodable duration yields nothing rather than NaN times', () => {
    // A video whose metadata never loaded reports NaN/Infinity duration; the
    // caller falls back to writing from the idea alone.
    for (const duration of [NaN, 0, -1, Infinity]) {
        assert.deepEqual(sampleTimes(duration, DEFAULT_FRAME_COUNT), []);
    }
});

test('layout stays a single row for short sets and squares up after', () => {
    assert.deepEqual(sheetLayout(2), { columns: 2, rows: 1 });
    assert.deepEqual(sheetLayout(3), { columns: 3, rows: 1 });
    assert.deepEqual(sheetLayout(4), { columns: 2, rows: 2 });
    assert.deepEqual(sheetLayout(6), { columns: 3, rows: 2 });
    assert.deepEqual(sheetLayout(9), { columns: 3, rows: 3 });
});

test('cell signatures separate different frames and match identical ones', () => {
    // The guard that refuses a sheet of six identical frames rests entirely on
    // this: a MediaRecorder webm has no seek index, so every seek lands on
    // frame one and the sheet would read as motion the clip does not have.
    const fakeContext = (fill) => ({
        getImageData: (x, y, w, h) => ({
            data: Uint8ClampedArray.from(
                { length: w * h * 4 },
                (_, i) => (i % 4 === 3 ? 255 : fill(Math.floor(i / 4) % w, Math.floor(Math.floor(i / 4) / w))),
            ),
        }),
    });
    const flat = cellSignature(fakeContext(() => 40), 0, 0, 64, 64);
    const flatAgain = cellSignature(fakeContext(() => 40), 0, 0, 64, 64);
    const gradient = cellSignature(fakeContext((x) => (x * 4) % 256), 0, 0, 64, 64);

    assert.equal(flat, flatAgain, 'identical pixels must produce an identical signature');
    assert.notEqual(flat, gradient, 'different pixels must produce a different signature');
});
