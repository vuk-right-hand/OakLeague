// Pure 3:1 decimator extracted for testability — see
// SPIKE_A_DEFERRED_FIXUP_PLAN.md §2A. Naive (no anti-alias filter); fine for
// 16kHz voice into Gemini Live. Day 13–14 polish: swap for polyphase FIR if
// iOS LTE shows audible artifacts.
//
// State machine: caller owns `{ phase: 0..2 }` and passes it back on each
// call. Phase = the next index in the *current chunk* we'd emit. After we
// process a chunk of length L, phase advances by `(3 - ((L - phase) % 3)) %
// 3` so emission continues seamlessly into the next chunk.
//
// Property tested in __tests__/mic-decimate.test.ts: feeding N small chunks
// and concatenating outputs is identical to feeding one big buffer in one
// call (continuity across chunk boundaries).

export function decimate3to1(input, state) {
  const phase = state.phase | 0;
  if (input.length === 0) {
    // Empty input — phase unchanged.
    return new Float32Array(0);
  }
  if (phase >= input.length) {
    // Skip the entire chunk; advance phase by `phase - input.length`. This
    // case is rare in practice (chunks are 128 samples; phase is 0..2) but
    // make the math explicit so tests don't trip on edge cases.
    state.phase = phase - input.length;
    return new Float32Array(0);
  }

  const outLen = Math.ceil((input.length - phase) / 3);
  const out = new Float32Array(outLen);
  let di = 0;
  for (let i = phase; i < input.length; i += 3) {
    out[di++] = input[i];
  }

  // Compute the next phase. After emitting indices [phase, phase+3, ..., last]
  // where last < input.length, the "next logical sample" is `last + 3`. Since
  // the next chunk starts at index 0, the new phase is `(last + 3) - input.length`.
  // This simplifies to: (3 - ((input.length - phase) % 3)) % 3.
  const remainder = (input.length - phase) % 3;
  state.phase = (3 - remainder) % 3;

  return out;
}
