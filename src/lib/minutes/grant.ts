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

// Non-negative integer env read with a default (matches the Phase-1/2 pattern).
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Phase-4 referral caps — passed UNCONDITIONALLY on every grant (cheaper than
// branching). minute_grant_insert ignores them for non-referral types, so a
// paid_topup / admin_adjustment carrying these is a harmless no-op. Env-tunable;
// the SQL defaults mirror these so the SQL-side caller (credit RPC) stays consistent.
function referralCaps() {
  return {
    lifetime: envInt('REFERRAL_LIFETIME_CAP_SECONDS', 18000),
    velocity: envInt('REFERRAL_VELOCITY_24H', 10),
    shareTapDaily: envInt('SHARE_TAP_DAILY_CAP', 2),
  };
}

export async function grantMinutes(input: GrantMinutesInput): Promise<GrantMinutesResult> {
  const admin = supabaseAdmin();
  const caps = referralCaps();
  const { data, error } = await admin.rpc('minute_grant_insert', {
    p_user_id: input.userId,
    p_grant_type: input.type,
    p_seconds: Math.floor(input.seconds),
    p_source_kind: input.sourceKind,
    p_source_key: input.sourceKey ?? null,
    p_metadata: input.metadata ?? null,
    // p_expires_at omitted — v1 grants are non-expiring (the RPC rejects a
    // non-null value to keep profiles.wallet_active_seconds exact).
    p_lifetime_cap_seconds: caps.lifetime,
    p_velocity_24h: caps.velocity,
    p_share_tap_daily_cap: caps.shareTapDaily,
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

// ── Phase 4 typed wrappers ────────────────────────────────────────────────

// +60s (SHARE_TAP_BONUS_SECONDS) per token minted, deduped on the token hash, capped
// 2/day by minute_grant_insert. Called from /api/recording/open-check on mint success.
export async function grantShareTap(userId: string, tokenHash: string): Promise<GrantMinutesResult> {
  return grantMinutes({
    userId,
    type: 'share_tap',
    seconds: envInt('SHARE_TAP_BONUS_SECONDS', 60),
    sourceKind: 'share_token',
    sourceKey: tokenHash,
  });
}

// +900s (SIGNUP_BONUS_SECONDS) universal welcome, deduped on 'signup:'||uid so the
// referred-user path (credit RPC) and the universal onboarding path never double-grant.
export async function grantSignupBonus(userId: string): Promise<GrantMinutesResult> {
  return grantMinutes({
    userId,
    type: 'signup_bonus',
    seconds: envInt('SIGNUP_BONUS_SECONDS', 900),
    sourceKind: 'signup',
    sourceKey: `signup:${userId}`,
    metadata: { source: 'onboarding' },
  });
}
