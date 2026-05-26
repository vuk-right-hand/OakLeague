// Pure aggregations for the COGS dashboard routes. Extracted from inline
// folds in /api/admin/cogs/live and /api/admin/cogs/historical so they can
// be unit-tested in isolation (vitest, no Next.js boot needed).
//
// Pipeline α' fallback gating: rows with metadata.fallback === 'seconds' are
// counted into a SEPARATE bucket from token-truth rows so the dashboard
// headline never silently merges the two.
//
// HUME_TTS_PLAN §6.12 — provider-aware aggregator. Every cogs row written by
// `cogs_insert_turn_voice_v2` (proxy §6.10) carries `metadata.tts_provider`
// = 'cartesia' | 'hume'. Pre-v2 rows lack the key; we tag those as 'cartesia'
// (the only provider that existed). Mixed sessions impossible by §6.6
// session-locked provider rule, but the aggregator handles the 'mixed' case
// defensively so a future swap-with-bug surfaces visibly instead of silent.

export type CogsLiveRow = {
  session_id: string;
  service: string;
  operation: string;
  units: string | number;
  cost_usd: string | number;
  metadata: Record<string, unknown> | null;
};

export type TtsProviderTag = 'cartesia' | 'hume' | 'mixed' | null;

export type LiveSessionAgg = {
  cost_usd_truth: number;
  cost_usd_fallback: number;
  tts_seconds: number;
  cogs_rows: number;
  cartesia_pending_rows: number;
  leg2_total: number;     // count of voice_audio_out_tokens rows
  leg2_fallback: number;  // count where metadata.fallback === 'seconds'
  // HUME_TTS_PLAN §6.12 — provider-aware buckets.
  tts_provider: TtsProviderTag;
  cost_usd_cartesia: number;
  cost_usd_hume: number;
  // Capped-turn signal (§6.9 C2 fix). Rows written via flushHumeCapExceededCogs
  // carry metadata.tts_cap_exceeded=true. Dashboard surface for "how often
  // does Hume cap fire?" — should be ~zero in steady state.
  tts_cap_exceeded_rows: number;
};

const LEG2_OPERATION = 'voice_audio_out_tokens';
const TTS_AUDIO_OPERATION = 'voice_tts_audio_seconds';

// HUME_TTS_PLAN §6.12 — derive the row's provider from metadata. Pre-v2
// rows have no key and are tagged 'cartesia' (the only provider that
// existed before this PR), BUT only for TTS-bearing services.
// Audit small fix: a row from `service='gemini'` is NOT a TTS row — it
// belongs to no provider bucket. Tagging it cartesia would inflate the
// cartesia totals with Gemini's audio-in / audio-out cost.
const TTS_SERVICES = new Set(['cartesia', 'hume']);
function rowProvider(r: { service: string; metadata: Record<string, unknown> | null }): 'cartesia' | 'hume' | null {
  if (!TTS_SERVICES.has(r.service)) return null;
  const v = r.metadata?.['tts_provider'];
  if (v === 'hume') return 'hume';
  return 'cartesia';
}

function mergeProviderTag(existing: TtsProviderTag, next: 'cartesia' | 'hume'): TtsProviderTag {
  if (existing == null) return next;
  if (existing === 'mixed') return 'mixed';
  return existing === next ? existing : 'mixed';
}

export function aggregateLiveSessions(rows: CogsLiveRow[]): Map<string, LiveSessionAgg> {
  const out = new Map<string, LiveSessionAgg>();
  for (const r of rows) {
    const cur =
      out.get(r.session_id) ??
      ({
        cost_usd_truth: 0,
        cost_usd_fallback: 0,
        tts_seconds: 0,
        cogs_rows: 0,
        cartesia_pending_rows: 0,
        leg2_total: 0,
        leg2_fallback: 0,
        tts_provider: null,
        cost_usd_cartesia: 0,
        cost_usd_hume: 0,
        tts_cap_exceeded_rows: 0,
      } as LiveSessionAgg);

    // Migration 0055 merges p_metadata into ALL four leg INSERTs (lines 124,
    // 135, 146, 159). So a fallback turn writes fallback='seconds' on every
    // row, even though only leg-2 (voice_audio_out_tokens) is actually
    // seconds-derived. Leg-1's cost is truth — `inputSeconds × pinned rate`,
    // not estimated. Gate the cost bucket on the leg-2 operation, not the
    // metadata flag alone, or leg-1 cost gets misclassified as fallback and
    // the headline truth-cost under-reports. (Audit B-1, 2026-04-30.)
    const metaFallback = r.metadata?.['fallback'] === 'seconds';
    const isLeg2Fallback = r.operation === LEG2_OPERATION && metaFallback;
    const cost = Number(r.cost_usd) || 0;
    if (isLeg2Fallback) cur.cost_usd_fallback += cost;
    else cur.cost_usd_truth += cost;

    if (r.operation === TTS_AUDIO_OPERATION) {
      cur.tts_seconds += Number(r.units) || 0;
    }
    if (r.operation === LEG2_OPERATION) {
      cur.leg2_total += 1;
      if (metaFallback) cur.leg2_fallback += 1;
    }
    if (r.metadata?.['cartesia_pending'] === true) {
      cur.cartesia_pending_rows += 1;
    }
    // HUME_TTS_PLAN §6.12 — provider-aware totals + per-row tagging.
    // Non-TTS rows (gemini legs) contribute to neither cartesia nor hume
    // sub-totals — they're scoped to the session's overall cost.
    const prov = rowProvider(r);
    if (prov !== null) {
      cur.tts_provider = mergeProviderTag(cur.tts_provider, prov);
      if (prov === 'hume') cur.cost_usd_hume     += cost;
      else                 cur.cost_usd_cartesia += cost;
    }
    if (r.metadata?.['tts_cap_exceeded'] === true) {
      cur.tts_cap_exceeded_rows += 1;
    }
    cur.cogs_rows += 1;
    out.set(r.session_id, cur);
  }
  return out;
}

export function fallbackRate(agg: LiveSessionAgg): number {
  if (agg.leg2_total === 0) return 0;
  return agg.leg2_fallback / agg.leg2_total;
}

// ── Historical summary ─────────────────────────────────────────────────────

export type CogsSummaryRow = {
  service: string;
  operation: string;
  units: string | number;
  cost_usd: string | number;
  metadata: Record<string, unknown> | null;
};

export type ByOperationAgg = {
  service: string;
  operation: string;
  cost_usd_truth: number;
  cost_usd_fallback: number;
  units: number;
  row_count: number;
  fallback_count: number;
};

// HUME_TTS_PLAN §6.12 — provider × leg breakdown for the dashboard widget.
export type ProviderLegAgg = {
  tts_provider: 'cartesia' | 'hume';
  operation: string;
  cost_usd_truth: number;
  cost_usd_fallback: number;
  units: number;
  row_count: number;
};

export type HistoricalSummary = {
  byOperation: ByOperationAgg[];
  // HUME_TTS_PLAN §6.12 — provider × operation breakdown for the dashboard
  // widget. byOperation keeps the existing service-keyed fold; byProviderLeg
  // surfaces (provider, operation) so cartesia-vs-hume comparisons are
  // first-class. Pre-v2 rows tagged 'cartesia' (only provider that existed).
  byProviderLeg: ProviderLegAgg[];
  totalUsdTruth: number;
  totalUsdFallback: number;
  totalUsdCartesia: number;
  totalUsdHume: number;
};

function rowProviderTag(r: CogsSummaryRow): 'cartesia' | 'hume' | null {
  if (!TTS_SERVICES.has(r.service)) return null;
  const v = r.metadata?.['tts_provider'];
  return v === 'hume' ? 'hume' : 'cartesia';
}

export function aggregateHistoricalSummary(rows: CogsSummaryRow[]): HistoricalSummary {
  const byOp = new Map<string, ByOperationAgg>();
  const byProviderLeg = new Map<string, ProviderLegAgg>();
  let totalUsdTruth = 0;
  let totalUsdFallback = 0;
  let totalUsdCartesia = 0;
  let totalUsdHume = 0;

  for (const r of rows) {
    const cost = Number(r.cost_usd) || 0;
    const units = Number(r.units) || 0;
    // Same gate as aggregateLiveSessions — only leg-2 (voice_audio_out_tokens)
    // rows with metadata.fallback='seconds' are seconds-derived. Other legs
    // carry the flag because migration 0055 merges p_metadata into all four
    // leg INSERTs. (Audit B-1.)
    const metaFallback = r.metadata?.['fallback'] === 'seconds';
    const isLeg2Fallback = r.operation === LEG2_OPERATION && metaFallback;
    if (isLeg2Fallback) totalUsdFallback += cost;
    else totalUsdTruth += cost;

    // Per-operation `fallback_count` keeps the metadata-only signal so we can
    // surface the leg-2 fallback rate. Cost bucketing is the strict gate.
    const fallbackForRow = isLeg2Fallback;

    const key = `${r.service}|${r.operation}`;
    const cur = byOp.get(key);
    if (cur) {
      if (fallbackForRow) cur.cost_usd_fallback += cost;
      else cur.cost_usd_truth += cost;
      cur.units += units;
      cur.row_count += 1;
      if (fallbackForRow) cur.fallback_count += 1;
    } else {
      byOp.set(key, {
        service: r.service,
        operation: r.operation,
        cost_usd_truth: fallbackForRow ? 0 : cost,
        cost_usd_fallback: fallbackForRow ? cost : 0,
        units,
        row_count: 1,
        fallback_count: fallbackForRow ? 1 : 0,
      });
    }

    // HUME_TTS_PLAN §6.12 — provider × leg fold + totals. Non-TTS rows
    // (gemini service) contribute only to the operation-wise total, not
    // to provider sub-totals (audit small fix).
    const prov = rowProviderTag(r);
    if (prov !== null) {
      if (prov === 'hume') totalUsdHume     += cost;
      else                 totalUsdCartesia += cost;
      const pKey = `${prov}|${r.operation}`;
      const pCur = byProviderLeg.get(pKey);
      if (pCur) {
        if (fallbackForRow) pCur.cost_usd_fallback += cost;
        else pCur.cost_usd_truth += cost;
        pCur.units += units;
        pCur.row_count += 1;
      } else {
        byProviderLeg.set(pKey, {
          tts_provider: prov,
          operation: r.operation,
          cost_usd_truth: fallbackForRow ? 0 : cost,
          cost_usd_fallback: fallbackForRow ? cost : 0,
          units,
          row_count: 1,
        });
      }
    }
  }

  const byOperation = Array.from(byOp.values()).sort(
    (a, b) =>
      (b.cost_usd_truth + b.cost_usd_fallback) -
      (a.cost_usd_truth + a.cost_usd_fallback),
  );
  const byProviderLegArr = Array.from(byProviderLeg.values()).sort(
    (a, b) =>
      (b.cost_usd_truth + b.cost_usd_fallback) -
      (a.cost_usd_truth + a.cost_usd_fallback),
  );
  return {
    byOperation,
    byProviderLeg: byProviderLegArr,
    totalUsdTruth,
    totalUsdFallback,
    totalUsdCartesia,
    totalUsdHume,
  };
}
