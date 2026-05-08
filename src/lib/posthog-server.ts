import 'server-only';
import { PostHog } from 'posthog-node';
import { scrub } from './posthog-scrub';
import type { ServerPostHogEvent } from './posthog-events';

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

/**
 * Server-side mirror of `captureSafe`. Runs the SAME `scrub()` regex against
 * properties so prop-name policy stays consistent between client and server.
 * Drop-on-fail semantics: PostHog not configured, network failure, or scrub
 * throws — all swallowed. Analytics is best-effort.
 *
 * `distinctId` should be the user's UUID when authenticated, or a stable
 * device fingerprint hash for anonymous events (e.g. referral_landing).
 *
 * Day-5: closes plan §11 telemetry — `referral_landing` (Route Handler)
 * + `referral_first_session` (sessions/open after() block).
 */
export async function captureServerSafe(
  distinctId: string,
  event: ServerPostHogEvent,
  props?: Record<string, unknown>,
): Promise<void> {
  try {
    const ph = posthogServer();
    if (!ph) return;
    ph.capture({ distinctId, event, properties: scrub(props) ?? {} });
    // flushAt:1 means capture flushes immediately; await it so the request
    // actually leaves the function before the serverless container can
    // freeze. Cheap (~5-20ms p50) and correctness-critical.
    await ph.flush();
  } catch { /* best-effort */ }
}
