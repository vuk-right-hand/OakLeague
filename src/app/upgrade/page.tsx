// /upgrade — landing for users who hit the daily cap and tapped the
// "Upgrade for unlimited" link from the Ask error pill. Thin reuse of
// the waitlist form with source='cap_hit' so we can measure conversion
// from cap-hit → signup separately from landing-page signups.

import 'server-only';
import Link from 'next/link';
import { WaitlistForm } from '@/app/waitlist/waitlist-form';

export const dynamic = 'force-dynamic';

export default function UpgradePage() {
  return (
    <main
      style={{
        maxWidth: 560,
        margin: '0 auto',
        padding: '40px 20px 80px',
        color: '#fff',
        background: '#000',
        minHeight: '100vh',
      }}
    >
      <div style={{ marginBottom: 32 }}>
        <Link
          href="/"
          style={{ fontSize: 13, opacity: 0.6, color: '#fff', textDecoration: 'none' }}
        >
          ‹ Back
        </Link>
      </div>

      <h1
        style={{
          fontSize: 'clamp(28px, 5vw, 40px)',
          fontWeight: 700,
          lineHeight: 1.1,
          letterSpacing: -0.4,
        }}
      >
        You&apos;ve hit today&apos;s daily limit.
      </h1>
      <p
        style={{
          fontSize: 16,
          opacity: 0.78,
          marginTop: 16,
          lineHeight: 1.5,
        }}
      >
        Free accounts get 5 minutes a day. Join the waitlist to unlock
        unlimited conversations with the creators you watch — we&apos;ll be
        in touch before the next billing tier opens.
      </p>

      <div style={{ marginTop: 28 }}>
        <WaitlistForm source="cap_hit" />
      </div>

      <p style={{ marginTop: 24, fontSize: 12, opacity: 0.55 }}>
        Your daily limit resets at local midnight. Already on the waitlist?
        We have you — no need to re-sign.
      </p>
    </main>
  );
}
