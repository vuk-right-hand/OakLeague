import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
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
