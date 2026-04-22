import 'server-only';
import { supabaseAdmin } from '../supabase/admin';

/**
 * Pinned rate for seconds of video ENCODED on Mux. This is our accounting
 * constant, not a live quote — update deliberately when Mux publishes new
 * pricing. Snapshot: 2026-04-22, $0.00096 / sec (Smart encoding tier).
 */
export const MUX_COST_PER_SECOND_USD = 0.00096;

export type LogMuxCogsInput = {
  operation: 'asset.ready' | 'asset.errored' | 'asset.delete';
  durationMs: number;
  assetId?: string;
  passthrough?: string;
};

// cogs_log.cost_usd is numeric(10,6) — caps at ~9999.999999. A pathological
// 11+ day asset duration would overflow and the silent INSERT would fail.
// 24h of encoded seconds at our rate = ~$82.94, well under the cap.
const MAX_SECONDS_PER_LOG = 24 * 60 * 60; // 86400

export async function logMuxCogs(input: LogMuxCogsInput): Promise<void> {
  const rawSeconds = input.durationMs / 1000;
  // Audit S5: defensive cap. Negative / NaN inputs coerce to 0.
  const seconds = Math.max(
    0,
    Math.min(Number.isFinite(rawSeconds) ? rawSeconds : 0, MAX_SECONDS_PER_LOG),
  );
  const cost = seconds * MUX_COST_PER_SECOND_USD;
  const admin = supabaseAdmin();
  const { error } = await admin.from('cogs_log').insert({
    service: 'mux',
    operation: input.operation,
    units: seconds,
    unit_label: 'seconds_encoded',
    cost_usd: Number(cost.toFixed(6)),
    metadata: {
      asset_id: input.assetId ?? null,
      passthrough: input.passthrough ?? null,
      quoted_at: '2026-04-22',
    },
  });
  if (error) {
    // Don't throw — webhook handler must still 200 to Mux. Surface to Sentry.
    console.error('[mux.costs] failed to log cogs', error);
  }
}
