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
      // HUME_TTS_PLAN audit C4 fix (2026-05-13): Sentry's RequestData
      // integration parses query strings into a separate field where the
      // `?` prefix is stripped — `[?&#]` URL-regex never matches. Scrub it
      // by treating it as a `&`-prefixed body so the regex fires.
      if (typeof event.request?.query_string === 'string') {
        event.request.query_string = scrubUrl('&' + event.request.query_string).slice(1);
      }
      // R3-C4 + R4-M8: scrub transcript-shaped fields from every channel.
      // User conversation content (Gemini outputTranscription text, Cartesia
      // transcripts, Hume SnippetAudioChunk.text) must NEVER reach Sentry.
      // Single helper applied at every surface — extras, contexts,
      // breadcrumbs[].data, message, exception.values[].value.
      scrubTranscriptKeys(event.extra);
      scrubTranscriptKeys(event.contexts);
      if (Array.isArray(event.breadcrumbs)) {
        for (const b of event.breadcrumbs) {
          if (b && typeof b === 'object') {
            scrubTranscriptKeys(b.data);
            if (typeof b.message === 'string') b.message = scrubUrl(stripLikelyTranscript(b.message));
            // Vuk-C1 / R2-M1: breadcrumb data.url frequently embeds the WS URL
            // on connect failures. Scrub query-string secrets explicitly.
            // Audit C4 fix (2026-05-13): also scrub data.to (3xx redirect
            // breadcrumbs land the target URL there, not in data.url).
            if (b.data && typeof b.data === 'object') {
              if (typeof b.data.url === 'string') b.data.url = scrubUrl(b.data.url);
              if (typeof b.data.to  === 'string') b.data.to  = scrubUrl(b.data.to);
              if (typeof b.data.from === 'string') b.data.from = scrubUrl(b.data.from);
            }
          }
        }
      }
      if (typeof event.message === 'string') event.message = scrubUrl(stripLikelyTranscript(event.message));
      // HUME_TTS_PLAN §2.0 step 2 / R2-M1: Hume forces api_key into the WS
      // URL query string. The `ws` library stringifies that URL into
      // exception.value AND into stacktrace context lines on ECONNREFUSED
      // / ENOTFOUND. Scrub both before send. Cartesia path doesn't carry
      // secrets in error messages (uses X-API-Key header) but this scrub
      // is provider-agnostic — runs on every captured exception.
      if (event.exception?.values) {
        for (const v of event.exception.values) {
          if (typeof v?.value === 'string') v.value = scrubUrl(stripLikelyTranscript(v.value));
          if (v?.stacktrace?.frames) {
            for (const f of v.stacktrace.frames) {
              if (typeof f?.context_line === 'string') f.context_line = scrubUrl(f.context_line);
              if (Array.isArray(f?.pre_context))  f.pre_context  = f.pre_context.map((s) => typeof s === 'string' ? scrubUrl(s) : s);
              if (Array.isArray(f?.post_context)) f.post_context = f.post_context.map((s) => typeof s === 'string' ? scrubUrl(s) : s);
            }
          }
        }
      }
      // HUME_TTS_PLAN audit C4 fix (2026-05-13): defense-in-depth — walk
      // the whole event tree and scrub any string that LOOKS like it
      // contains api_key=/access_token=/ticket= regardless of where it
      // appears (custom request fields, integration-injected metadata,
      // nested context object Sentry adds via getCurrentScope, etc.).
      // The field-specific scrubs above catch the common channels; this
      // is the belt-and-suspenders for everything else.
      scrubSecretsDeep(event);
      return event;
    },
  });
  console.log('[sentry] initialized');
} else {
  console.log('[sentry] SENTRY_DSN unset — capture is no-op');
}

// Vuk-C1 / HUME_TTS_PLAN §2.0 step 1: scrub query-string secrets in URLs.
// Three patterns cover the secret-bearing query params we ever emit:
//   ticket      — voice-proxy WS auth (single-use ticket id)
//   api_key     — Hume WS auth (Hume forces auth into URL; no header path)
//   access_token — Hume alternative auth (documented but unused; defensive)
// Pattern matches each independently so a URL carrying multiple is fully
// scrubbed. Exported for sentry.test.js direct coverage.
export function scrubUrl(s) {
  return String(s)
    .replace(/([?&#])ticket=[^&#]+/g,        '$1ticket=[redacted]')
    .replace(/([?&#])api_key=[^&#]+/g,       '$1api_key=[redacted]')
    .replace(/([?&#])access_token=[^&#]+/g,  '$1access_token=[redacted]');
}

// HUME_TTS_PLAN audit C4 fix (2026-05-13): tree-walk secret scrub. Applied
// AFTER all field-specific scrubs as defense-in-depth. Catches the case
// where a Sentry integration we don't control (RequestData, Node context,
// Express middleware, etc.) embeds the WS URL into a field we forgot to
// list explicitly. Cycles are unlikely in Sentry event payloads (JSON-
// serializable by contract) but we track visited objects to be safe.
export function scrubSecretsDeep(root, seen = new WeakSet()) {
  if (!root || typeof root !== 'object') return root;
  if (seen.has(root)) return root;
  seen.add(root);
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      const v = root[i];
      if (typeof v === 'string') {
        // Only run the regex when the string contains a delimiter — cheap
        // pre-check avoids regexing every stack frame line.
        if (v.includes('api_key=') || v.includes('access_token=') || v.includes('ticket=')) {
          root[i] = scrubUrl(v);
        }
      } else if (v && typeof v === 'object') {
        scrubSecretsDeep(v, seen);
      }
    }
    return root;
  }
  for (const k of Object.keys(root)) {
    const v = root[k];
    if (typeof v === 'string') {
      if (v.includes('api_key=') || v.includes('access_token=') || v.includes('ticket=')) {
        root[k] = scrubUrl(v);
      }
    } else if (v && typeof v === 'object') {
      scrubSecretsDeep(v, seen);
    }
  }
  return root;
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
  // HUME_TTS_PLAN §2.0.1 / Vuk-C2: Hume's SnippetAudioChunk envelope
  // carries a `text` field on EVERY audio chunk = the avatar-spoken
  // transcript fragment. Generic `text` is too broad to denylist; pin
  // the Hume-specific aliases the bridge MUST use when logging chunk
  // metadata. NO `JSON.stringify(msg)` allowed in hume-bridge.js
  // (enforced by CI grep — see plan §2.0.1).
  'hume_chunk_text',
  'humechunktext',
  'snippet_text',
  'snippettext',
  'snippetaudiochunk_text',
  'snippetaudiochunktext',
  'hume_text',
  'humetext',
  // HUME_TTS_PLAN §4 audit C5 (2026-05-13): cartesia-bridge.js + hume-bridge.js
  // BOTH emit `textSample` on error events for ops diagnostics. The field
  // value is user transcript content — the offending text we sent that
  // Cartesia/Hume rejected. Pre-existing Cartesia leak (line 492); newly
  // introduced in Hume. Lowercased full-key set membership covers both
  // `textSample` and `text_sample`.
  'textsample',
  'text_sample',
  // HUME_TTS_PLAN unit-wide audit M5 (2026-05-13): the bridge emits
  // `humeMessage` on error events. For E0101/payload_parse the bridge
  // sanitizes to literal 'hume_payload_parse'. For other codes mapped to
  // 'other' the bridge passes Hume's verbatim message (bounded 200 chars).
  // If Hume ever adds an error code that echoes client input in the
  // message field, those 200 chars are user content. Defense-in-depth:
  // redact at Sentry layer.
  'humemessage',
  'hume_message',
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
