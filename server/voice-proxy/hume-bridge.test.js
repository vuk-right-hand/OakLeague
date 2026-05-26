// HumeTTSBridge unit tests. Skips the open() handshake by stubbing _ws
// directly; the live API is exercised by scripts/hume-phase0-spike.mjs and
// the §8 burn-in.
//
// Run: cd server/voice-proxy && node --test hume-bridge.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HumeTTSBridge, HUME_CHARS_PER_TURN_HARD_CAP, validateHumePricingOrExit, assertHumePricing } from './hume-bridge.js';

const VALID_PRICING = { usdPerChar: 0.0000076, quotedAt: '2026-05-13' };

function makeStubBridge(opts = {}) {
  const sent = [];
  const ws = {
    readyState: 1, // OPEN
    send: (s) => { sent.push(JSON.parse(s)); },
    close: () => {},
    terminate: () => {},
  };
  const bridge = new HumeTTSBridge({
    apiKey: 'k',
    voiceId: '550e8400-e29b-41d4-a716-446655440000',
    voiceName: 'Vuk Voice',
    pricing: VALID_PRICING,
    ...opts,
  });
  bridge._ws = ws;
  bridge._closed = false;
  return { bridge, sent };
}

// ── URL construction + scrubbing ───────────────────────────────────────

test('_buildUrl includes api_key and required Hume query params (version=2 default)', () => {
  const { bridge } = makeStubBridge();
  const url = bridge._buildUrl();
  assert.ok(url.startsWith('wss://api.hume.ai/v0/tts/stream/input'));
  assert.ok(url.includes('api_key=k'));
  assert.ok(url.includes('version=2'));
  assert.ok(url.includes('instant_mode=true'));
  assert.ok(url.includes('strip_headers=true'));
  assert.ok(url.includes('format_type=pcm'));
  assert.ok(url.includes('no_binary=true'));
  assert.ok(url.includes('sample_rate=16000'));
});

test('_urlScrubbed redacts api_key (defense-in-depth — logs must never carry the secret)', () => {
  const { bridge } = makeStubBridge({ apiKey: 'hume_sk_very_secret' });
  const scrubbed = bridge._urlScrubbed();
  assert.ok(!scrubbed.includes('hume_sk_very_secret'), 'api_key leaked through _urlScrubbed');
  assert.ok(scrubbed.includes('api_key=[redacted]'));
});

test('modelVersion=1 emits version=1 (Octave 1 fallback)', () => {
  const { bridge } = makeStubBridge({ modelVersion: '1' });
  assert.ok(bridge._buildUrl().includes('version=1'));
});

test("modelVersion='default' OMITS version param (Hume auto-routes)", () => {
  const { bridge } = makeStubBridge({ modelVersion: 'default' });
  assert.ok(!bridge._buildUrl().includes('version='), 'default should omit version param');
});

test('modelVersion=3 (invalid) throws at constructor', () => {
  assert.throws(
    () => new HumeTTSBridge({ apiKey: 'k', voiceId: 'v', modelVersion: '3', pricing: VALID_PRICING }),
    /bad modelVersion/,
  );
});

test('C3: constructor throws when pricing is missing (fail-closed enforcement at bridge layer)', () => {
  assert.throws(
    () => new HumeTTSBridge({ apiKey: 'k', voiceId: 'v' }),
    /HUME_PRICING_NOT_VALIDATED/,
  );
});

test('C3: constructor throws when pricing.usdPerChar is zero or negative', () => {
  assert.throws(
    () => new HumeTTSBridge({ apiKey: 'k', voiceId: 'v', pricing: { usdPerChar: 0, quotedAt: '2026-05-13' } }),
    /HUME_PRICING_NOT_VALIDATED/,
  );
  assert.throws(
    () => new HumeTTSBridge({ apiKey: 'k', voiceId: 'v', pricing: { usdPerChar: -1, quotedAt: '2026-05-13' } }),
    /HUME_PRICING_NOT_VALIDATED/,
  );
});

test('C3: constructor throws when pricing.quotedAt is missing', () => {
  assert.throws(
    () => new HumeTTSBridge({ apiKey: 'k', voiceId: 'v', pricing: { usdPerChar: 0.0000076 } }),
    /HUME_PRICING_NOT_VALIDATED/,
  );
});

// ── sendText payload shape ─────────────────────────────────────────────

test('sendText emits Hume publish envelope: text + voice + CUSTOM_VOICE provider', () => {
  const { bridge, sent } = makeStubBridge();
  bridge.turnStart('sess-1:1');
  bridge.sendText('Hello,');
  bridge.sendText(' world.');
  assert.equal(sent.length, 2);
  for (const m of sent) {
    assert.deepEqual(m.voice, { id: '550e8400-e29b-41d4-a716-446655440000', provider: 'CUSTOM_VOICE' });
  }
  assert.equal(sent[0].text, 'Hello,');
  assert.equal(sent[1].text, ' world.');
});

test('sendText omits speed when ttsSpeed=null (Hume default)', () => {
  const { bridge, sent } = makeStubBridge({ ttsSpeed: null });
  bridge.turnStart('sess-1:1');
  bridge.sendText('Hi.');
  assert.equal(sent.length, 1);
  assert.ok(!('speed' in sent[0]), 'speed must NOT be present on null');
});

test('sendText omits speed when ttsSpeed=1.0 (functional default; reduces wire payload)', () => {
  const { bridge, sent } = makeStubBridge({ ttsSpeed: 1.0 });
  bridge.turnStart('sess-1:1');
  bridge.sendText('Hi.');
  assert.equal(sent.length, 1);
  assert.ok(!('speed' in sent[0]));
});

test('sendText emits speed=1.5 (founder-tested Octave 2 config)', () => {
  const { bridge, sent } = makeStubBridge({ ttsSpeed: 1.5 });
  bridge.turnStart('sess-1:1');
  bridge.sendText('Hi.');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].speed, 1.5);
});

test('sendText clamps speed=2.1 to null (out of range — DB CHECK is authoritative)', () => {
  const { bridge, sent } = makeStubBridge({ ttsSpeed: 2.1 });
  bridge.turnStart('sess-1:1');
  bridge.sendText('Hi.');
  assert.equal(sent.length, 1);
  assert.ok(!('speed' in sent[0]));
});

test('sendText coerces string ttsSpeed (defense-in-depth at supabase-js numeric boundary)', () => {
  const { bridge, sent } = makeStubBridge({ ttsSpeed: '1.25' });
  bridge.turnStart('sess-1:1');
  bridge.sendText('Hi.');
  assert.equal(sent[0].speed, 1.25);
  assert.equal(typeof sent[0].speed, 'number');
});

test('sendText emits trailing_silence=0.5 when set, omits when null/0', () => {
  // Default 0.3 set in DB → must come through
  const { bridge: b1, sent: s1 } = makeStubBridge({ trailingSilence: 0.5 });
  b1.turnStart('s:1');
  b1.sendText('Hi.');
  assert.equal(s1[0].trailing_silence, 0.5);

  const { bridge: b2, sent: s2 } = makeStubBridge({ trailingSilence: null });
  b2.turnStart('s:1');
  b2.sendText('Hi.');
  assert.ok(!('trailing_silence' in s2[0]), 'trailing_silence omitted on null');

  const { bridge: b3, sent: s3 } = makeStubBridge({ trailingSilence: 0 });
  b3.turnStart('s:1');
  b3.sendText('Hi.');
  assert.ok(!('trailing_silence' in s3[0]), 'trailing_silence omitted on 0');
});

test('sendText emits description (acting instructions hint, inert on Octave 2 today)', () => {
  const desc = 'warm, conversational, leaning forward';
  const { bridge, sent } = makeStubBridge({ description: desc });
  bridge.turnStart('s:1');
  bridge.sendText('Hi.');
  assert.equal(sent[0].description, desc);
});

test('sendText omits description when null or empty', () => {
  const { bridge, sent } = makeStubBridge({ description: '' });
  bridge.turnStart('s:1');
  bridge.sendText('Hi.');
  assert.ok(!('description' in sent[0]));
});

test('sendText normalizes Unicode punctuation (curly quotes, em-dash, ellipsis)', () => {
  const { bridge, sent } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('He said “hello” — it’s a test…');
  assert.equal(sent[0].text, 'He said "hello" - it\'s a test...');
});

// ── Char hard cap ──────────────────────────────────────────────────────

test('M5: hitting HUME_CHARS_PER_TURN_HARD_CAP emits protocol_violation error ONCE (not silent)', () => {
  const { bridge, sent } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge.turnStart('s:1');
  // Fill the cap exactly with first send (no emit yet — exactly at cap is fine).
  bridge.sendText('x'.repeat(HUME_CHARS_PER_TURN_HARD_CAP));
  assert.equal(bridge._charsThisTurn, HUME_CHARS_PER_TURN_HARD_CAP);
  // First over-the-cap call: must emit cap error.
  bridge.sendText('more text');
  bridge.sendText('and more');
  bridge.sendText('and again');
  const capErrors = events.filter((e) => e.kind === 'error' && /per_turn_cap_exceeded/.test(e.message));
  assert.equal(capErrors.length, 1, 'cap-exceeded error must emit ONCE per turn (latched)');
  assert.equal(capErrors[0].fatal, false, 'cap-exceeded must be recoverable (next turn)');
  assert.equal(sent.length, 1, 'no wire message after cap exceeded');
  off();
});

test('M5: partial-truncation when text exceeds remaining budget also emits cap error', () => {
  const { bridge } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge.turnStart('s:1');
  bridge.sendText('x'.repeat(HUME_CHARS_PER_TURN_HARD_CAP - 10));
  bridge.sendText('y'.repeat(50));
  // The partial-truncation path also fires the cap-exceeded event
  const capErrors = events.filter((e) => e.kind === 'error' && /per_turn_cap_exceeded/.test(e.message));
  assert.equal(capErrors.length, 1, 'partial-truncation must emit cap error');
  assert.equal(bridge._charsThisTurn, HUME_CHARS_PER_TURN_HARD_CAP);
  off();
});

test('M5: cap-error latch resets on next turn', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('x'.repeat(HUME_CHARS_PER_TURN_HARD_CAP + 10)); // emit cap once
  assert.equal(bridge._charCapEmittedThisTurn, true);
  bridge.turnStart('s:2');
  assert.equal(bridge._charCapEmittedThisTurn, false, 'latch must reset on turnStart');
});

// ── Inbound chunk handling ─────────────────────────────────────────────

test('inbound audio chunk emits audio_out + latches generation_id on first chunk', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  const events = [];
  const off = bridge.on((e) => events.push(e));

  bridge._onMessage(JSON.stringify({
    type: 'audio',
    audio: 'AAAA',
    audio_format: 'pcm',
    chunk_index: 0,
    generation_id: 'gen-abc-123',
    snippet_id: 'snip-1',
    is_last_chunk: false,
    request_id: 'req-1',
    text: 'hi', // ← LEAK CHANNEL — bridge must never log raw msg
  }), false);

  const audio = events.filter((e) => e.kind === 'audio_out');
  assert.equal(audio.length, 1);
  // 3-byte input ('AAAA' base64) → 1 s16le sample → FIR 48→16 emits 1
  // output sample = 2 bytes. Bridge always declares 16 kHz output.
  assert.equal(audio[0].chunk.bytes.length, 2);
  assert.equal(audio[0].chunk.mimeType, 'audio/pcm;rate=16000');
  assert.equal(audio[0].contextId, 's:1');
  assert.equal(audio[0].generationId, 'gen-abc-123');
  assert.equal(bridge._currentGenerationId, 'gen-abc-123', 'generation_id must latch on first chunk');
  assert.equal(bridge._audioBytesThisTurn, 2);
  off();
});

test('is_last_chunk:true emits turn_done', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  const events = [];
  const off = bridge.on((e) => events.push(e));

  bridge._onMessage(JSON.stringify({
    type: 'audio', audio: 'AAAA', generation_id: 'g1', is_last_chunk: true,
  }), false);

  const dones = events.filter((e) => e.kind === 'turn_done');
  assert.equal(dones.length, 1);
  assert.equal(dones[0].contextId, 's:1');
  assert.equal(dones[0].generationId, 'g1');
  off();
});

test('is_last_chunk:true with empty audio still emits turn_done', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage(JSON.stringify({
    type: 'audio', audio: '', generation_id: 'g1', is_last_chunk: true,
  }), false);
  // No audio_out (empty), but turn_done MUST fire
  assert.equal(events.filter((e) => e.kind === 'audio_out').length, 0);
  assert.equal(events.filter((e) => e.kind === 'turn_done').length, 1);
  off();
});

// ── Cancellation: filter-by-generation_id ──────────────────────────────

test('cancel adds current generation_id to cancel set; subsequent chunks for it are dropped', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  // First chunk latches generation_id
  bridge._onMessage(JSON.stringify({
    type: 'audio', audio: 'AAAA', generation_id: 'g1', is_last_chunk: false,
  }), false);
  // 3 input bytes → 1 sample → FIR 48→16 emits 2 bytes
  assert.equal(bridge._audioBytesThisTurn, 2);
  bridge.cancel();
  // Late chunks for g1 must be dropped
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage(JSON.stringify({
    type: 'audio', audio: 'AAAAAAAA', generation_id: 'g1', is_last_chunk: false,
  }), false);
  assert.equal(events.filter((e) => e.kind === 'audio_out').length, 0, 'late chunks for cancelled g1 dropped');
  assert.equal(bridge._audioBytesThisTurn, 2, 'audioBytes frozen at cancel time');
  off();
});

// Audit M6 — barge-in BEFORE the first audio chunk (gen-id unknown).
test('M6: cancel before first chunk → drop-all window latches leaked gen-id, no bleed into next turn', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  // No audio chunk arrived yet → _currentGenerationId is null.
  assert.equal(bridge._currentGenerationId, null);
  bridge.cancel();
  assert.equal(bridge._pendingCancelDropAll, true, 'drop-all armed when gen-id unknown at cancel');

  const events = [];
  const off = bridge.on((e) => events.push(e));

  // First leaked chunk of the cancelled (pre-genid) turn arrives now.
  bridge._onMessage(JSON.stringify({
    type: 'audio', audio: 'AAAAAAAA', generation_id: 'gLeak', is_last_chunk: false,
  }), false);
  assert.equal(events.filter((e) => e.kind === 'audio_out').length, 0, 'leaked chunk dropped in window');
  assert.equal(bridge._cancelledGenerationIds.has('gLeak'), true, 'leaked gen-id latched into cancel set');

  // Next turn starts — drop-all flag must clear (re-arm).
  bridge.turnStart('s:2');
  bridge.sendText('next');
  assert.equal(bridge._pendingCancelDropAll, false, 'drop-all cleared on turnStart');

  // A STILL-in-flight leaked chunk for gLeak arrives AFTER turnStart —
  // must stay filtered (gen-id is in the cancel set, survives turnStart).
  bridge._onMessage(JSON.stringify({
    type: 'audio', audio: 'AAAAAAAA', generation_id: 'gLeak', is_last_chunk: true,
  }), false);
  assert.equal(events.filter((e) => e.kind === 'audio_out').length, 0, 'post-turnStart leaked chunk still filtered');

  // The NEW turn's real audio (fresh gen-id) must emit normally.
  bridge._onMessage(JSON.stringify({
    type: 'audio', audio: 'AAAAAAAA', generation_id: 'gNew', is_last_chunk: false,
  }), false);
  assert.equal(events.filter((e) => e.kind === 'audio_out').length, 1, 'new turn audio emits');
  off();
});

test('cancel + is_last_chunk:true on cancelled gen evicts from cancel set', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  bridge._onMessage(JSON.stringify({ type: 'audio', audio: 'AA', generation_id: 'g1' }), false);
  bridge.cancel();
  assert.equal(bridge._cancelledGenerationIds.has('g1'), true);
  bridge._onMessage(JSON.stringify({ type: 'audio', audio: '', generation_id: 'g1', is_last_chunk: true }), false);
  assert.equal(bridge._cancelledGenerationIds.has('g1'), false, 'last-chunk eviction prevents unbounded growth');
});

test('cancel does NOT send a wire frame (Phase-0: all cancel strategies fail to stop within 200ms)', () => {
  const { bridge, sent } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  const sentBefore = sent.length;
  bridge.cancel();
  assert.equal(sent.length, sentBefore, 'cancel must not emit any wire message — filter-only strategy');
});

test('cancel sets _turnDead synchronously + nulls contextId', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  bridge.cancel();
  assert.equal(bridge._turnDead, true);
  assert.equal(bridge._currentContextId, null);
});

// ── Error envelope handling ────────────────────────────────────────────

test('M4 + C4 + unit-wide M7: E0101 emits safeMessage="hume_payload_parse" + humeMessage=null (literal echo never surfaces)', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage(JSON.stringify({
    type: 'error',
    code: 'E0101',
    slug: 'payload_parse',
    message: "Failed to parse payload. received `str` input of 'USER_TRANSCRIPT_LEAK_SENTINEL'",
    request_id: 'r-1',
  }), false);
  const errs = events.filter((e) => e.kind === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'protocol_violation');
  assert.equal(errs[0].fatal, false);
  // The literal echo must NOT surface in any emitted event field
  const str = JSON.stringify(errs[0]);
  assert.ok(!str.includes('USER_TRANSCRIPT_LEAK_SENTINEL'),
            'C4 leak: payload_parse message echoed our transcript content');
  // M7: safe message + null humeMessage (denylisted key gets bypassed by null)
  assert.equal(errs[0].message, 'hume_payload_parse');
  assert.equal(errs[0].humeMessage, null);
  assert.equal(errs[0].humeCode, 'E0101');
  assert.equal(errs[0].humeSlug, 'payload_parse');
  assert.equal(bridge._turnDead, true);
  assert.equal(bridge._currentContextId, null);
  off();
});

test('M4 + M7: unknown Hume code → "other" fatal=true + Hume verbatim surfaces in humeMessage (denylisted)', () => {
  const { bridge } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage(JSON.stringify({
    type: 'error', code: 'EXYZ', message: 'rate_limited at request including USER_LEAK',
  }), false);
  // Audit small fix (2026-05-13): unmapped code now emits a one-shot
  // 'unknown_hume_error_code' warning BEFORE the main error. Find the
  // main 'other' error explicitly rather than indexing the events array.
  const errs = events.filter((e) => e.kind === 'error');
  const main = errs.find((e) => e.code === 'other');
  assert.ok(main, 'main error event present');
  assert.equal(main.fatal, true);
  // M7: safeMessage is bridge-controlled; humeMessage carries the
  // verbatim (bounded). Sentry redacts humeMessage via TRANSCRIPT_KEYS.
  assert.equal(main.message, 'hume_other_error');
  assert.ok(main.humeMessage.includes('USER_LEAK'), 'humeMessage carries Hume verbatim');
  off();
});

test('humeMessage bounded to 200 chars + textSample included for diagnostics', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('Hello world test transcript that needs sampling');
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage(JSON.stringify({
    type: 'error', code: 'EXYZ', message: 'x'.repeat(500),
  }), false);
  // Audit small fix (2026-05-13): an unmapped code now also emits a
  // one-shot 'unknown_hume_error_code' warning before the main error.
  // Find the main error explicitly (mapped code === 'other'); the warning
  // is non-fatal and is asserted separately below.
  const err = events.find((e) => e.kind === 'error' && e.code === 'other');
  // safeMessage is short literal; humeMessage carries the bounded verbatim.
  assert.equal(err.message, 'hume_other_error');
  assert.ok(err.humeMessage.length <= 200);
  assert.ok(err.textSample.includes('Hello world'));
  // Verify the one-shot unknown-code warning fired exactly once.
  const warnings = events.filter((e) => e.kind === 'error' && e.code === 'unknown_hume_error_code');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].fatal, false);
  assert.equal(warnings[0].humeCode, 'EXYZ');
  off();
});

test('unknown Hume error code warning fires only once per code', () => {
  const { bridge } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));
  // Fire the same unmapped code three times.
  for (let i = 0; i < 3; i++) {
    bridge._onMessage(JSON.stringify({ type: 'error', code: 'EXYZ', message: 'foo' }), false);
  }
  // Different unmapped code fires its own one-shot.
  bridge._onMessage(JSON.stringify({ type: 'error', code: 'EZZZ', message: 'bar' }), false);
  const warnings = events.filter((e) => e.kind === 'error' && e.code === 'unknown_hume_error_code');
  assert.equal(warnings.length, 2, 'two distinct codes → two warnings');
  off();
});

test('protocol_violation on non-JSON frame', () => {
  const { bridge } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage(Buffer.from('not json'), false);
  assert.equal(events.find((e) => e.kind === 'error').code, 'protocol_violation');
  off();
});

test('protocol_violation on binary frame (no_binary=true was requested)', () => {
  const { bridge } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage(Buffer.from([1, 2, 3]), true);
  assert.equal(events.find((e) => e.kind === 'error').code, 'protocol_violation');
  off();
});

test('unknown envelope type warns once and keeps bridge alive', () => {
  const { bridge } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onMessage(JSON.stringify({ type: 'newfangled' }), false);
  bridge._onMessage(JSON.stringify({ type: 'newfangled' }), false);
  const warns = events.filter((e) => e.kind === 'error' && e.code === 'unknown_envelope_type');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].fatal, false);
  off();
});

// ── Bad-voice-id silent-close detection ────────────────────────────────

test('close 1000 + zero chunks + >1500ms since first send = bad_voice_id (fatal)', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  // Force _firstSendAtMs to 2s ago
  bridge._firstSendAtMs = Date.now() - 2000;
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onClose(1000, '');
  const errs = events.filter((e) => e.kind === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'bad_voice_id');
  assert.equal(errs[0].fatal, true);
  assert.ok(errs[0].message.includes('voiceId_len='), 'must include voiceId_len for diagnostics');
  assert.ok(!errs[0].message.includes('550e8400'), 'must NOT include the literal voice id');
  off();
});

test('close 1000 within 1500ms of first send is NOT bad_voice_id (transient hiccup)', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  bridge._firstSendAtMs = Date.now() - 500; // 500ms ago
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onClose(1000, '');
  const badVoice = events.filter((e) => e.kind === 'error' && e.code === 'bad_voice_id');
  assert.equal(badVoice.length, 0, 'must not declare bad_voice_id below 1500ms threshold');
  off();
});

test('close 1000 after chunks received is NOT bad_voice_id (normal close)', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  bridge._firstSendAtMs = Date.now() - 5000;
  bridge._onMessage(JSON.stringify({ type: 'audio', audio: 'AA', generation_id: 'g1' }), false);
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onClose(1000, '');
  const badVoice = events.filter((e) => e.kind === 'error' && e.code === 'bad_voice_id');
  assert.equal(badVoice.length, 0, 'chunks received before close → not bad_voice_id');
  off();
});

// ── turnEnd semantics ──────────────────────────────────────────────────

test('turnEnd resolves with non-zero metrics on is_last_chunk arrival', async () => {
  const { bridge, sent } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hello');
  // 6 raw bytes (3 s16le samples @ 48kHz) → downsamples 3:1 → 1 sample = 2 bytes out.
  // `audioBytes` tracks the post-downsample wire-output count.
  bridge._onMessage(JSON.stringify({ type: 'audio', audio: 'AAAAAAAA', generation_id: 'g1' }), false);
  const endP = bridge.turnEnd({ timeoutMs: 500 });
  setImmediate(() => {
    bridge._onMessage(JSON.stringify({
      type: 'audio', audio: '', generation_id: 'g1', is_last_chunk: true,
    }), false);
  });
  const result = await endP;
  assert.equal(result.partial, false);
  assert.equal(result.characters, 5);
  assert.equal(result.audioBytes, 2);
  // turnEnd should have sent a flush frame
  const flushes = sent.filter((m) => m.flush === true);
  assert.equal(flushes.length, 1, 'turnEnd must emit {flush:true}');
});

test('turnEnd resolves partial:true on timeout', async () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('xyz');
  const result = await bridge.turnEnd({ timeoutMs: 30 });
  assert.equal(result.partial, true);
  assert.equal(result.characters, 3);
});

test('turnEnd with no sendText emits NO flush + resolves zero (matches Cartesia)', async () => {
  const { bridge, sent } = makeStubBridge();
  bridge.turnStart('s:1');
  const result = await bridge.turnEnd({ timeoutMs: 30 });
  assert.equal(result.partial, false);
  assert.equal(result.characters, 0);
  assert.equal(sent.filter((m) => m.flush).length, 0);
});

test('turnEnd after cancel returns partial without sending flush', async () => {
  const { bridge, sent } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  bridge.cancel();
  const sentBefore = sent.length;
  const result = await bridge.turnEnd({ timeoutMs: 30 });
  assert.equal(result.partial, true);
  assert.equal(sent.length, sentBefore, 'no flush after cancel');
});

// ── Reconnect guards ───────────────────────────────────────────────────

test('turnStart during reconnect rejects synchronously with tts_reconnecting', () => {
  const { bridge } = makeStubBridge();
  bridge._reconnecting = true;
  let caught;
  try { bridge.turnStart('s:1'); } catch (e) { caught = e; }
  assert.ok(caught);
  assert.equal(caught.code, 'tts_reconnecting');
});

// ── Pricing fail-closed ────────────────────────────────────────────────

test('validateHumePricingOrExit exits when HUME_USD_PER_CHAR is missing', () => {
  let exitCode = null;
  let logCalled = false;
  validateHumePricingOrExit({
    env: { HUME_QUOTED_AT: '2026-05-13' },
    exit: (n) => { exitCode = n; },
    log: () => { logCalled = true; },
  });
  assert.equal(exitCode, 1);
  assert.equal(logCalled, true);
});

test('validateHumePricingOrExit exits when HUME_USD_PER_CHAR is non-finite', () => {
  let exitCode = null;
  validateHumePricingOrExit({
    env: { HUME_USD_PER_CHAR: 'not-a-number', HUME_QUOTED_AT: '2026-05-13' },
    exit: (n) => { exitCode = n; },
    log: () => {},
  });
  assert.equal(exitCode, 1);
});

test('validateHumePricingOrExit exits when HUME_USD_PER_CHAR is <= 0', () => {
  let exitCode = null;
  validateHumePricingOrExit({
    env: { HUME_USD_PER_CHAR: '0', HUME_QUOTED_AT: '2026-05-13' },
    exit: (n) => { exitCode = n; },
    log: () => {},
  });
  assert.equal(exitCode, 1);
});

test('validateHumePricingOrExit exits when HUME_QUOTED_AT is missing', () => {
  let exitCode = null;
  validateHumePricingOrExit({
    env: { HUME_USD_PER_CHAR: '0.0000076' },
    exit: (n) => { exitCode = n; },
    log: () => {},
  });
  assert.equal(exitCode, 1);
});

test('validateHumePricingOrExit returns {usdPerChar, quotedAt} on valid env', () => {
  const result = validateHumePricingOrExit({
    env: { HUME_USD_PER_CHAR: '0.0000076', HUME_QUOTED_AT: '2026-05-13' },
    exit: (n) => { throw new Error(`exit called with ${n}`); },
    log: () => {},
  });
  assert.equal(result.usdPerChar, 0.0000076);
  assert.equal(result.quotedAt, '2026-05-13');
});

// Audit M3 — HUME_QUOTED_AT must be YYYY-MM-DD (parity with Cartesia).
test('M3: validateHumePricingOrExit exits when HUME_QUOTED_AT is not YYYY-MM-DD', () => {
  let exitCode = null;
  validateHumePricingOrExit({
    env: { HUME_USD_PER_CHAR: '0.0000076', HUME_QUOTED_AT: 'yes' },
    exit: (n) => { exitCode = n; },
    log: () => {},
  });
  assert.equal(exitCode, 1);
});

// Audit C5 — the lazy/runtime validator THROWS (never process.exit) so a
// misconfigured fleet kills one session, not the whole VM.
test('C5: assertHumePricing throws (does NOT exit) on missing HUME_USD_PER_CHAR', () => {
  assert.throws(
    () => assertHumePricing({ env: { HUME_QUOTED_AT: '2026-05-13' } }),
    /HUME_USD_PER_CHAR missing or non-finite/,
  );
});

test('C5: assertHumePricing throws on bad HUME_QUOTED_AT format', () => {
  assert.throws(
    () => assertHumePricing({ env: { HUME_USD_PER_CHAR: '0.0000076', HUME_QUOTED_AT: '05/13/2026' } }),
    /HUME_QUOTED_AT must be a YYYY-MM-DD/,
  );
});

test('C5: assertHumePricing returns {usdPerChar, quotedAt} on valid env', () => {
  const r = assertHumePricing({ env: { HUME_USD_PER_CHAR: '0.0000076', HUME_QUOTED_AT: '2026-05-13' } });
  assert.equal(r.usdPerChar, 0.0000076);
  assert.equal(r.quotedAt, '2026-05-13');
});

// ── Vuk-C2: no msg leak in bridge logs ─────────────────────────────────

test('bridge never includes raw chunk msg.text in emitted events (Vuk-C2 leak guard)', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  const events = [];
  const off = bridge.on((e) => events.push(e));
  // Send a chunk whose `text` field contains identifiable content
  const sentinelText = 'LEAK_SENTINEL_TEXT_DO_NOT_LOG';
  bridge._onMessage(JSON.stringify({
    type: 'audio', audio: 'AAAA', generation_id: 'g1', is_last_chunk: false,
    text: sentinelText,
  }), false);
  // No emitted event should carry the sentinel text
  for (const e of events) {
    const str = JSON.stringify(e);
    assert.ok(!str.includes('LEAK_SENTINEL'), `event leaked chunk text: ${str.slice(0, 200)}`);
  }
  off();
});

// ── M1: cancel set bounded growth ──────────────────────────────────────

test('M1: _cancelledGenerationIds Set caps at 64 with FIFO eviction', () => {
  const { bridge } = makeStubBridge();
  // Generate 70 cancels with unique gen_ids — set must never exceed 64.
  for (let i = 0; i < 70; i++) {
    bridge.turnStart(`s:${i}`);
    bridge.sendText('hi');
    bridge._onMessage(JSON.stringify({ type: 'audio', audio: 'AA', generation_id: `g${i}` }), false);
    bridge.cancel();
  }
  assert.ok(bridge._cancelledGenerationIds.size <= 64, `cancel set grew to ${bridge._cancelledGenerationIds.size}`);
  // Oldest should be evicted (g0-g5 must be gone since we added 70 with cap 64).
  assert.equal(bridge._cancelledGenerationIds.has('g0'), false, 'oldest evicted');
  assert.equal(bridge._cancelledGenerationIds.has('g69'), true, 'newest retained');
});

// ── M2: bad-voice-id false-positive guard ──────────────────────────────

test('M2: prior turn with real audio bytes does NOT trigger bad_voice_id on subsequent idle close', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  bridge._firstSendAtMs = Date.now() - 2000;
  // Turn 1 received real audio bytes (no longer the "zero bytes ever" case)
  bridge._onMessage(JSON.stringify({ type: 'audio', audio: 'AAAA', generation_id: 'g1', is_last_chunk: true }), false);
  // Idle close 1000 a bit later
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onClose(1000, '');
  const badVoice = events.filter((e) => e.kind === 'error' && e.code === 'bad_voice_id');
  assert.equal(badVoice.length, 0, 'prior-turn audio bytes prevent bad_voice_id false-positive');
  off();
});

// ── Small: bad_voice_id event fires BEFORE closed event ────────────────

test('Small: bad_voice_id error emits BEFORE closed event (so turnEnd resolve handler sees error first)', () => {
  const { bridge } = makeStubBridge();
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  bridge._firstSendAtMs = Date.now() - 2000;
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._onClose(1000, '');
  // Find indices of the two events
  const errorIdx = events.findIndex((e) => e.kind === 'error' && e.code === 'bad_voice_id');
  const closedIdx = events.findIndex((e) => e.kind === 'closed');
  assert.ok(errorIdx >= 0 && closedIdx >= 0);
  assert.ok(errorIdx < closedIdx, 'bad_voice_id must fire before closed');
  off();
});

// ── M6: turnEnd handler registered BEFORE flush wire send ──────────────

test('M6: turnEnd handler subscribes BEFORE flush is sent (fast-arrival is_last_chunk works)', async () => {
  // Stub WS that synchronously invokes _onMessage with is_last_chunk:true
  // the moment {flush:true} is sent. Previously this would have raced and
  // turnEnd would have timed out partial:true.
  const sent = [];
  const bridge = new HumeTTSBridge({
    apiKey: 'k', voiceId: 'v', pricing: VALID_PRICING,
  });
  bridge._closed = false;
  bridge._ws = {
    readyState: 1,
    send: (s) => {
      sent.push(JSON.parse(s));
      // Synchronously deliver the last-chunk reply
      if (JSON.parse(s).flush) {
        bridge._onMessage(JSON.stringify({
          type: 'audio', audio: '', generation_id: 'g1', is_last_chunk: true,
        }), false);
      }
    },
    close: () => {}, terminate: () => {},
  };
  bridge.turnStart('s:1');
  bridge.sendText('hi');
  // Latch generation_id via a normal chunk first
  bridge._onMessage(JSON.stringify({ type: 'audio', audio: 'AA', generation_id: 'g1' }), false);
  const result = await bridge.turnEnd({ timeoutMs: 500 });
  assert.equal(result.partial, false, 'synchronous is_last_chunk arrival must resolve turnEnd non-partial');
});
