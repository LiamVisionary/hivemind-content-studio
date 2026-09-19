// The Providers board's model: which rows exist, what each one says, and which
// of them may offer a key field.
//
// These are logic-level tests rather than renders because the two facts that
// decide the panel — the passbook allow-list and whether the store already
// holds a name — arrive from an EFFECT, and effects never run under a server
// render (tests/helpers/render.js says so in its header). The board's markup is
// covered by hubViewsSmoke; what is covered here is the model it draws.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { root } = require('./helpers/render.js');

const VIEW = pathToFileURL(path.join(root, 'src/hub/views/ProvidersView.jsx')).href;
const load = () => import(VIEW);

// A cut-down /api/catalog body in the real shape: providers are filed under
// EVERY role they declare, by reference, which is the repetition the board has
// to collapse.
const provider = (id, extra = {}) => ({
    id,
    roles: ['image'],
    mode: 'cloud',
    requirement: `${id.toUpperCase()}_KEY`,
    cost: 'paid',
    side_effects: ['network'],
    fallback: 'local providers',
    keys: [],
    available: false,
    detail: `${id.toUpperCase()}_KEY`,
    needs: '',
    ...extra,
});

const byRole = (providers) => {
    const map = {};
    providers.forEach((entry) => {
        entry.roles.forEach((role) => {
            map[role] = map[role] || [];
            map[role].push(entry);
        });
    });
    return map;
};

const dedupe = (catalog) => [
    ...new Map(Object.values(catalog).flat().map((entry) => [entry.id, entry])).values(),
];

const CONNECTED = { openai: { connected: true, usable: true, needs_reconnect: false, detail: '' } };

test('a provider filed under seven roles is one row, not seven', async () => {
    const { boardRows } = await load();
    const muapi = provider('muapi', {
        roles: ['image', 'keyframe', 'motion', 'image-to-video', 'music', 'lip-sync', 'clip'],
    });
    const catalog = byRole([muapi]);
    assert.equal(Object.values(catalog).flat().length, 7, 'the payload really does repeat it');

    const rows = boardRows({
        providers: dedupe(catalog),
        oauth: {},
        statusKnown: true,
        offline: false,
        settable: new Map(),
    });
    assert.equal(rows.filter((row) => row.id === 'muapi').length, 1);
});

test('only a credential the studio may write gets a field, and the rest keep their instruction', async () => {
    const { boardRows } = await load();
    // ace-step declares a key the passbook route refuses; muapi declares one it
    // accepts. Rendering a field per DECLARED key is the bug this guards.
    const providers = [
        provider('ace-step', {
            roles: ['music'],
            keys: ['ACE_STEP_API_BASE_URL'],
            needs: 'Needs an ACE-Step server URL.',
            detail: 'ACE_STEP_API_BASE_URL or ace-step executable',
            requirement: 'ACE_STEP_API_BASE_URL or ace-step executable',
        }),
        provider('muapi', { keys: ['MUAPI_API_KEY'], needs: 'Needs a MUAPI key.', detail: 'MUAPI_API_KEY or MUAPI_KEY' }),
    ];
    const rows = boardRows({
        providers,
        oauth: {},
        statusKnown: true,
        offline: false,
        settable: new Map([['MUAPI_API_KEY', false]]),
    });
    const ace = rows.find((row) => row.id === 'ace-step');
    const muapi = rows.find((row) => row.id === 'muapi');

    assert.deepEqual(ace.keys, [], 'a key the route would refuse gets no field');
    assert.equal(ace.main, 'Needs an ACE-Step server URL.');
    assert.equal(
        ace.extra,
        'ACE_STEP_API_BASE_URL or ace-step executable',
        'with no field to offer, the requirement sentence is the only instruction there is',
    );
    assert.deepEqual(muapi.keys, ['MUAPI_API_KEY']);
});

test('a name the store already holds is a replacement, even on a provider that is not ready', async () => {
    const { boardRows } = await load();
    // Higgsfield needs BOTH names, so a half-configured row is not `available`.
    // Deciding "is this a replacement" from readiness would send the additive
    // write, and the store would keep the id the user just corrected.
    const rows = boardRows({
        providers: [provider('higgsfield-cloud', {
            keys: ['HIGGSFIELD_API_KEY_ID', 'HIGGSFIELD_API_KEY_SECRET'],
            available: false,
        })],
        oauth: {},
        statusKnown: true,
        offline: false,
        settable: new Map([['HIGGSFIELD_API_KEY_ID', true], ['HIGGSFIELD_API_KEY_SECRET', false]]),
    });
    const row = rows.find((entry) => entry.id === 'higgsfield-cloud');
    assert.equal(row.ready, false);
    assert.deepEqual(row.keys, ['HIGGSFIELD_API_KEY_ID', 'HIGGSFIELD_API_KEY_SECRET']);
    assert.deepEqual(row.configured, ['HIGGSFIELD_API_KEY_ID']);
});

test('a ready provider drops the fix line and keeps its metadata', async () => {
    const { boardRows } = await load();
    const rows = boardRows({
        providers: [provider('comfyui', {
            available: true,
            detail: "This machine's ComfyUI workflows are reachable.",
            requirement: 'ComfyUI or HivemindOS image/video route',
            mode: 'local',
            cost: 'local',
            fallback: 'media-studio-mcp',
        })],
        oauth: {},
        statusKnown: true,
        offline: false,
        settable: new Map(),
    });
    const row = rows[rows.length - 1];
    assert.equal(row.state, 'Ready');
    assert.equal(row.main, "This machine's ComfyUI workflows are reachable.");
    assert.equal(row.extra, '', 'the requirement is the fix, and a ready row has nothing to fix');
    assert.equal(row.fallback, 'media-studio-mcp');
});

test('the two accounts read connected, stale and absent as three different states', async () => {
    const { boardRows } = await load();
    const of = (oauth) => boardRows({ providers: [], oauth, statusKnown: true, offline: false, settable: new Map() })
        .find((row) => row.id === 'xai-account');

    const connected = of({ xai: { connected: true, usable: true, needs_reconnect: false, detail: '' } });
    const stale = of({ xai: { connected: true, usable: false, needs_reconnect: true, detail: '' } });
    const absent = of({ xai: { connected: false, usable: false, needs_reconnect: false, detail: '' } });

    assert.equal(connected.state, 'Connected');
    assert.equal(connected.ready, true);
    // A stale grant has a Reconnect button; "Not connected" beside it would
    // contradict the button.
    assert.equal(stale.state, 'Needs setup');
    assert.equal(stale.needsReconnect, true);
    assert.equal(absent.state, 'Not connected');
    assert.equal(absent.needsReconnect, false);

    // Where the sign-in happens is only worth saying while one is outstanding.
    assert.ok(!connected.main.includes('finish the sign-in'));
    assert.ok(absent.main.includes('finish the sign-in'));
});

test('an unread status is being read, not "not connected"', async () => {
    const { boardRows } = await load();
    const rows = (statusKnown, offline) => boardRows({
        providers: [], oauth: {}, statusKnown, offline, settable: new Map(),
    })[0];

    assert.equal(rows(false, false).state, 'Checking');
    assert.equal(rows(false, true).state, 'Offline');
    assert.equal(rows(true, false).state, 'Not connected');
});

test('every band is drawn once, in its declared order, and nothing falls off the board', async () => {
    const { boardRows, boardBands } = await load();
    const providers = [
        provider('muapi', { roles: ['image'] }),
        provider('comfyui', { roles: ['image'] }),
        provider('elevenlabs', { roles: ['voice'] }),
        provider('postiz', { roles: ['publish'] }),
        // Never declared by id: placed by role.
        provider('a-new-music-provider', { roles: ['music'] }),
        // Declared by neither id nor a known role: still gets a home.
        provider('a-provider-from-the-future', { roles: ['telepathy'] }),
    ];
    const rows = boardRows({ providers, oauth: {}, statusKnown: true, offline: false, settable: new Map() });
    const bands = boardBands(rows);

    const placed = bands.flatMap((band) => band.items.map((row) => row.id));
    assert.equal(placed.length, rows.length, 'every row is placed exactly once');
    assert.deepEqual([...new Set(placed)], placed, 'and no row is placed twice');

    const bandOf = (id) => bands.find((band) => band.items.some((row) => row.id === id)).key;
    assert.equal(bandOf('openai-account'), 'providers.groupAccounts');
    assert.equal(bandOf('comfyui'), 'providers.groupPictureMotion');
    assert.equal(bandOf('a-new-music-provider'), 'providers.groupSoundStock');
    assert.equal(bandOf('postiz'), 'providers.groupPipeline');
    assert.equal(bandOf('a-provider-from-the-future'), 'providers.groupOther');

    // The declared order wins over catalog order; the undeclared one trails it.
    const picture = bands.find((band) => band.key === 'providers.groupPictureMotion');
    assert.deepEqual(picture.items.map((row) => row.id), ['comfyui', 'muapi']);
});

test('the counters count every row the board draws, accounts included', async () => {
    const { boardRows } = await load();
    const rows = boardRows({
        providers: [provider('comfyui', { available: true }), provider('muapi', { available: false })],
        oauth: CONNECTED,
        statusKnown: true,
        offline: false,
        settable: new Map(),
    });
    assert.equal(rows.length, 4, 'two accounts and two routes');
    assert.equal(rows.filter((row) => row.ready).length, 2, 'comfyui and the OpenAI account');
    assert.equal(rows.filter((row) => !row.ready).length, 2, 'muapi and the xAI account');
});
