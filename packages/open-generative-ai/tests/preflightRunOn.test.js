import assert from 'node:assert/strict';
import test from 'node:test';
import { preflightRunOn } from '../src/studios/video/videoLogic.js';

// The dependency preflight asks ONE lane what it is missing. It used to ask the
// tab's pin or, with no pin, the default lane — this Mac. So selecting a
// rental-only workflow on a tab that had made no choice asked the wrong
// machine, got a truthful "that card is wrong and four files are missing", and
// bounced the tab onto Wan 2.2 with a banner — while the attached box was
// serving that exact workflow with nothing missing.
//
// Measured 2026-09-14 against the live gateway, same second, same workflow:
//   minimax-h3-eros on lane 'default'  -> hardware.supported false, 6 missing
//   minimax-h3-eros on the rental lane -> supported, nothing missing

const eros = { id: 'hivemind-media:minimax-h3-eros', name: 'MiniMax H3 Eros Max' };
const wan = { id: 'wan-2-2-i2v', name: 'Wan 2.2 I2V' };
const erosBox = { rental_id: 'vast:50991951', models_served: ['minimax_h3', '10eros_max'] };
const imageBox = { rental_id: 'vast:11', models_served: ['krea2_turbo_convrot'] };

test('with no pin, asks a machine that actually serves the lane', () => {
  assert.equal(preflightRunOn({}, [erosBox], eros), 'vast:50991951');
});

test('an explicit pin always wins — it is the tab owner\'s choice, not a guess', () => {
  assert.equal(
    preflightRunOn({ rentedMachineId: 'vast:99' }, [erosBox], eros),
    'vast:99',
  );
});

test('no machine serves it: ask the default lane, so the prompt can offer the install', () => {
  // '' means "the default lane". That is the RIGHT answer here: nothing else
  // can run it, so the preflight should say what this machine is short of
  // rather than silently pointing at a box that cannot help either.
  assert.equal(preflightRunOn({}, [imageBox], eros), '');
  assert.equal(preflightRunOn({}, [], eros), '');
});

test('a lane this Mac runs is not sent to a rented box just because one is attached', () => {
  // Wan matches none of the box's needles, so the preflight stays local — the
  // question "what is this Mac missing for Wan" is the one worth asking.
  assert.equal(preflightRunOn({}, [erosBox], wan), '');
});

test('no model selected yet is not a question for any lane', () => {
  assert.equal(preflightRunOn({}, [erosBox], null), '');
  assert.equal(preflightRunOn({}, [erosBox], undefined), '');
});

test('survives the shapes that actually arrive before the machine list does', () => {
  assert.equal(preflightRunOn(null, null, eros), '');
  assert.equal(preflightRunOn(undefined, undefined, eros), '');
});
