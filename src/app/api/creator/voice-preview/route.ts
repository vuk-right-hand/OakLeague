// POST /api/creator/voice-preview
//
// Creator-only preview endpoint for the voice-speed slider. Synthesizes a
// canned sentence at the requested speed using the creator's own Cartesia
// voice clone and returns the mp3 bytes for in-browser playback.
//
// Audit-driven design (R1 + R2 audits applied):
//   * R2 C1: speed range [0.6, 1.5], 1.0 = Cartesia no-op (omit field).
//   * R1 M2 / R2 M1: 3-state auth ladder — 401 unauthenticated → 403
//     not_a_creator → 409 voice_not_trained.
//   * R2 C3: numeric→number coercion at the creator-row boundary.
//   * R2 C4: env-scoped voice_id via resolveVoiceId().
//   * R1 C3 / R2 C5: rate_limit_hit with explicit signature, keyed by
//     creatorId. Two layers: burst (5/min) + daily (20/day, count-based
//     instead of $-aggregate per Vuk's 2026-05-11 decision).
//   * R2 C4 (cogs): service='cartesia', operation='voice_tts_preview_characters',
//     environment='production', units + unit_label REQUIRED.
//   * R1 M5 / R2 M6: branch on upstream.ok + content-length > 0. NEVER
//     stream a JSON error body as audio/mpeg.
//   * R2 M5: shouldSendSpeed() helper inline-duplicated to keep bridge
//     and preview path in sync (cross-package import infeasible).
//
// Cost model: ~150 chars × $0.00005/char = $0.0075/tap. 20/day cap = $0.15/day/creator
// worst case. Negligible vs production session cost.

import 'server-only';
import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { resolveVoiceId } from '@/lib/voice/env-scoped-voice-id';

// Canned preview sentence. ASCII-only (R1 audit S4 — avoid smart-quote
// autocorrect since Cartesia has historically rejected non-ASCII control
// chars). ~150 chars; ~7 seconds at default cadence.
const PREVIEW_SENTENCE =
  'Hi, this is how I will sound when someone taps to ask me a question. ' +
  'If this feels too fast or too slow, drag the slider and play this again.';

const CARTESIA_BYTES_ENDPOINT = 'https://api.cartesia.ai/tts/bytes';
const CARTESIA_VERSION = '2026-03-01';
const CARTESIA_TIMEOUT_MS = 8000;

// Keep in sync with shouldSendSpeed() in server/voice-proxy/cartesia-bridge.js.
// R2 audit M5: cross-package module import not feasible (proxy has its own
// node_modules, no shared build artifact). Duplicated by design.
function shouldSendSpeed(v: number | null): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v !== 1.0 && v >= 0.6 && v <= 1.5;
}

type ErrorBody = { code: string; detail?: string };

function jsonError(code: string, status: number, detail?: string): NextResponse<ErrorBody> {
  return NextResponse.json<ErrorBody>(
    detail ? { code, detail } : { code },
    { status },
  );
}

export async function POST(req: Request): Promise<NextResponse | Response> {
  // 1. Auth.
  const callerUserId = await getCallerUserId();
  if (!callerUserId) return jsonError('unauthorized', 401);

  // 2. Parse body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('invalid_json', 400);
  }
  const speedRaw = (body as { speed?: unknown })?.speed;
  if (typeof speedRaw !== 'number' || !Number.isFinite(speedRaw)) {
    return jsonError('invalid_speed', 400, 'speed must be a finite number');
  }
  if (speedRaw < 0.6 || speedRaw > 1.5) {
    return jsonError('speed_out_of_range', 400, 'speed must be in [0.6, 1.5]');
  }
  const speed = speedRaw;

  // 3. Resolve creator. Separate SELECT (NOT getCreatorForCaller — that
  // helper doesn't return voice_id/voice_id_preview/voice_id_dev or
  // tts_speed). R2 audit M1.
  const admin = supabaseAdmin();
  const { data: creatorRow, error: creatorErr } = await admin
    .from('creators')
    .select('id, voice_id, voice_id_preview, voice_id_dev')
    .eq('user_id', callerUserId)
    .maybeSingle<{
      id: string;
      voice_id: string | null;
      voice_id_preview: string | null;
      voice_id_dev: string | null;
    }>();
  if (creatorErr) {
    Sentry.captureException(creatorErr, { extra: { op: 'voice_preview_creator_lookup' } });
    return jsonError('creator_lookup_failed', 500);
  }
  if (!creatorRow) {
    return jsonError('not_a_creator', 403);
  }

  // 4. Resolve env-scoped voice_id. R2 audit C4: single-column read of
  // `voice_id` would break on Vercel preview deploys and localhost.
  const voiceId = resolveVoiceId(creatorRow);
  if (!voiceId) {
    return jsonError('voice_not_trained', 409, 'train your cloned voice first');
  }
  const creatorId = creatorRow.id;

  // 5. Rate limits — burst (5/min) + daily (20/day). Both via the
  //    rate_limit_counters table.
  //    Burst: rate_limit_hit RPC, signature (p_scope, p_key, p_window:='1 minute', p_limit).
  //    Daily: rate_limit_hit_day RPC (added in migration 20260511000006),
  //    purpose-built to bucket on day rather than minute. The existing
  //    rate_limit_hit RPC RAISEs 22023 on any window other than '1 minute'
  //    (migration 20260503000009:397) — the day RPC is a sister function
  //    with day-bucket semantics.
  //    Keyed by creatorId so a creator can't bypass via multiple sessions.
  const { data: burstOk, error: burstErr } = await admin.rpc('rate_limit_hit', {
    p_scope: 'voice_tts_preview_burst',
    p_key: creatorId,
    p_window: '1 minute',
    p_limit: 5,
  });
  if (burstErr) {
    Sentry.captureException(burstErr, { extra: { op: 'voice_preview_rate_limit_burst' } });
    return jsonError('rate_limit_failed', 500);
  }
  if (burstOk === false) return jsonError('rate_limited', 429, 'too many previews this minute');

  const { data: dailyOk, error: dailyErr } = await admin.rpc('rate_limit_hit_day', {
    p_scope: 'voice_tts_preview_daily',
    p_key: creatorId,
    p_limit: 20,
  });
  if (dailyErr) {
    Sentry.captureException(dailyErr, { extra: { op: 'voice_preview_rate_limit_daily' } });
    return jsonError('rate_limit_failed', 500);
  }
  if (dailyOk === false) return jsonError('daily_cap_reached', 429, 'preview budget resets midnight UTC');

  // 6. Fail-closed pricing env. CLAUDE.md mandates fail-closed when α' is on.
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) {
    return jsonError('cartesia_api_key_unset', 500);
  }
  const usdPerCharRaw = Number(process.env.CARTESIA_USD_PER_CHAR);
  if (!Number.isFinite(usdPerCharRaw) || usdPerCharRaw <= 0) {
    return jsonError('cartesia_pricing_unset', 500);
  }

  // 7. Build Cartesia request.
  const cartesiaBody: Record<string, unknown> = {
    model_id: 'sonic-3',
    transcript: PREVIEW_SENTENCE,
    voice: { mode: 'id', id: voiceId },
    output_format: { container: 'mp3', sample_rate: 24000, bit_rate: 128000 },
  };
  if (shouldSendSpeed(speed)) {
    cartesiaBody.generation_config = { speed };
  }

  // 8. Call Cartesia with timeout.
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), CARTESIA_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(CARTESIA_BYTES_ENDPOINT, {
      method: 'POST',
      headers: {
        // Pre-commit audit C2: Cartesia REST uses `Authorization: Bearer`,
        // NOT `X-API-Key` (that's the WebSocket auth header — used by the
        // proxy bridge). Confirmed by every other REST callsite in the
        // codebase (admin/voice-clone, voice-delete-worker).
        authorization: `Bearer ${apiKey}`,
        'Cartesia-Version': CARTESIA_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cartesiaBody),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(to);
    const err = e as Error;
    if (err?.name === 'AbortError') return jsonError('cartesia_timeout', 504);
    Sentry.captureException(e, { extra: { op: 'voice_preview_cartesia_fetch' } });
    return jsonError('cartesia_unreachable', 502);
  }
  // Clear the timeout BEFORE reading the body — otherwise a slow body
  // stream could trip the abort mid-read (pre-commit audit C3 race).
  clearTimeout(to);

  // 9. Branch on upstream status. R1 audit M5 / R2 M6 — NEVER forward
  // a JSON error body as audio/mpeg.
  if (!upstream.ok) {
    const upstreamStatus = upstream.status;
    let upstreamMsg = '';
    try {
      const errBody = await upstream.text();
      upstreamMsg = errBody.slice(0, 256);
    } catch { /* ignore */ }
    Sentry.captureMessage(`voice_preview_cartesia_error`, {
      level: 'warning',
      extra: { upstreamStatus, upstreamMsg, creatorId, speed },
    });
    // Map common cases to friendly codes.
    if (upstreamStatus === 401 || upstreamStatus === 403) {
      return jsonError('cartesia_auth_failed', 502);
    }
    if (upstreamStatus === 404) {
      return jsonError('cartesia_voice_not_found', 502);
    }
    if (upstreamStatus === 429) {
      return jsonError('cartesia_rate_limited', 502);
    }
    return jsonError('cartesia_error', 502, `upstream ${upstreamStatus}`);
  }

  // 10. Buffer + content-length guard (R2 M6 — 200 + 0 bytes shouldn't
  // be streamed as silent audio). Wrapped in try/catch — pre-commit
  // audit C3: a late-firing abort could trip during body read even if
  // headers arrived OK.
  let audioBuf: Buffer;
  try {
    audioBuf = Buffer.from(await upstream.arrayBuffer());
  } catch (e) {
    const err = e as Error;
    if (err?.name === 'AbortError') return jsonError('cartesia_timeout', 504);
    Sentry.captureException(e, { extra: { op: 'voice_preview_arraybuffer' } });
    return jsonError('cartesia_unreachable', 502);
  }
  if (audioBuf.length === 0) {
    Sentry.captureMessage('voice_preview_cartesia_empty_body', {
      level: 'warning',
      extra: { creatorId, speed },
    });
    return jsonError('cartesia_empty_body', 502);
  }

  // 11. Log to cogs_log. R2 audit C4 — full INSERT shape with units + unit_label.
  try {
    await admin.from('cogs_log').insert({
      user_id: callerUserId,
      session_id: null,
      service: 'cartesia',
      operation: 'voice_tts_preview_characters',
      units: PREVIEW_SENTENCE.length,
      unit_label: 'characters',
      cost_usd: PREVIEW_SENTENCE.length * usdPerCharRaw,
      environment: 'production',
      metadata: {
        kind: 'voice_speed_preview',
        speed,
        transcript_chars: PREVIEW_SENTENCE.length,
        audio_bytes: audioBuf.length,
        creator_id: creatorId,
      },
    });
  } catch (e) {
    // cogs failure does NOT fail the request — log + continue. The user's
    // preview is more important than a missing cogs row.
    Sentry.captureException(e, { extra: { op: 'voice_preview_cogs_log' } });
  }

  // 12. Stream audio bytes. The Response BodyInit type union in the
  // current TS DOM lib doesn't include Buffer / Uint8Array even though
  // both are accepted at runtime. Cast via `as unknown as BodyInit`
  // narrows TS without changing runtime behavior.
  const bodyBytes = new Uint8Array(audioBuf.buffer, audioBuf.byteOffset, audioBuf.byteLength);
  return new Response(bodyBytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(audioBuf.length),
      'Cache-Control': 'no-store',
    },
  });
}
