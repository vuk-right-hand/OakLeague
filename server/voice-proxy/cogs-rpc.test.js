// Unit tests for makeLogTurnCogs — Phase 1D regression guards.
//
// Run: cd server/voice-proxy && node --test cogs-rpc.test.js
//
// What we lock in here:
//   - Calls cogs_insert_turn_voice (NOT the legacy cogs_insert_turn).
//   - Truthy responseTokenCount → leg-2 tokens are the truth.
//   - Null/non-finite responseTokenCount → tokens derived from seconds × 50,
//     metadata.fallback='seconds' with full provenance.
//   - 3 consecutive RPC errors on the same session → onConsecutiveFailure.
//   - A success between failures resets the counter.
//   - Cartesia legs 3+4 = 0 with cartesia_pending: true (M7 deferral).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLogTurnCogs, GEMINI_TOKENS_PER_SEC_FALLBACK } from './proxy-handlers.js';

// Mock supabase: every test recreates one so call-history is isolated.
function mkSupabase({ errors = [] } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    rpc: async (name, payload) => {
      calls.push({ name, payload });
      const err = errors[i++];
      return err ? { error: err } : { error: null };
    },
  };
}

test('cogs RPC happy path: responseTokenCount → leg-2 tokens leg', async () => {
  const sb = mkSupabase();
  const { logTurnCogs } = makeLogTurnCogs({ supabase: sb });
  const out = await logTurnCogs({
    userId: 'u1', sessionId: 's1', turnNumber: 3,
    inputSeconds: 2.5, outputSeconds: 4.0,
    usageMetadata: { responseTokenCount: 200, promptTokenCount: 100, totalTokenCount: 300 },
  });
  assert.equal(out.ok, true);
  assert.equal(out.fallback, false);
  assert.equal(sb.calls.length, 1);
  assert.equal(sb.calls[0].name, 'cogs_insert_turn_voice');
  const p = sb.calls[0].payload;
  assert.equal(p.p_user_id, 'u1');
  assert.equal(p.p_session_id, 's1');
  assert.equal(p.p_turn_number, 3);
  assert.equal(p.p_gemini_audio_in_seconds, 2.5);
  assert.equal(p.p_gemini_audio_out_tokens, 200);
  // Leg 3+4 deferred (Cartesia not in proxy yet)
  assert.equal(p.p_cartesia_characters, 0);
  assert.equal(p.p_cartesia_cost, 0);
  assert.equal(p.p_cartesia_audio_seconds, 0);
  assert.equal(p.p_metadata.cartesia_pending, true);
  assert.equal(p.p_metadata.fallback, undefined);
});

test('cogs RPC fallback path: null usageMetadata → seconds-derived tokens', async () => {
  const sb = mkSupabase();
  const { logTurnCogs } = makeLogTurnCogs({ supabase: sb });
  const out = await logTurnCogs({
    userId: 'u2', sessionId: 's2', turnNumber: 1,
    inputSeconds: 1.0, outputSeconds: 4.0,
    usageMetadata: null,
  });
  assert.equal(out.ok, true);
  assert.equal(out.fallback, true);
  const p = sb.calls[0].payload;
  // 4.0 * 50 = 200 tokens derived
  assert.equal(p.p_gemini_audio_out_tokens, Math.round(4.0 * GEMINI_TOKENS_PER_SEC_FALLBACK));
  assert.equal(p.p_metadata.fallback, 'seconds');
  assert.equal(p.p_metadata.fallback_seconds, 4.0);
  assert.equal(p.p_metadata.fallback_tokens_per_sec, GEMINI_TOKENS_PER_SEC_FALLBACK);
  // QUOTED_AT pinned
  assert.ok(p.p_metadata.quoted_at, 'quoted_at present');
});

test('cogs RPC partial usageMetadata: totalTokenCount only → still falls back', async () => {
  // The Number.isFinite gate is on responseTokenCount specifically. If only
  // totalTokenCount is finite we don't know the in/out split, so leg 2 falls
  // back to seconds derivation.
  const sb = mkSupabase();
  const { logTurnCogs } = makeLogTurnCogs({ supabase: sb });
  const out = await logTurnCogs({
    userId: 'u3', sessionId: 's3', turnNumber: 1,
    inputSeconds: 1.0, outputSeconds: 2.0,
    usageMetadata: { totalTokenCount: 150 },
  });
  assert.equal(out.fallback, true);
  assert.equal(sb.calls[0].payload.p_metadata.fallback, 'seconds');
});

test('cogs RPC name regression guard: must be cogs_insert_turn_voice', async () => {
  const sb = mkSupabase();
  const { logTurnCogs } = makeLogTurnCogs({ supabase: sb });
  await logTurnCogs({
    userId: 'u4', sessionId: 's4', turnNumber: 1,
    inputSeconds: 1, outputSeconds: 1,
    usageMetadata: { responseTokenCount: 50 },
  });
  assert.equal(sb.calls[0].name, 'cogs_insert_turn_voice');
  assert.notEqual(sb.calls[0].name, 'cogs_insert_turn');
});

test('cogs RPC: 3 consecutive failures triggers onConsecutiveFailure', async () => {
  const sb = mkSupabase({ errors: [
    { message: 'brownout 1' },
    { message: 'brownout 2' },
    { message: 'brownout 3' },
  ]});
  const closed = [];
  const { logTurnCogs, _consecutiveFailures } = makeLogTurnCogs({
    supabase: sb,
    onConsecutiveFailure: (sessionId) => closed.push(sessionId),
  });
  for (let i = 0; i < 3; i++) {
    await logTurnCogs({
      userId: 'u5', sessionId: 's5', turnNumber: i + 1,
      inputSeconds: 1, outputSeconds: 1,
      usageMetadata: { responseTokenCount: 50 },
    });
  }
  assert.deepEqual(closed, ['s5']);
  assert.equal(_consecutiveFailures('s5'), 3);
});

test('cogs RPC: a success between failures resets the counter', async () => {
  const sb = mkSupabase({ errors: [
    { message: 'fail 1' },
    { message: 'fail 2' },
    null, // <-- success on 3rd
    { message: 'fail 4' },
    { message: 'fail 5' },
  ]});
  const closed = [];
  const { logTurnCogs, _consecutiveFailures } = makeLogTurnCogs({
    supabase: sb,
    onConsecutiveFailure: (sessionId) => closed.push(sessionId),
  });
  for (let i = 0; i < 5; i++) {
    await logTurnCogs({
      userId: 'u6', sessionId: 's6', turnNumber: i + 1,
      inputSeconds: 1, outputSeconds: 1,
      usageMetadata: { responseTokenCount: 50 },
    });
  }
  // Counter went 1, 2, reset to 0, 1, 2 — never reached 3.
  assert.deepEqual(closed, []);
  assert.equal(_consecutiveFailures('s6'), 2);
});

test('cogs RPC: per-session counter is isolated', async () => {
  const sb = mkSupabase({ errors: [
    { message: 'fail s7-1' },
    { message: 'fail s8-1' },
    { message: 'fail s7-2' },
    { message: 'fail s7-3' }, // <-- 3rd s7 failure trips
  ]});
  const closed = [];
  const { logTurnCogs } = makeLogTurnCogs({
    supabase: sb,
    onConsecutiveFailure: (sessionId) => closed.push(sessionId),
  });
  await logTurnCogs({ userId: 'u', sessionId: 's7', turnNumber: 1, inputSeconds: 1, outputSeconds: 1, usageMetadata: { responseTokenCount: 50 } });
  await logTurnCogs({ userId: 'u', sessionId: 's8', turnNumber: 1, inputSeconds: 1, outputSeconds: 1, usageMetadata: { responseTokenCount: 50 } });
  await logTurnCogs({ userId: 'u', sessionId: 's7', turnNumber: 2, inputSeconds: 1, outputSeconds: 1, usageMetadata: { responseTokenCount: 50 } });
  await logTurnCogs({ userId: 'u', sessionId: 's7', turnNumber: 3, inputSeconds: 1, outputSeconds: 1, usageMetadata: { responseTokenCount: 50 } });
  assert.deepEqual(closed, ['s7']);
});

test('cogs RPC: dropSession clears the counter', async () => {
  const sb = mkSupabase({ errors: [
    { message: 'f1' }, { message: 'f2' }, // s9 has 2 fails
  ]});
  const { logTurnCogs, dropSession, _consecutiveFailures } = makeLogTurnCogs({
    supabase: sb,
    onConsecutiveFailure: () => assert.fail('should not have fired'),
  });
  await logTurnCogs({ userId: 'u', sessionId: 's9', turnNumber: 1, inputSeconds: 1, outputSeconds: 1, usageMetadata: { responseTokenCount: 50 } });
  await logTurnCogs({ userId: 'u', sessionId: 's9', turnNumber: 2, inputSeconds: 1, outputSeconds: 1, usageMetadata: { responseTokenCount: 50 } });
  assert.equal(_consecutiveFailures('s9'), 2);
  dropSession('s9');
  assert.equal(_consecutiveFailures('s9'), 0);
});

test('cogs RPC: COGS_RPC_BYPASS_UNTIL suppresses counter increments', async () => {
  // Set bypass active for the next 1 minute.
  const future = new Date(Date.now() + 60_000).toISOString();
  process.env.COGS_RPC_BYPASS_UNTIL = future;
  try {
    const sb = mkSupabase({ errors: [
      { message: 'b1' }, { message: 'b2' }, { message: 'b3' }, { message: 'b4' },
    ]});
    const closed = [];
    const { logTurnCogs, _consecutiveFailures } = makeLogTurnCogs({
      supabase: sb,
      onConsecutiveFailure: (s) => closed.push(s),
    });
    for (let i = 0; i < 4; i++) {
      await logTurnCogs({
        userId: 'u', sessionId: 's10', turnNumber: i + 1,
        inputSeconds: 1, outputSeconds: 1,
        usageMetadata: { responseTokenCount: 50 },
      });
    }
    assert.deepEqual(closed, [], 'bypass should suppress callback');
    assert.equal(_consecutiveFailures('s10'), 0, 'counter should not increment under bypass');
  } finally {
    delete process.env.COGS_RPC_BYPASS_UNTIL;
  }
});

test('cogs RPC: leg-1 cost computation is finite and non-negative', async () => {
  const sb = mkSupabase();
  const { logTurnCogs } = makeLogTurnCogs({ supabase: sb });
  await logTurnCogs({
    userId: 'u', sessionId: 's11', turnNumber: 1,
    inputSeconds: 5.5, outputSeconds: 0,
    usageMetadata: { responseTokenCount: 0 },
  });
  const p = sb.calls[0].payload;
  assert.ok(Number.isFinite(p.p_gemini_audio_in_cost), 'cost is finite');
  assert.ok(p.p_gemini_audio_in_cost > 0, 'cost is positive for non-zero seconds');
  assert.equal(p.p_gemini_audio_out_tokens, 0);
});
