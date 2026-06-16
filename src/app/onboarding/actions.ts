'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';
import { grantSignupBonus } from '@/lib/minutes/grant';

const Input = z.object({
  goals: z.array(z.string().min(1).max(200)).min(1).max(5),
  obstacles: z.array(z.string().min(1).max(200)).max(5).default([]),
  timezone: z.string().min(1).max(100),
  next: z.string().max(500),
});

function safeNext(n: string): string {
  if (!n.startsWith('/') || n.startsWith('//')) return '/';
  return n;
}

export async function saveOnboarding(
  input: unknown,
): Promise<{ ok: true; next: string } | { ok: false; error: string }> {
  const userId = await getCallerUserId();
  if (!userId) return { ok: false, error: 'unauthorized' };

  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };

  // Whitelist — never spread `input`.
  const patch = {
    goals: parsed.data.goals,
    obstacles: parsed.data.obstacles,
    timezone: parsed.data.timezone,
    onboarded_at: new Date().toISOString(),
  };

  const supabase = await supabaseServer();
  const { error } = await supabase.from('profiles').update(patch).eq('id', userId);
  if (error) return { ok: false, error: 'save_failed' };

  // Phase 4 — universal welcome: every new signup (referred or not) earns the
  // signup_bonus once, at onboarding completion. grantSignupBonus uses the
  // service-role admin client (minute_grant_insert is service-role only — the
  // authenticated supabaseServer() client above would 403, R2-M3) and dedups on
  // 'signup:'||uid, so the referred-user credit path never double-grants. Awaited
  // (fast, idempotent) so the welcome reliably lands before the redirect; a grant
  // failure is Sentry-logged inside the helper and does NOT fail onboarding.
  //
  // Audit M6 — KNOWN GAP (accepted): onboarded_at is set above regardless, so this
  // is the ONLY automatic welcome attempt. If the grant RPC hits a transient error
  // here AND the user never opens a *referred* session (whose credit path re-grants
  // the same key), the welcome silently never lands. Low-likelihood, low-harm (a
  // missing 15 free min), and recoverable via an admin_adjustment grant — the
  // Phase-7 reconciler flags users with onboarded_at but no signup_bonus row. We
  // deliberately do NOT retro-grant on every session-open (would add a per-open RPC
  // + retro-grant every pre-Phase-4 user).
  await grantSignupBonus(userId);

  revalidatePath('/');
  return { ok: true, next: safeNext(parsed.data.next) };
}
