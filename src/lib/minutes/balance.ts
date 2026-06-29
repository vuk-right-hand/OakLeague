import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/supabase/admin';

// Growth & Minutes Economy — typed read over voice_balance_check (the unified
// balance: effective_remaining = free allowance + durable wallet). Service-role
// only; the caller must pass the AUTHENTICATED user's own id (the RPC is not
// exposed to `authenticated` to avoid a caller-supplied-id balance oracle —
// R1-S3). Used by the session-open gate, the meter route (Phase 3), and the
// soft gate (Phase 2).

export type CapPeriod = 'daily' | 'weekly' | 'monthly';

export interface MinutesBalance {
  effectiveRemaining: number;   // free allowance + wallet (the gate number)
  allowanceRemaining: number;   // free pool only
  walletRemaining: number;      // durable wallet only
  recruiterBonus: number;
  dailyUsed: number;
  dailyCap: number;
  dailyCapEff: number;          // dailyCap + recruiterBonus (fuse anchor input)
  weeklyUsed: number;
  weeklyCap: number | null;
  monthlyUsed: number;
  monthlyCap: number | null;
  walletActiveSeconds: number;
  walletSpentSeconds: number;
  capPeriod: CapPeriod | null;  // which free cap binds (drives reset copy)
  supporterActive: boolean;
}

export async function getBalance(userId: string): Promise<MinutesBalance | null> {
  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc('voice_balance_check', { p_user_id: userId });
  if (error) {
    // M6: P0002 = profile row not materialised yet (brand-new user). Expected
    // race — return null quietly so the caller can retry. ANY other error (RPC
    // outage, permission) must NOT be silent, or a Phase-2/3 meter shows nothing
    // on a transient failure with no signal.
    const code = (error as { code?: string }).code;
    if (code !== 'P0002') {
      Sentry.captureException(error, { extra: { op: 'getBalance', user_id: userId } });
    }
    return null;
  }
  if (!data) return null;
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) return null;

  // M5 — voice_balance_check ALWAYS returns a non-null cap_period (initialised
  // 'daily', only ever reassigned). A null here while a balance row exists means an
  // RPC schema regression that would silently drop the meter's reset + period copy
  // fleet-wide; page on it rather than degrade quietly.
  if (row.cap_period == null) {
    Sentry.captureException(new Error('voice_balance_check returned null cap_period with a balance row'), {
      level: 'warning',
      extra: { op: 'getBalance', user_id: userId },
    });
  }

  const num = (v: unknown): number => (v == null ? 0 : Number(v));
  const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

  return {
    effectiveRemaining: num(row.effective_remaining),
    allowanceRemaining: num(row.allowance_remaining),
    walletRemaining: num(row.wallet_remaining),
    recruiterBonus: num(row.recruiter_bonus),
    dailyUsed: num(row.daily_used),
    dailyCap: num(row.daily_cap),
    dailyCapEff: num(row.daily_cap_eff),
    weeklyUsed: num(row.weekly_used),
    weeklyCap: numOrNull(row.weekly_cap),
    monthlyUsed: num(row.monthly_used),
    monthlyCap: numOrNull(row.monthly_cap),
    walletActiveSeconds: num(row.wallet_active_seconds),
    walletSpentSeconds: num(row.wallet_spent_seconds),
    capPeriod: (row.cap_period as CapPeriod | null) ?? null,
    supporterActive: !!row.supporter_active,
  };
}
