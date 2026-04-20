import { redirect } from 'next/navigation';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { candidateHashes } from '@/lib/invite-tokens';

export default async function InviteLandingPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ unavailable?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  if (sp.unavailable === '1') {
    return renderError(
      "This invite can't be claimed from this account. Check that you signed in with the same email the invite was sent to.",
    );
  }
  const hashes = candidateHashes(token);
  if (hashes.length === 0) return renderError('Invite system not configured.');

  const sb = supabaseAdmin();
  const { data } = await sb
    .from('creator_invitations')
    .select('id, expires_at, used_at')
    .in('token_hash', hashes)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle<{ id: string; expires_at: string; used_at: string | null }>();

  if (!data) return renderError('This invite is invalid, used, or expired.');

  redirect(`/login?next=${encodeURIComponent(`/invite/${token}/claim`)}`);
}

function renderError(msg: string) {
  return (
    <main style={{ maxWidth: 480, margin: '10vh auto', padding: 24, textAlign: 'center' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600 }}>Invite unavailable</h1>
      <p style={{ opacity: 0.7, marginTop: 12 }}>{msg}</p>
    </main>
  );
}
