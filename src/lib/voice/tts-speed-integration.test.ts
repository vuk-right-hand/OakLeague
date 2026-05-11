// Integration test for the full tts_speed chain:
//   creators.tts_speed (Postgres numeric, comes back as JS string)
//     → /api/sessions/open route Number() coercion
//     → mintVoiceTicket insert with number
//     → voice_tickets row
//     → proxy SELECT + Number() coercion at the ticket boundary
//     → CartesiaTTSBridge constructor
//     → outbound JSON payload: generation_config.speed is a NUMBER
//
// R2 audit M7 + S8 — catches any future regression at any of the four
// numeric→string boundaries where a missing Number() cast would silently
// flip the wire payload from `"speed": 0.85` to `"speed": "0.85"` and
// Cartesia would reject.
//
// This is a node:test-style integration check executed via vitest. It
// does NOT mount the full Next runtime — it directly exercises:
//   1. The bridge's constructor coercion (string → number).
//   2. The bridge's outbound JSON shape (number on the wire).
// The route + proxy boundaries are tested separately in their own files
// with explicit `tts_speed: '0.85'` (string) mock fixtures.

import { describe, it, expect } from 'vitest';
// Cross-package import: server/voice-proxy is a separate Node package
// with no TS declarations. tsc would error implicit-any without this
// suppression; vitest's resolver handles the .js extension fine.
// @ts-expect-error - JS module from sibling package, no .d.ts
import { CartesiaTTSBridge } from '../../../server/voice-proxy/cartesia-bridge.js';

function makeStubBridge(ttsSpeed: unknown) {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: 1, // OPEN
    send: (s: string) => {
      sent.push(JSON.parse(s));
    },
    close: () => {},
    terminate: () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bridge = new (CartesiaTTSBridge as any)({
    apiKey: 'k',
    voiceId: 'voice-uuid-abc',
    ttsSpeed,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bridge as any)._ws = ws;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bridge as any)._closed = false;
  return { bridge, sent };
}

describe('tts_speed end-to-end coercion (R2 audit M7 / S8)', () => {
  it('numeric STRING "0.85" from supabase-js → wire payload number 0.85', () => {
    // Simulate the supabase-js shape: numeric column returns as a JS string.
    // The proxy SHOULD coerce via Number() before passing to bridge, AND
    // the bridge defensively coerces too. This test exercises the bridge's
    // own coercion (the second line of defense).
    const { bridge, sent } = makeStubBridge('0.85');
    bridge.turnStart('sess-1:1');
    bridge.sendText('Hello.');
    expect(sent).toHaveLength(1);
    const payload = sent[0];
    expect(payload.generation_config).toEqual({ speed: 0.85 });
    // Critical: the wire value must be a NUMBER, not a string.
    const config = payload.generation_config as { speed: unknown };
    expect(typeof config.speed).toBe('number');
  });

  it('numeric STRING "1.0" → omitted entirely (Cartesia default no-op)', () => {
    const { bridge, sent } = makeStubBridge('1.0');
    bridge.turnStart('sess-1:1');
    bridge.sendText('Hello.');
    expect(sent).toHaveLength(1);
    expect(sent[0].generation_config).toBeUndefined();
  });

  it('numeric STRING "1.50" (3 sig figs) → wire payload number 1.5', () => {
    const { bridge, sent } = makeStubBridge('1.50');
    bridge.turnStart('sess-1:1');
    bridge.sendText('Hello.');
    expect(sent).toHaveLength(1);
    const config = sent[0].generation_config as { speed: unknown };
    expect(config.speed).toBe(1.5);
    expect(typeof config.speed).toBe('number');
  });

  it('garbage STRING "fast" → falls back to null, omitted from wire', () => {
    const { bridge, sent } = makeStubBridge('fast');
    bridge.turnStart('sess-1:1');
    bridge.sendText('Hello.');
    expect(sent).toHaveLength(1);
    expect(sent[0].generation_config).toBeUndefined();
  });

  it('out-of-range STRING "2.0" → falls back to null, omitted from wire (DB CHECK is the real gate)', () => {
    const { bridge, sent } = makeStubBridge('2.0');
    bridge.turnStart('sess-1:1');
    bridge.sendText('Hello.');
    expect(sent).toHaveLength(1);
    expect(sent[0].generation_config).toBeUndefined();
  });
});
