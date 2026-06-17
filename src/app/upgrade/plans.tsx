'use client';

import { useState } from 'react';

// Phase 6 payment-plans cards. POSTs to /api/stripe/checkout and redirects to
// the hosted Checkout page. `source` (in_session|cap_hit|meter|upgrade) is
// threaded for conversion attribution.

type Tier = 'evangelist' | 'boardroom';

const CARD: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 14,
  padding: 24,
  marginBottom: 16,
  background: 'rgba(255,255,255,0.03)',
};

export function UpgradePlans({ source }: { source: string }) {
  const [loading, setLoading] = useState<Tier | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function checkout(tier: Tier) {
    setLoading(tier);
    setErr(null);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier, source }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      setErr(data.error === 'unauthorized' ? 'Please sign in first.' : 'Could not start checkout — try again.');
      setLoading(null);
    } catch {
      setErr('Network error — try again.');
      setLoading(null);
    }
  }

  const btn = (tier: Tier, label: string): React.CSSProperties => ({
    marginTop: 16,
    width: '100%',
    padding: '12px 16px',
    borderRadius: 10,
    border: 'none',
    fontSize: 15,
    fontWeight: 700,
    cursor: loading ? 'default' : 'pointer',
    opacity: loading && loading !== tier ? 0.5 : 1,
    background: tier === 'boardroom' ? '#fff' : '#ff2d55',
    color: tier === 'boardroom' ? '#000' : '#fff',
  });

  return (
    <div>
      <div style={CARD}>
        <div style={{ fontSize: 13, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.6 }}>Evangelist</div>
        <div style={{ fontSize: 30, fontWeight: 800, marginTop: 4 }}>
          $3.36<span style={{ fontSize: 15, opacity: 0.6, fontWeight: 500 }}>/mo</span>
        </div>
        <p style={{ fontSize: 14, opacity: 0.82, marginTop: 10, lineHeight: 1.5 }}>
          That&apos;s literally what it costs us to run your conversations — no markup, just keeping the lights
          on. 110 minutes of talk time a month, download your conversations, no daily limit.
        </p>
        <button style={btn('evangelist', 'e')} disabled={!!loading} onClick={() => checkout('evangelist')}>
          {loading === 'evangelist' ? 'Starting…' : 'Become an Evangelist'}
        </button>
      </div>

      <div style={CARD}>
        <div style={{ fontSize: 13, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.6 }}>Boardroom</div>
        <div style={{ fontSize: 30, fontWeight: 800, marginTop: 4 }}>
          $27<span style={{ fontSize: 15, opacity: 0.6, fontWeight: 500 }}>/mo</span>
        </div>
        <p style={{ fontSize: 14, opacity: 0.82, marginTop: 10, lineHeight: 1.5 }}>
          800 minutes of talk time a month — the works. For when one creator isn&apos;t enough.
        </p>
        <button style={btn('boardroom', 'b')} disabled={!!loading} onClick={() => checkout('boardroom')}>
          {loading === 'boardroom' ? 'Starting…' : 'Go Boardroom'}
        </button>
      </div>

      {err && <p style={{ color: '#ff8a8a', fontSize: 13, marginTop: 4 }}>{err}</p>}
      <p style={{ fontSize: 12, opacity: 0.5, marginTop: 12 }}>
        Cancel anytime. Earned and referral minutes stack on top of your monthly allowance.
      </p>
    </div>
  );
}
