// POST /api/admin/creator-retrieval-version — flip creators.retrieval_version
// between 1 and 2. Wraps the existing admin_set_creator_retrieval_version
// RPC so the panel can offer a button instead of "open Supabase SQL editor."
//
// Phase-1 unit audit C2 + M4. The promote workflow requires flipping
// retrieval_version=2 RIGHT AFTER deleting v1 chunks — otherwise voice
// sessions return zero passages between Promote and the manual flip. This
// route is the UI path admin uses post-Promote.
//
// The RPC itself (migration 20260514000001) recompiles persona inside the
// same transaction so a flip and the next session-open are always
// consistent. On v2→v1 downgrade the migration 20260516000004 cleans
// v2 zombies. All side effects live in the RPC.

import 'server-only';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { isSameOrigin, json, mapAuthGuardStatus } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = { creator_id?: unknown; version?: unknown };

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('application/json')) {
    return json(415, { error: 'bad_content_type' });
  }

  let admin: { userId: string };
  try {
    admin = await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) {
      const { status, body } = mapAuthGuardStatus(e.status);
      return json(status, body);
    }
    throw e;
  }
  Sentry.setUser({ id: admin.userId });

  let body: Body;
  try { body = (await req.json()) as Body; }
  catch { return json(400, { error: 'bad_json' }); }

  const creatorId = typeof body.creator_id === 'string' && UUID_RE.test(body.creator_id)
    ? body.creator_id : null;
  if (!creatorId) return json(400, { error: 'bad_creator_id' });

  // Only accept literal numeric 1 or 2 — defends against `"2"` strings,
  // truthy "yes", or arrays of [2].
  const version = body.version === 1 || body.version === 2 ? body.version : null;
  if (version === null) return json(400, { error: 'bad_version' });

  // The public wrapper admin_set_creator_retrieval_version asserts admin
  // via _assert_caller_is_admin() (auth.uid()). Calling via supabaseAdmin
  // (service-role) bypasses auth.uid(), so we use the underlying logic:
  // the RPC also exists as no _unsafe variant — it ONLY has the public
  // wrapper. We need to call it via an authenticated client. But the
  // existing admin routes pattern (brain-recompile, etc.) uses
  // supabaseAdmin direct. For consistency: call via supabaseAdmin and
  // pass the user JWT via Authorization header? No — supabaseAdmin is
  // service-role only.
  //
  // Pragma: call the public wrapper anyway; PostgREST will pass an empty
  // auth.uid() which fails _assert_caller_is_admin(). Workaround: use
  // the .auth.setSession() trick? No — service-role can call SECURITY
  // DEFINER functions directly, and `_assert_caller_is_admin()` raises
  // because auth.uid() is NULL.
  //
  // Solution: call the public RPC with the Authorization header set to
  // the user's JWT. supabaseServer() returns a JWT-bound client; use that.
  const { supabaseServer } = await import('@/lib/supabase/server');
  const userSb = await supabaseServer();
  const { error } = await userSb.rpc('admin_set_creator_retrieval_version', {
    p_creator_id: creatorId,
    p_version:    version,
  });

  if (error) {
    const msg = (error.message ?? '').toLowerCase();
    if (error.code === '42704' || msg.includes('creator_not_found')) {
      return json(404, { error: 'creator_not_found' });
    }
    if (error.code === '22023' || msg.includes('version_invalid')) {
      return json(400, { error: 'invalid_version' });
    }
    if (error.code === '42501') {
      return json(403, { error: 'forbidden' });
    }
    Sentry.captureException(error, {
      extra: { op: 'admin_set_creator_retrieval_version', creator_id: creatorId, version, admin_user_id: admin.userId },
    });
    return json(500, { error: 'flip_failed' });
  }

  // Revalidate the admin creator detail page so the retrieval_version cell
  // reflects the new state on next view without manual refresh.
  try {
    revalidatePath(`/admin/creators/${creatorId}`);
  } catch (e) {
    // Non-fatal — log but don't fail the POST response.
    Sentry.captureException(e, {
      extra: { op: 'revalidate_after_retrieval_flip', creator_id: creatorId },
    });
  }

  // The RPC's audit_log row already records this action via the migration.
  // Optionally double-check the post-state for the response.
  const sb = supabaseAdmin();
  const { data: row } = await sb
    .from('creators')
    .select('retrieval_version, brain_compiled_at')
    .eq('id', creatorId)
    .maybeSingle<{ retrieval_version: number; brain_compiled_at: string | null }>();

  return json(200, {
    ok: true,
    creator_id: creatorId,
    retrieval_version: row?.retrieval_version ?? version,
    brain_compiled_at: row?.brain_compiled_at ?? null,
  });
}
