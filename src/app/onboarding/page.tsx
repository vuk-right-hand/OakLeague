import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { getCallerUserId } from '@/lib/auth-guards';
import { OnboardingForm } from './onboarding-form';

function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await searchParams;
  const next = safeNext(sp.next);

  const userId = await getCallerUserId();
  if (!userId) redirect(`/login?next=${encodeURIComponent('/onboarding')}`);

  const supabase = await supabaseServer();
  const { data: profile } = await supabase
    .from('profiles')
    .select('onboarded_at')
    .eq('id', userId)
    .maybeSingle<{ onboarded_at: string | null }>();

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
