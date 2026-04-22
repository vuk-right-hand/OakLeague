// Pure scrub function for PostHog capture props. Isolated from the
// `posthog-js` import so it can be unit-tested in the node vitest
// environment without loading the browser SDK.
//
// Regex is intentionally loose. False positives (e.g. `monkey`, `keyboard`,
// `author`) drop analytics props — recoverable from Sentry breadcrumbs.
// False negatives leak credentials — NOT recoverable. Tightening this regex
// to fix a false-positive is a regression; add an allowlist exception instead.
// (R4-S4)

export const SENSITIVE_KEY_RE = /token|secret|key|bearer|ephemeral|auth|cred|password|jwt/i;

export function scrub(
  props: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!props) return props;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (SENSITIVE_KEY_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}
