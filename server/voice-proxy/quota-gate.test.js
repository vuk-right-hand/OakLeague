// Unit tests for quota-gate decision logic — Round-2 audit C4 regression guard.
//
// Prior behavior failed open on RPC error, which let a kill-switched user
// burn indefinitely during any Supabase brownout. These tests lock the new
// semantics in place.
//
// Run: cd server/voice-proxy && node --test quota-gate.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideQuotaGate } from './quota-gate.js';

test('healthy RPC + healthy quota → allow, cache snapshot', () => {
  const out = decideQuotaGate({
    rpc: { row: { kill_switch_fired_at: null, over_150_pct: false }, error: null },
    priorCache: undefined,
  });
  assert.equal(out.gate.ok, true);
  assert.equal(out.gate.reason, '');
  // C3 grew healthy to also carry the soft-exhaustion snapshot; assert the hard fields.
  assert.equal(out.nextCache.healthy.fired, false);
  assert.equal(out.nextCache.healthy.over150, false);
  assert.equal(out.nextCache.graceUsed, false);
});

test('healthy RPC + kill-switch fired → deny', () => {
  const out = decideQuotaGate({
    rpc: { row: { kill_switch_fired_at: '2026-04-21T12:00:00Z', over_150_pct: true }, error: null },
    priorCache: undefined,
  });
  assert.equal(out.gate.ok, false);
  assert.equal(out.gate.reason, 'kill_switch_fired');
});

test('healthy RPC + over 150% but latch not yet set → deny', () => {
  // Edge: over_150_pct computed true but kill_switch_fired_at trigger hasn't
  // run yet (race between UPDATE and trigger). Treat as fired — do not grant
  // turns on the basis of a latch-in-flight.
  const out = decideQuotaGate({
    rpc: { row: { kill_switch_fired_at: null, over_150_pct: true }, error: null },
    priorCache: undefined,
  });
  assert.equal(out.gate.ok, false);
  assert.equal(out.gate.reason, 'kill_switch_fired');
});

test('RPC fails + prior healthy snapshot = allowed → allow with degraded reason', () => {
  const out = decideQuotaGate({
    rpc: { row: null, error: new Error('timeout') },
    priorCache: { healthy: { fired: false, over150: false }, graceUsed: false },
  });
  assert.equal(out.gate.ok, true);
  assert.equal(out.gate.reason, 'quota_check_degraded');
  assert.deepEqual(out.nextCache, { healthy: { fired: false, over150: false }, graceUsed: false },
    'cache must not be mutated by a failed RPC');
});

test('C4 CORE: RPC fails + prior snapshot = FIRED → deny (no fail-open)', () => {
  // This is the exact regression the audit called out. Before C4, a failed
  // RPC returned true (allow) even when the session was already kill-switched.
  const out = decideQuotaGate({
    rpc: { row: null, error: new Error('supabase unreachable') },
    priorCache: { healthy: { fired: true, over150: true }, graceUsed: false },
  });
  assert.equal(out.gate.ok, false);
  assert.equal(out.gate.reason, 'kill_switch_fired');
});

test('RPC fails + no prior snapshot, first call → cold-start grace (allow once)', () => {
  const out = decideQuotaGate({
    rpc: { row: null, error: new Error('first call timeout') },
    priorCache: undefined,
  });
  assert.equal(out.gate.ok, true);
  assert.equal(out.gate.reason, 'cold_start_grace');
  assert.equal(out.nextCache.graceUsed, true);
  assert.equal(out.nextCache.healthy, null);
});

test('C4 CORE: RPC fails + no prior snapshot, grace used → deny', () => {
  // Second RPC failure in a row without ever getting a healthy check:
  // don't grant unlimited free turns.
  const priorCache = { healthy: null, graceUsed: true };
  const out = decideQuotaGate({
    rpc: { row: null, error: new Error('still failing') },
    priorCache,
  });
  assert.equal(out.gate.ok, false);
  assert.equal(out.gate.reason, 'quota_check_unavailable');
});

test('RPC recovers after grace → healthy snapshot overrides graceUsed', () => {
  // After a cold-start grace turn, a successful RPC should reset the cache
  // to healthy. Subsequent RPC failures trust the snapshot, not grace.
  const afterGrace = decideQuotaGate({
    rpc: { row: null, error: new Error('1st fail') },
    priorCache: undefined,
  });
  const afterRecover = decideQuotaGate({
    rpc: { row: { kill_switch_fired_at: null, over_150_pct: false }, error: null },
    priorCache: afterGrace.nextCache,
  });
  assert.equal(afterRecover.nextCache.healthy.fired, false);
  assert.equal(afterRecover.nextCache.healthy.over150, false);
  assert.equal(afterRecover.nextCache.graceUsed, true, 'graceUsed carries forward (spent once)');

  const afterFailAgain = decideQuotaGate({
    rpc: { row: null, error: new Error('2nd fail') },
    priorCache: afterRecover.nextCache,
  });
  assert.equal(afterFailAgain.gate.ok, true,
    'healthy snapshot drives decision even though graceUsed=true');
  assert.equal(afterFailAgain.gate.reason, 'quota_check_degraded');
});

test('healthy RPC returns empty row → treated as missing (error path), grace applies', () => {
  // The proxy wrapper converts "no row" into error. Pure function gets
  // row=null + error=truthy and should hit the degraded/grace path.
  const out = decideQuotaGate({
    rpc: { row: null, error: new Error('voice_check_quota returned no row') },
    priorCache: undefined,
  });
  assert.equal(out.gate.ok, true);
  assert.equal(out.gate.reason, 'cold_start_grace');
});

test('B1: fatal RPC (P0002) → deny + fatal flag, no grace, cache untouched', () => {
  // voice_check_quota raised P0002 — daily_quotas row is gone. This is a
  // quota-state inconsistency; caller must teardown with WS 4006. Must NOT
  // grant cold-start grace (no prior cache) and must NOT consult a healthy
  // snapshot (stale state doesn't overrule a db-level invariant break).
  const out = decideQuotaGate({
    rpc: { row: null, error: new Error('P0002'), fatal: true },
    priorCache: undefined,
  });
  assert.equal(out.gate.ok, false);
  assert.equal(out.gate.fatal, true);
  assert.equal(out.gate.reason, 'quota_state_inconsistent');
  assert.deepEqual(out.nextCache, { healthy: null, graceUsed: false },
    'fatal path must not burn cold-start grace');
});

test('B1: fatal RPC even when prior snapshot is healthy → still deny + fatal', () => {
  // A previously healthy session whose daily_quotas row vanished mid-flight
  // (admin deleted, trigger regressed, etc.) must tear down. The healthy
  // cache is stale — the database authority trumps it.
  const out = decideQuotaGate({
    rpc: { row: null, error: new Error('P0002'), fatal: true },
    priorCache: { healthy: { fired: false, over150: false }, graceUsed: false },
  });
  assert.equal(out.gate.ok, false);
  assert.equal(out.gate.fatal, true);
  assert.equal(out.gate.reason, 'quota_state_inconsistent');
});

// ── Phase 2: answer-end soft gate (Growth & Minutes Economy) ───────────────

const softRow = (over) => ({
  rpc: { row: { kill_switch_fired_at: null, over_150_pct: false, remaining_seconds: over.eff, allowance_remaining: over.allow, cap_period: over.cap ?? 'daily' }, error: null },
  priorCache: undefined,
  softGateEnabled: over.soft ?? true,
  ledgerOn: over.ledger ?? true,
});

test('soft gate OFF (flag unset) + exhausted → still allow (inert)', () => {
  const out = decideQuotaGate(softRow({ eff: 0, allow: 0, soft: false }));
  assert.equal(out.gate.ok, true);
  assert.equal(out.gate.soft, undefined);
});

test('soft gate ON + effective exhausted (ledgerOn) → soft deny, not hard', () => {
  const out = decideQuotaGate(softRow({ eff: 0, allow: 0, cap: 'weekly' }));
  assert.equal(out.gate.ok, false);
  assert.equal(out.gate.soft, true);
  assert.equal(out.gate.reason, 'tier_exhausted');
  assert.equal(out.gate.remaining_seconds, 0);
  assert.equal(out.gate.cap_period, 'weekly');
});

test('soft gate ON + balance remaining → allow', () => {
  const out = decideQuotaGate(softRow({ eff: 120, allow: 120 }));
  assert.equal(out.gate.ok, true);
  assert.equal(out.gate.soft, undefined);
});

test('soft gate ON + HARD (over150) trumps soft even at 0 balance', () => {
  const out = decideQuotaGate({
    rpc: { row: { kill_switch_fired_at: null, over_150_pct: true, remaining_seconds: 0, allowance_remaining: 0, cap_period: 'daily' }, error: null },
    priorCache: undefined, softGateEnabled: true, ledgerOn: true,
  });
  assert.equal(out.gate.ok, false);
  assert.equal(out.gate.soft, undefined, 'hard kill is not a soft gate');
  assert.equal(out.gate.reason, 'kill_switch_fired');
});

test('C1 co-gate: ledger OFF uses allowance — wallet does NOT rescue', () => {
  // Free pool exhausted but wallet has 500s. With the ledger flag OFF (proxy
  // not drawing the wallet), the soft gate must fire on allowance so we never
  // grant minutes the proxy isn't decrementing.
  const out = decideQuotaGate(softRow({ eff: 500, allow: 0, ledger: false }));
  assert.equal(out.gate.ok, false);
  assert.equal(out.gate.soft, true);
});

test('C1 co-gate: ledger ON uses effective — wallet rescues', () => {
  const out = decideQuotaGate(softRow({ eff: 500, allow: 0, ledger: true }));
  assert.equal(out.gate.ok, true);
  assert.equal(out.gate.soft, undefined);
});

test('soft exhaustion IS cached for the degraded fail-closed path (C3)', () => {
  const out = decideQuotaGate(softRow({ eff: 0, allow: 0, cap: 'daily' }));
  assert.equal(out.nextCache.healthy.fired, false);
  assert.equal(out.nextCache.healthy.over150, false);
  assert.equal(out.nextCache.healthy.softExhausted, true);
  assert.equal(out.nextCache.healthy.softCapPeriod, 'daily');
});

test('C3: degraded RPC + cached soft-exhausted → fail CLOSED (re-soft-gate, no free turn)', () => {
  const healthy = decideQuotaGate(softRow({ eff: 0, allow: 0, cap: 'weekly' }));
  assert.equal(healthy.gate.soft, true);
  const degraded = decideQuotaGate({
    rpc: { row: null, error: new Error('brownout') },
    priorCache: healthy.nextCache, softGateEnabled: true, ledgerOn: true,
  });
  assert.equal(degraded.gate.ok, false);
  assert.equal(degraded.gate.soft, true);
  assert.equal(degraded.gate.reason, 'tier_exhausted');
  assert.equal(degraded.gate.cap_period, 'weekly');
});

test('C3: degraded RPC + cached NOT-exhausted → allow (degraded), unchanged', () => {
  const healthy = decideQuotaGate(softRow({ eff: 120, allow: 120 }));
  const degraded = decideQuotaGate({
    rpc: { row: null, error: new Error('brownout') },
    priorCache: healthy.nextCache, softGateEnabled: true, ledgerOn: true,
  });
  assert.equal(degraded.gate.ok, true);
  assert.equal(degraded.gate.reason, 'quota_check_degraded');
});
