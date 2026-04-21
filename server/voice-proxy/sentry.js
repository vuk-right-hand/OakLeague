// Proxy-side Sentry init. Mirrors sentry.server.config.ts scrub rules so the
// ticket query param and Authorization headers never land in Sentry events.
// If SENTRY_DSN is unset (e.g., local dev), init is a no-op.

import * as Sentry from '@sentry/node';

const DSN = process.env.SENTRY_DSN || '';

if (DSN) {
  Sentry.init({
    dsn: DSN,
    tracesSampleRate: 0.1,
    environment: 'spike_a',
    release: process.env.FLY_MACHINE_VERSION || undefined,
    beforeSend(event) {
      if (event.request?.headers) {
        for (const k of Object.keys(event.request.headers)) {
          if (/^cookie$|^authorization$/i.test(k)) delete event.request.headers[k];
        }
      }
      if (event.request?.url) event.request.url = scrubUrl(event.request.url);
      if (event.transaction) event.transaction = scrubUrl(event.transaction);
      return event;
    },
  });
  console.log('[sentry] initialized');
} else {
  console.log('[sentry] SENTRY_DSN unset — capture is no-op');
}

function scrubUrl(s) {
  return String(s).replace(/([?&#])ticket=[^&#]+/g, '$1ticket=[redacted]');
}

// Accepts an optional { level, ...extras } context. `level` (if one of Sentry's
// severities) becomes the event's real `level` — the field Sentry alerting keys
// off. Everything else goes to `extra`. Round-2 audit K1: previously a caller
// that wanted to flag a FATAL was forced to stuff `severity: 'fatal'` into extras,
// which is inert for alerting.
const SENTRY_LEVELS = new Set(['fatal', 'error', 'warning', 'log', 'info', 'debug']);

export function captureException(e, context) {
  if (!DSN) return;
  try {
    if (!context) return void Sentry.captureException(e);
    const { level, ...extra } = context;
    const opts = {};
    if (level && SENTRY_LEVELS.has(level)) opts.level = level;
    if (Object.keys(extra).length) opts.extra = extra;
    Sentry.captureException(e, opts);
  } catch {}
}

export function captureMessage(msg, level = 'warning', context) {
  if (!DSN) return;
  try {
    Sentry.captureMessage(msg, { level, extra: context });
  } catch {}
}
