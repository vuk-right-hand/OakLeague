// POST /api/admin/corpus-promote-v2 — admin "Promote v2" cleanup. DELETEs
// every chunker_version=1 chunk for a creator after confirming
// chunker_version=2 chunks exist (footgun guard inside the RPC).
//
// Day-7 RAG-SOTA build (docs/_planning/RAG_SOTA_PLAN.md §5 step 4 + §11.Day7).
//
// After re-process completes and side-by-side comparison confirms v2 is
// stronger, admin clicks Promote → v1 chunks are DELETEd so storage stops
// double-paying AND the legacy creator_knowledge_topk RPC (which filters
// chunker_version=1) returns empty. After this, the creator's retrieval
// MUST run via the Phase-2 hybrid path (lands later) OR the creator should
// be at retrieval_version=2 already so the right read path is selected.
//
// Promote is itself NOT the flip — that's admin_set_creator_retrieval_version.
// Two separate admin actions, two separate audit rows, easy to roll back
// (re-process to recreate v1 if needed, though no current button does so).

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

type PromoteResultRow = {
  deleted_v1_count: number;
  remaining_v2_count: number;
};

type RejectReason =
  | 'creator_not_found'
  | 'not_an_active_admin'
  | 'no_v2_chunks_yet'
  | 'reprocess_in_progress';

// Audit-2 M6: distinct action per rejection so an admin-audit-log grep can
// filter by mode (revoked-admin attempt vs no-v2 footgun vs in-flight race).
const REJECT_ACTION: Record<RejectReason, string> = {
  creator_not_found:     'creator_promote_v2_chunks_rejected_creator_not_found',
  not_an_active_admin:   'creator_promote_v2_chunks_rejected_not_an_active_admin',
  no_v2_chunks_yet:      'creator_promote_v2_chunks_rejected_no_v2_chunks_yet',
  reprocess_in_progress: 'creator_promote_v2_chunks_rejected_reprocess_in_progress',
};

async function writeRejectionAudit(
  sb: ReturnType<typeof supabaseAdmin>,
  adminUserId: string,
  creatorId: string | null,
  reason: RejectReason,
): Promise<void> {
  const { error } = await sb.from('admin_audit_log').insert({
    admin_user_id: adminUserId,
    action:        REJECT_ACTION[reason],
    target_kind:   'creator',
    target_id:     creatorId,
    before:        { requested_creator_id: creatorId },
    after:         { reason },
  });
  if (error) {
    Sentry.captureException(error, {
      extra: { op: 'audit_write_rejection', reason, creator_id: creatorId, admin_user_id: adminUserId },
    });
  }
}

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

  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc('_admin_promote_v2_chunks_unsafe', {
    p_admin_user_id: admin.userId,
    p_creator_id:    creatorId,
  });

  if (error) {
    const msg = (error.message ?? '').toLowerCase();
    if (error.code === '42704' || msg.includes('creator_not_found')) {
      await writeRejectionAudit(sb, admin.userId, creatorId, 'creator_not_found');
      return json(404, { error: 'creator_not_found' });
    }
    if (error.code === '22023' && msg.includes('no_v2_chunks_yet')) {
      // Footgun-guard fired — admin tried to promote without re-processing first.
      await writeRejectionAudit(sb, admin.userId, creatorId, 'no_v2_chunks_yet');
      return json(409, { error: 'no_v2_chunks_yet' });
    }
    if (
      error.code === '55P03' ||
      msg.includes('lock_not_available') ||
      msg.includes('canceling statement due to lock timeout') ||
      msg.includes('reprocess_in_progress')
    ) {
      // Audit-2 C3 (lock_timeout) + Audit-3 C1 (state-guard for active
      // reprocess worker — RPC explicitly raises 55P03 with message
      // 'reprocess_in_progress' when status='processing' rows exist).
      await writeRejectionAudit(sb, admin.userId, creatorId, 'reprocess_in_progress');
      return json(409, { error: 'reprocess_in_progress' });
    }
    if (error.code === '22023') {
      return json(400, { error: 'invalid_argument' });
    }
    if (error.code === '42501' || msg.includes('not_an_active_admin')) {
      await writeRejectionAudit(sb, admin.userId, creatorId, 'not_an_active_admin');
      return json(403, { error: 'forbidden' });
    }
    Sentry.captureException(error, {
      extra: { op: 'admin_corpus_promote_v2', creator_id: creatorId, admin_user_id: admin.userId },
    });
    return json(500, { error: 'promote_failed' });
  }

  const row = Array.isArray(data) && data.length > 0
    ? (data[0] as PromoteResultRow)
    : null;
  if (!row) {
    Sentry.captureMessage('admin_corpus_promote_v2_empty_result', {
      level: 'error',
      extra: { creator_id: creatorId, admin_user_id: admin.userId },
    });
    return json(500, { error: 'promote_no_result' });
  }

  // Audit-3 M3: revalidate the creator detail page so retrieval_version /
  // chunk-count fields refresh on next view without manual reload.
  try { revalidatePath(`/admin/creators/${creatorId}`); } catch { /* non-fatal */ }

  return json(200, {
    ok: true,
    creator_id: creatorId,
    deleted_v1_count:    row.deleted_v1_count,
    remaining_v2_count:  row.remaining_v2_count,
  });
}
