// Settings → Privacy & vault, from the transport side.
//
// Two rules these calls exist to keep. A wrong current password is decided in
// the BROWSER, on a GCM tag, so the server is never an oracle to grind against.
// And the recovery key is announced only after the server has confirmed it
// stored the new wrap — showing a key that was never saved would be worse than
// showing none, because the person would file it and trust it.
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {
    __HIVEMIND_STUDIO__: 1,
    location: { search: '' },
    dispatchEvent(event) { announced.push(event); },
};
const announced = [];

const store = new Map();
global.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
};

let requests = [];
let answers = [];
global.fetch = async (url, options = {}) => {
    requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    const next = answers.shift();
    const { status = 200, body = {} } = (typeof next === 'function' ? next() : next) || {};
    return { ok: status < 400, status, json: async () => body };
};

async function fixture() {
    const vault = await import('../src/lib/e2eVault.js');
    const session = await import('../src/lib/vaultSession.js');
    const { identity } = await vault.createVaultIdentity('the-current-one');
    vault.lockVault();
    requests = [];
    announced.length = 0;
    store.clear();
    return { vault, session, identity };
}

const identityAnswer = (identity) => ({ body: { ok: true, exists: true, identity } });

test('change password: a wrong current password never reaches the server', async () => {
    const { session, identity } = await fixture();
    answers = [identityAnswer(identity)];
    const result = await session.changeWorkspacePassword('not-the-one', 'whatever');
    assert.deepEqual(result, { ok: false, reason: 'password' });
    assert.deepEqual(requests.map((entry) => entry.url), ['/api/vault/identity']);
});

test('change password: the server gets the new wrap and never the passphrase', async () => {
    const { vault, session, identity } = await fixture();
    store.set('hivemind.ownerPassphrase.once', JSON.stringify({
        password: 'the-current-one', expiresAt: Date.now() + 60_000,
    }));
    answers = [identityAnswer(identity), { body: { ok: true } }];

    assert.deepEqual(await session.changeWorkspacePassword('the-current-one', 'the-next-one'), { ok: true });
    const posted = requests.find((entry) => entry.url === '/api/accounts/me/password');
    assert.ok(posted, 'the change is posted');
    assert.ok(posted.body.wrap.salt && posted.body.wrap.wrapped_mk_pass);
    // The wrap really opens with the new password and nothing else.
    const updated = { ...identity, ...posted.body.wrap };
    assert.equal(await vault.unlockWithPassphrase(updated, 'the-current-one'), false);
    assert.equal(await vault.unlockWithPassphrase(updated, 'the-next-one'), true);
    vault.lockVault();

    // The per-tab handoff named a password that no longer exists; left stale, the
    // next reload would present a healthy vault as a locked one.
    assert.equal(JSON.parse(store.get('hivemind.ownerPassphrase.once')).password, 'the-next-one');
});

test('change password: a refused write says so, and changes nothing locally', async () => {
    const { session, identity } = await fixture();
    store.set('hivemind.ownerPassphrase.once', JSON.stringify({
        password: 'the-current-one', expiresAt: Date.now() + 60_000,
    }));
    answers = [identityAnswer(identity), { status: 401, body: { detail: 'nope' } }];
    assert.deepEqual(
        await session.changeWorkspacePassword('the-current-one', 'the-next-one'),
        { ok: false, reason: 'refused' },
    );
    assert.equal(JSON.parse(store.get('hivemind.ownerPassphrase.once')).password, 'the-current-one');
});

test('a new recovery key is announced only after the server stored it', async () => {
    const { vault, session, identity } = await fixture();
    answers = [identityAnswer(identity), { status: 500, body: {} }];
    assert.deepEqual(await session.mintNewRecoveryKey('the-current-one'), { ok: false, reason: 'failed' });
    assert.deepEqual(announced, [], 'a key the server refused is never shown');

    requests = [];
    answers = [identityAnswer(identity), { body: { ok: true } }];
    assert.deepEqual(await session.mintNewRecoveryKey('the-current-one'), { ok: true });
    const put = requests.find((entry) => entry.url === '/api/vault/recovery');
    assert.equal(put.options.method, 'PUT');
    assert.ok(put.body.wrapped_mk_recovery);
    assert.equal(announced.length, 1);
    assert.equal(announced[0].detail.reason, 'rotated', 'the modal must not claim a new vault');
    // The announced key is the one the server now holds a wrap for.
    const updated = { ...identity, wrapped_mk_recovery: put.body.wrapped_mk_recovery };
    assert.equal(await vault.unlockWithRecoveryKey(updated, announced[0].detail.recoveryKey), true);
});
