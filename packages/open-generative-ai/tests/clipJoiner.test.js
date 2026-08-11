// Lossless client-side clip join — REAL end-to-end: two ffmpeg-made clips are
// packet-copy concatenated through mediabunny (the same code the browser runs;
// it is pure JS, so Node exercises it exactly), then ffprobe verifies the
// result. Plus the chain-lineage walker.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

function haveFfmpeg() {
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function makeClip(path, seconds, freq) {
    execFileSync('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `testsrc2=size=192x128:rate=12:duration=${seconds}`,
        '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path,
    ], { timeout: 60000 });
}

function probe(path) {
    const out = execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'stream=codec_type,nb_frames,duration',
        '-show_entries', 'format=duration', '-of', 'json', path,
    ], { timeout: 30000 }).toString();
    return JSON.parse(out);
}

test('joinClips packet-copies two clips into one MP4 with audio', { skip: !haveFfmpeg() }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clipjoin-'));
    try {
        const a = join(dir, 'a.mp4');
        const b = join(dir, 'b.mp4');
        makeClip(a, 2, 440);
        makeClip(b, 3, 660);

        const { joinClips } = await import('../src/lib/clipJoiner.js');
        const result = await joinClips([
            new Blob([readFileSync(a)], { type: 'video/mp4' }),
            new Blob([readFileSync(b)], { type: 'video/mp4' }),
        ]);
        assert.ok(result.audioJoined, 'both clips carry audio, so the join must');
        assert.ok(Math.abs(result.seconds - 5) < 0.25, `joined duration ~5s, got ${result.seconds}`);

        const out = join(dir, 'joined.mp4');
        writeFileSync(out, Buffer.from(await result.blob.arrayBuffer()));
        const info = probe(out);
        const types = info.streams.map((s) => s.codec_type).sort();
        assert.deepEqual(types, ['audio', 'video']);
        const video = info.streams.find((s) => s.codec_type === 'video');
        // 12fps x 5s = 60 frames, bit-copied — none dropped, none re-encoded.
        assert.equal(Number(video.nb_frames), 60);
        assert.ok(Math.abs(Number(info.format.duration) - 5) < 0.3);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('joinClips refuses mismatched resolutions instead of silently re-encoding', { skip: !haveFfmpeg() }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clipjoin-'));
    try {
        const a = join(dir, 'a.mp4');
        const b = join(dir, 'b.mp4');
        makeClip(a, 1, 440);
        execFileSync('ffmpeg', [
            '-y', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc2=size=256x160:rate=12:duration=1',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', b,
        ], { timeout: 60000 });
        const { joinClips } = await import('../src/lib/clipJoiner.js');
        await assert.rejects(
            joinClips([
                new Blob([readFileSync(a)], { type: 'video/mp4' }),
                new Blob([readFileSync(b)], { type: 'video/mp4' }),
            ]),
            /different resolution/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('collectChainClips walks lineage oldest-first and survives gaps', async () => {
    const { collectChainClips } = await import('../src/lib/chainLineage.js');
    const history = [
        { url: 'u3', chainFromUrl: 'u2', chainShot: 3 },
        { url: 'u2', chainFromUrl: 'u1', chainShot: 2 },
        { url: 'u1' },
        { url: 'other' },
    ];
    const chain = collectChainClips(history[0], history);
    assert.deepEqual(chain.map((e) => e.url), ['u1', 'u2', 'u3']);
    // A pruned predecessor ends the walk instead of throwing.
    const partial = collectChainClips({ url: 'u9', chainFromUrl: 'missing' }, history);
    assert.deepEqual(partial.map((e) => e.url), ['u9']);
    // An unchained entry is just itself.
    assert.equal(collectChainClips(history[3], history).length, 1);
});
