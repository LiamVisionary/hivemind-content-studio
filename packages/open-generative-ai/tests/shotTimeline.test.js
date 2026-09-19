import test from 'node:test';
import assert from 'node:assert/strict';

import { fitShotTimeline, shotStartTimes, timelineOverruns } from '../src/lib/shotTimeline.js';
import { DEFAULT_PROMPTS } from '../src/lib/defaultPrompts.js';

test('a shot stamped past the end of the clip is found, and prose is not', () => {
    const prompt = '[Shot 1] She waits. [Shot 2] At 00:05.000, she leaves.\n[Shot 3] At 00:10.000, she returns.';
    assert.deepEqual(timelineOverruns(prompt, 10), [10]);
    assert.deepEqual(timelineOverruns(prompt, 15), []);
    // A time the SCENE contains is not a beat: rewriting it would change what
    // the shot depicts.
    assert.deepEqual(shotStartTimes('The clock reads At 09:30, and she leaves.'), []);
    // No duration known is not the same as everything fitting.
    assert.deepEqual(timelineOverruns(prompt, null), []);
});

test('the H3 starter refits onto a 10s clip instead of losing its last beat', () => {
    // The exact shape that failed: the Korean-home-video H3 starter is a fixed
    // 15s script (shots at 00:00, 00:05, 00:10) and the reference budget caps
    // the clip at 10s once pictures are attached, so [Shot 3] never rendered.
    const prompt = '[Shot 1] A man sits. [Shot 2] At 00:05.000, he walks. [Shot 3] At 00:10.000, he hangs laundry.';
    const fitted = fitShotTimeline(prompt, 10);
    assert.equal(fitted.changed, true);
    assert.equal(fitted.from, 15, 'a 0/5/10 script is a 15s script — the last beat gets a slice too');
    assert.equal(fitted.to, 10);
    assert.match(fitted.prompt, /\[Shot 2\] At 00:03\.333/);
    assert.match(fitted.prompt, /\[Shot 3\] At 00:06\.667/);
    // Every beat now starts inside the clip, which is the whole point.
    assert.deepEqual(timelineOverruns(fitted.prompt, 10), []);
    // And it reports what it moved rather than quietly editing the user's words.
    assert.deepEqual(fitted.moved, [
        { before: 0, after: 0 },
        { before: 5, after: 3.333 },
        { before: 10, after: 6.667 },
    ].slice(1), 'only timestamped anchors move; [Shot 1] carries none');
});

test('a prompt that already fits is returned untouched', () => {
    // Refitting a short script onto a long clip would spread it out, and nobody
    // asked for that. Only an overrun is repaired.
    const prompt = '[Shot 1] She waits. [Shot 2] At 00:03.000, she leaves.';
    const fitted = fitShotTimeline(prompt, 15);
    assert.equal(fitted.changed, false);
    assert.equal(fitted.prompt, prompt);
    // Same when there is nothing to fit, or nothing to fit it to.
    assert.equal(fitShotTimeline(prompt, 0).changed, false);
    assert.equal(fitShotTimeline('', 10).changed, false);
    assert.equal(fitShotTimeline('[Shot 1] No anchors at all.', 10).changed, false);
});

test('a single overrunning anchor still lands inside the clip', () => {
    // One gap is no gaps: the span falls back to twice the last start, so the
    // beat keeps a slice of its own instead of landing exactly on the end.
    const fitted = fitShotTimeline('[Shot 1] A. [Shot 2] At 00:12.000, B.', 10);
    assert.equal(fitted.changed, true);
    assert.deepEqual(timelineOverruns(fitted.prompt, 10), []);
    assert.match(fitted.prompt, /At 00:05\.000/);
});

test('every H3 starter fits the length it declares', () => {
    // The guarantee that was missing: a starter is a fixed script, so it cannot
    // obey an instruction about the clip length the way a written prompt can.
    for (const entry of DEFAULT_PROMPTS) {
        for (const part of entry.parts || []) {
            const overruns = timelineOverruns(part.prompt, part.durationSeconds);
            assert.deepEqual(
                overruns, [],
                `${entry.id} / ${part.label} stamps a shot at ${overruns.join(', ')}s of ${part.durationSeconds}s`,
            );
        }
    }
});

test('the check that fires is exactly the one the button clears', async () => {
    // Prompt Check already flagged this ("[Shot 3] cuts at 10.0s but the clip is
    // 10.0s — that shot never happens"); what was missing was a way to act on
    // it. These two have to agree, or the button appears and changes nothing —
    // or worse, does not appear on a prompt it could fix.
    const { checkH3Prompt } = await import('../src/lib/h3PromptCheck.js');
    const prompt = [
        'integrated_multimodal_description: A man sits.',
        '[Shot 2] At 00:05.000, he walks. [Shot 3] At 00:10.000, he hangs laundry.',
        'overall_soundscape: Birds.',
        'non_diegetic_music: N/A',
    ].join('\n');

    const before = checkH3Prompt({ prompt, durationSeconds: 10 });
    assert.ok(
        before.findings.some((finding) => finding.code === 'cut-past-end'),
        'the shape Liam sent must raise cut-past-end at 10s',
    );

    const fitted = fitShotTimeline(prompt, 10);
    assert.equal(fitted.changed, true);
    const after = checkH3Prompt({ prompt: fitted.prompt, durationSeconds: 10 });
    assert.deepEqual(
        after.findings.filter((finding) => finding.code === 'cut-past-end'), [],
        'refitting must clear the finding that offered the button',
    );
});

test('a starter loaded onto a shorter clip than it declares comes out fitted', () => {
    // The bug this run: references cap the clip at 10s, the H3 starters are
    // fixed 15s scripts, and loading one from the Prompts menu pasted the 15s
    // timing verbatim — the third beat arrived already past the end. The fix is
    // adoptPrompt() in VideoStudio, which runs exactly this on the way IN at
    // every door a whole prompt arrives through (starter, saved library, Shot
    // Builder, the hub insert bridge, a canvas restore, the helper).
    const capped = [5, 8, 10];
    for (const entry of DEFAULT_PROMPTS) {
        for (const part of entry.parts || []) {
            for (const duration of capped) {
                if (duration >= part.durationSeconds) continue;
                const fitted = fitShotTimeline(part.prompt, duration);
                assert.deepEqual(
                    timelineOverruns(fitted.prompt, duration), [],
                    `${entry.id} / ${part.label} still overruns a ${duration}s clip`,
                );
            }
        }
    }

    // Named outright, because it is the one Liam hit: part 1 of the H3 Korean
    // home video is 00:00 / 00:05 / 00:10 and has to survive the 10s cap.
    const korean = DEFAULT_PROMPTS.find((entry) => entry.id === 'korean-home-video-h3');
    const first = fitShotTimeline(korean.parts[0].prompt, 10);
    assert.equal(first.changed, true, 'a 15s script pasted onto a 10s clip must be re-timed');
    assert.equal(shotStartTimes(first.prompt).every((shot) => shot.seconds < 10), true);
});
