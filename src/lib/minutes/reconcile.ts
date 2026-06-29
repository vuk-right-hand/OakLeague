import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  blendedCogsRate,
  impliedUsd,
  roundUsd,
  type BlendedCogsRate,
} from './cogs-rate';

// Growth & Minutes Economy — Phase 7 reconcile assembly (plan §9).
//
// Calls the two read-only, service-role-only RPCs (migration 20260616000001)
// and shapes a single typed report for the admin viewer (/admin/minutes), the
// API route (/api/admin/minutes), and the CLI (scripts/minutes-reconcile.mjs).
// The pure shaper (shapeReconcile) is unit-testable without a DB; loadReconcile
// is the thin IO wrapper.
//
// FLOWS are range-bounded; STOCKS (wallet totals) + violation counts are
// point-in-time. The blended $/min rate is the env (cogs-rate.ts), never SQL.

// Raw RPC row shapes (numerics arrive as strings over PostgREST).
interface SummaryRowRaw {
  granted_seconds_total: number | string | null;
  granted_by_type: Record<string, number | string> | null;
  wallet_active_total: number | string | null;
  wallet_spent_total: number | string | null;
  consumed_seconds_total: number | string | null;
  voice_cogs_usd: number | string | null;
  wallet_mismatch_count: number | string | null;
  overspent_count: number | string | null;
  welcome_gap_count: number | string | null;
}

interface ViolationRowRaw {
  user_id: string;
  violation: string;
  wallet_active_seconds: number | string | null;
  wallet_spent_seconds: number | string | null;
  grants_sum: number | string | null;
  onboarded_at: string | null;
  detail: string | null;
}

export interface ReconcileOffender {
  user_id: string;
  violation: 'wallet_mismatch' | 'overspent' | 'welcome_gap' | string;
  wallet_active_seconds: number;
  wallet_spent_seconds: number;
  grants_sum: number;
  onboarded_at: string | null;
  detail: string | null;
}

export interface ReconcileReport {
  range: { since: string | null; until: string | null; welcome_floor: string | null };
  flows: {
    granted_seconds: number;
    granted_by_type: Record<string, number>;
    consumed_seconds: number;
  };
  stocks: {
    wallet_active_seconds: number;
    wallet_spent_seconds: number;
    wallet_remaining_seconds: number;
  };
  cogs: {
    blended_rate_usd_per_min: number;
    blended_rate_quoted_at: string | null;
    blended_rate_configured: boolean;
    implied_usd_from_granted: number;
    implied_usd_from_consumed: number;
    actual_voice_usd: number;
  };
  violations: {
    wallet_mismatch_count: number;
    overspent_count: number;
    welcome_gap_count: number;
    total: number;
    offenders: ReconcileOffender[];
  };
  // Paid monthly-allowance consumption has no minute_grants row to reconcile
  // against; that path ships with Phase 6 (stripe_customers). Surfaced so the
  // viewer doesn't imply the wallet figures cover paid tiers (R4-M3).
  paid_reconciliation: 'deferred_phase6';
}

function num(v: number | string | null | undefined): number {
  // Strict on type: PostgREST sends numerics as number|string; anything else
  // (a bool/object from a malformed row) coerces to 0 rather than NaN-poisoning.
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export interface ReconcileRange {
  since: string | null;
  until: string | null;
  welcomeFloor: string | null;
}

/**
 * Pure shaper — no IO. Turns the raw RPC rows + the env rate into the report.
 */
export function shapeReconcile(
  summary: SummaryRowRaw | null,
  violations: ViolationRowRaw[],
  rate: BlendedCogsRate,
  range: ReconcileRange,
): ReconcileReport {
  const grantedSeconds = num(summary?.granted_seconds_total);
  const consumedSeconds = num(summary?.consumed_seconds_total);
  const walletActive = num(summary?.wallet_active_total);
  const walletSpent = num(summary?.wallet_spent_total);

  const byTypeRaw = summary?.granted_by_type ?? {};
  const granted_by_type: Record<string, number> = {};
  for (const [k, v] of Object.entries(byTypeRaw)) granted_by_type[k] = num(v);

  const wallet_mismatch_count = num(summary?.wallet_mismatch_count);
  const overspent_count = num(summary?.overspent_count);
  const welcome_gap_count = num(summary?.welcome_gap_count);

  const offenders: ReconcileOffender[] = violations.map((r) => ({
    user_id: r.user_id,
    violation: r.violation,
    wallet_active_seconds: num(r.wallet_active_seconds),
    wallet_spent_seconds: num(r.wallet_spent_seconds),
    grants_sum: num(r.grants_sum),
    onboarded_at: r.onboarded_at,
    detail: r.detail,
  }));

  return {
    range: { since: range.since, until: range.until, welcome_floor: range.welcomeFloor },
    flows: {
      granted_seconds: grantedSeconds,
      granted_by_type,
      consumed_seconds: consumedSeconds,
    },
    stocks: {
      wallet_active_seconds: walletActive,
      wallet_spent_seconds: walletSpent,
      wallet_remaining_seconds: Math.max(0, walletActive - walletSpent),
    },
    cogs: {
      blended_rate_usd_per_min: rate.usdPerMin,
      blended_rate_quoted_at: rate.quotedAt,
      blended_rate_configured: rate.configured,
      implied_usd_from_granted: roundUsd(impliedUsd(grantedSeconds, rate.usdPerMin)),
      implied_usd_from_consumed: roundUsd(impliedUsd(consumedSeconds, rate.usdPerMin)),
      actual_voice_usd: roundUsd(num(summary?.voice_cogs_usd)),
    },
    violations: {
      wallet_mismatch_count,
      overspent_count,
      welcome_gap_count,
      total: wallet_mismatch_count + overspent_count + welcome_gap_count,
      offenders,
    },
    paid_reconciliation: 'deferred_phase6',
  };
}

export interface LoadReconcileOptions {
  since?: string | null;
  until?: string | null;
  welcomeFloor?: string | null;
  violationLimit?: number;
}

/**
 * IO wrapper: calls both reconcile RPCs with the service-role admin client and
 * returns the shaped report. Throws on RPC error (admin-only tool — the caller
 * maps it to a 500 / error render).
 */
export async function loadReconcile(
  admin: SupabaseClient,
  opts: LoadReconcileOptions = {},
): Promise<ReconcileReport> {
  const since = opts.since ?? null;
  const until = opts.until ?? null;
  const welcomeFloor = opts.welcomeFloor ?? null;
  const limit = Number.isFinite(opts.violationLimit) ? Math.floor(opts.violationLimit as number) : 100;

  const [summaryRes, violRes] = await Promise.all([
    admin.rpc('minutes_reconcile_summary', {
      p_from: since,
      p_to: until,
      p_welcome_floor: welcomeFloor,
    }),
    admin.rpc('minutes_reconcile_violations', {
      p_limit: limit,
      p_welcome_floor: welcomeFloor,
    }),
  ]);

  if (summaryRes.error) throw new Error(`reconcile_summary_failed: ${summaryRes.error.message}`);
  if (violRes.error) throw new Error(`reconcile_violations_failed: ${violRes.error.message}`);

  const summaryRow = (Array.isArray(summaryRes.data) ? summaryRes.data[0] : summaryRes.data) as
    | SummaryRowRaw
    | null;
  const violations = (Array.isArray(violRes.data) ? violRes.data : []) as ViolationRowRaw[];

  return shapeReconcile(summaryRow, violations, blendedCogsRate(), { since, until, welcomeFloor });
}
