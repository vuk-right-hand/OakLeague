// R3-C4 + R4-M8 — Sentry scrub fixture coverage.
//
// We don't init Sentry here (no DSN). Instead we test the helpers directly
// — they're pure and exported precisely so this test exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubTranscriptKeys, stripLikelyTranscript } from './sentry.js';

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
