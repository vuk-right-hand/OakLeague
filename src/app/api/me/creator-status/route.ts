// GET /api/me/creator-status — drives the bottom-nav middle button + "You" slot.
//
// Six states (PROFILE_SYSTEM_PLAN §3.6 / audit C1 — invite-only is load-bearing;
// CREATOR_JOURNEY WS1/U1 — added 'requested' so a logged-in user who submitted a
// creator request doesn't see "Become a Creator" looping back into the funnel):
//   guest        — logged out
//   not_invited  — no invite_nonce, not a creator, no application, no request
//   requested    — has a PENDING creator_request matching their email
//   invited      — invite_nonce present → may reach /apply
//   in_review    — has a submitted/under_review application
//   creator      — has a creators row → Studio
//
// `handle` is the viewer's public handle (creators.handle ?? profiles.handle),
// or null when not yet claimed (→ "You" routes to claim-handle, never /@null).

import 'server-only';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(body: unknown) {
  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function GET() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ state: 'guest', handle: null });

  const userId = user.id;
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

  let state: 'creator' | 'in_review' | 'invited' | 'requested' | 'not_invited';
  if (creator) {
    state = 'creator';
  } else if (application) {
    state = 'in_review';
  } else {
    const jar = await cookies();
    if (jar.get('invite_nonce')?.value) {
      state = 'invited';
    } else {
      // Has the caller submitted a still-pending creator request? Match on
      // lowercased email (creator_requests is service-role only, so use the
      // admin client). +tag variants are an accepted edge miss.
      let requested = false;
      const email = user.email?.toLowerCase();
      if (email) {
        const admin = supabaseAdmin();
        const { data: reqRow } = await admin
          .from('creator_requests')
          .select('id')
          .eq('email', email)
          .eq('status', 'pending')
          .limit(1)
          .maybeSingle<{ id: string }>();
        requested = !!reqRow;
      }
      state = requested ? 'requested' : 'not_invited';
    }
  }

  return json({ state, handle });
}
