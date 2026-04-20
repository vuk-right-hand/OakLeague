import 'server-only';
import { PostHog } from 'posthog-node';

let client: PostHog | null = null;

export function posthogServer(): PostHog | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  if (!key) return null;
  if (!client) {
    client = new PostHog(key, { host, flushAt: 1, flushInterval: 0 });
  }
  return client;
}
