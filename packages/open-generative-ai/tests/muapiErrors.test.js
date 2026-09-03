const test = require('node:test');
const assert = require('node:assert/strict');

// One reading of a MUAPI failure for Cinema, Lip sync and the prompt helper's
// 422 path. muapi.js throws plain Errors with the status and a 100-char body
// slice in the message; this maps them to something a person can act on.
//
// No `window` at import time: the module also carries the toast helper, and
// react-hot-toast's style engine reaches for `document` as soon as it sees a
// window. The one test that needs a window installs it after the import.

const modPromise = import('../src/lib/muapiErrors.js');

test('flattenApiDetail turns a FastAPI detail array into one line', async () => {
    const { flattenApiDetail } = await modPromise;
    assert.equal(flattenApiDetail([{ msg: 'field required' }, { msg: 'value is not a valid float' }]), 'field required · value is not a valid float');
    assert.equal(flattenApiDetail('plain text'), 'plain text');
    assert.equal(flattenApiDetail({ message: 'nested' }), 'nested');
    assert.equal(flattenApiDetail(null), '');
    assert.equal(flattenApiDetail(['a', { msg: 'b' }]), 'a · b');
});

test('muapiErrorStatus reads the status muapi.js puts in the message', async () => {
    const { muapiErrorStatus } = await modPromise;
    assert.equal(muapiErrorStatus(new Error('API Request Failed: 401 Unauthorized - {"detail":"bad key"}')), 401);
    assert.equal(muapiErrorStatus(new Error('Poll Failed: 404 - not found')), 404);
    assert.equal(muapiErrorStatus(new Error('File upload failed: 413 - too big')), 413);
    // The body can hold numbers of its own; the status is the one after "Failed:".
    assert.equal(muapiErrorStatus(new Error('API Request Failed: 400 Bad Request - {"detail":"width 1024 not allowed"}')), 400);
    assert.equal(muapiErrorStatus({ status: 503, message: 'x' }), 503);
    assert.equal(muapiErrorStatus(new Error('Generation failed: nsfw content')), 0);
    assert.equal(muapiErrorStatus(new Error('Generation timed out after polling.')), 0);
});

test('describeMuapiError: a rejected or missing key names the fix, not a page', async () => {
    // The toast carries the "Add key" button (studios/lipsync/muapiErrorToast.jsx),
    // so the sentence must not send anyone to Settings to look for it — and on a
    // machine that holds the key there is nothing in Settings to find.
    const { describeMuapiError } = await modPromise;
    const rejected = describeMuapiError(new Error('API Request Failed: 401 Unauthorized - {"detail":"Invalid API key"}'));
    assert.equal(rejected.keyRejected, true);
    assert.match(rejected.message, /MUAPI key rejected/);
    assert.doesNotMatch(rejected.message, /Settings/);
    assert.equal(describeMuapiError(new Error('API Request Failed: 403 Forbidden - ')).keyRejected, true);
    const missing = describeMuapiError(new Error('API Key missing. Add your MUAPI key to continue.'));
    assert.equal(missing.keyRejected, true);
    assert.match(missing.message, /MUAPI key missing/);
    assert.doesNotMatch(missing.message, /Settings/);
});

test('describeMuapiError: a 4xx carries what the server said, a 5xx names the status', async () => {
    const { describeMuapiError } = await modPromise;
    const refused = describeMuapiError(new Error('API Request Failed: 400 Bad Request - {"detail":"image_url must be a public URL"}'));
    assert.equal(refused.status, 400);
    assert.equal(refused.message, 'MUAPI refused the request: image_url must be a public URL');
    // A FastAPI array inside the body slice is flattened too.
    const flat = describeMuapiError(new Error('API Request Failed: 422 Unprocessable - {"detail":[{"msg":"field required"}]}'));
    assert.equal(flat.message, 'MUAPI refused the request: field required');
    // A truncated (unparseable) JSON body is dropped rather than pasted.
    const cut = describeMuapiError(new Error('API Request Failed: 400 Bad Request - {"detail":"a very long messa'));
    assert.equal(cut.message, 'MUAPI refused the request (400)');
    // A plain-text body is kept.
    assert.equal(describeMuapiError(new Error('Poll Failed: 404 - request not found')).message, 'MUAPI refused the request: request not found');
    const down = describeMuapiError(new Error('API Request Failed: 503 Service Unavailable - upstream'));
    assert.equal(down.status, 503);
    assert.match(down.message, /MUAPI request failed \(503\)/);
    assert.equal(down.keyRejected, false);
});

test('describeMuapiError: messages that already say what happened pass through', async () => {
    const { describeMuapiError } = await modPromise;
    assert.equal(describeMuapiError(new Error('Generation failed: nsfw content')).message, 'Generation failed: nsfw content');
    assert.equal(describeMuapiError(new Error('Generation timed out after polling.')).message, 'Generation timed out after polling.');
    assert.match(describeMuapiError(new TypeError('Failed to fetch')).message, /could not be reached/);
    assert.equal(describeMuapiError(null).message, 'MUAPI request failed');
});

test('openStudioSettings dispatches the navigate event the app router treats as "open settings"', async () => {
    const { openStudioSettings } = await modPromise;
    let seen = null;
    global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
    global.window = { dispatchEvent: (event) => { seen = event; } };
    openStudioSettings();
    assert.equal(seen.type, 'navigate');
    assert.deepEqual(seen.detail, { page: 'settings' });
});
