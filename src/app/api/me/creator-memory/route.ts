// /api/me/creator-memory — MEMORY_BREADTH_PLAN Unit 1b privacy surface.
//
// GET    → list the caller's memory rows (creator_id, sessions_count,
//          last_session_at) so the profile sheet can render "He remembers
//          you" entries. RLS-scoped: the caller's own client sees only
//          their rows (user_creator_memory_select_own).
// DELETE → "Forget our conversations" for ONE creator (?creator_id=) or
//          ALL of the caller's rows (no param). Deletes via the caller's
//          OWN RLS-scoped client (user_creator_memory_delete_own) — NOT
//          service role, so the policy is the enforcement, not our code.

import 'server-only';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';
import { isSameOrigin, json } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireCaller(): Promise<{ userId: string } | { errResponse: ReturnType<typeof json> }> {
  const userId = await getCallerUserId(); // null = unauthenticated
  if (!userId) return { errResponse: json(401, { error: 'unauthorized' }) };
  return { userId };
}

export async function GET(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });
  const caller = await requireCaller();
  if ('errResponse' in caller) return caller.errResponse;
  Sentry.setUser({ id: caller.userId });

  const sb = await supabaseServer();
  const { data, error } = await sb
    .from('user_creator_memory')
    .select('creator_id, sessions_count, last_session_at')
    .order('last_session_at', { ascending: false });
  if (error) {
    Sentry.captureException(error, { extra: { op: 'creator_memory_list' } });
    return json(500, { error: 'list_failed' });
  }
  return json(200, { ok: true, memories: data ?? [] });
}

export async function DELETE(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });
  const caller = await requireCaller();
  if ('errResponse' in caller) return caller.errResponse;
  Sentry.setUser({ id: caller.userId });

  const creatorIdRaw = req.nextUrl.searchParams.get('creator_id');
  if (creatorIdRaw !== null && !UUID_RE.test(creatorIdRaw)) {
    return json(400, { error: 'bad_creator_id' });
  }

  // The caller's RLS-scoped client: the delete-own policy is the boundary.
  const sb = await supabaseServer();
  let q = sb.from('user_creator_memory').delete({ count: 'exact' });
  if (creatorIdRaw) q = q.eq('creator_id', creatorIdRaw);
  // RLS scopes rows to auth.uid(); the explicit eq is belt-and-braces and
  // keeps the count meaningful if the policy ever widens.
  const { error, count } = await q.eq('user_id', caller.userId);
  if (error) {
    Sentry.captureException(error, {
      extra: { op: 'creator_memory_delete', creator_id: creatorIdRaw },
    });
    return json(500, { error: 'delete_failed' });
  }
  return json(200, { ok: true, deleted: count ?? 0 });
}
