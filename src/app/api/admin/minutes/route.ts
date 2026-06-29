// GET /api/admin/minutes — Growth & Minutes Economy Phase 7 reconcile viewer.
//
// Admin-guarded. Read-only. Returns the shaped ReconcileReport (see
// src/lib/minutes/reconcile.ts): range-bounded flows (granted / consumed /
// billed voice COGS) + point-in-time wallet stocks + invariant violation
// counts + the offending users.
//
// Query params (all optional):
//   since  — ISO; default now()-30d. Bounds the FLOW figures only (stocks +
//            violations are always point-in-time). Window clamped to ≤366d.
//   until  — ISO; default now().
//   limit  — offender rows, 1..1000, default 100.
// Welcome-gap floor comes from env MINUTES_WELCOME_GAP_FLOOR (unset ⇒ 0 gaps).

import 'server-only';
import { type NextRequest } from 'next/server';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { json, mapAuthGuardStatus } from '@/lib/session/http-helpers';
import { loadReconcile } from '@/lib/minutes/reconcile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

function isoOrNull(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function GET(req: NextRequest) {
  try {
    await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) {
      const { status, body } = mapAuthGuardStatus(e.status);
      return json(status, body);
    }
    throw e;
  }

  const url = new URL(req.url);
  const now = new Date();
  const sinceRaw = url.searchParams.get('since');
  const untilRaw = url.searchParams.get('until');
  const untilParsed = isoOrNull(untilRaw);
  const sinceParsed = isoOrNull(sinceRaw);
  // M4: distinguish "absent" (→ default window) from "present but unparseable"
  // (→ 400). Silently widening to the 30d default on a typo'd date would hand an
  // operator a window they didn't ask for on a money-reconciliation tool.
  if (sinceRaw && !sinceParsed) return json(400, { error: 'bad_param', detail: 'since' });
  if (untilRaw && !untilParsed) return json(400, { error: 'bad_param', detail: 'until' });
  const until = untilParsed ? new Date(untilParsed) : now;
  let since = sinceParsed ? new Date(sinceParsed) : new Date(until.getTime() - DEFAULT_WINDOW_MS);
  // Clamp the flow window so the granted/consumed/cogs scans stay bounded.
  const oldestAllowed = new Date(until.getTime() - MAX_WINDOW_MS);
  if (since < oldestAllowed) since = oldestAllowed;
  if (since > until) return json(400, { error: 'bad_range' });

  const limitRaw = Number(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const welcomeFloor = isoOrNull(process.env.MINUTES_WELCOME_GAP_FLOOR);

  try {
    const report = await loadReconcile(supabaseAdmin(), {
      since: since.toISOString(),
      until: until.toISOString(),
      welcomeFloor,
      violationLimit: limit,
    });
    return json(200, report);
  } catch (e) {
    return json(500, { error: 'reconcile_failed', detail: (e as Error).message.slice(0, 200) });
  }
}
