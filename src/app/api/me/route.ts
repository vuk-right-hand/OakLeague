import 'server-only';
import { NextResponse } from 'next/server';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(status: number, body: unknown) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function GET() {
  const userId = await getCallerUserId();
  if (!userId) return json(401, { error: 'unauthorized' });

  // Fail loudly if the profile row is missing — cogs_log FKs to profiles(id) and will 500 silently otherwise.
  const { data } = await supabaseAdmin().from('profiles').select('id').eq('id', userId).single();
  if (!data) return json(403, { error: 'profile_missing' });

  return json(200, { userId });
}
