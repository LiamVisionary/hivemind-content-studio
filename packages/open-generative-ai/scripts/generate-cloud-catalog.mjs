#!/usr/bin/env node
// Generate the browser's OFFLINE cloud-model list from the one catalog.
//
//   cd packages/open-generative-ai && npm run catalog:offline
//
// The catalog lives on the server — src/hivemind_content_studio/catalog/
// muapi_models.json — and the studios normally read it over
// /api/muapi/catalog. A standalone build has no control API to ask, so it needs
// a list in the bundle, and this writes that list rather than anyone hand-
// maintaining a second copy. (A hand-maintained second copy is exactly what
// src/lib/modelsData.js was: 12,779 lines, generated once, regenerated never.)
//
// It is deliberately the SMALL version. The bundled list carries what the
// studios READ off a row — the id, the display name, the endpoint, the routing
// flags, and, for each input, the values that drive a control (enum, default,
// range, type) — and drops what only the served catalog needs to carry: the
// provider's prose descriptions and prompt examples, and the server-side
// bookkeeping (upstream_fields, pinned). That keeps it off the landing chunk's
// critical path; the studios load it only when the served catalog is
// unreachable.
//
// Regenerate it whenever the catalog changes — after
// `scripts/regenerate_muapi_catalog.py --write`, or after editing the catalog
// by hand. tests/cloudCatalog.test.js fails when this file is out of date.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CATALOG_PATH = resolve(HERE, '../../../src/hivemind_content_studio/catalog/muapi_models.json');
export const OUTPUT_PATH = resolve(HERE, '../src/lib/generated/cloudCatalogFallback.js');

// Per-input keys the browser reads. `title` labels the control, the rest decide
// what the control IS. `description` is a hover tooltip and `examples` is never
// rendered, so neither earns bundle bytes in the offline list.
const INPUT_KEYS = ['name', 'title', 'type', 'enum', 'default', 'minValue', 'maxValue', 'step'];
// Row keys only the server needs: how the provider spells its own inputs, and
// which of ours are deliberately held away from it.
const SERVER_ONLY_ROW_KEYS = new Set(['upstream_fields', 'upstream_required', 'pinned']);

function trimInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const key of INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key];
  }
  return out;
}

export function trimRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (SERVER_ONLY_ROW_KEYS.has(key)) continue;
    if (key === 'inputs' && value && typeof value === 'object') {
      out.inputs = Object.fromEntries(Object.entries(value).map(([name, input]) => [name, trimInput(input)]));
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function buildFallback(catalog) {
  return Object.fromEntries(
    Object.entries(catalog.buckets).map(([bucket, rows]) => [bucket, rows.map(trimRow)]),
  );
}

export function render(catalog) {
  const buckets = buildFallback(catalog);
  return [
    '// GENERATED FILE — do not edit.',
    '// Source: src/hivemind_content_studio/catalog/muapi_models.json',
    '// Regenerate: cd packages/open-generative-ai && npm run catalog:offline',
    '//',
    '// The offline cloud-model list. The studios read the served catalog',
    '// (/api/muapi/catalog) and only fall back to this when there is no control',
    "// API to ask — a standalone build, or a server that cannot answer.",
    `export const generatedAt = ${JSON.stringify(catalog.generated_at || '')};`,
    `export const buckets = ${JSON.stringify(buckets)};`,
    'export default buckets;',
    '',
  ].join('\n');
}

export function readCatalog() {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const text = render(readCatalog());
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, text);
  process.stdout.write(`wrote ${OUTPUT_PATH} (${text.length} bytes)\n`);
}
