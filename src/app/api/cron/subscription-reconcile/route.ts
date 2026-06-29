// GET /api/cron/subscription-reconcile — Phase 6 lapse safety net + event GC.
//
// Daily cron (CRON_SECRET-guarded, mirrors cleanup-verifications). Flips any paid
// user whose stored billing period ended AND whose sub is not active → free
// (covers a missed customer.subscription.deleted), and prunes stripe_events > 30d.
// Fail-closed on a missing/short CRON_SECRET (empty-secret-vs-empty-Bearer bypass).

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  if (!constantTimeEqual(header, `Bearer ${secret}`)) {
    return new NextResponse('unauthorized', { status: 401 });
  }

  const sb = supabaseAdmin();
  const { data: lapsed, error: e1 } = await sb.rpc('stripe_subscription_reconcile');
  if (e1) {
    Sentry.captureException(e1, { extra: { op: 'stripe_subscription_reconcile' } });
    return NextResponse.json({ error: 'reconcile_failed' }, { status: 500 });
  }
  const { data: purged, error: e2 } = await sb.rpc('stripe_events_purge', { p_older_than_days: 30 });
  if (e2) {
    Sentry.captureException(e2, { extra: { op: 'stripe_events_purge' } });
    return NextResponse.json({ error: 'purge_failed' }, { status: 500 });
  }

  return NextResponse.json({ lapsed: lapsed ?? 0, purged: purged ?? 0 });
}
