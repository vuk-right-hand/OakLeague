// SIMLI_WIREUP §6 / R3-M3 / R4-M3 — Simli minute-level reconciliation.
//
// Bridge fires `onMinuteAccrual(seconds)` exactly once on close(); the
// browser POSTs to this endpoint, which writes a cogs_log row with
// operation='simli.video_minutes_bridge_close'. Distinct from the
// reaper-derived 'simli.video_minutes_reaper' so the aggregator MUSTes
// MAX(bridge_close, reaper) per session — never sum (a rollover yields
// two bridge_close rows, but they represent two non-overlapping pipes).
//
// WHY NOT cogs_insert_avatar_turn (B4.3 audit clarification):
//   The avatar-turn RPC (migration 20260502000003) is for PER-TURN
//   lipsync writes — its CHECK constraint enforces `p_duration_s > 0
//   AND <= 60`. This route is SESSION-LEVEL accrual: onMinuteAccrual
//   fires once per pipe-close with TOTAL session seconds, validated 0
//   to 7200 (2 hours). Routing through the RPC would 22003 every
//   write longer than 60s. Different cadence, different op, different
//   constraints. Cost ceiling enforcement here lives in
//   clampReportedCostUsd(...) — same ceiling values as the RPC.
//
// Idempotency: NOT enforced via cogs_log_turn_idempotency partial unique
// index — that index is `WHERE turn_number IS NOT NULL` and we MUST keep
// `turn_number` NULL here. Reason (R4-M3 + auditor C1): a rollover yields
// TWO bridge.close() events (one per pipe), each producing one accrual
// row. The aggregator MAXes per session — but two rows MUST exist. Setting
// turn_number=0 would 23505 the second row into oblivion.
//
// Network-retry idempotency for accrual is therefore route-side: we use
// a per-(session_id, opened_at) idempotency key derived from the request
// payload to dedup, currently best-effort via "first writer wins" check.
// In practice the bridge fires onMinuteAccrual exactly once per close()
// call (minuteAccrualFired guard) and the browser sendBeacon delivers
// once; retry storms aren't realistic.
//
// Cost: BEST_ESTIMATE_USD_PER_MIN.simli * (seconds/60), clamped to the
// daily ceiling via ceilingUsdPerMin (cost.ts).
//
// Grace window (Phase C B4.3): mirrors cogs_insert_avatar_turn's 60s
// threshold from migration 20260502000003. Protects against stale
// client-side replay POSTing accrual long after session_close ran.

import 'server-only';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getCallerUserId } from '@/lib/auth-guards';
import { json, isSameOrigin } from '@/lib/session/http-helpers';
import { BEST_ESTIMATE_USD_PER_MIN, QUOTED_AT, clampReportedCostUsd } from '@/lib/avatar/cost';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = {
  session_id?: unknown;
  seconds?: unknown;
};

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  const callerUserId = await getCallerUserId();
  if (!callerUserId) return json(401, { error: 'unauthorized' });

  // Phase C B3.5: per-request Sentry user tag. See sessions/open route for
  // rationale.
  Sentry.setUser({ id: callerUserId });

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json(400, { error: 'bad_json' }); }

  const sessionId = typeof body.session_id === 'string' && UUID_RE.test(body.session_id) ? body.session_id : null;
  if (!sessionId) return json(400, { error: 'bad_session_id' });

  const seconds = typeof body.seconds === 'number' && Number.isFinite(body.seconds) ? body.seconds : NaN;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 7200) {
    return json(400, { error: 'bad_seconds' });
  }

  const admin = supabaseAdmin();

  // Verify session ownership before billing. Service-role bypasses RLS.
  const { data: session, error: sessErr } = await admin
    .from('sessions')
    .select('id, user_id, ended_at')
    .eq('id', sessionId)
    .maybeSingle<{ id: string; user_id: string; ended_at: string | null }>();
  if (sessErr) return json(500, { error: 'session_lookup_failed' });
  if (!session || session.user_id !== callerUserId) return json(403, { error: 'not_owner' });

  // Grace window (Phase C B4.3) — mirrors cogs_insert_avatar_turn's 60s
  // threshold (migration 20260502000003:65-70). Reject accrual POSTed
  // long after session_close ran (replay defense). ended_at IS NULL
  // means session is live or just closed; accept either way.
  if (session.ended_at && new Date(session.ended_at).getTime() < Date.now() - 60_000) {
    return json(410, { error: 'session_closed' });
  }

  const minutes = seconds / 60;
  const rawCost = BEST_ESTIMATE_USD_PER_MIN.simli * minutes;
  const cost = clampReportedCostUsd('simli', rawCost, seconds);

  // Auditor C1 fix — turn_number is NULL so the idempotency partial
  // unique index doesn't apply. Multiple bridge_close rows per session
  // (rollover) are EXPECTED; aggregator MAXes by session.
  const { error: insErr } = await admin.from('cogs_log').insert({
    user_id: callerUserId,
    session_id: sessionId,
    turn_number: null,
    service: 'simli',
    operation: 'simli.video_minutes_bridge_close',
    units: Number(minutes.toFixed(4)),
    unit_label: 'minutes',
    cost_usd: cost,
    environment: 'production',
    metadata: {
      seconds: Number(seconds.toFixed(2)),
      quoted_at: QUOTED_AT,
      source: 'bridge_close',
    },
  });
  if (insErr) {
    Sentry.captureException(insErr, { extra: { op: 'simli_accrual_insert', session_id: sessionId } });
    return json(500, { error: 'insert_failed' });
  }

  return json(200, { ok: true, seconds, cost_usd: cost });
}
