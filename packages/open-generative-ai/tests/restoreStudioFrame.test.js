// The Restore route on the studio frame: what is on screen in each of its states.
//
// Restore moved off StudioLayout onto studios/frame/ — the comparison is the
// stage, past projects are the rail, the clip and the two presses float in one
// composer, and every dial is behind Advanced. That move had four ways to lose
// something quietly, and each is a test below:
//
//  1. a clip that is LOADED but not yet restored used to be answered with one
//     sentence in the middle of the frame. In a column that was a small card;
//     as the whole window it hid the clip that had just been loaded.
//  2. the Original view had no transport. The restored player owned the
//     controls and `invisible` does not make a hidden player's bar reachable,
//     so picking Original gave a still frame.
//  3. a <video src=""> resolves to the page's own URL and errors, which is what
//     an unrestored project's second player would be.
//  4. the projects rail is `hidden sm:flex`, so below 640px the ONLY door back
//     into a past render has to be somewhere else.
//
// Rendered, not grepped: these are claims about what a person can see and press.
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderComponent, renderStudio, textOf } = require('./helpers/render.js');

const SOURCE = { width: 640, height: 360, frames: 480, fps: 24, hasAudio: true };
const SETTINGS = {
    model: 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors',
    resolution: '1440p', maxResolution: 0, batchSize: 5, chunkSeconds: 4,
    contextFrames: 5, seamFrames: 3, colorCorrection: 'lab', seed: 42, tiledVae: false,
};
const PLAN = { chunks: new Array(14).fill(0), chunkFrames: 96, fps: 24, width: 2560, height: 1440 };
const LANES = [
    { lane: 'default', available: true, paid: false, assembles_here: true },
    { lane: 'vast-48', available: true, paid: true, machine: 'RTX 5090' },
    { lane: 'cloud', available: true, paid: true },
];

async function runOn(laneId = 'default') {
    const { runTargetsFromRows } = await import('../src/lib/runTargets.js');
    const { restoreRunTargets, laneReadinessFor } = await import('../src/lib/videoRestore.js');
    const targets = runTargetsFromRows(restoreRunTargets(LANES), { kind: 'video' });
    return {
        targets,
        value: targets.find((target) => target.id === laneId) || null,
        onChange: () => {},
        readinessFor: laneReadinessFor(LANES),
        onFixReadiness: () => {},
    };
}

const stage = (props) => renderComponent('src/studios/restore/RestoreStage.jsx', 'RestoreStage', props);

test('the route mounts on the frame: one floating composer, a rail, and no scrolling column', async () => {
    const markup = await renderStudio('src/studios/RestoreStudio.jsx', 'RestoreStudio');
    const text = textOf(markup);
    // The empty state is the stage, not a card in a column.
    assert.match(text, /Restore and upscale video, on your own machine/);
    // The clip door reads the same words the guide sends people to.
    assert.match(text, /Load a clip/);
    // The frame's drop contract — OutputRestoreDropZone checks for exactly this
    // attribute so a clip dropped on the composer is loaded rather than read as
    // a settings payload.
    assert.match(markup, /data-studio-composer/);
    // The render reads as a before and after, and the way to the rest is the
    // tab on the frame's left edge. With nothing loaded, the before is the word
    // the stage uses for the clip.
    assert.match(text, /Original → 2K 7B · standard/);
    const tab = /<button[^>]*data-drawer-tab[^>]*>/.exec(markup);
    assert.ok(tab, 'the Restore studio has no tab to open Advanced with');
    assert.match(tab[0], /aria-expanded="false"/, 'the Advanced tab reports itself shut');
});

test('a clip that is loaded but not restored is SHOWN, with the sentence as a note', async () => {
    const markup = await stage({
        source: SOURCE, originalUrl: 'blob:original', restoredUrl: '', mode: 'wipe',
    });
    // The clip is on screen…
    assert.match(markup, /src="blob:original"/);
    // …with its own transport, because it is the one being watched.
    assert.match(markup, /<video[^>]*src="blob:original"[^>]*controls/);
    // …and the sentence is a corner note over it, not the whole frame.
    assert.match(textOf(markup), /Nothing restored yet — render a test to see the difference/);
    // The second player is not mounted at all: src="" resolves to the page.
    assert.doesNotMatch(markup, /<video[^>]*src=""/);
});

test('with both clips the restored one leads and the original follows, muted', async () => {
    const markup = await stage({
        source: SOURCE, originalUrl: 'blob:original', restoredUrl: 'blob:restored', mode: 'wipe',
    });
    assert.match(markup, /src="blob:original"/);
    assert.match(markup, /src="blob:restored"/);
    // The wipe hides the player's own bar, so playback gets a button of its own.
    assert.match(textOf(markup), /Play/);
    // Both corners are labelled: which half of the frame is which.
    assert.match(textOf(markup), /Original/);
    assert.match(textOf(markup), /Restored/);
});

test('nothing loaded at all is the empty state, not an empty player', async () => {
    const markup = await stage({ source: null, originalUrl: '', restoredUrl: '' });
    assert.doesNotMatch(markup, /<video/);
    assert.match(textOf(markup), /Restore and upscale video/);
});

test('a render in flight reads out along the stage, and stopping is there too', async () => {
    const markup = await stage({
        source: SOURCE, originalUrl: 'blob:original', restoredUrl: '', busy: true,
        phase: 'Restoring', percent: 43, subject: '6 of 14 chunks',
        timing: '42¢ charged of $1.20 · about 12 min left',
        note: 'Each finished chunk is saved before the next one starts, so stopping — or closing this tab — costs you the chunk in flight and nothing else.',
        onCancel: () => {}, cancelLabel: 'Stop',
    });
    const text = textOf(markup);
    assert.match(text, /Restoring/);
    assert.match(text, /43%/);
    assert.match(text, /6 of 14 chunks/);
    // What has ACTUALLY been charged, beside how long is left: the two halves of
    // "what happens if I stop now".
    assert.match(text, /42¢ charged of \$1\.20/);
    assert.match(text, /about 12 min left/);
    assert.match(text, /costs you the chunk in flight and nothing else/);
    assert.match(text, /Stop/);
});

test('the compare door is offered only when there are two clips to compare', async () => {
    const both = await renderComponent('src/studios/restore/RestoreStage.jsx', 'RestoreStageActions', {
        mode: 'wipe', onModeChange: () => {}, canCompare: true, onDownload: () => {},
    });
    assert.match(both, /aria-label="Compare: Compare/);
    assert.match(both, /aria-label="Download the master"/);

    // One clip: choosing between four views of it is a choice with one outcome.
    const one = await renderComponent('src/studios/restore/RestoreStage.jsx', 'RestoreStageActions', {
        mode: 'wipe', onModeChange: () => {}, canCompare: false,
    });
    assert.doesNotMatch(one, /aria-label="Compare:/);
});

test('the composer says what the render will be, and offers the cheap press beside the dear one', async () => {
    const markup = await renderComponent('src/studios/restore/RestoreComposer.jsx', 'RestoreComposer', {
        clipName: 'holiday-1997.mp4',
        clipDetail: '640×360 · 480 frames · 24.00fps · sound',
        onPickClip: () => {},
        source: SOURCE,
        settings: SETTINGS, onChangeSettings: () => {}, plan: PLAN,
        previewSeconds: 2, previewAt: 3.5, previewMax: 18, onPreviewAt: () => {},
        runOn: await runOn('default'),
        primary: { label: 'Restore 14 chunks', onClick: () => {} },
        alternate: { label: 'Test 2s', onClick: () => {} },
        billLabel: 'free',
    });
    const text = textOf(markup);
    assert.match(text, /holiday-1997\.mp4/);
    assert.match(text, /640×360 · 480 frames · 24\.00fps · sound/);
    // The render as a before and after: the size the clip is, the size it comes
    // out, the model, and the machine with its bill. Every value after the
    // arrow is the control that sets it.
    assert.match(text, /640×360 → 2K · 2560×1440 7B · standard This Mac · free/);
    // The bill is said once, on the machine — not again beside the press.
    assert.equal(text.match(/\bfree\b/g)?.length, 1, 'the bill is printed more than once');
    // The render is not described as its chunks: the count is on the button.
    assert.doesNotMatch(text, /Restore 14 chunks at/);
    // The test's starting point is a line of its own, not a card of its own.
    assert.match(text, /Test 2s from 3\.5s/);
    // Two presses. The quieter one is the one to reach for first.
    assert.match(text, /Test 2s/);
    assert.match(text, /Restore 14 chunks/);
    // The clip row IS the door: a hidden input, so the whole row loads a clip.
    assert.match(markup, /type="file"[^>]*accept="video\/\*"/);
});

test('three ComfyUI processes on this Mac are one machine in the composer, named with its bill', async () => {
    // As this Mac's gateway lists them: one install started on three ports. The
    // token used to read "This Mac — anima — free, stays …", cut off mid-word.
    const lanes = [
        { lane: 'anima', available: true, paid: false, assembles_here: true },
        { lane: 'default', available: true, paid: false, assembles_here: true },
        { lane: 'ltx', available: true, paid: false, assembles_here: true },
        {
            lane: 'cloud', available: false, paid: true, remedy: 'connect',
            reason: 'connect your HivemindOS account to restore on the hosted service',
        },
    ];
    const { runTargetsFromRows } = await import('../src/lib/runTargets.js');
    const { laneEntryFor, laneReadinessFor, mergeLocalLanes, restoreRunTargets } = await import('../src/lib/videoRestore.js');
    const machines = mergeLocalLanes(lanes);
    const targets = runTargetsFromRows(restoreRunTargets(machines), { kind: 'video' });
    assert.equal(targets.filter((target) => target.place === 'this-mac').length, 1);
    // A project that ran on the anima process still reopens on This Mac.
    const selected = targets.find((target) => target.id === laneEntryFor(machines, 'anima')?.lane) || null;
    assert.ok(selected, 'a project on the anima lane has no row to reopen on');

    const markup = await renderComponent('src/studios/restore/RestoreComposer.jsx', 'RestoreComposer', {
        clipName: '', onPickClip: () => {},
        settings: SETTINGS, onChangeSettings: () => {}, plan: null,
        runOn: {
            targets, value: selected, onChange: () => {},
            readinessFor: laneReadinessFor(machines), onFixReadiness: () => {},
        },
        primary: { label: 'Restore', disabled: true, onClick: () => {} },
        billLabel: 'free',
    });
    const text = textOf(markup);
    assert.match(text, /Original → 2K 7B · standard This Mac · free/);
    const names = [...markup.matchAll(/(?:aria-label|title)="([^"]*)"/g)].map((match) => match[1]).join(' | ');
    assert.doesNotMatch(`${text} ${names}`, /\b(anima|ltx)\b/);
});

test('past projects have a door that survives a window too narrow for the rail', async () => {
    // The rail is `hidden sm:flex`. Below 640px this menu is the only way back
    // into a render, so it lists them at every width. Rendered on its own
    // because a Menu calls its children only while it is open.
    const markup = await renderComponent('src/studios/restore/RestoreComposer.jsx', 'ProjectDoorItems', {
        projects: [
            { id: 'a', width: 2560, height: 1440, status: 'running', progress: { chunks_done: 6, chunks_total: 14 } },
            { id: 'b', width: 1920, height: 1080, status: 'error', progress: { chunks_done: 3, chunks_total: 14 } },
        ],
        activeProjectId: 'a',
        onOpenProject: () => {},
    });
    const text = textOf(markup);
    assert.match(text, /2560x1440 — Running/);
    assert.match(text, /1920x1080 — Failed/);
    assert.match(text, /6\/14/);
    // …and the composer actually mounts it behind the one door it has.
    const composer = await renderComponent('src/studios/restore/RestoreComposer.jsx', 'RestoreComposer', {
        clipName: '', onPickClip: () => {},
        settings: SETTINGS, onChangeSettings: () => {}, plan: null,
        previewSeconds: 2, previewAt: 0, previewMax: 0, onPreviewAt: () => {},
        runOn: await runOn('default'),
        primary: { label: 'Restore', disabled: true, onClick: () => {} },
        projects: [{ id: 'a', width: 2560, height: 1440, status: 'running', progress: {} }],
        onOpenProject: () => {},
    });
    assert.match(composer, /aria-label="More"/);

    // Resume and Delete live in the rail's long-press menu, and the rail is the
    // thing that is not there below 640px — so the door carries them too when
    // the studio hands them over.
    const acting = await renderComponent('src/studios/restore/RestoreComposer.jsx', 'ProjectDoorItems', {
        projects: [
            { id: 'a', width: 2560, height: 1440, status: 'running', has_source: true, progress: { chunks_done: 6, chunks_total: 14 } },
            { id: 'b', width: 1920, height: 1080, status: 'complete', progress: { chunks_done: 14, chunks_total: 14 } },
        ],
        activeProjectId: 'a',
        onOpenProject: () => {},
        onResumeProject: () => {},
        onDeleteProject: () => {},
    });
    assert.match(acting, /aria-label="Resume 2560x1440 — Running"/);
    assert.match(acting, /aria-label="Delete 2560x1440 — Running"/);
    // A finished project has nothing left to resume.
    assert.doesNotMatch(acting, /aria-label="Resume 1920x1080 — Finished"/);
});

test('a project in the rail carries its whole row in one accessible name', async () => {
    const markup = await renderComponent('src/studios/restore/RestoreRail.jsx', 'RestoreRail', {
        projects: [{
            id: 'a', width: 1920, height: 1080, status: 'awaiting_assembly', sink: 'clip',
            has_source: true, progress: { chunks_done: 9, chunks_total: 9 },
        }],
        activeId: 'a', onOpen: () => {}, onResume: () => {}, onDelete: () => {},
        retention: 'Intermediates are kept 7 days, then cleared.',
    });
    // A 72px card cannot hold the row's line, so the button's name is the row.
    assert.match(markup, /aria-label="1920x1080 · Needs joining · 9 of 9 chunks · rendered on a rented machine"/);
    // How long a project survives, said where the projects are.
    assert.match(textOf(markup), /Intermediates are kept 7 days/);
});

test('a rented lane never reads as free — it bills by the hour', async () => {
    // It lands on This Mac (somebody else's card, reached through this Mac) and
    // carries no `machine` object for the readout to price, so the place's own
    // default note used to answer for it: "free, stays here", on the one lane
    // that charges by the hour. Now on the composer's sentence, where the press
    // that spends it is.
    const { runOnReadout, readoutText } = await import('../src/lib/runTargets.js');
    const { targets } = await runOn();
    const rented = targets.find((target) => target.id === 'vast-48');
    const free = targets.find((target) => target.id === 'default');
    const hosted = targets.find((target) => target.id === 'cloud');

    assert.match(readoutText(runOnReadout(rented)), /billed by the hour/);
    assert.doesNotMatch(readoutText(runOnReadout(rented)), /free/);
    // …and the free one still says so.
    assert.match(readoutText(runOnReadout(free)), /free, stays here/);
    // The hosted one is named by its bill, so it needs no note.
    assert.match(readoutText(runOnReadout(hosted)), /HivemindOS credits/);
    assert.doesNotMatch(readoutText(runOnReadout(hosted)), /free/);
});
