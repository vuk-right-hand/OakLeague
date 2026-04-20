import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { supabaseServer } from '@/lib/supabase/server';

function getAdminSecret(): string {
  const s = process.env.ADMIN_SECRET;
  if (!s || s.length < 32) {
    throw new Error('ADMIN_SECRET missing or too short (>= 32 chars required)');
  }
  return s;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function POST(req: NextRequest) {
  const secret = getAdminSecret();
  const header = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  if (!constantTimeEqual(header, expected)) {
    return new NextResponse('unauthorized', { status: 401 });
  }

  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: 'no_session' }, { status: 401 });
  }

  const { data, error } = await supabase.rpc('promote_founder_if_first');
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ result: data });
}
