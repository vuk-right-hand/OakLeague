// Proxy-side Sentry init. Mirrors sentry.server.config.ts scrub rules so the
// ticket query param and Authorization headers never land in Sentry events.
// If SENTRY_DSN is unset (e.g., local dev), init is a no-op.
//
// PRE-α'-CUTOVER GATE (2026-04-30, future agents read this):
// SENTRY_DSN is currently UNSET on the Fly app oakleague-voice-proxy.
// Acceptable today because the proxy only handles admin-gated Spike-A
// traffic — the cogs-failure WS-close logic works without Sentry.
//
// BEFORE production user traffic flows through this proxy (i.e. before
// Pipeline α' wires use-session-pipe.ts to forward Gemini transcript text
// → Cartesia → Simli via this proxy instead of going Gemini-direct), run:
//
//   fly secrets set --app oakleague-voice-proxy SENTRY_DSN=<dsn>
//
// Otherwise the cogs RPC failure-rate alert rule (plan §1A.2) cannot fire
// and you're flying blind on the "0055-style breakage in prod" scenario.
// Reference: docs/_planning/SPIKE_A_DEFERRED_FIXUP_PLAN.md §1A.2.

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
      // R3-C4 + R4-M8: scrub transcript-shaped fields from every channel.
      // User conversation content (Gemini outputTranscription text, Cartesia
      // transcripts) must NEVER reach Sentry. Single helper applied at every
      // surface — extras, contexts, breadcrumbs[].data, message,
      // exception.values[].value.
      scrubTranscriptKeys(event.extra);
      scrubTranscriptKeys(event.contexts);
      if (Array.isArray(event.breadcrumbs)) {
        for (const b of event.breadcrumbs) {
          if (b && typeof b === 'object') {
            scrubTranscriptKeys(b.data);
            if (typeof b.message === 'string') b.message = stripLikelyTranscript(b.message);
          }
        }
      }
      if (typeof event.message === 'string') event.message = stripLikelyTranscript(event.message);
      if (event.exception?.values) {
        for (const v of event.exception.values) {
          if (typeof v?.value === 'string') v.value = stripLikelyTranscript(v.value);
        }
      }
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

// S-C5 — explicit denylist of keys whose VALUES are user-conversation
// content (Gemini outputTranscription text, Cartesia transcripts, model
// prompts, raw response bodies). Substring matching was too loose
// (`pretext`, `subtext`, `context_text` got flagged) AND too tight
// (`prompt`, `message`, `responseBody` slipped through). Match is on the
// LOWERCASED full key name, set membership only.
const TRANSCRIPT_KEYS = new Set([
  'transcript',
  'transcripttext',
  'output_transcript',
  'outputtranscript',
  'outputtranscription',
  'output_transcription',
  'input_transcript',
  'inputtranscript',
  'inputtranscription',
  'input_transcription',
  '_currentturnoutputtranscript',
  'chunktext',
  'chunk_text',
  'prompt',
  'systeminstruction',
  'system_instruction',
  'userprompt',
  'user_prompt',
  'usermessage',
  'user_message',
  'modelprompt',
  'model_prompt',
  'responsebody',
  'response_body',
  'requestbody',
  'request_body',
  'cartesia_transcript',
]);

export function scrubTranscriptKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) scrubTranscriptKeys(item);
    return obj;
  }
  for (const k of Object.keys(obj)) {
    const lower = k.toLowerCase();
    if (TRANSCRIPT_KEYS.has(lower)) {
      // Preserve the key for debug breadcrumbs but redact the content.
      obj[k] = '[redacted]';
      continue;
    }
    if (obj[k] && typeof obj[k] === 'object') scrubTranscriptKeys(obj[k]);
  }
  return obj;
}

// S-C5 — `stripLikelyTranscript` was too aggressive: a 100-char regex
// matches normal stack-frame paths, base64 voice ids, single-line
// minified errors, etc. Removed entirely. The key-based scrub above is
// the contract; we trust callers not to stuff transcripts into
// `event.message` or `exception.values[].value`. The audit suite asserts
// this trust at every captureException site (sentry.test.js).
export function stripLikelyTranscript(s) {
  // No-op kept for back-compat with callers in sentry.js beforeSend.
  return s;
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
