// /upgrade — paid-tier plans (Phase 6) when GROWTH_PAID_TIERS_ENABLED, else the
// waitlist stub (the pre-Stripe behavior). `?source=in_session|cap_hit|meter`
// is threaded for conversion attribution.

import 'server-only';
import Link from 'next/link';
import { WaitlistForm } from '@/app/waitlist/waitlist-form';
import { UpgradePlans } from './plans';

export const dynamic = 'force-dynamic';

const ALLOWED_SOURCES = new Set(['in_session', 'cap_hit', 'meter', 'upgrade']);

const main: React.CSSProperties = {
  maxWidth: 560,
  margin: '0 auto',
  padding: '40px 20px 80px',
  color: '#fff',
  background: '#000',
  minHeight: '100vh',
};

export default async function UpgradePage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const sp = await searchParams;
  const source = sp.source && ALLOWED_SOURCES.has(sp.source) ? sp.source : 'upgrade';
  const paidTiersEnabled = process.env.GROWTH_PAID_TIERS_ENABLED === '1';

  return (
    <main style={main}>
      <div style={{ marginBottom: 32 }}>
        <Link href="/" style={{ fontSize: 13, opacity: 0.6, color: '#fff', textDecoration: 'none' }}>
          ‹ Back
        </Link>
      </div>

      {paidTiersEnabled ? (
        <>
          <h1 style={{ fontSize: 'clamp(28px, 5vw, 40px)', fontWeight: 700, lineHeight: 1.1, letterSpacing: -0.4 }}>
            Keep the conversation going.
          </h1>
          <p style={{ fontSize: 16, opacity: 0.78, margin: '16px 0 28px', lineHeight: 1.5 }}>
            Free gives you 5 minutes a day. Upgrade for more — priced at what it actually costs us to run.
          </p>
          <UpgradePlans source={source} />
        </>
      ) : (
        <>
          <h1 style={{ fontSize: 'clamp(28px, 5vw, 40px)', fontWeight: 700, lineHeight: 1.1, letterSpacing: -0.4 }}>
            You&apos;ve hit today&apos;s daily limit.
          </h1>
          <p style={{ fontSize: 16, opacity: 0.78, marginTop: 16, lineHeight: 1.5 }}>
            Free accounts get 5 minutes a day. Join the waitlist to unlock unlimited conversations with the
            creators you watch — we&apos;ll be in touch before the next billing tier opens.
          </p>
          <div style={{ marginTop: 28 }}>
            <WaitlistForm source="cap_hit" />
          </div>
          <p style={{ marginTop: 24, fontSize: 12, opacity: 0.55 }}>
            Your daily limit resets at local midnight. Already on the waitlist? We have you — no need to re-sign.
          </p>
        </>
      )}
    </main>
  );
}
