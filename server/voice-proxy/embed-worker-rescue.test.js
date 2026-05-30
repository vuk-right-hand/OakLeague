// Unit tests for the v3 ingest "no silent word-loss" helpers in embed-worker.js
// (audit round-2 M3 — the rescue/pre-screen logic owns the moat guarantee and
// previously had zero coverage). Pure functions, no supabase/Flash needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasWordContent, chunkUnitWithRescue, MAX_UNITS_PER_SECTION } from './embed-worker.js';

const wordChars = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]/gu) ?? []).join('');

test('hasWordContent: true iff a letter or number is present', () => {
  assert.equal(hasWordContent('hello'), true);
  assert.equal(hasWordContent('42'), true);
  assert.equal(hasWordContent('日本語'), true);          // CJK
  assert.equal(hasWordContent('Привет'), true);          // Cyrillic
  assert.equal(hasWordContent('--- *** ... ||| '), false);
  assert.equal(hasWordContent('   \n\t  '), false);
  assert.equal(hasWordContent(''), false);
  assert.equal(hasWordContent(null), false);
});

test('chunkUnitWithRescue: word-content unit ALWAYS yields >=1 child (the C1 guarantee)', () => {
  const inputs = [
    'A normal paragraph of prose with several words in it.',
    'oneword',
    'x',                                   // single word char
    'a\n\nb\n\nc',                         // multi-paragraph
    '   spaced   out   words   here   ',
    'Sell the trip, not the plane.',       // short aphorism
    'word. '.repeat(500),                  // long → multiple children
  ];
  for (const text of inputs) {
    const { children } = chunkUnitWithRescue(text, ['topic-a']);
    assert.ok(children.length >= 1, `expected >=1 child for: ${JSON.stringify(text.slice(0, 30))}`);
    // No word-character of the input is lost across the children.
    const joined = wordChars(children.map((c) => c.text).join(''));
    assert.equal(joined, wordChars(text), 'children must cover all word chars');
    // Children carry the topic tags + a token_count (chunkSample shape parity).
    for (const c of children) {
      assert.deepEqual(c.topic_tags, ['topic-a']);
      assert.ok(c.token_count >= 1);
    }
  }
});

test('chunkUnitWithRescue: whitespace/empty unit yields [] (nothing to lose)', () => {
  for (const text of ['   \n\n  ', '', '\t\t', null, undefined]) {
    const { children, rescued } = chunkUnitWithRescue(text, ['t']);
    assert.deepEqual(children, []);
    assert.equal(rescued, false);
  }
});

test('chunkUnitWithRescue: punctuation-only unit is chunked normally (not dropped — no word loss either way)', () => {
  // chunkSample produces a chunk for non-whitespace text, so a punctuation-only
  // UNIT inside a word-bearing section is embedded as a (low-signal) chunk, not
  // lost. The rescue branch is only for the (near-unreachable) chunker-empty +
  // word-content case. Either way: nothing with words is ever dropped.
  const { children } = chunkUnitWithRescue('--- *** ...', ['t']);
  assert.equal(children.length, 1);
});

test('chunkUnitWithRescue: normal prose is not flagged as rescued', () => {
  const { rescued } = chunkUnitWithRescue('A perfectly normal sentence here.', ['t']);
  assert.equal(rescued, false);
});

test('MAX_UNITS_PER_SECTION stays under the unit_index stride (10000)', () => {
  assert.ok(MAX_UNITS_PER_SECTION < 10000);
});
