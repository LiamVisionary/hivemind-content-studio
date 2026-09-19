// No studio offers a row it will not let you press without saying why and
// offering the fix.
//
// Measured in a real browser on 2026-09-04: the Image picker showed 19 disabled
// rows and Sprite 23, and every one of them had an empty title, no reason line
// and no button — because lib/providerReadiness.js, the module written for
// exactly this, was passed to the picker by two studios out of six. DESIGN.md
// line 104: "never present a problem in a place where its fix could have been
// offered instead."
//
// Deliberately textual: the sweep below is an ABSENCE claim over the whole
// tree — "no studio mounts this picker without readiness" — and a render can
// only ever show the studios somebody remembered to render. The rest of this
// file renders.
//
// Two halves, and both are needed. The SWEEP is an absence claim over the tree
// — a studio added tomorrow that mounts the picker without readiness fails here
// rather than shipping silent rows. The RENDERS execute it: the rows each
// studio actually builds, drawn through the same RunOnList the studio draws
// them with, with the credentials of a machine that has none.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { importComponent, renderElement, root, textOf } = require('./helpers/render.js');

// Served by the studio server, which is what makes the `studio` transport
// reachable at all. Without it every cloud row is refused for the transport
// rather than for its credential, and the credential is what this pins.
globalThis.__HIVEMIND_STUDIO__ = 1;

const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);

/* ---------------- the sweep ---------------- */

/** Every `<RunOnPicker …/>` and `<RunOnList …/>` mount under src/studios. */
function pickerMounts() {
    const mounts = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.jsx')) continue;
            const source = fs.readFileSync(full, 'utf8');
            for (const match of source.matchAll(/<RunOn(?:Picker|List)\b([\s\S]*?)\/>/g)) {
                mounts.push({ file: path.relative(root, full), props: match[1] });
            }
        }
    };
    walk(path.join(root, 'src/studios'));
    return mounts;
}

test('every studio that mounts the Runs-on picker hands it a readiness answer and a repair', () => {
    const mounts = pickerMounts();
    // Image (panel + composer), Video, Sprite ×2, Story ×3, Restore. If this
    // number falls, a picker was deleted; if it rises, the mount below it has
    // to satisfy the same rule.
    assert.ok(mounts.length >= 8, `only ${mounts.length} pickers found — did the sweep stop finding them?`);
    for (const mount of mounts) {
        assert.match(mount.props, /readinessFor=\{/, `${mount.file} mounts the picker with no readinessFor`);
        assert.match(mount.props, /onFixReadiness=\{/, `${mount.file} offers no repair on a blocked row`);
    }
});

test('readiness is one module, not a check inside each picker', () => {
    // The rule providerReadiness.js states about itself. A studio computing its
    // own OAuth/key state is how Image came to offer a MUAPI row at the same
    // moment Sprite refused it.
    const owners = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!/\.jsx?$/.test(entry.name)) continue;
            const source = fs.readFileSync(full, 'utf8');
            if (/(?<!function )fetchOAuthStatus\(/.test(source)) owners.push(path.relative(root, full));
        }
    };
    walk(path.join(root, 'src'));
    // The hook that asks, and the joined-inventory hook that needs the same
    // answer for the Automatic ladder. Nothing else asks.
    assert.deepEqual(owners.sort(), ['src/lib/useProviderReadiness.js', 'src/lib/useRunTargets.js']);
});

/* ---------------- the renders ---------------- */

// A machine with no credentials at all: no key in the shared store, no key in
// this browser, no account connected. Every cloud row below is therefore a row
// somebody would otherwise have found out about by pressing Generate.
const OAUTH_NONE = { openai: { connected: false, detail: 'This account is not connected yet.' }, xai: { connected: false } };

const CATALOG = [
    // The hosted rail is a BALANCE, not a key. It used to be fixtured with a
    // device-token name, and the picker duly rendered "Not configured -
    // HIVEMINDOS_DASHBOARD_DEVICE_TOKEN is not set" over an Add key button for
    // a token that was present — the rail had simply never been funded.
    {
        id: 'hivemindos-hosted-media',
        available: false,
        needs: 'Connect HivemindOS credits to run hosted models',
        keys: [],
        models: [{ id: 'flux-3', label: 'Flux 3' }],
    },
    {
        id: 'openai-gpt-image',
        available: false,
        needs: 'Needs an OpenAI API key.',
        keys: ['OPENAI_API_KEY'],
        models: [{ id: 'gpt-image-2', label: 'GPT Image 2' }],
    },
    {
        id: 'openai-gpt-image-oauth',
        available: false,
        models: [{ id: 'gpt-image-2', label: 'GPT Image 2' }],
    },
    {
        id: 'muapi',
        available: false,
        needs: 'Needs a MUAPI key.',
        keys: ['MUAPI_API_KEY'],
        models: [{ id: 'flux-2-pro', label: 'Flux 2 Pro' }],
    },
];

async function drawPicker(targets, readinessFor) {
    const RunOnList = await importComponent('src/components/RunOnPicker.jsx', 'RunOnList');
    const { markup, logged } = renderElement(RunOnList, {
        targets,
        value: null,
        onChange: () => {},
        close: () => {},
        searchable: false,
        readinessFor,
        onFixReadiness: () => {},
    });
    assert.deepEqual(logged, [], 'the picker logged during render');
    return markup;
}

/** Every row the list drew, with the readiness block that follows it. */
function rowsOf(markup) {
    return markup
        .split('<div class="flex flex-col">')
        .slice(1)
        .map((chunk) => ({
            html: chunk,
            text: textOf(chunk),
            disabled: /role="menuitem"[^>]*\bdisabled\b/.test(chunk) || /\bdisabled=""/.test(chunk),
            hasButton: /<button[^>]*>(?![\s\S]*?role="menuitem")/.test(chunk.split('</button>').slice(1).join('</button>')),
        }));
}

/**
 * The whole claim, applied to one studio's rows: nothing greyed out is silent,
 * and a state the app can repair carries the button that repairs it.
 */
function assertNoSilentRows(markup, studio) {
    const rows = rowsOf(markup);
    assert.ok(rows.length, `${studio}: no rows drawn`);
    let blocked = 0;
    for (const row of rows) {
        if (!row.disabled) continue;
        blocked += 1;
        // Something a person can read, beyond the model's own name.
        assert.ok(row.text.length > 0, `${studio}: a disabled row with no text`);
        assert.match(
            row.html,
            /title="[^"]+"/,
            `${studio}: a disabled row with an empty title — "${row.text}"`,
        );
        assert.ok(row.hasButton, `${studio}: a disabled row with no repair — "${row.text}"`);
    }
    assert.ok(blocked > 0, `${studio}: nothing was blocked, so nothing was proved`);
    return rows;
}

test('Image: a cloud row nobody has a credential for says which key and offers to add it', async () => {
    const { imageRunTargets } = await load('src/studios/image/imageRunTargets.js');
    const { readinessFor } = await load('src/lib/providerReadiness.js');
    const targets = imageRunTargets({ localModels: [], catalogProviders: CATALOG });

    const markup = await drawPicker(targets, (row) => readinessFor(row, { oauth: OAUTH_NONE }));
    const text = textOf(markup);

    assertNoSilentRows(markup, 'Image');
    // The server's own sentence, not an env-var name aimed at whoever set the
    // machine up, and the button that fixes it.
    assert.match(text, /Needs an OpenAI API key\./);
    assert.match(text, /Add key/);
    // The OAuth sibling is a different repair, said in the same place.
    assert.match(text, /Not connected/);
    assert.match(text, /Connect/);
});

test('Image: the two doors into one account are told apart', async () => {
    const { imageRunTargets } = await load('src/studios/image/imageRunTargets.js');
    const { readinessFor } = await load('src/lib/providerReadiness.js');
    const targets = imageRunTargets({ localModels: [], catalogProviders: CATALOG });

    // Reported as "GPT Image 2 | Your OpenAI account" twice, indistinguishable.
    // Both routes are real — two credentials, two bills — so the row names the
    // door rather than one of them being deleted.
    const openai = targets.filter((target) => target.label === 'GPT Image 2');
    assert.equal(openai.length, 2);
    assert.deepEqual(openai.map((target) => target.credentialLabel).sort(), ['API key', 'ChatGPT sign-in']);

    const markup = await drawPicker(targets, (row) => readinessFor(row, { oauth: OAUTH_NONE }));
    assert.match(textOf(markup), /Your OpenAI account · API key/);
    assert.match(textOf(markup), /Your OpenAI account · ChatGPT sign-in/);
});

test('Video: a clip row with no MUAPI key anywhere says so on the row', async () => {
    const { videoRunTargets } = await load('src/studios/video/videoRunTargets.js');
    const { readinessFor } = await load('src/lib/providerReadiness.js');
    const { targets } = videoRunTargets({
        models: [{ id: 'kling-2.5', name: 'Kling 2.5' }],
        tools: [],
        catalogProviders: CATALOG,
    });

    const markup = await drawPicker(targets, (row) => readinessFor(row, { oauth: OAUTH_NONE }));
    assertNoSilentRows(markup, 'Video');
    assert.match(textOf(markup), /No API key/);
    assert.match(textOf(markup), /Add key/);
});

test('Sprite and Story: the capability matrix rows get the same answer as the catalog rows', async () => {
    const { runTargetsFromRows } = await load('src/lib/runTargets.js');
    const { readinessFor } = await load('src/lib/providerReadiness.js');
    // The shape Story's choicesFor and Sprite's imageChoices hand over: rated
    // rows whose `available` is the SERVER's probe.
    const rows = [
        { id: 'flux-2-pro', label: 'Flux 2 Pro', provider: 'muapi', source: 'cloud', available: false, rating: 'workable' },
        {
            id: 'gpt-image-2', label: 'GPT Image 2', provider: 'openai-gpt-image', source: 'cloud',
            available: false, needs: 'Needs an OpenAI API key.', keys: ['OPENAI_API_KEY'],
        },
    ];
    const targets = runTargetsFromRows(rows, { kind: 'image' });

    const markup = await drawPicker(targets, (row) => readinessFor(row, { oauth: OAUTH_NONE }));
    assertNoSilentRows(markup, 'Sprite/Story');
    assert.match(textOf(markup), /Needs an OpenAI API key\./);
});

test('Sprite: a row this stage cannot reach keeps its own reason', async () => {
    const { animationChoices } = await load('src/studios/sprite/spriteRouting.js');
    const { runTargetsFromRows } = await load('src/lib/runTargets.js');
    const { readinessFor } = await load('src/lib/providerReadiness.js');
    const targets = runTargetsFromRows(
        animationChoices([{ id: 'kling-2.5', model: 'kling-2.5', label: 'Kling 2.5', provider: 'muapi', source: 'cloud', available: true }]),
        { kind: 'video' },
    );

    // The stage's own constraint outranks the credential rule: a MUAPI key
    // would not make this row reachable, so it stays refused and says why.
    assert.equal(targets[0].ready, false);
    const markup = await drawPicker(targets, (row) => readinessFor(row, { oauth: OAUTH_NONE }));
    assert.match(textOf(markup), /sealed on this machine/);
});

test('Restore: a lane with no upscaler says so in words and offers the Machines page', async () => {
    const { laneReadinessFor, restoreRunTargets } = await load('src/lib/videoRestore.js');
    const { runTargetsFromRows } = await load('src/lib/runTargets.js');
    const lanes = [
        {
            lane: 'default', remote: false, paid: false, available: false, state: 'missing-nodes',
            missing: ['LoadVideo', 'GetVideoComponents', 'SeedVR2LoadDiTModel', 'SeedVR2VideoUpscaler'],
            remedy: 'attach-machine',
        },
        {
            lane: 'cloud', remote: true, paid: true, available: false, metered: 'per-render',
            reason: 'hosted restoration is switched off on this deployment', remedy: 'retry',
        },
    ];
    const targets = runTargetsFromRows(restoreRunTargets(lanes), { kind: 'video' });

    const markup = await drawPicker(targets, laneReadinessFor(lanes));
    const text = textOf(markup);
    assertNoSilentRows(markup, 'Restore');
    assert.match(text, /no SeedVR2 upscaler installed/i);
    assert.match(text, /Open Machines/);
    // The five internal ComfyUI class names this row used to print at a
    // first-time user, with no button under them.
    for (const cls of ['LoadVideo', 'GetVideoComponents', 'SeedVR2LoadDiTModel', 'SeedVR2VideoUpscaler']) {
        assert.doesNotMatch(text, new RegExp(`\\b${cls}\\b`), `${cls} is a graph detail, not user copy`);
    }
});

test('every section says whose money it is, so no paid row reads as free', async () => {
    const { imageRunTargets } = await load('src/studios/image/imageRunTargets.js');
    const { readinessFor } = await load('src/lib/providerReadiness.js');
    const targets = imageRunTargets({
        localModels: [{ id: 'z-image-turbo', name: 'Z-Image Turbo', provider: 'sdcpp' }],
        catalogProviders: CATALOG,
    });

    const text = textOf(await drawPicker(targets, (row) => readinessFor(row, { oauth: OAUTH_NONE })));
    // The section states whose money it is. Only the hosted rail can also
    // state a FIGURE, and only per request — the composer quotes the press it
    // is about to make (see hostedQuote.js), because 528 of the rail's 538
    // endpoints price dynamically and there is no catalogue number to print.
    assert.match(text, /Free, private/);
    assert.match(text, /one balance of HivemindOS credits/);
    // …and it no longer claims the desktop app is involved, because it is not:
    // the rail is a public gateway this studio calls with its own credit key.
    assert.doesNotMatch(text, /the HivemindOS app spends/);
    assert.match(text, /Billed by the provider to an account you already pay for/);
});

// The hosted rail is a balance, not a credential.
//
// `PROVIDER_KEYS` used to name HIVEMINDOS_DASHBOARD_DEVICE_TOKEN for this
// provider, and that map is consulted whenever the server declares no keys —
// so a rail that was out of credits, or a service that merely blinked, was
// rendered as "Not configured — HIVEMINDOS_DASHBOARD_DEVICE_TOKEN is not set
// in the shared Hive environment" over an Add key button, for a token that
// was set the whole time. Neither half was true and the button fixed nothing.
test('the hosted rail never asks for a key, and both of its blocked states have a door', async () => {
    const { readinessFor, PROVIDER_KEYS, keyNamesFor } = await load('src/lib/providerReadiness.js');
    assert.equal(PROVIDER_KEYS['hivemindos-hosted-media'], undefined, 'the rail has no env-var credential');
    assert.deepEqual(keyNamesFor({ provider: 'hivemindos-hosted-media', keys: [] }), []);

    const unfunded = readinessFor({
        provider: 'hivemindos-hosted-media', source: 'cloud', available: false,
        needs: 'Connect HivemindOS credits to run hosted models',
    }, { oauth: {} });
    assert.equal(unfunded.state, 'credits');
    assert.equal(unfunded.label, 'No credits yet');
    assert.equal(unfunded.action.kind, 'top-up');
    assert.doesNotMatch(unfunded.detail, /[A-Z]{2,}_[A-Z0-9_]+/, 'no env-var name reaches the row');

    // A service that did not answer is not a missing credential either — and
    // it still gets the one thing that can change the answer.
    const down = readinessFor({
        provider: 'hivemindos-hosted-media', source: 'cloud', available: false,
        needs: 'The HivemindOS media service did not answer',
    }, { oauth: {} });
    assert.equal(down.state, 'offline');
    assert.equal(down.action.kind, 'refresh');

    // Funded and up: no readiness furniture at all.
    const ready = readinessFor({ provider: 'hivemindos-hosted-media', source: 'cloud', available: true }, { oauth: {} });
    assert.equal(ready.blocks, false);
});

// One account, one sentence, one button.
//
// Liam, on the "My accounts" section: "very messy especially always saying the
// same block of text." MUAPI serves 125 image models on this machine, and each
// row carried the account name, "Needs a MUAPI key.", the "No API key" state,
// the whole "This machine has no MUAPI key yet…" paragraph AND its own Add key
// button. Four repetitions of one fact, 125 times.
test('an account says what is wrong once, not once per model it serves', async () => {
    const {
        accountRunsOf, sharedAccountReadiness, buildRunTargets, PLACE_ACCOUNTS,
    } = await load('src/lib/runTargets.js');
    const { readinessFor } = await load('src/lib/providerReadiness.js');

    // buildRunTargets, not imageRunTargets: the Image studio replaces MUAPI's
    // models with its own vendored catalogue, which this is not about.
    const muapi = { id: 'muapi', available: false, needs: 'Needs a MUAPI key.', keys: ['MUAPI_API_KEY'],
        models: Array.from({ length: 12 }, (_, index) => ({ id: `m${index}`, label: `Model ${index}` })) };
    const targets = buildRunTargets({ kind: 'image', localModels: [], catalogProviders: [...CATALOG, muapi] });
    const accounts = targets.filter((target) => target.place === PLACE_ACCOUNTS);
    const runs = accountRunsOf(accounts);

    // An account reachable two ways is two runs, because they are repaired
    // differently — a key and a sign-in are not one door.
    const openai = runs.filter((run) => /OpenAI/.test(run.label));
    assert.equal(openai.length, 2);
    assert.deepEqual(openai.map((run) => run.credentialLabel).sort(), ['API key', 'ChatGPT sign-in']);

    const muapiRun = runs.find((run) => /MUAPI/.test(run.label));
    assert.ok(muapiRun.targets.length >= 12, 'every MUAPI model lands in one run');
    const shared = sharedAccountReadiness(muapiRun.targets, (row) => readinessFor(row, { oauth: OAUTH_NONE }));
    assert.ok(shared, 'twelve rows blocked on the same key is one thing to say');
    // MUAPI is the one account whose key can live in this browser as well as
    // in the shared store, so it has its own state and its own door.
    assert.equal(shared.state, 'browser-key');
    assert.equal(shared.action.kind, 'muapi-key');
    assert.ok(shared.detail, 'the account still says what to do — once');

    // One row is not a repetition, so it keeps its own block rather than
    // growing a header above it.
    assert.equal(sharedAccountReadiness([muapiRun.targets[0]], (row) => readinessFor(row, { oauth: OAUTH_NONE })), null);
    // Neither is an account whose rows fail for different reasons.
    const mixed = [muapiRun.targets[0], openai[0].targets[0]];
    assert.equal(sharedAccountReadiness(mixed, (row) => readinessFor(row, { oauth: OAUTH_NONE })), null);
});

test('the picker hoists that sentence and strips it off the rows beneath', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'RunOnPicker.jsx'), 'utf8');
    assert.match(source, /accountSectionsOf\(group\.targets, readinessFor\)/);
    assert.match(source, /<AccountNotice/);
    // The row keeps its name and nothing the account already said: not the
    // state, not the reason, not the account's own name in the meta column.
    assert.match(source, /accountSaid=\{Boolean\(run\.shared\)\}/);
    assert.match(source, /const blocked = Boolean\(readiness\) && readiness\.state !== 'ready' && !accountSaid;/);
    assert.match(source, /accountSaid \? '' : \(target\.reason \|\| ''\)/);
    assert.match(source, /accountSaid \? '' : placeMetaLabel/);
    // …but the tooltip still explains a greyed row, whoever said why.
    assert.match(source, /const why = note\s*\n\s*\|\| \(readiness && readiness\.state !== 'ready'/);
});

// …and an account that can run nothing does not bury the ones that can.
//
// Liam, pointing at a Higgsfield "Add key" off the bottom of the panel: "why
// is this all the way at the bottom shouldnt it be grouped with the others
// that can have key added at the top". MUAPI serves 125 of the 137 models in
// "Your accounts" and holds no key, so 125 greyed names nobody could press
// sat between the reader and the four buttons that would fix it.
test('accounts you can use come first, and an account you cannot run folds its models away', async () => {
    const { accountSectionsOf, buildRunTargets, PLACE_ACCOUNTS } = await load('src/lib/runTargets.js');
    const { readinessFor } = await load('src/lib/providerReadiness.js');

    const many = { id: 'muapi', available: false, needs: 'Needs a MUAPI key.', keys: ['MUAPI_API_KEY'],
        models: Array.from({ length: 30 }, (_, index) => ({ id: `m${index}`, label: `Model ${index}` })) };
    const working = { id: 'higgsfield-cloud', available: true, keys: [],
        models: [{ id: 'soul', label: 'Soul Standard' }] };
    const targets = buildRunTargets({ kind: 'image', localModels: [], catalogProviders: [many, working] })
        .filter((target) => target.place === PLACE_ACCOUNTS);

    const sections = accountSectionsOf(targets, (row) => readinessFor(row, { oauth: OAUTH_NONE }));
    // The usable account is first, whatever order it arrived in — it is the
    // answer to "where can this run", and the other is a chore.
    assert.equal(sections[0].shared, null);
    assert.match(sections[0].label, /Higgsfield/);
    assert.ok(sections[1].blocked, 'the account with no key comes after');
    assert.equal(sections[1].targets.length, 30);

    // The picker folds exactly that one, and never while a query is typed.
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'RunOnPicker.jsx'), 'utf8');
    assert.match(source, /const folded = Boolean\(run\.blocked\) && !open && !expanded;/);
    assert.match(source, /expanded=\{Boolean\(query\)\}/);
    assert.match(source, /tf\('runOn\.accountModels', count\)/);
});

// Repeating is the problem, not blocking.
//
// "Sign-in status unknown — Check again" does not stop a press, so the first
// cut of the hoist skipped it — and three xAI rows each printed that sentence
// and that button. Whether a state BLOCKS decides whether the models fold
// away; whether it REPEATS decides whether it is said once.
test('a repeated state is said once even when it does not block, and those models stay listed', async () => {
    const { accountSectionsOf, buildRunTargets, PLACE_ACCOUNTS } = await load('src/lib/runTargets.js');
    const { readinessFor } = await load('src/lib/providerReadiness.js');

    const xai = { id: 'xai-imagine-oauth', available: true, keys: [],
        models: [{ id: 'a', label: 'Grok Imagine Image' }, { id: 'b', label: 'Grok Imagine Image Quality' }] };
    const targets = buildRunTargets({ kind: 'image', localModels: [], catalogProviders: [xai] })
        .filter((target) => target.place === PLACE_ACCOUNTS);
    // No OAuth answer at all: the studio could not check, which is a state
    // with a door ("Check again") and no refusal.
    const [run] = accountSectionsOf(targets, (row) => readinessFor(row, { oauth: {} }));
    assert.ok(run.shared, 'two rows saying the same thing is one thing to say');
    assert.equal(run.shared.blocks, false);
    assert.equal(run.blocked, null, 'a state that does not block does not fold the models away');
    assert.equal(run.targets.length, 2);
});
