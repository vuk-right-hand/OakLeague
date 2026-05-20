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
  assert.deepEqual(tts, ['Let me ', 'think...']);
  const tc = orch.onTurnComplete();
  await tick();
  assert.deepEqual(tts, ['Let me ', 'think...'], 'no deep chunk while paraphrase unfinished');
  rel.resolve();
  await tc;
  assert.deepEqual(tts, ['Let me ', 'think...', 'The ', 'grounded ', 'answer.']);
  assert.equal(orch.lastAssistantResponse(), 'The grounded answer.');
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
  // Deep answer has streamed its deltas but not its terminal {final}.
  assert.deepEqual(tts, ['Let me ', 'think...', 'The ', 'answer.']);
  let spokenResolved = false;
  const sp = orch.awaitTurnSpoken(10_000).then(() => { spokenResolved = true; });
  await tick();
  assert.equal(spokenResolved, false,
    'turn_end MUST NOT proceed to ttsBridge.turnEnd() — deep answer not yet final');
  deepGate.resolve();          // deep answer completes
  await sp;
  assert.equal(spokenResolved, true, 'now safe to send continue:false');
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
