'use client';

import { useState } from 'react';

// Share button (CREATOR_JOURNEY WS7). Native share sheet on mobile, copy-link
// fallback on desktop (navigator.share is unavailable on desktop Chrome/Firefox
// and requires HTTPS + a user gesture — audit Small). Two looks:
//   'pill' — inline, for the /v engagement bar + /@handle profile actions
//   'fab'  — pulsating round button for the video right-rail (hooks + player)
//
// `path` is a relative app path (e.g. /v/<id> or /@handle); we resolve it to an
// absolute URL at click time against the live origin so it works across
// preview/prod without hardcoding a domain.

type Props = {
  path: string;
  title: string;
  text?: string;
  variant?: 'pill' | 'fab';
  label?: string;
};

const ShareGlyph = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M4 12v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 16V3M12 3 8 7M12 3l4 4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function ShareButton({ path, title, text, variant = 'pill', label = 'Share' }: Props) {
  const [copied, setCopied] = useState(false);

  async function onShare() {
    // Invariant: callers pass a server-constructed relative app path. Guard
    // against an absolute/external value sneaking in (open-redirect-by-share).
    if (!path.startsWith('/')) return;
    const url =
      typeof window !== 'undefined' ? new URL(path, window.location.origin).href : path;

    // Prefer the native share sheet (mobile). Cancel (AbortError) is a no-op.
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        // Any other share failure → fall through to copy.
      }
    }

    // Desktop / no-share-API fallback: copy link.
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / permissions / webview). Don't
      // leave a dead tap (audit M5) — surface the link so the user can copy it.
      if (typeof window !== 'undefined') window.prompt('Copy this link:', url);
    }
  }

  if (variant === 'fab') {
    return (
      <button
        type="button"
        className="oak-share-fab"
        data-copied={copied}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          void onShare();
        }}
      >
        {copied ? '✓' : ShareGlyph}
      </button>
    );
  }

  return (
    <button type="button" className="oak-share-btn" aria-label={label} onClick={() => void onShare()}>
      {copied ? 'Copied!' : <>{ShareGlyph} {label}</>}
    </button>
  );
}
