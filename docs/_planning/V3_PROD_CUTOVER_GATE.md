# V3 PROD CUTOVER GATE — READ BEFORE DEPLOYING retrieval_version=3

**Single source of truth for taking RAG v3 (routed hierarchical retrieval) to production.**
The older `PROD_DEPLOY_GATE.md` is the *decoupled-brain* gate (branch
`rag-sota-phase-2-days-8-12`) and PREDATES the v3 scaling work — it does not cover
the v3 migrations or the `retrieval_version=3` rollout. This doc does.

Created 2026-05-31. Branch: `rag-v3-scaling`. Status: **CODE DONE + 2x-audited +
committed (`7e159c1`); NOTHING on prod yet.**

---

## Ground truth (verified 2026-05-31 via `supabase migration list --linked`)

- **The entire v3 schema is ABSENT from prod.** 20 migrations are pending (blank
  REMOTE column):
  - **16** = v3 steps 1-8 chain: `20260528000001, …010, …011, …012, …013, …014,
    …020, …030, …031, …040, …041, …050, …051, …052, …053, …060`
  - **3** = v3 step 9 (this work): `20260531000001, …0002, …0003`
  - **1** = non-v3 security straggler: `20260525000011_handshakes_rpc_only_read`
    (REVOKEs raw SELECT on handshakes — safe + beneficial; comes along on push)
- **Consequence:** NO creator can be on v3 — the tables/columns/RPCs don't exist
  on prod. Prod creator #1 (`vuk_lehendas`, 74e897d8) is on `brain_mode='vector'`
  against a **v1 corpus** (per `PROD_DEPLOY_GATE.md`), NOT v3.
- **Migrations are additive / CREATE-OR-REPLACE** — pushing them is low-risk even
  before calibration BECAUSE no creator is flipped to v3 (the new read path is
  dormant until `retrieval_version=3`). Two behavior notes to eyeball at push:
  - `20260528000001` changes v2 `corpus_reprocess_mark_done` to bump
    `current_corpus_version` (cache invalidation) — affects the LIVE v2 path.
  - `20260531000001` rewrites the flip RPC to SOFT cutover — inert until a flip.

---

## Ordered checklist (do in this order)

### Phase 1 — land the deferred prod-readiness code FIRST (so it ships in the deploy)
- [ ] **M1 — worker-claim guard.** Thread `claimedVersion` → `bumpFailure` /
      `markJobErrored` `.eq('enqueue_version', claimedVersion)` so a zombie worker
      no-ops instead of clobbering a live claim. (Window is closed today by the
      540s<600s deadline ordering, but we're shipping it for prod robustness.)
      Plan → auditor → TDD → re-audit → commit.
- [ ] **M5 — admin UI for the soft-cutover lifecycle.** Two destructive buttons on
      `/admin/creators/[id]` with confirm dialog + audit-preview:
      - "Purge legacy v1/v2 chunks" → `admin_purge_legacy_chunks` (post-soak)
      - "GC old v3 generations" → `admin_gc_stale_section_generations`
      Plus auth guards (`assertAdminFromSession`), and surface `legacy_purged_at`
      so the UI shows rollback is no longer possible post-purge. Plan → auditor →
      TDD → re-audit → commit.

### Phase 2 — deploy the schema + code (all additive; safe pre-flip)
- [ ] **Apply migrations to prod.** `supabase db push` lands all 20 pending in
      order (incl. the handshakes security fix). It does NOT drag anything
      unaudited (the profile set 0525000001-10 is already on prod). Verify with
      `supabase migration list --linked` after (REMOTE column fills in).
- [x] **Env vars — VERIFIED, nothing to set (re-checked live 2026-05-31).**
      - Vercel (`oak-league` prod) HAS: `VOYAGE_API_KEY` (rerank — note the var is
        `VOYAGE_API_KEY`, injected as `voyageApiKey`, NOT `VOYAGE_RERANK_API_KEY`),
        `GEMINI_API_KEY`, `INTERNAL_API_SECRET`, Supabase keys. ✅
      - Fly (`oakleague-voice-proxy`) HAS: `GEMINI_API_KEY`, `INTERNAL_API_SECRET`,
        Supabase keys (worker trio; `INTERNAL_API_BASE_URL` via fly.toml [env], proven
        by the working v2 reprocess path). ✅
      - The model-pin override vars (`QUERY_REWRITE_MODEL`/`NARRATIVE_CHUNK_MODEL`/
        `FLASH_USD_*`/`QUERY_REWRITE_USD_*`) are DELIBERATELY ABSENT on both — code
        defaults to gemini-3.1-flash-lite at the right rates. Do NOT set them (a stale
        override is the COGS-mislabel trap from audit M3). Nothing to add for v3.
- [ ] **`fly deploy`** the proxy (ships the `embed-worker.js` v3 generation rewrite).
      Confirm boot log clean.
- [ ] **Merge `rag-v3-scaling` → `main`** → Vercel picks up `retrieve-knowledge.ts`.
      Coordinate with any held main-merge state.

### Phase 3 — calibrate, build a real v3 corpus, then flip (the validation IS the rollout)
- [ ] **Pin `min_sim` per-mode floors.** `DEFAULT_V3_MIN_SIM_BY_MODE` in
      `retrieve-knowledge.ts` is STILL placeholders; the §7 harness must pin real
      per-mode prod values BEFORE v3 takes real traffic (recall floor depends on it).
- [ ] **Re-ingest a creator's corpus through the v3 worker** (builds sections →
      units → chunks; costs COGS + minutes). Start with the **scratch eval creator**,
      then your own. v3 retrieval returns NOTHING for a creator until this runs.
- [ ] **`creator_v3_ready(creator)` must return TRUE** (gates the flip).
- [ ] **Flip scratch creator → `retrieval_version=3`** via
      `admin_set_creator_retrieval_version`. **Live "exactly him" voice test at book
      scale** — does it recall the back half of the book, in-persona?
- [ ] **Then flip creator #1 (you)** → live test → **then widen** to general.
- [ ] Rollback at any point = flip back to 2 (soft cutover keeps v1/v2 alive).
      Once confident, "Purge legacy" (M5 button) — after which rollback is refused.

---

## What this is NOT
- A `git push` of the branch = backup/PR only. Not prod.
- "We're one step away" — Phases 2+3 are a deliberate, partly-manual, COGS-and-time
  -bearing cutover. The schema deploy is safe; the FLIP is the gated, tested step.
