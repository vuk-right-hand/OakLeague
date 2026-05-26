// Unit tests for cogs aggregation helpers — Phase 1D dashboard fallback gating.
//
// Locks in: truth-only headline, fallback bucketed separately, cartesia
// pending rows counted but cost=0, fallback rate computation.

import { describe, expect, it } from 'vitest';
import {
  aggregateLiveSessions,
  aggregateHistoricalSummary,
  fallbackRate,
  type CogsLiveRow,
  type CogsSummaryRow,
} from './cogs-aggregations';

const liveRow = (over: Partial<CogsLiveRow>): CogsLiveRow => ({
  session_id: 'S1',
  service: 'gemini',
  operation: 'voice_audio_input_seconds',
  units: 1,
  cost_usd: 0,
  metadata: null,
  ...over,
});

const summaryRow = (over: Partial<CogsSummaryRow>): CogsSummaryRow => ({
  service: 'gemini',
  operation: 'voice_audio_input_seconds',
  units: 1,
  cost_usd: 0,
  metadata: null,
  ...over,
});

describe('aggregateLiveSessions', () => {
  it('headline is truth-only; fallback bucketed separately (leg-2 only)', () => {
    const out = aggregateLiveSessions([
      liveRow({ session_id: 'S1', operation: 'voice_audio_out_tokens', cost_usd: 0.001, metadata: null }),
      liveRow({ session_id: 'S1', operation: 'voice_audio_out_tokens', cost_usd: 0.002, metadata: { fallback: 'seconds' } }),
    ]);
    const agg = out.get('S1')!;
    expect(agg.cost_usd_truth).toBe(0.001);
    expect(agg.cost_usd_fallback).toBe(0.002);
  });

  // Audit B-1 (2026-04-30): migration 0055 merges p_metadata into all 4 leg
  // INSERTs, so a fallback turn writes fallback='seconds' on leg-1 too.
  // Leg-1 cost is `inputSeconds × pinned rate` — truth, not derived. Bug
  // surfaced when non-leg-2 cost was being misclassified as fallback.
  it('B-1 regression: leg-1 cost with fallback metadata is truth, not fallback', () => {
    const out = aggregateLiveSessions([
      liveRow({
        session_id: 'S1',
        operation: 'voice_audio_input_seconds',
        cost_usd: 0.05,
        metadata: { fallback: 'seconds' },
      }),
    ]);
    expect(out.get('S1')!.cost_usd_truth).toBe(0.05);
    expect(out.get('S1')!.cost_usd_fallback).toBe(0);
  });

  it('B-1 regression: full fallback turn — only leg-2 cost goes to fallback bucket', () => {
    // Simulate one fallback turn: 4 rows, all carry metadata.fallback='seconds'
    // because of the p_metadata || jsonb_build_object merge in migration 0055.
    // Truth = leg-1 (0.001) + cartesia legs (0). Fallback = leg-2 (0.002).
    const out = aggregateLiveSessions([
      liveRow({ session_id: 'T1', operation: 'voice_audio_input_seconds', cost_usd: 0.001, metadata: { fallback: 'seconds', cartesia_pending: true } }),
      liveRow({ session_id: 'T1', operation: 'voice_audio_out_tokens',    cost_usd: 0.002, metadata: { fallback: 'seconds', cartesia_pending: true } }),
      liveRow({ session_id: 'T1', operation: 'voice_tts_characters',      cost_usd: 0,     metadata: { fallback: 'seconds', cartesia_pending: true } }),
      liveRow({ session_id: 'T1', operation: 'voice_tts_audio_seconds',   cost_usd: 0,     metadata: { fallback: 'seconds', cartesia_pending: true } }),
    ]);
    const agg = out.get('T1')!;
    expect(agg.cost_usd_truth).toBeCloseTo(0.001, 6);
    expect(agg.cost_usd_fallback).toBeCloseTo(0.002, 6);
    expect(agg.leg2_total).toBe(1);
    expect(agg.leg2_fallback).toBe(1);
    expect(agg.cartesia_pending_rows).toBe(4);
    expect(agg.cogs_rows).toBe(4);
  });

  it('counts cartesia_pending rows separately', () => {
    const out = aggregateLiveSessions([
      liveRow({ session_id: 'S1', metadata: { cartesia_pending: true } }),
      liveRow({ session_id: 'S1', metadata: null }),
      liveRow({ session_id: 'S1', metadata: { cartesia_pending: true } }),
    ]);
    const agg = out.get('S1')!;
    expect(agg.cogs_rows).toBe(3);
    expect(agg.cartesia_pending_rows).toBe(2);
  });

  it('tts_seconds aggregates only on voice_tts_audio_seconds operation', () => {
    const out = aggregateLiveSessions([
      liveRow({ session_id: 'S1', operation: 'voice_tts_audio_seconds', units: 1.5 }),
      liveRow({ session_id: 'S1', operation: 'voice_tts_audio_seconds', units: 2.5 }),
      liveRow({ session_id: 'S1', operation: 'voice_audio_input_seconds', units: 100 }),
    ]);
    expect(out.get('S1')!.tts_seconds).toBe(4);
  });

  it('leg2 fallback counter only counts voice_audio_out_tokens rows', () => {
    const out = aggregateLiveSessions([
      liveRow({ operation: 'voice_audio_out_tokens', metadata: null }),
      liveRow({ operation: 'voice_audio_out_tokens', metadata: { fallback: 'seconds' } }),
      // This is leg-1 with fallback — should NOT count toward leg2 fallback rate.
      liveRow({ operation: 'voice_audio_input_seconds', metadata: { fallback: 'seconds' } }),
    ]);
    const agg = out.get('S1')!;
    expect(agg.leg2_total).toBe(2);
    expect(agg.leg2_fallback).toBe(1);
    expect(fallbackRate(agg)).toBe(0.5);
  });

  it('isolates per-session counters', () => {
    const out = aggregateLiveSessions([
      liveRow({ session_id: 'A', cost_usd: 1.0 }),
      liveRow({ session_id: 'B', cost_usd: 2.0 }),
    ]);
    expect(out.get('A')!.cost_usd_truth).toBe(1.0);
    expect(out.get('B')!.cost_usd_truth).toBe(2.0);
  });

  it('coerces string costs/units (PostgREST returns numerics as strings)', () => {
    const out = aggregateLiveSessions([
      liveRow({ session_id: 'S1', cost_usd: '0.0050' as unknown as string, units: '3.5' as unknown as string, operation: 'voice_tts_audio_seconds' }),
    ]);
    expect(out.get('S1')!.cost_usd_truth).toBeCloseTo(0.005, 6);
    expect(out.get('S1')!.tts_seconds).toBe(3.5);
  });

  it('fallbackRate is 0 when leg2_total is 0 (no division by zero)', () => {
    expect(fallbackRate({
      cost_usd_truth: 0, cost_usd_fallback: 0, tts_seconds: 0,
      cogs_rows: 0, cartesia_pending_rows: 0,
      leg2_total: 0, leg2_fallback: 0,
      tts_provider: null, cost_usd_cartesia: 0, cost_usd_hume: 0,
      tts_cap_exceeded_rows: 0,
    })).toBe(0);
  });

  // HUME_TTS_PLAN §6.12 — provider-aware buckets.

  it('tags provider from metadata.tts_provider; falls back to cartesia when absent', () => {
    // Provider buckets only fold TTS-bearing services (cartesia / hume).
    // Use the appropriate `service` value matching the row's provider.
    const out = aggregateLiveSessions([
      liveRow({ session_id: 'A', service: 'hume',     operation: 'voice_tts_audio_seconds', cost_usd: 0.1, metadata: { tts_provider: 'hume' } }),
      liveRow({ session_id: 'B', service: 'cartesia', operation: 'voice_tts_audio_seconds', cost_usd: 0.2, metadata: { tts_provider: 'cartesia' } }),
      liveRow({ session_id: 'C', service: 'cartesia', operation: 'voice_tts_audio_seconds', cost_usd: 0.3, metadata: null }),
    ]);
    expect(out.get('A')!.tts_provider).toBe('hume');
    expect(out.get('A')!.cost_usd_hume).toBeCloseTo(0.1, 6);
    expect(out.get('B')!.tts_provider).toBe('cartesia');
    expect(out.get('B')!.cost_usd_cartesia).toBeCloseTo(0.2, 6);
    expect(out.get('C')!.tts_provider).toBe('cartesia');
    expect(out.get('C')!.cost_usd_cartesia).toBeCloseTo(0.3, 6);
  });

  it('surfaces mixed when a session sees both providers (defensive — should not happen by §6.6)', () => {
    const out = aggregateLiveSessions([
      liveRow({ session_id: 'M', service: 'cartesia', cost_usd: 0.1, metadata: { tts_provider: 'cartesia' } }),
      liveRow({ session_id: 'M', service: 'hume',     cost_usd: 0.2, metadata: { tts_provider: 'hume' } }),
    ]);
    expect(out.get('M')!.tts_provider).toBe('mixed');
    expect(out.get('M')!.cost_usd_cartesia).toBeCloseTo(0.1, 6);
    expect(out.get('M')!.cost_usd_hume).toBeCloseTo(0.2, 6);
  });

  it('counts tts_cap_exceeded rows separately (§6.9 C2 signal)', () => {
    const out = aggregateLiveSessions([
      liveRow({ session_id: 'X', service: 'hume', cost_usd: 0.01, metadata: { tts_provider: 'hume', tts_cap_exceeded: true } }),
      liveRow({ session_id: 'X', service: 'hume', cost_usd: 0.01, metadata: { tts_provider: 'hume' } }),
    ]);
    expect(out.get('X')!.tts_cap_exceeded_rows).toBe(1);
  });

  // Audit small fix: non-TTS rows (service='gemini') don't contribute to
  // provider sub-totals even when carrying a tts_provider metadata tag.
  it('does not bucket gemini-service rows into provider totals', () => {
    const out = aggregateLiveSessions([
      liveRow({ session_id: 'G', service: 'gemini', operation: 'voice_audio_input_seconds', cost_usd: 0.05, metadata: null }),
      liveRow({ session_id: 'G', service: 'gemini', operation: 'voice_audio_out_tokens',    cost_usd: 0.10, metadata: null }),
    ]);
    const agg = out.get('G')!;
    expect(agg.tts_provider).toBe(null);
    expect(agg.cost_usd_cartesia).toBe(0);
    expect(agg.cost_usd_hume).toBe(0);
  });
});

describe('aggregateHistoricalSummary', () => {
  it('total truth + fallback split is correct (leg-2 only fallback)', () => {
    const { totalUsdTruth, totalUsdFallback } = aggregateHistoricalSummary([
      summaryRow({ operation: 'voice_audio_out_tokens', cost_usd: 0.10, metadata: null }),
      summaryRow({ operation: 'voice_audio_out_tokens', cost_usd: 0.05, metadata: { fallback: 'seconds' } }),
      summaryRow({ operation: 'voice_audio_out_tokens', cost_usd: 0.20, metadata: null }),
    ]);
    expect(totalUsdTruth).toBeCloseTo(0.30, 6);
    expect(totalUsdFallback).toBeCloseTo(0.05, 6);
  });

  // Audit B-1 (2026-04-30) — see aggregateLiveSessions equivalent for context.
  it('B-1 regression: leg-1 cost with fallback metadata stays in truth bucket', () => {
    const { totalUsdTruth, totalUsdFallback, byOperation } = aggregateHistoricalSummary([
      summaryRow({
        operation: 'voice_audio_input_seconds',
        cost_usd: 0.05,
        metadata: { fallback: 'seconds' },
      }),
    ]);
    expect(totalUsdTruth).toBe(0.05);
    expect(totalUsdFallback).toBe(0);
    const op = byOperation[0];
    expect(op.cost_usd_truth).toBe(0.05);
    expect(op.cost_usd_fallback).toBe(0);
    expect(op.fallback_count).toBe(0);
  });

  it('B-1 regression: full fallback turn aggregates correctly across legs', () => {
    const { totalUsdTruth, totalUsdFallback, byOperation } = aggregateHistoricalSummary([
      summaryRow({ service: 'gemini',   operation: 'voice_audio_input_seconds', cost_usd: 0.001, metadata: { fallback: 'seconds' } }),
      summaryRow({ service: 'gemini',   operation: 'voice_audio_out_tokens',    cost_usd: 0.002, metadata: { fallback: 'seconds' } }),
      summaryRow({ service: 'cartesia', operation: 'voice_tts_characters',      cost_usd: 0,     metadata: { fallback: 'seconds' } }),
      summaryRow({ service: 'cartesia', operation: 'voice_tts_audio_seconds',   cost_usd: 0,     metadata: { fallback: 'seconds' } }),
    ]);
    expect(totalUsdTruth).toBeCloseTo(0.001, 6);
    expect(totalUsdFallback).toBeCloseTo(0.002, 6);
    // Leg-2 row is the only one that should report fallback in its by-op entry.
    const leg2 = byOperation.find((o) => o.operation === 'voice_audio_out_tokens')!;
    expect(leg2.cost_usd_fallback).toBe(0.002);
    expect(leg2.fallback_count).toBe(1);
    const leg1 = byOperation.find((o) => o.operation === 'voice_audio_input_seconds')!;
    expect(leg1.cost_usd_truth).toBe(0.001);
    expect(leg1.fallback_count).toBe(0);
  });

  it('byOperation sorted by combined cost desc', () => {
    const { byOperation } = aggregateHistoricalSummary([
      summaryRow({ service: 'gemini', operation: 'voice_audio_input_seconds', cost_usd: 1.0 }),
      summaryRow({ service: 'cartesia', operation: 'voice_tts_characters', cost_usd: 5.0 }),
      summaryRow({ service: 'gemini', operation: 'voice_audio_out_tokens', cost_usd: 3.0 }),
    ]);
    expect(byOperation[0].operation).toBe('voice_tts_characters');
    expect(byOperation[1].operation).toBe('voice_audio_out_tokens');
    expect(byOperation[2].operation).toBe('voice_audio_input_seconds');
  });

  it('groups by service|operation key', () => {
    const { byOperation } = aggregateHistoricalSummary([
      summaryRow({ service: 'gemini', operation: 'voice_audio_input_seconds', cost_usd: 1, units: 10 }),
      summaryRow({ service: 'gemini', operation: 'voice_audio_input_seconds', cost_usd: 2, units: 20 }),
    ]);
    expect(byOperation).toHaveLength(1);
    expect(byOperation[0].cost_usd_truth).toBe(3);
    expect(byOperation[0].units).toBe(30);
    expect(byOperation[0].row_count).toBe(2);
  });

  it('per-operation fallback_count tracks fallback rows', () => {
    const { byOperation } = aggregateHistoricalSummary([
      summaryRow({ operation: 'voice_audio_out_tokens', cost_usd: 0.001, metadata: null }),
      summaryRow({ operation: 'voice_audio_out_tokens', cost_usd: 0.002, metadata: { fallback: 'seconds' } }),
      summaryRow({ operation: 'voice_audio_out_tokens', cost_usd: 0.003, metadata: { fallback: 'seconds' } }),
    ]);
    const op = byOperation.find((o) => o.operation === 'voice_audio_out_tokens')!;
    expect(op.row_count).toBe(3);
    expect(op.fallback_count).toBe(2);
    expect(op.cost_usd_truth).toBeCloseTo(0.001, 6);
    expect(op.cost_usd_fallback).toBeCloseTo(0.005, 6);
  });

  it('empty input yields empty output', () => {
    const { byOperation, byProviderLeg, totalUsdTruth, totalUsdFallback, totalUsdCartesia, totalUsdHume } = aggregateHistoricalSummary([]);
    expect(byOperation).toEqual([]);
    expect(byProviderLeg).toEqual([]);
    expect(totalUsdTruth).toBe(0);
    expect(totalUsdFallback).toBe(0);
    expect(totalUsdCartesia).toBe(0);
    expect(totalUsdHume).toBe(0);
  });

  // HUME_TTS_PLAN §6.12 — provider × leg breakdown.

  it('provider × leg fold separates cartesia and hume totals', () => {
    const { byProviderLeg, totalUsdCartesia, totalUsdHume } = aggregateHistoricalSummary([
      summaryRow({ service: 'cartesia', operation: 'voice_tts_characters', cost_usd: 0.50, metadata: { tts_provider: 'cartesia' } }),
      summaryRow({ service: 'hume',     operation: 'voice_tts_characters', cost_usd: 0.10, metadata: { tts_provider: 'hume' } }),
      summaryRow({ service: 'hume',     operation: 'voice_tts_audio_seconds', cost_usd: 0,    metadata: { tts_provider: 'hume' }, units: 3.0 }),
    ]);
    expect(totalUsdCartesia).toBeCloseTo(0.50, 6);
    expect(totalUsdHume).toBeCloseTo(0.10, 6);
    const humeChars = byProviderLeg.find((p) => p.tts_provider === 'hume' && p.operation === 'voice_tts_characters')!;
    expect(humeChars.cost_usd_truth).toBeCloseTo(0.10, 6);
    expect(humeChars.row_count).toBe(1);
    const cartChars = byProviderLeg.find((p) => p.tts_provider === 'cartesia' && p.operation === 'voice_tts_characters')!;
    expect(cartChars.cost_usd_truth).toBeCloseTo(0.50, 6);
  });

  it('byProviderLeg defaults missing tts_provider to cartesia (pre-v2 rows)', () => {
    const { byProviderLeg, totalUsdCartesia, totalUsdHume } = aggregateHistoricalSummary([
      summaryRow({ service: 'cartesia', operation: 'voice_tts_characters', cost_usd: 1.0, metadata: null }),
    ]);
    expect(totalUsdCartesia).toBe(1.0);
    expect(totalUsdHume).toBe(0);
    expect(byProviderLeg[0].tts_provider).toBe('cartesia');
  });
});
