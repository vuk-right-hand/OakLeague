// Pure aggregations for the COGS dashboard routes. Extracted from inline
// folds in /api/admin/cogs/live and /api/admin/cogs/historical so they can
// be unit-tested in isolation (vitest, no Next.js boot needed).
//
// Pipeline α' fallback gating: rows with metadata.fallback === 'seconds' are
// counted into a SEPARATE bucket from token-truth rows so the dashboard
// headline never silently merges the two.

export type CogsLiveRow = {
  session_id: string;
  service: string;
  operation: string;
  units: string | number;
  cost_usd: string | number;
  metadata: Record<string, unknown> | null;
};

export type LiveSessionAgg = {
  cost_usd_truth: number;
  cost_usd_fallback: number;
  tts_seconds: number;
  cogs_rows: number;
  cartesia_pending_rows: number;
  leg2_total: number;     // count of voice_audio_out_tokens rows
  leg2_fallback: number;  // count where metadata.fallback === 'seconds'
};

const LEG2_OPERATION = 'voice_audio_out_tokens';
const TTS_AUDIO_OPERATION = 'voice_tts_audio_seconds';

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

export type HistoricalSummary = {
  byOperation: ByOperationAgg[];
  totalUsdTruth: number;
  totalUsdFallback: number;
};

export function aggregateHistoricalSummary(rows: CogsSummaryRow[]): HistoricalSummary {
  const byOp = new Map<string, ByOperationAgg>();
  let totalUsdTruth = 0;
  let totalUsdFallback = 0;

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
  }

  const byOperation = Array.from(byOp.values()).sort(
    (a, b) =>
      (b.cost_usd_truth + b.cost_usd_fallback) -
      (a.cost_usd_truth + a.cost_usd_fallback),
  );
  return { byOperation, totalUsdTruth, totalUsdFallback };
}
