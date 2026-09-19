const test = require('node:test');
const assert = require('node:assert/strict');

// A 500 now answers `{detail, incident}` — a short id that is also in the
// studio's log file. The browser used to throw both away: `api()` read only
// `detail`, and an object detail (PassBook's `{message, remedy}`) became the
// string "[object Object]" in the toast. These pin the carrying.

let instance = 0;
function freshHub() {
    instance += 1;
    return import(`../src/hub/hubData.js?failure=${instance}`);
}

function response(body, { ok = false, status = 500 } = {}) {
    return {
        ok,
        status,
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

test('a 500 arrives as an error carrying the incident id, not a bare sentence', async () => {
    const { api } = await freshHub();
    global.fetch = async () => response({ detail: 'Something went wrong. Copy the details and send them with your report.', incident: 'ab12cd' });

    const error = await api('/api/runtime').then(() => null, (caught) => caught);

    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Something went wrong. Copy the details and send them with your report.');
    assert.equal(error.incident, 'ab12cd');
    assert.equal(error.status, 500);
    // Nothing developer-facing crossed into the sentence a person is shown.
    assert.ok(!/control API log|npm|HIVE_HOME/.test(error.message));
});

test('an object detail keeps its message and its remedy instead of becoming [object Object]', async () => {
    const { api } = await freshHub();
    global.fetch = async () => response(
        { detail: { message: 'This build cannot encrypt the shared credential store.', remedy: 'open-passbook' } },
        { status: 409 },
    );

    const error = await api('/api/passbook/seal', { method: 'POST' }).then(() => null, (caught) => caught);

    assert.equal(error.message, 'This build cannot encrypt the shared credential store.');
    assert.equal(error.remedy, 'open-passbook');
    assert.equal(error.detail.message, 'This build cannot encrypt the shared credential store.');
    assert.equal(error.incident, '');
});

test('the copied details are one line with the id, the code and the moment', async () => {
    const { failureDetails, incidentOf } = await import('../src/lib/failureToast.js');
    const error = Object.assign(new Error('Something went wrong.'), { incident: 'ab12cd', status: 500 });

    assert.equal(incidentOf(error), 'ab12cd');
    const details = failureDetails(error, { context: 'Create production' });
    assert.match(details, /^Something went wrong\. · incident #ab12cd · HTTP 500 · Create production · \d{4}-/);
    // No stack, ever: it names files on this machine.
    assert.ok(!details.includes('at '));
    assert.equal(incidentOf(new Error('plain')), '');
});
