// narrative-chunk.real-api.test.ts — gated real-API integration test for the
// v3 per-section narrative chunker (narrativeChunkSection).
//
// WHY THIS EXISTS (CLEANUP_BACKLOG "model-pin validation" M5)
//   The narrative-chunk.test.ts unit suite mocks @google/genai, so it proves
//   the WIRING (retry contract, schema shape, sanitize pass) but NOT that the
//   pinned model `gemini-3.1-flash-lite` actually:
//     (a) binds the SDK `responseSchema` for the section call (a model that
//         can't would drift on shape → schema_violation → null → the route's
//         verbatim fallback fires every section, silently degrading quality);
//     (b) honors `thinkingLevel: MINIMAL` (the isV3 branch) without erroring;
//     (c) returns VERBATIM-enough units that clear the production coverage
//         gate (section-coverage.ts) rather than summarizing the words away.
//   This is the chunker analogue of the voice-provider real-API gate CLAUDE.md
//   mandates ("catches silent model deprecation"). It re-runs the one-off
//   validation done by hand on 2026-05-31, but as a committed regression.
//
// HOW IT'S GATED — skipped unless BOTH:
//     RUN_REAL_API_TESTS=1
//     GEMINI_API_KEY   (real)
//   With either missing the suite logs why + skips (stays green in CI/normal
//   vitest). NARRATIVE_CHUNK_MODEL override is honored if set (so this also
//   validates whatever model a future swap pins), else the code default
//   gemini-3.1-flash-lite.
//
// COST: ~$0.0005 (one ~1.5K-token section in, ~1.5K-token JSON out on
//   3.1-flash-lite $0.25/$1.50 per 1M). Safe to bake into the real-API CI lane.
//
// RUN
//   bash:       RUN_REAL_API_TESTS=1 GEMINI_API_KEY=… npx vitest run src/lib/voice/narrative-chunk.real-api.test.ts
//   powershell: $env:RUN_REAL_API_TESTS='1'; $env:GEMINI_API_KEY='…'; npx vitest run src/lib/voice/narrative-chunk.real-api.test.ts

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { narrativeChunkSection, NARRATIVE_CHUNK_MODEL } from './narrative-chunk';
import { sanitizeForLLMPrompt } from './preprocess';
import {
  sectionCoverage,
  coveragePasses,
  isCoverageMeasurable,
} from './section-coverage';

const REAL = process.env.RUN_REAL_API_TESTS === '1';
const GEMINI = process.env.GEMINI_API_KEY;
const ENABLED = !!(REAL && GEMINI);

if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.log(
    `[real-api] narrative-chunk skipped — RUN_REAL_API_TESTS=${REAL ? '1' : '0'} ` +
      `GEMINI_API_KEY=${GEMINI ? 'set' : 'missing'}`,
  );
}

const maybeDescribe = ENABLED ? describe : describe.skip;

// A real book section — same corpus the eval harness + the 2026-05-31 manual
// probe used. Bounded to ~6K chars (well under the route's 32K cap and the
// section-segment.ts token budget) so the call is cheap + the JSON can't
// truncate. Path is resolved relative to THIS file so the test is CWD-agnostic.
function loadSection(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const corpus = `${here}../../../scripts/aod_test_corpus/module-01-sisyphus-job.txt`;
  return readFileSync(corpus, 'utf8').slice(0, 6000);
}

maybeDescribe('narrativeChunkSection real-API (pinned model binds responseSchema)', () => {
  it('returns Flash units + title + summary that clear the production coverage gate', async () => {
    // eslint-disable-next-line no-console
    console.log(`[real-api] narrative-chunk model = ${NARRATIVE_CHUNK_MODEL}`);
    const sanitizedSection = sanitizeForLLMPrompt(loadSection());

    const result = await narrativeChunkSection({
      sanitizedSection,
      sampleTitle: 'Acres of Diamonds',
      sectionCue: 'Module 1',
    });

    // Non-null ⇒ Flash bound responseSchema + parsed + cleared Zod on attempt
    // 1 or 2. Null would mean BOTH attempts failed (the route would substitute
    // verbatim) — a regression for this model.
    expect(result).not.toBeNull();
    expect(result!.units.length).toBeGreaterThan(0);
    expect(result!.sectionTitle.length).toBeGreaterThan(0);
    expect(result!.sectionSummary.length).toBeGreaterThan(0);
    // usage surfaced ⇒ the SDK round-trip happened (cogs accounting depends on it).
    expect(result!.usage.total_token_count).toBeGreaterThan(0);

    // The route's quality gate: did the model KEEP the words (verbatim units)
    // or summarize them away? This is the exact check that decides Flash-units
    // vs verbatim fallback in narrative-chunk-section/route.ts.
    const coverage = sectionCoverage(
      sanitizedSection,
      result!.units.map((u) => u.text),
    );
    // eslint-disable-next-line no-console
    console.log(
      `[real-api] attempt=${result!.attempt} units=${result!.units.length} ` +
        `coverage lengthRatio=${coverage.lengthRatio.toFixed(4)} ` +
        `trigram=${coverage.trigramContainment.toFixed(4)}`,
    );
    expect(isCoverageMeasurable(sanitizedSection)).toBe(true);
    expect(coveragePasses(coverage)).toBe(true);
  }, 60_000);
});
