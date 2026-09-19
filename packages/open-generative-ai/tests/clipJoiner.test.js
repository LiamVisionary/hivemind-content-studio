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

// --- does this clip carry sound? --------------------------------------------
//
// The stage's "Sound" badge used to be `/minimax/.test(model)`, under a comment
// saying other lanes were silent. True when written; wrong since LTX 2.3, which
// denoises a JOINT audio+video latent and scores every clip it renders — so
// every LTX clip went unbadged. A name test also cannot tell a graph that wires
// the audio out from one that samples it and drops it, which this codebase has
// actually shipped (the eros v1.4 graph decoded only the picture half).
//
// So the badge asks the FILE now, through the probe clipPrep already uses for
// the last-frame grab. Real clips, real mediabunny — the same code the browser
// runs — because "it reports the track that is there" is the whole claim.
test('probeClip reports the audio track a clip does or does not have', { skip: !haveFfmpeg() }, async () => {
    const { probeClip } = await import('../src/lib/clipPrep.js');
    const dir = mkdtempSync(join(tmpdir(), 'clipaudio-'));
    try {
        const scored = join(dir, 'scored.mp4');
        const silent = join(dir, 'silent.mp4');
        makeClip(scored, 2, 440);
        // The same clip WITHOUT the sine: one ffmpeg input, no audio stream.
        execFileSync('ffmpeg', [
            '-y', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc2=size=192x128:rate=12:duration=2',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent,
        ], { timeout: 60000 });

        const withSound = await probeClip(new Blob([readFileSync(scored)]));
        assert.equal(withSound.hasAudio, true);
        assert.equal(withSound.audioCodec, 'aac');

        const without = await probeClip(new Blob([readFileSync(silent)]));
        assert.equal(without.hasAudio, false, 'a video-only clip must not claim sound');
        assert.equal(without.audioCodec, null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// Deliberately textual: the claim is WHICH hook the stage badge is wired to,
// and the hook answers from an effect — effects never run under a server
// render, so a render of VideoStudio would show the same empty badge either
// way. The behaviour it rests on (does probeClip see the track?) is the real
// test above, and the live path was driven in a browser against one scored and
// one silent clip on the same lane.
test('the Sound badge reads the clip, not the model name', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const studio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    assert.doesNotMatch(studio, /clipHasAudio=\{\/minimax\//,
        'the badge is guessing from the model again — LTX 2.3 renders audio too');
    assert.match(studio, /const clipHasAudio = useClipHasAudio\(s\.resultUrl\);/);

    const hooks = fs.readFileSync(path.join(__dirname, '../src/hooks/hooks.js'), 'utf8');
    // Dynamic import on purpose: clipPrep carries mediabunny, which should not
    // weigh down the studio chunk just to badge a clip.
    assert.match(hooks, /await import\('\.\.\/lib\/clipPrep\.js'\)/);
    // Unknown answers "no badge", never a guessed yes.
    assert.match(hooks, /clipAudioCache\.set\(resolved, false\);/);
});

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
