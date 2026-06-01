// Feature A, stage 1 — the "Let's go somewhere private…" mask shown on the Ask
// surfaces (hook-panel feed + /v/[id] long-form) from the moment the user taps
// until we navigate to /s/[id]. A darkened room photo + a single warm line, so
// the ~1–3s /api/sessions/open round-trip reads as "walking into a private
// session," not dead air.
//
// The image is served at /Images/session-room.webp (the file lives under
// public/Images/, recompressed from the source PNG to ~56KB so it streams
// instantly on LTE behind the 65% scrim). If it's absent the overlay degrades
// to a warm dark gradient (the `backgroundColor` shows through) — so this ships
// and works before the asset is dropped in, and just gets richer once it is.
//
// Stage 2 ("Starting the call…", black) lives on /s/[id] (session-client) — this
// component is ONLY the room stage on the source page.
//
// Lifecycle note: the callers (hook-panel, long-form) deliberately do NOT clear
// `visible` on the success path — the router.push to /s/[id] unmounts the source
// tree (the `(feed)` / `/v/` segments share only the root layout with `/s/`, so
// they DO unmount), which removes this overlay with no flash. If anyone ever
// nests the source surfaces and /s/[id] under a shared layout, that unmount stops
// happening and the overlay would strand — clear `visible` explicitly then.

'use client';

import type { CSSProperties } from 'react';

const ROOM_IMAGE_SRC = '/Images/session-room.webp';

export function EnterPrivateRoomOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div role="status" aria-live="polite" style={overlay}>
      <style>{`@keyframes oakEnterFade { from { opacity: 0 } to { opacity: 1 } }
@keyframes oakEnterDot { 0%,80%,100% { opacity:.25 } 40% { opacity:1 } }`}</style>
      {/* darkening scrim over the room photo (≈65%) */}
      <div style={scrim} />
      <div style={content}>
        <div style={line}>Let&apos;s go somewhere private…</div>
        <div style={dots} aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ ...dot, animationDelay: `${i * 0.18}s` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  // Audit C1 — MUST sit above the persistent BottomNav (.oak-bottom-nav z-index:50,
  // visible on the feed `/` where hook-panel shows this) and the welcome overlay
  // (z-50). At z-60 the mask fully covers + blocks them, so a stray tap on the nav
  // can't soft-navigate away and abandon the just-opened session.
  zIndex: 60,
  backgroundColor: '#15110d', // warm near-black fallback when the photo is absent
  backgroundImage: `url(${ROOM_IMAGE_SRC})`,
  backgroundSize: 'cover',
  backgroundPosition: 'center',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  animation: 'oakEnterFade 280ms ease-out both',
};

const scrim: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(0,0,0,0.65)',
};

const content: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 14,
  textAlign: 'center',
  padding: 24,
};

const line: CSSProperties = {
  color: '#fff',
  fontSize: 20,
  fontWeight: 600,
  letterSpacing: 0.2,
  textShadow: '0 1px 8px rgba(0,0,0,0.6)',
};

const dots: CSSProperties = { display: 'flex', gap: 7 };

const dot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 4,
  background: '#fff',
  animation: 'oakEnterDot 1.2s infinite ease-in-out',
};
