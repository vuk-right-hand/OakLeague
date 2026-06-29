'use client';

// Growth & Minutes Economy Phase 3 — the always-on "X min left this week · resets in
// 3d" pill. Renders nothing unless GROWTH_METER_ENABLED is on (the route returns
// {enabled:false}) and a balance is available. All copy classification is in the
// framework-free minutes-meter-copy.ts (pure + unit-tested); this component only
// fetches + renders. Caller positions it via the `style` prop (same contract as
// AskErrorPill).

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { formatMinutesMeter, type MeterCapPeriod } from './minutes-meter-copy';

type BalancePayload = {
  enabled: boolean;
  balance: {
    remaining_seconds: number;
    wallet_remaining: number;
    cap_period: MeterCapPeriod | null;
    supporter_active: boolean;
  } | null;
};

// Short module-level cache so a rapid double-mount shares one fetch ("don't
// over-poll"), but SHORT enough that returning from a minute-burning session shows
// a fresh number (audit M2 — 30s could lag one short session). 10s: a real session
// is longer, so the on-return remount re-reads; a <10s bounce burned ~nothing.
// Audit M1 — the cache is per-tab heap and NOT keyed by user. Login is always a full
// document load (heap reset), so a different user never inherits this; but we also
// drop it on any 401 (auth lost) as belt-and-braces against a future in-app
// account-switch that lands here without a reload. `cache:'no-store'` keeps the HTTP
// layer from reusing a per-user body across users too.
let cache: { at: number; payload: BalancePayload } | null = null;
const TTL_MS = 10_000;

async function fetchBalance(): Promise<BalancePayload | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.payload;
  try {
    const r = await fetch('/api/minutes/balance', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { cache = null; return null; } // M1 — drop stale cache on auth loss
    if (!r.ok) return null;
    const payload = (await r.json()) as BalancePayload;
    cache = { at: Date.now(), payload };
    return payload;
  } catch {
    return null; // a failed meter read is silent — never an error on the feed chrome
  }
}

export function MinutesMeter({ style }: { style?: CSSProperties }) {
  const [payload, setPayload] = useState<BalancePayload | null>(null);

  useEffect(() => {
    let alive = true;
    fetchBalance().then((p) => { if (alive) setPayload(p); });
    return () => { alive = false; };
  }, []);

  if (!payload?.enabled || !payload.balance) return null;

  const { remaining_seconds, wallet_remaining, cap_period } = payload.balance;
  const copy = formatMinutesMeter({
    remainingSeconds: remaining_seconds,
    capPeriod: cap_period,
    walletRemaining: wallet_remaining,
  });

  return (
    // No aria-live (audit M3): this is passive chrome that updates only on remount,
    // not a user-triggered status change — announcing it would be useless now and
    // spammy if a future refetch loop lands here.
    <div style={{ ...basePill, ...style }}>
      <span style={{ fontWeight: 600 }}>{copy.label}</span>
      {copy.sublabel && <span style={{ opacity: 0.72 }}>{' · '}{copy.sublabel}</span>}
    </div>
  );
}

// Deliberately SUBTLE (translucent dark, small) — it must not compete with the Ask
// CTA for attention; it's a passive status line, not a button.
const basePill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  background: 'rgba(0,0,0,0.55)',
  color: 'rgba(255,255,255,0.92)',
  fontSize: 11.5,
  padding: '5px 10px',
  borderRadius: 999,
  lineHeight: 1.3,
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  pointerEvents: 'none',
  zIndex: 3,
};
