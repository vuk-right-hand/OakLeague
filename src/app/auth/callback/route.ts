import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

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
