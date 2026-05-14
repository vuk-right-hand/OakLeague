// build-injection-envelope-drift.test.ts — Day-13 audit M1.
//
// Asserts byte-identical output between:
//   src/lib/voice/build-injection-envelope.ts       (canonical TS)
//   server/voice-proxy/build-injection-envelope.js  (proxy JS mirror)
//
// vitest resolves the .js file as a plain ESM module — no transpile. The
// fixture suite covers parity-critical edge cases. Nonce is fixed so the
// random branch in makeNonce() doesn't bust equality.

import { describe, it, expect } from 'vitest';
import {
  buildInjectionEnvelope as buildTS,
  type RetrievedPassage,
} from './build-injection-envelope';
// @ts-expect-error — JS mirror has no .d.ts; runtime shape is identical.
import { buildInjectionEnvelope as buildJS } from '../../../server/voice-proxy/build-injection-envelope.js';

const NONCE = 'abc123';
const INJECTION_MAX_BYTES = 4096;

type Fixture = { name: string; passages: RetrievedPassage[] };

const FIXTURES: Fixture[] = [
  { name: 'empty', passages: [] },
  {
    name: 'single-small-no-title',
    passages: [{ text: 'hello world from the corpus.', sourceType: 'transcript' }],
  },
  {
    name: 'single-small-with-title',
    passages: [
      {
        text: 'hello world from the corpus.',
        sourceType: 'transcript',
        title: 'Twins Story',
      },
    ],
  },
  {
    name: 'multi-three-passages',
    passages: [
      {
        text: 'first body. discipline matters in everything.',
        sourceType: 'transcript',
        score: 0.9,
      },
      {
        text: 'second body. negative visualization helps.',
        sourceType: 'book_or_doc',
        score: 0.8,
        title: 'Letters',
      },
      {
        text: 'third body. action follows thought.',
        sourceType: 'youtube',
        score: 0.7,
      },
    ],
  },
  {
    name: 'oversize-60kb-mixed-scores',
    passages: [
      { text: 'X'.repeat(20_000), sourceType: 'transcript', score: 0.5 },
      { text: 'Y'.repeat(20_000), sourceType: 'transcript', score: 0.4 },
      { text: 'Z'.repeat(20_000), sourceType: 'transcript', score: 0.9 },
    ],
  },
  {
    name: 'score-undefined-treated-as-infinity',
    passages: [
      { text: 'A'.repeat(15_000), sourceType: 'transcript' },
      { text: 'B'.repeat(15_000), sourceType: 'transcript', score: 0.1 },
    ],
  },
  {
    name: 'unicode-multibyte',
    passages: [
      {
        text: '— smart quote, em-dash, 日本語の文章を含む corpus excerpt.',
        sourceType: 'transcript',
      },
    ],
  },
  {
    name: 'large-single-passage-near-cap',
    passages: [
      { text: 'L'.repeat(INJECTION_MAX_BYTES), sourceType: 'transcript' },
    ],
  },
  {
    name: 'empty-string-filtered-out',
    passages: [
      { text: '', sourceType: 'transcript' },
      { text: 'valid body here', sourceType: 'transcript' },
    ],
  },
  {
    name: 'long-title-truncated-to-80',
    passages: [
      {
        text: 'body text.',
        sourceType: 'transcript',
        title: 'A'.repeat(200),
      },
    ],
  },
];

// Day-13 audit-build M1 — randomness divergence regression.
// makeNonce() in both mirrors uses randomBytes(3).toString('hex') = 6
// chars. If a future change to ONE mirror swaps to randomBytes(4) (8
// chars), every envelope above shifts by 2 bytes — wrapper math drifts
// across mirrors but the fixed-nonce parity test would still pass.
// Assert the structural property: nonce LENGTH equal across paths.
describe('build-injection-envelope nonce length parity', () => {
  it('both mirrors produce same-length nonce when omitted', () => {
    const ts = buildTS({ passages: [{ text: 'x', sourceType: 'transcript' }] });
    const js = buildJS({ passages: [{ text: 'x', sourceType: 'transcript' }] });
    expect(js.nonce.length).toBe(ts.nonce.length);
    expect(js.nonce.length).toBe(6); // current contract
  });
});

describe('build-injection-envelope TS↔JS drift', () => {
  for (const f of FIXTURES) {
    it(`parity: ${f.name}`, () => {
      const ts = buildTS({ passages: f.passages, nonce: NONCE });
      const js = buildJS({ passages: f.passages, nonce: NONCE });
      expect({
        text: js.text,
        nonce: js.nonce,
        passageCount: js.passageCount,
        truncatedPassageIndices: js.truncatedPassageIndices,
        oversize: js.oversize,
        droppedPassages: js.droppedPassages,
      }).toEqual({
        text: ts.text,
        nonce: ts.nonce,
        passageCount: ts.passageCount,
        truncatedPassageIndices: ts.truncatedPassageIndices,
        oversize: ts.oversize,
        droppedPassages: ts.droppedPassages,
      });
    });
  }
});
