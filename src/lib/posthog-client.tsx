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
      sanitize_properties: (props) => {
        const redact = (s: string) => s
          .replace(/\/invite\/[^/?#]+/g, '/invite/[redacted]')
          .replace(/([?&#])access_token=[^&#]+/g, '$1access_token=[redacted]')
          .replace(/([?&#])ticket=[^&#]+/g, '$1ticket=[redacted]');
        for (const k of ['$current_url', '$referrer', '$pathname', '$initial_referrer', '$initial_current_url']) {
          if (typeof props[k] === 'string') props[k] = redact(props[k]);
        }
        return props;
      },
    });
    initialized = true;
  }, []);
  return <>{children}</>;
}
