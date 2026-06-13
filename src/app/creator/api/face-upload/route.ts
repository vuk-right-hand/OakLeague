// Creator face-upload — Simli Trinity-1 face training, self-serve (WS5).
//
// POST /creator/api/face-upload
//   multipart/form-data:
//     image: File (image/jpeg | image/png, ≤4.5 MB, dims 256–4096, aspect 9:16|16:9|1:1)
//   query (optional):
//     ?force=1 — required when the creator already has a simli_face_id
//
// Sibling of /api/admin/face-upload — NOT a wrapper (the trap, plan §0):
//   * assertCreatorFromSession() → creatorId from session ONLY (never body)
//   * audit row carries uploaded_by_user_id (admin_user_id stays NULL)
//   * rate limits key on uploaded_by_user_id
//   * finalize at status-time via face_clone_finalize_creator (auth.uid()),
//     which blocks an overwrite while the creator is published (M5).
//
// Production-only writes (same gate as admin; FACE_UPLOAD_ALLOW_LOCAL=1 for
// local e2e). Async like the admin path: returns uploadId, client polls
// /creator/api/face-upload/status.

import 'server-only';
import { NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import { assertCreatorFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { probeImage, classifyAspect } from '@/lib/avatar/image-probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = Math.floor(4.5 * 1024 * 1024); // 4.5 MB pre-flight (Simli rejects > 5 MB)
const MIN_DIM = 256;
const MAX_DIM = 4096;
const SIMLI_TRINITY_URL = 'https://api.simli.ai/faces/trinity';
const SIMLI_TIMEOUT_MS = 90_000;
const RATE_LIMIT_PER_24H = 3;
const RATE_LIMIT_ATTEMPTS_PER_24H = 20;

function jsonError(status: number, code: string, detail?: string) {
  return NextResponse.json({ error: code, ...(detail ? { detail } : {}) }, { status });
}

export async function POST(req: Request) {
  // 1. Creator gate — creatorId derived from session.
  let session: { userId: string; creatorId: string };
  try {
    session = await assertCreatorFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return jsonError(e.status, e.message);
    throw e;
  }
  const { userId, creatorId } = session;

  // 2. Same-origin (mirror admin route).
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

  // 3. Production-only gate (parity with admin; FACE_UPLOAD_ALLOW_LOCAL=1 for
  // local e2e only — must be unset in CI/preview/production).
  const vercelEnv = process.env.VERCEL_ENV || '';
  const localBypass = process.env.FACE_UPLOAD_ALLOW_LOCAL === '1';
  if (!(vercelEnv === 'production' || localBypass)) {
    return jsonError(
      503,
      'face_upload_only_in_production',
      'face-upload requires VERCEL_ENV=production (or FACE_UPLOAD_ALLOW_LOCAL=1 for local testing)',
    );
  }

  const simliKey = process.env.SIMLI_API_KEY || '';
  if (!simliKey) return jsonError(500, 'simli_misconfig', 'SIMLI_API_KEY unset');

  // 4. Content-Length pre-check.
  const cl = Number(req.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > MAX_BYTES + 64 * 1024) {
    return jsonError(413, 'face_too_large', `body=${cl}B > ${MAX_BYTES}B+envelope`);
  }

  // 5. Multipart parse.
  let form;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, 'bad_multipart');
  }
  const image = form.get('image');
  if (!(image instanceof Blob)) return jsonError(400, 'no_image');
  if (image.size === 0) return jsonError(400, 'empty_image');
  if (image.size > MAX_BYTES) return jsonError(413, 'face_too_large', `${image.size}B > ${MAX_BYTES}B`);

  // 6. Probe magic bytes + dims; ignore Content-Type from the form.
  const imgBuf = Buffer.from(await image.arrayBuffer());
  const probed = probeImage(imgBuf);
  if (!probed) return jsonError(415, 'bad_mime', 'only JPEG or PNG accepted');
  if (probed.width < MIN_DIM || probed.height < MIN_DIM) {
    return jsonError(400, 'bad_image_dims', `min ${MIN_DIM}px on each axis`);
  }
  if (probed.width > MAX_DIM || probed.height > MAX_DIM) {
    return jsonError(400, 'bad_image_dims', `max ${MAX_DIM}px on each axis`);
  }
  const aspect = classifyAspect(probed.width, probed.height);
  if (!aspect) return jsonError(400, 'bad_aspect', 'need 9:16, 16:9, or 1:1 (±5%)');

  const sha256 = createHash('sha256').update(imgBuf).digest('hex');
  const sb = supabaseAdmin();

  // 7. Rate limit. 3 successful trains + 20 attempts per 24h, keyed on the
  // creator (uploaded_by_user_id). No bypass list on the creator path.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: successCount, error: rateErr } = await sb
    .from('face_clone_uploads')
    .select('*', { count: 'exact', head: true })
    .eq('uploaded_by_user_id', userId)
    .gt('created_at', since)
    .eq('state', 'ready');
  if (rateErr) return jsonError(500, 'rate_lookup_failed');
  if ((successCount ?? 0) >= RATE_LIMIT_PER_24H) {
    return jsonError(429, 'rate_limit', `max ${RATE_LIMIT_PER_24H} successful trains per 24h`);
  }
  const { count: attemptCount, error: attemptErr } = await sb
    .from('face_clone_uploads')
    .select('*', { count: 'exact', head: true })
    .eq('uploaded_by_user_id', userId)
    .gt('created_at', since);
  if (attemptErr) return jsonError(500, 'rate_lookup_failed');
  if ((attemptCount ?? 0) >= RATE_LIMIT_ATTEMPTS_PER_24H) {
    return jsonError(429, 'rate_limit_attempts', `max ${RATE_LIMIT_ATTEMPTS_PER_24H} attempts per 24h`);
  }

  // 8. Creator row + consent + ?force gate. The atomic gate is
  // face_clone_finalize_creator at status-time; this saves a Simli call when
  // we can already tell we'll fail. published-while-live overwrite is blocked
  // in the RPC under the lock (M5) — we surface a friendly 409 here too.
  const { searchParams } = new URL(req.url);
  const force = searchParams.get('force') === '1';
  const { data: creator, error: creatorErr } = await sb
    .from('creators')
    .select('id, handle, simli_face_id, user_id, published_at')
    .eq('id', creatorId)
    .maybeSingle<{
      id: string;
      handle: string | null;
      simli_face_id: string | null;
      user_id: string;
      published_at: string | null;
    }>();
  if (creatorErr) return jsonError(500, 'creator_lookup_failed');
  if (!creator) return jsonError(404, 'creator_not_found');

  // Likeness consent (recorded at /apply for every creator). Mirror admin.
  const { count: likenessConsentCount, error: consentErr } = await sb
    .from('creator_consents')
    .select('id', { head: true, count: 'exact' })
    .eq('user_id', creator.user_id)
    .eq('consent_type', 'likeness')
    .is('revoked_at', null);
  if (consentErr) return jsonError(500, 'consent_lookup_failed');
  if ((likenessConsentCount ?? 0) === 0) {
    return jsonError(403, 'consent_missing', 'no likeness consent on record');
  }

  if (creator.simli_face_id) {
    // Already have a face. Overwrite is creator-allowed only while unpublished
    // (avatar identity is a live product surface once published — admin-only
    // changes after that, plan §C). Block early with a clear code.
    if (creator.published_at) return jsonError(409, 'face_locked_while_live');
    if (!force) return jsonError(409, 'already_face_trained', 'pass ?force=1 to overwrite');
  }
  const priorFaceId = creator.simli_face_id;

  // 9. Pre-insert audit row (uploaded_by_user_id; admin_user_id NULL).
  // force_overwrite persisted now so finalize doesn't read a per-poll param.
  const { data: uploadRow, error: insErr } = await sb
    .from('face_clone_uploads')
    .insert({
      uploaded_by_user_id: userId,
      creator_id: creatorId,
      vendor: 'simli',
      media_kind: 'image',
      sha256,
      mime: probed.mime,
      bytes: imgBuf.length,
      width: probed.width,
      height: probed.height,
      vendor_face_id: null,
      state: 'pending',
      force_overwrite: force,
    })
    .select('id')
    .single<{ id: number }>();
  if (insErr || !uploadRow) {
    console.error('[creator/face-upload] audit insert failed', insErr);
    return jsonError(500, 'audit_insert_failed');
  }

  // 10. POST to Simli /faces/trinity.
  const handleSlug = (creator.handle || creatorId.slice(0, 8)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  // Audit S3: random suffix so a same-millisecond double-submit can't collide
  // on the Simli face_name (keeps the audit trail readable).
  const faceName = `${handleSlug}_${Date.now()}_${randomUUID().slice(0, 8)}`;

  const fd = new FormData();
  fd.append('image', new Blob([imgBuf], { type: probed.mime }), `face.${probed.mime === 'image/png' ? 'png' : 'jpg'}`);

  let vendorFaceId: string;
  let warnings: unknown[] = [];
  let queuePosition: number | null = null;

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), SIMLI_TIMEOUT_MS);
  try {
    const url = new URL(SIMLI_TRINITY_URL);
    url.searchParams.set('face_name', faceName);
    url.searchParams.set('gsVersion', 'GSA_1.0');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-simli-api-key': simliKey },
      body: fd,
      signal: ac.signal,
    });

    if (!res.ok) {
      console.error('[creator/face-upload] simli non-200', res.status);
      let detailCode = 'face_train_failed';
      let detailMsg: string | undefined;
      try {
        const body = (await res.json().catch(() => null)) as { detail?: string } | null;
        const detail = String(body?.detail || '').toLowerCase();
        if (res.status === 413 || detail.includes('size must be less than')) detailCode = 'face_too_large';
        else if (res.status === 403 && detail.includes('max number of gs faces')) detailCode = 'simli_quota_exceeded';
        else if (/max queued requests|requests?\s+in\s+the\s+queue\s+already/.test(detail)) detailCode = 'simli_queue_full';
        else if (res.status === 422 || /no face|no subject|face not detected/.test(detail)) detailCode = 'face_no_subject';
        else if (res.status >= 500) detailCode = 'face_train_unreachable';
        if (body?.detail) detailMsg = String(body.detail).slice(0, 300);
      } catch {
        /* ignore */
      }
      await markFailed(sb, uploadRow.id, `simli_${res.status}_${detailCode}`);
      return NextResponse.json(
        { error: detailCode, ...(detailMsg ? { detail: detailMsg } : {}), uploadId: uploadRow.id },
        { status: res.status >= 500 ? 502 : res.status === 403 ? 403 : 400 },
      );
    }

    const body = (await res.json().catch(() => null)) as
      | { face_id?: string; warnings?: unknown[]; message?: string }
      | null;
    const id = body?.face_id;
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
      await markFailed(sb, uploadRow.id, 'simli_bad_response_no_face_id');
      return jsonError(502, 'face_train_bad_response');
    }
    vendorFaceId = id;
    warnings = Array.isArray(body?.warnings) ? (body!.warnings as unknown[]) : [];
    const m = /position in queue\s+(\d+)/i.exec(String(body?.message || ''));
    queuePosition = m ? Number(m[1]) : null;
  } catch (e) {
    const aborted = (e as Error)?.name === 'AbortError';
    console.error('[creator/face-upload] simli fetch failed', aborted ? 'abort' : e);
    await markFailed(sb, uploadRow.id, aborted ? 'simli_timeout' : 'simli_unreachable');
    return jsonError(502, 'face_train_unreachable');
  } finally {
    clearTimeout(timeout);
  }

  // 11. Register the pending face on the upload row (direct service-role write;
  // the append-only trigger permits vendor_face_id + warnings fill-once). On
  // failure, enqueue the now-unowned vendor face for delete.
  const { error: regErr } = await sb
    .from('face_clone_uploads')
    .update({ vendor_face_id: vendorFaceId, warnings })
    .eq('id', uploadRow.id)
    .is('vendor_face_id', null)
    .eq('state', 'pending');
  if (regErr) {
    console.error('[creator/face-upload] register failed', regErr);
    try {
      await sb.from('simli_face_delete_queue').upsert(
        { face_id: vendorFaceId, creator_id: creatorId, enqueued_by: userId, due_at: new Date().toISOString() },
        { onConflict: 'face_id' },
      );
    } catch (e) {
      console.error('[creator/face-upload] orphan-cleanup enqueue failed', e);
    }
    return jsonError(500, 'register_failed', regErr.code || 'unknown');
  }

  // 12. $0 cogs row at training start (provider-agnostic shape).
  try {
    await sb.from('cogs_log').insert({
      user_id: userId,
      session_id: null,
      service: 'simli',
      operation: 'avatar_face_train_enqueued',
      units: 1,
      unit_label: 'face',
      cost_usd: 0,
      environment: 'production',
      metadata: {
        creator_id: creatorId,
        upload_id: uploadRow.id,
        vendor_face_id: vendorFaceId,
        media_kind: 'image',
        bytes: imgBuf.length,
        pricing_unverified: true,
        queue_position: queuePosition,
        actor: 'creator',
      },
    });
  } catch (e) {
    console.error('[creator/face-upload] cogs audit failed', e);
  }

  // priorFaceId NOT enqueued for delete here — it stays live until the status
  // route flips this upload to 'ready' (no 'no face' window for the creator).
  return NextResponse.json({
    ok: true,
    uploadId: uploadRow.id,
    faceId: vendorFaceId,
    state: 'pending',
    queuePosition,
    warnings,
    overwrites: !!priorFaceId,
  });
}

// Direct service-role mark-failed (the admin face_clone_mark_failed RPC asserts
// admin_user_id; creator rows have none). The append-only trigger permits
// pending→failed + last_error fill-once.
async function markFailed(sb: ReturnType<typeof supabaseAdmin>, uploadId: number, lastError: string) {
  const { error } = await sb
    .from('face_clone_uploads')
    .update({ state: 'failed', last_error: lastError.slice(0, 500) })
    .eq('id', uploadId)
    .eq('state', 'pending');
  if (error) console.error('[creator/face-upload] markFailed failed', error);
}
