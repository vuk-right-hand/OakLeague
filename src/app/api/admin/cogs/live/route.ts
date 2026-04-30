// GET /api/admin/cogs/live — live in-flight sessions with running voice cost.
//
// Two-phase fetch (PostgREST can't join aggregates in a single client call):
//   1. sessions where ended_at IS NULL, newest-first, capped at 50 rows.
//   2. cogs_log rows for those session ids, filtered to the four α' voice
//      operations. We DO NOT use LIKE 'voice_%' — explicit IN-list avoids a
//      wildcard that would also match future operation strings (e.g. a Mux
//      `voice_x` would silently leak into the running total).
// Then fold the cogs rows into per-session sums client-side.
//
// Voice op strings are the α' legs (CLAUDE.md + handoff §5):
//   gemini.voice_audio_input_seconds   (billable seconds)
//   gemini.voice_audio_out_tokens      (billable, audio discarded)
//   cartesia.voice_tts_characters      (primary Cartesia billable)
//   cartesia.voice_tts_audio_seconds   (cost=0 observability only)
// Leg 4 has cost=0 on purpose, so SUM(cost_usd) does NOT double-count.

import 'server-only';
import { type NextRequest } from 'next/server';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { json, mapAuthGuardStatus } from '@/lib/session/http-helpers';
import {
  aggregateLiveSessions,
  fallbackRate,
  type CogsLiveRow,
} from '@/lib/admin/cogs-aggregations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VOICE_OPS = [
  'voice_audio_input_seconds',
  'voice_audio_out_tokens',
  'voice_tts_characters',
  'voice_tts_audio_seconds',
] as const;

type LiveSession = {
  id: string;
  user_id: string;
  creator_id: string | null;
  started_at: string;
  model_used: string | null;
  tier_at_session: string;
  active_seconds: number;
  environment: string | null;
  // Headline cost = truth-only sum (rows where metadata->>'fallback' IS NULL).
  // Fallback cost is reported separately so admins see the imprecision.
  voice_cost_usd: number;          // truth-only — render as the headline number
  voice_cost_usd_fallback: number; // seconds-derived rows; render as a badge
  voice_tts_audio_seconds: number;
  // turn_rows was renamed to cogs_rows for honesty: each turn writes 4 cogs
  // rows. cartesia_pending_rows counts the leg-3/4 placeholders we write while
  // Pipeline α' isn't wired (CLAUDE.md §Voice).
  cogs_rows: number;
  cartesia_pending_rows: number;
  // count(fallback) / count(leg-2 rows). >0 = some leg-2 rows were
  // seconds-derived; >0.05 surfaces a Sentry breadcrumb (handled in dashboard).
  fallback_rate: number;
  user_handle: string | null;
  user_email: string | null;
};

type SessionRow = {
  id: string;
  user_id: string;
  creator_id: string | null;
  started_at: string;
  model_used: string | null;
  tier_at_session: string;
  active_seconds: number;
  environment: string | null;
};
type CogsRow = CogsLiveRow;
type ProfileRow = { id: string; handle: string | null; email: string | null };

export async function GET(_req: NextRequest) {
  try {
    await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) {
      const { status, body } = mapAuthGuardStatus(e.status);
      return json(status, body);
    }
    throw e;
  }

  const sb = supabaseAdmin();

  const { data: sessRows, error: sessErr } = await sb
    .from('sessions')
    .select('id, user_id, creator_id, started_at, model_used, tier_at_session, active_seconds, environment')
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(50);
  if (sessErr) return json(500, { error: 'sessions_query_failed', detail: sessErr.message.slice(0, 200) });

  const sessions = (sessRows ?? []) as SessionRow[];
  if (sessions.length === 0) return json(200, { sessions: [] as LiveSession[] });

  const sessionIds = sessions.map((s) => s.id);
  const userIds = Array.from(new Set(sessions.map((s) => s.user_id)));

  const [{ data: cogsRows, error: cogsErr }, { data: profileRows, error: profErr }] = await Promise.all([
    sb.from('cogs_log')
      .select('session_id, service, operation, units, cost_usd, metadata')
      .in('session_id', sessionIds)
      .in('operation', VOICE_OPS as unknown as string[]),
    sb.from('profiles')
      .select('id, handle, email')
      .in('id', userIds),
  ]);
  if (cogsErr) return json(500, { error: 'cogs_query_failed', detail: cogsErr.message.slice(0, 200) });
  if (profErr) return json(500, { error: 'profiles_query_failed', detail: profErr.message.slice(0, 200) });

  const byId = aggregateLiveSessions((cogsRows ?? []) as CogsRow[]);

  const profileById = new Map<string, ProfileRow>(
    ((profileRows ?? []) as ProfileRow[]).map((p) => [p.id, p]),
  );

  const out: LiveSession[] = sessions.map((s) => {
    const agg = byId.get(s.id);
    const prof = profileById.get(s.user_id);
    const fbRate = agg ? fallbackRate(agg) : 0;
    return {
      id: s.id,
      user_id: s.user_id,
      creator_id: s.creator_id,
      started_at: s.started_at,
      model_used: s.model_used,
      tier_at_session: s.tier_at_session,
      active_seconds: s.active_seconds,
      environment: s.environment,
      voice_cost_usd: Number((agg?.cost_usd_truth ?? 0).toFixed(6)),
      voice_cost_usd_fallback: Number((agg?.cost_usd_fallback ?? 0).toFixed(6)),
      voice_tts_audio_seconds: Number((agg?.tts_seconds ?? 0).toFixed(2)),
      cogs_rows: agg?.cogs_rows ?? 0,
      cartesia_pending_rows: agg?.cartesia_pending_rows ?? 0,
      fallback_rate: Number(fbRate.toFixed(3)),
      user_handle: prof?.handle ?? null,
      user_email: prof?.email ?? null,
    };
  });

  return json(200, { sessions: out });
}
