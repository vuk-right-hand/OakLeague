// POST /api/admin/creator-publish — publish/unpublish a creator.
//
// FIVE_CREATOR_ONBOARDING_READINESS P0-1. Wraps admin_set_creator_published
// (migration 20260523000010) so the admin creator-detail page gets a button
// instead of "open the SQL editor." Publishing is the ONLY code path that
// sets creators.published_at + brain_status='ready' — before this, creator #1
// reached the feed only via hand-run SQL.
//
// Calls the RPC via the JWT-bound supabaseServer() client (NOT supabaseAdmin)
// so auth.uid() resolves inside _assert_caller_is_admin() AND so the
// admin_audit_log NOT-NULL admin_user_id FK is satisfied with the real admin
// (mirrors creator-retrieval-version/route.ts; auditor C2).
//
// Readiness preconditions live in the RPC and surface as distinct messages
// mapped to HTTP 422 here so the UI can show "voice not cloned" etc.

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

type Body = { creator_id?: unknown; publish?: unknown };

// Readiness-precondition messages the RPC RAISEs with errcode P0001. Mapped
// to HTTP 422 (unprocessable — request is well-formed but the creator isn't
// publish-ready). Kept as a set so an unknown P0001 still falls through to 500.
const PRECONDITION_CODES = new Set([
  'voice_not_cloned',
  'face_not_uploaded',
  'brain_not_compiled',
  'brain_errored',
  'no_corpus',
  'no_v2_chunks',
  'voice_consent_missing',
  'likeness_consent_missing',
]);

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

  // Only accept literal booleans — defends against "true"/"false" strings,
  // 1/0, etc. silently flipping publication state.
  if (body.publish !== true && body.publish !== false) {
    return json(400, { error: 'bad_publish' });
  }
  const publish = body.publish;

  // Call the public RPC via the JWT-bound client so auth.uid() resolves
  // (the RPC asserts admin + writes the audit row with auth.uid()).
  const { supabaseServer } = await import('@/lib/supabase/server');
  const userSb = await supabaseServer();
  const { error } = await userSb.rpc('admin_set_creator_published', {
    p_creator_id: creatorId,
    p_publish:    publish,
  });

  if (error) {
    const msg = (error.message ?? '').toLowerCase();
    if (error.code === '42704' || msg.includes('creator_not_found')) {
      return json(404, { error: 'creator_not_found' });
    }
    if (error.code === '22023' || msg.includes('publish_required')) {
      return json(400, { error: 'publish_required' });
    }
    // Precondition failures — well-formed request, creator not publish-ready.
    // Exact match on the bare code (the RPC RAISEs `message='<code>'` with
    // errcode P0001) — collision-proof vs substring matching (auditor Small).
    // An unknown P0001 falls through to 500 + Sentry so we hear about it.
    if (error.code === 'P0001' && PRECONDITION_CODES.has(msg)) {
      return json(422, { error: msg });
    }
    if (error.code === '42501') {
      return json(403, { error: 'forbidden' });
    }
    Sentry.captureException(error, {
      extra: { op: 'admin_set_creator_published', creator_id: creatorId, publish, admin_user_id: admin.userId },
    });
    return json(500, { error: 'publish_failed' });
  }

  // Revalidate the admin SSR pages so the publish state shows on next view.
  // The public feed is served force-dynamic from per-request RPCs
  // (feed_ranked_page / feed_ranked_anon_page) that filter
  // creators.published_at live — there is NO '/' route-cache entry to bust, so
  // a published creator appears on the next feed request automatically
  // (auditor C2: revalidatePath('/') was a no-op here).
  for (const path of ['/admin/creators', `/admin/creators/${creatorId}`]) {
    try { revalidatePath(path); } catch { /* non-fatal */ }
  }

  const sb = supabaseAdmin();
  const { data: row } = await sb
    .from('creators')
    .select('published_at, brain_status')
    .eq('id', creatorId)
    .maybeSingle<{ published_at: string | null; brain_status: string }>();

  return json(200, {
    ok: true,
    creator_id: creatorId,
    publish,
    published_at: row?.published_at ?? null,
    brain_status: row?.brain_status ?? null,
  });
}
