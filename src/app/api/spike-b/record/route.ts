import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { clampReportedCostUsd, BEST_ESTIMATE_USD_PER_MIN } from '@/lib/avatar/cost';
import { insertAvatarCogs } from '@/lib/avatar/cogs';
import { AVATAR_ERROR_CODES, type AvatarErrorCode, type AvatarProvider } from '@/lib/avatar/avatar-bridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

const VALID_PROVIDERS: ReadonlySet<AvatarProvider> = new Set(['simli', 'tavus']);
const VALID_OUTCOMES: ReadonlySet<AvatarErrorCode | 'ok'> = new Set<AvatarErrorCode | 'ok'>([
  'ok',
  ...AVATAR_ERROR_CODES,
]);

type Body = {
  provider?: unknown;
  clip_id?: unknown;
  chunk_size_bytes?: unknown;
  iteration?: unknown;
  device?: unknown;
  network?: unknown;
  t0_t1_ms?: unknown;
  t1_t2_ms?: unknown;
  duration_seconds?: unknown;
  reported_cost_usd?: unknown;
  outcome?: unknown;
  metadata?: unknown;
};

function num(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return null;
  return v;
}

function nullableNum(v: unknown, min: number, max: number): number | null | undefined {
  if (v === null || typeof v === 'undefined') return null;
  const n = num(v, min, max);
  return n;
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  let session;
  try {
    session = await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return json(e.status, { error: e.message });
    throw e;
  }

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json(400, { error: 'bad_json' }); }

  const provider = body.provider;
  if (typeof provider !== 'string' || !VALID_PROVIDERS.has(provider as AvatarProvider)) {
    return json(400, { error: 'bad_provider' });
  }
  const clipId = body.clip_id;
  if (typeof clipId !== 'string' || clipId.length < 1 || clipId.length > 64) {
    return json(400, { error: 'bad_clip_id' });
  }
  const iteration = num(body.iteration, 1, 100);
  if (iteration === null) return json(400, { error: 'bad_iteration' });

  const device = typeof body.device === 'string' && body.device.length >= 1 && body.device.length <= 64
    ? body.device : null;
  if (!device) return json(400, { error: 'bad_device' });

  const network = typeof body.network === 'string' && body.network.length <= 32 ? body.network : null;

  const chunkSize = body.chunk_size_bytes == null ? null : num(body.chunk_size_bytes, 1, 65536);
  if (body.chunk_size_bytes != null && chunkSize === null) {
    return json(400, { error: 'bad_chunk_size' });
  }

  const t0t1 = nullableNum(body.t0_t1_ms, 0, 120_000);
  // t1t2 can be negative: Simli streams a standby frame before audio arrives,
  // so video starts before t1. Negative = video-before-audio (useful datum).
  const t1t2 = nullableNum(body.t1_t2_ms, -120_000, 120_000);
  if (t0t1 === null && body.t0_t1_ms !== null && typeof body.t0_t1_ms !== 'undefined') {
    return json(400, { error: 'bad_t0_t1' });
  }
  if (t1t2 === null && body.t1_t2_ms !== null && typeof body.t1_t2_ms !== 'undefined') {
    return json(400, { error: 'bad_t1_t2' });
  }

  const duration = num(body.duration_seconds, 0, 3600);
  if (duration === null) return json(400, { error: 'bad_duration' });

  const reportedCost = num(body.reported_cost_usd, 0, 1000);
  if (reportedCost === null) return json(400, { error: 'bad_cost' });

  const outcome = body.outcome;
  if (typeof outcome !== 'string' || !VALID_OUTCOMES.has(outcome as AvatarErrorCode | 'ok')) {
    return json(400, { error: 'bad_outcome' });
  }

  // Preserve raw provider code when outcome='other' so taxonomy drift is
  // recoverable — see migration 20260422000001 outcome CHECK comment.
  let metadata: Record<string, unknown> | null = null;
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      return json(400, { error: 'bad_metadata' });
    }
    const asStr = JSON.stringify(body.metadata);
    if (asStr.length > 8192) return json(400, { error: 'metadata_too_large' });
    metadata = body.metadata as Record<string, unknown>;
  }
  if (outcome === 'other' && (!metadata || typeof metadata['outcome_raw'] !== 'string')) {
    return json(400, { error: 'outcome_other_requires_outcome_raw' });
  }

  // Apply a floor of best-estimate before clamping to the ceiling. When the
  // bridge has not yet reported a real cost (reportedCostUsd=0 in Phase 1),
  // this ensures the COGS accumulator and the kill-switch dollar cap receive
  // non-zero values, keeping them effective. clampReportedCostUsd still caps
  // UP at ceiling × duration so a mis-reporting provider can't blow the cap.
  const floor = (duration / 60) * BEST_ESTIMATE_USD_PER_MIN[provider as AvatarProvider];
  const clamped = clampReportedCostUsd(provider as AvatarProvider, Math.max(reportedCost, floor), duration);

  const admin = supabaseAdmin();
  try {
    // Write COGS first — if the run INSERT fails below, we still have the cost
    // row so the kill-switch keeps tightening. If COGS fails, abort (the row
    // would be invisible to the cap gate).
    await insertAvatarCogs({
      userId: session.userId,
      provider: provider as AvatarProvider,
      clampedCostUsd: clamped,
      durationSeconds: duration,
      environment: 'spike_b',
      metadata: {
        source: 'spike_b_harness',
        clip_id: clipId,
        iteration,
        device,
        network,
        chunk_size_bytes: chunkSize,
        outcome,
      },
    });

    const { error } = await admin.from('spike_b_runs').insert({
      run_by: session.userId,
      provider,
      clip_id: clipId,
      chunk_size_bytes: chunkSize,
      iteration,
      device,
      network,
      t0_t1_ms: t0t1 ?? null,
      t1_t2_ms: t1t2 ?? null,
      duration_seconds: duration,
      cost_usd: clamped,
      outcome,
      metadata,
    });
    if (error) throw new Error(`spike_b_runs_insert_failed: ${error.message}`);
  } catch (e) {
    Sentry.captureException(e, { extra: { op: 'spike_b_record' } });
    return json(500, { error: 'record_failed' });
  }

  return json(200, { ok: true, cost_usd: clamped });
}
