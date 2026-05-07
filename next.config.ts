import type { NextConfig } from 'next';

const config: NextConfig = {
  // Disabled 2026-05-06 (Phase 0.5 wireup). StrictMode dev double-mount
  // is fundamentally at odds with the session pipe's single-use external
  // resources (voice ticket consumed once by the proxy, HeyGen/Simli
  // session minted once per /api/sessions/open, Postgres session row).
  // The double-mount fires the unmount cleanup (sendBeacon close + ticket
  // already consumed by first mount's proxy WS), causing the second mount
  // to land on a closed session and fail with proxy_connect_failed. Making
  // every external resource idempotent across StrictMode cycles is real
  // refactor work — tracked separately. Production is unaffected (Strict
  // Mode is dev-only).
  reactStrictMode: false,
  poweredByHeader: false,
  // typedRoutes deferred to v1.1 — many dynamic redirect targets are built
  // from user input (next=<path>, /invite/<token>/claim) and the ergonomics
  // of RouteImpl casting every call site isn't worth it yet.
  typedRoutes: false,
  allowedDevOrigins: ['*.ngrok-free.dev', '*.ngrok-free.app'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.mux.com' },
      { protocol: 'https', hostname: 'image.mux.com' },
      { protocol: 'https', hostname: 'stream.mux.com' },
    ],
  },
};

export default config;
