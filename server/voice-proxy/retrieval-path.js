// retrieval-path.js -- single chokepoint for the v1/v2/v3 retrieval dispatch.
//
// THE BUG THIS EXISTS TO PREVENT (plan §5, audit round-3 C-3, round-4 C5).
// The proxy used to enumerate ~9 hardcoded `=== 2` / `version === 2` sites
// each with a silent `else -> v1` fall-through. A v3 session that hit any of
// those sites silently fell through to v1, which queries chunker_version=1
// chunks that don't exist for a v3-reprocessed creator -> ZERO retrieval
// every turn -> "he blanks." The most dangerous offender was the LIVE
// decoupled path (`retrieveEnvelopeForDecoupled`) whose `else` ran
// `retrieveTopK` directly.
//
// THE CHOKEPOINT contract:
//   * Every dispatch site calls `resolveRetrievalPath(version)`.
//   * Returns a string token 'v1' | 'v2' | 'v3'.
//   * THROWS on unknown version. Never silent-default-v1.
//   * A future v4 missed in a refactor fails LOUD at session-open instead
//     of degrading silently to v1.
//
// The spike-a admin-preview path doesn't go through real retrieval (it
// hard-pins v1). It uses the sibling `assertRetrievalPathSupportedOnSpike()`
// which probes a creator's retrieval_version and warns when admin is
// about to dogfood a v2/v3 creator on the v1 spike-a path (zero retrieval
// expected).

export class UnknownRetrievalVersionError extends Error {
  /** @param {unknown} version */
  constructor(version) {
    super(
      `unknown retrieval_version=${String(version)} -- expected one of: 1, 2, 3. `
      + 'A new retrieval_version landed without updating resolveRetrievalPath '
      + '(plan §5 chokepoint). Add the path here BEFORE flipping any creator.',
    );
    this.name = 'UnknownRetrievalVersionError';
    /** @type {unknown} */
    this.version = version;
  }
}

/**
 * Map a creator's retrieval_version to a path token. Throws loud on unknown.
 *
 * Strict: only accepts a number (supabase-js returns smallint as number, so
 * any string at this layer means a caller bug). No silent Number() coercion
 * because 'foo' -> NaN -> throws is the same outcome but '2' -> 2 would
 * silently succeed -- and we want EVERY non-canonical input to fail loud,
 * including string-numerics that suggest a body deserialization drift.
 *
 * @param {number | null | undefined} version
 * @returns {'v1' | 'v2' | 'v3'}
 */
export function resolveRetrievalPath(version) {
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new UnknownRetrievalVersionError(version);
  }
  if (version === 1) return 'v1';
  if (version === 2) return 'v2';
  if (version === 3) return 'v3';
  throw new UnknownRetrievalVersionError(version);
}

/**
 * Spike-a admin-preview probe. Spike-a hard-pins v1 retrieveTopK; if a
 * creator is at v2 or v3 today, this path returns zero retrieval (the v1
 * RPC filters chunker_version=1 chunks that don't exist for v2/v3-
 * reprocessed creators). Warns loudly AND returns a support verdict so the
 * caller can REFUSE the spike-a session instead of opening one that blanks
 * every turn.
 *
 * Returns `true` if spike-a can serve this version (v1, or unknown/NaN which
 * historically default-pins to v1), `false` for v2/v3 (caller must refuse).
 * Never throws — the caller's probe try/catch treats a throw as non-fatal and
 * would open the blanking session anyway, so the verdict MUST come back as a
 * return value, not an exception. (RAG v3, 2026-06-02: promoted from warn-only
 * to a hard refuse now that a creator is live on v3.)
 *
 * @param {number | null | undefined} version
 * @param {(msg: string) => void} [warn]  -- defaults to console.warn
 * @returns {boolean} true = spike-a supports this version; false = caller refuse
 */
export function assertRetrievalPathSupportedOnSpike(version, warn) {
  const log = warn || ((m) => console.warn(m));
  const n = Number(version);
  if (n === 2) {
    log(
      '[spike-a] creator at retrieval_version=2 but spike-a path hard-pins '
      + 'v1; expect ZERO retrieval (chunker_version=1 filter mismatch). '
      + 'Refusing the spike-a session -- use real /api/sessions/open instead.',
    );
    return false;
  }
  if (n === 3) {
    log(
      '[spike-a] creator at retrieval_version=3 but spike-a path hard-pins '
      + 'v1; expect ZERO retrieval (chunker_version=1 filter mismatch). '
      + 'Refusing the spike-a session -- use real /api/sessions/open instead.',
    );
    return false;
  }
  return true;
}
