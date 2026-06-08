'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

// TikTok-style persistent bottom nav (PROFILE_SYSTEM_PLAN U5 / §3.6).
// Rendered once in the root layout; hides itself on auth/onboarding/admin
// surfaces (audit S2: a shared-link visitor should not get the full authed
// shell). The middle button is a 5-state machine driven by /api/me/creator-status.

type Status = {
  state: 'guest' | 'not_invited' | 'requested' | 'invited' | 'in_review' | 'creator';
  handle: string | null;
};

// Routes that must NOT show the app shell. `/s/` is the immersive live voice
// session ("ask") — it has its own End button and a fixed-bottom talk button, so
// the nav both clutters it and overlaps the talk control. `/v/` is the full-screen
// 100svh long-form player — its own Back button + floating Ask CTA, and the fixed
// nav would overlap both the player's description band and the likes/comments
// engagement bar that scrolls below it (auditor M2, 2026-05-26). Stay full-screen.
const HIDDEN_PREFIXES = ['/login', '/onboarding', '/apply', '/auth', '/waitlist', '/admin', '/invite', '/r/', '/rate/', '/s/', '/v/'];

function Icon({ d }: { d: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const MIDDLE_COPY: Record<Status['state'], { label: string; href: string }> = {
  // Non-invited users go to /request (the public creator-request form), NEVER to
  // /apply — that page hard-fails without an invite_nonce (audit C1). WS1: the
  // request form replaces the old waitlist mailto as the single creator entry.
  guest: { label: 'Become a Creator', href: '/request' },
  not_invited: { label: 'Become a Creator', href: '/request' },
  // U1: a logged-in user who already requested sees their status, not a loop.
  requested: { label: 'Request sent', href: '/request' },
  invited: { label: 'Apply now', href: '/apply' },
  in_review: { label: 'In review', href: '/apply/submitted' },
  creator: { label: 'Studio', href: '/creator' },
};

export function BottomNav() {
  const pathname = usePathname() ?? '/';
  const [status, setStatus] = useState<Status | null>(null);

  const hidden = HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));

  // Fetch once when the nav becomes visible (not on every navigation — the nav
  // is mounted in the root layout and persists, so state is kept). Deps exclude
  // pathname so client navigations don't refetch (audit M5).
  useEffect(() => {
    if (hidden || status) return;
    let alive = true;
    fetch('/api/me/creator-status', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => alive && s && setStatus(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [hidden, status]);

  if (hidden) return null;

  // Until status resolves, render the middle button neutrally — never flash the
  // wrong state (e.g. "Become a Creator" to a logged-in creator) (audit M5).
  const mid = status ? MIDDLE_COPY[status.state] : { label: '', href: '/' };
  const youHref = status?.handle ? `/@${status.handle}` : '/onboarding?claim=1';
  const active = (href: string) => pathname === href;

  return (
    <nav className="oak-bottom-nav" aria-label="Primary">
      <a href="/" aria-current={active('/') ? 'page' : undefined}>
        <Icon d="M3 10.5 12 3l9 7.5V21H3z" />
        <span>Home</span>
      </a>
      <a href="/discover" aria-current={active('/discover') ? 'page' : undefined}>
        <Icon d="M21 21l-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z" />
        <span>Discover</span>
      </a>
      {status ? (
        <a className="oak-nav-middle" href={mid.href} data-state={status.state}>
          <span className="oak-nav-middle-plus">＋</span>
          <span>{mid.label}</span>
        </a>
      ) : (
        // Until status resolves, render a non-navigating placeholder — never a
        // dead tap to '/' (audit M-D3).
        <span className="oak-nav-middle" aria-disabled="true" style={{ opacity: 0.4, pointerEvents: 'none' }}>
          <span className="oak-nav-middle-plus">＋</span>
          <span />
        </span>
      )}
      <a href="/activity" aria-current={active('/activity') ? 'page' : undefined}>
        <Icon d="M22 12h-4l-3 9L9 3l-3 9H2" />
        <span>Activity</span>
      </a>
      <a href={youHref} aria-current={pathname.startsWith('/@') ? 'page' : undefined}>
        <Icon d="M20 21a8 8 0 1 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />
        <span>You</span>
      </a>
    </nav>
  );
}
