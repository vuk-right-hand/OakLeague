import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { candidateHashes } from '@/lib/invite-tokens';

export default async function ClaimPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const hashes = candidateHashes(token);

  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    redirect(`/login?next=${encodeURIComponent(`/invite/${token}/claim`)}`);
  }

  const { data: nonce, error } = await supabase.rpc('bind_invite_claim', {
    p_token_hashes: hashes,
  });

  if (error || typeof nonce !== 'string') {
    return (
      <main style={{ maxWidth: 480, margin: '10vh auto', padding: 24, textAlign: 'center' }}>
        <h1 style={{ fontSize: 24, fontWeight: 600 }}>Invite unavailable</h1>
        <p style={{ opacity: 0.7, marginTop: 12 }}>
          This invite can&apos;t be claimed from this account. Check that you signed in with the
          same email the invite was sent to.
        </p>
      </main>
    );
  }

  const jar = await cookies();
  jar.set('invite_nonce', nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60,
  });

  redirect('/apply');
}
