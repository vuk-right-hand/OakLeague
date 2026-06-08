// FishTTSBridge unit tests. Mirrors cartesia-bridge.test.js patterns —
// stubs `_ws` directly, never opens a real WebSocket. Live wire is
// exercised by scripts/fish-audio-ws-spike.mjs (Phase 0.5).
//
// Run: cd server/voice-proxy && node --test fish-bridge.test.js
//
// Phase 1 scaffold — first 5-8 tests covering the core lifecycle +
// msgpack roundtrip + event taxonomy. Additional tests (~24 more) land
// in subsequent commits per the FISH_AUDIO_PHASE_1 §5 coverage plan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '@msgpack/msgpack';
import {
  FishTTSBridge,
  assertFishPricing,
  validateFishPricingOrExit,
} from './fish-bridge.js';

const VALID_PRICING = { usdPerChar: 0.000015, quotedAt: '2026-05-28' };

/**
 * Build a bridge with a fake `_ws` whose `send()` captures the msgpack
 * payload and decodes it into a plain object for assertions. Mirrors
 * cartesia-bridge.test.js makeStubBridge() but adapted for binary frames.
 *
 * Returns:
 *   bridge — the FishTTSBridge instance
 *   sent   — array of decoded outbound envelopes ({event, …})
 *   ws     — the stub (so a test can flip readyState etc.)
 */
function makeStubBridge({ sentStart = true, contextId = 'sess-1:1' } = {}) {
  const sent = [];
  const ws = {
    readyState: 1, // OPEN
    send: (buf, opts) => {
      // Audit round 3 S7 — real `ws` requires binary:true for msgpack
      // frames. Assert here so a bridge regression that drops the binary
      // flag is caught by every test that runs sendText / turnStart.
      assert.equal(opts?.binary, true, 'msgpack frames MUST be sent with binary:true');
      // Wrap so the byteOffset-aware decode shape under test mirrors prod.
      const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      sent.push(decode(view));
    },
    close: () => {},
    terminate: () => {},
  };
  const bridge = new FishTTSBridge({
    apiKey: 'fk_test',
    voiceId: 'voice-fish-abc',
    pricing: VALID_PRICING,
  });
  bridge._ws = ws;
  bridge._closed = false;
  if (sentStart) {
    bridge._currentContextId = contextId;
    bridge._sentStart = true;
  }
  return { bridge, sent, ws };
}

// ── 1. Constructor input validation ───────────────────────────────────────

test('1: constructor requires apiKey, voiceId, AND validated pricing', () => {
  assert.throws(() => new FishTTSBridge({ voiceId: 'v', pricing: VALID_PRICING }), /FISH_API_KEY missing/);
  assert.throws(() => new FishTTSBridge({ apiKey: 'k', pricing: VALID_PRICING }), /voiceId missing/);
  // Pricing missing → throw with FISH_PRICING_NOT_VALIDATED.
  assert.throws(() => new FishTTSBridge({ apiKey: 'k', voiceId: 'v' }), /FISH_PRICING_NOT_VALIDATED/);
  // Pricing with invalid usdPerChar.
  assert.throws(
    () => new FishTTSBridge({ apiKey: 'k', voiceId: 'v', pricing: { usdPerChar: 0, quotedAt: '2026-05-28' } }),
    /FISH_PRICING_NOT_VALIDATED/,
  );
  // Pricing with empty quotedAt.
  assert.throws(
    () => new FishTTSBridge({ apiKey: 'k', voiceId: 'v', pricing: { usdPerChar: 0.000015, quotedAt: '' } }),
    /FISH_PRICING_NOT_VALIDATED/,
  );
  // All provided → constructor succeeds.
  const b = new FishTTSBridge({ apiKey: 'k', voiceId: 'v', pricing: VALID_PRICING });
  assert.equal(typeof b.turnStart, 'function');
  assert.equal(typeof b.prewarmTurn, 'function');
  assert.equal(typeof b.sendText, 'function');
  assert.equal(typeof b.flush, 'function');
  assert.equal(typeof b.turnEnd, 'function');
  assert.equal(typeof b.cancel, 'function');
  assert.equal(typeof b.close, 'function');
});

// ── 2. msgpack roundtrip via the stub WS ──────────────────────────────────

test('2: sendText emits msgpack { event:"text", text } + leading-edge flush + coalesced tail (C1 / C-R2-2)', () => {
  const { bridge, sent } = makeStubBridge();
  bridge.sendText('Hello');
  bridge.sendText(' world');
  // Audit round 3 C1 + C-R2-2 — leading-edge flush fires on first sendText
  // (so first audio latency isn't penalized); subsequent sendTexts during
  // the cooldown window coalesce — only mark _flushPending without sending.
  // Result: text + flush + text = 3 frames synchronously.
  assert.equal(sent.length, 3, 'first sendText: text+flush (leading edge); second sendText: text only (cooldown)');
  assert.deepEqual(sent[0], { event: 'text', text: 'Hello' });
  assert.deepEqual(sent[1], { event: 'flush' });
  assert.deepEqual(sent[2], { event: 'text', text: ' world' });
  assert.equal(bridge._flushPending, true, 'second sendText marked _flushPending; tail flush fires on cooldown expiry');
});

test('2b: flushPerChunk:false disables the per-chunk flush (opt-out for niche use)', () => {
  const sent = [];
  const ws = {
    readyState: 1,
    send: (buf) => {
      const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      sent.push(decode(view));
    },
    close: () => {},
    terminate: () => {},
  };
  const bridge = new FishTTSBridge({
    apiKey: 'k', voiceId: 'v', pricing: VALID_PRICING, flushPerChunk: false,
  });
  bridge._ws = ws;
  bridge._closed = false;
  bridge._currentContextId = 'sess-1:1';
  bridge._sentStart = true;
  bridge.sendText('Hello');
  bridge.sendText(' world');
  assert.equal(sent.length, 2, 'flushPerChunk:false → only text frames');
  assert.deepEqual(sent.map((m) => m.event), ['text', 'text']);
});

test('2c: flushDebounceMs:0 disables coalescing — every sendText flushes (C-R2-2 escape hatch)', () => {
  const sent = [];
  const ws = {
    readyState: 1,
    send: (buf) => {
      const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      sent.push(decode(view));
    },
    close: () => {},
    terminate: () => {},
  };
  const bridge = new FishTTSBridge({
    apiKey: 'k', voiceId: 'v', pricing: VALID_PRICING, flushDebounceMs: 0,
  });
  bridge._ws = ws;
  bridge._closed = false;
  bridge._currentContextId = 'sess-1:1';
  bridge._sentStart = true;
  bridge.sendText('Hello');
  bridge.sendText(' world');
  assert.equal(sent.length, 4, 'flushDebounceMs:0 → flush on every sendText (test/special-case)');
  assert.deepEqual(sent.map((m) => m.event), ['text', 'flush', 'text', 'flush']);
});

test('2d: coalesced tail flush fires after cooldown window expires (C-R2-2)', async () => {
  const sent = [];
  const ws = {
    readyState: 1,
    send: (buf) => {
      const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      sent.push(decode(view));
    },
    close: () => {},
    terminate: () => {},
  };
  const bridge = new FishTTSBridge({
    apiKey: 'k', voiceId: 'v', pricing: VALID_PRICING, flushDebounceMs: 20,
  });
  bridge._ws = ws;
  bridge._closed = false;
  bridge._currentContextId = 'sess-1:1';
  bridge._sentStart = true;

  bridge.sendText('A');
  bridge.sendText('B');
  bridge.sendText('C');
  // Synchronously: text(A) + flush + text(B) + text(C) = 4 frames.
  assert.equal(sent.length, 4);

  // Wait past the cooldown window.
  await new Promise((r) => setTimeout(r, 40));

  // Tail flush fires once.
  assert.equal(sent.length, 5, 'cooldown expiry triggers a single tail flush');
  assert.deepEqual(sent[4], { event: 'flush' });
});

// ── 3. Inbound audio chunk → audio_out event with PCM 16k mimeType ────────

test('3: inbound audio event emits audio_out with 16kHz PCM bytes', () => {
  const { bridge } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));

  const audioBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
  const frame = encode({ event: 'audio', audio: audioBytes });
  bridge._onMessage(Buffer.from(frame), true);

  const out = events.filter((e) => e.kind === 'audio_out');
  assert.equal(out.length, 1);
  assert.equal(out[0].chunk.bytes.length, 6);
  assert.equal(out[0].chunk.mimeType, 'audio/pcm;rate=16000');
  assert.equal(out[0].contextId, 'sess-1:1');
  assert.equal(bridge._audioBytesThisTurn, 6);
  assert.ok(bridge.getLastChunkAt() > 0);
  off();
});

// ── 4. byteOffset-aware decode (TCP fragmentation guard) ──────────────────

test('4: byteOffset-aware decode handles a non-zero-offset Buffer', () => {
  // Simulate Node ws receiving a frame whose underlying ArrayBuffer
  // contains earlier traffic at offset 0..k-1, with our message at offset k.
  // Without the byteOffset-aware wrap in _onMessage, msgpack.decode would
  // silently read from offset 0 and either throw or yield a corrupted shape.
  const { bridge } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));

  const audioBytes = new Uint8Array([0xaa, 0xbb, 0xcc]);
  const frame = encode({ event: 'audio', audio: audioBytes });
  // Build a backing buffer with leading garbage and slice our frame out.
  const padded = Buffer.alloc(frame.byteLength + 16);
  padded.set([0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
              0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef], 0);
  padded.set(frame, 16);
  const sliced = padded.subarray(16); // byteOffset = 16
  assert.equal(sliced.byteOffset, 16, 'pre-test invariant: slice is offset 16');

  bridge._onMessage(sliced, true);
  const out = events.filter((e) => e.kind === 'audio_out');
  assert.equal(out.length, 1, 'byteOffset-aware decode must read the actual message, not the garbage');
  assert.deepEqual(Array.from(out[0].chunk.bytes), [0xaa, 0xbb, 0xcc]);
  off();
});

// ── 5. flush() is a documented no-op (plan v4 §5 #4) ──────────────────────

test('5: explicit flush(expectedContextId) is a no-op — distinct from sendText\'s internal per-chunk flush', () => {
  const { bridge, sent } = makeStubBridge();
  // sendText emits text + flush (2 frames). Explicit flush() must add nothing.
  bridge.sendText('Some text');
  assert.equal(sent.length, 2, 'sendText emits text + flush (per-chunk)');
  const eventsBefore = [];
  const off = bridge.on((e) => eventsBefore.push(e));

  bridge.flush();
  bridge.flush('sess-1:1');
  bridge.flush('mismatched-ctx-id');

  // No new sends emitted (sent.length unchanged from sendText's 2).
  assert.equal(sent.length, 2, 'explicit flush() MUST NOT send a frame to the WS');
  // No events fired (flush is silent — no flush_done equivalent on fish either).
  assert.equal(eventsBefore.length, 0, 'flush() MUST NOT emit any events');
  off();
});

// ── 6. cancel() closes the WS synchronously, no stop frame sent ───────────

test('6: cancel() closes WS, marks turn dead, sets _cancelled, sends NO stop frame', () => {
  const { bridge, sent, ws } = makeStubBridge();
  bridge.sendText('Mid-turn text');
  assert.equal(sent.length, 2, 'sendText emits text + flush (per-chunk)');

  let closeCalled = 0;
  let closeCode = null;
  ws.close = (code) => { closeCalled++; closeCode = code; };

  bridge.cancel();

  assert.equal(closeCalled, 1, 'cancel() MUST close the WS');
  assert.equal(closeCode, 1000, 'normal-closure code');
  assert.equal(bridge._turnDead, true, 'turn marked dead — subsequent sendText/turnEnd no-op');
  assert.equal(bridge._cancelled, true, 'audit M2: _cancelled gates downstream fallback emission');
  assert.equal(bridge._currentContextId, null, 'context id nulled');
  // Critically: no 'stop' event sent. Fish has no protocol-level cancel —
  // closing the WS IS the cancel.
  assert.equal(sent.length, 2, 'cancel() MUST NOT send a stop frame');
});

// ── 7. close() is idempotent ──────────────────────────────────────────────

test('7: close() is idempotent and closes any in-flight WS', async () => {
  const { bridge, ws } = makeStubBridge();
  let closeCalled = 0;
  ws.close = () => { closeCalled++; };

  await bridge.close();
  assert.equal(closeCalled, 1);
  assert.equal(bridge._closed, true);

  // Second close is a no-op.
  await bridge.close();
  assert.equal(closeCalled, 1, 'second close() must be a no-op');
});

// ── 8. Inbound finish:error → recoverable error event w/ textSample ───────

test('8: inbound finish error → fatal=false error event, textSample captured, turn dead', () => {
  const { bridge, sent } = makeStubBridge();
  bridge.sendText('Hello world this is the offending text');
  assert.equal(sent.length, 2, 'sendText emits text + flush');

  const events = [];
  const off = bridge.on((e) => events.push(e));

  const frame = encode({
    event: 'finish',
    reason: 'error',
    message: 'fish synthesis failed: invalid reference_id',
  });
  bridge._onMessage(Buffer.from(frame), true);

  const errs = events.filter((e) => e.kind === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].fatal, false, 'per-turn error must be recoverable');
  assert.equal(errs[0].code, 'tts_synthesis_error');
  assert.ok(errs[0].message.includes('invalid reference_id'));
  assert.equal(typeof errs[0].textSample, 'string');
  assert.ok(errs[0].textSample.includes('Hello world'));
  // Turn marked dead → no more sends on this WS.
  assert.equal(bridge._turnDead, true);
  off();
});

// ── 9-12. fallback_required event emission (audit round 3 C4) ─────────────
//
// On pre-first-audio failure (WS close OR finish:error with no audio
// chunks yet), the bridge emits a fallback_required event so the
// orchestrator can re-dispatch the SAME turn to cartesia-bridge inline.
// Once first audio has flowed, NO fallback (voice-mid-switch is worse UX
// than the error itself).

test('9: finish:error pre-first-audio → fallback_required emitted with text sample', () => {
  const { bridge } = makeStubBridge();
  bridge.sendText('What does success look like?');
  // No audio chunks delivered yet.

  const events = [];
  const off = bridge.on((e) => events.push(e));

  const frame = encode({ event: 'finish', reason: 'error', message: 'synth failed' });
  bridge._onMessage(Buffer.from(frame), true);

  const fallbacks = events.filter((e) => e.kind === 'fallback_required');
  assert.equal(fallbacks.length, 1, 'pre-first-audio finish:error MUST emit fallback_required');
  assert.equal(fallbacks[0].code, 'finish_error_pre_first_audio');
  assert.equal(fallbacks[0].contextId, 'sess-1:1');
  assert.ok(fallbacks[0].textSample.includes('success look like'));
  // The regular error event also fires (orchestrator may want both).
  assert.equal(events.filter((e) => e.kind === 'error').length, 1);
  off();
});

test('10: finish:error AFTER first audio → NO fallback_required (voice-mid-switch is worse UX)', () => {
  const { bridge } = makeStubBridge();
  bridge.sendText('First chunk');
  // Stream a real audio chunk so _firstAudioReceived = true.
  const audioFrame = encode({ event: 'audio', audio: new Uint8Array([1, 2, 3, 4]) });
  bridge._onMessage(Buffer.from(audioFrame), true);
  assert.equal(bridge._firstAudioReceived, true);

  const events = [];
  const off = bridge.on((e) => events.push(e));

  const errFrame = encode({ event: 'finish', reason: 'error', message: 'mid-stream failure' });
  bridge._onMessage(Buffer.from(errFrame), true);

  const fallbacks = events.filter((e) => e.kind === 'fallback_required');
  assert.equal(fallbacks.length, 0, 'post-first-audio errors MUST NOT trigger fallback');
  // The regular error event still fires so the orchestrator can clean up.
  assert.equal(events.filter((e) => e.kind === 'error').length, 1);
  off();
});

test('11: WS close pre-first-audio with active turn → fallback_required emitted', () => {
  const { bridge } = makeStubBridge();
  bridge.sendText('Some pending text');
  assert.equal(bridge._firstAudioReceived, false);

  const events = [];
  const off = bridge.on((e) => events.push(e));

  // Simulate ws unexpected close (e.g., network blip mid-turn).
  bridge._onClose(1006, Buffer.from('connection lost'));

  const fallbacks = events.filter((e) => e.kind === 'fallback_required');
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].code, 'ws_closed_pre_first_audio');
  assert.equal(fallbacks[0].contextId, 'sess-1:1');
  // closed event still fires AFTER fallback_required.
  const closed = events.filter((e) => e.kind === 'closed');
  assert.equal(closed.length, 1);
  off();
});

test('12: WS close AFTER first audio → NO fallback_required, only closed event', () => {
  const { bridge } = makeStubBridge();
  bridge.sendText('Some text');
  const audioFrame = encode({ event: 'audio', audio: new Uint8Array([0xaa, 0xbb]) });
  bridge._onMessage(Buffer.from(audioFrame), true);
  assert.equal(bridge._firstAudioReceived, true);

  const events = [];
  const off = bridge.on((e) => events.push(e));

  bridge._onClose(1006, Buffer.from('connection lost'));

  const fallbacks = events.filter((e) => e.kind === 'fallback_required');
  assert.equal(fallbacks.length, 0, 'post-first-audio close MUST NOT emit fallback');
  assert.equal(events.filter((e) => e.kind === 'closed').length, 1);
  off();
});

// ── 13-14. Pricing validators (plan §5 #5 / audit round 1 C4) ────────────

test('13: assertFishPricing throws on missing or non-finite-positive FISH_USD_PER_CHAR', () => {
  assert.throws(
    () => assertFishPricing({ env: { FISH_QUOTED_AT: '2026-05-28' } }),
    /FISH_USD_PER_CHAR missing or non-finite-positive/,
  );
  assert.throws(
    () => assertFishPricing({ env: { FISH_USD_PER_CHAR: 'not-a-number', FISH_QUOTED_AT: '2026-05-28' } }),
    /FISH_USD_PER_CHAR missing or non-finite-positive/,
  );
  assert.throws(
    () => assertFishPricing({ env: { FISH_USD_PER_CHAR: '0', FISH_QUOTED_AT: '2026-05-28' } }),
    /FISH_USD_PER_CHAR missing or non-finite-positive/,
  );
  assert.throws(
    () => assertFishPricing({ env: { FISH_USD_PER_CHAR: '-0.001', FISH_QUOTED_AT: '2026-05-28' } }),
    /FISH_USD_PER_CHAR missing or non-finite-positive/,
  );
  // QUOTED_AT bad format.
  assert.throws(
    () => assertFishPricing({ env: { FISH_USD_PER_CHAR: '0.000015', FISH_QUOTED_AT: '05/28/2026' } }),
    /FISH_QUOTED_AT must be a YYYY-MM-DD/,
  );
  assert.throws(
    () => assertFishPricing({ env: { FISH_USD_PER_CHAR: '0.000015', FISH_QUOTED_AT: 'yes' } }),
    /FISH_QUOTED_AT must be a YYYY-MM-DD/,
  );
  // Valid env returns shape.
  const r = assertFishPricing({ env: { FISH_USD_PER_CHAR: '0.000015', FISH_QUOTED_AT: '2026-05-28' } });
  assert.equal(r.usdPerChar, 0.000015);
  assert.equal(r.quotedAt, '2026-05-28');
});

test('14: validateFishPricingOrExit calls exit(1) on bad env, returns shape on good env', () => {
  let exitedWith = null;
  const logged = [];
  const r1 = validateFishPricingOrExit({
    env: {},
    exit: (n) => { exitedWith = n; return undefined; },
    log: (s) => logged.push(s),
  });
  assert.equal(exitedWith, 1, 'missing env MUST exit(1)');
  assert.equal(r1, undefined);
  assert.ok(logged.some((s) => /FATAL.*FISH_USD_PER_CHAR/.test(s)), 'logs the FATAL reason');

  exitedWith = null;
  const r2 = validateFishPricingOrExit({
    env: { FISH_USD_PER_CHAR: '0.000015', FISH_QUOTED_AT: '2026-05-28' },
    exit: (n) => { exitedWith = n; return undefined; },
    log: () => {},
  });
  assert.equal(exitedWith, null, 'valid env MUST NOT exit');
  assert.deepEqual(r2, { usdPerChar: 0.000015, quotedAt: '2026-05-28' });
});

// ── 15-16. Speculative prewarmTurn (Phase 0.5 #2 mandatory) ──────────────

test('15: prewarmTurn is a no-op if WS already open (idempotent)', () => {
  const { bridge } = makeStubBridge({ sentStart: false });
  // bridge._ws is already set by makeStubBridge.
  bridge._prewarmPromise = null;
  bridge.prewarmTurn('sess-1:7');
  assert.equal(bridge._prewarmPromise, null, 'prewarm MUST NOT kick off when _ws already set');
});

test('16: prewarmTurn is idempotent across multiple calls before WS opens', () => {
  // Build a bridge with no stub _ws so prewarmTurn would actually want to open.
  // We then immediately overwrite _ws to short-circuit — the test asserts the
  // second call to prewarmTurn doesn't try to open a second WS.
  const bridge = new FishTTSBridge({
    apiKey: 'k',
    voiceId: 'v',
    pricing: VALID_PRICING,
  });
  // Stub the WS opener to capture how many times it would have been called.
  let openCalls = 0;
  bridge._openWsOnly = async () => {
    openCalls++;
    bridge._ws = { readyState: 1, send: () => {}, close: () => {}, terminate: () => {} };
  };

  bridge.prewarmTurn('sess-1:1');
  bridge.prewarmTurn('sess-1:1');  // second call — should be a no-op
  bridge.prewarmTurn('sess-1:2');  // different contextId — still no-op (warm WS reused)
  assert.equal(openCalls, 1, 'prewarm MUST open at most one WS regardless of repeat calls');
});

// ── 17-19. Proxy-handlers fish-pricing singleton wrappers ────────────────

test('17: _fishPricingPrimeForBoot mustValidate=false caches valid env', async () => {
  const { _fishPricingPrimeForBoot, getFishPricing, _fishPricingResetForTests } =
    await import('./proxy-handlers.js');
  _fishPricingResetForTests();
  const prev = { u: process.env.FISH_USD_PER_CHAR, q: process.env.FISH_QUOTED_AT };
  try {
    process.env.FISH_USD_PER_CHAR = '0.000015';
    process.env.FISH_QUOTED_AT = '2026-05-28';
    const r = _fishPricingPrimeForBoot({ mustValidate: false });
    assert.deepEqual(r, { usdPerChar: 0.000015, quotedAt: '2026-05-28' });
    // Subsequent getFishPricing() hits the cached singleton, no env re-read.
    process.env.FISH_USD_PER_CHAR = 'BREAK_IF_RE_READ';
    assert.deepEqual(getFishPricing(), { usdPerChar: 0.000015, quotedAt: '2026-05-28' });
  } finally {
    process.env.FISH_USD_PER_CHAR = prev.u;
    process.env.FISH_QUOTED_AT = prev.q;
    _fishPricingResetForTests();
  }
});

test('18: _fishPricingPrimeForBoot mustValidate=false on bad env → warns, sets probeFailed, no exit', async () => {
  const { _fishPricingPrimeForBoot, _fishPricingResetForTests } =
    await import('./proxy-handlers.js');
  _fishPricingResetForTests();
  const prev = { u: process.env.FISH_USD_PER_CHAR, q: process.env.FISH_QUOTED_AT };
  const origWarn = console.warn;
  const warns = [];
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    delete process.env.FISH_USD_PER_CHAR;
    delete process.env.FISH_QUOTED_AT;
    const r = _fishPricingPrimeForBoot({ mustValidate: false });
    assert.equal(r, null, 'mustValidate=false MUST return null on failure (no exit)');
    assert.ok(
      warns.some((s) => /WARN at boot.*FISH_USD_PER_CHAR/.test(s)),
      'MUST log a WARN with the underlying reason',
    );
  } finally {
    console.warn = origWarn;
    if (prev.u != null) process.env.FISH_USD_PER_CHAR = prev.u;
    if (prev.q != null) process.env.FISH_QUOTED_AT = prev.q;
    _fishPricingResetForTests();
  }
});

test('19: getFishPricing throws cleanly when probeFailed AND env still missing (per-session 1011)', async () => {
  const { _fishPricingPrimeForBoot, getFishPricing, _fishPricingResetForTests } =
    await import('./proxy-handlers.js');
  _fishPricingResetForTests();
  const prev = { u: process.env.FISH_USD_PER_CHAR, q: process.env.FISH_QUOTED_AT };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    delete process.env.FISH_USD_PER_CHAR;
    delete process.env.FISH_QUOTED_AT;
    _fishPricingPrimeForBoot({ mustValidate: false }); // sets _fishProbeFailed
    // Audit M6 — retries the assert; still fails when env still missing.
    assert.throws(() => getFishPricing(), /FISH_USD_PER_CHAR missing or non-finite-positive/);
  } finally {
    console.warn = origWarn;
    if (prev.u != null) process.env.FISH_USD_PER_CHAR = prev.u;
    if (prev.q != null) process.env.FISH_QUOTED_AT = prev.q;
    _fishPricingResetForTests();
  }
});

// ── 20-27. Audit round 3 fixes — explicit coverage of behavior changes ───

test('20: audio chunks AFTER finish are dropped (C5 — _turnFinished gate)', () => {
  const { bridge } = makeStubBridge();
  bridge.sendText('Hello');

  const events = [];
  const off = bridge.on((e) => events.push(e));

  // finish:stop first.
  const finishFrame = encode({ event: 'finish', reason: 'stop' });
  bridge._onMessage(Buffer.from(finishFrame), true);
  assert.equal(bridge._turnFinished, true, 'finish sets _turnFinished');

  // Late audio chunk arrives (Fish protocol doesn't promise finish is terminal).
  const audioFrame = encode({ event: 'audio', audio: new Uint8Array([1, 2, 3]) });
  bridge._onMessage(Buffer.from(audioFrame), true);

  const audioEvents = events.filter((e) => e.kind === 'audio_out');
  assert.equal(audioEvents.length, 0, 'late audio post-finish MUST be dropped');
  assert.equal(bridge._audioBytesThisTurn, 0, 'audio bytes counter MUST NOT advance');
  off();
});

test('21: cancel-then-finish:error skips fallback_required (M2)', () => {
  const { bridge } = makeStubBridge();
  bridge.sendText('Some text');

  bridge.cancel();
  assert.equal(bridge._cancelled, true);

  // Bridge is now cancelled. Fish replays its finish:error from the in-flight buffer.
  // BUT: cancel nulled _currentContextId, so the existing gate already skips
  // fallback. The _cancelled check is defense-in-depth for the alt path where
  // a future code change re-introduces _currentContextId before finish:error.
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._currentContextId = 'sess-1:1'; // simulate a regression that left ctx set
  const errFrame = encode({ event: 'finish', reason: 'error', message: 'late err' });
  bridge._onMessage(Buffer.from(errFrame), true);

  const fallbacks = events.filter((e) => e.kind === 'fallback_required');
  assert.equal(fallbacks.length, 0, '_cancelled MUST gate fallback emission');
  off();
});

test('22: cancel-then-WS-close skips fallback_required (M2 consistency with finish:error)', () => {
  const { bridge } = makeStubBridge();
  bridge.sendText('Some text');

  bridge.cancel();
  assert.equal(bridge._cancelled, true);

  // Fish closes the WS after our cancel (normal sequence).
  const events = [];
  const off = bridge.on((e) => events.push(e));
  bridge._currentContextId = 'sess-1:1'; // regression simulation
  bridge._onClose(1006, Buffer.from('peer closed'));

  const fallbacks = events.filter((e) => e.kind === 'fallback_required');
  assert.equal(fallbacks.length, 0, 'cancelled bridge MUST NOT emit ws_closed_pre_first_audio fallback');
  // closed event still fires (orchestrator wants the signal).
  assert.equal(events.filter((e) => e.kind === 'closed').length, 1);
  off();
});

test('23: getFishPricing recovers when FISH_USD_PER_CHAR appears after failed boot probe (M6)', async () => {
  const { _fishPricingPrimeForBoot, getFishPricing, _fishPricingResetForTests } =
    await import('./proxy-handlers.js');
  _fishPricingResetForTests();
  const prev = { u: process.env.FISH_USD_PER_CHAR, q: process.env.FISH_QUOTED_AT };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    delete process.env.FISH_USD_PER_CHAR;
    delete process.env.FISH_QUOTED_AT;
    _fishPricingPrimeForBoot({ mustValidate: false }); // _fishProbeFailed=true
    // Admin sets env without restart.
    process.env.FISH_USD_PER_CHAR = '0.000015';
    process.env.FISH_QUOTED_AT = '2026-05-28';
    const r = getFishPricing();
    assert.deepEqual(r, { usdPerChar: 0.000015, quotedAt: '2026-05-28' });
    // Subsequent calls hit the cached singleton.
    process.env.FISH_USD_PER_CHAR = 'BREAK_IF_RE_READ';
    const r2 = getFishPricing();
    assert.deepEqual(r2, { usdPerChar: 0.000015, quotedAt: '2026-05-28' });
  } finally {
    console.warn = origWarn;
    if (prev.u != null) process.env.FISH_USD_PER_CHAR = prev.u; else delete process.env.FISH_USD_PER_CHAR;
    if (prev.q != null) process.env.FISH_QUOTED_AT = prev.q; else delete process.env.FISH_QUOTED_AT;
    _fishPricingResetForTests();
  }
});

test('24: bearer token in WS error message is redacted before emit (C4)', () => {
  const { bridge } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));

  // Simulate a ws library error whose message accidentally carried the bearer.
  bridge._onError({ message: 'open failed; Authorization: Bearer fk_sensitive_token_xxx in request headers' });

  const errs = events.filter((e) => e.kind === 'error');
  assert.equal(errs.length, 1);
  assert.ok(!errs[0].message.includes('fk_sensitive_token_xxx'), 'bearer token MUST be redacted');
  assert.ok(errs[0].message.includes('<redacted>'), 'redaction placeholder MUST appear');
  off();
});

test('25: turnEnd called without turnStart cleans up orphan prewarm (M3)', async () => {
  const bridge = new FishTTSBridge({
    apiKey: 'k', voiceId: 'v', pricing: VALID_PRICING,
  });
  // Simulate a successful prewarm: WS is open, sentStart is still false.
  let closeCalls = 0;
  bridge._ws = {
    readyState: 1,
    send: () => {},
    close: (code, reason) => { closeCalls++; },
    terminate: () => {},
  };
  bridge._prewarmPromise = Promise.resolve();
  bridge._prewarmContextId = 'sess-1:1';
  bridge._closed = false;

  const r = await bridge.turnEnd();

  assert.deepEqual(r, { characters: 0, audioBytes: 0, audioSeconds: 0, partial: false });
  assert.equal(closeCalls, 1, 'orphan prewarmed WS MUST be closed by turnEnd');
  assert.equal(bridge._prewarmPromise, null);
  assert.equal(bridge._ws, null);
});

test('26: prewarm_ok emitted on success; only fallback_required (NOT prewarm_failed) on open error (M5 / C-R2-3)', async () => {
  // Success path — prewarm_ok signals "wire is hot, brain-spend safe".
  const okBridge = new FishTTSBridge({
    apiKey: 'k', voiceId: 'v', pricing: VALID_PRICING,
  });
  okBridge._openWsOnly = async () => {
    okBridge._ws = { readyState: 1, send: () => {}, close: () => {}, terminate: () => {} };
  };
  const okEvents = [];
  const offOk = okBridge.on((e) => okEvents.push(e));
  okBridge.prewarmTurn('sess-1:1');
  await okBridge._prewarmPromise;
  assert.equal(okEvents.filter((e) => e.kind === 'prewarm_ok').length, 1, 'success MUST emit prewarm_ok');
  assert.equal(okEvents.filter((e) => e.kind === 'fallback_required').length, 0);
  offOk();

  // Failure path — ONE event per failure (C-R2-3). Dropping prewarm_failed
  // to avoid double-dispatch by an orchestrator listening on both channels.
  // `fallback_required.code='prewarm_open_failed'` is the canonical signal.
  const badBridge = new FishTTSBridge({
    apiKey: 'k', voiceId: 'v', pricing: VALID_PRICING,
  });
  badBridge._openWsOnly = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const badEvents = [];
  const offBad = badBridge.on((e) => badEvents.push(e));
  badBridge.prewarmTurn('sess-1:2');
  // Capture the promise BEFORE letting the catch run — without a swallow
  // the rethrow would become unhandled (the bridge's own catch attaches
  // via `.then(success, failure)` which doesn't re-attach a `.catch`).
  const inflight = badBridge._prewarmPromise;
  inflight.catch(() => {});
  await inflight.then(() => {}, () => {});
  assert.equal(badEvents.filter((e) => e.kind === 'fallback_required').length, 1, 'failure MUST emit fallback_required');
  assert.equal(badEvents.filter((e) => e.kind === 'prewarm_failed').length, 0, 'C-R2-3: prewarm_failed dropped to avoid double-dispatch');
  assert.equal(badEvents.find((e) => e.kind === 'fallback_required').code, 'prewarm_open_failed');
  offBad();
});

test('27: cancel during in-flight prewarm skips fallback_required emission (C3)', async () => {
  const bridge = new FishTTSBridge({
    apiKey: 'k', voiceId: 'v', pricing: VALID_PRICING,
  });
  // Build a manually-controlled open promise so we can cancel between
  // prewarmTurn() and the promise resolution.
  let rejectOpen;
  bridge._openWsOnly = () => new Promise((_, reject) => { rejectOpen = reject; });
  const events = [];
  const off = bridge.on((e) => events.push(e));

  bridge.prewarmTurn('sess-1:1');
  // Capture the in-flight promise BEFORE cancel() nulls _prewarmPromise.
  const inflight = bridge._prewarmPromise;
  // No need to attach a manual swallow catch — cancel() does it (C-R2-1).
  bridge.cancel();
  assert.equal(bridge._cancelled, true);

  // NOW the ws open finally rejects.
  rejectOpen(new Error('WebSocket was closed before the connection was established'));
  // Let the catch handler run.
  await inflight.then(() => {}, () => {});

  const fallbacks = events.filter((e) => e.kind === 'fallback_required');
  assert.equal(fallbacks.length, 0, 'cancel-during-prewarm MUST NOT emit fallback_required (user already cancelled)');
  const prewarmFails = events.filter((e) => e.kind === 'prewarm_failed');
  assert.equal(prewarmFails.length, 0, 'cancel-during-prewarm MUST NOT emit prewarm_failed either');
  off();
});

// ── 28-31. Audit round 2 fixes ────────────────────────────────────────────

test('28: cancel during in-flight prewarm does NOT trigger unhandledRejection (C-R2-1)', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const bridge = new FishTTSBridge({
      apiKey: 'k', voiceId: 'v', pricing: VALID_PRICING,
    });
    let rejectOpen;
    bridge._openWsOnly = () => new Promise((_, reject) => { rejectOpen = reject; });
    bridge.prewarmTurn('sess-1:1');
    // Production path: cancel WITHOUT capturing the promise externally.
    // C-R2-1 fix means cancel() attaches its own swallow-catch before
    // nulling _prewarmPromise. Without the fix, the eventual reject would
    // surface as an unhandledRejection event.
    bridge.cancel();
    rejectOpen(new Error('WebSocket was closed before the connection was established'));
    // Let microtasks flush so unhandledRejection (if any) fires.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(unhandled.length, 0, 'cancel() MUST attach swallow-catch before nulling _prewarmPromise');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('29: cancel resets turn metrics to zero (M-R2-6 — defense vs accidental cancelled-turn billing)', () => {
  const { bridge } = makeStubBridge();
  bridge.sendText('Hello world, some text we cancel partway through');
  assert.ok(bridge._charsThisTurn > 0, 'pre-cancel: chars accumulated');

  bridge.cancel();

  assert.equal(bridge._charsThisTurn, 0, 'cancel zeros _charsThisTurn');
  assert.equal(bridge._audioBytesThisTurn, 0, 'cancel zeros _audioBytesThisTurn');
  assert.equal(bridge._sentFirstChunkOfTurn, false);
  assert.equal(bridge._firstAudioReceived, false);
  assert.equal(bridge._currentTurnTextSample, '');
});

test('30: bearer redactor catches base64-shaped tokens (+/= chars) — M-R2-3', () => {
  const { bridge } = makeStubBridge();
  const events = [];
  const off = bridge.on((e) => events.push(e));

  // Base64-ish token with +/= chars (Cartesia-style; future-proofing).
  bridge._onError({ message: 'auth failed; Authorization: Bearer aBc+DeF/GhIj==KlMn in headers' });

  const errs = events.filter((e) => e.kind === 'error');
  assert.equal(errs.length, 1);
  assert.ok(!errs[0].message.includes('aBc+DeF/GhIj==KlMn'), 'base64 token MUST be redacted');
  assert.ok(errs[0].message.includes('<redacted>'));
  off();
});

test('31: numeric msg.event types are debug-logged, not silently dropped (M-R2-7)', () => {
  const { bridge } = makeStubBridge();
  const origDebug = console.debug;
  const debugs = [];
  console.debug = (...args) => debugs.push(args.join(' '));
  try {
    // Numeric event (msgpack permits this).
    const frame = encode({ event: 42, payload: 'hi' });
    bridge._onMessage(Buffer.from(frame), true);
    assert.ok(
      debugs.some((s) => /unknown event type/.test(s) && /42/.test(s)),
      'numeric event MUST be debug-logged',
    );
  } finally {
    console.debug = origDebug;
  }
});
