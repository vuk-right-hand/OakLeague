# SESSION HANDOFF — 2026-05-31 (RAG v3 → prod)

**Read this first on resume.** Single source of truth for picking up exactly where we
paused. Branch `rag-v3-scaling`. Nothing pushed to git (deliberate — Vuk handles push).

Companion docs (all current, all on disk):
- [V3_PROD_CUTOVER_GATE.md](./V3_PROD_CUTOVER_GATE.md) — the v3 prod deploy checklist.
- [M1_M5_PLAN.md](./M1_M5_PLAN.md) — the APPROVED REV 3 plan for the next build unit.
- [CLEANUP_BACKLOG.md](./CLEANUP_BACKLOG.md) — deferred items + the Step-9 audit log.

---

## 1. ONE-PARAGRAPH STATUS

RAG v3 (routed hierarchical retrieval — the moat) is **code-complete through Step 9,
twice-audited, committed as `7e159c1`, NOT pushed, NOT on prod.** We then planned the
two deferred prod-readiness items (M1 worker-claim guard + M5 admin purge/GC UI)
through a full 2-round planning loop; **REV 3 of that plan is APPROVED and the build is
about to start (zero code written yet).** Next concrete action on resume: execute the
M1+M5 build per REV 3 (TDD), then code-audit, then commit. After that: the v3 prod
cutover (deploy migrations + fly + Vercel → calibrate min_sim → re-ingest a creator →
flip-and-test). Everything is additive/dormant until a creator is flipped to
`retrieval_version=3`, so nothing is live for users yet.

---

## 2. WHAT'S COMMITTED — `7e159c1` (Step 9)

"rag(v3): step 9 — soft cutover + generation machinery + rerank cap (2x code-audited)"
16 files. Contents:
- **C1 soft cutover** (mig `20260531000001`): flip TO v3 no longer deletes v1/v2 chunks
  → rollback instant. New `admin_purge_legacy_chunks(creator)` RPC (guarded: refuses
  unless on v3; stamps `creators.legacy_purged_at`).
- **C2/C3 generation machinery** (mig `20260531000002` cols+UNIQUE swaps, `...000003` six
  gen-aware RPCs, `embed-worker.js` rewrite): re-ingest builds gen N+1 alongside live gen
  N; `corpus_reprocess_finalize_v3` swaps `active_section_generation` atomically; all
  readers gen-filtered (correlated scalar preserves HNSW); deferred
  `admin_gc_stale_section_generations` keeps active+prior.
- **C4** rerank `MAX_CANDIDATES` 25→30, boot-asserted vs `DEFAULT_V3_TOP_S × N_PARENT`.
- Audit fixes folded: M2 (post-purge rollback refused via `legacy_purged_at`), M3
  (flat-fallback cap breadcrumb), M4 (gen-scoped readiness check), Smalls.
- **M5 (real-API gated test)** `narrative-chunk.real-api.test.ts` (separate from the
  admin-UI M5 below — naming collision, beware).
- Gates at commit: pgTAP 245 files/1057 tests PASS · voice vitest 527 pass/5 skip · tsc 0 · build green.

Model pin context (`b97bb97`, already committed earlier): gemini-2.5-flash →
3.1-flash-lite for ingest-chunk + query-rewrite; COGS at 3.1-lite rates ($0.25/$1.50/Mtok).

### Working tree right now (since 7e159c1) — verified clean, 3 consistent `git status` reads
HEAD = `7e159c1`. `git status --short` shows EXACTLY:
```
?? docs/_planning/M1_M5_PLAN.md
?? docs/_planning/V3_PROD_CUTOVER_GATE.md
?? scripts/session-cogs-breakdown.mjs
```
(plus this file, `?? docs/_planning/SESSION_HANDOFF_2026-05-31.md`, once written.)
- The 3 `docs/_planning/*.md` are this session's planning docs — safe to keep/commit later.
- **DO NOT TOUCH / DO NOT STAGE** `scripts/session-cogs-breakdown.mjs` (pre-existing untracked WIP, not ours).
- CLEANUP_BACKLOG.md is CLEAN (its Step-9 edits are already in `7e159c1`).
- **NO M1/M5 implementation code exists yet** — the build had not started.

---

## 3. THE BIG PICTURE — what "v3 to prod" actually requires

A `git push` of the branch = backup/PR only, NOT production. Prod runs `main`; v3 is
behind a per-creator `retrieval_version=3` flag that is **dormant** until flipped. The
real cutover is a deliberate, partly-manual, COGS-and-time-bearing sequence. Full
checklist in [V3_PROD_CUTOVER_GATE.md]; phases:

- **Phase 1 (code, NOW):** build M1 + M5 (this is the current unit) so they ship IN the
  v3 deploy.
- **Phase 2 (deploy, all additive/safe pre-flip):** `supabase db push` (20 pending
  migrations) → env already verified (nothing to set) → `fly deploy` → merge to `main`
  for Vercel.
- **Phase 3 (calibrate + rollout):** pin `min_sim` per-mode floors (still placeholders!)
  → re-ingest a creator's corpus through the v3 worker → `creator_v3_ready` → flip scratch
  creator → live "exactly him" voice test at book scale → flip Vuk (creator #1) → widen.

---

## 4. THE APPROVED BUILD UNIT — M1 + M5 (REV 3, approved, NOT started)

Full detail in [M1_M5_PLAN.md] (REV 3). Build order + TDD:

1. **M1 — lightweight zombie-claim helper-guard** (`server/voice-proxy/embed-worker.js`):
   - Add optional `claimedBy` param to `markJobErrored`@683 / `bumpFailure`@698 (the
     `corpus_reprocess_jobs` closure — the SECOND closure; the FIRST closure at 198/213
     is `sample_content_embedding_jobs`, OUT of scope).
   - When passed: `.eq('claimed_by', claimedBy).select('id')`; **0 rows → no-op +
     `captureMessage('reprocess.claim_moved_noop','warning',{...})`**.
   - **Discriminator MUST be `claimed_by`, NOT `enqueue_version`** (round-2 found the
     reaper requeue does NOT bump enqueue_version). `claimedBy` = `reprocess:${flyMachineId}:${pid}`
     at embed-worker.js:622.
   - Worker uses SERVICE-ROLE client → `.select()` RLS-unaffected (assert in a comment).
   - Thread via `failOwned`/`errorOwned` wrappers in `processV3Job` (@753) + v2 `tick` (@1658).
   - Extract `applyClaimGuard(query, claimedBy)` pure helper for unit testing.
   - Grep-gate test: NO raw `bumpFailure(`/`markJobErrored(` in those two bodies —
     CALL-SITE regex `^\s*await\s+(bumpFailure|markJobErrored)\s*\(`, NOT bare substring
     (would false-positive on comments at 11/694/718).
   - Dispatch-level `markJobErrored`@~1711 STAYS unguarded (claim just made, owned).
   - NODE:TEST file `server/voice-proxy/embed-worker-claim-guard.test.js`.
   - **NOT done** (accepted residual, already logged in CLEANUP_BACKLOG): per-write
     `assertStillClaimed` gating + `finalize_v3` signature change. The 540s-worker-deadline
     < 600s-reaper-TTL ordering is the real protection.

2. **C4 — patch existing flip route** `src/app/api/admin/creator-retrieval-version/route.ts`:
   - Accept `version === 3` (currently only 1|2 at line ~59).
   - Map `23514` → 409, discriminating by leading token `rollback_refused` vs
     `creator_v3_not_ready` (messages interpolate values — match the token).
   - **INVERT the now-stale test** `creator-retrieval-version/route.test.ts:111-113`
     (`'400 bad_version for 3'`) — version=3 is now valid. Name it as stale-flip.

3. **M5 — admin routes** (mirror `creator-retrieval-version/route.ts` EXACTLY — the proven
   pattern: `isSameOrigin` → `assertAdminFromSession` → UUID validate → call PUBLIC RPC via
   **JWT-bound `supabaseServer()`** [service-role NULLs auth.uid() → `_assert_caller_is_admin`
   fails] → error-map → `revalidatePath`):
   - `POST /api/admin/purge-legacy-chunks` → `admin_purge_legacy_chunks`. 42704→404;
     `23514`→409 matching token **`purge_refused`** (RPC emits `purge_refused_creator_not_on_v3`
     — NOT `purge_refused_not_on_v3`); 42501→403. Return RPC jsonb directly.
   - `POST /api/admin/gc-section-generations` → `admin_gc_stale_section_generations`. 42501→403.
   - **Preview GETs** (each runs `assertAdminFromSession()` FIRST — info-leak guard):
     - Purge preview: replicate the RPC's `retrieval_version=3` guard (if not on v3 →
       `{available:false,reason:'not_on_v3'}`, NO count); else count `chunker_version IN (1,2)`
       chunks + `narrative_units section_id IS NULL` (EXACT delete predicate) + `legacy_purged_at`.
     - GC preview: count sections `section_generation < active_section_generation - 1` PER SAMPLE
       (JOIN sample_content).
     - Counts ADVISORY; UI uses RPC returned counts as truth; N≠deleted is NOT an error.
   - Route tests mirror the sibling's vitest (it EXISTS): 401/403/bad_origin/415/400-bad-uuid/
     200-success(mock RPC)/409-on-23514(exact token).

4. **M5 — admin UI** `src/app/admin/creators/[id]/legacy-lifecycle-panel.tsx` (mirror
   `corpus-reprocess-panel.tsx`): mount on `[id]/page.tsx`; extend creators select with
   `retrieval_version`, `legacy_purged_at`.
   - On mount GET both previews → show counts + `legacy_purged_at`.
   - **Purge button = TYPE-TO-CONFIRM** (type handle or `PURGE` — it permanently disables
     rollback). GC button = plain `window.confirm` (recoverable).
   - AbortController + busy + seq-guard (per the reprocess panel).
   - **Post-success:** optimistically flip panel to purged-state (disable purge, show
     "purged on <now>, rollback disabled") — RSC revalidate won't refresh the mounted client.

5. **Gates:** voice vitest, proxy `node:test`, `tsc`, `npm run build`, full pgTAP.
6. **CODE auditor** before commit. Commit (NO push).

### Deploy ordering (critical)
Migrations `20260531000001/0002/0003` → prod FIRST → verify RPCs exist via
`information_schema.routines` → THEN the Vercel route deploy. A route deploy ahead of the
migration = guaranteed 500 on first admin click.

---

## 5. FULL AUDIT TRAIL (so nothing is lost)

### Step-9 code audit (the committed work, 7e159c1) — 2 rounds, 0 Critical
All findings applied or deferred-with-trigger. See CLEANUP_BACKLOG "Step 9 final CODE
audit": M2/M3/M4 + 5 Smalls fixed inline; **M1 + M5 deferred** (now being built).

### M1+M5 PLAN audit — round 1 (4 Criticals, all addressed in REV 2/3)
- **C1**: M1 guarded the wrong surface (job row, not the section/sample writes). → reshaped.
- **C2**: `.update().eq()` returns no count without `.select()`. → `.select('id')`.
- **C3**: purge preview must replicate the `retrieval_version=3` guard (no lying counts). → done.
- **C4**: flip route only accepts 1|2 + no 23514 branch → 500s. → patch route.
- Mediums: grep-gate, v2 tick exposure, GC preview per-sample, type-to-confirm purge,
  post-success client state, preview GET admin-guard.

### M1+M5 PLAN audit — round 2 (found a REAL bug in my REV 2 fix)
- **C1-RESIDUAL (blocker)**: my REV 2 `assertStillClaimed` keyed on `enqueue_version`,
  but **the reaper requeue does NOT bump enqueue_version** (only admin re-enqueue does) —
  so it would MISS the reaper-driven zombie. Correct discriminator = **`claimed_by`**.
  (Also found a FALSE comment in a migration claiming the reaper bumps enqueue_version.)
- **C1-CENTROID / C1-COST**: the per-section centroid write (~1505) can't be cheaply gated
  (40 round-trips/book). → drove the decision to go LIGHTWEIGHT.
- **Realization**: the 540s<600s deadline ordering IS the real protection; full per-write
  gating + a finalize_v3 signature change is over-engineering for a window that's already
  closed. → Vuk chose LIGHTWEIGHT M1 (helper-guard on claimed_by + documented residual).
- **M-A**: C4 patch breaks the existing `'400 bad_version for 3'` test → must invert it.
- **M-B**: my purge substring `purge_refused_not_on_v3` ≠ the RPC's real
  `purge_refused_creator_not_on_v3` → would 500. Match prefix `purge_refused`.
- **M-C**: message-substring matching is brittle → test against EXACT migration strings.
- **M-D**: GC preview can show N≠deleted (finalize raced) — not an error; UI wording.
- C2/C3/M-3/M-4/M-5/M-6 confirmed genuinely resolved in REV 2.

REV 3 (current, APPROVED) folds ALL of the above. No round-3 audit was run (Vuk approved build).

---

## 6. KEY FACTS VERIFIED THIS SESSION (don't re-derive)

- **20 migrations are NOT on prod** (via `supabase migration list --linked`): the 16-file
  v3 chain `20260528000001..000060`, my 3 `20260531000001..0003`, + 1 security straggler
  `20260525000011_handshakes_rpc_only_read` (safe — REVOKEs raw handshakes SELECT). All
  additive/CREATE-OR-REPLACE; safe to `supabase db push` (will NOT drag unaudited profile
  migrations — those `0525000001-10` are already on prod). Note `20260528000001` changes
  v2 `corpus_reprocess_mark_done` to bump corpus_version (live v2 path); `20260531000001`
  rewrites the flip RPC to soft cutover (inert until a flip).
- **Your corpus is NOT on v3** (it can't be — the v3 schema isn't on prod). Prod creator #1
  `vuk_lehendas` (74e897d8) is on `brain_mode='vector'` against a v1 corpus.
- **Onboarding flow (your sidenote, confirmed):** creator materials → `sample_content` rows
  under that creator → admin triggers the reprocess worker → it chunks/embeds per-creator.
  v3 just makes the worker build the Section→Unit→Chunk hierarchy.
- **ENV VARS: nothing to set for v3** (re-verified live both platforms 2026-05-31):
  - Vercel prod HAS `VOYAGE_API_KEY` (rerank — the var is `VOYAGE_API_KEY`, injected as
    `voyageApiKey`, NOT `VOYAGE_RERANK_API_KEY`), `GEMINI_API_KEY`, `INTERNAL_API_SECRET`, Supabase keys.
  - Fly proxy HAS `GEMINI_API_KEY`, `INTERNAL_API_SECRET`, Supabase keys.
  - The "4 vars" Vuk recalled = the Vercel model-pin OVERRIDE vars (`QUERY_REWRITE_MODEL` +
    3 pricing) — deliberately ABSENT on both (code defaults to 3.1-flash-lite at right
    rates). DO NOT set them (a stale override is the COGS-mislabel trap from audit M3).
  - `FLY_API_TOKEN` and `VERCEL_TOKEN` are in `.env.local` (Claude can run flyctl/vercel).
- **`min_sim` per-mode floors are STILL PLACEHOLDERS** (`DEFAULT_V3_MIN_SIM_BY_MODE` in
  `retrieve-knowledge.ts`) — must be pinned with §7 harness data BEFORE v3 takes real
  traffic. Phase 3 gate.

---

## 7. DECISIONS MADE (with rationale)

- **M1 = lightweight** (helper-guard on `claimed_by` only): the 540<600 deadline ordering
  is the real protection; full per-write gating + finalize change is over-engineering.
- **M5 deferred items being built NOW** (not "later"): Vuk — "0 reasons to keep for later."
- **Build M1+M5 BEFORE the prod deploy** so they ship in it (cleaner than a second deploy).
- **Full planning loop** (plan→audit→approve) used for M1+M5 (non-trivial: destructive admin
  ops + shared-helper refactor).
- **No git push** until Vuk says so. **db reset/test = LOCAL Docker only** (standing auth).

---

## 8. EXACT RESUME POINT

**Start here:** execute the M1+M5 build per [M1_M5_PLAN.md] REV 3, TDD, in the order in §4
above. The TodoWrite list is already seeded (item 1 = M1, in_progress). I had just read
`embed-worker.js:610-640` (the `claimedBy`@622 region) when we paused — no code written.

First action: read the exact bodies of `markJobErrored`@683 / `bumpFailure`@698 + the
`claimedBy` definition @622 + how `embed-worker.js` exports (for testing `applyClaimGuard`)
+ an existing `server/voice-proxy/*.test.js` for the node:test pattern. Then TDD M1.

After the full build + gates green → CODE auditor → apply findings → **commit (no push)** →
then we're ready for Phase 2 (the prod deploy) when Vuk gives the word.

---

## 9. STANDING CONSTRAINTS (persist across sessions)
- Auditor subagent before ANY commit (self-audit doesn't count).
- Git push ONLY on explicit "push to git" (none given — do not push).
- NEVER stage/touch `scripts/session-cogs-breakdown.mjs` (+ the other pre-existing untracked WIP in §2).
- Local Docker DB only (`db reset`/`db test` authorized); NEVER target remote/prod DB for tests.
- Apply every audit finding (Critical AND Medium AND Small) or defer explicitly-with-trigger + log it.
- Don't auto-chain a third audit — present state, let Vuk decide.
- Run full `npm run build` (Vercel's gate) before any main push, not just tsc.
- `supabase test db` runs against the LOCAL DEV DB — `db reset` FIRST after editing a migration,
  or the test runs against stale function definitions (learned this session).
