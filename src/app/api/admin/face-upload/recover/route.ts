// Path C — admin recovery endpoint for timeout-orphan face_clone_uploads
// rows. Called when our route's POST to Simli timed out before receiving
// a face_id, but Simli accepted the upload and trained it. Admin sees
// the orphan in Simli Studio, pastes the face_id, this endpoint:
//
//   1. Validates the face_id is reachable via /compose/token (i.e. ready).
//   2. Calls face_clone_recover_timeout_orphan RPC (atomic insert + creator
//      simli_face_id update under advisory lock).
//   3. Enqueues prior face for 60s deferred delete (mirrors finalize_locked).
//
// Strict guards:
//   * admin gate + same-origin
//   * production-only writes (same gate as upload route, via VERCEL_ENV
//     or FACE_UPLOAD_ALLOW_LOCAL=1 for local-test)
//   * uploadId must be owned by caller, currently 'failed', last_error
//     contains 'timeout', vendor_face_id IS NULL
//   * provided face_id must be a UUID and produce a successful compose-token
//     mint (= proves Simli has it ready)

import 'server-only';
import { NextResponse } from 'next/server';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIMLI_COMPOSE_URL = 'https://api.simli.ai/compose/token';
const SIMLI_TIMEOUT_MS = 8_000;
const DELETE_DEFER_MS = 60_000;
const FACE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function jsonError(status: number, code: string, detail?: string) {
  return NextResponse.json({ error: code, ...(detail ? { detail } : {}) }, { status });
}

export async function POST(req: Request) {
  // 1. Admin gate.
  let admin;
  try {
    admin = await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return jsonError(e.status, e.message);
    throw e;
  }

  // 2. Same-origin.
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

  // 3. Production-only env gate (mirrors upload route's R2-C5 fix).
  const vercelEnv = process.env.VERCEL_ENV || '';
  const localBypass = process.env.FACE_UPLOAD_ALLOW_LOCAL === '1';
  const allowWrite = vercelEnv === 'production' || localBypass;
  if (!allowWrite) {
    return jsonError(503, 'face_upload_only_in_production');
  }

  // 4. Simli env present.
  const simliKey = process.env.SIMLI_API_KEY || '';
  if (!simliKey) return jsonError(500, 'simli_misconfig');

  // 5. Body.
  let body: { uploadId?: unknown; faceId?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'bad_json');
  }
  const uploadId = Number(body.uploadId);
  const faceId = typeof body.faceId === 'string' ? body.faceId.trim() : '';
  if (!Number.isFinite(uploadId) || uploadId <= 0) return jsonError(400, 'bad_upload_id');
  if (!FACE_ID_RE.test(faceId)) return jsonError(400, 'bad_face_id');

  const sb = supabaseAdmin();

  // 6. Validate the face_id is actually trainable / ready by minting a
  // 1-second compose-token. If Simli returns INVALID_FACE_ID the orphan
  // hasn't finished training yet and admin should wait.
  let composeStatus = 0;
  let composeBody: { detail?: string } | null = null;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), SIMLI_TIMEOUT_MS);
  try {
    const res = await fetch(SIMLI_COMPOSE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-simli-api-key': simliKey },
      body: JSON.stringify({
        faceId,
        handleSilence: false,
        maxSessionLength: 1,
        maxIdleTime: 1,
      }),
      signal: ac.signal,
    });
    composeStatus = res.status;
    composeBody = await res.json().catch(() => null);
  } catch {
    clearTimeout(to);
    return jsonError(502, 'simli_unreachable');
  } finally {
    clearTimeout(to);
  }

  if (composeStatus !== 200) {
    const detail = String(composeBody?.detail || '').toLowerCase();
    if (detail.includes('invalid_face_id')) {
      return jsonError(409, 'face_not_ready', 'Simli says this face_id is invalid or still training. Wait for it to complete and retry.');
    }
    return jsonError(502, 'simli_compose_failed', detail.slice(0, 200));
  }

  // 7. Run the recovery RPC.
  const { data: rpcData, error: rpcErr } = await sb.rpc('face_clone_recover_timeout_orphan', {
    p_admin_user_id: admin.userId,
    p_prior_upload_id: uploadId,
    p_vendor_face_id: faceId,
  });
  if (rpcErr) {
    console.error('[face-upload/recover] rpc failed', rpcErr.code, rpcErr.message);
    if (rpcErr.code === '55006') {
      const m = /(\d+)\s+active sessions/.exec(rpcErr.message || '');
      const activeSessions = m ? Number(m[1]) : undefined;
      return NextResponse.json(
        {
          error: 'creator_has_active_sessions',
          ...(activeSessions !== undefined ? { activeSessions } : {}),
        },
        { status: 409 },
      );
    }
    if (rpcErr.code === '23505') {
      const msg = rpcErr.message || '';
      if (/already has a face/.test(msg)) {
        return jsonError(409, 'already_face_trained', 'creator already has a face; the prior upload was not flagged for overwrite');
      }
      // Partial unique conflict — same face_id already attributed.
      return jsonError(409, 'already_recovered', 'this face_id is already associated with another upload row');
    }
    if (rpcErr.code === 'P0002') {
      // Recovery preconditions not met (state mismatch / not a timeout orphan).
      return jsonError(409, 'not_recoverable', rpcErr.message || 'prior upload is not a timeout orphan');
    }
    if (rpcErr.code === '23503') {
      return jsonError(404, 'upload_not_found');
    }
    if (rpcErr.code === '42501') {
      return jsonError(403, 'admin_required', rpcErr.message || 'unauthorized');
    }
    if (rpcErr.code === '22023') {
      return jsonError(400, 'bad_input', rpcErr.message || 'invalid input');
    }
    return jsonError(500, 'recover_failed', rpcErr.code || 'unknown');
  }

  type RecoverRow = { new_upload_id: number; prior_face_id: string | null };
  const row = Array.isArray(rpcData) && rpcData.length > 0
    ? (rpcData[0] as RecoverRow)
    : null;
  const priorFaceId = row?.prior_face_id ?? null;
  const newUploadId = row?.new_upload_id ?? null;

  // 8. Enqueue prior face for 60s-deferred delete (mirrors finalize_locked).
  if (priorFaceId && priorFaceId !== faceId) {
    const dueAt = new Date(Date.now() + DELETE_DEFER_MS).toISOString();
    const { error: queueErr } = await sb.from('simli_face_delete_queue').upsert(
      {
        face_id: priorFaceId,
        creator_id: undefined,
        enqueued_by: admin.userId,
        due_at: dueAt,
      },
      { onConflict: 'face_id' },
    );
    if (queueErr) console.error('[face-upload/recover] delete-queue enqueue failed', queueErr);
  }

  return NextResponse.json({
    ok: true,
    state: 'ready',
    faceId,
    newUploadId,
    overwrote: !!priorFaceId,
  });
}
