import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { getClientIp } from '@/lib/ip';
import { readAnonId } from '@/lib/feed/anon-id';
import {
  feedEventsRequestSchema,
  type FeedEventsResponse,
} from '@/types/feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = feedEventsRequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const admin = supabaseAdmin();
  const ip = getClientIp(req);

  // 600 events/min/IP. Each event is one batch entry, but a batch counts as
  // one rate-limit hit — so a steady scroller emitting 4–5 events per hook
  // can comfortably page through 100+ hooks in a minute.
  const { data: allowed, error: rlErr } = await admin.rpc('rate_limit_hit', {
    p_scope: 'feed_events',
    p_key: ip,
    p_window: '1 minute',
    p_limit: 600,
  });
  if (rlErr) {
    return NextResponse.json({ error: 'rate_limit_failed' }, { status: 500 });
  }
  if (allowed === false) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();

  if (user) {
    const { data, error } = await sb.rpc('ingest_feed_events', {
      p_events: parsed.data.events,
    });
    if (error) {
      // 28000 = unauthenticated (race: cookie expired between getUser and rpc).
      // 22023 = malformed batch / oversized — caller should fix the payload.
      // 54000 = program_limit_exceeded — in-RPC per-user rate limit tripped
      //         (see migration 0503-09 H1 guard). Map to 429 so Sentry isn't
      //         polluted and clients back off instead of retrying the same
      //         batch immediately.
      const code = (error as { code?: string }).code;
      if (code === '28000') {
        return NextResponse.json({ error: 'auth_required' }, { status: 401 });
      }
      if (code === '22023') {
        return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
      }
      if (code === '54000') {
        return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
      }
      console.error('[feed/events] ingest_feed_events failed', error);
      return NextResponse.json({ error: 'ingest_failed' }, { status: 500 });
    }
    return NextResponse.json(toResponse(data));
  }

  // Anon path: cookie-bound. ONLY read — never mint here (audit P2-F).
  // sendBeacon-flushed batches at pagehide can't carry Set-Cookie back
  // (browsers ignore Set-Cookie response headers on beacon responses),
  // so a mint on this path produces an orphan anon_feed_sessions row
  // and the next visit re-mints, fragmenting attribution. The cookie
  // is always minted on the GET /api/feed read path, which IS allowed
  // to set cookies. If we see a beacon event before any GET has
  // landed (very rare race: open + immediate close), we silently drop.
  const anonId = await readAnonId();
  if (!anonId) {
    return NextResponse.json({ inserted: 0, deduped: 0, dead_zoned: 0 });
  }

  const { data, error } = await admin.rpc('ingest_feed_events_anon', {
    p_anon_id: anonId,
    p_events: parsed.data.events,
  });
  if (error) {
    // Same taxonomy as the auth branch; 54000 will surface once migration
    // 0503-15 (H1) adds the per-anon_id rate limit inside the RPC.
    const code = (error as { code?: string }).code;
    if (code === '28000') {
      return NextResponse.json(
        { error: 'anon_session_not_found' },
        { status: 401 },
      );
    }
    if (code === '22023') {
      return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
    }
    if (code === '54000') {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
    console.error('[feed/events] ingest_feed_events_anon failed', error);
    return NextResponse.json({ error: 'ingest_failed' }, { status: 500 });
  }

  return NextResponse.json(toResponse(data));
}

// The RPC returns a single-row table; supabase-js delivers it as a one-element
// array. Normalize to the FeedEventsResponse shape.
function toResponse(data: unknown): FeedEventsResponse {
  const row = Array.isArray(data) ? data[0] : data;
  const r = (row ?? {}) as Partial<FeedEventsResponse>;
  return {
    inserted: Number(r.inserted ?? 0),
    deduped: Number(r.deduped ?? 0),
    dead_zoned: Number(r.dead_zoned ?? 0),
  };
}
