// ensureVaultReady caches its answer for the page load. It used to cache the
// wrong kind: a studio that could not be REACHED — mid-restart, asleep, one
// dropped packet — was recorded as "this vault is locked" and stayed that way
// until a manual reload, with a valid session and healthy keys the whole time.
//
// A settled "no" is still cached; anything a retry could fix is not.
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = { __HIVEMIND_STUDIO__: 1, location: { search: '' }, dispatchEvent() {} };

const PASSPHRASE = 'a-real-workspace-passphrase';
const PASSPHRASE_KEY = 'hivemind.ownerPassphrase.once';
const HINT_KEY = 'hivemind.vaultUnlock.once';
const passphraseHandoff = () => ({ password: PASSPHRASE, expiresAt: Date.now() + 60_000 });
let handoff = passphraseHandoff();
let hint = null;
global.sessionStorage = {
    getItem(key) {
        if (key === PASSPHRASE_KEY) return handoff ? JSON.stringify(handoff) : null;
        if (key === HINT_KEY) return hint ? JSON.stringify(hint) : null;
        return null;
    },
    setItem() {},
    removeItem() {},
};

// Each entry answers one call, in order. Entries are thunks, evaluated at fetch
// time — a body built eagerly would capture the identity before it exists and
// quietly send the run down the vault-CREATION path instead.
let answers = [];
let calls = 0;
let requests = [];
global.fetch = async (url, options = {}) => {
    calls += 1;
    requests.push({ url, options });
    const next = answers.shift();
    const { status = 200, body = {} } = (typeof next === 'function' ? next() : next) || {};
    return { ok: status < 400, status, json: async () => body };
};

const vaultPromise = import('../src/lib/e2eVault.js');
const sessionPromise = import('../src/lib/vaultSession.js');

let identity = null;
async function reset(...queued) {
    const vault = await vaultPromise;
    if (!identity) ({ identity } = await vault.createVaultIdentity(PASSPHRASE));
    (await sessionPromise).resetVaultSession(); // locks the vault, drops the cache
    answers = queued;
    calls = 0;
    requests = [];
}

// Guards the whole file: every one of these runs must unlock an EXISTING vault.
// If a queued body ever arrives without the identity, bootstrap silently creates
// a second vault and the call counts stop meaning anything.
function assertServedExistingVault(vault) {
    assert.ok(identity, 'the identity exists before any request is answered');
    assert.equal(answers.length, 0, 'every queued answer was used');
    assert.equal(vault.isVaultUnlocked(), true);
}

const identityOk = () => ({ status: 200, body: { ok: true, exists: true, identity } });
const unreachable = () => { throw new TypeError('Failed to fetch'); };

test('an unreachable studio is not cached — the next caller retries and unlocks', async () => {
    const { ensureVaultReady } = await sessionPromise;
    await reset(unreachable, identityOk);

    assert.equal(await ensureVaultReady(), false, 'the first attempt cannot answer');
    assert.equal(await ensureVaultReady(), true, 'the retry finds a reachable studio');
    assert.equal(calls, 2, 'the failure did not stick');
    assertServedExistingVault(await vaultPromise);
});

test('a 5xx is not cached either — that is the studio mid-restart', async () => {
    const { ensureVaultReady } = await sessionPromise;
    await reset({ status: 503, body: {} }, identityOk);

    assert.equal(await ensureVaultReady(), false);
    assert.equal(await ensureVaultReady(), true);
    assert.equal(calls, 2);
});

test('a 4xx IS cached — it is a real answer about this session', async () => {
    const { ensureVaultReady } = await sessionPromise;
    await reset({ status: 401, body: { detail: 'Sign in to a workspace' } }, identityOk);

    assert.equal(await ensureVaultReady(), false);
    assert.equal(await ensureVaultReady(), false, 'the answer stands for this page load');
    assert.equal(calls, 1, 'every sealed image on the page must not re-ask for the same no');
});

test('a vault this browser has no way into is cached, without asking the server', async () => {
    const { ensureVaultReady } = await sessionPromise;
    handoff = null; // no passphrase, no passkey hint: nothing to try
    await reset(identityOk);

    assert.equal(await ensureVaultReady(), false);
    assert.equal(await ensureVaultReady(), false);
    assert.equal(calls, 0, 'bootstrap answers this one without a request');
    handoff = passphraseHandoff();
});

test('concurrent callers share one attempt, and a transient failure still retries', async () => {
    const { ensureVaultReady } = await sessionPromise;
    await reset(unreachable, identityOk);

    // e2eMedia calls this once per sealed URL; a page full of them must not
    // become a page full of requests.
    const together = await Promise.all([ensureVaultReady(), ensureVaultReady(), ensureVaultReady()]);
    assert.deepEqual(together, [false, false, false]);
    assert.equal(calls, 1, 'one in-flight attempt served all three');

    assert.equal(await ensureVaultReady(), true, 'and the slot was freed for a retry');
    assert.equal(calls, 2);
});

// ── a passkey sign-in stops riding the weaker path ───────────────────────────
//
// enrolPrfWrap needs the passphrase, and a passkey sign-in has not got one. So
// a browser that unlocked by device wrap never wrote a PRF wrap: it took the
// weaker path on every load, and the day the wrap broke there was nothing left
// but the password. A device unlock now finishes the enrolment itself.

function installFakeIndexedDb() {
    const databases = new Map();
    globalThis.indexedDB = {
        open(name) {
            const data = databases.get(name) || new Map();
            databases.set(name, data);
            const request = {};
            queueMicrotask(() => {
                const store = {
                    get(key) {
                        const get = {};
                        queueMicrotask(() => { get.result = data.get(key); get.onsuccess?.(); });
                        return get;
                    },
                    put(value, key) {
                        const put = {};
                        queueMicrotask(() => { data.set(key, value); put.onsuccess?.(); });
                        return put;
                    },
                    delete(key) {
                        const del = {};
                        queueMicrotask(() => { data.delete(key); del.onsuccess?.(); });
                        return del;
                    },
                };
                request.result = {
                    objectStoreNames: { contains: () => true },
                    createObjectStore: () => store,
                    close: () => {},
                    transaction() {
                        const tx = { objectStore: () => store };
                        queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
                        return tx;
                    },
                };
                request.onupgradeneeded?.();
                request.onsuccess?.();
            });
            return request;
        },
    };
}

const PRF_SECRET_B64URL = Buffer.alloc(32, 5).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('a device unlock enrols the PRF wrap the passphrase path would have written', async () => {
    installFakeIndexedDb();
    const vault = await vaultPromise;
    const { ensureVaultReady } = await sessionPromise;
    (await import('../src/lib/deviceIdentity.js')).__test.reset();

    await reset();
    await vault.rememberOnThisDevice(identity, PASSPHRASE, 1);
    assert.ok(!identity.wrapped_mk_prf, 'this vault has no passkey enrolled yet');

    // A passkey sign-in: a hint, and no passphrase anywhere.
    handoff = null;
    hint = { accountId: 1, credentialId: 'cred-1', prf: PRF_SECRET_B64URL };
    await reset(identityOk, { status: 200, body: { ok: true } });

    assert.equal(await ensureVaultReady(), true, 'the device wrap still unlocks');
    const enrolment = requests.find((request) => String(request.url).startsWith('/api/vault/prf/'));
    assert.ok(enrolment, 'the passkey was enrolled on the way through');
    assert.equal(enrolment.url, '/api/vault/prf/cred-1');
    const { wrapped_mk: wrappedMk } = JSON.parse(enrolment.options.body);
    assert.ok(wrappedMk && wrappedMk.includes('.'), 'an iv.ciphertext blob was sent');

    // And it is the real thing: that wrap opens this vault on its own.
    vault.lockVault();
    const enrolled = { ...identity, wrapped_mk_prf: JSON.stringify({ 'cred-1': wrappedMk }) };
    assert.equal(await vault.unlockWithPrf(enrolled, 'cred-1', new Uint8Array(32).fill(5)), true);

    handoff = passphraseHandoff();
    hint = null;
});

test('an already-enrolled passkey is not re-enrolled on every load', async () => {
    installFakeIndexedDb();
    const vault = await vaultPromise;
    const { ensureVaultReady } = await sessionPromise;
    (await import('../src/lib/deviceIdentity.js')).__test.reset();

    await reset();
    await vault.rememberOnThisDevice(identity, PASSPHRASE, 1);
    handoff = null;
    hint = { accountId: 1, credentialId: 'cred-1', prf: PRF_SECRET_B64URL };

    // The server already holds a wrap for this credential — but not one this
    // PRF secret can open, so the unlock still falls through to the device.
    const already = { ...identity, wrapped_mk_prf: JSON.stringify({ 'cred-1': 'someone.else' }) };
    await reset(() => ({ status: 200, body: { ok: true, exists: true, identity: already } }));

    assert.equal(await ensureVaultReady(), true);
    assert.equal(requests.filter((request) => String(request.url).startsWith('/api/vault/prf/')).length, 0,
        'enrolment is not repeated for a credential the server already has');

    handoff = passphraseHandoff();
    hint = null;
});

// ── the handoff outlives its own secret ──────────────────────────────────────
//
// The owner cookie slides — control_api re-issues it past half its life, so a
// tab in daily use never signs out. The sessionStorage handoff does not: it is
// stamped once at sign-in and dies 24 h later. Every browser therefore lost its
// vault exactly a day after signing in, with a valid session, a healthy vault
// and a perfectly good device wrap it was no longer allowed to name.

const expiredHint = () => ({
    accountId: 1,
    method: 'passkey-prf',
    credentialId: 'cred-1',
    prf: PRF_SECRET_B64URL,
    expiresAt: Date.now() - 1_000,
});

test('an expired hint still unlocks through the device wrap it names', async () => {
    installFakeIndexedDb();
    const vault = await vaultPromise;
    const { ensureVaultReady } = await sessionPromise;
    (await import('../src/lib/deviceIdentity.js')).__test.reset();

    await reset();
    await vault.rememberOnThisDevice(identity, PASSPHRASE, 1);

    // A day after signing in with a passkey: cookie still good, handoff lapsed.
    handoff = null;
    hint = expiredHint();
    await reset(identityOk);

    assert.equal(await ensureVaultReady(), true, 'the device wrap is not stale just because the hint is');
    assert.equal(vault.isVaultUnlocked(), true);

    handoff = passphraseHandoff();
    hint = null;
});

test('an expired hint does not spend its lapsed PRF secret', async () => {
    installFakeIndexedDb();
    const vault = await vaultPromise;
    const { ensureVaultReady } = await sessionPromise;
    (await import('../src/lib/deviceIdentity.js')).__test.reset();

    await reset();
    await vault.rememberOnThisDevice(identity, PASSPHRASE, 1);
    handoff = null;
    hint = expiredHint();

    // The server holds a PRF wrap this secret WOULD open. An expired secret
    // must not be used anyway, and must not be re-enrolled.
    const prfWrap = await vault.wrapMasterKeyForPrf(identity, PASSPHRASE, new Uint8Array(32).fill(5));
    vault.lockVault();
    const enrolled = { ...identity, wrapped_mk_prf: JSON.stringify({ 'cred-1': prfWrap }) };
    await reset(() => ({ status: 200, body: { ok: true, exists: true, identity: enrolled } }));

    assert.equal(await ensureVaultReady(), true, 'the device wrap carries it instead');
    assert.equal(requests.filter((request) => String(request.url).startsWith('/api/vault/prf/')).length, 0,
        'a lapsed secret enrols nothing');

    handoff = passphraseHandoff();
    hint = null;
});
