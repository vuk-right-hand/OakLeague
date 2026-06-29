import { NextResponse } from 'next/server';
import { getCallerUserId } from '@/lib/auth-guards';
import { getBalance } from '@/lib/minutes/balance';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Growth & Minutes Economy Phase 3 — the always-on minutes meter reads this.
// Flag-gated (GROWTH_METER_ENABLED) so the meter can be dark-launched independently
// of the ledger/soft-gate flags; when off we skip auth + the RPC and return a cheap
// {enabled:false} so the client hides the pill. Read-only; getBalance runs as
// service-role for the AUTHENTICATED caller's OWN id only — voice_balance_check is
// not exposed to `authenticated` (no caller-supplied-id balance oracle, R1-S3). The
// response is a WHITELIST of the four fields the meter renders, never the full row.
export async function GET() {
  const noStore = { 'Cache-Control': 'no-store' } as const;

  if (process.env.GROWTH_METER_ENABLED !== '1') {
    return NextResponse.json({ enabled: false }, { headers: noStore });
  }

  const userId = await getCallerUserId();
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  }

  const balance = await getBalance(userId);
  // null = brand-new user (profile row not materialised yet, getBalance swallows
  // P0002) OR a transient RPC failure (already Sentry'd in getBalance). The meter
  // hides on null; we NEVER 500 — a failed meter read must not put an error on the
  // feed chrome.
  return NextResponse.json(
    {
      enabled: true,
      balance: balance
        ? {
            remaining_seconds: balance.effectiveRemaining,
            wallet_remaining: balance.walletRemaining,
            cap_period: balance.capPeriod,
            supporter_active: balance.supporterActive,
          }
        : null,
    },
    { headers: noStore },
  );
}
