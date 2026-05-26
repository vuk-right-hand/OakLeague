// CartesiaTTSBridge unit tests. Skips the open() handshake by stubbing
// `_ws` directly; the live API is exercised separately by
// scripts/cartesia-phase0-rerun.mjs and the Phase-6 smoke test.
//
// Run: cd server/voice-proxy && node --test cartesia-bridge.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CartesiaTTSBridge } from './cartesia-bridge.js';

function makeStubBridge() {
  const sent = [];
  const ws = {
    readyState: 1, // OPEN
    send: (s) => { sent.push(JSON.parse(s)); },
    close: () => {},
    terminate: () => {},
  };
  const bridge = new CartesiaTTSBridge({
    apiKey: 'k',
    voiceId: 'voice-uuid-abc',
  });
  bridge._ws = ws;
  bridge._closed = false;
  return { bridge, sent };
}

test('every sendText emits the full Cartesia config block (pipecat pattern)', () => {
  // 2026-05-04: Cartesia rejects continuations that omit voice/model_id/
  // output_format with "neither embedding nor ID provided". Reference
  // implementation (pipecat services/cartesia/tts.py) sends the full
  // block on every WS message; we follow that pattern.
  const { bridge, sent } = makeStubBridge();
  bridge.turnStart('sess-1:1');
  bridge.sendText('Hello,');
  bridge.sendText(' world.');

  assert.equal(sent.length, 2);
  for (const m of sent) {
    assert.equal(m.model_id, 'sonic-3');
    assert.deepEqual(m.voice, { mode: 'id', id: 'voice-uuid-abc' });
    assert.equal(m.output_format.encoding, 'pcm_s16le');
    assert.equal(m.output_format.sample_rate, 24000);
    assert.equal(m.continue, true);
    assert.equal(m.context_id, 'sess-1:1');
  }
  assert.equal(sent[0].transcript, 'Hello,');
  assert.equal(sent[1].transcript, ' world.');
});

test('inbound chunk emits decoded audio_out with PCM bytes', async () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('sess-1:1');
  // First send so chars/audio counters initialize fairly.
  bridge.sendText('hi');
  const events = [];
  const off = bridge.on((e) => events.push(e));

  // 4 bytes of base64 → 3 bytes PCM.
  bridge._onMessage(JSON.stringify({ type: 'chunk', data: 'AAAA', context_id: 'sess-1:1' }), false);
  const audio = events.filter((e) => e.kind === 'audio_out');
  assert.equal(audio.length, 1);
  assert.equal(audio[0].chunk.bytes.length, 3);
  assert.equal(audio[0].chunk.mimeType, 'audio/pcm;rate=24000');
  assert.equal(audio[0].contextId, 'sess-1:1');
  assert.equal(bridge._audioBytesThisTurn, 3);
  off();
});

// ── P1-10 spurious-barge fix — getLastChunkAt() instrumentation ──────────
//
// The proxy's `interrupted` event handler reads this getter to suppress
// spurious Gemini Live interrupted events (Gemini's audio-gen timeline is
// independent of Cartesia playback in decoupled mode). These tests lock
// the invariants the heuristic depends on.

test('P1-10: getLastChunkAt is 0 before any chunk arrives', () => {
  const { bridge } = makeStubBridge();
  assert.equal(bridge.getLastChunkAt(), 0,
    'fresh bridge has no chunks yet → 0 (idleMs computed as Infinity by index.js)');
  bridge.turnStart('sess-1:1');
  assert.equal(bridge.getLastChunkAt(), 0,
    'after turnStart, still no chunk arrived → 0');
});

test('P1-10: getLastChunkAt advances on each inbound audio chunk', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('sess-1:1');
  bridge.sendText('hi');

  const t0 = bridge.getLastChunkAt();
  bridge._onMessage(JSON.stringify({ type: 'chunk', data: 'AAAA', context_id: 'sess-1:1' }), false);
  const t1 = bridge.getLastChunkAt();
  assert.ok(t1 > 0, 'first chunk sets a timestamp');
  assert.ok(t1 >= t0, 'timestamp is monotonic');

  // Second chunk advances again.
  bridge._onMessage(JSON.stringify({ type: 'chunk', data: 'AAAA', context_id: 'sess-1:1' }), false);
  const t2 = bridge.getLastChunkAt();
  assert.ok(t2 >= t1, 'second chunk does not regress timestamp');
});

test('P1-10 audit C1: turnStart resets getLastChunkAt back to 0', () => {
  // Without this reset, turn N+1's spurious-barge heuristic mis-classifies
  // pre-playback interrupted events against turn N's stale timestamp.
  const { bridge } = makeStubBridge();
  bridge.turnStart('sess-1:1');
  bridge.sendText('hi');
  bridge._onMessage(JSON.stringify({ type: 'chunk', data: 'AAAA', context_id: 'sess-1:1' }), false);
  assert.ok(bridge.getLastChunkAt() > 0, 'turn 1: chunk recorded');

  bridge.turnStart('sess-1:2');
  assert.equal(bridge.getLastChunkAt(), 0,
    'audit C1: turnStart MUST reset the timestamp to 0 (idleMs = Infinity until first chunk of new turn)');
});

test('P1-10: chunks for a non-current context_id do NOT advance getLastChunkAt', () => {
  // Stale/cancelled-context chunks (Cartesia keeps emitting for ~50ms
  // after cancel) shouldn't make the heuristic think audio is playing.
  const { bridge } = makeStubBridge();
  bridge.turnStart('sess-1:1');
  bridge.sendText('hi');
  bridge.cancel(); // nulls _currentContextId
  assert.equal(bridge._currentContextId, null);

  // Leaked chunk for the cancelled context.
  bridge._onMessage(JSON.stringify({ type: 'chunk', data: 'AAAA', context_id: 'sess-1:1' }), false);
  assert.equal(bridge.getLastChunkAt(), 0,
    'post-cancel leaked chunks must not advance lastChunkAt');
});

test('inbound error maps voice_not_found → bad_voice_id with fatal flag', () => {
  const { bridge } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage(JSON.stringify({
    type: 'error',
    error_code: 'voice_not_found',
    title: 'Voice not found',
    message: 'no such voice',
    status_code: 404,
  }), false);
  const errs = events.filter((e) => e.kind === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'bad_voice_id');
  assert.equal(errs[0].fatal, true);
  off();
});

test('inbound error "Invalid transcript" is recoverable: fatal=false, turnDead, contextId nulled, textSample included', () => {
  const { bridge, sent } = makeStubBridge();
  bridge.turnStart('sess-1:1');
  // Stream some text so the bridge captures a sample for the eventual error.
  bridge.sendText('Hello world this is a test transcript');
  // Sanity: WS open, sendText went through.
  assert.equal(sent.length, 1);
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage(JSON.stringify({
    type: 'error',
    error_code: 'invalid_input',
    title: 'Invalid transcript',
    message: 'transcript validation failed',
    status_code: 400,
    context_id: 'sess-1:1',
  }), false);
  const errs = events.filter((e) => e.kind === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].fatal, false, 'per-turn rejection must be recoverable');
  assert.equal(typeof errs[0].textSample, 'string');
  assert.ok(errs[0].textSample.includes('Hello world'), 'must include the offending sample');
  // Turn must be dead so subsequent sendText/turnEnd is a no-op.
  assert.equal(bridge._turnDead, true);
  assert.equal(bridge._currentContextId, null);
  // WS still open — bridge can be reused for next turn.
  off();
});

test('cancel sets _turnDead synchronously before the cancel send', () => {
  const { bridge, sent } = makeStubBridge();
  bridge.turnStart('sess-1:1');
  bridge.sendText('hi');
  // Snapshot pre-cancel
  assert.equal(bridge._turnDead, false);
  bridge.cancel();
  // Post-cancel both flag set AND a cancel:true frame on the wire.
  assert.equal(bridge._turnDead, true);
  const cancelFrames = sent.filter((m) => m.cancel === true);
  assert.equal(cancelFrames.length, 1);
});

test('chunks arriving after cancel are dropped (no audio_out)', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('sess-1:1');
  bridge.sendText('hi');
  bridge.cancel();
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage(JSON.stringify({
    type: 'chunk', data: 'AAAA', context_id: 'sess-1:1',
  }), false);
  assert.equal(events.filter((e) => e.kind === 'audio_out').length, 0);
  off();
});

test('protocol_violation on non-JSON frame', () => {
  const { bridge } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage(Buffer.from('not-json'), false);
  const errs = events.filter((e) => e.kind === 'error');
  assert.equal(errs[0].code, 'protocol_violation');
  off();
});

test('protocol_violation on binary frame', () => {
  const { bridge } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage(Buffer.from([1, 2, 3]), true);
  assert.equal(events.filter((e) => e.kind === 'error')[0].code, 'protocol_violation');
  off();
});

test('unknown envelope type warns once and keeps the bridge alive', () => {
  const { bridge } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage(JSON.stringify({ type: 'newfangled', context_id: 'x' }), false);
  bridge._onMessage(JSON.stringify({ type: 'newfangled', context_id: 'x' }), false);
  const warns = events.filter((e) => e.kind === 'error' && e.code === 'unknown_envelope_type');
  assert.equal(warns.length, 1, 'must warn exactly once per session');
  assert.equal(warns[0].fatal, false);
  off();
});

test('turnEnd resolves with non-zero metrics on a normal done', async () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('sess-1:1');
  bridge.sendText('hello');
  // Simulate audio chunks landing.
  bridge._onMessage(JSON.stringify({ type: 'chunk', data: 'AAAA', context_id: 'sess-1:1' }), false);
  bridge._onMessage(JSON.stringify({ type: 'chunk', data: 'AAAA', context_id: 'sess-1:1' }), false);

  const endP = bridge.turnEnd({ timeoutMs: 500 });
  // Fire `done` next tick.
  setImmediate(() => {
    bridge._onMessage(JSON.stringify({ type: 'done', context_id: 'sess-1:1', done: true }), false);
  });
  const result = await endP;
  assert.equal(result.partial, false);
  assert.equal(result.characters, 5);
  assert.equal(result.audioBytes, 6);
  assert.equal(result.audioSeconds, 6 / (24000 * 2));
});

test('turnEnd resolves partial:true on timeout (R3-C1: never throw)', async () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('sess-1:1');
  bridge.sendText('xyz');
  const result = await bridge.turnEnd({ timeoutMs: 30 });
  assert.equal(result.partial, true);
  assert.equal(result.characters, 3);
});

test('turnStart during reconnect rejects synchronously with tts_reconnecting', () => {
  const { bridge } = makeStubBridge();
  bridge._reconnecting = true;
  let caught;
  try { bridge.turnStart('sess-1:1'); } catch (e) { caught = e; }
  assert.ok(caught, 'must throw');
  assert.equal(caught.code, 'tts_reconnecting');
});

test('cancel + late chunks: counters frozen at cancel time', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('sess-1:1');
  bridge.sendText('hi');
  bridge._onMessage(JSON.stringify({ type: 'chunk', data: 'AAAA', context_id: 'sess-1:1' }), false);
  const beforeBytes = bridge._audioBytesThisTurn;
  bridge.cancel();
  bridge._onMessage(JSON.stringify({ type: 'chunk', data: 'AAAAAAAA', context_id: 'sess-1:1' }), false);
  assert.equal(bridge._audioBytesThisTurn, beforeBytes, 'late chunks must not change counters');
});

// ─────────────────────────────────────────────────────────────────────
// Creator voice-speed knob (migration 20260511000006)
// ─────────────────────────────────────────────────────────────────────

function makeStubBridgeWithSpeed(ttsSpeed) {
  const sent = [];
  const ws = {
    readyState: 1,
    send: (s) => { sent.push(JSON.parse(s)); },
    close: () => {},
    terminate: () => {},
  };
  const bridge = new CartesiaTTSBridge({
    apiKey: 'k',
    voiceId: 'voice-uuid-abc',
    ttsSpeed,
  });
  bridge._ws = ws;
  bridge._closed = false;
  return { bridge, sent };
}

test('tts_speed=0.85: every sendText carries generation_config.speed=0.85', () => {
  const { bridge, sent } = makeStubBridgeWithSpeed(0.85);
  bridge.turnStart('sess-1:1');
  bridge.sendText('Hello,');
  bridge.sendText(' world.');
  assert.equal(sent.length, 2);
  for (const m of sent) {
    assert.deepEqual(m.generation_config, { speed: 0.85 });
  }
});

test('tts_speed=1.15: terminator in turnEnd also carries generation_config.speed=1.15', async () => {
  const { bridge, sent } = makeStubBridgeWithSpeed(1.15);
  bridge.turnStart('sess-1:1');
  bridge.sendText('Hi.');
  // Kick a `done` event before timeout so turnEnd resolves cleanly.
  setTimeout(() => {
    bridge._onMessage(JSON.stringify({ type: 'done', context_id: 'sess-1:1' }), false);
  }, 10);
  await bridge.turnEnd({ timeoutMs: 500 });
  // sent[0] = sendText, sent[1] = terminator
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].generation_config, { speed: 1.15 });
  assert.deepEqual(sent[1].generation_config, { speed: 1.15 });
  assert.equal(sent[1].continue, false);
  assert.equal(sent[1].transcript, '');
});

test('tts_speed=null: generation_config field is OMITTED entirely (Cartesia default playback)', () => {
  const { bridge, sent } = makeStubBridgeWithSpeed(null);
  bridge.turnStart('sess-1:1');
  bridge.sendText('Hi.');
  assert.equal(sent.length, 1);
  assert.ok(!('generation_config' in sent[0]), 'generation_config must not be present on null speed');
});

test('tts_speed=1.0: treated as no-op, generation_config OMITTED (forward-compat with Cartesia param renames)', () => {
  const { bridge, sent } = makeStubBridgeWithSpeed(1.0);
  bridge.turnStart('sess-1:1');
  bridge.sendText('Hi.');
  assert.equal(sent.length, 1);
  assert.ok(!('generation_config' in sent[0]), 'generation_config must not be present on explicit 1.0');
});

test('tts_speed="1.15" (string from supabase-js numeric): coerced via Number(), emitted as number', () => {
  // Defense-in-depth: even though proxy coerces at the ticket boundary,
  // the bridge constructor coerces strings too so a future caller that
  // forgets the boundary cast doesn't silently send a string wire value.
  const { bridge, sent } = makeStubBridgeWithSpeed('1.15');
  bridge.turnStart('sess-1:1');
  bridge.sendText('Hi.');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].generation_config, { speed: 1.15 });
  assert.equal(typeof sent[0].generation_config.speed, 'number');
});

test('tts_speed=0.4 (below 0.6 floor): coerced to null fallback, generation_config OMITTED', () => {
  // Defense-in-depth: DB CHECK should catch this upstream; bridge defaults
  // to null/omit rather than fail the open if a corrupt ticket sneaks past.
  const { bridge, sent } = makeStubBridgeWithSpeed(0.4);
  bridge.turnStart('sess-1:1');
  bridge.sendText('Hi.');
  assert.equal(sent.length, 1);
  assert.ok(!('generation_config' in sent[0]));
});
