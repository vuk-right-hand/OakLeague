// GET /api/admin/cogs/historical — paginated cogs_log + per-operation summary.
//
// Query params (all optional):
//   since        — ISO timestamp, default now() - 24h, max-reach = 7d ago
//   until        — ISO timestamp, default now()
//   service      — one of cogs_service enum (gemini, cartesia, simli, mux, ...)
//   operation    — exact operation string
//   user_id      — uuid
//   cursor       — ISO timestamp for page-2 (use row.created_at of last row)
//   limit        — 1..100, default 50
//
// Response: { range_start, range_end, by_operation: [...], rows: [...],
//             next_cursor: string | null, summary_truncated: boolean }
//
// Summary aggregation is done server-side over rows matching the filter,
// capped at 10_000 rows for safety. If the cap is hit we flag
// `summary_truncated: true` so the UI can warn. At rc1 scale this cap is
// effectively unbounded; the real fix for scale is a small SUM-RPC or MV,
// tracked as a follow-up (Days 13-14 handoff §5 / handoff-Q1).

import 'server-only';
import { type NextRequest } from 'next/server';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { json, mapAuthGuardStatus } from '@/lib/session/http-helpers';
import { ALLOWED_COGS_SERVICES_SET, ALLOWED_COGS_OPERATIONS_SET } from '@/lib/admin/cogs-operations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SUMMARY_ROWS = 10_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type CogsRow = {
  id: string;
  created_at: string;
  user_id: string | null;
  session_id: string | null;
  service: string;
  operation: string;
  units: string | number;
  unit_label: string;
  cost_usd: string | number;
  environment: string;
};
type SummaryRow = { service: string; operation: string; units: string | number; cost_usd: string | number };

function isoOrNull(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

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
  const now = new Date();

  const untilParsed = isoOrNull(url.searchParams.get('until'));
  const sinceParsed = isoOrNull(url.searchParams.get('since'));
  const until = untilParsed ? new Date(untilParsed) : now;
  const defaultSince = new Date(until.getTime() - 24 * 60 * 60 * 1000);
  let since = sinceParsed ? new Date(sinceParsed) : defaultSince;
  // Clamp since so the window never exceeds 7 days (Postgres-side cost guard).
  const oldestAllowed = new Date(until.getTime() - SEVEN_DAYS_MS);
  if (since < oldestAllowed) since = oldestAllowed;
  if (since > until) return json(400, { error: 'bad_range' });

  const serviceParam = url.searchParams.get('service');
  const service = serviceParam && ALLOWED_COGS_SERVICES_SET.has(serviceParam) ? serviceParam : null;

  const operationParam = url.searchParams.get('operation');
  const operation = operationParam && ALLOWED_COGS_OPERATIONS_SET.has(operationParam) ? operationParam : null;

  const userIdParam = url.searchParams.get('user_id');
  const userId = userIdParam && UUID_RE.test(userIdParam) ? userIdParam : null;

  // Compound keyset cursor: "ISO|UUID". Ties on created_at are common (a single
  // session turn writes the 4 Pipeline α' legs in one transaction, sharing
  // now()), so a timestamp-only cursor would skip siblings at the page
  // boundary. Accept legacy ISO-only for in-flight page-2 requests.
  const cursorRaw = url.searchParams.get('cursor');
  let cursorTs: string | null = null;
  let cursorId: string | null = null;
  if (cursorRaw) {
    const pipeIdx = cursorRaw.indexOf('|');
    if (pipeIdx >= 0) {
      cursorTs = isoOrNull(cursorRaw.slice(0, pipeIdx));
      const idPart = cursorRaw.slice(pipeIdx + 1);
      if (cursorTs && UUID_RE.test(idPart)) cursorId = idPart;
    } else {
      cursorTs = isoOrNull(cursorRaw);
    }
  }

  const limitRaw = Number(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const sb = supabaseAdmin();
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();

  // Summary query: capped at MAX_SUMMARY_ROWS. UI gets summary_truncated:true
  // when we hit the cap. At rc1 scale this is effectively unbounded.
  let summaryQ = sb
    .from('cogs_log')
    .select('service, operation, units, cost_usd')
    .gte('created_at', sinceIso)
    .lt('created_at', untilIso)
    .order('created_at', { ascending: false })
    .limit(MAX_SUMMARY_ROWS);
  if (service) summaryQ = summaryQ.eq('service', service);
  if (operation) summaryQ = summaryQ.eq('operation', operation);
  if (userId) summaryQ = summaryQ.eq('user_id', userId);

  // Rows query: compound keyset on (created_at, id) DESC. Fetch limit+1 so we
  // know if there's a next page without a COUNT.
  let rowsQ = sb
    .from('cogs_log')
    .select('id, created_at, user_id, session_id, service, operation, units, unit_label, cost_usd, environment')
    .gte('created_at', sinceIso)
    .lt('created_at', untilIso)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  if (service) rowsQ = rowsQ.eq('service', service);
  if (operation) rowsQ = rowsQ.eq('operation', operation);
  if (userId) rowsQ = rowsQ.eq('user_id', userId);
  if (cursorTs && cursorId) {
    // (created_at, id) < (cursorTs, cursorId) — PostgREST OR group.
    rowsQ = rowsQ.or(`created_at.lt.${cursorTs},and(created_at.eq.${cursorTs},id.lt.${cursorId})`);
  } else if (cursorTs) {
    // Legacy cursor (timestamp only). Accept for backward compat; may skip
    // ties at the boundary but won't misorder.
    rowsQ = rowsQ.lt('created_at', cursorTs);
  }

  const [{ data: summaryData, error: summaryErr }, { data: rowsData, error: rowsErr }] = await Promise.all([summaryQ, rowsQ]);
  if (summaryErr) return json(500, { error: 'summary_query_failed', detail: summaryErr.message.slice(0, 200) });
  if (rowsErr) return json(500, { error: 'rows_query_failed', detail: rowsErr.message.slice(0, 200) });

  const summaryRows = (summaryData ?? []) as SummaryRow[];
  const summary_truncated = summaryRows.length >= MAX_SUMMARY_ROWS;

  type Agg = { service: string; operation: string; cost_usd: number; units: number; row_count: number };
  const byOp = new Map<string, Agg>();
  let total_usd = 0;
  for (const r of summaryRows) {
    const cost = Number(r.cost_usd) || 0;
    const units = Number(r.units) || 0;
    total_usd += cost;
    const key = `${r.service}|${r.operation}`;
    const cur = byOp.get(key);
    if (cur) {
      cur.cost_usd += cost;
      cur.units += units;
      cur.row_count += 1;
    } else {
      byOp.set(key, { service: r.service, operation: r.operation, cost_usd: cost, units, row_count: 1 });
    }
  }
  const by_operation = Array.from(byOp.values())
    .map((x) => ({ ...x, cost_usd: Number(x.cost_usd.toFixed(6)), units: Number(x.units.toFixed(4)) }))
    .sort((a, b) => b.cost_usd - a.cost_usd);

  const rows = (rowsData ?? []) as CogsRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = hasMore ? page[page.length - 1]! : null;
  const next_cursor = lastRow ? `${lastRow.created_at}|${lastRow.id}` : null;

  return json(200, {
    range_start: since.toISOString(),
    range_end: until.toISOString(),
    total_usd: Number(total_usd.toFixed(6)),
    by_operation,
    rows: page.map((r) => ({ ...r, cost_usd: Number(r.cost_usd), units: Number(r.units) })),
    next_cursor,
    summary_truncated,
  });
}
