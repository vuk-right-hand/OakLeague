// POST /creator/api/deep-brain/activate — flip the caller's creator to v3 once
// the build is ready.
//
// DEEP_BRAIN_SWITCH_PLAN Step 3. Calls creator_activate_deep_brain (ownership
// from auth.uid()), which delegates to the shared _set_retrieval_version_v3_unsafe
// core (advisory-locked + creator_v3_ready gate + soft cutover + recompile).
// Idempotent if already on v3. Called via the JWT-bound client so auth.uid()
// resolves inside the RPC.

import 'server-only';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCreatorFromSession, AuthGuardError } from '@/lib/auth-guards';
import { isSameOrigin, json, mapAuthGuardStatus } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

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
  const { data, error } = await sb.rpc('creator_activate_deep_brain');

  if (error) {
    const code = error.code ?? '';
    const msg = (error.message ?? '').toLowerCase();
    // The shared core raises check_violation (23514) when the build isn't
    // complete — surface it so the UI says "still building" not "failed".
    if (code === '23514' && msg.includes('creator_v3_not_ready')) {
      return json(409, { error: 'creator_v3_not_ready' });
    }
    if (code === '42501') return json(403, { error: 'forbidden' });
    if (code === '28000') return json(401, { error: 'unauthenticated' });
    Sentry.captureException(error, {
      extra: { op: 'creator_activate_deep_brain', creator_id: creator.creatorId },
    });
    return json(500, { error: 'activate_failed' });
  }

  try { revalidatePath('/creator'); } catch { /* non-fatal */ }

  return json(200, { ok: true, ...(data as Record<string, unknown>) });
}
