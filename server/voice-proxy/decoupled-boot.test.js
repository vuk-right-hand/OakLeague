// Unit tests for decoupled-boot.js — DECOUPLED_BRAIN_PLAN P1-5 C3 gate.
//
// The C3 audit finding made boot-prime a HARD ordering gate: a creator
// flagged `decoupled` with BRAIN_*/PARAPHRASE_* pricing missing must
// FATAL at boot (never silently mis-price a paid LLM call), the same
// posture as Cartesia/Hume. decoupled is data-driven (per-creator, no
// global env), so the gate probes for any decoupled creator exactly
// like the verified Hume per-creator-override probe. This is the "boot
// assertion test" C3 requires — a real unit (DI'd probe/getters/fatal),
// NOT an un-testable top-level-await + process.exit side effect.
//
// Run: cd server/voice-proxy && node --test decoupled-boot.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionDecoupledBrainPricing } from './decoupled-boot.js';

const SILENT = { warn() {}, log() {} };
function spyFatal() {
  const calls = [];
  const fatal = (msg) => { calls.push(msg); };
  return { fatal, calls };
}

test('zero decoupled creators → inert: pricing getters NOT called, no fatal', async () => {
  const { fatal, calls } = spyFatal();
  let getBrainCalled = false, getParaCalled = false;
  const r = await provisionDecoupledBrainPricing({
    probeAnyDecoupledCreator: async () => ({ found: false }),
    getBrain: () => { getBrainCalled = true; },
    getParaphrase: () => { getParaCalled = true; },
    log: SILENT, fatal,
  });
  assert.equal(r.inert, true);
  assert.equal(r.primed, false);
  assert.equal(getBrainCalled, false, 'no pricing requirement when zero decoupled creators');
  assert.equal(getParaCalled, false);
  assert.equal(calls.length, 0, 'never FATAL when no creator is decoupled');
});

test('decoupled creator present + pricing OK → primed, no fatal', async () => {
  const { fatal, calls } = spyFatal();
  const order = [];
  const r = await provisionDecoupledBrainPricing({
    probeAnyDecoupledCreator: async () => ({ found: true }),
    getBrain: () => order.push('brain'),
    getParaphrase: () => order.push('paraphrase'),
    log: SILENT, fatal,
  });
  assert.equal(r.primed, true);
  assert.equal(r.fatal, false);
  assert.deepEqual(order, ['brain', 'paraphrase'], 'both pricing singletons primed at boot');
  assert.equal(calls.length, 0);
});

test('C2 — decoupled creator present + α\' (VOICE_TTS_LAYER_ENABLED) OFF → FATAL, pricing never probed', async () => {
  const { fatal, calls } = spyFatal();
  let getBrainCalled = false;
  const r = await provisionDecoupledBrainPricing({
    probeAnyDecoupledCreator: async () => ({ found: true }),
    ttsLayerEnabled: false,
    getBrain: () => { getBrainCalled = true; },
    getParaphrase: () => {},
    log: SILENT, fatal,
  });
  assert.equal(r.fatal, true);
  assert.equal(r.primed, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /FATAL.*decoupled.*VOICE_TTS_LAYER_ENABLED/);
  assert.equal(getBrainCalled, false, 'α\' off is fatal BEFORE pricing is even resolved');
});

test('M1 — deferred path leaves the pricing singletons COLD (getters never called)', async () => {
  const { fatal, calls } = spyFatal();
  let brain = 0, para = 0;
  const r = await provisionDecoupledBrainPricing({
    probeAnyDecoupledCreator: async () => ({ error: 'supabase 503' }),
    getBrain: () => { brain++; },
    getParaphrase: () => { para++; },
    log: SILENT, fatal,
  });
  assert.equal(r.deferred, true);
  assert.equal(brain, 0);
  assert.equal(para, 0, 'deferred ⇒ singletons stay cold ⇒ first decoupled session lazy-validates');
  assert.equal(calls.length, 0);
});

test('decoupled creator present + BRAIN pricing misconfigured → FATAL', async () => {
  const { fatal, calls } = spyFatal();
  const r = await provisionDecoupledBrainPricing({
    probeAnyDecoupledCreator: async () => ({ found: true }),
    getBrain: () => { throw new Error('BRAIN_USD_PER_INPUT_TOKEN not set (fail-closed)'); },
    getParaphrase: () => {},
    log: SILENT, fatal,
  });
  assert.equal(r.fatal, true);
  assert.equal(r.primed, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /FATAL.*decoupled.*BRAIN_USD_PER_INPUT_TOKEN/);
});

test('decoupled creator present + PARAPHRASE pricing misconfigured → FATAL', async () => {
  const { fatal, calls } = spyFatal();
  const r = await provisionDecoupledBrainPricing({
    probeAnyDecoupledCreator: async () => ({ found: true }),
    getBrain: () => {},
    getParaphrase: () => { throw new Error('PARAPHRASE_QUOTED_AT not set'); },
    log: SILENT, fatal,
  });
  assert.equal(r.fatal, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /FATAL.*decoupled.*PARAPHRASE_QUOTED_AT/);
});

test('probe returns {error} (Supabase blip) → deferred to lazy, NOT fatal (C4 resilience)', async () => {
  const { fatal, calls } = spyFatal();
  let getBrainCalled = false;
  const r = await provisionDecoupledBrainPricing({
    probeAnyDecoupledCreator: async () => ({ error: 'connection reset' }),
    getBrain: () => { getBrainCalled = true; },
    getParaphrase: () => {},
    log: SILENT, fatal,
  });
  assert.equal(r.deferred, true);
  assert.equal(r.primed, false);
  assert.equal(getBrainCalled, false, 'a transient probe failure must NOT crash-loop a zero-decoupled fleet');
  assert.equal(calls.length, 0);
});

test('probe throws → deferred to lazy, NOT fatal', async () => {
  const { fatal, calls } = spyFatal();
  const r = await provisionDecoupledBrainPricing({
    probeAnyDecoupledCreator: async () => { throw new Error('socket hang up'); },
    getBrain: () => {},
    getParaphrase: () => {},
    log: SILENT, fatal,
  });
  assert.equal(r.deferred, true);
  assert.equal(calls.length, 0);
});
