// The server catalog is the only catalog.
//
// It used to be two: a 12,779-line vendored copy of the provider's model list in
// the browser (src/lib/modelsData.js), and a second hand-typed list of the same
// provider's models on the server. These tests exist so a third never appears,
// and so the browser's offline copy can never quietly drift from the served one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyCloudCatalog, audioModels, catalogSource, cloudCatalogReady, getAspectRatiosForI2VModel,
  getAspectRatiosForModel, getDurationsForI2VModel, getDurationsForModel, getEffectsForI2VModel,
  getLipSyncModelById, getMaxImagesForI2VModel, getModelById, getQualityFieldForModel,
  getResolutionsForLipSyncModel, i2iModels, i2vModels, imageLipSyncModels, lipsyncModels,
  recastModels, resetCloudCatalog, t2iModels, t2vModels, v2vModels, videoLipSyncModels,
} from '../src/lib/cloudCatalog.js';
import { buildFallback, readCatalog } from '../scripts/generate-cloud-catalog.mjs';
import { buckets as fallbackBuckets } from '../src/lib/generated/cloudCatalogFallback.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const BUCKETS = ['t2i', 't2v', 'i2i', 'i2v', 'v2v', 'lipsync', 'recast', 'audio'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { walk(path, out); continue; }
    if (/\.(js|jsx)$/.test(entry)) out.push(path);
  }
  return out;
}

/* ---------------- the vendored dump is gone ---------------- */

test('nothing imports the deleted vendored model dump', () => {
  const offenders = [];
  for (const path of walk(SRC)) {
    const source = readFileSync(path, 'utf8');
    // The import, not the word: cloudCatalog.js explains in prose what it
    // replaced, and that history is worth keeping.
    if (/from ['"][^'"]*\/(modelsData|models)\.js['"]/.test(source)) offenders.push(path);
  }
  assert.deepEqual(offenders, [], 'modelsData.js and its re-export shim are gone');
});

/* ---------------- one catalog, two readers ---------------- */

test('the offline list is regenerated from the served catalog, not maintained beside it', () => {
  // `node scripts/generate-cloud-catalog.mjs` regenerates the bundled file. If
  // this fails, the catalog moved and nobody re-ran it.
  assert.deepEqual(fallbackBuckets, buildFallback(readCatalog()));
});

test('the offline list carries every model the server serves, and the same options', () => {
  const served = readCatalog().buckets;
  for (const bucket of BUCKETS) {
    assert.deepEqual(
      fallbackBuckets[bucket].map((m) => m.id),
      served[bucket].map((m) => m.id),
      `${bucket}: same models in the same order`,
    );
  }
  // The trim drops prose, never a value that drives a control.
  for (const bucket of BUCKETS) {
    served[bucket].forEach((row, index) => {
      const offline = fallbackBuckets[bucket][index];
      for (const [name, input] of Object.entries(row.inputs || {})) {
        for (const key of ['enum', 'default', 'minValue', 'maxValue', 'step', 'type']) {
          assert.deepEqual(offline.inputs[name][key], input[key], `${row.id}.${name}.${key}`);
        }
      }
    });
  }
});

test('the offline list drops the prose the studios never render', () => {
  const inputs = BUCKETS.flatMap((b) => fallbackBuckets[b].flatMap((m) => Object.values(m.inputs || {})));
  assert.ok(inputs.length > 400, 'sanity: inputs were actually walked');
  assert.ok(!inputs.some((input) => 'examples' in input), 'prompt examples are never rendered');
  assert.ok(!inputs.some((input) => 'description' in input), 'input descriptions are a tooltip only');
  // Server-side bookkeeping stays on the server.
  const rows = BUCKETS.flatMap((b) => fallbackBuckets[b]);
  assert.ok(!rows.some((row) => 'pinned' in row || 'upstream_fields' in row));
});

/* ---------------- what the studios read ---------------- */

test('the studios load the model set the server serves', async () => {
  await cloudCatalogReady();
  // No control API in a node test, so this is the offline path — which is the
  // one a standalone build takes, and it must carry the same set.
  assert.equal(catalogSource, 'offline');
  const served = readCatalog().buckets;
  const lists = {
    t2i: t2iModels, t2v: t2vModels, i2i: i2iModels, i2v: i2vModels,
    v2v: v2vModels, lipsync: lipsyncModels, recast: recastModels, audio: audioModels,
  };
  for (const bucket of BUCKETS) {
    assert.deepEqual(lists[bucket].map((m) => m.id), served[bucket].map((m) => m.id), bucket);
  }
  assert.ok(t2iModels.length > 40 && i2vModels.length > 40, 'sanity: the studios have models');
});

test('aspect ratios, durations and effects come off catalog rows', async () => {
  await cloudCatalogReady();
  // A model that declares an enum gets exactly that enum.
  assert.deepEqual(getAspectRatiosForModel('nano-banana'), getModelById('nano-banana').inputs.aspect_ratio.enum);
  // Seedance 2.5 reaches 30s in one generation, and the ladder is ours: upstream
  // declares a 4-30 RANGE, which a picker would collapse to the default alone.
  assert.deepEqual(getDurationsForModel('seedance-2.5-text-to-video'), [5, 10, 15, 20, 25, 30]);
  // An i2v model that declares a range gets the range expanded into steps.
  const ranged = i2vModels.find((m) => m.inputs?.duration?.step && !m.inputs.duration.enum);
  if (ranged) {
    const durations = getDurationsForI2VModel(ranged.id);
    assert.ok(durations.length > 1, `${ranged.id} offers its whole range`);
    assert.equal(durations[0], ranged.inputs.duration.minValue);
  }
  // An unknown model never returns nothing — the picker would have no options.
  assert.deepEqual(getAspectRatiosForModel('not-a-model'), ['1:1']);
  assert.deepEqual(getAspectRatiosForI2VModel('not-a-model'), ['16:9']);
  assert.deepEqual(getDurationsForModel('not-a-model'), [5]);
  // Effects models declare their effect list as `inputs.name`.
  const effects = i2vModels.find((m) => m.inputs?.name?.enum);
  assert.ok(getEffectsForI2VModel(effects.id).length > 0);
  // Quality and resolution are one control under two provider spellings.
  const withQuality = t2iModels.find((m) => m.inputs?.quality && !m.inputs?.resolution);
  if (withQuality) assert.equal(getQualityFieldForModel(withQuality.id), 'quality');
  const withResolution = t2iModels.find((m) => m.inputs?.resolution);
  if (withResolution) assert.equal(getQualityFieldForModel(withResolution.id), 'resolution');
});

test('lip sync splits into its two lanes, with each model resolvable', async () => {
  await cloudCatalogReady();
  assert.equal(imageLipSyncModels.length + videoLipSyncModels.length, lipsyncModels.length);
  assert.ok(imageLipSyncModels.length > 0 && videoLipSyncModels.length > 0);
  for (const model of lipsyncModels) {
    assert.equal(getLipSyncModelById(model.id).id, model.id);
    assert.deepEqual(getResolutionsForLipSyncModel(model.id), model.inputs?.resolution?.enum || []);
  }
});

test('a model taking a last frame takes two pictures', async () => {
  await cloudCatalogReady();
  const withLast = i2vModels.find((m) => m.lastImageField && !m.maxImages);
  assert.ok(withLast, 'sanity: some model wires an end frame');
  assert.equal(getMaxImagesForI2VModel(withLast.id), 2);
  assert.equal(getMaxImagesForI2VModel('not-a-model'), 1);
});

test('ids are unique within each bucket', async () => {
  await cloudCatalogReady();
  const lists = { t2i: t2iModels, t2v: t2vModels, i2i: i2iModels, i2v: i2vModels, v2v: v2vModels };
  for (const [bucket, rows] of Object.entries(lists)) {
    const ids = rows.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, `${bucket} has a duplicate id`);
  }
});

/* ---------------- degrading ---------------- */

test('an empty catalog leaves the accessors answering, not throwing', () => {
  resetCloudCatalog();
  assert.deepEqual(t2iModels, []);
  assert.deepEqual(getAspectRatiosForModel('nano-banana'), ['1:1']);
  assert.equal(getMaxImagesForI2VModel('anything'), 1);
  applyCloudCatalog(fallbackBuckets, 'offline');
  assert.ok(t2iModels.length > 40, 'and the rows come back when a catalog lands');
});
