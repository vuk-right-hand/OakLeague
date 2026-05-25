// GET /api/me/creator-status — drives the bottom-nav middle button + "You" slot.
//
// Five states (PROFILE_SYSTEM_PLAN §3.6 / audit C1 — invite-only is load-bearing):
//   guest        — logged out
//   not_invited  — no invite_nonce, not a creator, no application → waitlist CTA
//   invited      — invite_nonce present → may reach /apply
//   in_review    — has a submitted/under_review application
//   creator      — has a creators row → Studio
//
// `handle` is the viewer's public handle (creators.handle ?? profiles.handle),
// or null when not yet claimed (→ "You" routes to claim-handle, never /@null).

import 'server-only';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(body: unknown) {
  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function GET() {
  const userId = await getCallerUserId();
  if (!userId) return json({ state: 'guest', handle: null });

  const supabase = await supabaseServer();
  const [{ data: creator }, { data: profile }, { data: application }] = await Promise.all([
    supabase.from('creators').select('handle').eq('user_id', userId).maybeSingle(),
    supabase.from('profiles').select('handle').eq('id', userId).maybeSingle(),
    supabase
      .from('creator_applications')
      .select('id')
      .eq('user_id', userId)
      .in('status', ['submitted', 'under_review'])
      .maybeSingle(),
  ]);

  const handle = creator?.handle ?? profile?.handle ?? null;

  let state: 'creator' | 'in_review' | 'invited' | 'not_invited';
  if (creator) {
    state = 'creator';
  } else if (application) {
    state = 'in_review';
  } else {
    const jar = await cookies();
    state = jar.get('invite_nonce')?.value ? 'invited' : 'not_invited';
  }

  return json({ state, handle });
}
