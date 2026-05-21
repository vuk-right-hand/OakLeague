// Admin face-upload — Simli Trinity-1 face training kickoff.
//
// POST /api/admin/face-upload
//   multipart/form-data:
//     creatorId: uuid
//     name:      string (≤80 chars) — passed as Simli face_name
//     image:     File   (image/jpeg | image/png, ≤4.5 MB, dims 256–4096, aspect 9:16|16:9|1:1)
//   query (optional):
//     ?force=1   — required when creators.simli_face_id is already populated
//
// Phase 0 (PHASE_0_FACE_API.md) found Simli is async: POST returns 200
// with { face_id, message, warnings[] } even though the face is still
// pending generation. We register it as 'pending' and return uploadId to
// the client, which then polls /api/admin/face-upload/status?uploadId=N.
// `creators.simli_face_id` is NOT set here; the status route flips it
// when generation_status reports ready.
//
// Production-only writes (PRD line: face training is once per creator,
// preview/dev populate via SQL — FACE_UI_PLAN §3, Q3=A).
//
// 5 MB Simli ceiling enforced as 4.5 MB at this layer (500 KB headroom).

import 'server-only';
import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { probeImage, classifyAspect } from '@/lib/avatar/image-probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = Math.floor(4.5 * 1024 * 1024); // 4.5 MB pre-flight (Simli rejects > 5 MB)
const MIN_DIM = 256;
const MAX_DIM = 4096;
const SIMLI_TRINITY_URL = 'https://api.simli.ai/faces/trinity';
// Phase 0 measured ~2s acknowledgment from Simli, but in production we've
// observed 30s+ when residential upload bandwidth is constrained or Simli
// is doing first-request warmup after a queue-empty period. 90s is well
// above the long tail seen so far. If this ever times out for real,
// Simli is broken on their side, not slow.
const SIMLI_TIMEOUT_MS = 90_000;
const RATE_LIMIT_PER_24H = 3;
const RATE_LIMIT_ATTEMPTS_PER_24H = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  // 2. Same-origin (mirror voice-clone pattern).
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

  // 3. Production-only env gate (Q3=A: all envs share the prod Simli account
  // for reads; only production can write the face record + train).
  // Auditor R2-C5 — fail-closed. Pre-fix the gate was permissive on hosts
  // where VERCEL_ENV was unset (custom Docker, Fly.io, `next start` on a
  // VPS, CI runs); a smoke build outside Vercel could quietly POST against
  // production Simli and burn a face slot. Now requires an explicit
  // positive assertion: VERCEL_ENV='production' OR an opt-in
  // FACE_UPLOAD_ALLOW_LOCAL=1 set only in `.env.local` for end-to-end
  // local testing. The local bypass is documented in CLAUDE.md /
  // FACE_UI_PLAN §3 and must be unset in CI / production / preview.
  const vercelEnv = process.env.VERCEL_ENV || '';
  const localBypass = process.env.FACE_UPLOAD_ALLOW_LOCAL === '1';
  const allowWrite = vercelEnv === 'production' || localBypass;
  if (!allowWrite) {
    return jsonError(
      503,
      'face_upload_only_in_production',
      'face-upload requires VERCEL_ENV=production (or FACE_UPLOAD_ALLOW_LOCAL=1 for local testing); populate creators.simli_face_id manually otherwise',
    );
  }

  // 4. Simli env present?
  const simliKey = process.env.SIMLI_API_KEY || '';
  if (!simliKey) return jsonError(500, 'simli_misconfig', 'SIMLI_API_KEY unset');

  // 5. Content-Length pre-check.
  const cl = Number(req.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > MAX_BYTES + 64 * 1024) {
    return jsonError(413, 'face_too_large', `body=${cl}B > ${MAX_BYTES}B+envelope`);
  }

  // 6. Multipart parse.
  let form;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, 'bad_multipart');
  }
  const creatorId = String(form.get('creatorId') || '');
  const rawName = String(form.get('name') || '');
  const name = rawName
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>{}|\\\/]/g, '')
    .trim()
    .slice(0, 80);
  const image = form.get('image');
  if (!creatorId || !UUID_RE.test(creatorId)) return jsonError(400, 'bad_creator_id');
  if (!name) return jsonError(400, 'bad_name');
  if (!(image instanceof Blob)) return jsonError(400, 'no_image');
  if (image.size === 0) return jsonError(400, 'empty_image');
  if (image.size > MAX_BYTES) return jsonError(413, 'face_too_large', `${image.size}B > ${MAX_BYTES}B`);

  // 7. Probe magic bytes + dims; ignore Content-Type from the form.
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

  // 8. Rate limit. 3 successful trains + 20 attempts per 24h. Mirrors
  // voice-clone caps. Bypass list reads union of new + old env names
  // (CREATOR_CLONE_RATE_LIMIT_BYPASS is the going-forward name; voice-
  // clone keeps reading the old VOICE_CLONE_RATE_LIMIT_BYPASS too).
  const bypassList = (
    (process.env.CREATOR_CLONE_RATE_LIMIT_BYPASS || '') + ',' +
    (process.env.VOICE_CLONE_RATE_LIMIT_BYPASS || '')
  ).split(',').map((s) => s.trim()).filter(Boolean);
  const isBypassAdmin = bypassList.includes(admin.userId);

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: successCount, error: rateErr } = await sb
    .from('face_clone_uploads')
    .select('*', { count: 'exact', head: true })
    .eq('admin_user_id', admin.userId)
    .gt('created_at', since)
    .eq('state', 'ready');
  if (rateErr) return jsonError(500, 'rate_lookup_failed');
  if (!isBypassAdmin && (successCount ?? 0) >= RATE_LIMIT_PER_24H) {
    return jsonError(429, 'rate_limit', `max ${RATE_LIMIT_PER_24H} successful trains per 24h`);
  }
  const { count: attemptCount, error: attemptErr } = await sb
    .from('face_clone_uploads')
    .select('*', { count: 'exact', head: true })
    .eq('admin_user_id', admin.userId)
    .gt('created_at', since);
  if (attemptErr) return jsonError(500, 'rate_lookup_failed');
  if (!isBypassAdmin && (attemptCount ?? 0) >= RATE_LIMIT_ATTEMPTS_PER_24H) {
    return jsonError(429, 'rate_limit_attempts', `max ${RATE_LIMIT_ATTEMPTS_PER_24H} attempts per 24h`);
  }

  // 9. Pre-flight existence + active-session count + ?force=1 gate. The
  // atomic gate is face_clone_finalize_locked at status-time; this saves
  // a Simli call when we can already tell we're going to fail.
  const { searchParams } = new URL(req.url);
  const force = searchParams.get('force') === '1';
  const { data: creator, error: creatorErr } = await sb
    .from('creators')
    .select('id, handle, simli_face_id, user_id')
    .eq('id', creatorId)
    .maybeSingle<{ id: string; handle: string | null; simli_face_id: string | null; user_id: string }>();
  if (creatorErr) return jsonError(500, 'creator_lookup_failed');
  if (!creator) return jsonError(404, 'creator_not_found');

  // P0-3 consent gate: refuse to upload a face/likeness with no recorded
  // likeness consent. Override via POST /api/admin/creator-consent
  // (admin_attest_creator_consent). Existing creators were backfilled.
  const { count: likenessConsentCount, error: consentErr } = await sb
    .from('creator_consents')
    .select('id', { head: true, count: 'exact' })
    .eq('user_id', creator.user_id)
    .eq('consent_type', 'likeness')
    .is('revoked_at', null);
  if (consentErr) return jsonError(500, 'consent_lookup_failed');
  if ((likenessConsentCount ?? 0) === 0) {
    return jsonError(403, 'consent_missing', 'no likeness consent on record; record it in the Consent panel before uploading a face');
  }
  if (creator.simli_face_id && !force) {
    return jsonError(409, 'already_face_trained', 'creator already has a face; pass ?force=1 to overwrite');
  }
  const priorFaceId = creator.simli_face_id;

  // 10. Pre-insert audit row with vendor_face_id=NULL, state='pending'.
  // Auditor R2-M2 — persist force_overwrite at upload time so the status
  // route's finalize step doesn't read a per-poll query param the client
  // could drop mid-train.
  const { data: uploadRow, error: insErr } = await sb
    .from('face_clone_uploads')
    .insert({
      admin_user_id: admin.userId,
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
    console.error('[face-upload] audit insert failed', insErr);
    return jsonError(500, 'audit_insert_failed');
  }

  // 11. POST to Simli /faces/trinity. Phase 0: returns 200 with
  // {face_id, message, warnings[]} on success even though async.
  const handleSlug = (creator.handle || creatorId.slice(0, 8)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  const faceName = `${handleSlug}_${Date.now()}`;

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
      // Phase 0: Simli error envelope is {detail: string}. Never log the
      // full body — Simli sometimes echoes our face_name back.
      console.error('[face-upload] simli non-200', res.status);
      let detailCode = 'face_train_failed';
      let detailMsg: string | undefined;
      try {
        const body = (await res.json().catch(() => null)) as { detail?: string } | null;
        const detail = String(body?.detail || '').toLowerCase();
        if (res.status === 413 || detail.includes('size must be less than')) detailCode = 'face_too_large';
        else if (res.status === 403 && detail.includes('max number of gs faces')) detailCode = 'simli_quota_exceeded';
        // Simli surfaces the "queue full" condition as 400 with this exact
        // string. Distinct error code so the admin knows to wait, not to
        // try a different photo. Discovered 2026-05-05 against Hobby plan
        // (1 concurrent training slot).
        else if (/max queued requests|requests?\s+in\s+the\s+queue\s+already/.test(detail)) {
          detailCode = 'simli_queue_full';
        }
        else if (res.status === 422 || /no face|no subject|face not detected/.test(detail)) detailCode = 'face_no_subject';
        else if (res.status >= 500) detailCode = 'face_train_unreachable';
        if (body?.detail) detailMsg = String(body.detail).slice(0, 300);
      } catch {
        /* ignore */
      }
      // Persist the failure on the audit row so /admin can see it.
      await sb.rpc('face_clone_mark_failed', {
        p_admin_user_id: admin.userId,
        p_upload_id: uploadRow.id,
        p_last_error: `simli_${res.status}_${detailCode}`,
      });
      return NextResponse.json(
        { error: detailCode, ...(detailMsg ? { detail: detailMsg } : {}), uploadId: uploadRow.id },
        { status: res.status >= 500 ? 502 : res.status === 403 ? 403 : 400 },
      );
    }

    const body = (await res.json().catch(() => null)) as { face_id?: string; warnings?: unknown[]; message?: string } | null;
    const id = body?.face_id;
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
      await sb.rpc('face_clone_mark_failed', {
        p_admin_user_id: admin.userId,
        p_upload_id: uploadRow.id,
        p_last_error: 'simli_bad_response_no_face_id',
      });
      return jsonError(502, 'face_train_bad_response');
    }
    vendorFaceId = id;
    warnings = Array.isArray(body?.warnings) ? body!.warnings as unknown[] : [];
    const m = /position in queue\s+(\d+)/i.exec(String(body?.message || ''));
    queuePosition = m ? Number(m[1]) : null;
  } catch (e) {
    const aborted = (e as Error)?.name === 'AbortError';
    console.error('[face-upload] simli fetch failed', aborted ? 'abort' : e);
    await sb.rpc('face_clone_mark_failed', {
      p_admin_user_id: admin.userId,
      p_upload_id: uploadRow.id,
      p_last_error: aborted ? 'simli_timeout' : 'simli_unreachable',
    });
    return jsonError(502, 'face_train_unreachable');
  } finally {
    clearTimeout(timeout);
  }

  // 12. Register the pending face on the upload row.
  const { error: regErr } = await sb.rpc('face_clone_register_pending', {
    p_admin_user_id: admin.userId,
    p_upload_id: uploadRow.id,
    p_creator_id: creatorId,
    p_vendor_face_id: vendorFaceId,
    p_warnings: warnings,
  });
  if (regErr) {
    console.error('[face-upload] register_pending failed', regErr);
    // Orphan-cleanup: enqueue the now-unowned vendor face for delete.
    // Worker will retry once it transitions out of pending.
    try {
      await sb.from('simli_face_delete_queue').upsert(
        {
          face_id: vendorFaceId,
          creator_id: creatorId,
          enqueued_by: admin.userId,
          due_at: new Date().toISOString(),
        },
        { onConflict: 'face_id' },
      );
    } catch (e) {
      console.error('[face-upload] orphan-cleanup enqueue failed', e);
    }
    return jsonError(500, 'register_failed', regErr.code || 'unknown');
  }

  // 13. Audit: $0 cogs row at training start (Q5=A). Provider-agnostic
  // shape — the same row works for tavus/heygen when the cost lands.
  try {
    await sb.from('cogs_log').insert({
      user_id: admin.userId,
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
      },
    });
  } catch (e) {
    // Non-fatal — training was successfully enqueued.
    console.error('[face-upload] cogs audit failed', e);
  }

  // priorFaceId NOT enqueued for delete here — it stays live until the
  // status route flips this upload to 'ready' and finalize_locked runs.
  // The delete enqueue happens there so the user-facing creators row
  // never has a 'no face' window between old + new.

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
