import type { Metadata, Viewport } from 'next';
import './globals.css';
import { PostHogProvider } from '@/lib/posthog-client';
import { BottomNav } from '@/components/bottom-nav';

export const metadata: Metadata = {
  // metadataBase makes the WS7 OG images + og:url resolve to the CANONICAL host
  // (not the per-deploy VERCEL_URL, which crawlers can't reach / is stale) —
  // without it shared cards silently fail to unfurl in prod (audit C3).
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://oak-league.vercel.app'),
  title: 'OakLeague',
  description: 'Interactive video mentorship — talk to the people you\'d pay $10K/mo to sit across from.',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0a0a0a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PostHogProvider>{children}</PostHogProvider>
        <BottomNav />
      </body>
    </html>
  );
}
