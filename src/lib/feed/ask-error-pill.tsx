'use client';

// Shared error pill for the Ask CTA across feed hook-panel and long-form
// viewer. Centralizes:
//   • Friendly copy when the daily cap fires (`rate_limited` /
//     `kill_switch_blocked`) — replaces the previous dead conditional
//     that checked 'kill_switch_fired', a string the API never produces.
//   • An "Upgrade for unlimited →" link routed to /upgrade?source=cap_hit
//     so cap-hit conversions can be measured separately in waitlist.source.
//   • Fallback copy for unmapped errors.
//
// The reset-time string is computed from the browser's IANA timezone via
// Intl. The server-side cap key is profiles.timezone (set at onboarding,
// typically the same browser TZ); a roaming user could see the displayed
// reset drift by an hour or two from when the kill-switch actually
// releases. Acceptable for a polish surface; if it bites, thread the
// SSR-known timezone via prop chain.

import Link from 'next/link';
import type { CSSProperties } from 'react';

type Props = {
  /** API error code from the /api/sessions/open response body, or
      'network' for fetch-level failures. null hides the pill. */
  error: string | null;
  /** Position override. Defaults to a corner-style absolute pill the
      caller is responsible for placing within its own container. */
  style?: CSSProperties;
};

const CAP_HIT_CODES = new Set([
  'rate_limited',
  'kill_switch_blocked',
  // Defensive: keep the legacy string the prior dead conditional checked
  // so a stale server build doesn't break the friendly copy.
  'kill_switch_fired',
]);

export function AskErrorPill({ error, style }: Props) {
  if (!error) return null;

  if (CAP_HIT_CODES.has(error)) {
    return (
      <div role="alert" style={{ ...basePill, ...style }}>
        <span>Daily limit reached. Resets in {formatTimeUntilLocalMidnight()}.</span>{' '}
        <Link href="/upgrade?source=cap_hit" style={ctaLink}>
          Upgrade for unlimited →
        </Link>
      </div>
    );
  }

  // R3-C1 (UX) — Pipeline α' pre-WS gate: creator's voice clone hasn't
  // been uploaded yet. Friendly copy so demo day "this creator's voice
  // isn't ready" doesn't surface as the generic "Couldn't start session"
  // string.
  if (error === 'creator_voice_not_trained') {
    return (
      <div role="alert" style={{ ...basePill, ...style }}>
        This creator&apos;s voice isn&apos;t ready yet — check back soon.
      </div>
    );
  }

  if (error === 'creator_not_ready') {
    return (
      <div role="alert" style={{ ...basePill, ...style }}>
        This creator isn&apos;t fully set up yet — check back soon.
      </div>
    );
  }

  return (
    <div role="alert" style={{ ...basePill, ...style }}>
      Couldn&apos;t start session: {error}
    </div>
  );
}

const basePill: CSSProperties = {
  background: 'rgba(255,255,255,0.96)',
  color: '#111',
  fontSize: 12,
  padding: '8px 12px',
  borderRadius: 10,
  maxWidth: 280,
  lineHeight: 1.45,
  zIndex: 3,
};

const ctaLink: CSSProperties = {
  color: '#2e6bff',
  textDecoration: 'none',
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

// Computes "Xh Ym" until the next local midnight. Returns "Ym" alone for
// sub-hour windows and "0m" if we somehow land at exactly midnight (the
// caller still renders the pill but the copy degrades gracefully).
function formatTimeUntilLocalMidnight(): string {
  try {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    const diffMs = next.getTime() - now.getTime();
    if (diffMs <= 0) return '0m';
    const totalMin = Math.ceil(diffMs / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h <= 0) return `${m}m`;
    return `${h}h ${m}m`;
  } catch {
    return 'a few hours';
  }
}
