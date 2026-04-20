import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  beforeSend: scrub,
});

function scrub(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request?.cookies) delete event.request.cookies;
  if (event.request?.headers) {
    for (const k of Object.keys(event.request.headers)) {
      if (/^cookie$|^authorization$/i.test(k)) delete event.request.headers[k];
    }
  }
  if (event.request?.url) event.request.url = redactInvitePath(event.request.url);
  if (event.transaction) event.transaction = redactInvitePath(event.transaction);
  return event;
}

function redactInvitePath(s: string): string {
  return s.replace(/\/invite\/[^/?#]+/g, '/invite/[redacted]');
}
