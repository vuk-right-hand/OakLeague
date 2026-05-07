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
import { GeminiBridge } from './gemini-bridge.js';

function makeBridgeWithStubSession() {
  const bridge = new GeminiBridge({ apiKey: 'test-key' });
  // Skip open() — install a stub session and flip _closed to false manually.
  bridge._session = { sendRealtimeInput: () => {}, close: () => {} };
  bridge._closed = false;
  return bridge;
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
