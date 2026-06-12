'use server';

import { revalidatePath } from 'next/cache';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';

const WEIGHT_KEY_RE = /^W_[A-Z0-9_]{1,40}$/;

type SetWeightResult =
  | { ok: true }
  | {
      error: 'auth_required' | 'bad_key' | 'bad_value' | 'not_found' | 'internal';
      message?: string;
    };

export async function setFeedAlgoWeight(
  key: string,
  value: number,
): Promise<SetWeightResult> {
  // Layered guard #1 — cookie session (the RPC re-guards as #2).
  try {
    await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return { error: 'auth_required' };
    throw e;
  }

  if (!WEIGHT_KEY_RE.test(key)) {
    return { error: 'bad_key', message: 'Invalid weight key.' };
  }
  if (!Number.isFinite(value)) {
    return { error: 'bad_value', message: 'Weight must be a finite number.' };
  }

  // CRITICAL: must be supabaseServer() (cookie-bound), NOT supabaseAdmin().
  // supabaseAdmin() uses the service-role key → auth.uid() returns NULL inside
  // the SECURITY DEFINER body → admin guard fails with 42501.
  const sb = await supabaseServer();
  const { error } = await sb.rpc('admin_set_feed_algo_weight', {
    p_key: key,
    p_value: value,
  });

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') return { error: 'auth_required' };
    if (code === '22023')
      return { error: 'bad_value', message: error.message ?? 'Value out of bounds.' };
    if (code === 'P0002') return { error: 'not_found', message: 'Unknown weight key.' };
    return { error: 'internal' };
  }

  revalidatePath('/admin/algo/weights');
  return { ok: true };
}
