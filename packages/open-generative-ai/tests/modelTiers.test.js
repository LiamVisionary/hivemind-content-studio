const test = require('node:test');
const assert = require('node:assert/strict');

async function load() {
    return import('../src/lib/modelTiers.js');
}

const lite = { id: 'hivemind-video:ltx23-eros-v14-lite', name: 'LTX 2.3 Eros v1.4', tierGroup: 'ltx23-eros-v14', tier: 'lite' };
const standard = { id: 'hivemind-video:ltx23-eros-v14', name: 'LTX 2.3 Eros v1.4', tierGroup: 'ltx23-eros-v14', tier: 'standard' };
const plain = { id: 'hivemind-video:ltx23-eros-fast', name: 'LTX 2.3 Eros Fast' };

test('both builds of a model collapse into one picker row', async () => {
    const { groupModelTiers } = await load();
    const rows = groupModelTiers([plain, lite, standard]);

    assert.equal(rows.length, 2);
    const group = rows.find((row) => row.isTierGroup);
    assert.equal(group.tierGroup, 'ltx23-eros-v14');
    assert.equal(group.tiers.lite.id, lite.id);
    assert.equal(group.tiers.standard.id, standard.id);
});

test('models without a tier pass through untouched', async () => {
    const { groupModelTiers } = await load();
    assert.deepEqual(groupModelTiers([plain]), [plain]);
});

test('a lone build never renders a one-sided switch', async () => {
    const { groupModelTiers } = await load();
    const rows = groupModelTiers([lite]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].isTierGroup, undefined);
    assert.equal(rows[0].id, lite.id);
});

test('grouping keeps the position of the first tier encountered', async () => {
    const { groupModelTiers } = await load();
    const rows = groupModelTiers([standard, plain, lite]);

    assert.equal(rows[0].isTierGroup, true);
    assert.deepEqual(rows[1], plain);
});

test('the two builds are never listed as separate rows', async () => {
    const { groupModelTiers } = await load();
    const ids = groupModelTiers([lite, standard]).flatMap((row) => (row.isTierGroup ? [row.tierGroup] : [row.id]));

    assert.deepEqual(ids, ['ltx23-eros-v14']);
});

test('active tier follows the selected model id', async () => {
    const { groupModelTiers, activeTierFor } = await load();
    const [group] = groupModelTiers([lite, standard]);

    assert.equal(activeTierFor(group, standard.id), 'standard');
    assert.equal(activeTierFor(group, lite.id), 'lite');
});

test('active tier defaults to lite when neither build is selected', async () => {
    const { groupModelTiers, activeTierFor } = await load();
    const [group] = groupModelTiers([lite, standard]);

    assert.equal(activeTierFor(group, 'something-else'), 'lite');
});

test('active tier is null for an ungrouped row', async () => {
    const { activeTierFor } = await load();
    assert.equal(activeTierFor(plain, plain.id), null);
});

test('the quality switch appears for either build of a pair', async () => {
    const { tierPairFor } = await load();
    const models = [plain, lite, standard];

    for (const selected of [lite, standard]) {
        const pair = tierPairFor(models, selected.id);
        assert.equal(pair.lite.id, lite.id);
        assert.equal(pair.standard.id, standard.id);
    }
});

test('no quality switch for a model without tiers', async () => {
    const { tierPairFor } = await load();
    assert.equal(tierPairFor([plain, lite, standard], plain.id), null);
});

test('no quality switch when only one build is installed', async () => {
    const { tierPairFor } = await load();
    // Standard missing: rendering a switch would offer a tier that cannot load.
    assert.equal(tierPairFor([plain, lite], lite.id), null);
});

test('no quality switch for an unknown selection', async () => {
    const { tierPairFor } = await load();
    assert.equal(tierPairFor([plain, lite, standard], 'nope'), null);
});
