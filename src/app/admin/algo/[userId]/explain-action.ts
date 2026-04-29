'use server';

import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';

const HOOK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ExplainResponse = {
  breakdown: {
    score_total?: number;
    components?: Record<string, number>;
    weighted?: Record<string, number>;
    top_topic?: string;
    age_days?: number;
    [k: string]: unknown;
  } | null;
  narrative: string;
  display_slot_one_indexed: number | null;
  served_at_last_impression: string | null;
  reconstructed_creator_streak: number;
  regime_label: 'A' | 'B' | 'C' | 'D';
  notes: Record<string, string>;
};

type ExplainResult =
  | { data: ExplainResponse }
  | { error: 'auth_required' | 'bad_hook_id' | 'not_found' | 'internal'; message?: string };

export async function explainHook(
  pUserId: string,
  pHookId: string,
  pSessionCorrelationId: string,
): Promise<ExplainResult> {
  // Layered guard #1 — cookie session.
  try {
    await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return { error: 'auth_required' };
    throw e;
  }

  if (!HOOK_ID_RE.test(pHookId)) {
    return { error: 'bad_hook_id', message: 'Invalid hook ID format. Expected UUID.' };
  }

  // CRITICAL: must be supabaseServer() (cookie-bound), NOT supabaseAdmin().
  // supabaseAdmin() uses the service-role key → auth.uid() returns NULL inside
  // the SECURITY DEFINER body → admin guard fails with 42501.
  const sb = await supabaseServer();
  const { data, error } = await sb.rpc('admin_algo_score_explain', {
    p_user_id: pUserId,
    p_hook_id: pHookId,
    p_session_correlation_id: pSessionCorrelationId,
  });

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') return { error: 'auth_required' };
    if (code === '22P02') return { error: 'bad_hook_id', message: 'Invalid hook ID format.' };
    if (code === 'P0002') return { error: 'not_found',   message: 'Hook not found in catalog.' };
    return { error: 'internal' };
  }

  return { data: data as ExplainResponse };
}
