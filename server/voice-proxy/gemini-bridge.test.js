// Unit tests for GeminiBridge — Round-2 audit C3 regression guard.
//
// Gemini Live emits `usageMetadata.promptTokenCount` as a CUMULATIVE count of
// the entire conversation history (not a per-message delta). An earlier
// implementation summed metadata across every server message in a turn,
// inflating prompt tokens 5–10×. These tests lock in the fixed semantics:
// the bridge captures the LAST observed metadata in a turn, overwriting
// earlier partial values.
//
// Run: cd server/voice-proxy && node --test gemini-bridge.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiBridge, parseGoAwayTimeLeftMs } from './gemini-bridge.js';

function makeBridgeWithStubSession(opts = {}) {
  const bridge = new GeminiBridge({ apiKey: 'test-key', ...opts });
  // Skip open() — install a stub session and flip _closed to false manually.
  bridge._session = { sendRealtimeInput: () => {}, close: () => {} };
  bridge._closed = false;
  return bridge;
}
// D-GoAway is HARD-GATED to decoupled (audit C1) — the proactive
// reopen tests must construct the decoupled bridge.
function makeDecoupledBridge() {
  return makeBridgeWithStubSession({ decoupled: true });
}

test('C3: usageMetadata captures LAST value, not sum across messages', () => {
  const bridge = makeBridgeWithStubSession();
  bridge.turnStart();

  // Simulate three server messages within one turn. Gemini emits running
  // cumulative counts — promptTokenCount grows across messages even though
  // the "prompt" hasn't changed in this turn.
  bridge._onMessage({
    usageMetadata: { promptTokenCount: 100, responseTokenCount: 10, totalTokenCount: 110 },
  });
  bridge._onMessage({
    usageMetadata: { promptTokenCount: 100, responseTokenCount: 25, totalTokenCount: 125 },
  });
  bridge._onMessage({
    usageMetadata: { promptTokenCount: 100, responseTokenCount: 42, totalTokenCount: 142 },
  });

  const usage = bridge._currentTurnUsage;
  assert.ok(usage, 'usage metadata must be captured');
  assert.equal(usage.promptTokenCount, 100, 'prompt must equal last value, not 300');
  assert.equal(usage.responseTokenCount, 42, 'response must equal last value, not 77');
  assert.equal(usage.totalTokenCount, 142, 'total must equal last value, not 377');
});

test('C3: turnStart resets usageMetadata between turns', () => {
  const bridge = makeBridgeWithStubSession();

  bridge.turnStart();
  bridge._onMessage({
    usageMetadata: { promptTokenCount: 50, responseTokenCount: 5, totalTokenCount: 55 },
  });
  assert.ok(bridge._currentTurnUsage, 'turn 1 should have usage');

  bridge.turnStart();
  assert.equal(bridge._currentTurnUsage, null, 'turn 2 start must clear prior usage');

  bridge._onMessage({
    usageMetadata: { promptTokenCount: 200, responseTokenCount: 15, totalTokenCount: 215 },
  });
  assert.equal(bridge._currentTurnUsage.promptTokenCount, 200,
    'turn 2 must reflect its own metadata only');
});

test('C3: missing count fields coerce to null, not 0', () => {
  // A partial message might omit one field. We must preserve null so COGS
  // downstream can distinguish "unknown" from "zero" — zero on promptTokens
  // would wrongly read as "no history" and mis-price.
  const bridge = makeBridgeWithStubSession();
  bridge.turnStart();

  bridge._onMessage({
    usageMetadata: { totalTokenCount: 50 }, // prompt + response missing
  });
  assert.equal(bridge._currentTurnUsage.promptTokenCount, null);
  assert.equal(bridge._currentTurnUsage.responseTokenCount, null);
  assert.equal(bridge._currentTurnUsage.totalTokenCount, 50);
});

test('C3: no usageMetadata in any message → _currentTurnUsage stays null', () => {
  const bridge = makeBridgeWithStubSession();
  bridge.turnStart();

  // Simulate a real audio frame (non-empty base64) with NO usageMetadata. The
  // prior version of this test passed `data: ''`, which short-circuited the
  // `mime.startsWith('audio/pcm') && b64` branch — so no audio was actually
  // emitted and the assertion proved nothing beyond "the message parser
  // didn't crash." Feed real bytes so we exercise the audio path + the
  // absence-of-metadata path together.
  const audioB64 = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64');
  const audioEvents = [];
  const off = bridge.on((e) => { if (e.kind === 'audio_out') audioEvents.push(e); });

  bridge._onMessage({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: audioB64 } }] },
    },
  });

  assert.equal(audioEvents.length, 1, 'audio_out must fire so the test actually exercises the audio branch');
  assert.equal(bridge._currentTurnUsage, null,
    'missing metadata must stay null so downstream can distinguish from real zeros');
  off();
});

// ── Pipeline α' upgrade tests ───────────────────────────────────────────

import { OUTPUT_TRANSCRIPT_MAX_CHARS } from './gemini-bridge.js';

function makeAlphaBridge({ discardAudioOut = false } = {}) {
  const b = new GeminiBridge({
    apiKey: 'test-key',
    enableOutputTranscription: true,
    discardAudioOut,
  });
  b._session = { sendRealtimeInput: () => {}, close: () => {} };
  b._closed = false;
  return b;
}

test("α': outputTranscription chunks fire output_transcription_chunk events + accumulate", () => {
  const bridge = makeAlphaBridge();
  bridge.turnStart();
  const events = [];
  const off = bridge.on((e) => events.push(e));

  bridge._onMessage({ serverContent: { outputTranscription: { text: 'Hello,' } } });
  bridge._onMessage({ serverContent: { outputTranscription: { text: ' world.' } } });

  const chunks = events.filter((e) => e.kind === 'output_transcription_chunk');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, 'Hello,');
  assert.equal(chunks[1].text, ' world.');
  assert.equal(bridge._currentTurnOutputTranscript, 'Hello, world.');
  off();
});

test("α': transcript_runaway fires once at the cap and further chunks are dropped", () => {
  const bridge = makeAlphaBridge();
  bridge.turnStart();
  const events = [];
  const off = bridge.on((e) => events.push(e));

  // Push exactly to the cap, then one more chunk that must be ignored.
  const big = 'x'.repeat(OUTPUT_TRANSCRIPT_MAX_CHARS);
  bridge._onMessage({ serverContent: { outputTranscription: { text: big } } });
  bridge._onMessage({ serverContent: { outputTranscription: { text: 'overflow' } } });
  bridge._onMessage({ serverContent: { outputTranscription: { text: 'overflow2' } } });

  const runaway = events.filter((e) => e.kind === 'transcript_runaway');
  assert.equal(runaway.length, 1, 'runaway must fire exactly once per turn');
  assert.equal(runaway[0].characterCount, OUTPUT_TRANSCRIPT_MAX_CHARS);
  assert.equal(bridge._currentTurnOutputTranscript.length, OUTPUT_TRANSCRIPT_MAX_CHARS);
  off();
});

test("α': discardAudioOut skips audio_out events but still tracks output bytes", () => {
  const bridge = makeAlphaBridge({ discardAudioOut: true });
  bridge.turnStart();
  const events = [];
  const off = bridge.on((e) => events.push(e));

  // 4 bytes of base64 → ~3 bytes (0.75 ratio).
  bridge._onMessage({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] },
    },
  });

  const audio = events.filter((e) => e.kind === 'audio_out');
  assert.equal(audio.length, 0, 'discardAudioOut must suppress audio_out emission');
  assert.equal(bridge._currentTurnOutputBytes, 3, 'byte counter still increments for cogs leg-2');
  off();
});

test("α': turnStart resets transcript + runaway state between turns", () => {
  const bridge = makeAlphaBridge();
  bridge.turnStart();
  bridge._currentTurnOutputTranscript = 'leftover';
  bridge._currentTurnRunawayFired = true;
  bridge.turnStart();
  assert.equal(bridge._currentTurnOutputTranscript, '');
  assert.equal(bridge._currentTurnRunawayFired, false);
});

test("α': bridge without enableOutputTranscription ignores outputTranscription text", () => {
  const bridge = new GeminiBridge({ apiKey: 'test-key' });
  bridge._session = { sendRealtimeInput: () => {}, close: () => {} };
  bridge._closed = false;
  bridge.turnStart();
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage({ serverContent: { outputTranscription: { text: 'should be dropped' } } });
  assert.equal(events.filter((e) => e.kind === 'output_transcription_chunk').length, 0);
  assert.equal(bridge._currentTurnOutputTranscript, '');
  off();
});

test('sessionResume: stores newHandle from sessionResumptionUpdate', () => {
  const bridge = makeBridgeWithStubSession();
  assert.equal(bridge._sessionResumeHandle, null, 'starts null');
  bridge._onMessage({ sessionResumptionUpdate: { newHandle: 'handle-1', resumable: true } });
  assert.equal(bridge._sessionResumeHandle, 'handle-1');
  // Subsequent updates overwrite (only freshest is kept).
  bridge._onMessage({ sessionResumptionUpdate: { newHandle: 'handle-2', resumable: true } });
  assert.equal(bridge._sessionResumeHandle, 'handle-2');
});

test('sessionResume: ignores empty / non-string newHandle', () => {
  const bridge = makeBridgeWithStubSession();
  bridge._sessionResumeHandle = 'preserved';
  bridge._onMessage({ sessionResumptionUpdate: { newHandle: '' } });
  assert.equal(bridge._sessionResumeHandle, 'preserved');
  bridge._onMessage({ sessionResumptionUpdate: { newHandle: null } });
  assert.equal(bridge._sessionResumeHandle, 'preserved');
  bridge._onMessage({ sessionResumptionUpdate: {} });
  assert.equal(bridge._sessionResumeHandle, 'preserved');
});

// ── D-GoAway (DECOUPLED_BRAIN_PLAN P1-6 + audit C1-C4/M1-M5/Smalls) ──────

const nextTick = () => new Promise((r) => setImmediate(r));

test('parseGoAwayTimeLeftMs: forms, realistic 59s, negatives, M3 ms-clamp', () => {
  assert.equal(parseGoAwayTimeLeftMs('10s'), 10000);
  assert.equal(parseGoAwayTimeLeftMs('9.5s'), 9500);
  assert.equal(parseGoAwayTimeLeftMs('59s'), 59000);       // realistic GoAway window
  assert.equal(parseGoAwayTimeLeftMs('600'), 600000);      // no trailing s
  assert.equal(parseGoAwayTimeLeftMs(30), 30000);          // number = seconds (Duration)
  assert.equal(parseGoAwayTimeLeftMs({ seconds: 12, nanos: 500000000 }), 12500);
  assert.equal(parseGoAwayTimeLeftMs({ seconds: 7 }), 7000);
  // garbage / missing → conservative default (never a huge trusted window)
  assert.equal(parseGoAwayTimeLeftMs(null), 8000);
  assert.equal(parseGoAwayTimeLeftMs('not-a-duration'), 8000);
  assert.equal(parseGoAwayTimeLeftMs(undefined), 8000);
  // Audit Small — a negative duration must NOT collapse to 0 (⇒ instant
  // mid-utterance reopen). Falls back to the conservative default.
  assert.equal(parseGoAwayTimeLeftMs('-5s'), 8000);
  assert.equal(parseGoAwayTimeLeftMs(-3), 8000);
  assert.equal(parseGoAwayTimeLeftMs({ seconds: -10 }), 8000);
  // Audit NEW-S2 — a PRESENT but non-finite field is garbage: don't
  // drop a bad `seconds` and trust `nanos` alone (tiny ms ⇒ instant
  // mid-utterance deadline). Unparseable → conservative fallback.
  assert.equal(parseGoAwayTimeLeftMs({ seconds: 'abc', nanos: 500000000 }), 8000);
  assert.equal(parseGoAwayTimeLeftMs({ seconds: 5, nanos: 'xyz' }), 8000);
  // Audit M3 — if the SDK ever surfaces ms (60000) the seconds-assumption
  // yields 60_000_000ms (>20min) — implausible ⇒ fall back, NOT an
  // effectively-never-firing timer that lets the server ABORT.
  assert.equal(parseGoAwayTimeLeftMs(60000), 8000);
  assert.equal(parseGoAwayTimeLeftMs('99999s'), 8000);     // 99999s > 20min cap
});

// Audit C1 — D-GoAway is HARD-GATED to decoupled. The legacy/coupled
// path (default constructor) must be byte-identical pre-P1-6: a goAway
// is a complete no-op (no event, no timer, no pending) so the persona +
// 60KB prefix re-seed never rides an un-audited proactive bounce.
test('C1: legacy bridge ignores goAway entirely (byte-identical pre-P1-6)', () => {
  const bridge = makeBridgeWithStubSession();        // decoupled:false
  const events = [];
  bridge.on((e) => events.push(e));
  bridge._onMessage({ goAway: { timeLeft: '600s' } });
  assert.equal(events.find((e) => e.kind === 'go_away'), undefined, 'no go_away on legacy');
  assert.equal(bridge._goAwayPending, false);
  assert.equal(bridge._goAwayTimer, null);
  bridge._onMessage({ serverContent: { turnComplete: true } });
  // no proactive reopen scheduled
  assert.equal(events.some((e) => e.kind === 'go_away_reopen'), false);
});

test('goAway → emits go_away, sets pending, arms fallback timer (NOT unref — M4)', () => {
  const bridge = makeDecoupledBridge();
  const events = [];
  bridge.on((e) => events.push(e));
  bridge._onMessage({ goAway: { timeLeft: '600s' } });
  const ga = events.find((e) => e.kind === 'go_away');
  assert.ok(ga, 'go_away event emitted');
  assert.equal(ga.timeLeftMs, 600000);
  assert.equal(ga.deadlineInMs, 598000);            // 600000 - 2000 margin
  assert.equal(bridge._goAwayPending, true);
  assert.ok(bridge._goAwayTimer, 'fallback timer armed');
  // Audit M4 — the UX-critical deadline timer must NOT be unref'd
  // (event-loop load must not deprioritize the only thing between the
  // user and a server ABORTED).
  assert.equal(typeof bridge._goAwayTimer.hasRef === 'function'
    ? bridge._goAwayTimer.hasRef() : true, true, 'fallback timer keeps a ref');
  clearTimeout(bridge._goAwayTimer);
});

test('goAway then turn_complete → proactive reopen at the VAD-silence boundary', async () => {
  const bridge = makeDecoupledBridge();
  const events = [];
  bridge.on((e) => events.push(e));
  let reopenCalls = 0;
  bridge.reopen = async () => { reopenCalls += 1; bridge._closed = false; };

  bridge._onMessage({ goAway: { timeLeft: '600s' } });
  bridge._onMessage({ serverContent: { turnComplete: true } });
  // turn_complete must be emitted BEFORE the reopen is scheduled
  assert.ok(events.some((e) => e.kind === 'turn_complete'));
  await nextTick();            // setImmediate(_proactiveReopen)
  await nextTick();            // _proactiveReopen's internal setImmediate
  await nextTick();
  assert.equal(reopenCalls, 1, 'reopened exactly once');
  assert.equal(bridge._goAwayPending, false, 'pending cleared');
  assert.equal(bridge._goAwayTimer, null, 'fallback timer cleared');
  const phases = events.filter((e) => e.kind === 'go_away_reopen').map((e) => e.phase);
  assert.deepEqual(phases, ['start', 'ok']);
});

// Audit C2 — the fallback timer must NEVER force-close while an
// utterance is in flight (3.1 Live emits inputTranscription once at
// end-of-utterance → a force-close destroys the entire question). It
// re-arms a short grace and the clean vad_silence reopen takes over.
test('C2: deadline defers while utterance in flight, then clean vad_silence reopen', async () => {
  const bridge = makeDecoupledBridge();
  const events = [];
  bridge.on((e) => events.push(e));
  let reopenReason = null;
  bridge.reopen = async () => { bridge._closed = false; };
  bridge.on((e) => { if (e.kind === 'go_away_reopen' && e.phase === 'start') reopenReason = e.reason; });

  bridge.turnStart();                                // utterance opens
  assert.equal(bridge._utteranceInFlight, true);
  bridge._onMessage({ goAway: { timeLeft: '0.05s' } }); // fallbackMs → 0
  await new Promise((r) => setTimeout(r, 10));        // deadline timer fires
  // It must have RE-ARMED, not force-closed: no reopen yet.
  assert.equal(reopenReason, null, 'no force-close mid-utterance');
  assert.equal(bridge._goAwayDeadlineRetries, 1, 're-armed once');
  assert.ok(bridge._goAwayTimer, 'grace timer re-armed');
  // turn_complete closes the utterance window → clean proactive bounce.
  bridge._onMessage({ serverContent: { turnComplete: true } });
  assert.equal(bridge._utteranceInFlight, false);
  await nextTick(); await nextTick(); await nextTick();
  assert.equal(reopenReason, 'vad_silence', 'reopen deferred to the safe boundary');
  assert.ok(events.some((e) => e.kind === 'go_away_reopen' && e.phase === 'ok'));
});

test('goAway idempotent: two goAway + one turn_complete → ONE reopen', async () => {
  const bridge = makeDecoupledBridge();
  let reopenCalls = 0;
  bridge.reopen = async () => { reopenCalls += 1; bridge._closed = false; };
  bridge._onMessage({ goAway: { timeLeft: '600s' } });
  bridge._onMessage({ goAway: { timeLeft: '300s' } }); // refreshes, still one pending
  bridge._onMessage({ serverContent: { turnComplete: true } });
  await nextTick(); await nextTick(); await nextTick();
  assert.equal(reopenCalls, 1);
});

test('goAway fallback timer fires the reopen when NO turn_complete arrives', async () => {
  const bridge = makeDecoupledBridge();
  const events = [];
  bridge.on((e) => events.push(e));
  let reason = null;
  bridge.reopen = async () => { bridge._closed = false; };
  bridge.on((e) => { if (e.kind === 'go_away_reopen' && e.phase === 'start') reason = e.reason; });
  // tiny timeLeft → fallbackMs = max(0, 30 - 2000) = 0; NO utterance in
  // flight → fires immediately (no re-arm).
  bridge._onMessage({ goAway: { timeLeft: '0.03s' } });
  await new Promise((r) => setTimeout(r, 30));
  await nextTick(); await nextTick();
  assert.equal(reason, 'deadline', 'reopen driven by the hard fallback timer');
  assert.ok(events.some((e) => e.kind === 'go_away_reopen' && e.phase === 'ok'));
});

test('reopen failure → go_away_reopen:fail (proxy tears down)', async () => {
  const bridge = makeDecoupledBridge();
  const events = [];
  bridge.on((e) => events.push(e));
  bridge.reopen = async () => { throw new Error('handle_rejected'); };
  bridge._onMessage({ goAway: { timeLeft: '600s' } });
  bridge._onMessage({ serverContent: { turnComplete: true } });
  await nextTick(); await nextTick(); await nextTick();
  const fail = events.find((e) => e.kind === 'go_away_reopen' && e.phase === 'fail');
  assert.ok(fail, 'fail event emitted so the proxy can tear down');
  assert.match(fail.message, /handle_rejected/);
  assert.equal(bridge._goAwayReopenInFlight, false, 'flag reset in finally even on failure');
});

// Audit M5 — a user-close DURING the bounce makes reopen() throw
// `bridge_user_closed`. That is an EXPECTED abort, not a failure: emit
// a distinct non-error phase so the proxy does NOT captureException /
// send upstream_closed / fire a racing teardown.
test('M5: user-close mid-bounce → aborted_user_closed, NOT fail', async () => {
  const bridge = makeDecoupledBridge();
  const events = [];
  bridge.on((e) => events.push(e));
  bridge.reopen = async () => { bridge._userClosed = true; throw new Error('bridge_user_closed'); };
  await bridge._proactiveReopen('deadline');
  const phases = events.filter((e) => e.kind === 'go_away_reopen').map((e) => e.phase);
  assert.deepEqual(phases, ['start', 'aborted_user_closed']);
  assert.equal(events.some((e) => e.phase === 'fail'), false, 'no fail phase on user-close');
});

test('close() during a pending goAway kills the timer and refuses reopen', async () => {
  const bridge = makeDecoupledBridge();
  let reopenCalls = 0;
  bridge.reopen = async () => { reopenCalls += 1; };
  bridge._onMessage({ goAway: { timeLeft: '600s' } });
  await bridge.close();
  assert.equal(bridge._goAwayTimer, null, 'goAway timer cleared on user close');
  assert.equal(bridge._goAwayPending, false);
  assert.equal(bridge._utteranceInFlight, false);
  // a turn_complete after user-close must NOT resurrect via proactive reopen
  bridge._onMessage({ serverContent: { turnComplete: true } });
  await nextTick(); await nextTick();
  assert.equal(reopenCalls, 0, '_proactiveReopen refuses after _userClosed');
});

// ── C3 — session-generation guard (extracted _onSessionClose seam) ──────

test('C3: a STALE old-session close is a hard no-op (cannot tear down new session)', () => {
  const bridge = makeDecoupledBridge();
  const events = [];
  bridge.on((e) => events.push(e));
  bridge._sessionGen = 5;                 // a newer session is live
  bridge._closed = false;
  // The OLD session (gen 3) finally delivers its close — non-1000.
  bridge._onSessionClose(3, { code: 1006, reason: 'abnormal' });
  assert.equal(bridge._closed, false, 'stale close must NOT clobber live _closed');
  assert.equal(events.some((e) => e.kind === 'closed'), false, 'no phantom closed event');
});

test('C3: current-gen close still emits closed (real upstream failure surfaces)', () => {
  const bridge = makeDecoupledBridge();
  const events = [];
  bridge.on((e) => events.push(e));
  bridge._sessionGen = 5;
  bridge._onSessionClose(5, { code: 1006, reason: 'abnormal' });
  assert.equal(bridge._closed, true);
  const closed = events.find((e) => e.kind === 'closed');
  assert.ok(closed && closed.code === 1006, 'real close surfaces for teardown');
});

// Audit M2 — a REAL upstream close while a goAway is pending must cancel
// the proactive timer so the reactive path owns the reopen (no double
// ai.live.connect + handle replay).
test('M2: real close while goAway pending cancels the proactive timer', () => {
  const bridge = makeDecoupledBridge();
  bridge._sessionGen = 2;
  bridge._onMessage({ goAway: { timeLeft: '600s' } });
  assert.equal(bridge._goAwayPending, true);
  assert.ok(bridge._goAwayTimer);
  bridge._onSessionClose(2, { code: 1000 });   // js-genai#707 1000-close
  assert.equal(bridge._goAwayPending, false, 'goAway state cleared');
  assert.equal(bridge._goAwayTimer, null, 'proactive timer cancelled — reactive path owns it');
});

// ── C4 — _proactiveReopen must NOT blank the prior turn's billing ──────

test('C4: _proactiveReopen preserves _currentTurnUsage (kill-switch intact)', async () => {
  const bridge = makeDecoupledBridge();
  bridge.reopen = async () => { bridge._closed = false; };
  bridge._currentTurnUsage = { promptTokenCount: 123, responseTokenCount: 45, totalTokenCount: 168 };
  bridge._currentTurnReceivedContent = true;
  await bridge._proactiveReopen('vad_silence');
  assert.deepEqual(bridge._currentTurnUsage,
    { promptTokenCount: 123, responseTokenCount: 45, totalTokenCount: 168 },
    'server-authoritative usage for a still-billing turn must survive the bounce');
});

// ── M1 — reopen() reentrancy coalescing (no double ai.live.connect) ────

test('M1: concurrent reopen() calls coalesce to a SINGLE open()', async () => {
  const bridge = makeDecoupledBridge();
  bridge._userClosed = false;
  bridge._lastOpenArgs = { model: 'm', sessionId: 's' };
  bridge._closed = true;
  let openCalls = 0;
  bridge.open = async () => {
    openCalls += 1;
    await new Promise((r) => setTimeout(r, 20));
    bridge._closed = false;
  };
  // Proactive bounce + proxy lazy-reopen both call reopen() concurrently.
  await Promise.all([bridge.reopen(), bridge.reopen(), bridge.reopen()]);
  assert.equal(openCalls, 1, 'all concurrent callers share ONE open()');
  assert.equal(bridge._reopenInFlight, null, 'in-flight promise cleared after settle');
});

// ── Round-2 re-audit fixes (NEW-M1..M4) ─────────────────────────────────

// NEW-M1 — barge-in / supersede ends the utterance with NO turn_complete.
// If _utteranceInFlight stays true, a pending goAway deadline re-arms 3×
// against a phantom utterance, burning the grace while the real cap
// elapses → server ABORT (the exact failure C2 prevents).
test('NEW-M1: interrupted (barge) clears _utteranceInFlight → deadline does NOT re-arm against a phantom', async () => {
  const bridge = makeDecoupledBridge();
  let reopenReason = null;
  bridge.reopen = async () => { bridge._closed = false; };
  bridge.on((e) => { if (e.kind === 'go_away_reopen' && e.phase === 'start') reopenReason = e.reason; });

  bridge.turnStart();
  assert.equal(bridge._utteranceInFlight, true);
  bridge._onMessage({ serverContent: { interrupted: true } });   // user barged
  assert.equal(bridge._utteranceInFlight, false, 'barge ended the utterance window');
  bridge._onMessage({ goAway: { timeLeft: '0.03s' } });          // fallbackMs → 0
  await new Promise((r) => setTimeout(r, 20));
  await nextTick(); await nextTick();
  // No phantom utterance ⇒ deadline force-reopens immediately (no re-arm).
  assert.equal(bridge._goAwayDeadlineRetries, 0, 'did NOT re-arm against a phantom');
  assert.equal(reopenReason, 'deadline', 'clean force-reopen, not 3× grace burn');
});

// NEW-M2 — a refreshing goAway (server re-warns near the cap) must NOT
// reset the bounded 3-retry counter, else the C2 bound is defeated.
test('NEW-M2: a refreshing goAway does NOT reset _goAwayDeadlineRetries', () => {
  const bridge = makeDecoupledBridge();
  bridge.turnStart();                                  // utterance in flight
  bridge._onMessage({ goAway: { timeLeft: '600s' } }); // first goAway of window
  assert.equal(bridge._goAwayPending, true);
  bridge._goAwayDeadlineRetries = 2;                    // simulate two re-arms used
  bridge._onMessage({ goAway: { timeLeft: '300s' } }); // server re-warns (refresh)
  assert.equal(bridge._goAwayDeadlineRetries, 2, 'refresh must NOT reset the bound');
  clearTimeout(bridge._goAwayTimer);
});

// NEW-M3 — the bounce ends the utterance window; leaving the flag true
// makes the NEXT goAway on the resumed session defer against a phantom.
test('NEW-M3: _proactiveReopen clears _utteranceInFlight', async () => {
  const bridge = makeDecoupledBridge();
  bridge.reopen = async () => { bridge._closed = false; };
  bridge.turnStart();
  assert.equal(bridge._utteranceInFlight, true);
  await bridge._proactiveReopen('deadline');
  assert.equal(bridge._utteranceInFlight, false, 'bounce abandons the utterance window');
});

// NEW-M4 — north star: an error inside the goAway window with a valid
// resumption handle must ATTEMPT the handle reopen, not guarantee
// teardown. _proactiveReopen fails cleanly if the handle is dead.
test('NEW-M4: error during goAway window with a handle → attempts resumption reopen (not fatal)', async () => {
  const bridge = makeDecoupledBridge();
  const events = [];
  bridge.on((e) => events.push(e));
  let reopened = false;
  bridge.reopen = async () => { reopened = true; bridge._closed = false; };
  bridge._sessionResumeHandle = 'h-123';
  bridge._sessionGen = 1;
  bridge._onMessage({ goAway: { timeLeft: '600s' } });   // goAway pending
  bridge._onSessionError(1, { message: 'ws blip' });      // current-gen error
  await nextTick(); await nextTick(); await nextTick();
  assert.equal(reopened, true, 'attempted the resumption-handle reopen');
  assert.equal(events.some((e) => e.kind === 'error' && e.fatal), false,
    'did NOT emit a fatal error — recovery preferred over teardown');
  assert.ok(events.some((e) => e.kind === 'go_away_reopen' && e.reason === 'error'));
});

test('NEW-M4: error with NO handle / not decoupled still emits fatal (unchanged)', () => {
  const legacy = makeBridgeWithStubSession();             // decoupled:false
  const events = [];
  legacy.on((e) => events.push(e));
  legacy._sessionGen = 1;
  legacy._onSessionError(1, { message: 'boom' });
  assert.ok(events.some((e) => e.kind === 'error' && e.fatal),
    'legacy/coupled path emits fatal exactly as pre-P1-6');
});
