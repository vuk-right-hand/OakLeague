// Unit tests for makeLogTurnCogs — Phase 1D regression guards.
//
// HUME_TTS_PLAN §6.10 (2026-05-13): RPC renamed to cogs_insert_turn_voice_v2,
// cartesia-specific params renamed to p_tts_*. Backward-compat test cases
// still use the `cartesia` envelope key (legacy alias accepted by the
// factory) — assertions read p_tts_* now.
//
// Run: cd server/voice-proxy && node --test cogs-rpc.test.js
//
// What we lock in here:
//   - Calls cogs_insert_turn_voice_v2 (NOT v1 / NOT the legacy cogs_insert_turn).
//   - Truthy responseTokenCount → leg-2 tokens are the truth.
//   - Null/non-finite responseTokenCount → tokens derived from seconds × 50,
//     metadata.fallback='seconds' with full provenance.
//   - 3 consecutive RPC errors on the same session → onConsecutiveFailure.
//   - A success between failures resets the counter.
//   - TTS legs 3+4 = 0 with cartesia_pending: true when α' off.
//   - p_tts_service / p_tts_provider land per ticket-driven ttsProvider.

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
  assert.equal(sb.calls[0].name, 'cogs_insert_turn_voice_v2');
  const p = sb.calls[0].payload;
  assert.equal(p.p_user_id, 'u1');
  assert.equal(p.p_session_id, 's1');
  assert.equal(p.p_turn_number, 3);
  assert.equal(p.p_gemini_audio_in_seconds, 2.5);
  assert.equal(p.p_gemini_audio_out_tokens, 200);
  // Legs 3+4 deferred (no `tts` envelope passed → α' not wired yet)
  assert.equal(p.p_tts_characters, 0);
  assert.equal(p.p_tts_cost, 0);
  assert.equal(p.p_tts_audio_seconds, 0);
  // Default ttsProvider = 'cartesia' when caller omits.
  assert.equal(p.p_tts_service, 'cartesia');
  assert.equal(p.p_tts_provider, 'cartesia');
  assert.equal(p.p_metadata.cartesia_pending, true);
  assert.equal(p.p_metadata.tts_provider, 'cartesia');
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

test('cogs RPC name regression guard: must be cogs_insert_turn_voice_v2', async () => {
  const sb = mkSupabase();
  const { logTurnCogs } = makeLogTurnCogs({ supabase: sb });
  await logTurnCogs({
    userId: 'u4', sessionId: 's4', turnNumber: 1,
    inputSeconds: 1, outputSeconds: 1,
    usageMetadata: { responseTokenCount: 50 },
  });
  assert.equal(sb.calls[0].name, 'cogs_insert_turn_voice_v2');
  assert.notEqual(sb.calls[0].name, 'cogs_insert_turn');
  assert.notEqual(sb.calls[0].name, 'cogs_insert_turn_voice'); // v1 shim — proxy MUST call v2 directly
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

// ── Pipeline α' / Cartesia leg tests ────────────────────────────────────

test("α': cartesia payload populates legs 3+4 with real values + drops cartesia_pending", async () => {
  // Set up Cartesia env for getCartesiaPricing.
  process.env.VOICE_TTS_LAYER_ENABLED = '1';
  process.env.CARTESIA_USD_PER_CHAR = '0.000015'; // $15/1M chars
  process.env.CARTESIA_QUOTED_AT = '2026-05-02';
  // Force re-import so module-level snapshots pick up the env.
  const mod = await import(`./proxy-handlers.js?cartesia=${Date.now()}`);
  const sb = mkSupabase();
  const { logTurnCogs } = mod.makeLogTurnCogs({ supabase: sb });

  await logTurnCogs({
    userId: 'u', sessionId: 's-c1', turnNumber: 1,
    inputSeconds: 1.0, outputSeconds: 2.0,
    usageMetadata: { responseTokenCount: 100 },
    ttsProvider: 'cartesia',
    tts: {
      characters: 200,
      audioBytes: 240000, // 5s of 24kHz s16le = 240000 bytes
      audioSeconds: 5.0,
      partial: false,
    },
  });
  const p = sb.calls[0].payload;
  assert.equal(p.p_tts_characters, 200);
  // 200 chars × 0.000015 = 0.003 USD
  assert.equal(p.p_tts_cost, 0.003);
  assert.equal(p.p_tts_audio_seconds, 5.0);
  assert.equal(p.p_tts_service, 'cartesia');
  assert.equal(p.p_tts_provider, 'cartesia');
  assert.equal(p.p_metadata.tts_provider, 'cartesia');
  assert.equal(p.p_metadata.tts_quoted_at, '2026-05-02');
  // Back-compat key still emitted on cartesia path.
  assert.equal(p.p_metadata.cartesia_quoted_at, '2026-05-02');
  assert.equal(p.p_metadata.cartesia_pending, undefined,
    'pending flag must be cleared on real Cartesia legs');
  assert.equal(p.p_metadata.cartesia_partial, undefined,
    'partial flag absent on a clean turn');
});

test("α': tts.partial=true sets tts_partial + cartesia_partial metadata", async () => {
  process.env.VOICE_TTS_LAYER_ENABLED = '1';
  process.env.CARTESIA_USD_PER_CHAR = '0.000015';
  process.env.CARTESIA_QUOTED_AT = '2026-05-02';
  const mod = await import(`./proxy-handlers.js?partial=${Date.now()}`);
  const sb = mkSupabase();
  const { logTurnCogs } = mod.makeLogTurnCogs({ supabase: sb });
  await logTurnCogs({
    userId: 'u', sessionId: 's-p', turnNumber: 1,
    inputSeconds: 1, outputSeconds: 2,
    usageMetadata: { responseTokenCount: 100 },
    ttsProvider: 'cartesia',
    tts: { characters: 50, audioBytes: 0, audioSeconds: 0, partial: true },
  });
  const p = sb.calls[0].payload;
  assert.equal(p.p_metadata.tts_partial, true);
  assert.equal(p.p_metadata.cartesia_partial, true); // back-compat
  assert.equal(p.p_tts_audio_seconds, 0);
  assert.equal(p.p_tts_characters, 50);
});

test('M4 mixed-rows scenario: dashboard headline filter excludes pending + partial', () => {
  // Simulates the SQL the live cogs route applies. Vibes-check that the
  // metadata shape we write is filterable.
  const rows = [
    { cost_usd: 0.0042, metadata: {} },
    { cost_usd: 0.0010, metadata: { cartesia_pending: true } },
    { cost_usd: 0.0030, metadata: { cartesia_partial: true } },
    { cost_usd: 0.0050, metadata: { cartesia_quoted_at: '2026-05-02' } },
  ];
  // headline = sum where neither flag set
  const headline = rows
    .filter((r) => !r.metadata.cartesia_pending && !r.metadata.cartesia_partial)
    .reduce((a, r) => a + r.cost_usd, 0);
  assert.equal(headline, 0.0042 + 0.0050);
});

test('R3-S6 cost precision: $6/turn ceiling rounds to 6 decimals (no integer pennies)', async () => {
  process.env.VOICE_TTS_LAYER_ENABLED = '1';
  // Hypothetical worst-case: $0.0015/char × 4000 char cap = $6.00.
  process.env.CARTESIA_USD_PER_CHAR = '0.0015';
  process.env.CARTESIA_QUOTED_AT = '2026-05-02';
  const mod = await import(`./proxy-handlers.js?precision=${Date.now()}`);
  const sb = mkSupabase();
  const { logTurnCogs } = mod.makeLogTurnCogs({ supabase: sb });
  await logTurnCogs({
    userId: 'u', sessionId: 's-prec', turnNumber: 1,
    inputSeconds: 1, outputSeconds: 0,
    ttsProvider: 'cartesia',
    tts: { characters: 4000, audioBytes: 0, audioSeconds: 0, partial: false },
  });
  const p = sb.calls[0].payload;
  // 4000 × 0.0015 = 6.000000
  assert.equal(p.p_tts_cost, 6);
  // Confirm we DIDN'T floor to dollars.
  assert.notEqual(p.p_tts_cost.toString(), '0');
});

test('R4-S3 fail-closed: missing CARTESIA_USD_PER_CHAR throws when enabled', async () => {
  process.env.VOICE_TTS_LAYER_ENABLED = '1';
  delete process.env.CARTESIA_USD_PER_CHAR;
  process.env.CARTESIA_QUOTED_AT = '2026-05-02';
  const mod = await import(`./proxy-handlers.js?missing=${Date.now()}`);
  const sb = mkSupabase();
  const { logTurnCogs } = mod.makeLogTurnCogs({ supabase: sb });
  await assert.rejects(
    () => logTurnCogs({
      userId: 'u', sessionId: 's-fc', turnNumber: 1,
      inputSeconds: 1, outputSeconds: 0,
      ttsProvider: 'cartesia',
      tts: { characters: 100, audioBytes: 0, audioSeconds: 0, partial: false },
    }),
    /CARTESIA_USD_PER_CHAR/,
  );
});

test('R4-S3: empty-string env → finite-positive guard rejects (caught Number(\'\') === 0 trap)', async () => {
  process.env.VOICE_TTS_LAYER_ENABLED = '1';
  process.env.CARTESIA_USD_PER_CHAR = ''; // empty → Number('') = 0
  process.env.CARTESIA_QUOTED_AT = '2026-05-02';
  const mod = await import(`./proxy-handlers.js?empty=${Date.now()}`);
  const sb = mkSupabase();
  const { logTurnCogs } = mod.makeLogTurnCogs({ supabase: sb });
  await assert.rejects(
    () => logTurnCogs({
      userId: 'u', sessionId: 's-em', turnNumber: 1,
      inputSeconds: 1, outputSeconds: 0,
      ttsProvider: 'cartesia',
      tts: { characters: 100, audioBytes: 0, audioSeconds: 0, partial: false },
    }),
    /CARTESIA_USD_PER_CHAR/,
  );
});

test('Cartesia disabled (default env): legacy zeros + cartesia_pending preserved', async () => {
  delete process.env.VOICE_TTS_LAYER_ENABLED;
  delete process.env.CARTESIA_USD_PER_CHAR;
  delete process.env.CARTESIA_QUOTED_AT;
  const mod = await import(`./proxy-handlers.js?disabled=${Date.now()}`);
  const sb = mkSupabase();
  const { logTurnCogs } = mod.makeLogTurnCogs({ supabase: sb });
  await logTurnCogs({
    userId: 'u', sessionId: 's-off', turnNumber: 1,
    inputSeconds: 1, outputSeconds: 2,
    usageMetadata: { responseTokenCount: 50 },
  });
  const p = sb.calls[0].payload;
  assert.equal(p.p_tts_characters, 0);
  assert.equal(p.p_tts_cost, 0);
  assert.equal(p.p_tts_audio_seconds, 0);
  assert.equal(p.p_metadata.cartesia_pending, true);
  assert.equal(p.p_metadata.cartesia_quoted_at, undefined);
});

// ── HUME_TTS_PLAN §6.10 — Hume path tests ──────────────────────────────────

test("α' hume: tts payload populates legs 3+4 with Hume pricing + tts_provider tag", async () => {
  process.env.VOICE_TTS_LAYER_ENABLED = '1';
  process.env.CARTESIA_USD_PER_CHAR = '0.00005';
  process.env.CARTESIA_QUOTED_AT = '2026-05-13';
  process.env.HUME_USD_PER_CHAR = '0.0000076'; // $7.60/1M chars
  process.env.HUME_QUOTED_AT = '2026-05-13';
  const mod = await import(`./proxy-handlers.js?hume=${Date.now()}`);
  const sb = mkSupabase();
  const { logTurnCogs } = mod.makeLogTurnCogs({ supabase: sb });

  await logTurnCogs({
    userId: 'u', sessionId: 's-h1', turnNumber: 1,
    inputSeconds: 1.0, outputSeconds: 2.0,
    usageMetadata: { responseTokenCount: 100 },
    ttsProvider: 'hume',
    tts: { characters: 1000, audioBytes: 240000, audioSeconds: 5.0, partial: false },
  });
  const p = sb.calls[0].payload;
  assert.equal(p.p_tts_service, 'hume');
  assert.equal(p.p_tts_provider, 'hume');
  assert.equal(p.p_tts_characters, 1000);
  // 1000 × 0.0000076 = 0.0076 USD
  assert.equal(p.p_tts_cost, 0.0076);
  assert.equal(p.p_tts_audio_seconds, 5.0);
  assert.equal(p.p_metadata.tts_provider, 'hume');
  assert.equal(p.p_metadata.tts_quoted_at, '2026-05-13');
  // On Hume path the cartesia-specific back-compat keys must NOT appear.
  assert.equal(p.p_metadata.cartesia_quoted_at, undefined);
  assert.equal(p.p_metadata.cartesia_partial, undefined);
});

test('α\' hume: missing HUME_USD_PER_CHAR throws fail-closed', async () => {
  process.env.VOICE_TTS_LAYER_ENABLED = '1';
  process.env.CARTESIA_USD_PER_CHAR = '0.00005';
  process.env.CARTESIA_QUOTED_AT = '2026-05-13';
  delete process.env.HUME_USD_PER_CHAR;
  process.env.HUME_QUOTED_AT = '2026-05-13';
  const mod = await import(`./proxy-handlers.js?humemissing=${Date.now()}`);
  const sb = mkSupabase();
  const { logTurnCogs } = mod.makeLogTurnCogs({ supabase: sb });
  // Audit C5 — the LAZY/per-turn path (getHumePricing → assertHumePricing)
  // must THROW a catchable error, NEVER process.exit. process.exit here
  // would kill the whole Fly VM and drop every concurrent user's WebSocket
  // mid-turn on a crash-loop. Assert: (1) logTurnCogs rejects (fail-closed
  // — no silent $0 billing), (2) process.exit is NOT invoked.
  const realExit = process.exit;
  let exitCalledWith = null;
  // @ts-ignore
  process.exit = (n) => { exitCalledWith = n; throw new Error('process.exit MUST NOT be called on the per-turn cogs path (C5)'); };
  try {
    await assert.rejects(
      () => logTurnCogs({
        userId: 'u', sessionId: 's-h-fc', turnNumber: 1,
        inputSeconds: 1, outputSeconds: 0,
        ttsProvider: 'hume',
        tts: { characters: 100, audioBytes: 0, audioSeconds: 0, partial: false },
      }),
      /HUME_USD_PER_CHAR missing or non-finite/,
    );
    assert.equal(exitCalledWith, null, 'C5: process.exit MUST NOT be called from the per-turn cogs path');
  } finally {
    // @ts-ignore
    process.exit = realExit;
  }
});

test('back-compat: legacy `cartesia` envelope still accepted (defaults provider to cartesia)', async () => {
  process.env.VOICE_TTS_LAYER_ENABLED = '1';
  process.env.CARTESIA_USD_PER_CHAR = '0.00005';
  process.env.CARTESIA_QUOTED_AT = '2026-05-13';
  const mod = await import(`./proxy-handlers.js?legacy=${Date.now()}`);
  const sb = mkSupabase();
  const { logTurnCogs } = mod.makeLogTurnCogs({ supabase: sb });
  await logTurnCogs({
    userId: 'u', sessionId: 's-legacy', turnNumber: 1,
    inputSeconds: 1, outputSeconds: 2,
    usageMetadata: { responseTokenCount: 100 },
    cartesia: { characters: 200, audioBytes: 0, audioSeconds: 5, partial: false },
  });
  const p = sb.calls[0].payload;
  assert.equal(p.p_tts_service, 'cartesia');
  assert.equal(p.p_tts_provider, 'cartesia');
  assert.equal(p.p_tts_characters, 200);
});
