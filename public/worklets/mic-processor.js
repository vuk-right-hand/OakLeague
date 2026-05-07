// mic-processor.js — AudioWorklet for mic capture into Gemini Live.
//
// AudioContext delivers Float32 at the device sample rate (48kHz on most
// devices). Gemini Live wants LE mono PCM16 @ 16kHz. We downsample 3:1
// (assumes 48k input), clip to [-1, 1], convert to int16, and post 40ms
// frames (640 samples @ 16kHz = 1280 bytes) to the main thread.
//
// iOS Safari quirk: large postMessage payloads can jank — 40ms frames stay
// under the 1KB-ish threshold. Base64 + chunking happens in the main thread
// (the worklet hands off raw ArrayBuffers via transferList).
//
// Lifecycle: main thread sends { type: 'stop' } to drain + exit.
//
// Phase 0.5 (2026-05-07). The decimate3to1 helper used to live in a
// sibling module imported via `import { decimate3to1 } from './mic-decimate.js'`.
// AudioWorklet module imports only landed in iOS Safari 16.4 — older iOS
// (15.x, 16.0–16.3) silently fail to load the worklet, no `mic.first_frame`
// ever flows to the proxy, and the session looks like a frozen "avatar TTL
// expired." Inlined the helper here so the worklet has zero imports and
// loads on every iOS ≥15.0. Source-of-truth + unit tests still live in
// public/worklets/mic-decimate.js — keep them in sync if you tweak.

function decimate3to1(input, state) {
  const phase = state.phase | 0;
  if (input.length === 0) {
    return new Float32Array(0);
  }
  if (phase >= input.length) {
    state.phase = phase - input.length;
    return new Float32Array(0);
  }
  const outLen = Math.ceil((input.length - phase) / 3);
  const out = new Float32Array(outLen);
  let di = 0;
  for (let i = phase; i < input.length; i += 3) {
    out[di++] = input[i];
  }
  const remainder = (input.length - phase) % 3;
  state.phase = (3 - remainder) % 3;
  return out;
}

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf16k = new Int16Array(640); // 40ms @ 16k
    this._fill = 0;
    this._stopped = false;
    // Owned by decimate3to1 — phase 0..2; caller passes the same object back.
    // A fresh worklet instance starts at phase=0 (drops sample 0 of the very
    // first chunk only on the first call where phase=0; subsequent chunks
    // resume continuously). See plan §2B M5 caveat.
    this._decimateState = { phase: 0 };

    this.port.onmessage = (e) => {
      if (e.data?.type === 'stop') this._stopped = true;
    };
  }

  process(inputs) {
    if (this._stopped) return false;

    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0 || ch0.length === 0) return true;

    const decimated = decimate3to1(ch0, this._decimateState);
    for (let i = 0; i < decimated.length; i++) {
      let s = decimated[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      this._buf16k[this._fill++] = (s < 0 ? s * 0x8000 : s * 0x7fff) | 0;

      if (this._fill === this._buf16k.length) {
        const out = new Int16Array(this._buf16k);
        this.port.postMessage({ type: 'frame', pcm: out.buffer }, [out.buffer]);
        this._fill = 0;
      }
    }

    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
