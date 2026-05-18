// HUME_TTS_PLAN §5.2 — Hume voice-clone (Scenario B: admin paste flow).
//
// POST /api/admin/voice-clone/hume-id
//   JSON body:
//     creatorId:     uuid
//     humeVoiceId:   string (UUID, 1..128 chars — column CHECK is the bound)
//     humeVoiceName: string (1..128 chars — REQUIRED for the DELETE flow)
//   query (optional):
//     ?force=1     — required when creator already has a Hume voice
//
// Why Scenario B and not A: Phase-0 2026-05-13 verified Hume has NO
// programmatic audio-clone REST endpoint. `POST /v0/tts/voices` accepts
// only `{generation_id, name}` (voice-design from prompt path). Admin
// must upload audio in app.hume.ai/voices and paste the resulting voice
// id + name back here. When Hume ships an audio-upload REST endpoint we
// flip this route to the one-step flow.
//
// CRITICAL deferred-fix this route carries:
//   * Unit-wide audit C1 (2026-05-13) — production-only gate. The
//     finalize RPC writes prod `creators.hume_voice_id` regardless of
//     env. Allowing preview/dev to call this route would let a test
//     paste overwrite the prod creator's Hume voice. 503 until an
//     env-aware finalize RPC ships (post-YC follow-up).
//
// Differences from the Cartesia route at /api/admin/voice-clone:
//   * No audio upload — JSON body, not multipart.
//   * No WAV probe, no SHA-256 of clip bytes (no clip).
//   * GET-sanity-check via Hume's voices list to confirm the pasted id
//     actually exists in Hume's library (paste-mistake guard).
//   * Audit row writes nulls for sha256 / duration / mime / bytes
//     (R3-C3 — voice_clone_uploads has these as nullable for non-audio
//     audit rows; constraint is `(cartesia_voice_id IS NULL) OR
//     (hume_voice_id IS NULL)` via the append-only trigger).
//   * Rate-limit count uses tts_provider='hume' (separate cap from
//     Cartesia per §5.3).
//   * Overwrite enqueue: `voice_delete_queue` with `tts_provider='hume'`
//     + `voice_name=<prior name>` (Hume DELETE is keyed by NAME).
//
// Sentry: only structured fields. Hume error response bodies are NEVER
// logged (Vuk-C1 leak channel — Hume echoes client input in error
// messages). Catch + status-code-only logging.

import 'server-only';
import { NextResponse } from 'next/server';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { currentVoiceIdEnv } from '@/lib/voice/env-scoped-voice-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HUME_VOICE_ID_MAX = 128;
const HUME_VOICE_NAME_MAX = 128;
const RATE_LIMIT_PER_24H = 3;
const RATE_LIMIT_ATTEMPTS_PER_24H = 20;
const HUME_DELETE_DEFER_MS = 60_000;
const HUME_LIST_VOICES_URL = 'https://api.hume.ai/v0/tts/voices';
const HUME_FETCH_TIMEOUT_MS = 10_000;
// Generous UUID regex — Hume Phase-0 verified 36-char canonical UUID,
// but plan §5.2 explicitly says NOT to enforce regex (defensive against
// Hume changing format). Column CHECK char_length BETWEEN 1 AND 128 is
// the bound. We do a basic non-empty + max-length pre-check here.

function jsonError(status: number, code: string, detail?: string) {
  return NextResponse.json({ error: code, ...(detail ? { detail } : {}) }, { status });
}

export async function POST(req: Request) {
  // 1. Admin gate (same pattern as Cartesia route).
  let admin;
  try {
    admin = await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return jsonError(e.status, e.message);
    throw e;
  }

  // 2. Same-origin check.
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

  // 3. Hume env present.
  // §5 audit C4 fix (2026-05-13): HUME_API_KEY must be set on BOTH Vercel
  // (this route runs in Next.js runtime) AND Fly (the proxy + delete
  // worker). Plan §8 deploy checklist documents both. If only Fly has it,
  // the admin's first paste returns 500 with a confusing message.
  const humeKey = process.env.HUME_API_KEY || '';
  if (!humeKey) {
    return jsonError(
      500,
      'hume_misconfig',
      'HUME_API_KEY env var unset on Vercel — admin Hume paste route requires the key on Vercel (Next.js side) AND Fly (proxy side); see HUME_TTS_PLAN §8 deploy checklist',
    );
  }

  // 3a. DEFERRED CRITICAL (unit-wide audit C1) — production-only gate.
  // voice_clone_finalize_locked_v2 writes prod creators.hume_voice_id
  // unconditionally; allowing preview/dev would let a test paste
  // overwrite the prod row. Until an env-aware finalize RPC ships, this
  // route is production-only. Mirrors the Cartesia precedent at
  // /api/admin/voice-clone/route.ts:96-104.
  const voiceEnv = currentVoiceIdEnv();
  if (voiceEnv !== 'production') {
    // §5 audit S10 fix (2026-05-13): interpolate the actual env name,
    // not a 2-value lookup (currentVoiceIdEnv can return new values in
    // the future).
    const colSuffix = voiceEnv === 'preview' ? '_preview' : '_dev';
    return jsonError(
      503,
      'hume_clone_only_in_production',
      `hume-id paste route is production-only until env-aware finalize RPC ships; populate creators.hume_voice_id${colSuffix} + creators.hume_voice_name${colSuffix} manually for ${voiceEnv} testing`,
    );
  }

  // 4. Parse + validate JSON body.
  let body: { creatorId?: unknown; humeVoiceId?: unknown; humeVoiceName?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'bad_json');
  }
  const creatorId = String(body.creatorId ?? '');
  const rawId = String(body.humeVoiceId ?? '');
  const rawName = String(body.humeVoiceName ?? '');

  // Mirror Cartesia name sanitization (route.ts:130-134). Hume allows
  // any printable Unicode in voice names per app.hume.ai/voices UI; we
  // strip control chars + path/shell/tag chars + trim.
  const humeVoiceId = rawId
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, HUME_VOICE_ID_MAX);
  const humeVoiceName = rawName
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>{}|\\\/]/g, '')
    .trim()
    .slice(0, HUME_VOICE_NAME_MAX);

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!creatorId || !UUID_RE.test(creatorId)) return jsonError(400, 'bad_creator_id');
  if (!humeVoiceId || humeVoiceId.length < 1) return jsonError(400, 'bad_hume_voice_id');
  if (!humeVoiceName || humeVoiceName.length < 1) return jsonError(400, 'bad_hume_voice_name');

  const sb = supabaseAdmin();

  // 5. Rate limit — per-provider per §5.3 (3 successes / 20 attempts per
  // 24h, scoped to tts_provider='hume').
  const bypassList = (
    (process.env.CREATOR_CLONE_RATE_LIMIT_BYPASS || '') + ',' +
    (process.env.VOICE_CLONE_RATE_LIMIT_BYPASS || '')
  ).split(',').map((s) => s.trim()).filter(Boolean);
  const isBypassAdmin = bypassList.includes(admin.userId);

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: successCount, error: rateErr } = await sb
    .from('voice_clone_uploads')
    .select('*', { count: 'exact', head: true })
    .eq('admin_user_id', admin.userId)
    .eq('tts_provider', 'hume')
    .gt('created_at', since)
    .not('hume_voice_id', 'is', null);
  if (rateErr) return jsonError(500, 'rate_lookup_failed');
  if (!isBypassAdmin && (successCount ?? 0) >= RATE_LIMIT_PER_24H) {
    return jsonError(429, 'rate_limit', `max ${RATE_LIMIT_PER_24H} successful Hume clones per 24h`);
  }
  const { count: attemptCount, error: attemptErr } = await sb
    .from('voice_clone_uploads')
    .select('*', { count: 'exact', head: true })
    .eq('admin_user_id', admin.userId)
    .eq('tts_provider', 'hume')
    .gt('created_at', since);
  if (attemptErr) return jsonError(500, 'rate_lookup_failed');
  if (!isBypassAdmin && (attemptCount ?? 0) >= RATE_LIMIT_ATTEMPTS_PER_24H) {
    return jsonError(429, 'rate_limit_attempts', `max ${RATE_LIMIT_ATTEMPTS_PER_24H} Hume clone attempts per 24h`);
  }

  // 6. Pre-flight creator lookup. Reads BOTH hume_voice_id AND
  // hume_voice_name so the overwrite-enqueue path has the prior name.
  const { searchParams } = new URL(req.url);
  const force = searchParams.get('force') === '1';
  const { data: creator, error: creatorErr } = await sb
    .from('creators')
    .select('id, hume_voice_id, hume_voice_name')
    .eq('id', creatorId)
    .maybeSingle<{ id: string; hume_voice_id: string | null; hume_voice_name: string | null }>();
  if (creatorErr) return jsonError(500, 'creator_lookup_failed');
  if (!creator) return jsonError(404, 'creator_not_found');
  if (creator.hume_voice_id && !force) {
    return jsonError(409, 'already_cloned', 'creator already has a Hume voice; pass ?force=1 to overwrite');
  }
  const priorHumeVoiceId = creator.hume_voice_id;
  const priorHumeVoiceName = creator.hume_voice_name;

  // 6a. §5 audit C3 fix (2026-05-13) — cross-creator name collision check.
  // Hume voice names are unique org-wide (Hume's library key). If another
  // creator already points at this name, the overwrite-DELETE would nuke
  // the wrong creator's voice. Migration 0008 adds a UNIQUE INDEX as the
  // load-bearing guarantee; this pre-check returns a clearer 409 before
  // the finalize RPC hits the unique-constraint violation.
  const { data: clash, error: clashErr } = await sb
    .from('creators')
    .select('id')
    .eq('hume_voice_name', humeVoiceName)
    .neq('id', creatorId)
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (clashErr && clashErr.code !== 'PGRST116') return jsonError(500, 'collision_lookup_failed');
  if (clash) {
    return jsonError(409, 'hume_voice_name_in_use', 'another creator already points at this Hume voice name; rename it in app.hume.ai/voices first');
  }

  // 6b. §5 audit M1 fix (2026-05-13): insert the audit row BEFORE the
  // Hume GET-sanity-check. The previous ordering had GET-then-insert,
  // which meant retry-bursts on GET failures didn't count toward the
  // 20-attempts/24h cap (audit row never landed). Insert-first means
  // every attempt — even ones that bail at GET — leaves a ledger row
  // with hume_voice_id=NULL. §5.5 writer discipline: pass tts_provider
  // explicitly so 0007's DROP DEFAULT doesn't 23502.
  const { data: uploadRow, error: insErr } = await sb
    .from('voice_clone_uploads')
    .insert({
      admin_user_id: admin.userId,
      creator_id: creatorId,
      tts_provider: 'hume',
    })
    .select('id')
    .single<{ id: number }>();
  if (insErr || !uploadRow) {
    console.error('[voice-clone/hume-id] audit insert failed', insErr);
    return jsonError(500, 'audit_insert_failed');
  }

  // 7. GET-sanity-check against Hume — confirm the pasted (id, name) pair
  // actually exists in OUR Hume org's custom voice library. Catches the
  // common paste mistake (admin copied the wrong row). Hume's voices
  // endpoint is keyed by name + provider:
  //   GET /v0/tts/voices?name=<name>&provider=CUSTOM_VOICE
  // Authorization: X-Hume-Api-Key (Hume REST uses header; WS uses query
  // param — different schemes for different endpoints).
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), HUME_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      const url = `${HUME_LIST_VOICES_URL}?name=${encodeURIComponent(humeVoiceName)}&provider=CUSTOM_VOICE`;
      res = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Hume-Api-Key': humeKey,
          accept: 'application/json',
        },
        signal: ac.signal,
      });
    } finally { clearTimeout(to); }

    if (res.status === 404) {
      return jsonError(404, 'hume_voice_not_found', 'no voice with that name in OakLeague Hume org — verify the name copied from app.hume.ai/voices');
    }
    if (!res.ok) {
      // Don't log Hume body — error responses can echo client input.
      console.error('[voice-clone/hume-id] hume sanity GET non-200', res.status);
      if (res.status >= 500) {
        return jsonError(502, 'hume_unreachable', `status=${res.status}`);
      }
      return jsonError(502, 'hume_sanity_check_failed', `status=${res.status}`);
    }
    const list = await res.json().catch(() => null) as { voices?: Array<{ id?: unknown; name?: unknown }> } | null;
    const voices = Array.isArray(list?.voices) ? list!.voices : [];
    // §5 audit S9 fix (2026-05-13): split the failure modes so admin gets
    // an accurate diagnosis instead of the generic mismatch message.
    if (voices.length === 0) {
      return jsonError(
        404,
        'hume_voice_not_found',
        'no voice with that name in OakLeague Hume org — verify the name copied from app.hume.ai/voices',
      );
    }
    const match = voices.find((v) => String(v?.id ?? '') === humeVoiceId && String(v?.name ?? '') === humeVoiceName);
    if (!match) {
      return jsonError(
        404,
        'hume_voice_id_mismatch',
        'voice with that name exists in Hume but id does not match — verify both fields copied from the same row',
      );
    }
  } catch (e) {
    // Don't surface raw Hume errors. AbortError → timeout.
    if ((e as { name?: string })?.name === 'AbortError') {
      return jsonError(502, 'hume_unreachable', 'timeout');
    }
    console.error('[voice-clone/hume-id] hume sanity GET failed', (e as { code?: string })?.code || 'unknown');
    return jsonError(502, 'hume_unreachable');
  }

  // 9. Atomic finalize via v2 RPC. Writes both creators.hume_voice_id +
  // creators.hume_voice_name (paired CHECK) AND voice_clone_uploads.hume_*
  // under a per-creator advisory lock. RPC handles overwrite-active-session
  // gating (raises 55006) and admin-still-active gating.
  const { data: finalizeData, error: finalizeErr } = await sb.rpc('voice_clone_finalize_locked_v2', {
    p_admin_user_id: admin.userId,
    p_upload_id: uploadRow.id,
    p_creator_id: creatorId,
    p_tts_provider: 'hume',
    p_voice_id: humeVoiceId,
    p_voice_name: humeVoiceName,
    p_force: force,
  });
  if (finalizeErr) {
    console.error('[voice-clone/hume-id] finalize RPC failed', finalizeErr.code);

    // Don't enqueue the NEW voice for delete — the admin still has the
    // row in their Hume library and may want to retry. (Cartesia's
    // orphan-cleanup logic exists because Cartesia minted the voice
    // server-side; for Hume Scenario B the voice already exists in the
    // library before this call, and the admin owns it.)

    if (finalizeErr.code === '55006') {
      const msg = finalizeErr.message || '';
      // §6 unit-wide audit C1 (2026-05-13): finalize_v2 now also raises
      // 55006 when the worker is mid-dispatch on a voice the admin is
      // trying to re-finalize. Disambiguate by message.
      if (/voice_just_deleted_retry_paste/.test(msg)) {
        return NextResponse.json(
          {
            error: 'voice_dispatch_in_flight',
            detail: 'the previous Hume voice for this creator is being deleted by the worker right now; wait ~60s and re-paste a fresh voice from app.hume.ai/voices',
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
      const msg = finalizeErr.message || '';
      if (/already cloned/.test(msg)) {
        return jsonError(409, 'already_cloned', 'creator already has a Hume voice; pass ?force=1 to overwrite');
      }
      if (/already finalized/.test(msg)) {
        return jsonError(409, 'upload_already_used', 'this upload row was already consumed');
      }
      // §5 audit C3 catch (2026-05-13): if the route-level cross-creator
      // pre-check race-missed, the UNIQUE INDEX from migration 0008
      // surfaces here as a 23505 on creators_hume_voice_name_unique.
      // Convert to the same user-facing error as the pre-check.
      if (/creators_hume_voice_name(?:_preview|_dev)?_unique/.test(msg)) {
        return jsonError(409, 'hume_voice_name_in_use', 'another creator already points at this Hume voice name; rename it in app.hume.ai/voices first');
      }
    }
    // Audit M1 (post-fix): 22023 surfaces for data-mismatch errors
    // (admin/creator/tts_provider mismatch on the upload row, or
    // hume_voice_name_required when name was passed null — shouldn't
    // happen here since we validate above, but defensive).
    if (finalizeErr.code === '22023') {
      return jsonError(400, 'data_mismatch', finalizeErr.message || 'parameter validation failed');
    }
    return jsonError(500, 'finalize_failed', finalizeErr.code || 'unknown');
  }

  // 10. Overwrite path — enqueue OLD Hume voice for DELETE-by-name.
  // Hume keys DELETE by name (Phase-0 verified); composite PK requires
  // both columns in the upsert payload. priorHumeVoiceName must be
  // non-null on the overwrite path (paired CHECK guaranteed it at write
  // time) but defensively guard.
  if (priorHumeVoiceId && priorHumeVoiceName) {
    const dueAt = new Date(Date.now() + HUME_DELETE_DEFER_MS).toISOString();
    const { error: queueErr } = await sb.from('voice_delete_queue').upsert(
      {
        tts_provider: 'hume',
        voice_id: priorHumeVoiceId,
        voice_name: priorHumeVoiceName,
        enqueued_by: admin.userId,
        due_at: dueAt,
      },
      { onConflict: 'tts_provider,voice_id' },
    );
    if (queueErr) {
      // Don't fail the request — admin already swapped successfully.
      console.error('[voice-clone/hume-id] delete-queue enqueue failed', queueErr);
    }
  }

  // First-element optional chaining — finalizeData is TABLE-returning so
  // it comes back as an array. priorVoiceName mirrors Cartesia's
  // overwrote: boolean response shape.
  const prior = Array.isArray(finalizeData) ? finalizeData[0] : null;

  return NextResponse.json({
    ok: true,
    humeVoiceId,
    humeVoiceName,
    uploadId: uploadRow.id,
    overwrote: !!priorHumeVoiceId,
    priorVoiceName: prior?.prior_voice_name ?? null,
  });
}
