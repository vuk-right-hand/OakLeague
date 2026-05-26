// R3-C4 + R4-M8 — Sentry scrub fixture coverage.
//
// We don't init Sentry here (no DSN). Instead we test the helpers directly
// — they're pure and exported precisely so this test exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubTranscriptKeys, stripLikelyTranscript, scrubUrl, scrubSecretsDeep } from './sentry.js';

test('scrubTranscriptKeys redacts allowlisted transcript-shaped keys', () => {
  const obj = {
    sessionId: 'abc',
    transcript: 'hello world',
    outputTranscript: 'hello',
    chunkText: 'foo',
    prompt: 'system instruction',
    responseBody: 'raw json',
    user_message: 'hi',
    safe: 42,
  };
  scrubTranscriptKeys(obj);
  assert.equal(obj.sessionId, 'abc');
  assert.equal(obj.transcript, '[redacted]');
  assert.equal(obj.outputTranscript, '[redacted]');
  assert.equal(obj.chunkText, '[redacted]');
  assert.equal(obj.prompt, '[redacted]');
  assert.equal(obj.responseBody, '[redacted]');
  assert.equal(obj.user_message, '[redacted]');
  assert.equal(obj.safe, 42);
});

test('S-C5: substring-shaped keys (pretext, subtext, context_text) are NOT redacted', () => {
  const obj = {
    pretext: 'safe',
    subtext: 'safe',
    context_text: 'safe', // not in denylist; substring 'text' alone is too broad
    nextAttempts: 5,
    contextId: 'abc',
  };
  scrubTranscriptKeys(obj);
  assert.equal(obj.pretext, 'safe');
  assert.equal(obj.subtext, 'safe');
  assert.equal(obj.context_text, 'safe');
  assert.equal(obj.nextAttempts, 5);
  assert.equal(obj.contextId, 'abc');
});

test('scrubTranscriptKeys recurses into nested contexts', () => {
  const obj = { runtime: { node: '20', transcript: 'leak' }, list: [{ chunkText: 'leak2' }] };
  scrubTranscriptKeys(obj);
  assert.equal(obj.runtime.transcript, '[redacted]');
  assert.equal(obj.list[0].chunkText, '[redacted]');
  assert.equal(obj.runtime.node, '20');
});

test('scrubTranscriptKeys handles null + non-object inputs without throwing', () => {
  assert.doesNotThrow(() => scrubTranscriptKeys(null));
  assert.doesNotThrow(() => scrubTranscriptKeys(undefined));
  assert.doesNotThrow(() => scrubTranscriptKeys('a string'));
});

// ── scrubUrl coverage — Vuk-C1 / HUME_TTS_PLAN §2.0 ────────────────────────

test('scrubUrl redacts ticket query param (existing contract — regression guard)', () => {
  const u = 'wss://oakleague-voice-proxy.fly.dev/voice/spike-a?ticket=550e8400-e29b-41d4-a716-446655440000&model=gemini';
  const out = scrubUrl(u);
  assert.ok(!out.includes('550e8400'), 'ticket value leaked');
  assert.ok(out.includes('ticket=[redacted]'));
  assert.ok(out.includes('model=gemini'), 'non-secret params preserved');
});

test('scrubUrl redacts api_key query param (Hume WS auth pattern)', () => {
  const u = 'wss://api.hume.ai/v0/tts/stream/input?version=2&api_key=hume_sk_U2ZvjxjeirTfLiLe9876543210abcdef&format_type=pcm';
  const out = scrubUrl(u);
  assert.ok(!out.includes('hume_sk_'), 'Hume API key leaked through scrubUrl');
  assert.ok(!out.includes('U2Zvjxjei'), 'partial key chars leaked');
  assert.ok(out.includes('api_key=[redacted]'));
  assert.ok(out.includes('version=2'));
  assert.ok(out.includes('format_type=pcm'));
});

test('scrubUrl redacts api_key when it is the LAST query param', () => {
  // Hume's actual buildUrl() in hume-bridge.js appends api_key last; the
  // [^&#]+ pattern must terminate cleanly at end-of-string, not just at & or #.
  const u = 'wss://api.hume.ai/v0/tts/stream/input?version=2&instant_mode=true&api_key=secret-trailing-key-value';
  const out = scrubUrl(u);
  assert.ok(!out.includes('secret-trailing'), 'trailing api_key leaked');
  assert.ok(out.endsWith('api_key=[redacted]'));
});

test('scrubUrl redacts access_token (Hume alternative auth, defensive)', () => {
  const u = 'wss://api.hume.ai/v0/tts/stream/input?access_token=oauth-token-12345&version=2';
  const out = scrubUrl(u);
  assert.ok(!out.includes('oauth-token-12345'));
  assert.ok(out.includes('access_token=[redacted]'));
});

test('scrubUrl redacts MULTIPLE secret params in one URL', () => {
  // Defensive: if a future URL ever carries ticket AND api_key (unlikely
  // but possible if a worker hits the proxy + an upstream simultaneously),
  // both must be scrubbed in a single pass.
  const u = 'wss://example.com/x?ticket=t-secret&api_key=k-secret&access_token=a-secret';
  const out = scrubUrl(u);
  assert.ok(!out.includes('t-secret'));
  assert.ok(!out.includes('k-secret'));
  assert.ok(!out.includes('a-secret'));
  assert.equal((out.match(/\[redacted\]/g) || []).length, 3);
});

test('scrubUrl handles errors from ws library (URL embedded in error message)', () => {
  // Real ws library failure mode: e.message = 'connect ECONNREFUSED <url>'
  // The proxy beforeSend pipes exception.value through scrubUrl precisely
  // for this case. Verify the regex still matches when surrounded by prose.
  const msg = 'Error: connect ECONNREFUSED wss://api.hume.ai/v0/tts/stream/input?api_key=hume_sk_REAL_KEY at TCPConnectWrap.afterConnect';
  const out = scrubUrl(msg);
  assert.ok(!out.includes('hume_sk_REAL_KEY'), 'API key leaked through error-message scrub');
  assert.ok(out.includes('api_key=[redacted]'));
});

test('scrubUrl is idempotent (re-scrubbing a scrubbed URL is a no-op)', () => {
  const u = 'wss://api.hume.ai/x?api_key=secret&ticket=t';
  const once = scrubUrl(u);
  const twice = scrubUrl(once);
  assert.equal(once, twice);
});

test('scrubUrl handles non-string input without throwing', () => {
  assert.equal(scrubUrl(null), 'null');
  assert.equal(scrubUrl(undefined), 'undefined');
  assert.equal(scrubUrl(42), '42');
});

// ── Hume TRANSCRIPT_KEYS coverage — Vuk-C2 / HUME_TTS_PLAN §2.0.1 ──────────

test('scrubTranscriptKeys redacts Hume SnippetAudioChunk text aliases', () => {
  // The bridge MUST use one of these keys when logging chunk-derived data;
  // the generic `text` key stays unscrubbed (too broad — would false-positive
  // on unrelated fields). Pattern: lowercased full-key match.
  const obj = {
    hume_chunk_text: 'leak the user words',
    humeChunkText:   'leak via camelCase',
    snippet_text:    'leak via snake_case',
    snippetText:     'leak via camelCase',
    snippetAudioChunk_text: 'leak via mixed',
    hume_text:       'leak via short alias',
    humeText:        'leak via camelCase short',
    // negative controls — these must NOT be redacted
    type:            'audio',
    generation_id:   '550e8400-e29b-41d4-a716-446655440000',
    chunkIndex:      0,
  };
  scrubTranscriptKeys(obj);
  assert.equal(obj.hume_chunk_text,            '[redacted]');
  assert.equal(obj.humeChunkText,              '[redacted]');
  assert.equal(obj.snippet_text,               '[redacted]');
  assert.equal(obj.snippetText,                '[redacted]');
  assert.equal(obj.snippetAudioChunk_text,     '[redacted]');
  assert.equal(obj.hume_text,                  '[redacted]');
  assert.equal(obj.humeText,                   '[redacted]');
  assert.equal(obj.type,          'audio');
  assert.equal(obj.generation_id, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(obj.chunkIndex,    0);
});

test('C5: scrubTranscriptKeys redacts textSample / text_sample (both bridges emit this on errors)', () => {
  // cartesia-bridge.js:492 + hume-bridge.js both attach the offending
  // outbound transcript fragment to error events as `textSample` for ops
  // diagnostics. The field IS user content; if it flows through Sentry
  // unredacted, captureException leaks transcript.
  const obj = {
    code: 'bad_voice_id',
    fatal: true,
    textSample: 'CARTESIA_LEAK_VIA_TEXTSAMPLE',
    text_sample: 'HUME_LEAK_VIA_SNAKE_CASE',
    safe: 'keep me',
  };
  scrubTranscriptKeys(obj);
  assert.equal(obj.textSample, '[redacted]');
  assert.equal(obj.text_sample, '[redacted]');
  assert.equal(obj.safe, 'keep me');
});

test('M5: scrubTranscriptKeys redacts humeMessage / hume_message (defense-in-depth for future codes that echo client input)', () => {
  // Unit-wide audit M5: HumeTTSBridge sanitizes E0101 messages, but maps
  // unknown codes to 'other' and passes Hume's verbatim message (bounded
  // 200 chars). If a future Hume code echoes user input in `message`,
  // those 200 chars are transcript content. Redact at Sentry layer.
  const obj = {
    code: 'other',
    fatal: true,
    humeMessage: 'rate_limited at request including USER_TRANSCRIPT_LEAK',
    hume_message: 'snake_case alias also denylisted',
    humeCode: 'EXYZ',
    humeSlug: 'safe-slug',
  };
  scrubTranscriptKeys(obj);
  assert.equal(obj.humeMessage, '[redacted]');
  assert.equal(obj.hume_message, '[redacted]');
  // Code + slug remain — they're metadata, not user content.
  assert.equal(obj.humeCode, 'EXYZ');
  assert.equal(obj.humeSlug, 'safe-slug');
});

test('scrubTranscriptKeys does NOT redact generic `text` key (intentional — too broad)', () => {
  // Documenting the boundary: a bare `text` field is allowed. The bridge
  // is responsible for never putting chunk text under that key. Use the
  // hume_ aliases or snippet_ aliases above when the value is sensitive.
  const obj = { text: 'this could be anything safe', humeText: 'this is the leak channel' };
  scrubTranscriptKeys(obj);
  assert.equal(obj.text, 'this could be anything safe');
  assert.equal(obj.humeText, '[redacted]');
});

test('S-C5: stripLikelyTranscript is now a no-op (regex was too eager)', () => {
  // Regression guard: make sure no caller depends on the old redaction
  // behavior. UUIDs, stack traces, and Cartesia error strings come
  // through unchanged.
  const samples = [
    'connect_timeout: open exceeded 10s',
    '550e8400-e29b-41d4-a716-446655440000-and-more-than-100-printable-ascii-characters',
    'x'.repeat(150),
  ];
  for (const s of samples) assert.equal(stripLikelyTranscript(s), s);
  assert.equal(stripLikelyTranscript(42), 42);
  assert.equal(stripLikelyTranscript(null), null);
});

// ── C4 fix: tree-walking secret scrub + breadcrumb/request_string coverage ──

test('C4: scrubSecretsDeep redacts api_key in arbitrarily nested objects', () => {
  // Sentry integrations sometimes shove the WS URL into custom request
  // fields, frame.vars, or context objects we don't enumerate. The tree
  // walker is the safety net.
  const event = {
    contexts: {
      runtime: { node: '20', boot_url: 'wss://api.hume.ai/x?api_key=hume_sk_NESTED_LEAK' },
    },
    extra: {
      retry_chain: [
        { attempt: 1, url: 'wss://api.hume.ai/x?api_key=hume_sk_DEEP_LEAK&v=2' },
        { attempt: 2, msg: 'fine — no secret here' },
      ],
    },
    custom_field: 'connect: wss://example.com/?ticket=secret-ticket-id failed',
  };
  scrubSecretsDeep(event);
  assert.ok(!JSON.stringify(event).includes('hume_sk_NESTED_LEAK'));
  assert.ok(!JSON.stringify(event).includes('hume_sk_DEEP_LEAK'));
  assert.ok(!JSON.stringify(event).includes('secret-ticket-id'));
  // Non-secret data preserved
  assert.equal(event.contexts.runtime.node, '20');
  assert.equal(event.extra.retry_chain[1].msg, 'fine — no secret here');
});

test('C4: scrubSecretsDeep skips strings that do not contain delimiters (perf guard)', () => {
  // The fast-path `includes()` check must not match unrelated content
  // (stack frame paths, error messages without secrets).
  const event = {
    message: 'connect ECONNREFUSED 127.0.0.1:443',
    stack: 'at Object.<anonymous> (/app/server/voice-proxy/hume-bridge.js:42:10)',
  };
  const before = JSON.stringify(event);
  scrubSecretsDeep(event);
  assert.equal(JSON.stringify(event), before);
});

test('C4: scrubSecretsDeep handles cycles without infinite loop', () => {
  const a = { url: 'wss://api.hume.ai/?api_key=hume_sk_CYCLE' };
  const b = { back: a, side: 'safe' };
  a.next = b;
  // Cycle = doesn't infinite-loop. Inspect the scrubbed value directly
  // (can't JSON.stringify a circular object).
  assert.doesNotThrow(() => scrubSecretsDeep(a));
  assert.ok(!a.url.includes('hume_sk_CYCLE'));
  assert.ok(a.url.includes('api_key=[redacted]'));
  assert.equal(b.side, 'safe');
});

test('C4: scrubSecretsDeep handles null/non-object inputs', () => {
  assert.doesNotThrow(() => scrubSecretsDeep(null));
  assert.doesNotThrow(() => scrubSecretsDeep(undefined));
  assert.doesNotThrow(() => scrubSecretsDeep('a string'));
  assert.doesNotThrow(() => scrubSecretsDeep(42));
});

test('C4: scrubSecretsDeep redacts secrets in array elements', () => {
  // Sentry's stacktrace.frames and breadcrumbs[] are arrays.
  const arr = [
    'wss://api.hume.ai/x?api_key=hume_sk_IN_ARRAY',
    { nested: 'wss://other?ticket=array-ticket' },
    'unrelated',
  ];
  scrubSecretsDeep(arr);
  assert.ok(!JSON.stringify(arr).includes('hume_sk_IN_ARRAY'));
  assert.ok(!JSON.stringify(arr).includes('array-ticket'));
  assert.equal(arr[2], 'unrelated');
});
