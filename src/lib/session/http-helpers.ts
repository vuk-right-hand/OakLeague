// Shared helpers for /api/sessions/* routes. All routes share:
//   1. Same-origin check honoring x-forwarded-host (ngrok/reverse-proxy safe;
//      see .claude_learnings.md 2026-04-21 "ngrok HTTPS → Next dev HTTP").
//   2. A typed error envelope that maps Postgres custom errcodes (P0001..P0006)
//      to HTTP status + stable error codes the client can branch on.
//
// Keep this file tight: route handlers call these, do their own auth guard,
// then hand off to the RPC. No business logic here.

import { NextResponse, type NextRequest } from 'next/server';

export function json(status: number, body: unknown): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

export function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    const originHost = new URL(origin).host;
    const forwardedHost = req.headers.get('x-forwarded-host');
    const reqHost = forwardedHost ?? req.nextUrl.host;
    return originHost === reqHost;
  } catch {
    return false;
  }
}

// Postgres errors come through PostgREST / postgres-js with an errcode on
// `.code`. We only map the 5-digit SQLSTATEs we raise ourselves — everything
// else bubbles as 500 so production surfaces the genuine bug.
type PgError = { code?: string; message?: string };

const ERRCODE_TO_ENVELOPE: Record<string, { status: number; error: string }> = {
  // P0001 is overloaded in voice_* RPCs ("kill_switch_fired") AND could be
  // raised by generic plpgsql; we match on message for kill_switch specifically.
  P0003: { status: 409, error: 'downgrade_blocked_until_tomorrow' },
  P0004: { status: 409, error: 'has_active_session' },
  P0005: { status: 409, error: 'already_active' },
  P0006: { status: 410, error: 'not_found_or_dead' },
  '42501': { status: 403, error: 'forbidden' },
  '23505': { status: 409, error: 'conflict' },
  '22003': { status: 400, error: 'out_of_range' },
  '22023': { status: 400, error: 'invalid_argument' },
};

/**
 * Envelope for AuthGuardError. Keeps 401 (unauthenticated) and 403 (forbidden)
 * distinguishable at the wire so clients route the user to login vs. "ask an
 * admin" instead of treating both as the same state (R5-S5).
 */
export function mapAuthGuardStatus(status: number): { status: number; body: { error: string } } {
  if (status === 401) return { status: 401, body: { error: 'unauthenticated' } };
  if (status === 403) return { status: 403, body: { error: 'forbidden' } };
  return { status, body: { error: 'auth_guard_failed' } };
}

export function mapPgError(e: unknown): { status: number; body: { error: string; detail?: string } } {
  const err = e as PgError;
  const code = err?.code ?? '';
  const msg = err?.message ?? '';

  if (code === 'P0001' && /kill_switch_fired/i.test(msg)) {
    return { status: 429, body: { error: 'kill_switch_fired' } };
  }
  // 22003 is raised by admin_set_user_voice_caps with one of three distinct
  // messages — surface the per-field code so the UI can attach the error to
  // the right input instead of a generic "out of range" banner.
  if (code === '22003') {
    if (/bad_daily_cap/i.test(msg)) return { status: 400, body: { error: 'bad_daily_cap' } };
    if (/bad_weekly_cap/i.test(msg)) return { status: 400, body: { error: 'bad_weekly_cap' } };
    if (/bad_monthly_cap/i.test(msg)) return { status: 400, body: { error: 'bad_monthly_cap' } };
  }
  const mapped = ERRCODE_TO_ENVELOPE[code];
  if (mapped) return { status: mapped.status, body: { error: mapped.error } };

  return { status: 500, body: { error: 'internal', detail: msg.slice(0, 200) } };
}
