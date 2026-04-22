import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Rater score submission — TOKEN-AUTH ONLY. Raters are friends/colleagues,
// not admins; assertAdminFromSession() would 403 them. Token revalidated
// against spike_b_rater_tokens on every call. Single-use: consume token on
// successful insert. See SPIKE_B_PLAN.md decision 14 + §Security review.
//
// Source-of-truth for rater_cohort is the TOKEN ROW, never the client payload.
// A hostile client could otherwise flip cohort to bypass the DB-level
// rater_cohort_fields_gated CHECK on spike_b_rater_scores.

function json(status: number, body: unknown) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    const originHost = new URL(origin).host;
    const forwardedHost = req.headers.get('x-forwarded-host');
    const reqHost = forwardedHost ?? req.nextUrl.host;
    return originHost === reqHost;
  } catch {
    return false;
  }
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = {
  token?: unknown;
  clip_pair_id?: unknown;
  lipsync_alignment?: unknown;
  mouth_in_sync?: unknown;
  feels_alive?: unknown;
  resemblance?: unknown;
  uncanny_valley?: unknown;
  would_listen_5_min?: unknown;
  sentinel_flag?: unknown;
  metadata?: unknown;
};

function intIn(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return null;
  return v;
}

function optIntIn(v: unknown, min: number, max: number): number | null | 'bad' {
  if (v === null || typeof v === 'undefined') return null;
  const n = intIn(v, min, max);
  return n === null ? 'bad' : n;
}

function optBool(v: unknown): boolean | null | 'bad' {
  if (v === null || typeof v === 'undefined') return null;
  if (typeof v === 'boolean') return v;
  return 'bad';
}

type TokenRow = {
  token_id: string;
  rater_id: string;
  rater_cohort: 'vuk_naive' | 'vuk_knower';
  bound_ua_hash: string;
  expires_at: string;
  consumed_at: string | null;
};

type SideProviderMap = { left: 'simli' | 'tavus'; right: 'simli' | 'tavus' };

type ClipPairRow = { clip_pair_id: string; side_provider_map: SideProviderMap };

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  const ua = req.headers.get('user-agent') ?? '';
  if (ua.length < 1 || ua.length > 2048) return json(400, { error: 'bad_ua' });
  const uaHash = sha256Hex(ua);

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json(400, { error: 'bad_json' }); }

  const token = body.token;
  if (typeof token !== 'string' || !UUID_RE.test(token)) return json(400, { error: 'bad_token' });

  const clipPairId = body.clip_pair_id;
  if (typeof clipPairId !== 'string' || clipPairId.length < 1 || clipPairId.length > 64) {
    return json(400, { error: 'bad_clip_pair_id' });
  }

  const admin = supabaseAdmin();

  // Token revalidation: exists, unexpired, unconsumed, UA matches. The UA
  // binding prevents token-sharing: if the rater forwarded their link to
  // someone else, their UA hash differs.
  const { data: tokenRow, error: tokErr } = await admin
    .from('spike_b_rater_tokens')
    .select('token_id, rater_id, rater_cohort, bound_ua_hash, expires_at, consumed_at')
    .eq('token_id', token)
    .maybeSingle<TokenRow>();
  if (tokErr) {
    Sentry.captureException(tokErr, { extra: { op: 'rate_submit_token_lookup' } });
    return json(500, { error: 'token_lookup_failed' });
  }
  if (!tokenRow) return json(404, { error: 'token_not_found' });
  if (tokenRow.consumed_at) return json(410, { error: 'token_consumed' });
  if (new Date(tokenRow.expires_at).getTime() < Date.now()) return json(410, { error: 'token_expired' });
  if (tokenRow.bound_ua_hash !== uaHash) return json(403, { error: 'ua_mismatch' });

  // Ground truth for cohort is the token row, NOT the client body. A compromised
  // or buggy client otherwise bypasses the DB rater_cohort_fields_gated CHECK
  // by submitting vuk_knower fields under a vuk_naive label (or vice versa).
  const cohort = tokenRow.rater_cohort;

  // Validate client scores. Shared fields.
  const lipsync = optIntIn(body.lipsync_alignment, 1, 10);
  const mouthInSync = optBool(body.mouth_in_sync);
  const feelsAlive = optIntIn(body.feels_alive, 1, 10);
  const sentinel = typeof body.sentinel_flag === 'boolean' ? body.sentinel_flag : false;
  if (lipsync === 'bad') return json(400, { error: 'bad_lipsync_alignment' });
  if (mouthInSync === 'bad') return json(400, { error: 'bad_mouth_in_sync' });
  if (feelsAlive === 'bad') return json(400, { error: 'bad_feels_alive' });

  // Vuk-knower-only fields. For naïve cohort these are forced null regardless
  // of what the client submitted (belt-and-suspenders; the DB CHECK would also
  // reject, but an explicit null keeps the error path serializable).
  let resemblance: number | null = null;
  let uncannyValley: boolean | null = null;
  let wouldListen: boolean | null = null;
  if (cohort === 'vuk_knower') {
    const r = optIntIn(body.resemblance, 1, 10);
    const u = optBool(body.uncanny_valley);
    const w = optBool(body.would_listen_5_min);
    if (r === 'bad') return json(400, { error: 'bad_resemblance' });
    if (u === 'bad') return json(400, { error: 'bad_uncanny_valley' });
    if (w === 'bad') return json(400, { error: 'bad_would_listen_5_min' });
    resemblance = r;
    uncannyValley = u;
    wouldListen = w;
  }

  let metadata: Record<string, unknown> | null = null;
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      return json(400, { error: 'bad_metadata' });
    }
    const asStr = JSON.stringify(body.metadata);
    if (asStr.length > 2048) return json(400, { error: 'metadata_too_large' });
    metadata = body.metadata as Record<string, unknown>;
  }

  // Look up side→provider map for this clip pair. The map lives server-side
  // (admin seeds it when authoring the pair); raters never see provider names.
  // We don't have a clip_pairs table in Phase 1, so the map is passed in via
  // server-side lookup from a seed. For Phase 1 smoke, accept the admin-seeded
  // mapping via spike_b_rater_scores prior rows OR via a default 50/50.
  //
  // Day 11 hardens this with a spike_b_clip_pairs table keyed by clip_pair_id.
  // For now: if any prior row references this clip_pair_id, reuse its map
  // (keeps consistency within a cohort); otherwise reject as unknown pair.
  const { data: priorRows, error: priorErr } = await admin
    .from('spike_b_rater_scores')
    .select('side_provider_map')
    .eq('clip_pair_id', clipPairId)
    .limit(1);
  if (priorErr) {
    Sentry.captureException(priorErr, { extra: { op: 'rate_submit_map_lookup' } });
    return json(500, { error: 'map_lookup_failed' });
  }
  const map = (priorRows?.[0] as ClipPairRow | undefined)?.side_provider_map;
  if (
    !map ||
    (map.left !== 'simli' && map.left !== 'tavus') ||
    (map.right !== 'simli' && map.right !== 'tavus')
  ) {
    return json(400, { error: 'unknown_clip_pair' });
  }

  // Insert score. Sentinel-abort detection is offline in Phase 3; we just record.
  const { error: insErr } = await admin.from('spike_b_rater_scores').insert({
    rater_id: tokenRow.rater_id,
    rater_cohort: cohort,
    clip_pair_id: clipPairId,
    side_provider_map: map,
    lipsync_alignment: lipsync,
    mouth_in_sync: mouthInSync,
    feels_alive: feelsAlive,
    resemblance,
    uncanny_valley: uncannyValley,
    would_listen_5_min: wouldListen,
    sentinel_flag: sentinel,
    metadata,
  });
  if (insErr) {
    Sentry.captureException(insErr, { extra: { op: 'rate_submit_insert', code: insErr.code } });
    return json(500, { error: 'score_insert_failed' });
  }

  // Consume token (single-use). This is best-effort AFTER score insert — if
  // the score was written but consume fails, the rater can re-submit, which
  // would create a duplicate row. Acceptable for Phase 1 (sentinels dedupe
  // offline); Day 11 may atomicize via RPC.
  const { error: consErr } = await admin
    .from('spike_b_rater_tokens')
    .update({ consumed_at: new Date().toISOString() })
    .eq('token_id', tokenRow.token_id)
    .is('consumed_at', null);
  if (consErr) {
    Sentry.captureException(consErr, { extra: { op: 'rate_submit_consume' } });
    // Non-fatal — score already landed.
  }

  return json(200, { ok: true });
}
