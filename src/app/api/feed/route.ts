import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { getClientIp } from '@/lib/ip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const cursorCreatedAt = url.searchParams.get('cursor_created_at');
  const cursorId = url.searchParams.get('cursor_id');
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw
    ? Math.min(Math.max(parseInt(limitRaw, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  // Service role only for rate_limit_hit (it INSERTs into rate_limit_log).
  // feed_page runs on a cookie-bound client so RLS applies — never admin.
  // (Audit C1: service-role bypassed RLS and leaked drafts.)
  const admin = supabaseAdmin();
  const sb = await supabaseServer();

  // 120 hits/min/IP. See DAYS_6_7_FEED_PLAN §5 R4-M4 for rationale.
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

  const { data, error } = await sb.rpc('feed_page', {
    p_cursor_created_at: cursorCreatedAt,
    p_cursor_id: cursorId,
    p_limit: limit,
  });

  if (error) {
    console.error('[feed] feed_page failed', error);
    return NextResponse.json({ error: 'feed_fetch_failed' }, { status: 500 });
  }

  return NextResponse.json({
    items: data ?? [],
    nextCursor: data && data.length === limit
      ? {
          cursor_created_at: data[data.length - 1].hook_created_at,
          cursor_id: data[data.length - 1].hook_id,
        }
      : null,
  });
}
