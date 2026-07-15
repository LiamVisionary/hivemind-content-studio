const test = require('node:test');
const assert = require('node:assert/strict');

const { LOCAL_MODEL_CATALOG } = require('../electron/lib/modelCatalog');

test('Ideogram 4 advertises one-off and persistent local runtime modes', () => {
    const model = LOCAL_MODEL_CATALOG.find(m => m.id === 'ideogram4-fp8');
    assert.ok(model);
    assert.deepEqual(model.runtimeModes.map(m => m.id), ['one-off', 'persistent']);
    assert.equal(model.defaultRuntimeMode, 'one-off');
});
