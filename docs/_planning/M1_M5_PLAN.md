# M1 + M5 implementation plan — REV 3 (post plan-audit round 2)

Two deferred Step-9 findings, to land BEFORE the v3 prod deploy. Branch
`rag-v3-scaling`. Loop: plan → audit r1 (4 Crit) → REV 2 → audit r2 (C1 discriminator
bug) → THIS REV 3. Context: [V3_PROD_CUTOVER_GATE.md](./V3_PROD_CUTOVER_GATE.md).

Round-2 verified the REAL protection against zombie-worker corruption is the
**540s worker-deadline < 600s reaper-TTL** ordering (a live-but-slow worker
self-aborts before the reaper can reassign its job; the zombie scenario needs a
single op to hang >60s THEN resume). Decision (Vuk): **lightweight M1** — a correct
belt-and-suspenders helper-guard, NOT per-write gating or a finalize change.

---

## M1 — lightweight zombie-claim helper-guard (REV 3)

### Scope (deliberately minimal)
The 540<600 deadline ordering + the worker's per-section `timeLeft()<0` / `shuttingDown`
returns are the load-bearing protection (documented as accepted residual). M1 adds ONE
cheap, correct safety: a worker that DID wake after losing its claim must not clobber
the job row (stomp the new owner's claim / burn `attempts`).

### The fix
`markJobErrored`@683 / `bumpFailure`@698 (the `corpus_reprocess_jobs` closure ONLY —
the `sample_content_embedding_jobs` worker at 198/213 is a different table/worker, OUT
of scope) gain an optional `claimedBy` param:
- **Discriminator is `claimed_by`, NOT `enqueue_version`** (round-2 C1: the reaper
  requeue does NOT bump `enqueue_version` — only admin re-enqueue does — so an
  enqueue_version guard would MISS the reaper-driven zombie. `claimed_by` is the
  worker's unique identity `reprocess:${flyMachineId}:${pid}`, embed-worker.js:622).
- When `claimedBy` is passed: the update is `.eq('claimed_by', claimedBy).select('id')`
  and **0 returned rows → no-op + `captureMessage('reprocess.claim_moved_noop','warning',{job_id,claimed_by})`** (round-2 C2: `.update().eq()` returns NO count without
  `.select()`; 0-rows means "claim moved," not necessarily a zombie — don't mislabel).
  The worker uses the SERVICE-ROLE client, so `.select()` is RLS-unaffected — assert
  this in a comment so a future client swap can't silently break the count.
- Backward-compatible: `claimedBy` undefined → identical to today (no `.eq`).
- bumpFailure's existing `claimed_by=null` write stays; the `.eq('claimed_by',claimedBy)`
  guard precedes it, so a still-owner's update applies (and nulls claimed_by as today);
  a moved-on claim no-ops.

### Threading (round-2 M-1 grep-gate)
`processV3Job` + v2 `tick` define local `failOwned`/`errorOwned` wrappers capturing the
module-level `claimedBy` (622), replacing their `bumpFailure`/`markJobErrored` calls.
**Test grep-gate** asserting no RAW helper calls remain in those two bodies must match
CALL SITES, not comments: regex `^\s*await\s+(bumpFailure|markJobErrored)\s*\(` over the
two function bodies (round-2 Small: a bare substring grep false-positives on the doc
comments at 11/694/718). The dispatch-level `markJobErrored`@~1711 stays UNGUARDED —
correct: we JUST claimed the job this tick and own it by construction (no `await`
between claim@1687 and that path), so there is no zombie window there.

### Explicitly NOT done (accepted residual, documented)
- NO `assertStillClaimed` before the cleanup-delete / centroid / count writes. The
  deadline ordering already requires a >60s hang-then-resume for those to fire; finalize
  is additionally `WHERE status='processing'`-gated (first finalizer wins, second
  abandons). Residual: a hung-then-resumed zombie could waste work / leave garbage gen
  rows (GC'd) / rarely double-finalize a partial gen — bounded + never under normal
  timing. Recorded in CLEANUP_BACKLOG M1 with the trigger (lower reaper TTL, multi-worker,
  or observed 23505/partial-gen in logs) → revisit the full `claimed_by` write-gating then.
- NO `finalize_v3` signature change.

### Tests (node:test)
`server/voice-proxy/embed-worker-claim-guard.test.js`:
- `applyClaimGuard(query, claimedBy)` pure helper: undefined → no `.eq`; defined →
  `.eq('claimed_by', claimedBy)`. (round-2 Small: pure seam, prefer over test-hook.)
- helper with claimedBy, 0 rows returned → no throw, breadcrumb emitted, attempts NOT bumped.
- helper without claimedBy → legacy behavior (no `.eq`).
- grep-gate (call-site regex, comment-safe).

---

## M5 — admin UI for purge + GC (carried from REV 2, round-2 fixes folded)

### Routes (mirror `creator-retrieval-version/route.ts`)
`isSameOrigin` → `assertAdminFromSession` → UUID validate → PUBLIC RPC via JWT-bound
`supabaseServer()` (service-role NULLs `auth.uid()`) → error-map → `revalidatePath`.
`runtime='nodejs'`, `dynamic='force-dynamic'`, `application/json` POST guard.
- `POST /api/admin/purge-legacy-chunks` → `admin_purge_legacy_chunks`. Errors: `42704`→404;
  **`23514`→409 — match the message on the leading token `purge_refused`** (round-2 M-B:
  the RPC emits `purge_refused_creator_not_on_v3` with `_creator_`, NOT my earlier
  `purge_refused_not_on_v3`; the message also interpolates values, so match the prefix,
  not the whole sentence); `42501`→403. Success → return the RPC jsonb directly.
- `POST /api/admin/gc-section-generations` → `admin_gc_stale_section_generations`.
  `42501`→403. Success → jsonb.

### C4 — patch the EXISTING flip route (round-2 M-A + M-B + M-C)
`creator-retrieval-version/route.ts` today: accepts only `version 1|2` ([:59]) and maps
42704/22023/42501 but NOT 23514. mig …0001 added v3 + two new 23514s
(`rollback_refused_legacy_purged`, `creator_v3_not_ready`). Patch:
- Accept `version === 3`.
- Map `23514` → 409, discriminating on leading token: `rollback_refused` vs
  `creator_v3_not_ready` (round-2 M-C: messages interpolate values — match the token,
  not the whole string; and the route test must assert against the EXACT token copied
  from the migration so a message edit breaks the test, not prod).
- **Invert the now-stale test** `creator-retrieval-version/route.test.ts:111-113`
  (`'400 bad_version for 3'`) — round-2 M-A: version=3 is now VALID; assert 200 (mocked
  ready creator) and/or 409 (mocked `creator_v3_not_ready` RPC error). Name it as
  stale-test-to-invert, don't paper over the red.

### Preview GETs (round-2 M-6, C3, M-D)
GET, **`assertAdminFromSession()` FIRST** (M-6: a service-role count read without the
admin guard is an info leak), `dynamic='force-dynamic'`:
- Purge preview: **replicate the RPC's `retrieval_version=3` guard** → if not on v3,
  `{available:false, reason:'not_on_v3'}` (C3: no count the POST would 409 on). If on v3,
  count `chunker_version IN (1,2)` chunks + `narrative_units section_id IS NULL` (EXACT
  delete predicate) + return `legacy_purged_at`.
- GC preview: count sections `section_generation < active_section_generation - 1`
  **per sample** (JOIN sample_content, exactly as the RPC).
- Counts are ADVISORY (read outside the RPC lock). UI uses the RPC's RETURNED counts as
  truth and (round-2 M-D) must NOT render "preview N ≠ deleted M" as an error — a GC that
  previews >0 and deletes 0 (a finalize raced) is normal, show the returned count plainly.

### UI panel `legacy-lifecycle-panel.tsx` (mirror corpus-reprocess-panel)
- On mount GET both previews → show counts + `legacy_purged_at`.
- **Purge: TYPE-TO-CONFIRM** (round-2 M-4: purge PERMANENTLY disables rollback — stronger
  than the reprocess panel's plain confirm). Require typing the creator handle (or `PURGE`).
- GC: plain `window.confirm` (recoverable). AbortController + busy + seq-guard.
- **Post-success (round-2 M-5):** on 200 purge, optimistically flip panel to purged-state
  (disable purge, "purged on <now>, rollback disabled") — `revalidatePath` updates RSC
  cache but the mounted client won't re-read `legacy_purged_at` without it.
- Errors: 409 purge_refused → "Creator must be on v3 first."

### Mount + data
`/admin/creators/[id]/page.tsx`: render `<LegacyLifecyclePanel creatorId>` near the
reprocess + retrieval panels; extend creators select with `retrieval_version`,
`legacy_purged_at`.

### Tests
Confirm sibling vitest coverage first (round-2 Small — `creator-retrieval-version/route.test.ts`
EXISTS, so mirror it). Route tests: 401/403/bad_origin/415/400-bad-uuid/200-success(mock
RPC)/409-on-23514(exact token). DB guards/locks/gen-gating already pgTAP-covered.

---

## Order
1. M1 helper-guard (`applyClaimGuard` + `claimedBy` threading + node:test incl. grep-gate).
2. C4 flip-route patch (accept v3 + map 23514 by token) + INVERT the stale route test.
3. M5 purge/gc routes + preview GETs + route tests.
4. M5 UI panel + mount.
5. Gates: voice vitest, proxy node:test, tsc, build, full pgTAP.
6. CODE auditor before commit. Commit (no push).

## Deploy ordering
Migrations …0531000001/0002/0003 → prod FIRST → verify RPCs exist
(`information_schema.routines`) → THEN Vercel route deploy (route ahead of migration =
guaranteed 500). Ships in the same v3 deploy per the cutover gate.
