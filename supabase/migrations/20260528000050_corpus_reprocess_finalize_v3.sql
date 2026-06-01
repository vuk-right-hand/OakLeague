-- 20260528000050 — corpus_reprocess_finalize_v3 (RAG v3 step 7 / plan §4 item 8).
--
-- The v3 per-sample finish RPC, mirroring corpus_reprocess_finalize (the v2
-- one from 20260521000001) — same structure, same advisory key, same
-- silent-abandon + 02000 semantics. Then UPGRADES the
-- corpus_reprocess_mark_done_v3 STUB (from 20260528000020) to delegate here.
--
-- ── ADDITIVE-BUILD CONTRACT (round-5 audit C1 — load-bearing) ───────────
-- Plan §6 build-then-flip promises: while a creator is being staged to v3,
-- "v3 chunks/sections accumulate invisibly (version-filtered out of v2
-- reads); the creator keeps reading their current path the entire time."
-- finalize_v3 runs PER-SAMPLE during that build window, while the creator
-- is STILL at retrieval_version=2 reading chunker_version=2 chunks.
--
-- THEREFORE finalize_v3 MUST NOT touch chunker_version=2 chunks or v2-shape
-- narrative_units (section_id NULL) — deleting them would blank the live v2
-- read path mid-build (the exact UX-death regression the §6 ordering exists
-- to prevent). It deletes ONLY chunker_version=1 chunks, which are dead for
-- ANY v2/v3 creator (every read RPC hard-filters its own version), so
-- reclaiming them is never a live-read regression.
--
-- The v1 + v2 bulk cutover cleanup happens EXACTLY ONCE, at the v2→v3 flip
-- (admin_set_creator_retrieval_version, migration 20260528000053) — the
-- single moment v2 becomes dead. finalize_v3 never does the v2 delete.
--
-- This is why finalize_v3 ≈ v2 finalize: both delete chunker_version=1 only
-- + bump current_corpus_version. The ONLY material difference is the
-- target_version=3 gate (so a v2 job can't be finalized via the v3 path).
--
-- ── ACCEPTED: v2-cache thrash during build (round-6 M3) ─────────────────
-- finalize_v3 bumps creators.current_corpus_version per sample during the
-- build window. The still-v2 read path's semantic_query_cache is keyed on
-- current_corpus_version, so each v3 sample-finalize invalidates the v2
-- creator's cache → cold-cache latency on the next few v2 turns. This is
-- LATENCY, not incorrectness (v2 retrieval recomputes fresh + re-caches),
-- and the build is a one-time event per creator. Accepted rather than
-- introducing a separate v3-only invalidation revision (extra column +
-- cache-key change for a transient build-window effect). Revisit only if a
-- live creator's build window is long enough that cache-cold turns hurt UX.
--
-- Companion change (same step 7): the v3 worker (embed-worker.js) builds
-- ADDITIVELY — it no longer deletes v2 narrative_units in its pre-loop, and
-- offsets v3 unit_index above the surviving v2 range so the
-- (sample_id, unit_index) UNIQUE never collides. v2 + v3 rows coexist until
-- the flip.
--
-- ── What finalize_v3 does (per-sample, atomic) ──────────────────────────
--   1. Server-derive sample_id + creator_id from job+sample join (caller
--      passes only p_job_id + p_claimed_version — parameter-trust closure).
--   2. Gate: status='processing' AND enqueue_version match AND target_version=3.
--   3. SET LOCAL lock_timeout='5s' + pg_advisory_xact_lock on
--      hashtext('reprocess:'||creator_id) — SAME key as v2 finalize so the
--      two serialize per-creator during any mixed-state window.
--   4. DELETE this sample's chunker_version=1 chunks ONLY (v2 + v3 survive).
--   5. Bump creators.current_corpus_version (cache invalidation).
--   6. Mark job done + finished_at.
--   Returns new version (int) on success, NULL on silent-abandon, RAISES
--   02000 on creator-disappeared (worker catches it). NOTE the 02000 branch
--   is effectively unreachable (sample_content→creators is FK CASCADE, so a
--   deleted creator takes its samples + jobs with it → the SELECT returns
--   nothing → silent-abandon path); kept for parity with v2 finalize +
--   defense if the FK ever changes. (audit round-5 M2)

CREATE FUNCTION public.corpus_reprocess_finalize_v3(
  p_job_id          uuid,
  p_claimed_version int
) RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sample_id   uuid;
  v_creator_id  uuid;
  v_new_version int;
BEGIN
  -- Cap the lock wait (mirrors v2 finalize / Day-9-cross C1). On wait-out
  -- plpgsql raises lock_not_available (55P03); the v3 worker branch's
  -- try/catch maps it to a transient requeue (embed-worker.js:1401).
  SET LOCAL lock_timeout = '5s';

  -- Server-derive sample_id + creator_id. target_version=3 gate so a v2 job
  -- cannot be finalized through the v3 path. enqueue_version match =
  -- silent-abandon on mid-flight re-enqueue. FOR UPDATE OF j locks only the
  -- jobs row.
  SELECT j.sample_id, s.creator_id
    INTO v_sample_id, v_creator_id
    FROM public.corpus_reprocess_jobs j
    JOIN public.sample_content s ON s.id = j.sample_id
   WHERE j.id = p_job_id
     AND j.status = 'processing'
     AND j.enqueue_version = p_claimed_version
     AND j.target_version = 3
   FOR UPDATE OF j;

  IF v_sample_id IS NULL THEN
    -- Silent-abandon: job missing, not processing, version-mismatched, OR
    -- target_version<>3. Reaper requeues the re-enqueued row after TTL.
    RETURN NULL;
  END IF;

  -- Per-creator serialization. SAME advisory key as v2 finalize so a v2 and
  -- v3 finalize for one creator never interleave their delete+bump.
  PERFORM pg_advisory_xact_lock(hashtext('reprocess:' || v_creator_id::text));

  -- ADDITIVE-BUILD: delete chunker_version=1 ONLY. v2 chunks are the LIVE
  -- read path during the build window (creator still at retrieval_version=2)
  -- and MUST survive — the v2→v3 flip RPC does the v1+v2 bulk cutover.
  -- v3 chunks (just written) obviously survive. (audit round-5 C1)
  DELETE FROM public.sample_content_chunks
   WHERE sample_id = v_sample_id
     AND chunker_version = 1;

  -- Bump cache-invalidation revision. semantic_query_cache rows under the
  -- prior revision now miss on lookup. Day-8-final M5: distinguish
  -- creator-disappeared (RAISE 02000) from silent-abandon (RETURN NULL).
  UPDATE public.creators
     SET current_corpus_version = current_corpus_version + 1
   WHERE id = v_creator_id
   RETURNING current_corpus_version INTO v_new_version;

  IF v_new_version IS NULL THEN
    RAISE EXCEPTION 'creator_disappeared_during_finalize_v3 creator_id=%', v_creator_id
      USING ERRCODE = 'no_data_found';  -- 02000
  END IF;

  UPDATE public.corpus_reprocess_jobs
     SET status = 'done', finished_at = now()
   WHERE id = p_job_id;

  RETURN v_new_version;
END;
$$;

COMMENT ON FUNCTION public.corpus_reprocess_finalize_v3(uuid, int) IS
  'Atomic v3 worker-finalize for one sample reprocess (target_version=3 only). ADDITIVE-BUILD (audit round-5 C1): deletes ONLY chunker_version=1 chunks — v2 chunks are the live read path during the build-then-flip window and survive until the v2→v3 flip RPC does the bulk cutover. Derives sample_id + creator_id server-side. pg_advisory_xact_lock on hashtext(''reprocess:''||creator_id) — SAME key as v2 finalize. Bumps creators.current_corpus_version. Returns new version on success, NULL on silent-abandon (enqueue_version mismatch / not processing / target_version<>3), RAISES 02000 on creator-disappeared (effectively unreachable via FK CASCADE — kept for parity). Service-role only.';

REVOKE ALL ON FUNCTION public.corpus_reprocess_finalize_v3(uuid, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.corpus_reprocess_finalize_v3(uuid, int)
  TO service_role;

-- ── Upgrade the mark_done_v3 STUB to delegate to finalize_v3 ─────────────
-- The stub (20260528000020) only flipped status. Replace its body with a
-- thin wrapper that delegates to finalize_v3, translating the int→uuid
-- contract (mirrors how step-1b's mark_done wraps v2 finalize). External
-- SIGNATURE unchanged (uuid, int) → uuid, so the worker (embed-worker.js
-- :1394) needs no code change — and it ALREADY handles the 55P03 / 02000
-- codes finalize_v3 can now raise (which the status-flip stub never did).
CREATE OR REPLACE FUNCTION public.corpus_reprocess_mark_done_v3(
  p_job_id          uuid,
  p_claimed_version int
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_new_version int;
BEGIN
  v_new_version := public.corpus_reprocess_finalize_v3(p_job_id, p_claimed_version);
  IF v_new_version IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN p_job_id;
END;
$$;

COMMENT ON FUNCTION public.corpus_reprocess_mark_done_v3(uuid, int) IS
  'v3 worker-finish for corpus_reprocess_jobs (target_version=3 only). Delegates to corpus_reprocess_finalize_v3 (per-creator advisory-locked + 5s lock_timeout): ADDITIVE-BUILD — deletes the sample''s chunker_version=1 chunks only, bumps creators.current_corpus_version, marks the job done. v2 chunks survive until the v2→v3 flip cutover. Returns p_job_id on success, NULL on silent-abandon. Migration 20260528000050 (RAG v3 step 7) upgraded this from the step-4c status-flip stub. Service-role only.';

REVOKE ALL ON FUNCTION public.corpus_reprocess_mark_done_v3(uuid, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.corpus_reprocess_mark_done_v3(uuid, int)
  TO service_role;
