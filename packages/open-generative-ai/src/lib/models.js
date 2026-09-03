// Single source of truth is the vendored model data in ./modelsData.js — the
// hand-maintained MUAPI catalog, edited in place as the provider's schemas
// change. This file exists only so existing imports of "../lib/models" keep
// resolving without touching every consumer.
export * from './modelsData.js';
