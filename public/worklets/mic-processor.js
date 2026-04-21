// mic-processor.js — AudioWorklet for Spike A mic capture.
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

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf16k = new Int16Array(640); // 40ms @ 16k
    this._fill = 0;
    this._stopped = false;
    this._carry = 0; // fractional sample carry for naive 3:1 decimation

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

    // Naive 3:1 decimation. Good enough for 16kHz voice — Gemini Live
    // server-VAD and ASR front-end both tolerate mild aliasing above 8kHz.
    // Day 5 hardening: swap for polyphase FIR if iOS LTE reveals artifacts.
    const decimated = new Float32Array(Math.ceil(ch0.length / 3));
    let di = 0;
    for (let i = this._carry; i < ch0.length; i += 3) {
      decimated[di++] = ch0[i];
    }
    this._carry = (this._carry + 3 - (ch0.length % 3)) % 3;

    for (let i = 0; i < di; i++) {
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
