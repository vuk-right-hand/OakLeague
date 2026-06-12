// GET /creator/api/deep-brain/status — the caller's own Deep Brain state.
//
// DEEP_BRAIN_SWITCH_PLAN Step 3. Returns retrieval_version, v3 readiness,
// per-status build counts, and FIFO queue position — all computed inside the
// creator_deep_brain_status SECDEF RPC from auth.uid() (NO client creator_id;
// corpus_reprocess_jobs is RLS deny-all). Polled by the dashboard card every
// few seconds while building. No same-origin check (read-only, no CSRF surface
// — mirrors the admin corpus-reprocess GET).

import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCreatorFromSession, AuthGuardError } from '@/lib/auth-guards';
import { json, mapAuthGuardStatus } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  let creator: { userId: string; creatorId: string };
  try {
    creator = await assertCreatorFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) {
      const { status, body } = mapAuthGuardStatus(e.status);
      return json(status, body);
    }
    throw e;
  }
  Sentry.setUser({ id: creator.userId });

  const sb = await supabaseServer();
  const { data, error } = await sb.rpc('creator_deep_brain_status');

  if (error) {
    const code = error.code ?? '';
    if (code === '42501') return json(403, { error: 'forbidden' });
    if (code === '28000') return json(401, { error: 'unauthenticated' });
    Sentry.captureException(error, {
      extra: { op: 'creator_deep_brain_status', creator_id: creator.creatorId },
    });
    return json(500, { error: 'status_failed' });
  }

  return json(200, { ok: true, ...(data as Record<string, unknown>) });
}
