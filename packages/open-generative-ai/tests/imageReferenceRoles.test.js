const test = require('node:test');
const assert = require('node:assert/strict');

// Four references and nothing said about them is a guess. These are the words
// that turn a collage into a composite.
const load = () => import('../src/lib/imageReferenceRoles.js');

test('references are addressed the way their family reads them', async () => {
    const { referenceLabelFor, referenceLabelStyleFor } = await load();
    assert.equal(referenceLabelFor(0, 'h3'), '<Picture 1>');
    assert.equal(referenceLabelFor(2, 'h3'), '<Picture 3>');
    assert.equal(referenceLabelFor(0), 'the first reference image');
    assert.equal(referenceLabelFor(3), 'the fourth reference image');
    assert.equal(referenceLabelStyleFor('minimax-h3-image'), 'h3');
    assert.equal(referenceLabelStyleFor('mlx-mxfp8-bigloves-klein3-edit'), 'ordinal');
});

test('a role is written as ownership, naming what does NOT carry', async () => {
    const { referenceRoleClause } = await load();
    const wardrobe = referenceRoleClause('wardrobe', '<Picture 2>');
    assert.match(wardrobe, /^<Picture 2> supplies wardrobe/);
    assert.match(wardrobe, /no identity, pose, environment or camera carries from it/);
});

test('a placement map is stated as coordinates, not pixels', async () => {
    const { referenceRoleClause } = await load();
    const clause = referenceRoleClause('placement', 'the third reference image');
    assert.match(clause, /not an appearance reference/);
    assert.match(clause, /coordinates rather than pixels/);
});

test('an unknown role falls back rather than writing nothing', async () => {
    const { referenceRoleClause, DEFAULT_IMAGE_REFERENCE_ROLE } = await load();
    assert.equal(
        referenceRoleClause('nonsense', '<Picture 1>'),
        referenceRoleClause(DEFAULT_IMAGE_REFERENCE_ROLE, '<Picture 1>'),
    );
});

test('a note rides along with the role, and replaces it entirely for custom', async () => {
    const { referenceRoleClause } = await load();
    assert.match(referenceRoleClause('identity', 'X', 'Keep the scar.'), /appearance only[\s\S]*Keep the scar\./);
    assert.equal(referenceRoleClause('custom', 'X', 'supplies only the tattoo.'), 'X supplies only the tattoo.');
});

test('roles are normalized to exactly the references attached', async () => {
    const { normalizeReferenceRoles } = await load();
    const rows = normalizeReferenceRoles([{ role: 'wardrobe' }, { role: 'style' }, { role: 'lighting' }], 2);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.role), ['wardrobe', 'style']);
    // Growing the row count fills with the default rather than leaving holes.
    assert.equal(normalizeReferenceRoles([{ role: 'wardrobe' }], 3).length, 3);
});

test('all-default roles say nothing, so nothing is written', async () => {
    const { applyReferenceRoles, referenceRolesAreSet } = await load();
    assert.equal(referenceRolesAreSet([{ role: 'identity' }, { role: 'identity' }], 2), false);
    assert.equal(applyReferenceRoles('a woman in a red coat', [{ role: 'identity' }], 1), 'a woman in a red coat');
});

test('the block is appended after the description, never before it', async () => {
    const { applyReferenceRoles, OWNERSHIP_HEADING } = await load();
    const out = applyReferenceRoles('Put her in the leather jacket.', [{ role: 'base_image' }, { role: 'wardrobe' }], 2);
    assert.ok(out.startsWith('Put her in the leather jacket.'));
    assert.ok(out.includes(OWNERSHIP_HEADING));
    assert.equal((out.match(/^- /gm) || []).length, 2);
});

test('re-applying replaces the block rather than stacking a second one', async () => {
    const { applyReferenceRoles, OWNERSHIP_HEADING } = await load();
    const once = applyReferenceRoles('Edit her jacket.', [{ role: 'base_image' }, { role: 'wardrobe' }], 2);
    const twice = applyReferenceRoles(once, [{ role: 'base_image' }, { role: 'style' }], 2);
    assert.equal(twice.split(OWNERSHIP_HEADING).length - 1, 1);
    assert.match(twice, /supplies the visual style only/);
    assert.ok(!twice.includes('supplies wardrobe'));
    assert.ok(twice.startsWith('Edit her jacket.'));
});

test('clearing the roles takes the block back out', async () => {
    const { applyReferenceRoles, stripReferenceOwnership } = await load();
    const withBlock = applyReferenceRoles('Edit her jacket.', [{ role: 'wardrobe' }], 1);
    assert.equal(stripReferenceOwnership(withBlock), 'Edit her jacket.');
    assert.equal(applyReferenceRoles(withBlock, [{ role: 'identity' }], 1), 'Edit her jacket.');
});

test('prose written after the block survives a re-apply', async () => {
    const { applyReferenceRoles } = await load();
    const withBlock = `${applyReferenceRoles('Edit her jacket.', [{ role: 'wardrobe' }], 1)}\n\nShot on 35mm.`;
    const again = applyReferenceRoles(withBlock, [{ role: 'style' }], 1);
    assert.ok(again.includes('Shot on 35mm.'));
    assert.equal(again.split('Reference ownership:').length - 1, 1);
});
