import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { getClientIp } from '@/lib/ip';
import { readOrMintAnonId } from '@/lib/feed/anon-id';
import { feedHookSchema, type FeedHook, type FeedPageResponse } from '@/types/feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_EXCLUDE_IDS = 50;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const feedPageResultSchema = z.array(feedHookSchema);

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);

  const limitRaw = url.searchParams.get('limit');
  const limit = clampLimit(limitRaw);

  const cursorRaw = url.searchParams.get('cursor_epoch');
  const cursorEpoch = parseCursorEpoch(cursorRaw);

  // p_exclude_hook_ids carries the hooks already shown this session so the
  // ranker doesn't redundantly re-serve them. Capped at 50 (URL + RPC bound).
  const excludeRaw = url.searchParams.get('exclude');
  const excludeHookIds = parseExcludeIds(excludeRaw);

  const admin = supabaseAdmin();

  // Per-IP rate limit shared across auth + anon. The auth path also pays
  // implicit per-user rate-limit cost via Supabase, but IP is what protects
  // the anon endpoint from cheap fanout.
  const ip = getClientIp(req);
  const { data: allowed, error: rlErr } = await admin.rpc('rate_limit_hit', {
    p_scope: 'feed_api',
    p_key: ip,
    p_window: '1 minute',
    p_limit: 120,
  });
  if (rlErr) {
    return NextResponse.json({ error: 'rate_limit_failed' }, { status: 500 });
  }
  if (allowed === false) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  // M2: probe with limit+1 so has_more is exact. If the RPC returns
  // exactly (limit+1) rows, drop the tail row and report has_more=true;
  // anything shorter is the true final page. The RPC's own clamp tops
  // out at 50 — so when caller asks for 50, we can't probe for a 51st.
  // In that case fall back to the "full page" heuristic.
  const probeLimit = Math.min(limit + 1, MAX_LIMIT);
  const canProbe = probeLimit > limit;

  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();

  let rawRows: unknown;
  if (user) {
    const { data, error } = await sb.rpc('feed_ranked_page', {
      p_limit: probeLimit,
      p_cursor_epoch: cursorEpoch,
      p_exclude_hook_ids: excludeHookIds,
    });
    if (error) {
      console.error('[feed] feed_ranked_page failed', error);
      return NextResponse.json({ error: 'feed_fetch_failed' }, { status: 500 });
    }
    rawRows = data ?? [];
  } else {
    let anonId: string;
    try {
      anonId = await readOrMintAnonId();
    } catch (e) {
      console.error('[feed] anon_id mint failed', e);
      return NextResponse.json({ error: 'anon_init_failed' }, { status: 500 });
    }
    const { data, error } = await admin.rpc('feed_ranked_anon_page', {
      p_anon_id: anonId,
      p_limit: probeLimit,
      p_cursor_epoch: cursorEpoch,
      p_exclude_hook_ids: excludeHookIds,
    });
    if (error) {
      console.error('[feed] feed_ranked_anon_page failed', error);
      return NextResponse.json({ error: 'feed_fetch_failed' }, { status: 500 });
    }
    rawRows = data ?? [];
  }

  // S2: boundary validation. A silent column rename at the RPC fails here
  // instead of shipping undefined fields to the client.
  const parsed = feedPageResultSchema.safeParse(rawRows);
  if (!parsed.success) {
    console.error('[feed] ranked page payload shape mismatch', parsed.error.issues);
    return NextResponse.json({ error: 'feed_schema_mismatch' }, { status: 500 });
  }

  const allRows = parsed.data;
  let items: FeedHook[];
  let hasMore: boolean;
  if (canProbe) {
    hasMore = allRows.length > limit;
    items = hasMore ? allRows.slice(0, limit) : allRows;
  } else {
    // limit == MAX_LIMIT: we couldn't probe past the RPC's clamp. Fall back
    // to "full page → assume more" — the client will discover the empty
    // trailing page and stop. One wasted round-trip per 50-at-a-time pager.
    items = allRows;
    hasMore = allRows.length === limit;
  }

  // cursor_epoch is identical for every row in a page — it's not a
  // "next item" cursor. The SQL function (feed_ranked_page migration
  // 0503-16) sets v_cursor_epoch once at call time and returns it on
  // every row to seed deterministic explore-slot positioning across
  // load-more calls (audit P2-D). Pagination advances via
  // p_exclude_hook_ids, not via the cursor. items[0] / items[N-1]
  // both yield the same value; covered by pgTAP test
  // algo_feed_ranked_page_cursor_epoch_stable.test.sql.
  const cursorOut = items.length > 0 ? items[0].cursor_epoch : cursorEpoch;
  const body: FeedPageResponse = {
    items,
    cursor_epoch: cursorOut,
    has_more: hasMore,
  };

  return NextResponse.json(body);
}

function clampLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

function parseCursorEpoch(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

// S1: dedupe before the cap so a caller passing `?exclude=A,A,A,...` can't
// burn the 50-slot budget on one hook and defeat the exclusion window.
function parseExcludeIds(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim().toLowerCase();
    if (UUID_RE.test(trimmed)) seen.add(trimmed);
    if (seen.size >= MAX_EXCLUDE_IDS) break;
  }
  return Array.from(seen);
}
