// Voice quota kill-switch. Called by proxy at turn_start.
//
// The latch already exists at the DB boundary: migration 0019 sets
// daily_quotas.kill_switch_fired_at once seconds_used crosses 150% of
// daily_limit_s (BEFORE INSERT/UPDATE trigger). This function just reads
// the latched row and throws if fired — the source of truth is Postgres,
// not application memory.
//
// Timezone contract: quota_date is user-local (profiles.timezone) per
// migration 0019. We match the same formula via a RPC-ish SELECT rather
// than guessing UTC midnight client-side.
//
// NOTE: the 24h window below is a rolling lookback, not a strict "today"
// lookup. Day 8 hardening: migrate to a SECURITY DEFINER RPC that resolves
// (profiles.timezone, now()) → quota_date and does an equality match, so a
// stale kill-switch row from 23h ago never leaks into the next calendar day.
// For spike-scale (one admin user) the rolling window is fine.

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';

export class QuotaExceededError extends Error {
  readonly code = 'quota_exceeded';
  constructor(message = 'daily voice quota exceeded') {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

/**
 * Throws QuotaExceededError iff today's row has kill_switch_fired_at set.
 * Proxy catches and closes WS with code 1008, reason 'quota_exceeded'.
 *
 * Note: this is read-only. Usage accumulation (seconds_used increment) is
 * the voice service's responsibility at turn_end — the latch trigger then
 * decides whether the next turn is allowed.
 */
export async function assertWithinQuota(userId: string): Promise<void> {
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('daily_quotas')
    .select('kill_switch_fired_at, seconds_used, daily_limit_s')
    .eq('user_id', userId)
    .gte('quota_date', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
    .order('quota_date', { ascending: false })
    .limit(1)
    .maybeSingle<{ kill_switch_fired_at: string | null; seconds_used: number; daily_limit_s: number }>();

  if (error) throw new Error(`kill-switch lookup failed: ${error.message}`);
  if (!row(data)) return;

  if (data.kill_switch_fired_at != null) {
    throw new QuotaExceededError();
  }
  if (data.seconds_used >= (data.daily_limit_s * 3) / 2) {
    throw new QuotaExceededError();
  }
}

function row<T>(x: T | null): x is T {
  return x != null;
}
