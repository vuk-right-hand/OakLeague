import { NextResponse } from 'next/server';
import { getCreatorForCaller } from '@/lib/creator/get-creator';
import { AuthGuardError } from '@/lib/auth-guards';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const { creator } = await getCreatorForCaller();
    return NextResponse.json(
      { brain_status: creator.brain_status },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    if (e instanceof AuthGuardError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}
