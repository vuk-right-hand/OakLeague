// Unit tests for makeRunReaper / installReaper — Phase 1D regression guards.
//
// Run: cd server/voice-proxy && node --test reaper-call.test.js
//
// What we lock in:
//   - runReaper calls rpc('reap_stale_sessions', {}) — empty args object
//     (uses RPC default of 60s threshold). No legacy `p_threshold_seconds`.
//   - installReaper sets the interval to REAPER_CADENCE_MS (20s).
//   - Even if `error` is returned, the closure does not throw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRunReaper, installReaper, REAPER_CADENCE_MS } from './proxy-handlers.js';

function mkSupabase({ error = null } = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (name, payload) => {
      calls.push({ name, payload });
      return { data: [], error };
    },
  };
}

test('runReaper calls reap_stale_sessions with empty args (no override)', async () => {
  const sb = mkSupabase();
  const { runReaper } = makeRunReaper({ supabase: sb });
  await runReaper();
  assert.equal(sb.calls.length, 1);
  assert.equal(sb.calls[0].name, 'reap_stale_sessions');
  // Empty args object — RPC default (60s) governs.
  assert.deepEqual(sb.calls[0].payload, {});
  // Sanity: no legacy override key.
  assert.equal(sb.calls[0].payload?.p_threshold_seconds, undefined);
});

test('runReaper does not throw on RPC error', async () => {
  const sb = mkSupabase({ error: { message: 'PostgREST blew up' } });
  const { runReaper } = makeRunReaper({ supabase: sb });
  await assert.doesNotReject(runReaper());
});

test('REAPER_CADENCE_MS constant is 20_000', () => {
  // The const is the contract — installReaper uses it. The next test
  // verifies the actual setInterval delay.
  assert.equal(REAPER_CADENCE_MS, 20_000);
});

test('installReaper sets the actual setInterval delay (not just the const)', () => {
  // REV 4 I-B: a future regression that hard-codes setInterval(..., 60_000)
  // while leaving the const at 20_000 must NOT pass.
  const sb = mkSupabase();
  const { handle, runReaper } = installReaper({ supabase: sb });
  try {
    // Node's Timeout has _idleTimeout; ugly but the only way to inspect the
    // configured delay without monkey-patching setInterval globally.
    const delay = handle._idleTimeout;
    assert.equal(delay, 20_000, `expected 20000ms cadence, got ${delay}ms`);
    assert.equal(typeof runReaper, 'function');
  } finally {
    clearInterval(handle);
  }
});

test('installReaper accepts intervalMs override (for tests)', () => {
  const sb = mkSupabase();
  const { handle } = installReaper({ supabase: sb, intervalMs: 5_000 });
  try {
    assert.equal(handle._idleTimeout, 5_000);
  } finally {
    clearInterval(handle);
  }
});

test('installReaper fires runReaper at boot', async () => {
  // Boot-time fire is the proxy-crash recovery mechanism (plan §1B I-D).
  const sb = mkSupabase();
  const { handle } = installReaper({ supabase: sb, intervalMs: 999_999 });
  try {
    // Microtask flush — the boot call is async but synchronous to schedule.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sb.calls.length, 1, 'boot-time runReaper should have fired exactly once');
    assert.equal(sb.calls[0].name, 'reap_stale_sessions');
  } finally {
    clearInterval(handle);
  }
});
