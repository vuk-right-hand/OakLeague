// POST /api/admin/corpus-reprocess — admin enqueues a v2 re-process for
// every ready sample of a creator. Bypasses the on-sample_content trigger's
// retrieval_version gate so a v1 creator's corpus can be re-processed into
// v2 chunks BEFORE flipping their retrieval_version.
//
// GET  /api/admin/corpus-reprocess?creator_id=…&limit=… — admin reads the
// queue state. The /admin/creators/[id] panel polls this every 5s to render
// per-sample progress.
//
// Day-6 RAG SOTA build (docs/_planning/RAG_SOTA_PLAN.md §5 + §11.Day6).
//
// Both endpoints:
//   - same-origin check (CSRF defense — POST mutates queue + audit log)
//   - JSON content-type required on POST (CSRF defense layered on origin)
//   - admin gate via assertAdminFromSession
//   - service-role RPC for the actual DB work (`_admin_enqueue_corpus_reprocess_unsafe`
//     and `admin_list_corpus_reprocess_jobs` — both audit-aware)

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

type EnqueueBody = { creator_id?: unknown; force?: unknown };

type EnqueueResultRow = {
  enqueued_count: number;
  total_ready_samples: number;
  skipped_in_flight: number;
  skipped_already_queued: number;
};

// Audit-1 C2: write a rejection audit row from the route layer when the RPC
// raises before reaching its own audit INSERT (the RPC's RAISE EXCEPTION
// rolls back any audit row written within the same transaction). The route
// has supabaseAdmin available which bypasses RLS, and writes the audit
// row with a distinct action so it's distinguishable from successful runs.
async function writeRejectionAudit(
  sb: ReturnType<typeof supabaseAdmin>,
  adminUserId: string,
  creatorId: string | null,
  reason: 'creator_not_found' | 'not_an_active_admin',
  force: boolean,
): Promise<void> {
  const { error } = await sb.from('admin_audit_log').insert({
    admin_user_id: adminUserId,
    action:        'creator_corpus_reprocess_enqueue_rejected',
    target_kind:   'creator',
    target_id:     creatorId,
    before:        { force, requested_creator_id: creatorId },
    after:         { reason },
  });
  if (error) {
    // Audit-write failure is non-fatal — the request was already rejected,
    // we just lose the audit row. Capture so Sentry alerts.
    Sentry.captureException(error, {
      extra: { op: 'audit_write_rejection', reason, creator_id: creatorId, admin_user_id: adminUserId },
    });
  }
}

type JobRow = {
  id: string;
  sample_id: string;
  sample_title: string | null;
  creator_id: string;
  target_version: number;
  status: string;
  attempts: number;
  last_error: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  finished_at: string | null;
  enqueue_version: number;
  progress_json: unknown;
  created_at: string;
};

// ───────────────────────── POST (enqueue) ─────────────────────────────────

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

  let body: EnqueueBody;
  try { body = (await req.json()) as EnqueueBody; }
  catch { return json(400, { error: 'bad_json' }); }

  const creatorId = typeof body.creator_id === 'string' && UUID_RE.test(body.creator_id)
    ? body.creator_id : null;
  if (!creatorId) return json(400, { error: 'bad_creator_id' });

  // Force is optional; only `true` literal toggles it on. Anything else (incl.
  // truthy strings) is treated as false — defensive against UI sending "true"
  // strings or the field being injected as something weird.
  const force = body.force === true;

  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc('_admin_enqueue_corpus_reprocess_unsafe', {
    p_admin_user_id: admin.userId,
    p_creator_id:    creatorId,
    p_force:         force,
  });

  if (error) {
    // PG message strings — set by RAISE EXCEPTION USING message=... in the
    // migration. Keep mapping narrow; everything else bubbles as 500.
    const msg = (error.message ?? '').toLowerCase();
    if (error.code === '42704' || msg.includes('creator_not_found')) {
      // Audit-1 C2: write rejection audit row from the route. The RPC's
      // RAISE EXCEPTION rolled back any audit insert it might have made.
      await writeRejectionAudit(sb, admin.userId, creatorId, 'creator_not_found', force);
      return json(404, { error: 'creator_not_found' });
    }
    if (error.code === '22023' || msg.includes('creator_id_null')) {
      return json(400, { error: 'creator_id_null' });
    }
    if (error.code === '42501' || msg.includes('not_an_active_admin')) {
      // Defense-in-depth — admin's role was revoked between assertAdmin and RPC.
      await writeRejectionAudit(sb, admin.userId, creatorId, 'not_an_active_admin', force);
      return json(403, { error: 'forbidden' });
    }
    Sentry.captureException(error, {
      extra: { op: 'admin_corpus_reprocess_enqueue', creator_id: creatorId, admin_user_id: admin.userId, force },
    });
    return json(500, { error: 'enqueue_failed' });
  }

  // supabase-js returns TABLE-returning functions as Array<row>. We have
  // exactly one row (RETURN NEXT once); echo it back.
  const row = Array.isArray(data) && data.length > 0
    ? (data[0] as EnqueueResultRow)
    : null;
  if (!row) {
    Sentry.captureMessage('admin_corpus_reprocess_enqueue_empty_result', {
      level: 'error',
      extra: { creator_id: creatorId, admin_user_id: admin.userId, force },
    });
    return json(500, { error: 'enqueue_no_result' });
  }

  // Audit-3 M3: revalidate the admin creator detail page so a hard
  // reload pulls the freshest reprocess queue state. The panel polls
  // GET /api/admin/corpus-reprocess every 5s so this is mostly cosmetic,
  // but it covers the edge where admin reloads in a second tab.
  try { revalidatePath(`/admin/creators/${creatorId}`); } catch { /* non-fatal */ }

  return json(200, {
    ok: true,
    creator_id: creatorId,
    force,
    enqueued_count:         row.enqueued_count,
    total_ready_samples:    row.total_ready_samples,
    skipped_in_flight:      row.skipped_in_flight,
    skipped_already_queued: row.skipped_already_queued,
  });
}

// ───────────────────────── GET (status poll) ──────────────────────────────

export async function GET(req: NextRequest) {
  // Audit-1 M2 fix: no same-origin check on GET. Read endpoint, no state
  // mutation, no CSRF surface (an external referrer with a stolen cookie
  // could read queue status — they could already read /admin/creators
  // via the same cookie). The origin check was producing false 403s when
  // the browser omitted Origin on same-origin GETs (Chrome/Firefox do this
  // for some navigation patterns). Auth alone is sufficient here.

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

  const url = new URL(req.url);
  const creatorIdRaw = url.searchParams.get('creator_id');
  const creatorId = creatorIdRaw && UUID_RE.test(creatorIdRaw) ? creatorIdRaw : null;
  if (!creatorId) return json(400, { error: 'bad_creator_id' });

  // Clamp limit. Default 100, max 500 (matches the RPC's GREATEST/LEAST).
  const limitRaw = url.searchParams.get('limit');
  const limitParsed = limitRaw === null ? 100 : parseInt(limitRaw, 10);
  const limit = Number.isFinite(limitParsed)
    ? Math.min(Math.max(limitParsed, 1), 500)
    : 100;

  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc('admin_list_corpus_reprocess_jobs', {
    p_creator_id: creatorId,
    p_limit:      limit,
  });

  if (error) {
    Sentry.captureException(error, {
      extra: { op: 'admin_corpus_reprocess_list', creator_id: creatorId, admin_user_id: admin.userId },
    });
    return json(500, { error: 'list_failed' });
  }

  const rows = (data ?? []) as JobRow[];

  // Pre-aggregated status counts for the UI's headline display. Cheaper to
  // compute server-side than ship the row list + recompute in the browser
  // (and the row list is also useful for the per-sample breakdown).
  const counts: Record<string, number> = { pending: 0, processing: 0, done: 0, errored: 0 };
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  }

  return json(200, {
    ok: true,
    creator_id: creatorId,
    total: rows.length,
    counts,
    rows,
  });
}
