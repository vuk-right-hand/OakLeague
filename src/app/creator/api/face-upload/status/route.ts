// Creator face-upload polling endpoint (WS5).
//
// GET /creator/api/face-upload/status?uploadId=<id>
//
// Sibling of /api/admin/face-upload/status. Polls Simli's generation_status;
// on the first ready response calls face_clone_finalize_creator (auth.uid()
// ownership, NOT admin) via the JWT-bound client so auth.uid() resolves inside
// the SECDEF RPC. Service-role client is used for reads, Simli calls, and the
// prior-face delete-queue enqueue.
//
// Ownership: the upload row must have uploaded_by_user_id === session user.

import 'server-only';
import { NextResponse } from 'next/server';
import { assertCreatorFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIMLI_STATUS_URL = 'https://api.simli.ai/faces/trinity/generation_status';
const SIMLI_COMPOSE_URL = 'https://api.simli.ai/compose/token';
const SIMLI_TIMEOUT_MS = 8_000;
const DELETE_DEFER_MS = 60_000;

function jsonError(status: number, code: string, detail?: string) {
  return NextResponse.json({ error: code, ...(detail ? { detail } : {}) }, { status });
}

type UploadRow = {
  id: number;
  uploaded_by_user_id: string | null;
  creator_id: string;
  vendor_face_id: string | null;
  state: 'pending' | 'ready' | 'failed' | 'deleted';
  warnings: unknown;
  last_error: string | null;
  ready_at: string | null;
};

export async function GET(req: Request) {
  let session: { userId: string; creatorId: string };
  try {
    session = await assertCreatorFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return jsonError(e.status, e.message);
    throw e;
  }
  const { userId, creatorId } = session;

  // Same-origin (mirror upload route).
  const origin = req.headers.get('origin') || '';
  const host = req.headers.get('host') || '';
  if (origin) {
    try {
      const o = new URL(origin).host;
      const expected =
        process.env.VERCEL === '1' || process.env.NODE_ENV !== 'production'
          ? req.headers.get('x-forwarded-host') || host
          : host;
      if (o !== expected) return jsonError(403, 'cross_origin');
    } catch {
      return jsonError(403, 'bad_origin');
    }
  }

  const simliKey = process.env.SIMLI_API_KEY || '';
  if (!simliKey) return jsonError(500, 'simli_misconfig');

  const { searchParams } = new URL(req.url);
  const uploadId = Number(searchParams.get('uploadId'));
  if (!Number.isFinite(uploadId) || uploadId <= 0) return jsonError(400, 'bad_upload_id');

  const sb = supabaseAdmin();

  const { data: upload, error: rowErr } = await sb
    .from('face_clone_uploads')
    .select('id, uploaded_by_user_id, creator_id, vendor_face_id, state, warnings, last_error, ready_at')
    .eq('id', uploadId)
    .maybeSingle<UploadRow>();
  if (rowErr) return jsonError(500, 'upload_lookup_failed');
  if (!upload) return jsonError(404, 'upload_not_found');
  if (upload.uploaded_by_user_id !== userId || upload.creator_id !== creatorId) {
    return jsonError(403, 'not_owner');
  }

  // Terminal states return immediately.
  if (upload.state === 'ready') {
    return NextResponse.json({
      ok: true,
      state: 'ready',
      faceId: upload.vendor_face_id,
      warnings: upload.warnings ?? [],
      readyAt: upload.ready_at,
    });
  }
  if (upload.state === 'failed') {
    return NextResponse.json({
      ok: false,
      state: 'failed',
      error: 'face_train_failed',
      lastError: upload.last_error,
      warnings: upload.warnings ?? [],
    });
  }
  if (upload.state === 'deleted') {
    return NextResponse.json({ ok: false, state: 'deleted', error: 'upload_deleted' });
  }
  if (!upload.vendor_face_id) {
    return NextResponse.json({ ok: false, state: 'pending', error: 'face_id_missing' });
  }

  // Hit Simli generation_status.
  let simliStatus: { status?: string; queue_position?: number } | null = null;
  let httpStatus = 0;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), SIMLI_TIMEOUT_MS);
  try {
    const url = new URL(SIMLI_STATUS_URL);
    url.searchParams.set('face_id', upload.vendor_face_id);
    const res = await fetch(url, { method: 'GET', headers: { 'x-simli-api-key': simliKey }, signal: ac.signal });
    httpStatus = res.status;
    if (res.ok) simliStatus = await res.json().catch(() => null);
  } catch {
    return NextResponse.json({ ok: false, state: 'pending', simliReachable: false });
  } finally {
    clearTimeout(to);
  }

  if (httpStatus === 404) {
    await markFailed(sb, upload.id, 'simli_face_not_found_after_train');
    return jsonError(502, 'face_train_failed', 'simli no longer recognizes the face_id');
  }
  if (httpStatus !== 200 || !simliStatus) {
    return NextResponse.json({ ok: false, state: 'pending', simliReachable: true, simliStatus: httpStatus });
  }

  const rawStatus = String(simliStatus.status || '').toLowerCase();
  const queuePos = typeof simliStatus.queue_position === 'number' ? simliStatus.queue_position : null;

  if (rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'rejected') {
    await markFailed(sb, upload.id, `simli_status_${rawStatus}`);
    return NextResponse.json({ ok: false, state: 'failed', error: 'face_train_failed' });
  }
  if (rawStatus === 'pending' || rawStatus === 'processing' || rawStatus === 'queued') {
    return NextResponse.json({ ok: true, state: 'pending', simliStatus: rawStatus, queuePosition: queuePos });
  }

  // Unknown / probable-ready value — probe compose-token for the truth
  // (minimum-length probe so Simli releases the session immediately).
  let composeOk = false;
  let composeBody: { detail?: string } | null = null;
  try {
    const ac2 = new AbortController();
    const to2 = setTimeout(() => ac2.abort(), SIMLI_TIMEOUT_MS);
    const res = await fetch(SIMLI_COMPOSE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-simli-api-key': simliKey },
      body: JSON.stringify({ faceId: upload.vendor_face_id, handleSilence: false, maxSessionLength: 1, maxIdleTime: 1 }),
      signal: ac2.signal,
    });
    clearTimeout(to2);
    composeOk = res.ok;
    if (!res.ok) composeBody = await res.json().catch(() => null);
  } catch {
    return NextResponse.json({ ok: true, state: 'pending', simliStatus: rawStatus, queuePosition: queuePos });
  }

  if (!composeOk) {
    const detail = String(composeBody?.detail || '').toLowerCase();
    if (detail.includes('invalid_face_id')) {
      return NextResponse.json({ ok: true, state: 'pending', simliStatus: rawStatus, queuePosition: queuePos });
    }
    await markFailed(sb, upload.id, `compose_probe_failed_${(detail || 'unknown').slice(0, 60)}`);
    return NextResponse.json({ ok: false, state: 'failed', error: 'face_train_failed' });
  }

  // Ready! Finalize via the JWT-bound client (auth.uid() must resolve inside
  // face_clone_finalize_creator). Ownership + locked-while-live live in the RPC.
  const jwt = await supabaseServer();
  const { data: finalizeData, error: finalizeErr } = await jwt.rpc('face_clone_finalize_creator', {
    p_upload_id: upload.id,
    p_vendor_face_id: upload.vendor_face_id,
  });
  if (finalizeErr) {
    console.error('[creator/face-upload/status] finalize failed', finalizeErr.code, finalizeErr.message);
    const msg = finalizeErr.message || '';
    if (finalizeErr.code === '55006') {
      const m = /(\d+)\s+active sessions/.exec(msg);
      return NextResponse.json(
        { ok: false, state: 'pending', error: 'creator_has_active_sessions', ...(m ? { activeSessions: Number(m[1]) } : {}) },
        { status: 409 },
      );
    }
    if (finalizeErr.code === 'P0001' && /face_locked_while_live/.test(msg)) {
      await orphanCleanup(sb, upload, userId, 'face_locked_while_live');
      return NextResponse.json({ ok: false, state: 'failed', error: 'face_locked_while_live' }, { status: 409 });
    }
    if (finalizeErr.code === 'P0001' && /face_state_drift/.test(msg)) {
      await orphanCleanup(sb, upload, userId, 'face_state_drift_after_retrain');
      return NextResponse.json({ ok: false, state: 'failed', error: 'face_state_drift' }, { status: 409 });
    }
    if (finalizeErr.code === '23505' && /already has a face/.test(msg)) {
      await orphanCleanup(sb, upload, userId, 'lost_concurrent_finalize_race');
      return NextResponse.json({ ok: false, state: 'failed', error: 'already_face_trained' }, { status: 409 });
    }
    return jsonError(500, 'finalize_failed', finalizeErr.code || 'unknown');
  }

  type FinalizeRow = { prior_face_id: string | null };
  const finalizeRow =
    Array.isArray(finalizeData) && finalizeData.length > 0 ? (finalizeData[0] as FinalizeRow) : null;
  const priorFaceId = finalizeRow?.prior_face_id ?? null;

  // Enqueue prior face for 60s-deferred delete.
  if (priorFaceId && priorFaceId !== upload.vendor_face_id) {
    const dueAt = new Date(Date.now() + DELETE_DEFER_MS).toISOString();
    const { error: queueErr } = await sb.from('simli_face_delete_queue').upsert(
      { face_id: priorFaceId, creator_id: upload.creator_id, enqueued_by: userId, due_at: dueAt },
      { onConflict: 'face_id' },
    );
    if (queueErr) console.error('[creator/face-upload/status] delete-queue enqueue failed', queueErr);
  }

  return NextResponse.json({
    ok: true,
    state: 'ready',
    faceId: upload.vendor_face_id,
    warnings: upload.warnings ?? [],
    overwrote: !!priorFaceId,
    readyAt: new Date().toISOString(),
  });
}

async function markFailed(sb: ReturnType<typeof supabaseAdmin>, uploadId: number, lastError: string) {
  const { error } = await sb
    .from('face_clone_uploads')
    .update({ state: 'failed', last_error: lastError.slice(0, 500) })
    .eq('id', uploadId)
    .eq('state', 'pending');
  if (error) console.error('[creator/face-upload/status] markFailed failed', error);
}

// The vendor face we trained is now unowned (lost race, drift, or locked).
// Mark this pending row failed + enqueue the orphan vendor face for delete.
async function orphanCleanup(
  sb: ReturnType<typeof supabaseAdmin>,
  upload: UploadRow,
  userId: string,
  reason: string,
) {
  await markFailed(sb, upload.id, reason);
  if (upload.vendor_face_id) {
    try {
      await sb.from('simli_face_delete_queue').upsert(
        { face_id: upload.vendor_face_id, creator_id: upload.creator_id, enqueued_by: userId, due_at: new Date().toISOString() },
        { onConflict: 'face_id' },
      );
    } catch (e) {
      console.error('[creator/face-upload/status] orphan enqueue failed', e);
    }
  }
}
