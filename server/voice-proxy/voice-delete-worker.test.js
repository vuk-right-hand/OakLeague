// Multi-provider voice-delete-worker tests. §5.4 of HUME_TTS_PLAN.
//
// We stub `supabase.rpc` and global `fetch` to drive the worker through
// every (provider, key-presence, voice_name-presence, response-code) leg.
// Live DELETE calls are exercised by scripts/hume-phase0-spike.mjs + §8
// burn-in.
//
// Run: cd server/voice-proxy && node --test voice-delete-worker.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVoiceDeleteWorker } from './voice-delete-worker.js';

function makeFakeSupabase({ claimRows = [], onComplete, onFailure } = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'voice_delete_queue_claim_v2') {
        return { data: claimRows, error: null };
      }
      if (name === 'voice_delete_queue_complete_v2') {
        onComplete?.(args);
        return { data: null, error: null };
      }
      if (name === 'voice_delete_queue_record_failure_v2') {
        onFailure?.(args);
        return { data: null, error: null };
      }
      return { data: null, error: { code: 'unknown_rpc' } };
    },
  };
}

function stubFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return responder(url, opts);
  };
  return calls;
}

test('claim returns empty → tick is a no-op (no fetch calls)', async () => {
  const supabase = makeFakeSupabase({ claimRows: [] });
  const fetchCalls = stubFetch(() => { throw new Error('should not fetch'); });
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: 'ck', humeApiKey: 'hk' });
  await w.tick();
  assert.equal(fetchCalls.length, 0);
});

test('cartesia row → DELETE /voices/{id} with Bearer auth + Cartesia-Version', async () => {
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'cartesia', voice_id: 'vid-c', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  let completed = null;
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_complete_v2') { completed = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  const fetchCalls = stubFetch(() => ({ status: 200 }));
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: 'ck', humeApiKey: null });
  await w.tick();
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.startsWith('https://api.cartesia.ai/voices/vid-c'));
  assert.equal(fetchCalls[0].opts.method, 'DELETE');
  assert.equal(fetchCalls[0].opts.headers.authorization, 'Bearer ck');
  assert.equal(fetchCalls[0].opts.headers['Cartesia-Version'], '2026-03-01');
  assert.deepEqual(completed, { p_tts_provider: 'cartesia', p_voice_id: 'vid-c' });
});

// Helper: respond to GET-verify (returns matching voices list) then DELETE.
function stubHumeGetThenDelete({ getStatus = 200, getVoices = null, deleteStatus = 204 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (opts?.method === 'GET' || opts?.method === undefined && String(url).includes('?name=')) {
      if (getStatus === 200) {
        return { status: 200, ok: true, json: async () => ({ voices: getVoices ?? [] }) };
      }
      return { status: getStatus, ok: false };
    }
    return { status: deleteStatus, ok: deleteStatus >= 200 && deleteStatus < 300 };
  };
  return calls;
}

test('hume row → GET-verify-id (audit C2+C3) then DELETE /v0/tts/voices?name=<name>', async () => {
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'hume', voice_id: 'vid-h', voice_name: 'My Hume Voice', attempts: 1, due_at: new Date().toISOString() }],
  });
  let completed = null;
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_complete_v2') { completed = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  const fetchCalls = stubHumeGetThenDelete({
    getStatus: 200,
    getVoices: [{ id: 'vid-h', name: 'My Hume Voice' }],
    deleteStatus: 204,
  });
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: null, humeApiKey: 'hk' });
  await w.tick();
  assert.equal(fetchCalls.length, 2, 'GET-verify + DELETE = 2 fetches');
  assert.equal(fetchCalls[0].opts.method, 'GET', 'first fetch is verify');
  assert.ok(fetchCalls[0].url.includes('name=My%20Hume%20Voice'));
  assert.ok(fetchCalls[0].url.includes('provider=CUSTOM_VOICE'));
  assert.equal(fetchCalls[1].opts.method, 'DELETE', 'second fetch is delete');
  assert.equal(fetchCalls[1].opts.headers['X-Hume-Api-Key'], 'hk');
  assert.deepEqual(completed, { p_tts_provider: 'hume', p_voice_id: 'vid-h' });
});

test('hume row + GET returns 404 → success (already gone, skip DELETE)', async () => {
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'hume', voice_id: 'vid-h', voice_name: 'gone', attempts: 1, due_at: new Date().toISOString() }],
  });
  let completed = null;
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_complete_v2') { completed = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  const fetchCalls = stubHumeGetThenDelete({ getStatus: 404 });
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: null, humeApiKey: 'hk' });
  await w.tick();
  assert.equal(fetchCalls.length, 1, 'GET 404 short-circuits — no DELETE');
  assert.ok(completed, 'GET 404 must dequeue (already gone)');
});

test('hume row + GET returns voice with DIFFERENT id (rename-in-UI) → skipBump, no DELETE', async () => {
  // §6 unit-wide audit C2+C3 — the worker must REFUSE to dispatch
  // DELETE if the live Hume voice with this name has a different id
  // than what we enqueued. Prevents nuking the wrong creator's voice.
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'hume', voice_id: 'enqueued-vid', voice_name: 'shared-name', attempts: 1, due_at: new Date().toISOString() }],
  });
  let completed = null;
  let recorded = null;
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_complete_v2') { completed = args; return { data: null, error: null }; }
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  const fetchCalls = stubHumeGetThenDelete({
    getStatus: 200,
    getVoices: [{ id: 'DIFFERENT-vid', name: 'shared-name' }],
  });
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: null, humeApiKey: 'hk' });
  await w.tick();
  assert.equal(fetchCalls.length, 1, 'GET-mismatch must NOT dispatch DELETE');
  assert.equal(completed, null, 'rename-in-UI must not dequeue');
  assert.equal(recorded, null, 'rename-in-UI is skipBump (fresh due_at) — no record_failure');
});

test('hume row + GET 500 (unreachable verify) → record_failure with verify_status=500', async () => {
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'hume', voice_id: 'vid', voice_name: 'name', attempts: 1, due_at: new Date().toISOString() }],
  });
  let recorded = null;
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  stubHumeGetThenDelete({ getStatus: 500 });
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: null, humeApiKey: 'hk' });
  await w.tick();
  assert.equal(recorded.p_last_error, 'verify_status=500');
});

test('cartesia row but no cartesiaApiKey → skipBump, logs once, no fetch', async () => {
  // Use a recent due_at so the 24h-stale escalation doesn't fire.
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'cartesia', voice_id: 'vid', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  let recorded = null;
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  const fetchCalls = stubFetch(() => { throw new Error('should not fetch'); });
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: null, humeApiKey: 'hk' });
  await w.tick();
  assert.equal(fetchCalls.length, 0, 'no fetch when key missing');
  assert.equal(recorded, null, 'fresh row → skipBump (no record_failure)');
});

test('hume row + null voice_name → skipBump (DB CHECK should prevent, defensive)', async () => {
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'hume', voice_id: 'vid', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  let recorded = null;
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  const fetchCalls = stubFetch(() => { throw new Error('should not fetch'); });
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: null, humeApiKey: 'hk' });
  await w.tick();
  assert.equal(fetchCalls.length, 0);
  assert.equal(recorded, null);
});

test('hume row + stale orphan (due_at >24h ago + no key) → burns attempt so 10-cutoff catches it', async () => {
  const oldDate = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'hume', voice_id: 'vid', voice_name: 'orphan', attempts: 8, due_at: oldDate }],
  });
  let recorded = null;
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  stubFetch(() => { throw new Error('should not fetch'); });
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: null, humeApiKey: null });
  await w.tick();
  assert.ok(recorded, 'stale orphan must record_failure so attempts trend toward 10');
});

test('500 response → record_failure with status=500', async () => {
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'cartesia', voice_id: 'vid', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  let recorded = null;
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  stubFetch(() => ({ status: 500 }));
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: 'ck', humeApiKey: 'hk' });
  await w.tick();
  assert.deepEqual(recorded, { p_tts_provider: 'cartesia', p_voice_id: 'vid', p_last_error: 'status=500' });
});

test('AbortError on fetch → record_failure with last_error=timeout', async () => {
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'cartesia', voice_id: 'vid', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  let recorded = null;
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  stubFetch(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: 'ck', humeApiKey: 'hk' });
  await w.tick();
  assert.equal(recorded.p_last_error, 'timeout');
});

test('worker constructs without either key (R1-M1) — keys-missing handled per-row', () => {
  assert.doesNotThrow(() => makeVoiceDeleteWorker({ supabase: makeFakeSupabase() }));
});

test('worker throws when supabase missing', () => {
  assert.throws(() => makeVoiceDeleteWorker({}), /supabase required/);
});

test('mixed batch — cartesia + hume in one tick, each routes to its provider', async () => {
  const supabase = makeFakeSupabase({
    claimRows: [
      { tts_provider: 'cartesia', voice_id: 'c1', voice_name: null, attempts: 1, due_at: new Date().toISOString() },
      { tts_provider: 'hume',     voice_id: 'h1', voice_name: 'Hume Voice', attempts: 1, due_at: new Date().toISOString() },
    ],
  });
  const completed = [];
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_complete_v2') { completed.push(args); return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  // Hume path now does GET-verify (audit C2+C3) before DELETE = 2 fetches.
  // Cartesia is 1 fetch. Total = 3 in this mixed batch.
  const fetchCalls = stubFetch((url, opts) => {
    if (url.includes('api.hume.ai') && opts?.method === 'GET') {
      return { status: 200, ok: true, json: async () => ({ voices: [{ id: 'h1', name: 'Hume Voice' }] }) };
    }
    return { status: 200, ok: true };
  });
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: 'ck', humeApiKey: 'hk' });
  await w.tick();
  assert.equal(fetchCalls.length, 3, 'cartesia DELETE + hume GET-verify + hume DELETE');
  assert.ok(fetchCalls[0].url.includes('api.cartesia.ai'));
  assert.ok(fetchCalls[1].url.includes('api.hume.ai') && fetchCalls[1].opts.method === 'GET');
  assert.ok(fetchCalls[2].url.includes('api.hume.ai') && fetchCalls[2].opts.method === 'DELETE');
  assert.equal(completed.length, 2);
  assert.equal(completed[0].p_tts_provider, 'cartesia');
  assert.equal(completed[1].p_tts_provider, 'hume');
});

// ── FISH_AUDIO_PHASE_1 §6 M4 — fish dispatch tests ─────────────────────
// Test fixture id is INTENTIONALLY synthetic (not the real spike voice id)
// so test traces never leak Fish's prod resource ids into log aggregators.
const FISH_TEST_VOICE_ID = 'fishtest32hexffffffffffffffffffff';

test('fish row → DELETE /model/{id} with Bearer auth (no GET-verify, no name pair)', async () => {
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'fish', voice_id: FISH_TEST_VOICE_ID, voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  let completed = null;
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_complete_v2') { completed = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  const fetchCalls = stubFetch(() => ({ status: 204 }));
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: null, humeApiKey: null, fishApiKey: 'fk' });
  await w.tick();
  assert.equal(fetchCalls.length, 1, 'fish DELETE is single-shot (no GET-verify pre-flight)');
  assert.ok(fetchCalls[0].url.startsWith(`https://api.fish.audio/model/${FISH_TEST_VOICE_ID}`));
  assert.equal(fetchCalls[0].opts.method, 'DELETE');
  // Audit M2: header name is capitalized 'Authorization'.
  assert.equal(fetchCalls[0].opts.headers.Authorization, 'Bearer fk');
  // Audit M3: User-Agent for Fish-side identification.
  assert.ok(fetchCalls[0].opts.headers['User-Agent']?.startsWith('oakleague-voice-delete-worker'));
  assert.deepEqual(completed, { p_tts_provider: 'fish', p_voice_id: FISH_TEST_VOICE_ID });
});

test('fish row + status 200 → success (dequeue)', async () => {
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'fish', voice_id: 'vid-f', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  let completed = null;
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_complete_v2') { completed = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  stubFetch(() => ({ status: 200 }));
  const w = makeVoiceDeleteWorker({ supabase, fishApiKey: 'fk' });
  await w.tick();
  assert.deepEqual(completed, { p_tts_provider: 'fish', p_voice_id: 'vid-f' });
});

test('fish row + status 404 → success (idempotent — already deleted)', async () => {
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'fish', voice_id: 'vid-f', voice_name: null, attempts: 2, due_at: new Date().toISOString() }],
  });
  let completed = null;
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_complete_v2') { completed = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  stubFetch(() => ({ status: 404 }));
  const w = makeVoiceDeleteWorker({ supabase, fishApiKey: 'fk' });
  await w.tick();
  assert.deepEqual(completed, { p_tts_provider: 'fish', p_voice_id: 'vid-f' });
});

test('fish row + status 500 → record_failure (retry per existing semantics)', async () => {
  let recorded = null;
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'fish', voice_id: 'vid-f', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  stubFetch(() => ({ status: 500 }));
  const w = makeVoiceDeleteWorker({ supabase, fishApiKey: 'fk' });
  await w.tick();
  assert.equal(recorded?.p_last_error, 'status=500');
});

test('fish row + fishApiKey missing → skipBump (no record_failure, no dispatch)', async () => {
  let recorded = null;
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'fish', voice_id: 'vid-f', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  const fetchCalls = stubFetch(() => { throw new Error('should not fetch'); });
  const w = makeVoiceDeleteWorker({ supabase, fishApiKey: null });
  await w.tick();
  assert.equal(fetchCalls.length, 0, 'no dispatch attempted when fishApiKey missing');
  assert.equal(recorded, null, 'no record_failure — sit-orphan path catches it after 24h');
});

test('fish row + stale orphan (due_at >24h ago + no key) → burns attempt so 10-cutoff catches it', async () => {
  let recorded = null;
  const dueAtOld = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'fish', voice_id: 'vid-f', voice_name: null, attempts: 1, due_at: dueAtOld }],
  });
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  stubFetch(() => { throw new Error('should not fetch'); });
  const w = makeVoiceDeleteWorker({ supabase, fishApiKey: null });
  await w.tick();
  assert.equal(recorded?.p_last_error, 'no_fish_key', 'stale orphan transitions skipBump → record_failure');
});

test('fish row + fetch AbortError → record_failure with last_error=timeout', async () => {
  let recorded = null;
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'fish', voice_id: 'vid-f', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  stubFetch(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  const w = makeVoiceDeleteWorker({ supabase, fishApiKey: 'fk' });
  await w.tick();
  assert.equal(recorded?.p_last_error, 'timeout');
});

// Audit C2 + M6 — non-200 status codes routed correctly:
//   429 / 503 → skipBump (transient — retry without burning attempts)
//   401 / 403 → skipBump + Sentry (auth — retrying won't fix; orphan-bump after 24h)

test('fish row + status 429 → skipBump (rate-limited, no record_failure)', async () => {
  let recorded = null;
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'fish', voice_id: 'vid-f', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  stubFetch(() => ({ status: 429 }));
  const w = makeVoiceDeleteWorker({ supabase, fishApiKey: 'fk' });
  await w.tick();
  assert.equal(recorded, null, '429 must NOT burn attempts — sit-orphan path catches it after 24h if persistent');
});

test('fish row + status 503 → skipBump', async () => {
  let recorded = null;
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'fish', voice_id: 'vid-f', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  stubFetch(() => ({ status: 503 }));
  const w = makeVoiceDeleteWorker({ supabase, fishApiKey: 'fk' });
  await w.tick();
  assert.equal(recorded, null, '503 transient → skipBump');
});

test('fish row + status 401 → skipBump (bad key — retrying won\'t help)', async () => {
  let recorded = null;
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'fish', voice_id: 'vid-f', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  stubFetch(() => ({ status: 401 }));
  const w = makeVoiceDeleteWorker({ supabase, fishApiKey: 'fk' });
  await w.tick();
  assert.equal(recorded, null, '401 auth-failure must NOT burn attempts');
});

test('fish row + status 403 → skipBump', async () => {
  let recorded = null;
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'fish', voice_id: 'vid-f', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  stubFetch(() => ({ status: 403 }));
  const w = makeVoiceDeleteWorker({ supabase, fishApiKey: 'fk' });
  await w.tick();
  assert.equal(recorded, null, '403 account-suspended must NOT burn attempts');
});

// Audit C1 defense-in-depth — malformed voice_id at the worker boundary.
test('fish row + voice_id with path traversal → refuses dispatch (no fetch)', async () => {
  let recorded = null;
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'fish', voice_id: '../../../admin/keys', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded = args; return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  const fetchCalls = stubFetch(() => { throw new Error('should not fetch'); });
  const w = makeVoiceDeleteWorker({ supabase, fishApiKey: 'fk' });
  await w.tick();
  assert.equal(fetchCalls.length, 0, 'malformed voice_id must NOT reach Fish');
  assert.equal(recorded, null, 'skipBump:true — no record_failure (surfaces as orphan after 24h)');
});

test('fish row + empty voice_id → refuses dispatch', async () => {
  const supabase = makeFakeSupabase({
    claimRows: [{ tts_provider: 'fish', voice_id: '', voice_name: null, attempts: 1, due_at: new Date().toISOString() }],
  });
  const fetchCalls = stubFetch(() => { throw new Error('should not fetch'); });
  const w = makeVoiceDeleteWorker({ supabase, fishApiKey: 'fk' });
  await w.tick();
  assert.equal(fetchCalls.length, 0);
});

test('mixed batch — cartesia + hume + fish in one tick, each routes to its provider', async () => {
  const completed = [];
  const supabase = makeFakeSupabase({
    claimRows: [
      { tts_provider: 'cartesia', voice_id: 'c1',   voice_name: null,           attempts: 1, due_at: new Date().toISOString() },
      { tts_provider: 'hume',     voice_id: 'h1',   voice_name: 'Hume Voice',   attempts: 1, due_at: new Date().toISOString() },
      { tts_provider: 'fish',     voice_id: 'fid1', voice_name: null,           attempts: 1, due_at: new Date().toISOString() },
    ],
  });
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_complete_v2') { completed.push(args); return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  // Cartesia + Fish are 1 fetch each; Hume is GET-verify + DELETE = 2 fetches.
  // Total = 4.
  const fetchCalls = stubFetch((url, opts) => {
    if (url.includes('api.hume.ai') && opts?.method === 'GET') {
      return { status: 200, ok: true, json: async () => ({ voices: [{ id: 'h1', name: 'Hume Voice' }] }) };
    }
    return { status: 200, ok: true };
  });
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: 'ck', humeApiKey: 'hk', fishApiKey: 'fk' });
  await w.tick();
  assert.equal(fetchCalls.length, 4, 'cartesia DELETE + hume GET-verify + hume DELETE + fish DELETE');
  // Audit Small: claim-order from SKIP LOCKED isn't guaranteed across PG
  // versions; assert by URL-shape, not index.
  const urls = fetchCalls.map((c) => c.url);
  assert.ok(urls.some((u) => u.includes('api.cartesia.ai')), 'cartesia DELETE present');
  assert.ok(urls.some((u) => u.includes('api.fish.audio')), 'fish DELETE present');
  assert.equal(urls.filter((u) => u.includes('api.hume.ai')).length, 2, 'hume GET+DELETE present');
  assert.equal(completed.length, 3);
  assert.deepEqual(completed.map((c) => c.p_tts_provider).sort(), ['cartesia', 'fish', 'hume']);
});

test('Sentry: composite dedup key prevents cross-provider collision at threshold 5', async () => {
  // Two rows with the SAME voice_id but DIFFERENT providers, both at
  // attempts=5. The dedup key is ${provider}:${voice_id}:5 so BOTH must
  // record_failure (and both would alert in production; SENTRY_DSN
  // unset in tests makes captureException a no-op, so we assert on the
  // RPC side-effect instead — the absence of cross-provider dedup is
  // exactly that both rows get record_failure'd).
  const recorded = [];
  const supabase = makeFakeSupabase({
    claimRows: [
      { tts_provider: 'cartesia', voice_id: 'shared', voice_name: null, attempts: 5, due_at: new Date().toISOString() },
      { tts_provider: 'hume',     voice_id: 'shared', voice_name: 'name', attempts: 5, due_at: new Date().toISOString() },
    ],
  });
  supabase.rpc = (orig => async (name, args) => {
    if (name === 'voice_delete_queue_record_failure_v2') { recorded.push(args); return { data: null, error: null }; }
    return orig(name, args);
  })(supabase.rpc);
  stubFetch(() => ({ status: 500 }));
  const w = makeVoiceDeleteWorker({ supabase, cartesiaApiKey: 'ck', humeApiKey: 'hk' });
  await w.tick();
  // §5 audit S8 fix (2026-05-13): assert both providers recorded —
  // proves cross-provider dedup does NOT incorrectly merge the two rows.
  assert.equal(recorded.length, 2);
  assert.deepEqual(recorded.map((r) => r.p_tts_provider).sort(), ['cartesia', 'hume']);
});
