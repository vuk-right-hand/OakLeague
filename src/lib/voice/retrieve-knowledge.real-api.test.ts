// retrieve-knowledge.real-api.test.ts — gated real-API integration test
// for the Day-11 hybrid retrieval orchestrator.
//
// WHY THIS EXISTS
//   Unit tests mock @google/genai, fetch, and the Supabase client. Mocks
//   prove the wiring; they do NOT prove that:
//     (a) `gemini-2.5-flash` actually returns the rewrite JSON shape we
//         claim it does (CLAUDE.md "Verify, don't guess")
//     (b) `gemini-embedding-001` returns 768-dim vectors at RETRIEVAL_QUERY
//     (c) Voyage rerank-2.5 maps `index` ↔ caller-supplied id correctly
//     (d) PostgREST handles our `\x`+hex bytea binding (Day-9 audit M7 was
//         caught via JSON.stringify introspection, NOT a real round-trip)
//     (e) the HNSW iterative scan strict_order GUC actually applies under
//         a normal Supabase service-role connection (Day-8-cross C3)
//
// HOW IT'S GATED
//   Skipped unless ALL of:
//     RUN_REAL_API_TESTS=1
//     GEMINI_API_KEY                (real)
//     VOYAGE_API_KEY                (real)
//     SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY  (real)
//     RAG_TEST_CREATOR_ID           (UUID of a test-fixture creator
//                                    populated by scripts/seed-rag-test-
//                                    fixture.mjs + scripts/corpus-
//                                    reprocess.mjs)
//
//   With any of those missing the suite logs the missing pieces and
//   skips — tests stay green in normal vitest runs.
//
// SETUP (one-time per environment)
//   1. node scripts/seed-rag-test-fixture.mjs
//      Creates the fixture creator + sample_content (text only).
//   2. node scripts/corpus-reprocess.mjs --creator-id <id>
//      Runs the v2 reprocess pipeline: narrative_chunk → contextual-gen →
//      embed → insert. Takes ~30s for this small fixture.
//   3. RUN_REAL_API_TESTS=1 RAG_TEST_CREATOR_ID=<id> npx vitest run
//      src/lib/voice/retrieve-knowledge.real-api.test.ts
//
// COST
//   Per test run: ~$0.001 (one rewrite + one embed + one rerank).
//   Safe to run on every PR; bake into CI alongside the existing
//   real-API gates.
//
// FIXTURE CORPUS
//   The seeded transcript contains three narratives the assertions rely on:
//     - "The Twins Story" (escape-velocity-via-environment metaphor)
//     - "On Escape Velocity" (habit formation)
//     - "Negative Visualization" (Stoic mental rehearsal)
//   The test queries against these and asserts top-1 contains the
//   relevant parent.

import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

import { retrieveKnowledgeV2, RAG_TURN_BUDGET_MS_DEFAULT } from './retrieve-knowledge';

const REAL = process.env.RUN_REAL_API_TESTS === '1';
const GEMINI = process.env.GEMINI_API_KEY;
const VOYAGE = process.env.VOYAGE_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_CREATOR_ID = process.env.RAG_TEST_CREATOR_ID;

const ENABLED = !!(REAL && GEMINI && VOYAGE && SUPABASE_URL && SUPABASE_KEY && TEST_CREATOR_ID);

if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.log(
    `[real-api] skipped — RUN_REAL_API_TESTS=${REAL ? '1' : '0'} ` +
      `GEMINI_API_KEY=${GEMINI ? 'set' : 'missing'} ` +
      `VOYAGE_API_KEY=${VOYAGE ? 'set' : 'missing'} ` +
      `SUPABASE_URL=${SUPABASE_URL ? 'set' : 'missing'} ` +
      `SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_KEY ? 'set' : 'missing'} ` +
      `RAG_TEST_CREATOR_ID=${TEST_CREATOR_ID ? 'set' : 'missing'}`,
  );
}

// vitest's `describe.skipIf` skips the whole block but still registers it
// so test counts are predictable.
const maybeDescribe = ENABLED ? describe : describe.skip;

// Day-12 audit M3: UUID prefix switched from 00000000 to aaaaaaaa so test
// fixture rows don't camouflage as nil-adjacent in audit-log greps.
const FIXTURE_USER_ID = 'aaaaaaaa-1212-4aaa-a000-000000000002';

maybeDescribe('retrieveKnowledgeV2 real-API integration', () => {
  const admin = ENABLED
    ? createClient(SUPABASE_URL as string, SUPABASE_KEY as string, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      })
    : null;

  it('round-trips against the test-fixture creator (rewrite + embed + topk + rerank + cache write)', async () => {
    expect(admin).not.toBeNull();
    const testStart = new Date();
    const result = await retrieveKnowledgeV2({
      supabaseAdmin: admin!,
      userId: FIXTURE_USER_ID, // matches scripts/seed-rag-test-fixture.mjs
      creatorId: TEST_CREATOR_ID as string,
      rawUtterance: 'tell me the twins story',
      lastAssistantResponse: null,
      corpusVersionAtSession: 1,
      sessionId: null,
      geminiApiKey: GEMINI as string,
      voyageApiKey: VOYAGE as string,
      deadlineMs: Date.now() + RAG_TURN_BUDGET_MS_DEFAULT,
      topK: 3,
    });

    // Result shape — assert the orchestrator did what it claims.
    expect(result.budgetExceeded).toBe(false);
    expect(result.rewriteFallback).toBe(false);

    // Parents — the fixture has 3 narratives; top-3 must contain the
    // "Twins Story" parent (titled or text-contains). Day-12 audit S3:
    // dropped 'engineer' from regex (too generic — the test corpus uses
    // 'programmer' now anyway).
    expect(result.parents.length).toBeGreaterThanOrEqual(1);
    const topTexts = result.parents.map((p) => `${p.title ?? ''} ${p.text}`.toLowerCase());
    expect(topTexts.some((t) => /twins|brothers|marathoner/.test(t))).toBe(true);

    // Telemetry — every paid leg landed values, no fallback.
    expect(result.telemetry.rewrite?.fallback).toBe(false);
    expect(result.telemetry.rewrite?.inputTokens).toBeGreaterThan(0);
    expect(result.telemetry.embed?.inputTokens).toBeGreaterThan(0);
    expect(result.telemetry.retrieve?.parentsReturned).toBeGreaterThan(0);
    expect(result.telemetry.rerank?.fallback).toBe(false);
    expect(result.telemetry.rerank?.rerankTop1Score).toBeGreaterThan(0);
    expect(result.telemetry.rerank?.inputTokens).toBeGreaterThan(0);
    expect(result.telemetry.cacheHit).toBe(false); // first run = miss

    // Score sanity — Day-15 dogfood gate target is top-1 > 0.70.
    // Allow slack here since the fixture corpus is tiny and rerank scores
    // calibrate against the whole training distribution. Calibrated
    // 2026-05-14 against voyage rerank-2.5.
    expect((result.parents[0].score ?? 0)).toBeGreaterThan(0.30);
    expect(result.parents[0].scoreSource).toBe('rerank');

    // Day-12 audit M6: verify cogs_log actually wrote rows. The
    // orchestrator does void-fire flushCogsLogRows; wait a tick for the
    // promise to schedule + the insert to round-trip.
    await new Promise((r) => setTimeout(r, 400));
    const { data: cogsRows, error: cogsErr } = await admin!
      .from('cogs_log')
      .select('operation, service, user_id, created_at')
      .eq('user_id', FIXTURE_USER_ID)
      .gte('created_at', testStart.toISOString())
      .order('created_at', { ascending: false })
      .limit(10);
    expect(cogsErr).toBeNull();
    const ops = (cogsRows ?? []).map((r: { operation: string }) => r.operation);
    expect(ops).toContain('rewrite');
    expect(ops).toContain('embedding');
    expect(ops).toContain('rerank');
  }, 30_000);

  it('cache hits on the SECOND call for the same rewritten query', async () => {
    expect(admin).not.toBeNull();
    const args = {
      supabaseAdmin: admin!,
      userId: FIXTURE_USER_ID,
      creatorId: TEST_CREATOR_ID as string,
      rawUtterance: 'explain negative visualization',
      lastAssistantResponse: null,
      corpusVersionAtSession: 1,
      sessionId: null,
      geminiApiKey: GEMINI as string,
      voyageApiKey: VOYAGE as string,
      deadlineMs: Date.now() + RAG_TURN_BUDGET_MS_DEFAULT,
      topK: 3,
      // Day-12 audit C3: lower cache threshold for the integration test
      // because Gemini's embedding API isn't bit-exact deterministic
      // across runs of the same input. Production uses default 0.92;
      // the 0.80 here gives the cache-hit assertion robustness against
      // ~0.05 cosine drift while still proving "same query → same row."
      cacheThreshold: 0.80,
    };

    // First call — populates cache.
    const first = await retrieveKnowledgeV2(args);
    expect(first.telemetry.cacheHit).toBe(false);

    // Second call — same rewritten text → cache hit.
    const second = await retrieveKnowledgeV2({
      ...args,
      deadlineMs: Date.now() + RAG_TURN_BUDGET_MS_DEFAULT,
    });
    expect(second.telemetry.cacheHit).toBe(true);
    // No rerank on hit.
    expect(second.telemetry.rerank).toBeNull();
    // Parent IDs match (same cache row resolved).
    const firstIds = first.parents.map((p) => p.parentUnitId).sort();
    const secondIds = second.parents.map((p) => p.parentUnitId).sort();
    expect(secondIds).toEqual(firstIds);
  }, 60_000);

  it('rejects invalid corpus_version up front (no real-API calls)', async () => {
    expect(admin).not.toBeNull();
    await expect(
      retrieveKnowledgeV2({
        supabaseAdmin: admin!,
        userId: FIXTURE_USER_ID,
        creatorId: TEST_CREATOR_ID as string,
        rawUtterance: 'q',
        lastAssistantResponse: null,
        corpusVersionAtSession: 0, // invalid
        sessionId: null,
        geminiApiKey: GEMINI as string,
        voyageApiKey: VOYAGE as string,
        deadlineMs: Date.now() + RAG_TURN_BUDGET_MS_DEFAULT,
      }),
    ).rejects.toMatchObject({ code: 'invalid_corpus_version' });
  });
});
