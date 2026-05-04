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
