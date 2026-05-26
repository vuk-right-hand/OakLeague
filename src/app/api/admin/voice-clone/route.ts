// Admin voice-clone upload — Pipeline α' clone-create flow.
//
// POST /api/admin/voice-clone
//   multipart/form-data:
//     creatorId: uuid
//     name:      string (≤80 chars)
//     language:  string (default 'en')
//     description?: string (≤500 chars)
//     clip:      File   (audio/wav, ≤10 MB, 3.0–120.0 s)
//   query (optional):
//     ?force=1   — required when creators.voice_id is already populated
//
// v1 narrowing: WAV-only at the route layer. Other table-allowed MIMEs
// (audio/mpeg | audio/ogg | audio/x-m4a | audio/mp4) parse fine in SQL but
// we don't have a deps-free duration probe for them yet — adding
// `music-metadata` post-YC unblocks the broader allowlist.
//
// Hard contracts:
//   * assertAdminFromSession on every entry — service-role writes only.
//   * RIFF/WAVE magic + duration sniffed server-side; Content-Type ignored.
//   * Content-Length ≤ 10 MB.
//   * SHA-256 of clip bytes recorded for audit.
//   * 24h rate-limit: 3 successful clones per admin (R4-S4 — failed
//     attempts excluded).
//   * voice_clone_finalize RPC atomicizes the upload-row + creators-row
//     UPDATEs (R3-C5 / R4-S2).
//   * Overwrite path requires ?force=1 AND zero active sessions for the
//     creator (R3-C5 + R4-C3). DELETE of the prior Cartesia voice is
//     deferred 60s via voice_delete_queue (R4-M3).
//
// Sentry: only structured fields. Never send the clip bytes or the
// transcript. Scrub helper in proxy/sentry.js handles the proxy side; the
// Next.js side relies on @sentry/nextjs default scrub + this route never
// putting PII into extras.

import 'server-only';
import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { probeWav } from '@/lib/voice/wav-probe';
import { isVoiceCloneMime } from '@/lib/voice/voice-clone-mimes';
import { currentVoiceIdEnv, voiceIdColumn } from '@/lib/voice/env-scoped-voice-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MIN_DURATION_S = 3.0;
const MAX_DURATION_S = 120.0;
const RATE_LIMIT_PER_24H = 3;
const RATE_LIMIT_ATTEMPTS_PER_24H = 20;
const CARTESIA_VERSION = '2026-03-01';
const CARTESIA_CLONE_URL = 'https://api.cartesia.ai/voices/clone';
const CARTESIA_DELETE_DEFER_MS = 60_000;

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

  // 2. Same-origin check (mirror existing admin routes).
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

  // 3. Cartesia env present?
  const cartesiaKey = process.env.CARTESIA_API_KEY || '';
  if (!cartesiaKey) return jsonError(500, 'cartesia_misconfig', 'CARTESIA_API_KEY unset');

  // SIMLI_WIREUP §12a.1 / R3-Missing-1 / R4-M6 / Auditor C2 —
  // production-only gate. The voice_clone_finalize_locked RPC writes to
  // creators.voice_id (the prod column). Allowing preview/dev to call
  // this route + post-process to relocate would leave a non-atomic gap
  // where prod reads see a non-prod clone UUID. Until an env-aware
  // finalize RPC ships, refuse here.
  const voiceEnv = currentVoiceIdEnv();
  if (voiceEnv !== 'production') {
    const targetCol = voiceIdColumn(voiceEnv);
    return jsonError(
      503,
      'voice_clone_only_in_production',
      `voice-clone admin route is production-only until env-aware finalize RPC ships; populate ${targetCol} manually for ${voiceEnv} testing`,
    );
  }

  // S-C1 — Content-Length pre-check BEFORE req.formData() so a 50 MB
  // upload can't allocate a 50 MB ArrayBuffer in memory just to be
  // rejected at line ~140. Multipart envelope adds ~200 bytes of overhead;
  // round up the cap to MAX_BYTES + 64 KB to be safe.
  const cl = Number(req.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > MAX_BYTES + 64 * 1024) {
    return jsonError(413, 'clip_too_large', `body=${cl}B > ${MAX_BYTES}B+envelope`);
  }

  // 4. Multipart parse.
  let form;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, 'bad_multipart');
  }
  const creatorId = String(form.get('creatorId') || '');
  // S-M3 / R3-M2 — strip control chars + path/shell/tag dangers; otherwise
  // accept any unicode letter/number/punctuation. Apostrophes, em-dashes,
  // ampersands, commas, parens, accented characters all pass — names like
  // O'Brien, Søren—Vuk, D'Angelo & Co. survive intact. Final length cap
  // slice replaces the prior (length > 80) reject so accidental over-length
  // doesn't bounce a polished name.
  const rawName = String(form.get('name') || '');
  const name = rawName
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>{}|\\\/]/g, '')
    .trim()
    .slice(0, 80);
  const language = String(form.get('language') || 'en').trim();
  const rawDesc = String(form.get('description') || '');
  const description = rawDesc.replace(/[\x00-\x1f]/g, '').trim() || null;
  const clip = form.get('clip');
  // Canonical UUID regex — `[0-9a-f-]{36}` accepted 36 dashes (S-C / S-S smalls).
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!creatorId || !UUID_RE.test(creatorId)) return jsonError(400, 'bad_creator_id');
  if (!name || name.length > 80) return jsonError(400, 'bad_name');
  if (description && description.length > 500) return jsonError(400, 'bad_description');
  if (!(clip instanceof Blob)) return jsonError(400, 'no_clip');
  if (clip.size === 0) return jsonError(400, 'empty_clip');
  if (clip.size > MAX_BYTES) return jsonError(413, 'clip_too_large');

  // 5. Read bytes; sniff MIME via WAV magic; probe duration.
  const clipBuf = Buffer.from(await clip.arrayBuffer());
  const wav = probeWav(clipBuf);
  if (!wav) return jsonError(415, 'unsupported_format', 'only PCM WAV is accepted in v1');
  if (wav.durationSeconds < MIN_DURATION_S) return jsonError(400, 'clip_too_short');
  if (wav.durationSeconds > MAX_DURATION_S) return jsonError(400, 'clip_too_long');
  const sniffedMime = 'audio/wav';
  if (!isVoiceCloneMime(sniffedMime)) {
    // Defensive — should be impossible since 'audio/wav' is in the allowlist.
    return jsonError(415, 'unsupported_format');
  }

  const sha256 = createHash('sha256').update(clipBuf).digest('hex');
  const sb = supabaseAdmin();

  // 6. Rate limit. Two thresholds:
  //    * R4-S4 — successful clones (cartesia_voice_id IS NOT NULL): 3/24h
  //    * S-M4  — total attempts (success + failed): 20/24h
  // The success cap is the user-facing dial; the attempts cap closes the
  // bypass where a rogue admin hammers the endpoint while Cartesia is
  // 5xx'ing (every failure leaves cartesia_voice_id=NULL → previously
  // didn't count toward any cap).
  //
  // R3-M5 (sec) — break-glass: `VOICE_CLONE_RATE_LIMIT_BYPASS` is a
  // comma-separated list of admin user-ids that can bypass BOTH caps.
  // Use only during a Cartesia outage on a demo-day morning when an
  // admin has legitimately exhausted retries. Audit row still writes,
  // so cleanup is visible. Flip the env, redeploy Vercel, do the work,
  // unset the env. Documented in CLAUDE.md.
  // FACE_UI_PLAN R2-M1: env name alias cycle. New name is
  // CREATOR_CLONE_RATE_LIMIT_BYPASS (covers voice + face). Old name
  // VOICE_CLONE_RATE_LIMIT_BYPASS still read for one cycle. Both routes
  // read the union.
  const bypassList = (
    (process.env.CREATOR_CLONE_RATE_LIMIT_BYPASS || '') + ',' +
    (process.env.VOICE_CLONE_RATE_LIMIT_BYPASS || '')
  ).split(',').map((s) => s.trim()).filter(Boolean);
  const isBypassAdmin = bypassList.includes(admin.userId);

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  // HUME_TTS_PLAN audit C2 fix (2026-05-13): scope the rate-limit count to
  // tts_provider='cartesia' so a Hume clone via the §5.2 paste-flow doesn't
  // burn this route's cap. Hume's rate-limit lives in its own route.
  const { count: successCount, error: rateErr } = await sb
    .from('voice_clone_uploads')
    .select('*', { count: 'exact', head: true })
    .eq('admin_user_id', admin.userId)
    .eq('tts_provider', 'cartesia')
    .gt('created_at', since)
    .not('cartesia_voice_id', 'is', null);
  if (rateErr) return jsonError(500, 'rate_lookup_failed');
  if (!isBypassAdmin && (successCount ?? 0) >= RATE_LIMIT_PER_24H) {
    return jsonError(429, 'rate_limit', `max ${RATE_LIMIT_PER_24H} successful clones per 24h`);
  }
  const { count: attemptCount, error: attemptErr } = await sb
    .from('voice_clone_uploads')
    .select('*', { count: 'exact', head: true })
    .eq('admin_user_id', admin.userId)
    .eq('tts_provider', 'cartesia')
    .gt('created_at', since);
  if (attemptErr) return jsonError(500, 'rate_lookup_failed');
  if (!isBypassAdmin && (attemptCount ?? 0) >= RATE_LIMIT_ATTEMPTS_PER_24H) {
    return jsonError(429, 'rate_limit_attempts', `max ${RATE_LIMIT_ATTEMPTS_PER_24H} clone attempts per 24h`);
  }

  // 7. Pre-flight read for cheap rejects. The actual atomic gate is
  // voice_clone_finalize_locked (S-C2): per-creator advisory lock +
  // active-session count + creators+voice_clone_uploads UPDATEs in one
  // transaction. The pre-flight saves a Cartesia call when we can already
  // tell we're going to fail.
  const { searchParams } = new URL(req.url);
  const force = searchParams.get('force') === '1';
  const { data: creator, error: creatorErr } = await sb
    .from('creators')
    .select('id, voice_id, user_id')
    .eq('id', creatorId)
    .maybeSingle<{ id: string; voice_id: string | null; user_id: string }>();
  if (creatorErr) return jsonError(500, 'creator_lookup_failed');
  if (!creator) return jsonError(404, 'creator_not_found');

  // P0-3 consent gate: refuse to clone a voice with no recorded voice_clone
  // consent for the creator's user. Override path: an admin records out-of-band
  // consent via POST /api/admin/creator-consent (admin_attest_creator_consent),
  // which inserts a row here and unblocks. Existing creators were backfilled
  // (migration 20260523000007).
  const { count: voiceConsentCount, error: consentErr } = await sb
    .from('creator_consents')
    .select('id', { head: true, count: 'exact' })
    .eq('user_id', creator.user_id)
    .eq('consent_type', 'voice_clone')
    .is('revoked_at', null);
  if (consentErr) return jsonError(500, 'consent_lookup_failed');
  if ((voiceConsentCount ?? 0) === 0) {
    return jsonError(403, 'consent_missing', 'no voice_clone consent on record; record it in the Consent panel before cloning');
  }
  if (creator.voice_id && !force) {
    return jsonError(409, 'already_cloned', 'creator already has a voice; pass ?force=1 to overwrite');
  }
  const priorVoiceId = creator.voice_id;

  // 8. Pre-insert audit row with cartesia_voice_id=NULL.
  // HUME_TTS_PLAN §5.5 writer discipline (2026-05-13): pass tts_provider
  // EXPLICITLY so the follow-up migration that drops the DEFAULT can ship
  // without 23502'ing this insert. CI grep enforces every voice_clone_uploads
  // INSERT/UPSERT contains `tts_provider`.
  const { data: uploadRow, error: insErr } = await sb
    .from('voice_clone_uploads')
    .insert({
      admin_user_id: admin.userId,
      creator_id: creatorId,
      tts_provider: 'cartesia',
      sha256,
      duration_seconds: Number(wav.durationSeconds.toFixed(3)),
      mime: sniffedMime,
      bytes: clipBuf.length,
      cartesia_voice_id: null,
    })
    .select('id')
    .single<{ id: number }>();
  if (insErr || !uploadRow) {
    console.error('[voice-clone] audit insert failed', insErr);
    return jsonError(500, 'audit_insert_failed');
  }

  // 9. POST to Cartesia clone endpoint. Multipart hand-built so we can
  // stream the bytes without pulling form-data dep.
  let voiceId: string;
  try {
    const fd = new FormData();
    fd.append('clip', new Blob([clipBuf], { type: sniffedMime }), `${name}.wav`);
    fd.append('name', name);
    fd.append('language', language);
    if (description) fd.append('description', description);

    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(CARTESIA_CLONE_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cartesiaKey}`,
          'Cartesia-Version': CARTESIA_VERSION,
        },
        body: fd,
        signal: ac.signal,
      });
    } finally { clearTimeout(to); }

    if (!res.ok) {
      // S-C4 — never log Cartesia error bodies. Their 4xx responses
      // sometimes echo the `description`/`name` fields we sent. Log
      // only the status code. The audit row stays with
      // cartesia_voice_id=NULL — visible as a failed attempt;
      // rate-limit excludes it via the IS NOT NULL filter (R4-S4).
      console.error('[voice-clone] cartesia non-200', res.status);
      // R3-S — distinguish 4xx ("Cartesia rejected the clip") from 5xx
      // ("Cartesia is unreachable / down"). The friendly UI copy
      // diverges on this; misleading the admin with "rejected" on a
      // Cartesia 5xx wastes their next 5 minutes re-recording.
      if (res.status >= 500) {
        return jsonError(502, 'cartesia_unreachable', `status=${res.status}`);
      }
      return jsonError(502, 'cartesia_clone_failed', `status=${res.status}`);
    }
    const body = await res.json();
    voiceId = String(body?.id || '');
    if (!voiceId || voiceId.length > 128) {
      return jsonError(502, 'cartesia_clone_bad_response');
    }
  } catch (e) {
    console.error('[voice-clone] cartesia fetch failed', e);
    return jsonError(502, 'cartesia_unreachable');
  }

  // 10. Atomic two-table finalize under a per-creator advisory lock
  // (S-C2 + S-M5). RPC checks active-session count for the overwrite
  // path inside the same transaction as the UPDATEs. RPC also re-asserts
  // the admin role is currently active.
  const { error: finalizeErr } = await sb.rpc('voice_clone_finalize_locked', {
    p_admin_user_id: admin.userId,
    p_upload_id: uploadRow.id,
    p_creator_id: creatorId,
    p_voice_id: voiceId,
    p_force: force,
  });
  if (finalizeErr) {
    console.error('[voice-clone] finalize RPC failed', finalizeErr.code);

    // R3-C1 (sec) — Cartesia minted `voiceId` successfully but the DB
    // finalize failed. If we don't enqueue the now-orphan voice for
    // delete, it leaks in Cartesia forever (no DB pointer references it).
    // Enqueue with no defer (due_at = now) so the worker drains it on
    // the next 30s tick. Best-effort; if the queue write itself fails,
    // log it — admin can clean up via Cartesia dashboard.
    // HUME_TTS_PLAN audit C1 fix (2026-05-13): voice_delete_queue PK is now
    // composite (tts_provider, voice_id). onConflict must list both columns
    // and the payload must include tts_provider explicitly (the DEFAULT
    // 'cartesia' only fires on raw INSERT; upsert ON CONFLICT path needs
    // the value present).
    try {
      await sb.from('voice_delete_queue').upsert(
        { tts_provider: 'cartesia', voice_id: voiceId, enqueued_by: admin.userId, due_at: new Date().toISOString() },
        { onConflict: 'tts_provider,voice_id' },
      );
    } catch (e) {
      console.error('[voice-clone] orphan-cleanup enqueue failed', e);
    }

    // Map known PG error codes to user-actionable responses.
    if (finalizeErr.code === '55006') {
      // HUME_TTS_PLAN unit-wide audit C1 (2026-05-13): finalize_v2 raises
      // 55006 in two cases now — disambiguate by message. The
      // voice_just_deleted_retry_paste case can hit the Cartesia path
      // too via the v1 shim if the worker happened to claim the prior
      // cartesia voice's queue row between admin clicks.
      const msg = finalizeErr.message || '';
      if (/voice_just_deleted_retry_paste/.test(msg)) {
        return NextResponse.json(
          {
            error: 'voice_dispatch_in_flight',
            detail: 'the previous Cartesia voice for this creator is being deleted by the worker right now; wait ~60s and re-submit the clone',
          },
          { status: 409 },
        );
      }
      const m = /(\d+)\s+active sessions/.exec(msg);
      const activeSessions = m ? Number(m[1]) : undefined;
      return NextResponse.json(
        {
          error: 'creator_has_active_sessions',
          detail: 'cannot replace voice while live sessions exist',
          ...(activeSessions !== undefined ? { activeSessions } : {}),
        },
        { status: 409 },
      );
    }
    if (finalizeErr.code === '23505') {
      // R3-C3 (logic) — RPC raises 23505 with TWO distinct messages.
      // Disambiguate by message.
      const msg = finalizeErr.message || '';
      if (/already cloned/.test(msg)) {
        return jsonError(409, 'already_cloned', 'creator already has a voice; pass ?force=1 to overwrite');
      }
      if (/already finalized/.test(msg)) {
        return jsonError(409, 'upload_already_used', 'this upload row was already consumed; submit a fresh clip');
      }
      // Generic 23505 (e.g., creators PK conflict) — fall through.
    }
    return jsonError(500, 'finalize_failed', finalizeErr.code || 'unknown');
  }

  // SIMLI_WIREUP §12a.1 / R3-Missing-1 — production-env gate is enforced
  // upstream at step 3a so finalize can write directly to creators.voice_id
  // without a post-hoc relocate (Auditor C2 fix).

  // 11. R4-M3 — defer DELETE of the prior Cartesia voice id by 60s.
  // Vercel can't survive a setTimeout post-response, so we enqueue and
  // let the Fly proxy worker drain.
  if (priorVoiceId) {
    const dueAt = new Date(Date.now() + CARTESIA_DELETE_DEFER_MS).toISOString();
    // HUME_TTS_PLAN audit C1 fix (2026-05-13): composite PK requires both
    // columns in onConflict + payload.
    const { error: queueErr } = await sb.from('voice_delete_queue').upsert(
      { tts_provider: 'cartesia', voice_id: priorVoiceId, enqueued_by: admin.userId, due_at: dueAt },
      { onConflict: 'tts_provider,voice_id' },
    );
    if (queueErr) {
      // Don't fail the request — admin already swapped successfully. Log.
      console.error('[voice-clone] delete-queue enqueue failed', queueErr);
    }
  }

  return NextResponse.json({
    ok: true,
    voiceId,
    uploadId: uploadRow.id,
    durationSeconds: Number(wav.durationSeconds.toFixed(3)),
    overwrote: !!priorVoiceId,
  });
}
