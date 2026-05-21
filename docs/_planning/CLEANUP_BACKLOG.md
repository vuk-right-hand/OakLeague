# CLEANUP_BACKLOG — orphaned debt on `rag-sota-phase-2-days-8-12`

Captured 2026-05-21. These are **pre-existing items left by prior work**, not
owned by either currently-active workstream (decoupled-brain/failover, RAG
embed). No agent currently owns them — this doc is the checklist so they don't
slip. Each was located + root-caused already; this is triage-and-execute, NOT a
"go read all the code" discovery task.

Companion memory: `project_preexisting_red_pgtap_tests.md` (same items, terse).

---

## How to use this
Do NOT spawn a generalist agent to "handle all one by one" — the items differ
wildly in size/risk. Trivial ones are minutes with context that already exists;
the PG crash is a real investigation. Slice by risk (below), evidence-first on
the hard ones. Escalate a *single narrow* item to a focused agent only if it
balloons.

---

## TRIVIAL — fix is known, minutes each

### C-2 · `creator_applications.topics` NOT-NULL drift (7 pgTAP tests RED)
- **Symptom:** `null value in column "topics" of relation "creator_applications" violates not-null constraint`.
- **Cause:** a branch migration made `creator_applications.topics` NOT NULL; older tests INSERT without it.
- **Affected tests:** `enqueue_routes_by_retrieval_version`, `creators_retrieval_version`,
  `creator_embedding_budget_cap_bump`, `creator_brain_compile_reads_retrieval_version`,
  `corpus_reprocess_jobs`, `claim_corpus_reprocess_job`, `admin_set_retrieval_version_cleans_v2_zombies`.
- **Fix:** add `topics` (e.g. `ARRAY['x']`) to each test's INSERT, OR give the column a sane default. Decide which is intended product behavior.

### C-3 · `creator_knowledge_topk_grants` — `role "public" does not exist`
- **Cause:** test references a `public` role that doesn't exist in the test DB.
- **Fix:** one-line test correction (use the right role / drop the grant assertion).

### C-6 · maxOutputTokens discarded-output cap — UNCOMMITTED WIP, needs landing
- **Where:** `server/voice-proxy/gemini-bridge.js` working-tree changes (`_decoupledOutputCapConfig`, `parseDecoupledMaxOutputTokens`, default 24 / floor 16, decoupled-gated). Plus tests in `gemini-bridge.test.js`.
- **What it does:** closes the ~14%-of-COGS discarded Gemini-audio-garbage leak in decoupled STT mode. Spike-validated (S10/S11): cap is the fix, `=8` flaky, 16/24/32 clean, no new pricing var (existing `gemini_audio_out` leg prices the smaller spend).
- **Status:** code looks correct + tested but is **uncommitted** — so the leak is fixed in working tree only.
- **Fix:** review + commit it (own commit, with its tests). Confirm it's not entangled with other WIP in the same file first.
- See memory `project_decoupled_stt_output_cost.md`.

---

## INVESTIGATION — evidence-first, do NOT guess from reading

### C-1 · `face_clone_finalize_locked_lifecycle.test.sql` CRASHES Postgres ⚠️ HIGHEST RISK
- **Symptom:** "server closed the connection unexpectedly" → DB enters recovery mode. Cascades: every test sorting alphabetically AFTER `face_clone*` then fails with "database system is in recovery mode" — so the **back half of the suite is MASKED, not passing**.
- **Why it matters:** a test that crashes PG into recovery usually indicates a real lock/lifecycle bug, not just a bad test.
- **Step 1 (evidence):** run it isolated after a fresh `supabase db reset` → capture the crash stack / PG log. Don't theorize before the stack.
- **Step 2:** fix root cause, then re-run the masked back-half tests in isolation to find any reds the crash was hiding.

### C-4 · `/api/admin/corpus-reprocess` → 500 (persistent)
- **Route is sound** (`src/app/api/admin/corpus-reprocess/route.ts`) — 500 is `enqueue_failed`/`list_failed` bubbling from the RAG RPC (`_admin_enqueue_corpus_reprocess_unsafe` / `admin_list_corpus_reprocess_jobs`).
- **Cause:** RAG RPC erroring on local data state (stale-local-DB class).
- **Step 1:** sync local DB (`supabase db reset`), reproduce, capture the actual PG error from the RPC.

### C-5 · decoupled early-trigger returns before `truncationSuspected`
- **Symptom:** a >15s question can be answered from a TRUNCATED transcript with no signal — silent quality loss.
- **Where:** decoupled early-trigger path (voice proxy). Pre-existing, not the failover work.
- **Fix:** thread the truncation signal through the early-trigger return, or defer the trigger until truncation state is known.

---

## OURS — already understood, trivial, coordinate only

### O-1 · `cogs_insert_brain_leg` PGRST202 (local only)
- **Cause:** Step-2 code calls the 12-arg overload; local PostgREST only knows the 11-arg version until migration `20260523000004` is applied.
- **NOT a prod bug** — migration is committed, correct (ends with `NOTIFY pgrst`), and in the deploy gate.
- **Fix:** `supabase db reset` applies it. ⚠️ Reset WIPES local data another agent may be mid-voice-session on — coordinate, don't reset unilaterally.
- **Local consequence until applied:** deep-answer COGS legs silently don't write → kill-switch blind to deep-answer spend **on local only**.

---

## Benign — do NOT chase (confirmed expected)
- Haiku failover DISABLED locally (`ANTHROPIC_*` secrets unset) = deliberate fail-closed. Expected without Anthropic secrets.
- `[latency]`/`[decoupled]` DIAG logs removed = intentional cleanup. (If still debugging playout, may want them back temporarily — costs observability.)
- `SimliClient FAILED TO SEND FINAL MESSAGE` at teardown predates this work — likely red herring; only chase if it correlates with the no-audio symptom.
