// Admin face-upload polling endpoint.
//
// GET /api/admin/face-upload/status?uploadId=<id>
//
// Called from the FaceUpload UI cell every ~3s after kickoff. Server-side
// hits Simli's GET /faces/trinity/generation_status. On the first ready
// response, calls face_clone_finalize_locked to atomically:
//   - flip the upload row to state='ready'
//   - set creators.simli_face_id (overwriting using force_overwrite from the audit row)
//   - return prior_face_id
// Then enqueues the prior face for 60s-deferred delete (mirrors voice-clone
// overwrite path).
//
// Auditor R2-M2 — force is read from the audit row, NOT from a query
// param. Persisted at upload time.
//
// Status field semantics (Phase 0 — see PHASE_0_FACE_API.md):
//   - "pending" / "processing" → keep polling
//   - "failed" / "error"       → terminal, mark upload row failed
//   - any other value          → probe with /compose/token; if 200 → ready
//                                 if INVALID_FACE_ID → still pending
// Bulletproof against Simli's success-state vocabulary changes.

import 'server-only';
import { NextResponse } from 'next/server';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';

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
  admin_user_id: string;
  creator_id: string;
  vendor: string;
  vendor_face_id: string | null;
  state: 'pending' | 'ready' | 'failed' | 'deleted';
  warnings: unknown;
  last_error: string | null;
  ready_at: string | null;
  created_at: string;
};

export async function GET(req: Request) {
  // 1. Admin gate.
  let admin;
  try {
    admin = await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return jsonError(e.status, e.message);
    throw e;
  }

  // 2. Same-origin (mirror upload route).
  const origin = req.headers.get('origin') || '';
  const host = req.headers.get('host') || '';
  if (origin) {
    try {
      const o = new URL(origin).host;
      const expected = process.env.VERCEL === '1' || process.env.NODE_ENV !== 'production'
        ? (req.headers.get('x-forwarded-host') || host)
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

  // 3. Load upload row.
  const { data: upload, error: rowErr } = await sb
    .from('face_clone_uploads')
    .select('id, admin_user_id, creator_id, vendor, vendor_face_id, state, warnings, last_error, ready_at, created_at')
    .eq('id', uploadId)
    .maybeSingle<UploadRow>();
  if (rowErr) return jsonError(500, 'upload_lookup_failed');
  if (!upload) return jsonError(404, 'upload_not_found');
  if (upload.admin_user_id !== admin.userId) return jsonError(403, 'admin_mismatch');

  // Terminal states return immediately without hitting Simli.
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
    // Pending but Simli never gave us a face_id (the route's pre-insert
    // row before the simli call). Should be rare — admin can resubmit.
    return NextResponse.json({ ok: false, state: 'pending', error: 'face_id_missing' });
  }

  // 4. Hit Simli generation_status.
  let simliStatus: { status?: string; queue_position?: number } | null = null;
  let httpStatus = 0;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), SIMLI_TIMEOUT_MS);
  try {
    const url = new URL(SIMLI_STATUS_URL);
    url.searchParams.set('face_id', upload.vendor_face_id);
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-simli-api-key': simliKey },
      signal: ac.signal,
    });
    httpStatus = res.status;
    if (res.ok) {
      simliStatus = await res.json().catch(() => null);
    }
  } catch {
    // Treat as still-pending; client will retry. Don't terminate the upload.
    return NextResponse.json({ ok: false, state: 'pending', simliReachable: false });
  } finally {
    clearTimeout(to);
  }

  if (httpStatus === 404) {
    // Simli forgot the face — terminal failure.
    await sb.rpc('face_clone_mark_failed', {
      p_admin_user_id: admin.userId,
      p_upload_id: upload.id,
      p_last_error: 'simli_face_not_found_after_train',
    });
    return jsonError(502, 'face_train_failed', 'simli no longer recognizes the face_id');
  }
  if (httpStatus !== 200 || !simliStatus) {
    return NextResponse.json({ ok: false, state: 'pending', simliReachable: true, simliStatus: httpStatus });
  }

  const rawStatus = String(simliStatus.status || '').toLowerCase();
  const queuePos = typeof simliStatus.queue_position === 'number' ? simliStatus.queue_position : null;

  // Failure terminal.
  if (rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'rejected') {
    await sb.rpc('face_clone_mark_failed', {
      p_admin_user_id: admin.userId,
      p_upload_id: upload.id,
      p_last_error: `simli_status_${rawStatus}`,
    });
    return NextResponse.json({ ok: false, state: 'failed', error: 'face_train_failed' });
  }

  // Still working.
  if (rawStatus === 'pending' || rawStatus === 'processing' || rawStatus === 'queued') {
    return NextResponse.json({
      ok: true,
      state: 'pending',
      simliStatus: rawStatus,
      queuePosition: queuePos,
    });
  }

  // Unknown / probable-ready value. Probe compose-token for the truth.
  // Auditor R2-M4 — minimum-length probe so Simli releases the token
  // immediately and the probe doesn't burn a real session window or
  // count toward the Hobby-tier 2-concurrent-session ceiling.
  let composeOk = false;
  let composeBody: { detail?: string } | null = null;
  try {
    const ac2 = new AbortController();
    const to2 = setTimeout(() => ac2.abort(), SIMLI_TIMEOUT_MS);
    const res = await fetch(SIMLI_COMPOSE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-simli-api-key': simliKey },
      body: JSON.stringify({
        faceId: upload.vendor_face_id,
        handleSilence: false,
        maxSessionLength: 1,
        maxIdleTime: 1,
      }),
      signal: ac2.signal,
    });
    clearTimeout(to2);
    composeOk = res.ok;
    if (!res.ok) composeBody = await res.json().catch(() => null);
  } catch {
    // Network hiccup — treat as still pending.
    return NextResponse.json({
      ok: true,
      state: 'pending',
      simliStatus: rawStatus,
      queuePosition: queuePos,
    });
  }

  if (!composeOk) {
    const detail = String(composeBody?.detail || '').toLowerCase();
    if (detail.includes('invalid_face_id')) {
      // Still pending — Simli's status keyword was misleading.
      return NextResponse.json({
        ok: true,
        state: 'pending',
        simliStatus: rawStatus,
        queuePosition: queuePos,
      });
    }
    // Other compose error; surface as failure.
    await sb.rpc('face_clone_mark_failed', {
      p_admin_user_id: admin.userId,
      p_upload_id: upload.id,
      p_last_error: `compose_probe_failed_${(detail || 'unknown').slice(0, 60)}`,
    });
    return NextResponse.json({ ok: false, state: 'failed', error: 'face_train_failed' });
  }

  // Ready! Run finalize_locked. Force flag is read from the upload row
  // server-side (auditor R2-M2).
  const { data: finalizeData, error: finalizeErr } = await sb.rpc('face_clone_finalize_locked', {
    p_admin_user_id: admin.userId,
    p_upload_id: upload.id,
    p_creator_id: upload.creator_id,
    p_vendor_face_id: upload.vendor_face_id,
  });
  if (finalizeErr) {
    console.error('[face-upload/status] finalize failed', finalizeErr.code);
    if (finalizeErr.code === '55006') {
      const m = /(\d+)\s+active sessions/.exec(finalizeErr.message || '');
      const activeSessions = m ? Number(m[1]) : undefined;
      return NextResponse.json(
        {
          ok: false,
          state: 'pending',
          error: 'creator_has_active_sessions',
          ...(activeSessions !== undefined ? { activeSessions } : {}),
        },
        { status: 409 },
      );
    }
    if (finalizeErr.code === '23505') {
      const msg = finalizeErr.message || '';
      if (/already has a face/.test(msg)) {
        // Auditor R2-C2 — concurrent upload race: another tab won. The
        // vendor face we just trained is now an orphan. Mark this row
        // failed and enqueue the orphan vendor face for delete in one
        // RPC so audit + queue stay consistent.
        //
        // Auditor R4-C1 — orphan_cleanup itself can raise
        // `42501 orphan_cleanup_refused_live_face` if a future caller
        // ever invokes it against a live ready row whose vendor_face_id
        // == creators.simli_face_id. Today the active code path can't
        // reach that case (we only call it on losing-race rows whose
        // creators row is owned by the winner), but swallow defensively
        // so a future regression doesn't surface as a 500 to the user.
        try {
          const { error: cleanupErr } = await sb.rpc('face_clone_orphan_cleanup', {
            p_admin_user_id: admin.userId,
            p_upload_id: upload.id,
            p_creator_id: upload.creator_id,
            p_vendor_face_id: upload.vendor_face_id,
            p_reason: 'lost_concurrent_finalize_race',
          });
          if (cleanupErr && !/orphan_cleanup_refused_live_face/.test(cleanupErr.message || '')) {
            console.error('[face-upload/status] orphan_cleanup failed', cleanupErr);
          }
        } catch (cleanupErr) {
          console.error('[face-upload/status] orphan_cleanup threw', cleanupErr);
        }
        return NextResponse.json(
          { ok: false, state: 'failed', error: 'already_face_trained' },
          { status: 409 },
        );
      }
    }
    if (finalizeErr.code === 'P0001' && /face_state_drift/.test(finalizeErr.message || '')) {
      // Auditor R2-C3 — idempotent re-call detected creators.simli_face_id
      // no longer matches our vendor_face_id (force-retrain happened
      // mid-poll). Treat as orphan and clean up.
      //
      // Auditor R4-C1 — same swallow as above for 42501.
      try {
        const { error: cleanupErr } = await sb.rpc('face_clone_orphan_cleanup', {
          p_admin_user_id: admin.userId,
          p_upload_id: upload.id,
          p_creator_id: upload.creator_id,
          p_vendor_face_id: upload.vendor_face_id,
          p_reason: 'face_state_drift_after_retrain',
        });
        if (cleanupErr && !/orphan_cleanup_refused_live_face/.test(cleanupErr.message || '')) {
          console.error('[face-upload/status] drift orphan_cleanup failed', cleanupErr);
        }
      } catch (cleanupErr) {
        console.error('[face-upload/status] drift orphan_cleanup threw', cleanupErr);
      }
      return NextResponse.json(
        { ok: false, state: 'failed', error: 'face_state_drift' },
        { status: 409 },
      );
    }
    return jsonError(500, 'finalize_failed', finalizeErr.code || 'unknown');
  }

  type FinalizeRow = { prior_face_id: string | null };
  const finalizeRow = Array.isArray(finalizeData) && finalizeData.length > 0
    ? (finalizeData[0] as FinalizeRow)
    : null;
  const priorFaceId = finalizeRow?.prior_face_id ?? null;

  // Enqueue prior face for 60s-deferred delete.
  if (priorFaceId && priorFaceId !== upload.vendor_face_id) {
    const dueAt = new Date(Date.now() + DELETE_DEFER_MS).toISOString();
    const { error: queueErr } = await sb.from('simli_face_delete_queue').upsert(
      {
        face_id: priorFaceId,
        creator_id: upload.creator_id,
        enqueued_by: admin.userId,
        due_at: dueAt,
      },
      { onConflict: 'face_id' },
    );
    if (queueErr) console.error('[face-upload/status] delete-queue enqueue failed', queueErr);
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
