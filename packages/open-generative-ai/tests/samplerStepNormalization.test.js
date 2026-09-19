import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSamplerSteps } from '../src/lib/genProgress.js';

// MiniMax H3 runs Spectrum with offline_smoothing_replay, which samples the
// schedule twice and reports progress over both passes (total_work = steps*2).
// Measured on a rented box 2026-08-10: Standard (15 steps) reported max 30,
// High detail (32) reported max 64 — while the Refinement control said 15/32.

test('Spectrum double-counting folds back to the chosen Refinement steps', () => {
  assert.deepEqual(normalizeSamplerSteps(0, 30, 15), { step: 0, total: 15 });
  assert.deepEqual(normalizeSamplerSteps(1, 30, 15), { step: 1, total: 15 });
  assert.deepEqual(normalizeSamplerSteps(15, 30, 15), { step: 8, total: 15 });
  // The replay pass must not push the label past the total.
  assert.deepEqual(normalizeSamplerSteps(30, 30, 15), { step: 15, total: 15 });
  assert.deepEqual(normalizeSamplerSteps(64, 64, 32), { step: 32, total: 32 });
});

test('a total that is not exactly double is reported as it arrived', () => {
  // Spectrum off: the sampler reports the real count and nothing is folded.
  assert.deepEqual(normalizeSamplerSteps(7, 15, 15), { step: 7, total: 15 });
  // A workflow that genuinely runs more steps than asked keeps its own truth.
  assert.deepEqual(normalizeSamplerSteps(9, 40, 15), { step: 9, total: 40 });
  // Unknown request (a cloud model, or a resumed job): pass through.
  assert.deepEqual(normalizeSamplerSteps(9, 30, null), { step: 9, total: 30 });
});

test('no counter at all stays absent rather than reading as zero of zero', () => {
  assert.equal(normalizeSamplerSteps(0, 0, 15), null);
  assert.equal(normalizeSamplerSteps(null, null, 15), null);
});
