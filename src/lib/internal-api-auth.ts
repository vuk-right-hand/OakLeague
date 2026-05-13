// internal-api-auth.ts — shared bearer auth for /api/internal/* routes.
//
// Three routes (contextual-gen, preprocess, narrative-chunk) all share the
// same INTERNAL_API_SECRET bearer pattern. Centralized so the auth surface
// is one file to audit, not three.
//
// Used by:
//   * /api/internal/contextual-gen  (Day 4)
//   * /api/internal/preprocess      (Day 5)
//   * /api/internal/narrative-chunk (Day 5)
//
// Contract:
//   `checkInternalAuth(req)` returns null on success, or a NextResponse
//   with the appropriate status (401 unauthorized / 500 misconfigured)
//   ready to return from the handler.
//
// FAIL-CLOSED on missing env. R5-M5: empty secret against empty bearer
// must not pass (length check bails first, then constant-time equality).

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';

function getInternalSecret(): string {
  const s = process.env.INTERNAL_API_SECRET;
  if (!s || s.length < 32) {
    throw new Error('INTERNAL_API_SECRET missing or too short (>= 32 chars required)');
  }
  return s;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Returns null on auth success, or a NextResponse to return from the route
 * handler. Caller supplies `requestId` for response/log correlation.
 */
export function checkInternalAuth(
  req: NextRequest,
  requestId: string,
  stageTag: string,
): NextResponse | null {
  let secret: string;
  try {
    secret = getInternalSecret();
  } catch (e) {
    console.error(`[${stageTag}]`, requestId, 'INTERNAL_API_SECRET misconfigured:', (e as Error).message);
    Sentry.captureException(e, {
      level: 'fatal',
      tags: { request_id: requestId, stage: 'auth_env', route: stageTag },
    });
    return NextResponse.json(
      { error: 'misconfigured', retryable: false, request_id: requestId },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }

  const header = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  if (!constantTimeEqual(header, expected)) {
    return NextResponse.json(
      { error: 'unauthorized', retryable: false, request_id: requestId },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );
  }
  return null;
}
