import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { candidateHashes } from '@/lib/invite-tokens';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    const next = encodeURIComponent(`/invite/${token}/claim`);
    return NextResponse.redirect(new URL(`/login?next=${next}`, req.url));
  }

  const hashes = candidateHashes(token);
  const { data: nonce, error } = await supabase.rpc('bind_invite_claim', {
    p_token_hashes: hashes,
  });

  if (error || typeof nonce !== 'string') {
    return NextResponse.redirect(new URL(`/invite/${token}?unavailable=1`, req.url));
  }

  const res = NextResponse.redirect(new URL('/apply', req.url));
  res.cookies.set('invite_nonce', nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60,
  });
  return res;
}
