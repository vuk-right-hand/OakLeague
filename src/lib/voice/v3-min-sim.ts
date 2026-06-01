// RAG v3 per-rank-mode min-similarity floors + env override.
//
// The floors gate which child chunks survive scoped topk; below the floor →
// dropped. v2's flat 0.30 was tuned for SUM-RRF and is meaningless for MAX-child
// ranking, so v3 carries a per-mode map.
//
// CALIBRATED 2026-06-01 (scripts/diag-eval-v3.mjs sweep, aod corpus, 21 sec /
// 166 units / 273 chunks, 113 grid points): topk_min_sim has NO effect on recall
// across [0, 0.3] for either rank mode at any S/λ — the floor is a precision /
// off-topic-rejection knob, not a recall lever. Off-topic queries already return
// EMPTY at floor 0 (routing/scoping does the rejection; preflight 2/2 verified),
// so these floors don't drop on-domain hits and a clean-empty result genuinely
// means off-domain. The values below are therefore validated-safe (0.20 has wide
// headroom — recall is flat to 0.30). Env override stays available to re-pin if a
// future, larger corpus moves the optimum.
//
// Env override (added with P0-3): each mode can be overridden by an env var so
// the harness output can be pinned WITHOUT a code edit. A value must parse to a
// finite number in (0, 1] — anything else (NaN, ≤0, >1, e.g. a cosine floor of
// 1.5 that would nuke EVERY child → every turn reads as off-domain) is REJECTED
// and falls back to the placeholder, logged loudly. Absent vars are the expected
// pre-calibration state and stay silent. When at least one override IS set, the
// modes still on placeholders are logged once so a partial override during a
// calibration sweep (only `max_blend` is prod-frozen) is never silent.

export type V3RankMode = 'max' | 'max_blend' | 'vec_max' | 'best_child';

// Per-mode floors (audit M4; calibrated 2026-06-01 — see header). max-rrf modes
// need a LOWER floor than pure-cosine vec_max. Validated recall-safe by the aod
// sweep; env override re-pins them without a code edit. (Name kept _PLACEHOLDERS
// for the env-override contract: these are the values used when no env is set.)
export const V3_MIN_SIM_PLACEHOLDERS: Record<V3RankMode, number> = {
  max: 0.20, // MAX(rrf) needs a low floor (rrf scale ~0.01-0.03)
  max_blend: 0.20, // MAX(rrf) + lambda*ln boost — same scale concerns
  vec_max: 0.40, // pure cosine — gate higher to avoid distant ranks
  best_child: 0.20, // MAX(rrf) flavor
};

const V3_MIN_SIM_ENV_KEYS: Record<V3RankMode, string> = {
  max: 'V3_MIN_SIM_MAX',
  max_blend: 'V3_MIN_SIM_MAX_BLEND',
  vec_max: 'V3_MIN_SIM_VEC_MAX',
  best_child: 'V3_MIN_SIM_BEST_CHILD',
};

type EnvLike = Record<string, string | undefined>;

/**
 * Resolve the per-mode floors, applying valid env overrides over the
 * placeholders. Pure (env injected) so it's unit-testable without re-importing.
 * Invalid overrides fall back to the placeholder and are collected for logging.
 */
export function resolveV3MinSimByMode(
  env: EnvLike = process.env,
  log: (msg: string) => void = (m) => console.warn(m),
): Record<V3RankMode, number> {
  const out: Record<V3RankMode, number> = { ...V3_MIN_SIM_PLACEHOLDERS };
  const rejected: string[] = [];
  const onPlaceholder: V3RankMode[] = [];
  let anyOverride = false;

  for (const mode of Object.keys(V3_MIN_SIM_PLACEHOLDERS) as V3RankMode[]) {
    const key = V3_MIN_SIM_ENV_KEYS[mode];
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') {
      onPlaceholder.push(mode);
      continue; // absent → placeholder (expected pre-calibration; silent)
    }
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0 && v <= 1) {
      out[mode] = v;
      anyOverride = true;
    } else {
      rejected.push(`${key}=${JSON.stringify(raw)}`);
      onPlaceholder.push(mode);
    }
  }

  if (rejected.length > 0) {
    log(
      `[v3-min-sim] REJECTED min_sim env override(s) — value must be a finite number in (0, 1]; ` +
        `using placeholder floor instead: ${rejected.join(', ')}`,
    );
  }
  // Surface partial overrides during a calibration run: if SOME modes were set
  // but others are still on placeholders, say which — so a sweep that switches
  // rankMode doesn't silently measure against an un-pinned default.
  if (anyOverride && onPlaceholder.length > 0) {
    log(
      `[v3-min-sim] min_sim override active but these modes are still on PLACEHOLDER floors: ` +
        `${onPlaceholder.join(', ')} (set ${onPlaceholder.map((m) => V3_MIN_SIM_ENV_KEYS[m]).join(', ')} to pin them)`,
    );
  }
  return out;
}
