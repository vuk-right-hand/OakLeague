import type { Metadata, Viewport } from 'next';
import './globals.css';
import { PostHogProvider } from '@/lib/posthog-client';
import { BottomNav } from '@/components/bottom-nav';

export const metadata: Metadata = {
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
