// halfvec.ts — pgvector halfvec(768) <-> JS number array bridge.
//
// PostgREST sends `halfvec` over the wire as text (the bracket form
// `[0.1,0.2,...]`). Supabase JS client doesn't auto-coerce JS arrays to
// halfvec, so callers send the text form themselves.
//
// Canonical implementation. Both `src/lib/voice/*.ts` callers (Day 9
// semantic-cache, future retrieve-knowledge.ts) and the Fly proxy's
// `embed-client.js` mirror this — proxy-side stays inline because Node
// ESM rejects `.ts` imports (2026-05-09 learning), but the TS file is
// the canonical source of truth for the TS tree.

export const HALFVEC_DIM = 768;

/**
 * Convert a 768-element number array to pgvector halfvec text representation.
 *
 * Length validation: caller's responsibility — kept out of the hot path.
 *
 * NaN / Infinity policy: THROW (Day-9-cross M4 reversal). The earlier
 * "silently replace with 0" policy was unsafe — a poisoned all-zero
 * embedding would write a cache row that subsequent zero-vector queries
 * match (cosine of zero vs zero is undefined in pgvector and varies
 * across versions). Better to fail loud at the boundary and let the
 * caller decide. Embedding pipeline should never produce non-finite
 * values; if it does, that's a real bug worth surfacing.
 *
 * @throws VectorEncodingError on non-finite values
 * @example
 *   vectorToPgText([0, 0, 0.5, ...]) === '[0,0,0.5,...]'
 */
export function vectorToPgText(v: readonly number[]): string {
  const parts: string[] = new Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (!Number.isFinite(x)) {
      throw new VectorEncodingError(
        `non_finite_value_at_${i}: ${x === undefined ? 'undefined' : String(x)}`,
      );
    }
    parts[i] = String(x);
  }
  return '[' + parts.join(',') + ']';
}

export class VectorEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorEncodingError';
  }
}
