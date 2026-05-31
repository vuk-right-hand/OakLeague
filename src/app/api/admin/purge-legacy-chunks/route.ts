// /api/admin/purge-legacy-chunks — the deferred legacy delete for a v3 creator
// (Step-9 audit C1 / M5). Wraps admin_purge_legacy_chunks so the admin console
// can offer a button instead of "open Supabase SQL editor."
//
//   POST { creator_id } → admin_purge_legacy_chunks(creator_id)
//     Deletes the creator's dormant chunker_version IN (1,2) chunks + v2-shape
//     narrative_units (section_id NULL). GUARDED: the RPC refuses (23514) unless
//     the creator is on retrieval_version=3. Stamps creators.legacy_purged_at,
//     after which a rollback OFF v3 is permanently refused — DESTRUCTIVE +
//     IRREVERSIBLE; the UI gates it behind type-to-confirm.
//   GET ?creator_id=X → preview: how many rows WOULD be deleted (advisory).
//     Replicates the RPC's retrieval_version=3 guard so it never shows a count
//     the POST would 409 on.
//
// Pattern mirrors creator-retrieval-version/route.ts: the public RPC asserts
// admin via _assert_caller_is_admin() (auth.uid()), so it MUST be called via the
// JWT-bound supabaseServer() client — the service-role client NULLs auth.uid()
// and the assert fails. Preview reads use the service-role client (admin already
// asserted in-process) for RLS-free counts.

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

type Body = { creator_id?: unknown };

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

  // JWT-bound client so auth.uid() resolves for _assert_caller_is_admin().
  const { supabaseServer } = await import('@/lib/supabase/server');
  const userSb = await supabaseServer();
  const { data, error } = await userSb.rpc('admin_purge_legacy_chunks', {
    p_creator_id: creatorId,
  });

  if (error) {
    const msg = (error.message ?? '').toLowerCase();
    if (error.code === '42704' || msg.includes('creator_not_found')) {
      return json(404, { error: 'creator_not_found' });
    }
    // 23514: the only check_violation this RPC raises is the not-on-v3 guard.
    // Match the leading token (the message interpolates the version value).
    if (error.code === '23514' || msg.includes('purge_refused')) {
      return json(409, { error: 'purge_refused_not_on_v3' });
    }
    if (error.code === '42501') {
      return json(403, { error: 'forbidden' });
    }
    Sentry.captureException(error, {
      extra: { op: 'admin_purge_legacy_chunks', creator_id: creatorId, admin_user_id: admin.userId },
    });
    return json(500, { error: 'purge_failed' });
  }

  try { revalidatePath(`/admin/creators/${creatorId}`); }
  catch (e) {
    Sentry.captureException(e, { extra: { op: 'revalidate_after_purge', creator_id: creatorId } });
  }

  // The RPC returns its delete counts + new corpus version as authoritative jsonb.
  return json(200, { ok: true, creator_id: creatorId, result: data ?? null });
}

// Preview — advisory counts of what a purge WOULD delete. Read-only; admin-gated
// (a service-role count read without the guard would leak corpus structure).
export async function GET(req: NextRequest) {
  try {
    await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) {
      const { status, body } = mapAuthGuardStatus(e.status);
      return json(status, body);
    }
    throw e;
  }

  const creatorId = req.nextUrl.searchParams.get('creator_id');
  if (!creatorId || !UUID_RE.test(creatorId)) return json(400, { error: 'bad_creator_id' });

  const sb = supabaseAdmin();

  const { data: creator, error: cErr } = await sb
    .from('creators')
    .select('retrieval_version, legacy_purged_at')
    .eq('id', creatorId)
    .maybeSingle<{ retrieval_version: number; legacy_purged_at: string | null }>();
  if (cErr) {
    Sentry.captureException(cErr, { extra: { op: 'purge_preview.creator', creator_id: creatorId } });
    return json(500, { error: 'preview_failed' });
  }
  if (!creator) return json(404, { error: 'creator_not_found' });

  // Replicate the RPC's retrieval_version=3 guard: never show a deletable count
  // for a creator the POST would 409 on (audit C3).
  if (creator.retrieval_version !== 3) {
    return json(200, {
      available: false,
      reason: 'not_on_v3',
      retrieval_version: creator.retrieval_version,
      legacy_purged_at: creator.legacy_purged_at,
    });
  }

  // EXACT mirror of the RPC's DELETE predicates.
  const { count: legacyChunks, error: chErr } = await sb
    .from('sample_content_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', creatorId)
    .in('chunker_version', [1, 2]);
  const { count: v2Units, error: uErr } = await sb
    .from('sample_content_narrative_units')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', creatorId)
    .is('section_id', null);
  if (chErr || uErr) {
    Sentry.captureException(chErr || uErr, { extra: { op: 'purge_preview.counts', creator_id: creatorId } });
    return json(500, { error: 'preview_failed' });
  }

  return json(200, {
    available: true,
    retrieval_version: creator.retrieval_version,
    legacy_purged_at: creator.legacy_purged_at,
    legacy_chunks: legacyChunks ?? 0,
    v2_narrative_units: v2Units ?? 0,
  });
}
