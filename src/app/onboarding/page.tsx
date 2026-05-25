import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { getCallerUserId } from '@/lib/auth-guards';
import { OnboardingForm } from './onboarding-form';
import { ClaimHandleForm } from './claim-handle-form';

function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; claim?: string }>;
}) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const claimMode = sp.claim === '1';

  const userId = await getCallerUserId();
  if (!userId) redirect(`/login?next=${encodeURIComponent(claimMode ? '/onboarding?claim=1' : '/onboarding')}`);

  const supabase = await supabaseServer();
  const { data: profile } = await supabase
    .from('profiles')
    .select('onboarded_at, handle')
    .eq('id', userId)
    .maybeSingle<{ onboarded_at: string | null; handle: string | null }>();

  // Claim mode (audit C3): a handle-less user landing from the "You" tab claims
  // one here regardless of onboarded_at. If they (or a creator) already have a
  // public handle, send them to their profile.
  if (claimMode) {
    const { data: creator } = await supabase
      .from('creators')
      .select('handle')
      .eq('user_id', userId)
      .maybeSingle<{ handle: string | null }>();
    // A creator manages identity in Studio — never the claim form (saveProfile
    // would reject them with edit_in_studio). Send them there directly (C-D2).
    if (creator) redirect('/creator');
    if (profile?.handle) redirect(`/@${profile.handle}`);
    return (
      <main style={{ maxWidth: 520, margin: '6vh auto', padding: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 600 }}>Claim your handle</h1>
        <p style={{ opacity: 0.7, marginTop: 8 }}>This is your public profile at oakleague.com/@you.</p>
        <ClaimHandleForm />
      </main>
    );
  }

  if (profile?.onboarded_at) redirect(next);

  return (
    <main style={{ maxWidth: 520, margin: '6vh auto', padding: 24 }}>
      <h1 style={{ fontSize: 28, fontWeight: 600 }}>A couple of questions</h1>
      <p style={{ opacity: 0.7, marginTop: 8 }}>
        We&apos;ll use these to tailor what you see.
      </p>
      <OnboardingForm next={next} />
    </main>
  );
}
