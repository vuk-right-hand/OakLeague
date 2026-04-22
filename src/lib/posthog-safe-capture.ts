// Single entry point for PostHog capture calls from client code.
//
// Regex is intentionally loose. False positives (e.g. `monkey`, `keyboard`,
// `author`) drop analytics props — recoverable from Sentry breadcrumbs.
// False negatives leak credentials — NOT recoverable. Tightening this regex
// to fix a false-positive is a regression; add an allowlist exception instead.
// (R4-S4)
//
// The codebase enforces "no raw posthog.capture outside this wrapper" via
// tests/posthog-safe-capture.spec.ts (grep-based).

'use client';

import posthog from 'posthog-js';
import { scrub } from './posthog-scrub';

export function captureSafe(event: string, props?: Record<string, unknown>): void {
  try {
    posthog.capture(event, scrub(props));
  } catch { /* posthog not initialized yet — drop silently */ }
}
