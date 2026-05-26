# OakLeague RAG SOTA — Phase 2 Ship Handoff

**Status**: code-complete on branch `rag-sota-phase-2-days-8-12`. Awaiting
proxy-shim wiring (Day-13) + merge to main + dogfood gate (Days-15/16/17
per RAG_SOTA_PLAN.md §10).

> ⚠️ **MERGING THIS BRANCH DOES NOT ROUTE ANY TRAFFIC THROUGH V2.**
> The Fly voice-proxy still imports a v1-only JS mirror
> (`server/voice-proxy/retrieve-knowledge.js`). All Phase-2 TS code is
> **unreachable from the runtime path** until Day-13 ships the HTTP shim
> (§2a). Specifically: setting `creators.retrieval_version=2` on any
> creator BEFORE the shim exists silently bricks their avatar — the v1
> mirror queries `chunker_version=1` chunks that may not exist for a
> v2-reprocessed creator. **Do not flip retrieval_version=2 on any real
> creator before Day-13 lands.** Final-cross audit C3.

**Author**: Claude (Opus 4.7), commissioned by Vuk.
**Date**: 2026-05-14.
**Predecessor**: [`RAG_SOTA_PLAN.md`](./RAG_SOTA_PLAN.md).

---

## 1. What's shipped on the branch

### Day 8 — SQL foundation (8 migrations + 67 pgTAP)

| Migration | Purpose |
|---|---|
| `20260521000001_creators_current_corpus_version_finalize.sql` | `creators.current_corpus_version` + `corpus_reprocess_finalize(p_job_id)` RPC (advisory lock + lock_timeout) |
| `20260521000002_creator_knowledge_topk_v2.sql` | Hybrid retrieval RPC (vector + BM25 + RRF k=60) + `try_build_tsquery` helper |
| `20260521000003_semantic_query_cache.sql` | 16-way HASH-partitioned cache + per-partition HNSW + UNIQUE on `(creator_id, corpus_version, query_text_hash)` + upsert RPC with FOR SHARE check |
| `20260521000004_voice_session_state.sql` | Per-session conversation memory + 7-day pg_cron purge + RLS deny-all |
| `20260521000005_claim_corpus_reprocess_job_advisory_lock.sql` | Adds `pg_advisory_xact_lock` + `lock_timeout='5s'` to claim RPC |
| `20260521000006_sessions_corpus_version_at_session.sql` | Session-open snapshot column |
| `20260521000007_sessions_corpus_version_backfill.sql` | Cross-cutting M1 — backfill OPEN sessions whose creator has advanced past 1 |
| `20260521000008_semantic_cache_first_write_wins.sql` | Day-11-cross M5 — concurrent upserts on same hash bump telemetry only |

### Day 9 — TS modules

| File | Purpose |
|---|---|
| `src/lib/voice/halfvec.ts` | Canonical `vectorToPgText` (throws `VectorEncodingError` on NaN/Infinity) |
| `src/lib/voice/query-rewrite.ts` | Gemini Flash rewriter, `deadlineMs` budget, typed `RewriteFallbackReason`, boot-regex guard |
| `src/lib/voice/semantic-cache.ts` | Day-8 MIG-3 RPC wrappers, `hashQueryText` returns `\x`+hex bytea text, typed `CacheUpsertResult`, VectorEncodingError catch |
| `src/lib/voice/voice-session-state.ts` | Day-8 MIG-4 wrappers, `!== undefined` patch semantics |

### Day 10 — Voyage rerank bridge

| File | Purpose |
|---|---|
| `src/lib/voice/rerank.ts` | `RerankBridge` interface, Voyage-only (Cohere deferred), `performance.now()` monotonic token bucket, synthetic monotonic-decreasing scores on fallback, MAX_CANDIDATES=25, 429 penalizes bucket |

### Day 11 — Orchestrator + telemetry + envelope hardening

| File | Purpose |
|---|---|
| `src/lib/voice/retrieve-knowledge.ts` | v2 hybrid orchestrator (`retrieveKnowledgeV2`). try/finally telemetry flush; cache-hit-zero-fetched fall-through; id-based rerank mapping; embed wrapped in `withDeadline`. Keeps v1 `retrieveTopK` for legacy creators. |
| `src/lib/voice/rag-telemetry.ts` | `RagTurnTelemetry` aggregator + `toCogsLogRows` batch emitter + `flushCogsLogRows` fire-and-forget + `toPostHogEventBatch` event mapping |
| `src/lib/voice/build-injection-envelope.ts` | 32KB hard input ceiling + lowest-score-drop loop + title/score per passage |
| `src/lib/voice/embed.ts` | Pinned `EMBEDDING_QUOTED_AT` |

### Day 12 — Real-API integration test + fixture seed + this doc

| File | Purpose |
|---|---|
| `scripts/seed-rag-test-fixture.mjs` | Idempotent UPSERT of test-fixture creator + sample_content text |
| `src/lib/voice/retrieve-knowledge.real-api.test.ts` | Gated real-API integration test (RUN_REAL_API_TESTS=1) |
| `docs/_planning/RAG_SOTA_PHASE_2_HANDOFF.md` | This doc |

**Test coverage at HEAD**:
- vitest: 929/929 passing (Phase-2-net contribution: +88 cases across Day-9/10/11/12)
- pgTAP: 67/67 passing (all Day-8 suites green)
- tsc: clean
- Real-API integration test: gated; requires manual setup (§4 below)

---

## 2. What's deferred (load-bearing for Day-13+)

### 2a. Proxy-shim wiring (RAG_SOTA_PLAN.md §10 Day-13)

The Day-11 orchestrator is a Next-side module (imports `'server-only'`).
The Fly voice-proxy needs to invoke it once per turn.

**DECISION: Option A (HTTP shim).** Add a Next.js internal API route
`/api/internal/retrieve-knowledge` that wraps `retrieveKnowledgeV2`. Proxy
POSTs `{rawUtterance, lastAssistantResponse, sessionId, creatorId, …}`
per turn over the existing internal-service trust channel, receives
`{parents, telemetry, …}` back.

Rationale:
- Matches the Day-4 contextual-gen pattern (Anthropic-SDK-in-Fly bug from
  2026-05-09 `.claude_learnings.md` makes Fly-side SDK code fragile).
- The orchestrator stays out of the Fly process; canonical TS lives in
  Next. No `.ts` import gymnastics in Node ESM.
- One HTTP hop adds ~50ms over Vercel edge — negligible against the
  4000ms turn budget.
- Future provider swaps (Cohere fallback, embedder upgrade, etc.) ship
  via Vercel deploy without touching Fly.

**Sidebar — Option B (proxy duplicates TS logic) rejected.** Plan §4
line 554 considered it. Cost: 200+ lines of orchestrator re-implementation
in JS, must stay in sync with TS. Re-litigate only if HTTP-hop latency
proves intolerable in load testing.

**Either way the proxy MUST:**
1. Reuse the same `sessions.id` across Gemini Live 15-minute reopens
   (load-bearing contract documented in
   `supabase/migrations/20260521000004_voice_session_state.sql` header).
2. Capture `corpus_version_at_session` from `sessions.corpus_version_at_session`
   at WS-open and carry it as a closure const for every retrieval call.
3. After each turn: persist `lastAssistantResponse` to `voice_session_state`
   (truncated to 2000 chars) via the Day-9 `voice-session-state.ts` wrapper.
4. Emit PostHog events from the returned `telemetry`:
   ```ts
   toPostHogEventBatch(result.telemetry).forEach(e =>
     posthog.capture(e.name, e.properties)
   );
   ```
   Without this, the SLO ("rerank fallback >5% sustained 10min → page")
   is unenforceable. Cross-cutting C4 from the Day-11 audit explicitly
   defers this to the proxy author.
5. Build the injection envelope from `result.parents` and emit
   `rag_envelope_oversize` when `envelope.oversize === true` (cross-cutting
   M6 — the orchestrator does NOT populate `telemetry.envelope`).

### 2b. Pre-launch / future-day work

These are documented in the relevant module headers; collected here for
the proxy/Day-13+ author's reference:

| Item | Where flagged | Why deferred |
|---|---|---|
| **M3 budget-counter split** | `retrieve-knowledge.ts:135-141` | Requires SQL change to split `voice_retrieval_budget_check_and_increment` into check + commit phases. At YC dogfood scale (1 user) the over-counting is theoretical. Pre-launch fix: split + add `decrement_on_failure` RPC. |
| **M4 AbortSignal threading** | `retrieve-knowledge.ts:142-146` | supabase-js v2.45+ supports `.abortSignal()` on `PostgrestFilterBuilder`. Thread `withDeadline`'s timeout signal through every DB call to actually cancel hung queries instead of orphaning them in pgbouncer. |
| **Cohere fallback** | `rerank.ts` header | Single-vendor (Voyage) per Vuk's "no fallback until scale" decision 2026-05-14. Bridge architecture supports drop-in: add `CohereRerankBridge` + widen `assertProviderIsVoyage` allowlist. |
| **PostHog client wiring** | Day-11 audit C4 disposition | Orchestrator returns telemetry; caller emits. Day-13 proxy author wires the PostHog server-side client. |

### 2c. Phase-2.5 measurement gate (RAG_SOTA_PLAN.md §11b)

After v2 ships and stabilizes for ~1 week of production traffic, run the
50-question offline A/B against the dogfood corpus to decide whether to
add multi-query expansion. Not blocking the v2 ship.

---

## 3. cogs_log accounting model (Day-11 contract)

Every turn through `retrieveKnowledgeV2` writes **one batch insert** into
`cogs_log` containing zero to three rows:

| Leg | Service | Operation | Fires when |
|---|---|---|---|
| Rewrite | `gemini` | `rewrite` | `inputTokens > 0 OR outputTokens > 0` (skipped when fast-fail fallback with no API call) |
| Embed | `gemini` | `embedding` | `inputTokens > 0` (always on every turn that gets past rewrite) |
| Rerank | `voyage` | `rerank` | `inputTokens > 0` (paid call); also emits marker row with `units=0` + `metadata.token_count_unavailable=true` when Voyage returns success WITHOUT `usage.total_tokens` (response-shape drift detection — Day-11 audit M6) |

**Flush guarantee (Day-11-cross C1):** the orchestrator wraps its body in
`try/finally` and flushes from the `finally`. cogs_log lands on EVERY
return path AND on throws (`embed_failed`, `rpc_failed`, `budget_check_failed`).
Paid telemetry collected before a throw is preserved, not lost.

**No write on budget_exceeded**: when the user hit their 200/day cap, no
paid calls happened → no rows. The Day-13 author SHOULD still emit a
PostHog `rag_budget_exceeded` event (already in `toPostHogEventBatch`)
so admins see the cap-hit signal.

---

## 4. Running the real-API integration test

**Day-0 admin checklist (run ONCE per cluster, before any of this works):**
- `ALTER DATABASE <db> SET app.environment = 'staging'` on staging
  cluster; `'production'` on prod. Verify via fresh psql session:
  `SELECT current_setting('app.environment', true);` returns the
  expected value (see migration `20260515000003` header for rationale).
- Without this, the `purge_test_fixture_rag_data` cron either refuses
  to run (correct on prod) or registers on the wrong cluster.

One-time setup per environment:

```bash
# 1. Seed the test-fixture creator (idempotent — safe to re-run).
#    Day-12 audit C2: refuses to run unless URL matches localhost or
#    /staging\.|--staging|preview\.|-staging-/ pattern. Use
#    --force-non-staging to override (DANGEROUS — production poisoning).
SUPABASE_URL=https://<staging-project>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-secret> \
  node scripts/seed-rag-test-fixture.mjs

# 2. Run the v2 reprocess pipeline. Takes ~30 seconds for this small fixture.
#    Requires Anthropic API key (contextual-gen) + Gemini API key (chunker +
#    embed) in addition to the Supabase secrets. All models pinned:
#      EMBEDDING_MODEL=gemini-embedding-001          (Day-9 embed.ts default)
#      QUERY_REWRITE_MODEL=gemini-2.5-flash          (Day-9 query-rewrite.ts default)
#      ANTHROPIC_MODEL=claude-haiku-4-5-20251001     (CLAUDE.md fixed)
#      VOYAGE_RERANK_MODEL=rerank-2.5                (Day-10 rerank.ts default)
SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
GEMINI_API_KEY=... \
ANTHROPIC_API_KEY=... \
ANTHROPIC_MODEL=claude-haiku-4-5-20251001 \
  node scripts/corpus-reprocess.mjs --creator-id aaaaaaaa-1212-4aaa-a000-000000000001

# 3. Run the integration test.
RUN_REAL_API_TESTS=1 \
SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
GEMINI_API_KEY=... \
VOYAGE_API_KEY=... \
RAG_TEST_CREATOR_ID=aaaaaaaa-1212-4aaa-a000-000000000001 \
  npx vitest run src/lib/voice/retrieve-knowledge.real-api.test.ts
```

**Cost per run**: ~$0.001 (one rewrite + one embed + one rerank, twice
for the cache-hit test). Safe to run on every PR.

**Cleanup**: the daily staging-only pg_cron `purge_test_fixture_rag_data`
wipes chunks + narrative_units + sample_content for `is_test_fixture=true`
creators nightly at 4am UTC. Re-run step 2 to regenerate. The cron is
guarded against firing on production (see migration
`20260515000003_test_fixture_creator.sql` header).

---

## 5. Dogfood gate procedure (RAG_SOTA_PLAN.md §10 Day-15)

After the proxy wiring (Day-13) + cold-deploy (Day-13) + Vuk's staging
re-process (Day-14):

1. **In a single sub-15-min window** (to avoid Gemini Live session
   boundary biasing the M2 resumption test), Vuk runs 20 questions
   against his avatar with `retrieval_version=2`.

2. The 20 questions span 4 buckets (5 each):

   **Direct retrieval** (5) — questions whose exact terms appear in the
   creator's corpus. Tests vector + BM25 lower bound.
   *Example*: "What's the twins story you told about discipline?"

   **Follow-up** (5) — second-turn questions that reference the prior
   assistant turn pronominally. Tests query-rewrite + voice_session_state
   persistence across Gemini Live reopens.
   *Example*: After avatar discusses negative visualization, ask "Tell
   me more about that."

   **Paraphrased** (5) — questions about corpus content using vocabulary
   the corpus doesn't share. Tests contextual-retrieval headers + rerank.
   *Example*: "What's that mental trick where you imagine the worst?"
   (corpus uses "negative visualization", not "imagine the worst").

   **Edge-of-corpus** (5) — questions partially adjacent to the corpus.
   Tests the floor (0.30 min_sim) — relevant matches surface, irrelevant
   matches don't.
   *Example*: "What do you think about poker strategy?" (corpus has
   nothing on poker; avatar should answer persona-only, not hallucinate
   from any vaguely-related parent).

3. **Acceptance**: ≥18/20 retrieves the relevant parent at top-1
   (top-3 for direct retrieval bucket). For edge-of-corpus: ≥4/5 return
   ZERO parents (orchestrator returns `parents: []`; avatar answers from
   persona only).
4. If pass: admin UPDATE `creators.retrieval_version=2` for Vuk only
   (already at 2 if Day-13 flip happened; this confirms).
5. If fail: gather PostHog `rag_rewrite_*` + `rag_rerank_*` event
   breakdowns. Sweep min_sim threshold (currently 0.30) against the
   dogfood fixture and pick by retrieval-quality.
6. 24h monitor (Day-16). Sentry + PostHog clean → green (Day-17).

---

## 6. Audit trail

Every day landed under the SOP — adversary audit + apply findings +
cross-cutting unit audit + apply findings + push.

| Phase | Audit cycles | Findings disposed |
|---|---|---|
| Day 8 (SQL migrations) | 2 (plan + post-build) | 5 Critical, 7 Medium, 8 Small — all applied |
| Day 9 (TS modules) | 2 (Day-9 + Day-8/9 cross) | 4 Critical, 7 Medium, 8 Small — all applied |
| Day 10 (rerank) | 2 (Day-10 + Day-8/9/10 cross) | 4 Critical, 7 Medium, 10 Small — all applied; M3/M4 doc-deferred (SQL change + AbortSignal threading) |
| Day 11 (orchestrator + telemetry + envelope) | 2 (Day-11 + Day-8/9/10/11 cross) | 8 Critical, 14 Medium, 16 Small total — all addressed; M3/M4/M6 documented as deferred |
| Day 12 (this commit) | 2 (Day-12 + Day-8/9/10/11/12 final cross) | 4 Critical (schema mismatch in seed, env guard absent, cache-hit non-determinism, brain_not_ready trap), 6 Medium, 10 Small — all applied or accepted-by-doc |

Critical findings consistently fall into three categories:
1. **Hot-path resource management** (timeouts, abort signals, cogs_log
   flush on throw) — addressed via `withDeadline` + try/finally.
2. **Cross-module contract clarity** (rewrite-fallback cache poisoning,
   cache stale_corpus drift, rerank id-vs-index mapping, NaN-vs-monotonic
   scores) — addressed via prominent header docs + tightened return types.
3. **CLAUDE.md compliance** (paid-call cogs_log, pinned model versions,
   provider-agnostic bridges) — addressed by aggregator type + bridge
   pattern + boot-regex guards.

---

## 7. Files touched (Phase-2 total)

```
supabase/migrations/                                                            8 new
src/lib/voice/halfvec.ts                                                        new
src/lib/voice/halfvec.test.ts                                                   new
src/lib/voice/query-rewrite.ts                                                  new
src/lib/voice/query-rewrite.test.ts                                             new
src/lib/voice/semantic-cache.ts                                                 new
src/lib/voice/semantic-cache.test.ts                                            new
src/lib/voice/voice-session-state.ts                                            new
src/lib/voice/voice-session-state.test.ts                                       new
src/lib/voice/rerank.ts                                                         new
src/lib/voice/rerank.test.ts                                                    new
src/lib/voice/retrieve-knowledge.ts                                             refactored (v1 path preserved)
src/lib/voice/retrieve-knowledge.test.ts                                        refactored
src/lib/voice/retrieve-knowledge.real-api.test.ts                               new
src/lib/voice/rag-telemetry.ts                                                  new
src/lib/voice/rag-telemetry.test.ts                                             new
src/lib/voice/build-injection-envelope.ts                                       extended (32KB ceiling + title/score)
src/lib/voice/build-injection-envelope.test.ts                                  extended
src/lib/voice/embed.ts                                                          extended (pinned EMBEDDING_QUOTED_AT)
supabase/tests/                                                                 4 new pgTAP suites
scripts/seed-rag-test-fixture.mjs                                               new
docs/_planning/RAG_SOTA_PHASE_2_HANDOFF.md                                      this file
```

No proxy / Next-route files touched. Day-13's job.
