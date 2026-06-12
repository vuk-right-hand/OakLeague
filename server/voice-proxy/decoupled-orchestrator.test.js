// Unit tests for decoupled-orchestrator.js — DECOUPLED_BRAIN_PLAN P1-5.2,
// post audit a1bb5bc2 (C1-C4 / M1-M7). These lock the UX-critical and
// kill-switch-critical behaviors:
//   * paraphrase first; deep answer NEVER overlaps it
//   * C1: awaitTurnSpoken() does NOT resolve until the deep answer
//     finished streaming to TTS — so ttsBridge.turnEnd()'s continue:false
//     cannot truncate the creator's actual answer
//   * C3: a PRE-DISPATCH abort (server never billed) writes NO cogs leg
//   * C4: lastAssistantResponse() = the COMPLETED turn, never the
//     in-flight one even after the next utterance arrived
//   * M3: an over-budget retrieve degrades to persona-only (no dead air)
//   * misconfigured → onFatal once + latched (no 2nd paid call)
//
// Run: cd server/voice-proxy && node --test decoupled-orchestrator.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDecoupledOrchestrator } from './decoupled-orchestrator.js';

const tick = () => new Promise((r) => setImmediate(r));
function deferred() {
  let resolve; const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function onAbort(signal) {
  return new Promise((res) => {
    if (signal.aborted) return res();
    signal.addEventListener('abort', () => res(), { once: true });
  });
}
async function* genStream(deltas, final) {
  for (const d of deltas) yield { delta: d };
  yield { final: true, ...final };
}
async function* genThrow(deltas, code, partial) {
  for (const d of deltas) yield { delta: d };
  const e = new Error(code); e.code = code; if (partial) e.partial = partial;
  throw e;
}
async function* genGated(deltas, gate, final) {
  for (const d of deltas) yield { delta: d };
  await gate;
  yield { final: true, ...final };
}
async function* genBargeable(deltas, signal, partial) {
  for (const d of deltas) yield { delta: d };
  await onAbort(signal);
  const e = new Error('aborted'); e.code = 'timeout'; e.partial = partial;
  throw e;
}

function harness(overrides = {}) {
  const tts = []; const legs = []; const fatals = []; let personaNull = 0;
  const base = {
    generateParaphrase: () => genStream(['Let me ', 'think...'],
      { operation: 'brain_paraphrase', text: 'Let me think...', firstChunkMs: 5, startedAt: 1 }),
    generateDeepAnswer: () => genStream(['The ', 'grounded ', 'answer.'],
      { operation: 'brain_deep_answer', text: 'The grounded answer.', inputTokens: 9, outputTokens: 9, quotedAt: 'q', firstChunkMs: 7, latencyMs: 99, startedAt: 2 }),
    retrieve: async () => '--- BEGIN REFERENCE a1b2c3 ---\nx\n--- END REFERENCE a1b2c3 ---',
    ttsSendText: (t) => tts.push(t),
    logBrainLeg: async ({ leg }) => { legs.push(leg); return { ok: true }; },
    persona: 'You are Alex.', apiKey: 'k', userId: 'u', sessionId: 's',
    onFatal: (c) => fatals.push(c),
    onPersonaNull: () => { personaNull++; },
    // Existing suite exercises the paraphrase-ON behavior; the off-path has
    // its own dedicated tests below. Default-on here keeps these explicit.
    paraphraseEnabled: true,
    log: { warn() {}, error() {} },
    captureException: () => {},
  };
  const orch = makeDecoupledOrchestrator({ ...base, ...overrides });
  return { orch, tts, legs, fatals, personaNull: () => personaNull };
}

// ── seamless handoff ────────────────────────────────────────────────────

test('paraphrase speaks first; deep answer NEVER overlaps it', async () => {
  const rel = deferred();
  const { orch, tts } = harness({
    generateParaphrase: () => genGated(['Let me ', 'think...'], rel.promise,
      { operation: 'brain_paraphrase', text: 'Let me think...' }),
  });
  orch.onUserTranscript('q', 1);
  await tick();
  // Word-boundary buffer (2026-05-26): the trailing partial word of a stream
  // that is still SUSPENDED (gated before {final}) is held back until flush,
  // so only the space-terminated 'Let me ' has reached TTS; 'think...' is held.
  assert.deepEqual(tts, ['Let me ']);
  const tc = orch.onTurnComplete();
  await tick();
  assert.deepEqual(tts, ['Let me '], 'no deep chunk while paraphrase unfinished');
  rel.resolve();
  await tc;
  // Once each stream completes, flushWordCarry() releases the held final word —
  // so the full word-aligned sequence lands.
  assert.deepEqual(tts, ['Let me ', 'think...', 'The ', 'grounded ', 'answer.']);
  assert.equal(orch.lastAssistantResponse(), 'The grounded answer.');
});

// ── redundant onTurnComplete must not resolve spoken early (silent-Cartesia) ──

test('redundant onTurnComplete (early-trigger + Gemini fallback) does NOT resolve spoken before the deep answer finishes streaming', async () => {
  // The silent-Cartesia bug: onTurnComplete fires twice in decoupled mode
  // (early at input_transcription + the Gemini turn_complete fallback). If the
  // second (t.done) call resolves spoken, index.js's awaitTurnSpoken() returns
  // early → ttsBridge.turnEnd() closes the Cartesia context → the still-
  // streaming deep answer's sendText no-ops → 0 chars → dead air. Exposed when
  // maxOutputTokens made Gemini's turn_complete beat the deep answer.
  const rel = deferred();
  const { orch, tts } = harness({
    paraphraseEnabled: false, // prod default — deep answer is the sole voice
    generateDeepAnswer: () => genGated(['The answer.'], rel.promise,
      { operation: 'brain_deep_answer', text: 'The answer.', firstChunkMs: 7, latencyMs: 9, startedAt: 2 }),
  });
  orch.onUserTranscript('q', 1);
  const tc1 = orch.onTurnComplete();          // early-trigger — streams, then hangs on rel
  await tick();
  await orch.onTurnComplete();                // Gemini turn_complete fallback (t.done)
  let spokenResolved = false;
  orch.awaitTurnSpoken(10_000).then(() => { spokenResolved = true; });
  await tick();
  assert.equal(spokenResolved, false,
    'spoken must NOT resolve while the deep answer is mid-stream (else ttsBridge.turnEnd closes Cartesia → silence)');
  // Word-boundary buffer: 'The ' streamed (space-terminated); the still-held
  // 'answer.' proves the partial trailing word waits for flush at stream end.
  assert.deepEqual(tts, ['The '], 'deep answer delta already streamed to TTS');
  rel.resolve();
  await tc1;
  await tick();
  assert.equal(spokenResolved, true, 'spoken resolves once the deep answer finishes streaming');
});

test('audit M2 — fallback onTurnComplete DURING retrieval (before any deep delta) is the exact shipped timing; still must not resolve spoken', async () => {
  // The token cap made Gemini turn_complete fire while the first call was still
  // awaiting RETRIEVAL — before a single deep-answer delta. This pins that window.
  const relRetrieve = deferred();
  const { orch, tts } = harness({
    paraphraseEnabled: false,
    retrieve: async () => { await relRetrieve.promise; return null; }, // hangs → no delta yet
    generateDeepAnswer: () => genStream(['Grounded answer.'],
      { operation: 'brain_deep_answer', text: 'Grounded answer.', firstChunkMs: 3, latencyMs: 4, startedAt: 1 }),
  });
  orch.onUserTranscript('q', 1);
  const tc1 = orch.onTurnComplete();   // blocks in retrieval — no delta emitted
  await tick();
  await orch.onTurnComplete();         // fallback fires MID-retrieval (the shipped trigger)
  let resolved = false;
  orch.awaitTurnSpoken(10_000).then(() => { resolved = true; });
  await tick();
  assert.equal(resolved, false, 'fallback must not resolve spoken while retrieval is still pending');
  assert.deepEqual(tts, [], 'no deep delta yet — retrieval not done');
  relRetrieve.resolve();
  await tc1;
  await tick();
  assert.equal(resolved, true, 'spoken resolves after the deep answer streams');
  // Word-boundary buffer: single delta 'Grounded answer.' emits the space-
  // terminated 'Grounded ' mid-stream, then flushWordCarry() releases 'answer.'.
  assert.deepEqual(tts, ['Grounded ', 'answer.'], 'deep answer reaches TTS once retrieval completes');
});

// ── C1: awaitTurnSpoken gates ttsBridge.turnEnd() ───────────────────────

test('C1: awaitTurnSpoken does NOT resolve until the deep answer finished streaming', async () => {
  const deepGate = deferred();
  const { orch, tts } = harness({
    generateDeepAnswer: () => genGated(['The ', 'answer.'], deepGate.promise,
      { operation: 'brain_deep_answer', text: 'The answer.' }),
  });
  orch.onUserTranscript('q', 1);
  await tick();
  orch.onTurnComplete();
  await tick();
  // Deep answer has streamed its deltas but not its terminal {final}. The
  // paraphrase completed (so its held 'think...' was flushed); the deep stream
  // is still suspended, so its trailing 'answer.' stays held in the word-buffer
  // — only the space-terminated 'The ' has reached TTS.
  assert.deepEqual(tts, ['Let me ', 'think...', 'The ']);
  let spokenResolved = false;
  const sp = orch.awaitTurnSpoken(10_000).then(() => { spokenResolved = true; });
  await tick();
  assert.equal(spokenResolved, false,
    'turn_end MUST NOT proceed to ttsBridge.turnEnd() — deep answer not yet final');
  deepGate.resolve();          // deep answer completes
  await sp;
  assert.equal(spokenResolved, true, 'now safe to send continue:false');
});

// ── word-boundary buffer (mid-word "shh/chh" garble fix, 2026-05-26) ────────

test('word-boundary buffer: a delta that splits a word mid-grapheme never reaches TTS as a fragment', async () => {
  // The brain LLM streams token-aligned deltas that split mid-word
  // ('mon'|'k under'|'stands.'). Forwarding each raw delta as its own Cartesia
  // continuation message produced fricative seams (garbled "shh/chh"). The
  // buffer must reassemble whole words before they hit TTS.
  const { orch, tts } = harness({
    paraphraseEnabled: false,
    generateDeepAnswer: () => genStream(['The mon', 'k under', 'stands.'],
      { operation: 'brain_deep_answer', text: 'The monk understands.', firstChunkMs: 3, latencyMs: 4, startedAt: 1 }),
  });
  orch.onUserTranscript('q', 1);
  orch.onTurnComplete();
  await tick();
  // 1. Nothing is lost or duplicated: the concatenation is the exact answer.
  assert.equal(tts.join(''), 'The monk understands.');
  // 2. Every emitted piece EXCEPT the final flush ends on whitespace — i.e. no
  //    chunk ever ends in the middle of a word ('mon', 'under' never go alone).
  tts.slice(0, -1).forEach((piece) => {
    assert.match(piece, /\s$/, `chunk ${JSON.stringify(piece)} must end on a word boundary`);
  });
  // 3. Concretely, the reassembled words ride single contiguous chunks.
  assert.deepEqual(tts, ['The ', 'monk ', 'understands.']);
});

test('C1: awaitTurnSpoken resolves on barge even though the deep answer never finished', async () => {
  let dSig;
  const { orch } = harness({
    generateDeepAnswer: ({ signal }) => { dSig = signal; return genBargeable(['The'], signal,
      { operation: 'brain_deep_answer', billed: true, text: 'The', inputTokens: 9, outputTokens: 1 }); },
  });
  orch.onUserTranscript('q', 1);
  await tick();
  orch.onTurnComplete();
  await tick();
  orch.onInterrupted();
  await orch.awaitTurnSpoken(10_000); // must resolve, not hang
  assert.equal(dSig.aborted, true);
});

test('C1: awaitTurnSpoken resolves immediately when no turn ran', async () => {
  const { orch } = harness();
  await orch.awaitTurnSpoken(10_000);
});

test('C1: awaitTurnSpoken is BOUNDED — a wedged deep generator cannot stall teardown', async () => {
  const never = new Promise(() => {});
  const { orch } = harness({
    generateDeepAnswer: () => genGated(['x'], never, { operation: 'brain_deep_answer', text: 'x' }),
  });
  orch.onUserTranscript('q', 1);
  await tick();
  orch.onTurnComplete();
  await tick();
  const t0 = Date.now();
  await orch.awaitTurnSpoken(40); // tiny bound
  assert.ok(Date.now() - t0 < 5000, 'awaitTurnSpoken honored its timeout, did not hang');
});

// ── paraphrase failure invisible ────────────────────────────────────────

test('paraphrase network_error → no fatal; the deep answer still speaks', async () => {
  const { orch, tts, fatals, legs } = harness({
    generateParaphrase: () => genThrow([], 'network_error'),
  });
  orch.onUserTranscript('q', 1);
  await tick();
  await orch.onTurnComplete();
  assert.equal(fatals.length, 0);
  assert.deepEqual(tts, ['The ', 'grounded ', 'answer.']);
  assert.deepEqual(legs.map((l) => l.operation), ['brain_deep_answer']);
});

// ── retrieval: null / throw / M3 ceiling ────────────────────────────────

test('retrieve → null: deep answer called with null envelope (C2 persona-only)', async () => {
  let seen = 'unset';
  const { orch, tts } = harness({
    retrieve: async () => null,
    generateDeepAnswer: ({ referenceEnvelopeText }) => {
      seen = referenceEnvelopeText;
      return genStream(['Persona.'], { operation: 'brain_deep_answer', text: 'Persona.' });
    },
  });
  orch.onUserTranscript('q', 1);
  await tick();
  await orch.onTurnComplete();
  assert.equal(seen, null);
  assert.ok(tts.includes('Persona.'));
});

test('M3: a retrieve that exceeds the ceiling degrades to persona-only (no dead air)', async () => {
  let seen = 'unset';
  const { orch } = harness({
    retrieveCeilingMs: 30,
    retrieve: () => new Promise((res) => setTimeout(() => res('--- BEGIN REFERENCE a1b2c3 ---\nx\n--- END REFERENCE a1b2c3 ---'), 5000)),
    generateDeepAnswer: ({ referenceEnvelopeText }) => {
      seen = referenceEnvelopeText;
      return genStream(['Answer.'], { operation: 'brain_deep_answer', text: 'Answer.' });
    },
  });
  orch.onUserTranscript('q', 1);
  await tick();
  await orch.onTurnComplete();
  assert.equal(seen, null, 'over-budget retrieve ⇒ null envelope ⇒ deep answer starts NOW');
  assert.equal(orch.metricsSnapshot().degraded.includes('r:timeout'), true);
});

// Audit M6 — on a ceiling-timeout the retrieval HTTP call is useless
// (result never consumed) but still BILLING to its budget. The
// orchestrator must abort the retrieve signal so the socket dies and
// the billing tail stops the instant we stop waiting.
test('M6: ceiling-timeout ABORTS the retrieve signal (kills the billing tail)', async () => {
  let capturedSignal = null;
  const { orch } = harness({
    retrieveCeilingMs: 20,
    retrieve: (q, signal) => {
      capturedSignal = signal;
      return new Promise((res) => setTimeout(() => res('late'), 5000));
    },
    generateDeepAnswer: () => genStream(['A.'], { operation: 'brain_deep_answer', text: 'A.' }),
  });
  orch.onUserTranscript('q', 1);
  await tick();
  assert.ok(capturedSignal && capturedSignal.aborted === false, 'retrieve in flight, not yet aborted');
  await orch.onTurnComplete();
  assert.equal(capturedSignal.aborted, true, 'over-ceiling retrieve socket aborted — no billing tail');
});

// ── P0-3 — groundingState classification (off-domain vs retrieval-failure) ──

// Drives one paraphrase-OFF turn and returns the groundingState the deep answer
// was called with. `envOn` toggles V3_OFF_DOMAIN_HEDGE_ENABLED for the call.
async function groundingFor(retrieveImpl, { question = 'what is your framework for hiring?', retrieveCeilingMs, envOn = false } = {}) {
  const prev = process.env.V3_OFF_DOMAIN_HEDGE_ENABLED;
  if (envOn) process.env.V3_OFF_DOMAIN_HEDGE_ENABLED = '1';
  else delete process.env.V3_OFF_DOMAIN_HEDGE_ENABLED;
  let seen = 'unset';
  try {
    const { orch } = harness({
      paraphraseEnabled: false,
      ...(retrieveCeilingMs ? { retrieveCeilingMs } : {}),
      retrieve: retrieveImpl,
      generateDeepAnswer: ({ groundingState }) => {
        seen = groundingState;
        return genStream(['A.'], { operation: 'brain_deep_answer', text: 'A.', firstChunkMs: 5 });
      },
    });
    orch.onUserTranscript(question, 1);
    await tick();
    await orch.onTurnComplete();
  } finally {
    if (prev === undefined) delete process.env.V3_OFF_DOMAIN_HEDGE_ENABLED;
    else process.env.V3_OFF_DOMAIN_HEDGE_ENABLED = prev;
  }
  return seen;
}

test('P0-3: a real envelope → groundingState "grounded"', async () => {
  const env = '--- BEGIN REFERENCE a1b2c3 ---\nx\n--- END REFERENCE a1b2c3 ---';
  assert.equal(await groundingFor(async () => env), 'grounded');
});

test('P0-3: clean-empty retrieval (attempted) + hedge ON → "off_domain"', async () => {
  assert.equal(await groundingFor(async () => null, { envOn: true }), 'off_domain');
});

test('P0-3: clean-empty retrieval + hedge OFF (default) → "retrieval_failed" (conservative — no false "not my expertise")', async () => {
  assert.equal(await groundingFor(async () => null, { envOn: false }), 'retrieval_failed');
});

test('P0-3: a thrown retrieval → t.retrieveFailed → "retrieval_failed" (even with hedge ON)', async () => {
  assert.equal(
    await groundingFor(async () => { throw new Error('shim 503'); }, { envOn: true }),
    'retrieval_failed',
  );
});

test('P0-3: a ceiling timeout → "retrieval_failed" (classified off the timeout sentinel, not the post-abort value)', async () => {
  const grounding = await groundingFor(
    () => new Promise((res) => setTimeout(() => res('--- BEGIN REFERENCE a1b2c3 ---\nx\n--- END REFERENCE a1b2c3 ---'), 5000)),
    { retrieveCeilingMs: 20, envOn: true },
  );
  assert.equal(grounding, 'retrieval_failed');
});

test('P0-3: a trivial Q skips retrieval → "none" (today\'s plain persona-only, no hedge)', async () => {
  // 'hey' is trivial → retrievalAttempted=false → not off_domain even with hedge ON.
  assert.equal(await groundingFor(async () => null, { question: 'hey', envOn: true }), 'none');
});

// Audit M7 — onUserTranscript after the fatal latch must NOT be a
// silent no-op: a breadcrumb makes the "user spoke during the teardown
// race" window greppable in triage (onFatal owns the user-visible 1011).
test('M7: onUserTranscript after fatal logs a breadcrumb (not silent), no paid work', async () => {
  const warns = [];
  let deepCalls = 0;
  const { orch, tts } = harness({
    generateParaphrase: () => genThrow([], 'misconfigured'),
    generateDeepAnswer: () => { deepCalls++; return genStream(['x'], { operation: 'brain_deep_answer', text: 'x' }); },
    log: { warn: (m) => warns.push(m), error() {} },
  });
  orch.onUserTranscript('q1', 1);   // latches fatal via misconfigured
  await tick();
  warns.length = 0;                 // isolate the post-fatal breadcrumb
  orch.onUserTranscript('q2', 2);   // user speaks again during teardown race
  await tick();
  assert.ok(warns.some((m) => /onUserTranscript after fatal/.test(m)),
    'fatal early-return emits a triage breadcrumb');
  assert.equal(deepCalls, 0, 'no second paid call after fatal');
  assert.equal(tts.length, 0, 'nothing spoken for the post-fatal turn');
});

test('retrieve throws → swallowed, deep proceeds persona-only, not fatal', async () => {
  const { orch, tts, fatals } = harness({
    retrieve: async () => { throw new Error('shim 503'); },
    generateDeepAnswer: () => genStream(['ok.'], { operation: 'brain_deep_answer', text: 'ok.' }),
  });
  orch.onUserTranscript('q', 1);
  await tick();
  await orch.onTurnComplete();
  assert.equal(fatals.length, 0);
  assert.ok(tts.includes('ok.'));
});

// ── C-5: suspected-truncated transcript ─────────────────────────────────
// A >12s utterance whose transcript Gemini dropped >40% of must NOT silently
// ground retrieval on the partial question. Skip retrieval (persona-only) and
// record it so the quality loss is observable (was silent before).
test('C-5: truncationSuspected skips retrieval, runs persona-only, and is recorded', async () => {
  let retrieveCalls = 0;
  let deepEnvelope = 'UNSET';
  let deepForceBrief = null;
  const { orch } = harness({
    paraphraseEnabled: false,
    retrieve: async () => { retrieveCalls++; return '--- BEGIN REFERENCE a1b2c3 ---\nx\n--- END REFERENCE a1b2c3 ---'; },
    generateDeepAnswer: ({ referenceEnvelopeText, forceBrief }) => {
      deepEnvelope = referenceEnvelopeText;
      deepForceBrief = forceBrief;
      return genStream(['A.'], { operation: 'brain_deep_answer', text: 'A.' });
    },
  });
  orch.onUserTranscript('a long question that got cut off mid', 1, { truncationSuspected: true });
  await orch.onTurnComplete();
  assert.equal(retrieveCalls, 0, 'retrieval skipped on suspected truncation');
  assert.equal(deepEnvelope, null, 'deep answer runs persona-only (no grounding on a partial Q)');
  assert.equal(deepForceBrief, true, 'audit M1: truncated Q answered BRIEF, not a confident 450-word reply to a fragment');
  const m = orch.metricsSnapshot();
  assert.equal(m.truncatedTurns, 1, 'truncated turn counted');
  assert.ok((m.degraded || []).includes('trunc'), 'truncation recorded in degraded (observable, not silent)');
});

test('C-5 control: without the flag, retrieval runs + grounds (no regression)', async () => {
  let retrieveCalls = 0;
  let deepEnvelope = 'UNSET';
  const { orch } = harness({
    paraphraseEnabled: false,
    retrieve: async () => { retrieveCalls++; return '--- BEGIN REFERENCE a1b2c3 ---\nx\n--- END REFERENCE a1b2c3 ---'; },
    generateDeepAnswer: ({ referenceEnvelopeText }) => {
      deepEnvelope = referenceEnvelopeText;
      return genStream(['A.'], { operation: 'brain_deep_answer', text: 'A.' });
    },
  });
  orch.onUserTranscript('q', 1);
  await orch.onTurnComplete();
  assert.equal(retrieveCalls, 1, 'retrieval runs when not truncated');
  assert.ok(typeof deepEnvelope === 'string' && deepEnvelope.includes('BEGIN REFERENCE'),
    'grounded envelope passed to the deep answer');
  assert.equal(orch.metricsSnapshot().truncatedTurns, 0, 'no truncated turn counted');
});

// ── barge-in cogs (C3) ──────────────────────────────────────────────────

test('barge mid-paraphrase: server billed → billed:true partial leg IS written', async () => {
  const partial = { operation: 'brain_paraphrase', billed: true, text: 'Let me', inputTokens: 1, outputTokens: 0 };
  const { orch, legs } = harness({
    generateParaphrase: ({ signal }) => genBargeable(['Let me'], signal, partial),
  });
  orch.onUserTranscript('q', 1);
  await tick();
  orch.onInterrupted();
  await tick(); await tick();
  assert.equal(legs.length, 1);
  assert.equal(legs[0].billed, true);
  assert.equal(orch.metricsSnapshot().barged, 1);
});

test('C3: PRE-DISPATCH abort (server NOT billed, billed:false) writes NO cogs leg', async () => {
  // streamGenerate throws timeout with .partial.billed=false when the
  // signal was already aborted before dispatch. No phantom cost row.
  const { orch, legs } = harness({
    generateParaphrase: () => genThrow([], 'timeout',
      { operation: 'brain_paraphrase', billed: false, text: '', inputTokens: null, outputTokens: null }),
  });
  orch.onUserTranscript('q', 1);
  await tick();
  await orch.onTurnComplete();
  assert.equal(legs.filter((l) => l.operation === 'brain_paraphrase').length, 0,
    'a call the server never billed must NOT write a cogs leg (kill-switch integrity)');
});

// ── misconfigured: onFatal once + latched ───────────────────────────────

test("misconfigured → onFatal once; the latch blocks a 2nd paid call", async () => {
  let deepCalls = 0;
  const { orch, fatals } = harness({
    generateParaphrase: () => genThrow([], 'misconfigured'),
    generateDeepAnswer: () => { deepCalls++; return genStream(['x'], { operation: 'brain_deep_answer', text: 'x' }); },
  });
  orch.onUserTranscript('q', 1);
  await tick();
  await orch.onTurnComplete();
  assert.deepEqual(fatals, ['misconfigured']);
  assert.equal(deepCalls, 0, 'fatal latched ⇒ onTurnComplete makes no deep-answer call');
});

test('empty_input degrade: no fatal, nothing spoken', async () => {
  const { orch, fatals, tts } = harness({
    generateParaphrase: () => genThrow([], 'empty_input'),
    generateDeepAnswer: () => genThrow([], 'empty_input'),
  });
  orch.onUserTranscript('   ', 1);
  await tick();
  await orch.onTurnComplete();
  assert.equal(fatals.length, 0);
  assert.deepEqual(tts, []);
});

// ── C4: completed-turn attribution under overlap ────────────────────────

test('C4: lastAssistantResponse() returns the COMPLETED turn even after the next utterance arrives', async () => {
  const { orch } = harness();
  orch.onUserTranscript('q1', 1);
  await tick();
  await orch.onTurnComplete();             // turn 1 completes
  assert.equal(orch.lastAssistantResponse(), 'The grounded answer.');
  orch.onUserTranscript('q2', 2);          // turn 2 starts, global `turn` moves
  await tick();
  assert.equal(orch.lastAssistantResponse(), 'The grounded answer.',
    'still turn 1 — NOT null/stale from the in-flight turn 2');
});

test('C4/M2: a new utterance supersedes a still-streaming previous turn (aborts it)', async () => {
  let firstDeepSignal;
  const never = new Promise(() => {});
  const { orch } = harness({
    generateDeepAnswer: ({ signal }) => { if (!firstDeepSignal) firstDeepSignal = signal;
      return genGated(['slow'], never, { operation: 'brain_deep_answer', text: 'slow' }); },
  });
  orch.onUserTranscript('q1', 1);
  await tick();
  orch.onTurnComplete();                    // turn 1 deep answer starts, hangs
  await tick();
  orch.onUserTranscript('q2', 2);           // supersede
  await tick();
  assert.equal(firstDeepSignal.aborted, true, 'turn 1 aborted — we do not talk over the user');
});

// ── persona-null breadcrumb + cogs verbatim ─────────────────────────────

test('persona null → onPersonaNull once', async () => {
  const { orch, personaNull } = harness({ persona: null });
  assert.equal(personaNull(), 1);
  orch.onUserTranscript('q', 1);
  await tick();
  assert.equal(personaNull(), 1);
});

test('the bridge {final} is handed to logBrainLeg verbatim', async () => {
  const { orch, legs } = harness();
  orch.onUserTranscript('q', 1);
  await tick();
  await orch.onTurnComplete();
  const deep = legs.find((l) => l.operation === 'brain_deep_answer');
  assert.equal(deep.text, 'The grounded answer.');
  assert.equal(deep.inputTokens, 9);
  assert.equal(deep.quotedAt, 'q');
});

// ── whole-build audit C1 — metricsSnapshot SHAPE is the contract index.js reads
//
// metricsSnapshot field names are load-bearing: index.js's teardown log
// (the (A)-gate first-audio metric) reads them by name. Before the fix
// the reader was `m.turnNumber` / `m.paraphrase?.firstChunkMs` /
// `m.deep?.firstChunkMs` and resolved to undefined every session. This
// asserts the CURRENT field names — a future drift on either side fails
// loudly instead of writing `na` to the log line.
test('C1 metricsSnapshot exposes lastTurnNumber / lastParaFirstMs / lastDeepFirstMs', async () => {
  const { orch } = harness();
  orch.onUserTranscript('q', 7);
  await tick();
  await orch.onTurnComplete();
  const m = orch.metricsSnapshot();
  assert.ok(m, 'snapshot present after a turn ran');
  assert.equal(m.turns, 1);
  assert.equal(m.lastTurnNumber, 7);
  assert.equal(typeof m.lastParaFirstMs, 'number', 'lastParaFirstMs populated post-final');
  assert.equal(typeof m.lastDeepFirstMs, 'number', 'lastDeepFirstMs populated post-final');
  // Drift guard — the pre-fix readers MUST NOT come back as a future
  // refactor convenience or index.js will silently log undefined again.
  assert.equal(m.turnNumber, undefined);
  assert.equal(m.paraphrase, undefined);
  assert.equal(m.deep, undefined);
});

// ── whole-build audit M4 — firstChunkMs captured on barge (no final)
test('M4 firstChunkMs is captured even when the turn barges before final', async () => {
  // Paraphrase yields a delta then never finals — barge mid-stream. The
  // pre-fix path read firstChunkMs only from `final`; this asserts the
  // streamToTts wall-clock capture lands the metric anyway.
  const { orch } = harness({
    generateParaphrase: ({ signal }) => genBargeable(['Let me think...'], signal,
      { operation: 'brain_paraphrase', text: 'Let me think...', inputTokens: 5, outputTokens: 5, quotedAt: 'q', modelId: 'm', usdPerInputToken: 1, usdPerOutputToken: 1, billed: true }),
  });
  orch.onUserTranscript('q', 1);
  await tick();
  orch.onInterrupted(); // barge — paraphraseAbort fires
  await tick();
  await tick();
  const m = orch.metricsSnapshot();
  assert.equal(typeof m.lastParaFirstMs, 'number',
    'M4: firstChunkMs landed in lastParaFirstMs even though no final event arrived');
});

// ── whole-build audit C2 — streaming char ceiling soft-stops a runaway
test('C2 deep-answer char ceiling soft-stops a runaway (≤ 4200c emitted, degraded=char_ceiling)', async () => {
  // 100 deltas × 50 chars = 5000c emitted upstream. The orchestrator must
  // soft-stop within the ceiling+slack window (4200c) and mark the turn
  // degraded='char_ceiling'.
  const big = '. ' + 'x'.repeat(48); // 50 chars; the '.' is a sentence boundary
  const deltas = Array.from({ length: 100 }, () => big);
  const { orch, tts } = harness({
    generateDeepAnswer: () => genStream(deltas,
      { operation: 'brain_deep_answer', text: deltas.join(''), inputTokens: 9, outputTokens: 9, quotedAt: 'q', firstChunkMs: 7, latencyMs: 99, startedAt: 2 }),
  });
  orch.onUserTranscript('q', 1);
  await tick();
  await orch.onTurnComplete();
  const total = tts.join('').length;
  assert.ok(total <= 4200,
    `C2: TTS-emitted chars must stay within ceiling+slack (got ${total}, ceiling=4000, slack=200)`);
  const m = orch.metricsSnapshot();
  assert.ok((m.degraded || []).some((d) => d.includes('char_ceiling')),
    `C2: degraded list should record char_ceiling (got ${JSON.stringify(m.degraded)})`);
});

// ── Step-2 — Haiku failover metric ──────────────────────────────────────
test('Step-2: metricsSnapshot.deepFailedOver counts a Haiku-carried (failedOver) turn', async () => {
  const { orch } = harness({
    paraphraseEnabled: false,
    generateDeepAnswer: () => genStream(['Haiku ', 'answer.'], {
      operation: 'brain_deep_answer_failover', service: 'anthropic', failedOver: true,
      text: 'Haiku answer.', inputTokens: 5, outputTokens: 5, quotedAt: 'q', firstChunkMs: 7, latencyMs: 50, startedAt: 2,
    }),
  });
  orch.onUserTranscript('what is the moat?', 1);
  await tick();
  await orch.onTurnComplete();
  assert.equal(orch.metricsSnapshot().deepFailedOver, 1);
});

test('Step-2: a normal Gemini turn leaves deepFailedOver at 0', async () => {
  const { orch } = harness({ paraphraseEnabled: false });
  orch.onUserTranscript('what is the moat?', 1);
  await tick();
  await orch.onTurnComplete();
  assert.equal(orch.metricsSnapshot().deepFailedOver, 0);
});

// ── P1-10 — trivial-Q classifier + skip deep_answer ────────────────────
//
// Real-session finding (2026-05-20): user asked "can you hear me?" and
// got a long invented hedge ("Let me reflect on how to best frame this,
// my friend - what you're really asking about is how a single fork in
// the road of our worldview..."). The hedge is the paraphrase model
// hallucinating because the prompt forced an ALWAYS-HEDGE behavior.
//
// Fix: orchestrator detects trivial Qs and skips the off-Live
// deep_answer. The paraphrase IS the full answer (paraphrase.js's
// PARAPHRASE_SYSTEM_SUFFIX now handles trivial Qs with a direct short
// reply). These tests lock the orchestrator-side behavior.

import { isTrivialQuestion } from './decoupled-orchestrator.js';

test('P1-10: isTrivialQuestion classifies greetings + hearing checks + mic checks', () => {
  // True positives (should be trivial)
  const trivial = [
    // Greetings
    'hi', 'hello', 'hey', 'Hello!', 'hey,', 'sup', 'hola',
    'hello hello', 'yo wassup', 'wassup', 'whats up', "what's up",
    // Hearing checks (full-string anchored)
    'can you hear me', 'can you hear me?',
    'do you hear me',
    'are you still listening to me',
    'are you actually listening',
    // "are you" variants
    'are you there', 'are you there?', 'are you listening',
    'are you on', 'are you with me',
    // Time-of-day greetings
    'good morning', 'good afternoon', 'good evening', 'good night',
    // Mic / test
    'test', 'testing', 'mic check', 'mic test', 'check',
    'hello there', 'one two three',
    // Closings / acknowledgments (P1-10 audit M4 — added)
    'thanks', 'thank you', 'ty', 'tysm', 'appreciate it',
    'bye', 'goodbye', 'see ya', 'see you', 'later', 'peace',
    'ok', 'okay', 'got it', 'gotcha', 'cool', 'nice', 'cheers',
    'alright', 'sounds good',
    // TTFT optimization (2026-06-10) — how-are-you family, incl. Gemini
    // STT artifacts: dropped-g, contraction, apostrophe-less, "ya".
    'how are you', 'how are you?', 'How are you today?',
    'how are you doing', 'how are you doing today',
    'how are you doin', "how're you", "how're you doing",
    'how are ya', 'how ya doing', 'how ya doin',
    'how you doing', 'how you doing today',
    "how's it going", 'how is it going', 'hows it going',
    "how's your day", 'how is your day going', 'hows your day been',
    "how's everything", 'hows everything', "how's things",
    "how's life", 'how do you do', 'you good', 'you good?',
  ];
  for (const q of trivial) {
    assert.equal(isTrivialQuestion(q), true, `trivial: "${q}"`);
  }

  // True negatives (should NOT be trivial — real questions).
  // P1-10 audit C3 — these used to false-classify because the
  // hearing-check / "are you" regex was mid-string anchored via \b…\b.
  // After end-of-string anchoring they correctly route to substantive.
  const substantive = [
    '',
    'What is one practical fundraising tip for a pre-seed founder?',
    'how do I hire my first engineer',
    // The C3 keystone false-positives — substantive questions that
    // happen to contain "can you hear" / "are you here" prefixes:
    'can you hear me on this question about pricing?',
    'are you here for the call about my fundraise?',
    'can you listen to a quick situation',
    'do you hear what the market is saying about ai',
    // Trivial-looking prefix + real continuation:
    'thanks but actually what I meant was…',
    'ok so my real question is about strategy',
    // Quoted greeting inside a real question:
    'I said "hi" to my mentor and he ignored me — what now?',
    // Length cap (>60 chars) prevents false positives:
    'hello there, I have a long-form question about hiring strategy',
    // Comma-tail variants reclassify as substantive (per audit C3 note —
    // appending an address turns hearing-check into a conversational opener
    // that DOES warrant a real answer).
    'can you hear me, friend? I have a real question',
    // TTFT (2026-06-10, plan-audit verified) — how-are-you prefixed
    // SUBSTANTIVE questions must NOT match (the $ anchor defeats them):
    'how are you handling pricing for enterprise',
    'how are you different from other coaches',
    'how is it going to work',
    'how are you measuring success',
    'how is your day structured for deep work',
  ];
  for (const q of substantive) {
    assert.equal(isTrivialQuestion(q), false, `substantive: "${q}"`);
  }
});

test('P1-10 audit M3: trivial Q does NOT pollute lastAssistantResponse (retrieval context)', async () => {
  // The PRIOR substantive turn's response should survive a trivial turn.
  // Without this, the next substantive turn's retrieval rewriter gets
  // "Loud and clear, friend." as conversation context — useless.
  const { orch } = harness();

  // Turn 1: substantive — populates lastAssistantResponse.
  orch.onUserTranscript('What is one practical fundraising tip?', 1);
  await tick();
  await orch.onTurnComplete();
  const substantiveAnswer = orch.lastAssistantResponse();
  assert.equal(substantiveAnswer, 'The grounded answer.',
    'turn 1 substantive answer captured');

  // Turn 2: trivial — must NOT overwrite lastAssistantResponse.
  orch.onUserTranscript('can you hear me?', 2);
  await tick();
  await orch.onTurnComplete();
  assert.equal(orch.lastAssistantResponse(), substantiveAnswer,
    'M3: trivial turn must preserve PRIOR substantive lastAssistantResponse');
});

test('P1-10 audit M2: metricsSnapshot exposes interruptedSuppressed + trivialTurns', async () => {
  const { orch } = harness();
  orch.onUserTranscript('hi', 1);
  await tick();
  await orch.onTurnComplete();
  orch.onUserTranscript('good morning', 2);
  await tick();
  await orch.onTurnComplete();

  // Simulate the proxy's suppression-handler invocation.
  orch.recordInterruptedSuppressed();
  orch.recordInterruptedSuppressed();

  const m = orch.metricsSnapshot();
  assert.equal(m.trivialTurns, 2, 'trivialTurns counts trivial-Q-detected turns');
  assert.equal(m.interruptedSuppressed, 2,
    'interruptedSuppressed counts spurious-barge suppressions');
});

test('P1-10: trivial Q → paraphrase fires, deep_answer SKIPPED, no retrieval', async () => {
  let deepCalls = 0;
  let retrieveCalls = 0;
  const { orch, legs } = harness({
    generateParaphrase: () => genStream(['Loud and clear, ', 'friend. ', 'What\'s on your mind?'],
      { operation: 'brain_paraphrase', text: 'Loud and clear, friend. What\'s on your mind?',
        inputTokens: 8, outputTokens: 9, quotedAt: 'q', firstChunkMs: 5, latencyMs: 99, startedAt: 1 }),
    generateDeepAnswer: () => { deepCalls++; return genStream(['x'], { operation: 'brain_deep_answer', text: 'x', firstChunkMs: 7 }); },
    retrieve: async () => { retrieveCalls++; return null; },
  });
  orch.onUserTranscript('can you hear me?', 1);
  await tick();
  await orch.onTurnComplete();

  assert.equal(deepCalls, 0, 'deep_answer MUST NOT fire on trivial Q');
  assert.equal(retrieveCalls, 0, 'retrieve MUST NOT fire on trivial Q (no deep_answer will use it)');
  assert.equal(legs.filter((l) => l.operation === 'brain_paraphrase').length, 1, 'paraphrase still fires on trivial Q');
  assert.equal(legs.filter((l) => l.operation === 'brain_deep_answer').length, 0, 'no deep_answer cogs leg on trivial Q');
  // P1-10 audit M3 — lastAssistantResponse NOT polluted with trivial-Q
  // text (would poison next turn's retrieval rewriter context).
  assert.equal(orch.lastAssistantResponse(), null,
    'M3: trivial Q does NOT update lastAssistantResponse (no prior substantive turn → null)');
});

test('P1-10: substantive Q still fires BOTH paraphrase + deep_answer (regression guard)', async () => {
  let deepCalls = 0;
  const { orch, legs } = harness({
    generateDeepAnswer: () => { deepCalls++; return genStream(['The ', 'grounded ', 'answer.'],
      { operation: 'brain_deep_answer', text: 'The grounded answer.', inputTokens: 9, outputTokens: 9, quotedAt: 'q', firstChunkMs: 7, latencyMs: 99, startedAt: 2 }); },
  });
  orch.onUserTranscript('What is one practical fundraising tip?', 1);
  await tick();
  await orch.onTurnComplete();

  assert.equal(deepCalls, 1, 'deep_answer MUST fire on substantive Q');
  assert.equal(legs.filter((l) => l.operation === 'brain_paraphrase').length, 1);
  assert.equal(legs.filter((l) => l.operation === 'brain_deep_answer').length, 1);
});

// ── paraphrase OFF (PARAPHRASE_ENABLED=0 — the default) ───────────────────

test('paraphrase OFF: substantive Q → ONLY deep_answer fires, deep is sole voice', async () => {
  let paraCalls = 0;
  let deepCalls = 0;
  const { orch, legs, tts } = harness({
    paraphraseEnabled: false,
    generateParaphrase: () => { paraCalls++; return genStream(['nope'], { operation: 'brain_paraphrase', text: 'nope' }); },
    generateDeepAnswer: () => { deepCalls++; return genStream(['The ', 'grounded ', 'answer.'],
      { operation: 'brain_deep_answer', text: 'The grounded answer.', inputTokens: 9, outputTokens: 9, quotedAt: 'q', firstChunkMs: 7, latencyMs: 99, startedAt: 2 }); },
  });
  orch.onUserTranscript('What is one practical fundraising tip?', 1);
  await tick();
  await orch.onTurnComplete();

  assert.equal(paraCalls, 0, 'paraphrase MUST NOT fire when disabled');
  assert.equal(deepCalls, 1, 'deep_answer fires as sole voice');
  assert.equal(legs.filter((l) => l.operation === 'brain_paraphrase').length, 0, 'no paraphrase cogs leg');
  assert.equal(legs.filter((l) => l.operation === 'brain_deep_answer').length, 1);
  assert.deepEqual(tts, ['The ', 'grounded ', 'answer.'], 'only deep-answer text reaches TTS — no hedge opener');
});

test('paraphrase OFF: trivial Q → deep_answer FIRES (not skipped), persona-only, retrieval still skipped', async () => {
  let deepCalls = 0;
  let retrieveCalls = 0;
  let deepEnvelope = 'UNSET';
  const { orch, legs } = harness({
    paraphraseEnabled: false,
    generateDeepAnswer: ({ referenceEnvelopeText }) => {
      deepCalls++; deepEnvelope = referenceEnvelopeText;
      return genStream(['Yes, ', 'loud and clear.'], { operation: 'brain_deep_answer', text: 'Yes, loud and clear.', firstChunkMs: 7 });
    },
    retrieve: async () => { retrieveCalls++; return 'should not be used'; },
  });
  orch.onUserTranscript('can you hear me?', 1);
  await tick();
  await orch.onTurnComplete();

  assert.equal(deepCalls, 1, 'deep_answer FIRES on trivial Q when paraphrase off (avoids dead silence)');
  assert.equal(retrieveCalls, 0, 'retrieval still skipped on trivial Q');
  assert.equal(deepEnvelope, null, 'deep answer runs persona-only (no reference envelope) on trivial Q');
  assert.equal(legs.filter((l) => l.operation === 'brain_paraphrase').length, 0, 'no paraphrase leg');
  assert.equal(legs.filter((l) => l.operation === 'brain_deep_answer').length, 1);
});

test('paraphrase OFF: trivial Q does NOT become lastCompleted (M3 — no retrieval-context pollution)', async () => {
  const { orch } = harness({
    paraphraseEnabled: false,
    generateDeepAnswer: () => genStream(['Yes, loud and clear.'], { operation: 'brain_deep_answer', text: 'Yes, loud and clear.', firstChunkMs: 7 }),
    retrieve: async () => null,
  });
  orch.onUserTranscript('hello hello', 1);
  await tick();
  await orch.onTurnComplete();
  assert.equal(orch.lastAssistantResponse(), null,
    'trivial deep answer is filler — must not feed next-turn retrieval context');
});

// ── Phase 3 audit C3 — tier + forceBrief plumbing into generateDeepAnswer ──
// This is the exact surface the audit C1 bug lived on: the orchestrator must
// forward its `tier` and `forceBrief: t.isTrivial` to generateDeepAnswer.
// Without this test, a regression (or a wrong tier source) ships silently.

test('Phase 3 C3: substantive GROUNDED turn forwards tier + forceBrief:false to generateDeepAnswer', async () => {
  let deepArgs = null;
  const { orch } = harness({
    paraphraseEnabled: false,
    tier: 'premium',
    generateDeepAnswer: (args) => { deepArgs = args; return genStream(['ok.'],
      { operation: 'brain_deep_answer', text: 'ok.', firstChunkMs: 7 }); },
    // Grounded turn: a real envelope → groundingState 'grounded' → not briefed.
    // (P0-3: an EMPTY retrieval on a substantive Q now correctly force-briefs the
    // hedge/clarifier — see the dedicated groundingState tests above.)
    retrieve: async () => '--- BEGIN REFERENCE a1b2c3 ---\nx\n--- END REFERENCE a1b2c3 ---',
  });
  orch.onUserTranscript('walk me through your first 1000 users', 1);
  await tick();
  await orch.onTurnComplete();
  assert.ok(deepArgs, 'generateDeepAnswer was called');
  assert.equal(deepArgs.tier, 'premium', 'session tier threads through');
  assert.equal(deepArgs.forceBrief, false, 'substantive grounded Q is not force-briefed');
  assert.equal(deepArgs.groundingState, 'grounded');
});

test('Phase 3 C3: trivial turn (paraphrase off) forwards forceBrief:true (M2 floor)', async () => {
  let deepArgs = null;
  const { orch } = harness({
    paraphraseEnabled: false,
    tier: 'premium',
    generateDeepAnswer: (args) => { deepArgs = args; return genStream(['Yep.'],
      { operation: 'brain_deep_answer', text: 'Yep.', firstChunkMs: 7 }); },
    retrieve: async () => null,
  });
  orch.onUserTranscript('hello hello', 1);
  await tick();
  await orch.onTurnComplete();
  assert.ok(deepArgs, 'generateDeepAnswer was called (paraphrase off → trivial falls through)');
  assert.equal(deepArgs.forceBrief, true, 'trivial Q force-briefs the deep answer');
});

test('Phase 3 C3: tier defaults to free when omitted (safe tighter budget)', async () => {
  let deepArgs = null;
  const { orch } = harness({
    paraphraseEnabled: false,
    // tier intentionally omitted → factory default 'free'
    generateDeepAnswer: (args) => { deepArgs = args; return genStream(['ok.'],
      { operation: 'brain_deep_answer', text: 'ok.', firstChunkMs: 7 }); },
    retrieve: async () => null,
  });
  orch.onUserTranscript('explain product-market fit', 1);
  await tick();
  await orch.onTurnComplete();
  assert.equal(deepArgs.tier, 'free', 'omitted tier → free (never the looser paid budget)');
});

// ── Re-audit C3 — looksLikeFollowUp deictic branch tightened ≤5 → ≤3 ─────

import { looksLikeFollowUp } from './decoupled-orchestrator.js';

test('re-audit C3: explicit continuation cues are follow-ups (intended B2 cases)', () => {
  for (const t of ['please continue', 'go on', 'tell me more', 'can you elaborate', 'go deeper', 'and then what']) {
    assert.equal(looksLikeFollowUp(t), true, `"${t}" is a follow-up`);
  }
});

test('re-audit C3: bare deictic ≤3 words are follow-ups', () => {
  for (const t of ['why?', 'how so?', 'and that?', 'why is that', 'what about it']) {
    assert.equal(looksLikeFollowUp(t), true, `"${t}" (≤3 deictic) is a follow-up`);
  }
});

test('re-audit C3: substantive ≥4-word questions are NOT follow-ups (the fixed false positives)', () => {
  // These each merely CONTAIN a wh/pronoun token but introduce a fresh topic.
  // Pre-fix (≤5) they wrongly threaded the prior answer + steered retrieval.
  for (const t of ['how do I start', 'why does this work', 'is it worth it', 'how about pricing strategy', 'what should I do next']) {
    assert.equal(looksLikeFollowUp(t), false, `"${t}" is a fresh question, not a follow-up`);
  }
});

test('re-audit C3: empty / whitespace → false', () => {
  for (const t of ['', '   ', null, undefined]) assert.equal(looksLikeFollowUp(t), false);
});

// ── Re-audit M3 — deep_answer_done fires ONLY on a turn that streamed audio ─

test('re-audit M3: onDeepAnswerDone fires once on a normal (audio-streamed) turn', async () => {
  let done = 0;
  const { orch } = harness({ paraphraseEnabled: false, onDeepAnswerDone: () => { done++; } });
  orch.onUserTranscript('what is the moat?', 1);
  await tick();
  await orch.onTurnComplete();
  assert.equal(done, 1, 'streamed audio → one flush signal');
});

test('re-audit M3: a degraded turn that streamed NO audio does NOT fire onDeepAnswerDone', async () => {
  let done = 0;
  const { orch } = harness({
    paraphraseEnabled: false,
    onDeepAnswerDone: () => { done++; },
    // throws before any delta (billed:false pre-dispatch-style) → degrade,
    // firstChunkMs stays null → deepStreamedAudio false → no flush signal.
    generateDeepAnswer: () => genThrow([], 'timeout', { billed: false }),
  });
  orch.onUserTranscript('what is the moat?', 1);
  await tick();
  await orch.onTurnComplete();
  assert.equal(done, 0, 'no audio streamed → nothing to flush → no signal');
});

test('re-audit M3: a barged turn does NOT fire onDeepAnswerDone', async () => {
  let done = 0;
  const { orch } = harness({
    paraphraseEnabled: false,
    onDeepAnswerDone: () => { done++; },
    generateDeepAnswer: (args) => genBargeable(['partial '], args.signal, { billed: false }),
  });
  orch.onUserTranscript('what is the moat?', 1);
  const tc = orch.onTurnComplete();
  await tick();
  orch.onInterrupted(); // barge mid-stream
  await tc;
  assert.equal(done, 0, 'barge suppresses the tail-flush signal (browser dropped the carry)');
});

// ── Re-audit C1/B1 (orchestrator side) — MAX_TOKENS metered + resume ────────

test('re-audit C1: a MAX_TOKENS deep answer increments deepTruncated + marks the turn for resume', async () => {
  let deepArgs = [];
  const { orch } = harness({
    paraphraseEnabled: false,
    generateDeepAnswer: (args) => {
      deepArgs.push(args);
      // turn 1 = cut at the cap; turn 2 = normal
      const cut = deepArgs.length === 1;
      return genStream(['a long answer'], {
        operation: 'brain_deep_answer', text: 'a long answer', firstChunkMs: 7, latencyMs: 9, startedAt: 2,
        finishReason: cut ? 'MAX_TOKENS' : 'STOP',
      });
    },
  });
  orch.onUserTranscript('tell me the whole boardroom story', 1);
  await tick();
  await orch.onTurnComplete();
  assert.equal(orch.metricsSnapshot().deepTruncated, 1, 'MAX_TOKENS counted (now visible)');

  // Follow-up turn: the prior (cut) answer must be threaded as truncated → resume.
  orch.onUserTranscript('continue', 2);
  await tick();
  await orch.onTurnComplete();
  // Unit 2 — the orchestrator now threads the RING (array, oldest→newest).
  assert.ok(Array.isArray(deepArgs[1].priorTurns), 'follow-up threads the prior-answer ring');
  assert.equal(deepArgs[1].priorTurns.length, 1, 'one completed turn → one ring entry');
  assert.equal(deepArgs[1].priorTurns[0].truncated, true, 'prior answer flagged truncated → preamble says RESUME');
});

// ── Unit 2 (MEMORY_BREADTH_PLAN) — continuity ring 1→3 ─────────────────────

test('U2: ring carries the last 3 completed turns, oldest first, capped at 3', async () => {
  const deepArgs = [];
  const { orch } = harness({
    paraphraseEnabled: false,
    generateDeepAnswer: (args) => {
      deepArgs.push(args);
      const n = deepArgs.length;
      return genStream([`answer-${n}`], {
        operation: 'brain_deep_answer', text: `answer-${n}`, firstChunkMs: 7, latencyMs: 9, startedAt: 2,
        finishReason: 'STOP',
      });
    },
  });
  // 4 substantive turns, then a follow-up — ring must hold answers 2,3,4.
  for (let i = 1; i <= 4; i++) {
    orch.onUserTranscript(`substantive question number ${i} about the work`, i);
    await tick();
    await orch.onTurnComplete();
  }
  orch.onUserTranscript('tell me more about that', 5);
  await tick();
  await orch.onTurnComplete();
  const ring = deepArgs[4].priorTurns;
  assert.ok(Array.isArray(ring), 'ring threaded on follow-up');
  assert.equal(ring.length, 3, 'capped at 3');
  assert.deepEqual(
    ring.map((r) => r.answer),
    ['answer-2', 'answer-3', 'answer-4'],
    'oldest→newest, turn-1 evicted',
  );
});

test('U2: non-follow-up question stays stateless (ring NOT threaded)', async () => {
  const deepArgs = [];
  const { orch } = harness({
    paraphraseEnabled: false,
    generateDeepAnswer: (args) => {
      deepArgs.push(args);
      return genStream(['ans'], {
        operation: 'brain_deep_answer', text: 'ans', firstChunkMs: 7, latencyMs: 9, startedAt: 2,
        finishReason: 'STOP',
      });
    },
  });
  orch.onUserTranscript('substantive question about discipline and identity', 1);
  await tick();
  await orch.onTurnComplete();
  orch.onUserTranscript('what is the best morning routine for energy', 2);
  await tick();
  await orch.onTurnComplete();
  assert.equal(deepArgs[1].priorTurns, null, 'fresh question → no ring');
});

// ── Unit 1a/1b (MEMORY_BREADTH_PLAN) — userContext + first-turn latch ───────

test('U1a: userContext threads to every deep answer; isFirstTurn true only until the first substantive completion', async () => {
  const deepArgs = [];
  const { orch } = harness({
    paraphraseEnabled: false,
    userContext: 'Goals: ship it.\n[OPEN THREAD] said he was stuck.',
    generateDeepAnswer: (args) => {
      deepArgs.push(args);
      return genStream(['ans'], {
        operation: 'brain_deep_answer', text: 'ans', firstChunkMs: 7, latencyMs: 9, startedAt: 2,
        finishReason: 'STOP',
      });
    },
  });
  orch.onUserTranscript('substantive question about identity and discipline', 1);
  await tick();
  await orch.onTurnComplete();
  orch.onUserTranscript('another substantive question about feedback loops', 2);
  await tick();
  await orch.onTurnComplete();
  assert.equal(deepArgs[0].userContext, 'Goals: ship it.\n[OPEN THREAD] said he was stuck.');
  assert.equal(deepArgs[0].isFirstTurn, true, 'turn 1 → check-in window open');
  assert.equal(deepArgs[1].userContext, deepArgs[0].userContext, 'context rides every turn');
  assert.equal(deepArgs[1].isFirstTurn, false, 'latch closed after first substantive answer');
});

test('U1a: omitted userContext defaults to null (byte-identical legacy)', async () => {
  const deepArgs = [];
  const { orch } = harness({
    paraphraseEnabled: false,
    generateDeepAnswer: (args) => {
      deepArgs.push(args);
      return genStream(['ans'], {
        operation: 'brain_deep_answer', text: 'ans', firstChunkMs: 7, latencyMs: 9, startedAt: 2,
        finishReason: 'STOP',
      });
    },
  });
  orch.onUserTranscript('substantive question about goals', 1);
  await tick();
  await orch.onTurnComplete();
  assert.equal(deepArgs[0].userContext, null);
});
