// The H3 reference budget — four rations enforced at once, of which only the
// per-kind COUNT was ever visible in the panel. These tests pin the three that
// were invisible: the twelve-reference total, the three-audio-clip allowance a
// soundtrack eats into, and the per-kind 15-second total that a split
// soundtrack spends from twice.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/lib/h3References.js');

const pic = (n) => Array.from({ length: n }, (_, i) => `https://x/pic${i}.png`);
const clip = (n, useAudio = false) => Array.from({ length: n }, (_, i) => ({ url: `https://x/vid${i}.mp4`, useAudio }));
const voice = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://x/aud${i}.wav` }));
const codes = (report) => report.problems.map((p) => p.code);

test('an empty panel is within budget and reports nothing', async () => {
    const { referenceBudgetReport } = await load();
    const report = referenceBudgetReport({});
    assert.equal(report.ok, true);
    assert.deepEqual(report.problems, []);
    assert.equal(report.counts.total, 0);
});

test('nine pictures and three silent clips is exactly the twelve-reference limit', async () => {
    const { referenceBudgetReport, H3_REFERENCE_LIMITS } = await load();
    const report = referenceBudgetReport({ images: pic(9), videos: clip(3) });
    assert.equal(report.counts.total, 12);
    assert.equal(report.counts.total, H3_REFERENCE_LIMITS.totalReferences);
    assert.equal(report.ok, true, 'exactly at the limit is not over it');
});

test('a split soundtrack is its own reference, so it pushes a full row over twelve', async () => {
    const { referenceBudgetReport } = await load();
    // The same nine + three as above, but one clip brings its sound.
    const report = referenceBudgetReport({
        images: pic(9),
        videos: [...clip(2), { url: 'https://x/loud.mp4', useAudio: true }],
    });
    assert.equal(report.counts.total, 13, 'the soundtrack counts as a thirteenth reference');
    assert.equal(report.counts.soundtracks, 1);
    assert.ok(codes(report).includes('over-total'));
});

test('three clips with sound spend the whole three-audio-clip allowance', async () => {
    const { referenceBudgetReport } = await load();
    const loud = referenceBudgetReport({ images: pic(1), videos: clip(3, true) });
    assert.equal(loud.counts.audioClips, 3, 'soundtracks are audio clips');
    assert.ok(!codes(loud).includes('over-audio-clips'), 'exactly three is allowed');

    // One standalone voice clip on top is the fourth, which is not.
    const over = referenceBudgetReport({ images: pic(1), videos: clip(3, true), audios: voice(1) });
    assert.equal(over.counts.audioClips, 4);
    assert.ok(codes(over).includes('over-audio-clips'));
});

test('a split soundtrack spends from BOTH duration totals at once', async () => {
    const { referenceBudgetReport } = await load();
    // The README's worked example: a 12s video with its audio on uses 12 of the
    // 15 video seconds AND 12 of the 15 audio seconds.
    const report = referenceBudgetReport({
        images: pic(1),
        videos: [{ url: 'v', useAudio: true }],
        durations: { v: 12 },
    });
    assert.equal(report.seconds.video, 12);
    assert.equal(report.seconds.audio, 12, 'the same seconds are billed twice');
    assert.equal(report.ok, true, '12 is under 15 on both counts');

    // Which leaves only 3 seconds of audio for anything else — a 5s voice clip
    // busts the audio total while the video total is still fine.
    const plusVoice = referenceBudgetReport({
        images: pic(1),
        videos: [{ url: 'v', useAudio: true }],
        audios: [{ url: 'a' }],
        durations: { v: 12, a: 5 },
    });
    assert.equal(plusVoice.seconds.video, 12, 'the voice clip adds nothing to video');
    assert.equal(plusVoice.seconds.audio, 17);
    assert.ok(codes(plusVoice).includes('over-audio-seconds'));
    assert.ok(!codes(plusVoice).includes('over-video-seconds'));
    // The fix depends on knowing a soundtrack is involved, so it is reported.
    const problem = plusVoice.problems.find((p) => p.code === 'over-audio-seconds');
    assert.equal(problem.soundtracks, 1);
});

test('fifteen seconds is the total for a kind, not a per-clip allowance', async () => {
    const { referenceBudgetReport } = await load();
    // Three 15s clips is 45s — each one legal on its own, three times over together.
    const report = referenceBudgetReport({
        images: pic(1),
        videos: [{ url: 'a' }, { url: 'b' }, { url: 'c' }],
        durations: { a: 15, b: 15, c: 15 },
    });
    assert.equal(report.seconds.video, 45);
    assert.ok(codes(report).includes('over-video-seconds'));
    assert.ok(!codes(report).includes('clip-too-long'), 'no single clip is over');

    // Three at five seconds each is the shape that fits.
    const fits = referenceBudgetReport({
        images: pic(1),
        videos: [{ url: 'a' }, { url: 'b' }, { url: 'c' }],
        durations: { a: 5, b: 5, c: 5 },
    });
    assert.equal(fits.seconds.video, 15);
    assert.equal(fits.ok, true);
});

test('each clip is flagged outside 2-15 seconds', async () => {
    const { referenceBudgetReport } = await load();
    const report = referenceBudgetReport({
        images: pic(1),
        videos: [{ url: 'short' }, { url: 'long' }],
        durations: { short: 1.2, long: 16 },
    });
    const short = report.problems.find((p) => p.code === 'clip-too-short');
    const long = report.problems.find((p) => p.code === 'clip-too-long');
    assert.ok(short && short.url === 'short' && short.seconds === 1.2);
    assert.ok(long && long.url === 'long' && long.seconds === 16);
});

test('audio cannot be the only thing attached', async () => {
    const { referenceBudgetReport } = await load();
    const alone = referenceBudgetReport({ audios: voice(1), durations: { 'https://x/aud0.wav': 5 } });
    assert.ok(codes(alone).includes('audio-without-visual'));

    // One picture is enough to make it legal.
    const withPicture = referenceBudgetReport({ images: pic(1), audios: voice(1), durations: { 'https://x/aud0.wav': 5 } });
    assert.ok(!codes(withPicture).includes('audio-without-visual'));

    // A video counts as the visual too.
    const withVideo = referenceBudgetReport({ videos: clip(1), audios: voice(1), durations: { 'https://x/aud0.wav': 5 } });
    assert.ok(!codes(withVideo).includes('audio-without-visual'));
});

test('unmeasured clips are reported as unmeasured, never guessed at', async () => {
    const { referenceBudgetReport } = await load();
    const report = referenceBudgetReport({
        images: pic(1),
        videos: [{ url: 'known' }, { url: 'unknown' }],
        durations: { known: 9 },
    });
    assert.equal(report.measured, 1);
    assert.equal(report.unmeasured, 1);
    // Only the measured clip is billed — a guess would produce a false warning.
    assert.equal(report.seconds.video, 9);
    assert.equal(report.ok, true);

    // Junk in the duration map is treated as unmeasured rather than as zero,
    // because a zero-second clip would trip the too-short rule for no reason.
    for (const bad of [0, -3, Number.NaN, null, undefined, 'abc']) {
        const junk = referenceBudgetReport({
            images: pic(1), videos: [{ url: 'v' }], durations: { v: bad },
        });
        assert.equal(junk.unmeasured, 1, `${String(bad)} is not a measurement`);
        assert.equal(junk.seconds.video, 0);
        assert.deepEqual(junk.problems, []);
    }
});

test('counts stay right when every ration is blown at once', async () => {
    const { referenceBudgetReport } = await load();
    const report = referenceBudgetReport({
        images: pic(9),
        videos: clip(3, true),
        audios: voice(2),
        durations: {
            'https://x/vid0.mp4': 16, 'https://x/vid1.mp4': 16, 'https://x/vid2.mp4': 16,
            'https://x/aud0.wav': 16, 'https://x/aud1.wav': 16,
        },
    });
    // 9 pictures + 3 videos + 3 soundtracks + 2 voice clips.
    assert.equal(report.counts.total, 17);
    assert.equal(report.counts.audioClips, 5);
    const found = new Set(codes(report));
    for (const code of ['over-total', 'over-audio-clips', 'clip-too-long', 'over-video-seconds', 'over-audio-seconds']) {
        assert.ok(found.has(code), `${code} reported`);
    }
    assert.equal(report.ok, false);
});

test('a sound-only motion row spends an audio slot and audio seconds, never a video slot', async () => {
    const { referenceBudgetReport } = await load();
    const report = referenceBudgetReport({
        images: ['/p'],
        videos: [{ url: '/m.mov', useAudio: false }, { url: '/s.mov', motion: false, useAudio: true }],
        audios: [],
        durations: { '/m.mov': 6, '/s.mov': 9 },
    });
    assert.equal(report.counts.videos, 1);
    assert.equal(report.counts.audioClips, 1);
    assert.equal(report.counts.soundtracks, 1);
    assert.equal(report.counts.total, 3);
    assert.equal(report.seconds.video, 6);
    assert.equal(report.seconds.audio, 9);
    assert.deepEqual(report.problems, []);
    // Sound only with no picture and no motion clip has nothing to attach to.
    const alone = referenceBudgetReport({
        images: [], videos: [{ url: '/s.mov', motion: false, useAudio: true }], audios: [], durations: { '/s.mov': 5 },
    });
    assert.ok(alone.problems.some((problem) => problem.code === 'audio-without-visual'));
});
