// SIMLI_WIREUP §12a.2 / R3-Missing-2 / R4-C3 — admin "force-retrain Simli
// replica" endpoint.
//
// POST /api/admin/simli-retrain
//   body: { creatorId: uuid }
//
// Calls admin_force_retrain_creator RPC which:
//   * Acquires pg_advisory_xact_lock (R4-C3 — serialize concurrent retrain).
//   * Raises P0001 'creator_has_active_session' if any open sessions.
//   * Clears creators.simli_face_id; enqueues prior face_id for 60s
//     deferred delete via simli_face_delete_queue.
//   * Audits to cogs_log (cost=0).
//
// Actual retrain (mint a new face from a stored source frame) is admin
// out-of-band today: after this endpoint succeeds, an admin uploads a
// fresh face via the Simli portal or a future /api/admin/simli-face-upload.
// Next /api/sessions/open against this creator returns 409
// creator_face_not_trained until that happens — which is the desired UX
// (admin sees the explicit "this creator's avatar is offline" state).

import 'server-only';
import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Auditor R3 small — strict RFC-4122 UUID v1-5. Same pattern used by
// `/api/admin/face-upload`; previously this route accepted non-RFC inputs
// the upload route would reject (inconsistency was a defense-in-depth gap).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function err(status: number, code: string, detail?: string) {
  return NextResponse.json({ error: code, ...(detail ? { detail } : {}) }, { status });
}

export async function POST(req: Request) {
  try {
    await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return err(e.status, e.message);
    throw e;
  }

  let body: { creatorId?: unknown };
  try { body = await req.json(); } catch { return err(400, 'bad_json'); }
  const creatorId = typeof body.creatorId === 'string' && UUID_RE.test(body.creatorId) ? body.creatorId : null;
  if (!creatorId) return err(400, 'bad_creator_id');

  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc('admin_force_retrain_creator', { p_creator_id: creatorId });
  if (error) {
    if (error.code === 'P0001' && /creator_has_active_session/.test(error.message || '')) {
      return err(409, 'creator_has_active_session', error.message);
    }
    Sentry.captureException(error, { extra: { op: 'admin_force_retrain', creator_id: creatorId } });
    return err(500, 'retrain_failed', error.code || 'unknown');
  }
  const row = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({
    ok: true,
    priorFaceId: row?.prior_face_id ?? null,
    cleared: row?.cleared ?? false,
  });
}
