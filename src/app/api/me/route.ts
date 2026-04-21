import 'server-only';
import { NextResponse } from 'next/server';
import { getCallerUserId } from '@/lib/auth-guards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const userId = await getCallerUserId();
  if (!userId) {
    return new NextResponse(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  return new NextResponse(JSON.stringify({ userId }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
