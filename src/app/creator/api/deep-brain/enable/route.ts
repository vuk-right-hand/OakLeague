// POST /creator/api/deep-brain/enable — creator turns on Deep Brain (v3).
//
// DEEP_BRAIN_SWITCH_PLAN Step 3. Enqueues a v3 corpus build for the caller's
// own creator. Ownership is derived inside the RPC from auth.uid() (NO
// creator_id in the body — IDOR-proof), so we call via the JWT-bound
// supabaseServer() client, NOT service-role (service-role makes auth.uid()
// NULL → not_a_creator for everyone; see creator-retrieval-version/route.ts).
//
// No rate-limit: Enable is a one-way switch (the RPC refuses once already on v3
// and never re-embeds a built sample), and the worker's per-creator embedding
// USD cap is the real cost ceiling (plan C3/C4).

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
  // Same-origin is the CSRF gate (no body to parse, so no content-type check).
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
  const { data, error } = await sb.rpc('creator_enable_deep_brain');

  if (error) {
    const code = error.code ?? '';
    const msg = (error.message ?? '').toLowerCase();
    // Well-formed request, creator just isn't enable-ready → 422 with the token.
    if (code === 'P0001' && msg.includes('brain_errored')) return json(422, { error: 'brain_errored' });
    if (code === 'P0001' && msg.includes('no_ready_samples')) return json(422, { error: 'no_ready_samples' });
    if (code === '42501') return json(403, { error: 'forbidden' });
    if (code === '28000') return json(401, { error: 'unauthenticated' });
    Sentry.captureException(error, {
      extra: { op: 'creator_enable_deep_brain', creator_id: creator.creatorId },
    });
    return json(500, { error: 'enable_failed' });
  }

  // Refresh the dashboard's server-rendered Deep Brain card (plan M6).
  try { revalidatePath('/creator'); } catch { /* non-fatal */ }

  return json(200, { ok: true, ...(data as Record<string, unknown>) });
}
