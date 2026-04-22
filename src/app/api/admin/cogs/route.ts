// GET /api/admin/cogs — COGS rollup for the admin dashboard.
//
// Queries `cogs_log_admin_rollup` (materialized view, refreshed every 60s by
// pg_cron per 20260502000005). Admin-auth; service-role read because the MV
// is owner-only (REVOKE ALL from PUBLIC/anon/authenticated — R2-M2).
//
// Query params:
//   - `window_s` (default 3600, max 86400) — trailing seconds to aggregate
//   - `environment` (optional) — filter to one cogs_log.environment value
//
// Response:
//   {
//     window_s: number,
//     range_start: string (ISO),
//     range_end: string (ISO),
//     total_usd: number,
//     by_service: { service, environment, cost_usd, units, row_count }[]
//   }
// Note (R5-S1): by_minute was dropped. The dashboard only renders by_service
// today; re-add when a sparkline/time-series view lands.

import 'server-only';
import { type NextRequest } from 'next/server';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { json, mapAuthGuardStatus } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_ENVS = new Set(['production', 'spike_a', 'spike_b', 'dev']);
const MAX_WINDOW_S = 86400; // 24h

type RollupRow = {
  service: string;
  environment: string;
  cost_usd: string | number;
  units: string | number;
  row_count: string | number;
};

export async function GET(req: NextRequest) {
  try {
    await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) {
      const { status, body } = mapAuthGuardStatus(e.status);
      return json(status, body);
    }
    throw e;
  }

  const url = new URL(req.url);
  const windowRaw = Number(url.searchParams.get('window_s') ?? '3600');
  const windowS = Number.isFinite(windowRaw) && windowRaw > 0
    ? Math.min(Math.floor(windowRaw), MAX_WINDOW_S)
    : 3600;
  const envParam = url.searchParams.get('environment');
  const envFilter = envParam && ALLOWED_ENVS.has(envParam) ? envParam : null;

  const rangeEnd = new Date();
  const rangeStart = new Date(rangeEnd.getTime() - windowS * 1000);

  const sb = supabaseAdmin();
  let q = sb
    .from('cogs_log_admin_rollup')
    .select('service, environment, cost_usd, units, row_count')
    .gte('bucket_ts', rangeStart.toISOString());
  if (envFilter) q = q.eq('environment', envFilter);

  const { data, error } = await q;
  if (error) return json(500, { error: 'rollup_query_failed', detail: error.message.slice(0, 200) });

  const rows = (data ?? []) as RollupRow[];

  // Aggregate by service+environment.
  const byKey = new Map<string, { service: string; environment: string; cost_usd: number; units: number; row_count: number }>();
  let totalUsd = 0;

  for (const r of rows) {
    const cost = Number(r.cost_usd) || 0;
    const units = Number(r.units) || 0;
    const count = Number(r.row_count) || 0;
    totalUsd += cost;

    const k = `${r.service}|${r.environment}`;
    const existing = byKey.get(k);
    if (existing) {
      existing.cost_usd += cost;
      existing.units += units;
      existing.row_count += count;
    } else {
      byKey.set(k, { service: r.service, environment: r.environment, cost_usd: cost, units, row_count: count });
    }
  }

  return json(200, {
    window_s: windowS,
    range_start: rangeStart.toISOString(),
    range_end: rangeEnd.toISOString(),
    total_usd: Number(totalUsd.toFixed(6)),
    by_service: Array.from(byKey.values()).sort((a, b) => b.cost_usd - a.cost_usd),
  });
}
