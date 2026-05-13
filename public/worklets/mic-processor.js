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

// Voice activity detection — RMS over each output frame. Threshold and
// per-frame logic lives here so the main thread doesn't have to redecimate.
// -50 dBFS converted to linear amplitude: 10^(-50/20) ≈ 0.00316.
// Frames with RMS above this are reported as voice activity. Main thread
// uses the message timestamp to drive silence-based auto-stop. False positives
// from background hum slightly above -50 dBFS are acceptable: they delay
// auto-stop, never trigger spurious stops.
const VOICE_RMS_THRESHOLD = 0.00316;

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf16k = new Int16Array(640); // 40ms @ 16k
    // Parallel float32 buffer for RMS calculation. Match the int16 fill cursor
    // — when _fill wraps, both are flushed.
    this._bufF32 = new Float32Array(640);
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
      this._buf16k[this._fill] = (s < 0 ? s * 0x8000 : s * 0x7fff) | 0;
      this._bufF32[this._fill] = s;
      this._fill += 1;

      if (this._fill === this._buf16k.length) {
        // RMS over the just-completed 40ms frame. Cheap: one sqrt + one
        // compare per frame (~25 frames/sec).
        let sumSq = 0;
        for (let k = 0; k < this._bufF32.length; k++) {
          const v = this._bufF32[k];
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / this._bufF32.length);
        if (rms >= VOICE_RMS_THRESHOLD) {
          // Tiny payload — main thread treats any arrival as "voice activity
          // observed at this timestamp." No need to send the RMS value itself.
          this.port.postMessage({ type: 'voice_activity' });
        }
        const out = new Int16Array(this._buf16k);
        this.port.postMessage({ type: 'frame', pcm: out.buffer }, [out.buffer]);
        this._fill = 0;
      }
    }

    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
