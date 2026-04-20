// R5-M5: fail closed at import time. Empty CRON_SECRET against Authorization:
// Bearer '' would otherwise succeed — classic auth bypass.

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';

// Fail-closed: throw at first request if env is missing. We can't throw at
// module top because Next's build-phase data collection imports the module
// before env vars are materialized in some hosting setups. The guard still
// runs before any comparison happens, so empty-CRON_SECRET-against-empty-
// Bearer-string bypass is impossible.
function getCronSecret(): string {
  const s = process.env.CRON_SECRET;
  if (!s || s.length < 32) {
    throw new Error('CRON_SECRET missing or too short (>= 32 chars required)');
  }
  return s;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret();
  const header = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  if (!constantTimeEqual(header, expected)) {
    return new NextResponse('unauthorized', { status: 401 });
  }

  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc('cleanup_expired_verifications');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: data ?? 0 });
}
