// Creator voice-clone (WS4) — self-serve clone-create via the Cartesia
// pipeline. Recording-only (the client builds a 16-bit mono WAV from a fresh
// server-minted script; no file upload). Sibling of /api/admin/voice-clone —
// NOT a wrapper (plan §0): creatorId from session, uploaded_by_user_id audit
// column, script freshness gate, finalize via voice_clone_finalize_creator
// (auth.uid()) which blocks overwrite while published (M5) + stamps the script
// used_at single-use.
//
// The raw WAV is persisted to the private voice-source bucket BEFORE Cartesia
// so a future Fish clone never needs a re-record (fish buffer-room, R8). The
// path is immutable on the upload row (append-only trigger), so it's set at
// insert time.
//
// HARD prod-only (audit C5): same currentVoiceIdEnv() gate as admin. There is
// NO VOICE_CLONE_ALLOW_LOCAL bypass — the finalize RPC writes the prod
// creators.voice_id column.

import 'server-only';
import { NextResponse } from 'next/server';
import { randomUUID, createHash } from 'node:crypto';
import { assertCreatorFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { probeWav } from '@/lib/voice/wav-probe';
import { currentVoiceIdEnv } from '@/lib/voice/env-scoped-voice-id';
import { CARTESIA_VERSION, CARTESIA_CLONE_URL } from '@/lib/voice/cartesia-clone';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MIN_DURATION_S = 20.0; // creator floor (plan §D — meaningful clone material)
const MAX_DURATION_S = 120.0;
const MAX_SAMPLE_RATE = 48_000;
const SCRIPT_TTL_MS = 30 * 60 * 1000;
const RATE_LIMIT_PER_24H = 3;
const RATE_LIMIT_ATTEMPTS_PER_24H = 20;
const CARTESIA_DELETE_DEFER_MS = 60_000;

function jsonError(status: number, code: string, detail?: string) {
  return NextResponse.json({ error: code, ...(detail ? { detail } : {}) }, { status });
}

export async function POST(req: Request) {
  // 1. Creator gate.
  let session: { userId: string; creatorId: string };
  try {
    session = await assertCreatorFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return jsonError(e.status, e.message);
    throw e;
  }
  const { userId, creatorId } = session;

  // 2. Same-origin.
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

  // 3. Cartesia env + HARD prod-only gate (audit C5 — no local bypass).
  const cartesiaKey = process.env.CARTESIA_API_KEY || '';
  if (!cartesiaKey) return jsonError(500, 'cartesia_misconfig', 'CARTESIA_API_KEY unset');
  if (currentVoiceIdEnv() !== 'production') {
    return jsonError(503, 'voice_clone_only_in_production', 'voice cloning runs on the live site only');
  }

  // 4. Content-Length pre-check.
  const cl = Number(req.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > MAX_BYTES + 64 * 1024) {
    return jsonError(413, 'clip_too_large', `body=${cl}B > ${MAX_BYTES}B+envelope`);
  }

  // 5. Multipart parse — clip + scriptId.
  let form;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, 'bad_multipart');
  }
  const scriptId = String(form.get('scriptId') || '');
  const clip = form.get('clip');
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(scriptId)) return jsonError(400, 'bad_script');
  if (!(clip instanceof Blob)) return jsonError(400, 'no_clip');
  if (clip.size === 0) return jsonError(400, 'empty_clip');
  if (clip.size > MAX_BYTES) return jsonError(413, 'clip_too_large');

  // 6. Probe WAV — mono, ≤48k, 20–120s (audit M1).
  const clipBuf = Buffer.from(await clip.arrayBuffer());
  const wav = probeWav(clipBuf);
  if (!wav) return jsonError(415, 'unsupported_format', 'recording must be PCM WAV');
  if (wav.channels !== 1) return jsonError(400, 'not_mono');
  if (wav.sampleRate > MAX_SAMPLE_RATE) return jsonError(400, 'sample_rate_too_high');
  if (wav.durationSeconds < MIN_DURATION_S) return jsonError(400, 'clip_too_short');
  if (wav.durationSeconds > MAX_DURATION_S) return jsonError(400, 'clip_too_long');

  const sha256 = createHash('sha256').update(clipBuf).digest('hex');
  const sb = supabaseAdmin();

  // 7. Script freshness + ownership + unused (replay-resistance, R7). The
  // finalize RPC stamps used_at single-use; this is the cheap pre-check.
  const { data: script, error: scriptErr } = await sb
    .from('voice_clone_scripts')
    .select('id, creator_id, created_at, used_at')
    .eq('id', scriptId)
    .maybeSingle<{ id: string; creator_id: string; created_at: string; used_at: string | null }>();
  if (scriptErr) return jsonError(500, 'script_lookup_failed');
  if (!script || script.creator_id !== creatorId) return jsonError(400, 'bad_script');
  if (script.used_at) return jsonError(409, 'script_used', 'generate a fresh script and re-record');
  if (Date.now() - new Date(script.created_at).getTime() > SCRIPT_TTL_MS) {
    return jsonError(409, 'script_expired', 'generate a fresh script and re-record');
  }

  // 8. Rate limit — keyed on the creator, cartesia provider.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: successCount, error: rateErr } = await sb
    .from('voice_clone_uploads')
    .select('*', { count: 'exact', head: true })
    .eq('uploaded_by_user_id', userId)
    .eq('tts_provider', 'cartesia')
    .gt('created_at', since)
    .not('cartesia_voice_id', 'is', null);
  if (rateErr) return jsonError(500, 'rate_lookup_failed');
  if ((successCount ?? 0) >= RATE_LIMIT_PER_24H) {
    return jsonError(429, 'rate_limit', `max ${RATE_LIMIT_PER_24H} successful clones per 24h`);
  }
  const { count: attemptCount, error: attemptErr } = await sb
    .from('voice_clone_uploads')
    .select('*', { count: 'exact', head: true })
    .eq('uploaded_by_user_id', userId)
    .eq('tts_provider', 'cartesia')
    .gt('created_at', since);
  if (attemptErr) return jsonError(500, 'rate_lookup_failed');
  if ((attemptCount ?? 0) >= RATE_LIMIT_ATTEMPTS_PER_24H) {
    return jsonError(429, 'rate_limit_attempts', `max ${RATE_LIMIT_ATTEMPTS_PER_24H} attempts per 24h`);
  }

  // 9. Pre-flight: block early if a voice exists AND the creator is published
  // (overwrite while live is admin-only — finalize re-checks under the lock).
  const { data: creator, error: creatorErr } = await sb
    .from('creators')
    .select('id, voice_id, user_id, published_at')
    .eq('id', creatorId)
    .maybeSingle<{ id: string; voice_id: string | null; user_id: string; published_at: string | null }>();
  if (creatorErr) return jsonError(500, 'creator_lookup_failed');
  if (!creator) return jsonError(404, 'creator_not_found');
  if (creator.voice_id && creator.published_at) {
    return jsonError(409, 'voice_locked_while_live', 'your profile is live; contact us to change your voice');
  }

  // 10. Voice-clone consent (recorded at /apply). Mirror admin.
  const { count: consentCount, error: consentErr } = await sb
    .from('creator_consents')
    .select('id', { head: true, count: 'exact' })
    .eq('user_id', creator.user_id)
    .eq('consent_type', 'voice_clone')
    .is('revoked_at', null);
  if (consentErr) return jsonError(500, 'consent_lookup_failed');
  if ((consentCount ?? 0) === 0) return jsonError(403, 'consent_missing', 'no voice consent on record');

  const priorVoiceId = creator.voice_id;

  // 11. Persist the raw WAV to the private voice-source bucket FIRST (fish
  // buffer-room, R8). The path is immutable on the upload row, so set it at
  // insert time — hence upload before insert.
  const objectPath = `${creatorId}/${randomUUID()}.wav`;
  const { error: storeErr } = await sb.storage
    .from('voice-source')
    .upload(objectPath, clipBuf, { contentType: 'audio/wav', upsert: false });
  if (storeErr) {
    console.error('[creator/voice-clone] source persist failed', storeErr);
    return jsonError(500, 'source_persist_failed');
  }

  // Audit C1: any failure AFTER the source upload but BEFORE a successful
  // finalize must remove the voice-source object, else it leaks in the bucket
  // (PII + cost) — the buffer-room only wants sources of SUCCESSFUL clones.
  const cleanupSource = async () => {
    try {
      await sb.storage.from('voice-source').remove([objectPath]);
    } catch (e) {
      console.error('[creator/voice-clone] source cleanup failed', e);
    }
  };

  // 12. Pre-insert audit row (uploaded_by_user_id; admin_user_id NULL).
  const { data: uploadRow, error: insErr } = await sb
    .from('voice_clone_uploads')
    .insert({
      uploaded_by_user_id: userId,
      creator_id: creatorId,
      tts_provider: 'cartesia',
      sha256,
      duration_seconds: Number(wav.durationSeconds.toFixed(3)),
      mime: 'audio/wav',
      bytes: clipBuf.length,
      cartesia_voice_id: null,
      source_object_path: objectPath,
      script_id: scriptId,
    })
    .select('id')
    .single<{ id: number }>();
  if (insErr || !uploadRow) {
    console.error('[creator/voice-clone] audit insert failed', insErr);
    await cleanupSource(); // C1: no row references the object → unrecoverable orphan otherwise
    return jsonError(500, 'audit_insert_failed');
  }

  // 13. POST to Cartesia clone.
  let voiceId: string;
  try {
    const fd = new FormData();
    fd.append('clip', new Blob([clipBuf], { type: 'audio/wav' }), 'clip.wav');
    fd.append('name', `creator_${creatorId.slice(0, 8)}`);
    fd.append('language', 'en');
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(CARTESIA_CLONE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${cartesiaKey}`, 'Cartesia-Version': CARTESIA_VERSION },
        body: fd,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(to);
    }
    if (!res.ok) {
      console.error('[creator/voice-clone] cartesia non-200', res.status);
      await cleanupSource();
      if (res.status >= 500) return jsonError(502, 'cartesia_unreachable', `status=${res.status}`);
      return jsonError(502, 'cartesia_clone_failed', `status=${res.status}`);
    }
    const body = await res.json();
    voiceId = String(body?.id || '');
    if (!voiceId || voiceId.length > 128) {
      await cleanupSource();
      return jsonError(502, 'cartesia_clone_bad_response');
    }
  } catch (e) {
    console.error('[creator/voice-clone] cartesia fetch failed', e);
    await cleanupSource();
    return jsonError(502, 'cartesia_unreachable');
  }

  // 14. Atomic finalize via JWT-bound client (auth.uid() must resolve inside
  // voice_clone_finalize_creator). Blocks overwrite while published, guards
  // active sessions, stamps script used_at, all under the per-creator lock.
  const jwt = await supabaseServer();
  const { error: finalizeErr } = await jwt.rpc('voice_clone_finalize_creator', {
    p_upload_id: uploadRow.id,
    p_voice_id: voiceId,
  });
  if (finalizeErr) {
    console.error('[creator/voice-clone] finalize failed', finalizeErr.code, finalizeErr.message);
    // Cartesia minted the voice but the DB finalize failed — enqueue the
    // now-orphan voice for delete (no defer) so it doesn't leak, and remove
    // the source object (C1) since this attempt did not produce a live clone.
    try {
      await sb.from('voice_delete_queue').upsert(
        { tts_provider: 'cartesia', voice_id: voiceId, enqueued_by: userId, due_at: new Date().toISOString() },
        { onConflict: 'tts_provider,voice_id' },
      );
    } catch (e) {
      console.error('[creator/voice-clone] orphan-cleanup enqueue failed', e);
    }
    await cleanupSource();
    const msg = finalizeErr.message || '';
    if (finalizeErr.code === 'P0001' && /voice_locked_while_live/.test(msg)) {
      return jsonError(409, 'voice_locked_while_live', 'your profile is live; contact us to change your voice');
    }
    if (finalizeErr.code === '55006') {
      if (/voice_just_deleted_retry_paste/.test(msg)) {
        return jsonError(409, 'voice_dispatch_in_flight', 'your previous voice is being cleaned up; wait ~60s and retry');
      }
      const m = /(\d+)\s+active sessions/.exec(msg);
      return NextResponse.json(
        { error: 'creator_has_active_sessions', ...(m ? { activeSessions: Number(m[1]) } : {}) },
        { status: 409 },
      );
    }
    if (finalizeErr.code === '23505') {
      if (/already finalized/.test(msg)) return jsonError(409, 'upload_already_used', 'record a fresh clip');
    }
    return jsonError(500, 'finalize_failed', finalizeErr.code || 'unknown');
  }

  // 15. Defer DELETE of the prior voice by 60s (worker drains).
  if (priorVoiceId) {
    const dueAt = new Date(Date.now() + CARTESIA_DELETE_DEFER_MS).toISOString();
    const { error: queueErr } = await sb.from('voice_delete_queue').upsert(
      { tts_provider: 'cartesia', voice_id: priorVoiceId, enqueued_by: userId, due_at: dueAt },
      { onConflict: 'tts_provider,voice_id' },
    );
    if (queueErr) console.error('[creator/voice-clone] delete-queue enqueue failed', queueErr);
  }

  // 16. $0 cogs row (provider-agnostic; real Cartesia clone cost is flat/free
  // per their pricing — leave cost_usd 0 with pricing_unverified like admin).
  try {
    await sb.from('cogs_log').insert({
      user_id: userId,
      session_id: null,
      service: 'cartesia',
      operation: 'voice_clone_create',
      units: 1,
      unit_label: 'clone',
      cost_usd: 0,
      environment: 'production',
      metadata: {
        creator_id: creatorId,
        upload_id: uploadRow.id,
        duration_seconds: Number(wav.durationSeconds.toFixed(3)),
        pricing_unverified: true,
        actor: 'creator',
      },
    });
  } catch (e) {
    console.error('[creator/voice-clone] cogs audit failed', e);
  }

  return NextResponse.json({
    ok: true,
    voiceId,
    uploadId: uploadRow.id,
    durationSeconds: Number(wav.durationSeconds.toFixed(3)),
    overwrote: !!priorVoiceId,
  });
}
