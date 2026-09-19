const test = require('node:test');
const assert = require('node:assert/strict');

// The owner-vault blob transport. A missing blob is 200 + ciphertext null on
// the real server (control_api.get_vault_blob), so a non-OK answer is always a
// failure — and used to be swallowed: a failed GET became "empty library" and a
// failed PUT reported nothing at all, which is how a lapsed session could wipe a
// saved-prompt library. Both now throw, carrying the server's detail.

global.window = { __HIVEMIND_STUDIO__: 1, location: { search: '' }, dispatchEvent() {} };
global.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };

let nextResponse = null;
let lastRequest = null;
global.fetch = async (url, options = {}) => {
    lastRequest = { url, options };
    const { status = 200, body = {} } = nextResponse || {};
    return {
        ok: status < 400,
        status,
        json: async () => {
            if (body === undefined) throw new Error('no body');
            return body;
        },
    };
};

const sessionPromise = import('../src/lib/vaultSession.js');

test('getVaultBlob returns the ciphertext, or null for a blob that was never written', async () => {
    const { getVaultBlob } = await sessionPromise;
    nextResponse = { status: 200, body: { ok: true, ciphertext: 'v1.abc' } };
    assert.equal(await getVaultBlob('library', 'prompts_v1'), 'v1.abc');
    assert.match(lastRequest.url, /^\/api\/vault\/blob\/library\/prompts_v1$/);
    nextResponse = { status: 200, body: { ok: true, ciphertext: null } };
    assert.equal(await getVaultBlob('library', 'prompts_v1'), null);
});

test('getVaultBlob throws on a non-OK read, with the server detail when there is one', async () => {
    const { getVaultBlob } = await sessionPromise;
    nextResponse = { status: 401, body: { detail: 'Sign in to a workspace' } };
    await assert.rejects(() => getVaultBlob('library', 'prompts_v1'), (error) => {
        assert.equal(error.message, 'Sign in to a workspace');
        assert.equal(error.status, 401);
        return true;
    });
    // No JSON body at all: the status still reaches the caller.
    nextResponse = { status: 503, body: undefined };
    await assert.rejects(() => getVaultBlob('library', 'prompts_v1'), /Could not read from your vault \(503\)/);
});

test('putVaultBlob throws on a non-OK write instead of reporting nothing', async () => {
    const { putVaultBlob } = await sessionPromise;
    nextResponse = { status: 200, body: { ok: true } };
    await putVaultBlob('library', 'prompts_v1', 'v1.xyz');
    assert.equal(lastRequest.options.method, 'PUT');
    assert.deepEqual(JSON.parse(lastRequest.options.body), { ciphertext: 'v1.xyz' });

    nextResponse = { status: 400, body: { detail: 'blob too large' } };
    await assert.rejects(() => putVaultBlob('library', 'prompts_v1', 'v1.xyz'), /blob too large/);

    // A FastAPI validation error is an array of { msg } — flattened, never "[object Object]".
    nextResponse = { status: 422, body: { detail: [{ msg: 'field required', loc: ['body', 'ciphertext'] }, { msg: 'too long' }] } };
    await assert.rejects(() => putVaultBlob('library', 'prompts_v1', ''), /field required · too long/);

    nextResponse = { status: 500, body: {} };
    await assert.rejects(() => putVaultBlob('library', 'prompts_v1', 'v1.xyz'), /Could not write to your vault \(500\)/);
});
