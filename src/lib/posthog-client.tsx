'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';

let initialized = false;

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (initialized) return;
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
    if (!key) return;
    posthog.init(key, {
      api_host: host,
      capture_pageview: true,
      person_profiles: 'identified_only',
    });
    initialized = true;
  }, []);
  return <>{children}</>;
}
