// POST /api/me/watch — records a real watch into watch_history (U4/C2).
//
// Called fire-and-forget by the long-form player at the first quartile. The
// record_watch RPC re-gates on published video + published creator and is
// rate-limited; for anon callers we no-op (200) so the player never errors.
//
// NOTE (audit M-D1): watch_history is SELF-ATTESTED — record_watch gates on
// published status, not on proof the caller actually watched. It is fine as a
// private "your history" list. Do NOT treat it as a trusted "really watched"
// signal for ranking/personalization without corroborating a server-side
// feed_events quartile row for the same (user, video).

import 'server-only';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';
import { isSameOrigin } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ok() {
  return new NextResponse(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function POST(req: NextRequest) {
  // Best-effort beacon, not a security boundary: a cross-origin caller gets a
  // silent 200 (record_watch still gates server-side). Intentional (M-D1/Small).
  if (!isSameOrigin(req)) return ok();
  const userId = await getCallerUserId();
  if (!userId) return ok(); // anon watching is fine — just no history

  let body: { video_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return ok();
  }
  const videoId = typeof body.video_id === 'string' ? body.video_id : '';
  if (!UUID_RE.test(videoId)) return ok();

  const supabase = await supabaseServer();
  // record_watch enforces published gate + rate limit; ignore its errors here.
  await supabase.rpc('record_watch', { p_video_id: videoId });
  return ok();
}
