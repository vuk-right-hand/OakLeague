import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/supabase/admin';

// Growth & Minutes Economy — typed server helper over the minute_grant_insert
// RPC (the sole write path to the minute_grants wallet ledger). Service-role
// only; every caller must have already authenticated + decided the grant is
// owed. Idempotent on (type, sourceKind, sourceKey) when sourceKey is non-null.
//
// Phase 1 ships this helper; the signup-bonus / referral / share-tap callers
// are wired in Phase 4. Phase 4 also CREATE OR REPLACEs the RPC to add the
// lifetime/velocity/share-tap-daily caps — this helper's surface is stable
// across that change (the extra `reason` values are already in the union).

export type MinuteGrantType =
  | 'signup_bonus'
  | 'share_tap'
  | 'referral_verified'
  | 'paid_topup'
  | 'admin_adjustment';

export interface GrantMinutesInput {
  userId: string;
  type: MinuteGrantType;
  seconds: number;
  /** 'referral_token' | 'stripe_event' | 'share_token' | 'signup' | 'admin' */
  sourceKind: string;
  /** dedup key: token_hash / evt_… / 'signup:'||uid. Null = never deduped (admin ops). */
  sourceKey?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type GrantDeniedReason =
  | 'duplicate'
  | 'lifetime_cap'
  | 'velocity_cap'
  | 'share_tap_daily_cap'
  | 'error';

export interface GrantMinutesResult {
  granted: boolean;
  reason: GrantDeniedReason | null;
  grantId: number | null;
}

export async function grantMinutes(input: GrantMinutesInput): Promise<GrantMinutesResult> {
  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc('minute_grant_insert', {
    p_user_id: input.userId,
    p_grant_type: input.type,
    p_seconds: Math.floor(input.seconds),
    p_source_kind: input.sourceKind,
    p_source_key: input.sourceKey ?? null,
    p_metadata: input.metadata ?? null,
    // p_expires_at omitted — v1 grants are non-expiring (the RPC rejects a
    // non-null value to keep profiles.wallet_active_seconds exact).
  });
  if (error) {
    Sentry.captureException(error, {
      extra: { op: 'grantMinutes', user_id: input.userId, grant_type: input.type, source_kind: input.sourceKind },
    });
    return { granted: false, reason: 'error', grantId: null };
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { granted: boolean; reason: string | null; grant_id: number | null }
    | null;
  if (!row) return { granted: false, reason: 'error', grantId: null };
  return {
    granted: !!row.granted,
    reason: (row.reason as GrantDeniedReason | null) ?? null,
    grantId: row.grant_id ?? null,
  };
}
