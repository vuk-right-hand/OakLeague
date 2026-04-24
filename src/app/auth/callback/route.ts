import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import * as Sentry from '@sentry/nextjs';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ANON_ID_COOKIE, readAnonId } from '@/lib/feed/anon-id';

function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

function publicUrl(req: NextRequest, path: string): URL {
  const forwardedHost = req.headers.get('x-forwarded-host');
  const forwardedProto = req.headers.get('x-forwarded-proto');
  if (forwardedHost) {
    return new URL(path, `${forwardedProto ?? 'https'}://${forwardedHost}`);
  }
  return new URL(path, req.url);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const claim = url.searchParams.get('claim');
  const next = safeNext(url.searchParams.get('next'));

  if (error) return NextResponse.redirect(publicUrl(req, `/login?error=${error}`));
  if (!code) return NextResponse.redirect(publicUrl(req, '/login?error=no_code'));

  const supabase = await supabaseServer();
  try {
    const { error: exErr } = await supabase.auth.exchangeCodeForSession(code);
    if (exErr) return NextResponse.redirect(publicUrl(req, '/login?error=exchange_failed'));
  } catch {
    return NextResponse.redirect(publicUrl(req, '/login?error=exchange_failed'));
  }

  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return NextResponse.redirect(publicUrl(req, '/login?error=no_user'));

  // Merge pre-signup anon affinity into the authenticated user's rollup.
  // merge_anon_feed_state is idempotent and DELETEs the anon_feed_sessions
  // row on success — we clear the cookie regardless of outcome so a stale
  // anon_id doesn't linger past the first sign-in. Failure here is logged
  // but non-fatal: losing the anon signal is a worse UX than blocking auth.
  //
  // N3: report to Sentry on failure. At launch a spike here means every
  // new sign-up is losing their anon affinity — we want that paging, not
  // buried in Vercel logs.
  const anonId = await readAnonId();
  if (anonId) {
    const admin = supabaseAdmin();
    try {
      const { error: mergeErr } = await admin.rpc('merge_anon_feed_state', {
        p_anon_id: anonId,
        p_user_id: user.id,
      });
      if (mergeErr) {
        Sentry.captureException(mergeErr, {
          extra: {
            op: 'auth_callback_merge_anon_feed_state',
            user_id: user.id,
            code: mergeErr.code,
          },
        });
        console.error('[auth/callback] merge_anon_feed_state failed', mergeErr);
      }
    } catch (e) {
      Sentry.captureException(e, {
        extra: { op: 'auth_callback_merge_anon_feed_state_throw', user_id: user.id },
      });
      console.error('[auth/callback] merge_anon_feed_state threw', e);
    }
    const jar = await cookies();
    jar.delete(ANON_ID_COOKIE);
  }

  // Consume email-signup claim nonce (idempotent; zero-rows == silent ignore).
  if (claim && user.email) {
    const admin = supabaseAdmin();
    await admin
      .from('auth_pending_verifications')
      .update({ consumed_at: new Date().toISOString() })
      .eq('verification_token', claim)
      .eq('email', user.email)
      .eq('purpose', 'email_signup_claim')
      .is('consumed_at', null)
      .gt('expires_at', new Date().toISOString());
  }

  // Route to onboarding if profile not onboarded, unless user is headed to /apply.
  if (!next.startsWith('/apply')) {
    const admin = supabaseAdmin();
    const { data: profile } = await admin
      .from('profiles')
      .select('onboarded_at')
      .eq('id', user.id)
      .maybeSingle<{ onboarded_at: string | null }>();
    if (!profile?.onboarded_at) {
      return NextResponse.redirect(publicUrl(req, `/onboarding?next=${encodeURIComponent(next)}`));
    }
  }

  return NextResponse.redirect(publicUrl(req, next));
}
