// The passphrase leaves sessionStorage once the device wrap exists.
//
// The sign-in gate hands the plaintext passphrase to the app through
// sessionStorage with a 24 h expiry, readable by any script in the origin. The
// device wrap makes it unnecessary: after one passphrase unlock this browser
// can unlock from IndexedDB with only the account id. So once that wrap is
// confirmed written, the passphrase is removed and the hint is reduced to its
// identifiers — and a reload still unlocks. The crypto below is real WebCrypto;
// only storage and transport are faked.
const test = require('node:test');
const assert = require('node:assert/strict');

const PASSPHRASE = 'a-real-workspace-passphrase';
const PASSPHRASE_KEY = 'hivemind.ownerPassphrase.once';
const HINT_KEY = 'hivemind.vaultUnlock.once';

const dispatched = [];
global.window = { __HIVEMIND_STUDIO__: 1, location: { search: '' }, dispatchEvent: (event) => dispatched.push(event) };
global.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

// sessionStorage as the browser has it: a real store, so removeItem is observable.
const storage = new Map();
global.sessionStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
};

// An in-memory IndexedDB, as in vaultPasskeyUnlock.test.js.
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
    return databases;
}
installFakeIndexedDb();

// Each entry answers one fetch, in order; thunks are evaluated at fetch time.
let answers = [];
let requests = [];
global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    const next = answers.shift();
    const { status = 200, body = {} } = (typeof next === 'function' ? next() : next) || {};
    return { ok: status < 400, status, json: async () => body };
};

const vaultPromise = import('../src/lib/e2eVault.js');
const sessionPromise = import('../src/lib/vaultSession.js');

const signIn = ({ passphrase = PASSPHRASE, accountId, prf = null, credentialId = null } = {}) => {
    storage.clear();
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    if (passphrase) storage.set(PASSPHRASE_KEY, JSON.stringify({ password: passphrase, expiresAt }));
    if (accountId) storage.set(HINT_KEY, JSON.stringify({ accountId, method: 'password', prf, credentialId, expiresAt }));
};

const hint = () => JSON.parse(storage.get(HINT_KEY) || 'null');

async function reset(...queued) {
    (await sessionPromise).resetVaultSession();
    answers = queued;
    requests = [];
}

test('after a passphrase unlock with a device wrap, the passphrase is gone and the hint keeps only identifiers', async () => {
    const vault = await vaultPromise;
    const session = await sessionPromise;
    const { identity } = await vault.createVaultIdentity(PASSPHRASE);
    signIn({ accountId: 1 });
    await reset(() => ({ body: { ok: true, exists: true, identity } }));

    assert.equal(await session.ensureVaultReady(), true);
    assert.equal(vault.isVaultUnlocked(), true);
    assert.equal(storage.get(PASSPHRASE_KEY), undefined, 'the passphrase is no longer in sessionStorage');
    assert.deepEqual(hint(), { accountId: 1, credentialId: null, prf: null }, 'no secret, no expiry — identifiers only');
    assert.equal(answers.length, 0);

    // The point of retiring it: a reload of this tab still unlocks, from the
    // device wrap, with nothing but the account id.
    await reset(() => ({ body: { ok: true, exists: true, identity } }));
    assert.equal(await session.ensureVaultReady(), true, 'the next bootstrap unlocks without the passphrase');
    assert.equal(vault.isVaultUnlocked(), true);
    assert.equal(storage.get(PASSPHRASE_KEY), undefined);
    assert.deepEqual(hint(), { accountId: 1, credentialId: null, prf: null });
});

test('a passkey+password sign-in retires the PRF secret too, once the PRF wrap is enrolled', async () => {
    const vault = await vaultPromise;
    const session = await sessionPromise;
    const { identity } = await vault.createVaultIdentity(PASSPHRASE);
    const prf = Buffer.from(new Uint8Array(32).fill(5)).toString('base64url');
    signIn({ accountId: 1, prf, credentialId: 'cred-1' });
    // GET identity (no PRF wrap yet), then the PUT of the fresh PRF wrap.
    await reset(() => ({ body: { ok: true, exists: true, identity } }), { status: 200, body: { ok: true } });

    assert.equal(await session.ensureVaultReady(), true);
    assert.equal(requests[1]?.options?.method, 'PUT');
    assert.match(requests[1].url, /\/api\/vault\/prf\/cred-1$/, 'the PRF wrap was enrolled while the secret was in hand');
    assert.equal(storage.get(PASSPHRASE_KEY), undefined);
    assert.deepEqual(hint(), { accountId: 1, credentialId: 'cred-1', prf: null }, 'the credential id survives; the secret does not');
});

test('without a device wrap the passphrase stays — it is still the only way back after a reload', async () => {
    const vault = await vaultPromise;
    const session = await sessionPromise;
    const { identity } = await vault.createVaultIdentity(PASSPHRASE);
    // No hint at all (the in-app VaultUnlockModal path stashes only the
    // passphrase): there is no account id to wrap for.
    signIn({ accountId: null });
    await reset(() => ({ body: { ok: true, exists: true, identity } }));

    assert.equal(await session.ensureVaultReady(), true);
    assert.ok(storage.get(PASSPHRASE_KEY), 'nothing else can unlock this tab yet, so the passphrase is kept');
});

test('a first run creates the vault, remembers the device, announces the key, and drops the passphrase', async () => {
    const vault = await vaultPromise;
    const session = await sessionPromise;
    dispatched.length = 0;
    signIn({ accountId: 2 });
    let created = null;
    await reset(
        { status: 200, body: { ok: true, exists: false } },
        () => { created = JSON.parse(requests[1].options.body).identity; return { status: 200, body: { ok: true } }; },
    );

    assert.equal(await session.ensureVaultReady(), true);
    assert.ok(created?.wrapped_mk_pass, 'the new identity was registered');
    const announced = dispatched.find((event) => event.type === 'hivemind-vault-recovery-key');
    assert.ok(announced?.detail?.recoveryKey, 'the recovery key was announced exactly as before');
    assert.equal(storage.get(PASSPHRASE_KEY), undefined, 'the passphrase does not outlive the first run');
    assert.deepEqual(hint(), { accountId: 2, credentialId: null, prf: null });

    // ...and that browser can come back to the vault it just made.
    await reset(() => ({ body: { ok: true, exists: true, identity: created } }));
    assert.equal(await session.ensureVaultReady(), true, 'reload unlocks from the device wrap');
    assert.equal(vault.isVaultUnlocked(), true);
});
