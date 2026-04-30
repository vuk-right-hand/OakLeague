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
// Decimation lives in mic-decimate.js (pure function, unit-tested). See
// SPIKE_A_DEFERRED_FIXUP_PLAN.md §2A for the carry-fix rationale.
//
// iOS 15 worklet-module support: this file uses an ES-module `import` from a
// sibling file under public/worklets/. Module workers landed in iOS 15.0;
// AudioWorklet module imports landed in 16.4. If the target floor is iOS
// 15.x and the import fails at addModule time, fall back to inlining
// mic-decimate.js's contents here. Pre-deploy device check: see plan §2A.

import { decimate3to1 } from './mic-decimate.js';

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
