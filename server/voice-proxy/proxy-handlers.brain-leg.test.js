// Unit tests for makeLogTurnCogs().logBrainLeg — DECOUPLED_BRAIN_PLAN
// P1-5.1b. The per-leg token COGS writer for the decoupled brain.
//
// DI'd fake supabase (captures the .rpc call) — same idiom as
// decoupled-boot.test.js. Asserts the bridge cogs-contract → RPC param
// mapping, the M6 billed-partial coercion (null tokens → 0 + visible
// estimate flag, never a silent gap), and the failure paths.
//
// Run: cd server/voice-proxy && node --test proxy-handlers.brain-leg.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLogTurnCogs } from './proxy-handlers.js';

function fakeSupabase({ rpcError = null } = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => { calls.push({ name, args }); return { error: rpcError }; },
  };
}

const FINAL_DEEP = {
  final: true,
  operation: 'brain_deep_answer',
  text: 'the grounded answer',
  modelId: 'gemini-2.5-flash',
  usdPerInputToken: 0.0000003,
  usdPerOutputToken: 0.0000025,
  inputTokens: 1200,
  outputTokens: 90,
  quotedAt: '2026-05-18',
  startedAt: Date.now(),
};

test('logBrainLeg: valid {final} deep-answer → cogs_insert_brain_leg with summed costs', async () => {
  const sb = fakeSupabase();
  const { logBrainLeg } = makeLogTurnCogs({ supabase: sb, env: 'production' });
  const r = await logBrainLeg({ userId: 'u1', sessionId: 's1', turnNumber: 3, leg: FINAL_DEEP });
  assert.deepEqual(r, { ok: true, billedPartial: false });
  assert.equal(sb.calls.length, 1);
  const { name, args } = sb.calls[0];
  assert.equal(name, 'cogs_insert_brain_leg');
  assert.equal(args.p_operation, 'brain_deep_answer');
  assert.equal(args.p_user_id, 'u1');
  assert.equal(args.p_session_id, 's1');
  assert.equal(args.p_turn_number, 3);
  assert.equal(args.p_input_tokens, 1200);
  assert.equal(args.p_output_tokens, 90);
  assert.equal(args.p_input_cost, Number((1200 * 0.0000003).toFixed(6)));   // 0.00036
  assert.equal(args.p_output_cost, Number((90 * 0.0000025).toFixed(6)));    // 0.000225
  assert.equal(args.p_billed_partial, false);
  assert.equal(args.p_environment, 'production');
  assert.equal(args.p_metadata.model, 'gemini-2.5-flash');
  assert.equal(args.p_metadata.quoted_at, '2026-05-18');
  assert.equal(args.p_metadata.source, 'production');
  assert.ok(!('token_estimate_unavailable' in args.p_metadata));
});

test('logBrainLeg: M6 — barged .partial with NULL tokens → coerced 0, billed_partial, estimate-unavailable flag', async () => {
  const sb = fakeSupabase();
  const { logBrainLeg } = makeLogTurnCogs({ supabase: sb, env: 'production' });
  const partial = {
    operation: 'brain_paraphrase',
    billed: true,
    text: 'Let me think',
    inputTokens: null,
    outputTokens: null,
    modelId: 'gemini-2.5-flash',
    usdPerInputToken: 0.0000003,
    usdPerOutputToken: 0.0000025,
    quotedAt: '2026-05-18',
  };
  const r = await logBrainLeg({ userId: 'u1', sessionId: 's1', turnNumber: 4, leg: partial });
  assert.deepEqual(r, { ok: true, billedPartial: true });
  const { args } = sb.calls[0];
  assert.equal(args.p_operation, 'brain_paraphrase');
  assert.equal(args.p_input_tokens, 0, 'null coerced to 0 — row still written');
  assert.equal(args.p_output_tokens, 0);
  assert.equal(args.p_input_cost, 0);
  assert.equal(args.p_output_cost, 0);
  assert.equal(args.p_billed_partial, true);
  assert.equal(args.p_metadata.token_estimate_unavailable, true,
    'a billed call we could not size is a VISIBLE estimate, never a silent gap');
});

test('logBrainLeg: .partial WITH token counts → billed_partial, NO estimate-unavailable flag', async () => {
  const sb = fakeSupabase();
  const { logBrainLeg } = makeLogTurnCogs({ supabase: sb, env: 'production' });
  const partial = {
    operation: 'brain_deep_answer', billed: true, text: 'partial ans',
    inputTokens: 1200, outputTokens: 12,
    usdPerInputToken: 0.0000003, usdPerOutputToken: 0.0000025,
    modelId: 'gemini-2.5-flash', quotedAt: '2026-05-18',
  };
  const r = await logBrainLeg({ userId: 'u1', sessionId: 's1', turnNumber: 5, leg: partial });
  assert.equal(r.ok, true);
  assert.equal(r.billedPartial, true);
  const { args } = sb.calls[0];
  assert.equal(args.p_input_tokens, 1200);
  assert.equal(args.p_output_tokens, 12);
  assert.equal(args.p_billed_partial, true);
  assert.ok(!('token_estimate_unavailable' in args.p_metadata));
});

test('logBrainLeg: missing/invalid leg.operation → NO rpc call, ok:false', async () => {
  const sb = fakeSupabase();
  const { logBrainLeg } = makeLogTurnCogs({ supabase: sb, env: 'production' });
  for (const bad of [undefined, null, { operation: 'voice_audio_input_seconds' }, { operation: 'brain_freestyle' }]) {
    const r = await logBrainLeg({ userId: 'u1', sessionId: 's1', turnNumber: 1, leg: bad });
    assert.equal(r.ok, false);
  }
  assert.equal(sb.calls.length, 0, 'never write a mis-shaped cogs row');
});

test('logBrainLeg: RPC returns {error} → ok:false (recordFailure path)', async () => {
  const sb = fakeSupabase({ rpcError: { message: 'check_violation brain input_cost oob' } });
  const { logBrainLeg } = makeLogTurnCogs({ supabase: sb, env: 'production' });
  const r = await logBrainLeg({ userId: 'u1', sessionId: 's1', turnNumber: 2, leg: FINAL_DEEP });
  assert.equal(r.ok, false);
  assert.equal(sb.calls.length, 1, 'attempted the write, surfaced the error');
});

test('logBrainLeg: costs are quantised to 6dp before the numeric(10,6) column', async () => {
  const sb = fakeSupabase();
  const { logBrainLeg } = makeLogTurnCogs({ supabase: sb, env: 'dev' });
  // Big token counts so the product has >6 decimals → rounding is observable.
  const leg = { ...FINAL_DEEP, inputTokens: 1234567, outputTokens: 7654321,
                usdPerInputToken: 0.0000003, usdPerOutputToken: 0.0000025 };
  await logBrainLeg({ userId: 'u1', sessionId: 's1', turnNumber: 7, leg });
  const { args } = sb.calls[0];
  // Contract: never a raw float into numeric(10,6); exactly toFixed(6).
  assert.equal(args.p_input_cost, Number((1234567 * 0.0000003).toFixed(6)));
  assert.equal(args.p_output_cost, Number((7654321 * 0.0000025).toFixed(6)));
  for (const c of [args.p_input_cost, args.p_output_cost]) {
    assert.equal(typeof c, 'number');
    const dp = (String(c).split('.')[1] || '').length;
    assert.ok(dp <= 6, `≤6 decimal places, got ${dp}`);
  }
});
