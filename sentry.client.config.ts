import * as Sentry from '@sentry/nextjs';
import { applyTranscriptScrub } from '@/lib/sentry-scrub';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  beforeSend: scrub,
  beforeBreadcrumb: (crumb) => {
    if (crumb.category === 'fetch' && typeof crumb.data?.url === 'string') {
      crumb.data.url = redactSensitive(crumb.data.url);
    }
    if (typeof crumb.message === 'string') {
      crumb.message = redactSensitive(crumb.message);
    }
    return crumb;
  },
});

function scrub(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request?.cookies) delete event.request.cookies;
  if (event.request?.headers) {
    for (const k of Object.keys(event.request.headers)) {
      if (/^cookie$/i.test(k)) delete event.request.headers[k];
    }
  }
  if (event.request?.url) event.request.url = redactSensitive(event.request.url);
  if (event.transaction) event.transaction = redactSensitive(event.transaction);
  if (typeof event.message === 'string') event.message = redactSensitive(event.message);
  if (event.exception?.values) {
    for (const v of event.exception.values) {
      if (typeof v.value === 'string') v.value = redactSensitive(v.value);
    }
  }
  if (Array.isArray(event.breadcrumbs)) {
    for (const c of event.breadcrumbs) {
      if (typeof c.message === 'string') c.message = redactSensitive(c.message);
      if (typeof c.data?.url === 'string') c.data.url = redactSensitive(c.data.url);
    }
  }
  // S-C4 / R3-C4 — transcript-key scrub mirroring the proxy.
  applyTranscriptScrub(event);
  return event;
}

function redactSensitive(s: string): string {
  return redactSpikeB(redactInvitePath(s));
}

function redactInvitePath(s: string): string {
  return s
    .replace(/\/invite\/[^/?#]+/g, '/invite/[redacted]')
    .replace(/\/rate\/[^/?#]+/g, '/rate/[redacted]')
    .replace(/([?&#])access_token=[^&#]+/g, '$1access_token=[redacted]')
    .replace(/([?&#])ticket=[^&#]+/g, '$1ticket=[redacted]');
}

// Spike B (avatar provider) — scrub per SPIKE_B_PLAN.md Rev 4 C4 / Rev 5.
// Covers URL query params AND JSON body string occurrences. Explicit regex per
// name (not a single greedy pattern) so each key's shape is auditable.
function redactSpikeB(s: string): string {
  return s
    .replace(/([?&#])simli_token=[^&#]+/g,      '$1simli_token=[redacted]')
    .replace(/([?&#])compose_url=[^&#]+/g,      '$1compose_url=[redacted]')
    .replace(/([?&#])conversation_url=[^&#]+/g, '$1conversation_url=[redacted]')
    .replace(/([?&#])daily_room_url=[^&#]+/g,   '$1daily_room_url=[redacted]')
    .replace(/([?&#])api_key=[^&#]+/g,          '$1api_key=[redacted]')
    .replace(/([?&#])token=[^&#]+/g,            '$1token=[redacted]')
    .replace(/"simli_token"\s*:\s*"[^"]*"/g,      '"simli_token":"[redacted]"')
    .replace(/"compose_url"\s*:\s*"[^"]*"/g,      '"compose_url":"[redacted]"')
    .replace(/"conversation_url"\s*:\s*"[^"]*"/g, '"conversation_url":"[redacted]"')
    .replace(/"daily_room_url"\s*:\s*"[^"]*"/g,   '"daily_room_url":"[redacted]"')
    .replace(/"api_key"\s*:\s*"[^"]*"/g,           '"api_key":"[redacted]"')
    .replace(/"token"\s*:\s*"[^"]*"/g,             '"token":"[redacted]"');
}
