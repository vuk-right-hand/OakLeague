import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/supabase/admin';
import RaterClient from './rater-client';

export const metadata: Metadata = {
  title: 'OakLeague — Rater',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /rate/[token] — NOT under /admin/*. Token-auth only. See SPIKE_B_PLAN.md
// decision 14 + §Security review. Raters are friends/colleagues; admin-gate
// would 403 them. The final consume step happens on /api/rate/submit; we only
// validate existence + unexpired here (UA-hash binding is also checked on
// submit, not here — the first page render may be from a clicked email
// preview whose UA differs from the eventual form submit).

type TokenRow = {
  token_id: string;
  rater_cohort: 'vuk_naive' | 'vuk_knower';
  expires_at: string;
  consumed_at: string | null;
};

export default async function RatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!UUID_RE.test(token)) notFound();

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('spike_b_rater_tokens')
    .select('token_id, rater_cohort, expires_at, consumed_at')
    .eq('token_id', token)
    .maybeSingle<TokenRow>();

  if (error) throw error;
  if (!data) notFound();

  const expired = new Date(data.expires_at).getTime() < Date.now();
  const consumed = data.consumed_at !== null;

  return (
    <div style={{ maxWidth: 640, margin: '4vh auto', padding: 24 }}>
      <h1 style={{ marginTop: 0 }}>OakLeague — Rater</h1>
      {expired || consumed ? (
        <p>
          This link is {consumed ? 'already used' : 'expired'}. Please ask the organizer
          for a fresh link.
        </p>
      ) : (
        <RaterClient token={data.token_id} cohort={data.rater_cohort} />
      )}
    </div>
  );
}
