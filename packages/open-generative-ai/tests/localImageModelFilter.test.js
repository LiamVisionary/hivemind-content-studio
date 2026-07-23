import test from 'node:test';
import assert from 'node:assert/strict';

import { visibleLocalImageModels } from '../src/lib/localImageModelFilter.js';

const models = [
    { id: 'z-image', requires: { image: false }, accepts: ['prompt'] },
    { id: 'krea-2', requires: { image: false }, accepts: ['prompt', 'image_base64'] },
    { id: 'biglove', requires: { image: true }, accepts: ['prompt', 'image_base64'] },
];

test('local picker shows image-required workflows before an image is attached', () => {
    assert.deepEqual(
        visibleLocalImageModels(models, false).map(model => model.id),
        ['z-image', 'krea-2', 'biglove'],
    );
});

test('local picker hides workflows that cannot consume an attached image', () => {
    assert.deepEqual(
        visibleLocalImageModels(models, true).map(model => model.id),
        ['krea-2', 'biglove'],
    );
});
