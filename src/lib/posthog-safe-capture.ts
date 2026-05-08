// Single entry point for PostHog capture calls from client code.
//
// Regex is intentionally loose. False positives (e.g. `monkey`, `keyboard`,
// `author`) drop analytics props — recoverable from Sentry breadcrumbs.
// False negatives leak credentials — NOT recoverable. Tightening this regex
// to fix a false-positive is a regression; add an allowlist exception instead.
// (R4-S4)
//
// "No raw posthog.capture outside this wrapper" is convention, not enforced.
// All known callsites go through captureSafe (verified post-B3.1 — six raw
// `(window as any).posthog?.capture?.` calls in feed/long-form/welcome were
// migrated). New callers must use captureSafe so scrub() runs and the event
// name is type-checked against the registry in posthog-events.ts.

'use client';

import posthog from 'posthog-js';
import { scrub } from './posthog-scrub';
import type { ClientPostHogEvent } from './posthog-events';

// Phase C B3.1: `event` is typed against the registry in posthog-events.ts
// instead of `string`. A typo at a callsite is now a typecheck error
// rather than a silently-dropped metric. Adding a new event requires
// registering it in posthog-events.ts first.
export function captureSafe(event: ClientPostHogEvent, props?: Record<string, unknown>): void {
  try {
    posthog.capture(event, scrub(props));
  } catch { /* posthog not initialized yet — drop silently */ }
}
