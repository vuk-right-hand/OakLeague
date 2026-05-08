// POST /api/admin/brain-recompile — admin escape hatch for forced
// persona recompile.
//
// Calls _creator_brain_compile_unsafe (service-role gated) directly.
// Surface in /admin/creators/[id] gives admins a one-click "Recompile
// brain" button when something looks wrong (creator updated their bio
// but the persona didn't refresh, or a backfill skipped them).
//
// Brain wire-up PR-3 (R3 audit + plan §Phase 5).

import 'server-only';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { isSameOrigin, json, mapAuthGuardStatus } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = { creator_id?: unknown };

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });
  // PR-3 audit C1: require JSON content-type so a CSRF-style form-encoded
  // post doesn't slip through `isSameOrigin` on referrer-less requests.
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('application/json')) {
    return json(415, { error: 'bad_content_type' });
  }

  let admin: { userId: string };
  try {
    admin = await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) {
      const { status, body } = mapAuthGuardStatus(e.status);
      return json(status, body);
    }
    throw e;
  }

  // Sentry v10 isolation scope is per-request in Next.js App Router (Phase
  // C B3.5 pattern), so setUser scopes correctly to this request without
  // explicit withScope wrapping.
  Sentry.setUser({ id: admin.userId });

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json(400, { error: 'bad_json' }); }

  const creatorId = typeof body.creator_id === 'string' && UUID_RE.test(body.creator_id)
    ? body.creator_id : null;
  if (!creatorId) return json(400, { error: 'bad_creator_id' });

  const sb = supabaseAdmin();

  // PR-3 audit M7: warn when admin recompiles an explicitly-errored
  // creator so a recompile doesn't silently un-error a deliberately
  // flagged row.
  const { data: pre } = await sb
    .from('creators')
    .select('brain_status')
    .eq('id', creatorId)
    .maybeSingle<{ brain_status: string }>();
  if (pre?.brain_status === 'errored') {
    Sentry.captureMessage('brain.admin_recompile_errored_creator', {
      level: 'warning',
      extra: { creator_id: creatorId, admin_user_id: admin.userId },
    });
  }

  // Use admin (service-role) so _unsafe is callable directly. Skip the
  // public wrapper because we already gated on admin via assertAdmin.
  const { error } = await sb.rpc('_creator_brain_compile_unsafe', {
    p_creator_id: creatorId,
  });
  if (error) {
    Sentry.captureException(error, {
      extra: { op: 'admin_brain_recompile', creator_id: creatorId, admin_user_id: admin.userId },
    });
    if (error.code === '42704') return json(404, { error: 'creator_not_found' });
    return json(500, { error: 'recompile_failed' });
  }

  // Echo back the freshly-compiled timestamp so the admin UI can show
  // "Recompiled at HH:MM" without a separate fetch.
  // PR-3 audit M1: do NOT echo system_prompt_length — admin already has
  // it via the page-level SELECT and exposing here turns the route into
  // a probing oracle if assertAdmin scope ever loosens.
  const { data: row } = await sb
    .from('creators')
    .select('brain_compiled_at')
    .eq('id', creatorId)
    .maybeSingle<{ brain_compiled_at: string | null }>();

  return json(200, {
    ok: true,
    creator_id: creatorId,
    brain_compiled_at: row?.brain_compiled_at ?? null,
  });
}
