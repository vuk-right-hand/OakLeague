-- 20260531000001 — v3 SOFT cutover + admin_purge_legacy_chunks (Step-9 audit C1).
--
-- ── Why this exists (the rollback-bricking bug) ─────────────────────────
-- 20260528000053 made the flip TO v3 do a ONE-SHOT hard delete of the
-- creator's chunker_version IN (1,2) chunks + v2-shape narrative_units at the
-- flip moment. But creator_knowledge_topk_v2 hard-filters chunker_version=2,
-- so once those rows are gone, flipping retrieval_version BACK to 2 reads ZERO
-- chunks → the brain answers confidently-ungrounded (persona-only). The whole
-- premise of "phased rollout behind retrieval_version=3" is that the flip is
-- REVERSIBLE; the hard delete made it a one-way door. Step-9 audit C1.
--
-- ── The fix: SOFT cutover ────────────────────────────────────────────────
-- Flip TO 3 NO LONGER deletes v1/v2 chunks. They go DORMANT: the v3 read path
-- (creator_knowledge_topk_v3 / creator_route_sections_v3) filters to
-- chunker_version=3 + sections, so v1/v2 rows are invisible to reads but
-- remain on disk. Rollback (flip 3→2 or 3→1) is therefore instant + correct:
-- the v2 read path finds its chunker_version=2 chunks exactly as before.
--
-- The now-dead v1/v2 rows are deleted DELIBERATELY + EXPLICITLY by an admin,
-- only after a v3 soak period they're happy with, via the new
-- admin_purge_legacy_chunks(creator_id) RPC below. Until purge, disk carries
-- both corpora for that creator (bounded: one creator's books, cheap).
--
-- Net behavior change vs 20260528000053:
--   • Flip TO 3: was {delete v1/v2 + bump-free} → now {NO delete}. The v3
--     worker's per-sample finalize_v3 already bumped current_corpus_version
--     during the build, so the cache is already warm/invalidated; the flip
--     itself only needs to switch retrieval_version + recompile persona.
--   • v2→v1 downgrade cleanup: PRESERVED VERBATIM (that path is a real
--     downgrade where v2 chunks ARE dead — unchanged, still deletes them).
--   • NEW admin_purge_legacy_chunks(creator_id): the deferred, explicit
--     legacy delete. Idempotent; advisory-locked; only purges when the
--     creator is actually on v3 (guard against purging a creator's only
--     live corpus by mistake).
--
-- This is additive + CREATE OR REPLACE only; no schema change, no data
-- migration. Replay-safe.

-- ── 0. legacy_purged_at marker (Step-9 audit M2) ─────────────────────────
-- Stamped by admin_purge_legacy_chunks. Once set, admin_set_creator_retrieval_version
-- REFUSES a 3->2 / 3->1 rollback: the v1/v2 corpus is GONE, so the rollback
-- would read ZERO chunks — the exact confidently-ungrounded failure the soft
-- cutover exists to prevent, just deferred to the purge. We fail LOUD here so a
-- non-author admin can't silently brick a creator by rolling back after a purge;
-- the recovery is to re-ingest the legacy corpus first. (Pre-purge rollback is
-- unaffected — legacy_purged_at IS NULL.) Grandfathered table, no new GRANT.
ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS legacy_purged_at timestamptz;

COMMENT ON COLUMN public.creators.legacy_purged_at IS
  'Set by admin_purge_legacy_chunks when the dormant v1/v2 corpus is deleted post-v3-soak (Step-9 audit M2). While non-NULL, admin_set_creator_retrieval_version refuses a 3->2/3->1 rollback (no legacy corpus left to serve). NULL = legacy chunks still on disk, rollback safe.';

-- ── 1. Soft cutover: drop the hard delete from the flip RPC ──────────────
CREATE OR REPLACE FUNCTION public.admin_set_creator_retrieval_version(
  p_creator_id uuid,
  p_version    smallint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id            uuid;
  v_prev                smallint;
  v_legacy_purged_at    timestamptz;
  v_chunks_deleted      int := 0;   -- v2→v1 downgrade path (preserved)
  v_units_deleted       int := 0;   -- v2→v1 downgrade path (preserved)
  v_v3_ready            boolean;
  v_after_jsonb         jsonb;
BEGIN
  v_admin_id := auth.uid();
  PERFORM public._assert_caller_is_admin();

  IF p_version IS NULL OR p_version NOT IN (1, 2, 3) THEN
    RAISE EXCEPTION USING errcode='22023', message='version_invalid';
  END IF;

  SET LOCAL lock_timeout = '5s';

  -- Round-6 C1 deadlock-ordering note is now MOOT for the flip itself (it no
  -- longer touches reprocess-owned chunk rows), but we KEEP taking the
  -- reprocess advisory lock before the creators FOR UPDATE on the flip-TO-3
  -- path so the flip still serializes against an in-flight finalize_v3 for the
  -- same creator (we must not flip to 3 while a sample is mid-finalize — the
  -- creator_v3_ready gate read below must see a stable, committed build).
  IF p_version = 3 THEN
    PERFORM pg_advisory_xact_lock(hashtext('reprocess:' || p_creator_id::text));
  END IF;

  SELECT retrieval_version, legacy_purged_at INTO v_prev, v_legacy_purged_at
    FROM public.creators WHERE id = p_creator_id
    FOR UPDATE;
  IF v_prev IS NULL THEN
    RAISE EXCEPTION USING errcode='42704', message='creator_not_found';
  END IF;

  -- Same-version flip is a no-op (no recompile / audit / lock).
  IF v_prev = p_version THEN
    RETURN;
  END IF;

  -- Step-9 audit M2: refuse a rollback OFF v3 once the legacy corpus is purged.
  -- After admin_purge_legacy_chunks the v1/v2 chunks are gone, so a 3->2/3->1
  -- flip would read an EMPTY corpus (confidently-ungrounded brain — the failure
  -- C1's soft cutover prevents, deferred to the purge). Fail loud; recovery is
  -- to re-ingest. Pre-purge rollback is unaffected (legacy_purged_at IS NULL).
  IF v_prev = 3 AND p_version IN (1, 2) AND v_legacy_purged_at IS NOT NULL THEN
    RAISE EXCEPTION USING errcode='check_violation',
      message='rollback_refused_legacy_purged -- legacy v1/v2 chunks were purged (admin_purge_legacy_chunks) at '||v_legacy_purged_at||'; rolling back to v'||p_version||' would read an empty corpus. Re-ingest the legacy corpus before downgrading.';
  END IF;

  -- v3 FLIP GATE — plan §6 step 3. Cannot flip TO 3 unless every 'ready'
  -- sample has v3 chunks + sections + done job.
  IF p_version = 3 THEN
    SELECT public.creator_v3_ready(p_creator_id) INTO v_v3_ready;
    IF NOT v_v3_ready THEN
      RAISE EXCEPTION USING errcode='check_violation',
        message='creator_v3_not_ready -- at least one ready sample is missing v3 sections / chunks / done job. Run creator_v3_ready(creator_id) for diagnostics.';
    END IF;
  END IF;

  UPDATE public.creators
     SET retrieval_version = p_version
   WHERE id = p_creator_id;

  -- v2 zombie cleanup on the v2→v1 downgrade path (PRESERVED VERBATIM from
  -- 20260516000004 — this is a genuine downgrade where v2 chunks are dead).
  IF v_prev = 2 AND p_version = 1 THEN
    DELETE FROM public.sample_content_chunks
     WHERE creator_id = p_creator_id AND chunker_version = 2;
    GET DIAGNOSTICS v_chunks_deleted = ROW_COUNT;

    DELETE FROM public.sample_content_narrative_units
     WHERE creator_id = p_creator_id;
    GET DIAGNOSTICS v_units_deleted = ROW_COUNT;
  END IF;

  -- SOFT CUTOVER (Step-9 audit C1): flip TO 3 NO LONGER deletes v1/v2 chunks.
  -- They go dormant (v3 read path version-filters them out) and survive so a
  -- 3→2 / 3→1 rollback restores working retrieval instantly. The deliberate
  -- legacy delete is admin_purge_legacy_chunks(creator_id), run after soak.

  -- Per-version persona recompile (preserved).
  PERFORM public._creator_brain_compile_unsafe(p_creator_id);

  v_after_jsonb := jsonb_build_object('retrieval_version', p_version);
  IF v_prev = 2 AND p_version = 1 THEN
    v_after_jsonb := v_after_jsonb || jsonb_build_object(
      'v2_chunks_deleted', v_chunks_deleted,
      'v2_narrative_units_deleted', v_units_deleted
    );
  ELSIF p_version = 3 THEN
    -- Soft cutover: no delete, so no cutover_*_deleted counts. Flag that
    -- legacy chunks remain on disk pending an explicit purge.
    v_after_jsonb := v_after_jsonb || jsonb_build_object(
      'soft_cutover', true,
      'legacy_chunks_purged', false
    );
  END IF;

  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
  VALUES
    (v_admin_id, 'creator_retrieval_version_set', 'creator', p_creator_id,
     jsonb_build_object('retrieval_version', v_prev),
     v_after_jsonb);
END;$$;

COMMENT ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint) IS
  'Admin flips creators.retrieval_version between 1, 2, 3. v3 flip GATED on creator_v3_ready (plan §6 step 3). SOFT CUTOVER (Step-9 audit C1): flip TO 3 does NOT delete v1/v2 chunks — they go dormant (v3 read path version-filters them) so a 3→2/3→1 rollback restores working retrieval instantly. The deliberate legacy delete is admin_purge_legacy_chunks(creator_id), run after a v3 soak. v2→v1 downgrade still cleans its (genuinely dead) v2 chunks + units. Same-version flip is a no-op. Recompiles persona in-txn. Audits before/after. Service-role/admin only.';

REVOKE ALL ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint)
  TO authenticated;


-- ── 2. admin_purge_legacy_chunks(creator_id) — the deferred legacy delete ──
--
-- The deliberate counterpart to the soft cutover: deletes the creator's
-- now-dormant chunker_version IN (1,2) chunks + v2-shape narrative_units
-- (section_id NULL). Run by an admin AFTER a v3 soak, when rollback to v2 is
-- no longer wanted. Idempotent (re-run deletes nothing). Bumps
-- current_corpus_version so any lingering v2 semantic-cache rows invalidate.
--
-- GUARD: only purges when the creator is CURRENTLY on retrieval_version=3.
-- This prevents the catastrophe of purging a creator's only live corpus
-- (e.g. an admin fat-fingering purge on a v2 creator → empty retrieval).
-- A creator who has rolled BACK to v2 is (correctly) refused — purging would
-- brick the very corpus they rolled back to.
--
-- Lock order matches finalize_v3 / the flip RPC (advisory 'reprocess:'||id
-- FIRST, then creators FOR UPDATE) so it never deadlocks against an in-flight
-- finalize or flip for the same creator.
CREATE FUNCTION public.admin_purge_legacy_chunks(
  p_creator_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id        uuid;
  v_rv              smallint;
  v_chunks_deleted  int := 0;
  v_units_deleted   int := 0;
  v_new_version     int;
  v_result          jsonb;
BEGIN
  v_admin_id := auth.uid();
  PERFORM public._assert_caller_is_admin();

  SET LOCAL lock_timeout = '5s';
  PERFORM pg_advisory_xact_lock(hashtext('reprocess:' || p_creator_id::text));

  SELECT retrieval_version INTO v_rv
    FROM public.creators WHERE id = p_creator_id
    FOR UPDATE;
  IF v_rv IS NULL THEN
    RAISE EXCEPTION USING errcode='42704', message='creator_not_found';
  END IF;

  -- GUARD: refuse to purge unless the creator is live on v3. Purging a v1/v2
  -- creator (or one that rolled back to v2) would delete its live corpus.
  IF v_rv <> 3 THEN
    RAISE EXCEPTION USING errcode='check_violation',
      message='purge_refused_creator_not_on_v3 -- creator.retrieval_version='||v_rv||'. Legacy v1/v2 chunks are the live read path at this version; refusing to purge. Flip to 3 first, or this creator has rolled back and needs its v2 corpus.';
  END IF;

  DELETE FROM public.sample_content_chunks
   WHERE creator_id = p_creator_id AND chunker_version IN (1, 2);
  GET DIAGNOSTICS v_chunks_deleted = ROW_COUNT;

  -- v2-shape narrative_units only (section_id NULL). v3 units (section_id
  -- NOT NULL) are the live read path — never touched.
  DELETE FROM public.sample_content_narrative_units
   WHERE creator_id = p_creator_id AND section_id IS NULL;
  GET DIAGNOSTICS v_units_deleted = ROW_COUNT;

  -- Bump current_corpus_version so any stale v2 semantic-cache rows invalidate
  -- (mirrors finalize_v3's cache-invalidation contract). Stamp legacy_purged_at
  -- (Step-9 audit M2) so a later 3->2/3->1 rollback fails loud instead of
  -- silently serving the now-empty legacy corpus.
  UPDATE public.creators
     SET current_corpus_version = current_corpus_version + 1,
         legacy_purged_at       = now()
   WHERE id = p_creator_id
   RETURNING current_corpus_version INTO v_new_version;

  v_result := jsonb_build_object(
    'creator_id', p_creator_id,
    'legacy_chunks_deleted', v_chunks_deleted,
    'v2_narrative_units_deleted', v_units_deleted,
    'new_corpus_version', v_new_version
  );

  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
  VALUES
    (v_admin_id, 'creator_legacy_chunks_purged', 'creator', p_creator_id,
     jsonb_build_object('retrieval_version', v_rv),
     v_result);

  RETURN v_result;
END;$$;

COMMENT ON FUNCTION public.admin_purge_legacy_chunks(uuid) IS
  'Deliberate post-soak delete of a v3 creator''s now-dormant chunker_version IN (1,2) chunks + v2-shape narrative_units (section_id NULL). The explicit counterpart to the SOFT cutover (Step-9 audit C1): the flip TO 3 leaves v1/v2 alive for instant rollback; this purges them once the admin is confident in v3. GUARD: refuses unless creator.retrieval_version=3 (purging a v2/rolled-back creator would brick its live corpus). Idempotent. Bumps current_corpus_version (cache invalidation). Advisory-locked (reprocess:||id) + creators FOR UPDATE, same order as finalize_v3. Returns delete counts. Service-role/admin only.';

REVOKE ALL ON FUNCTION public.admin_purge_legacy_chunks(uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_purge_legacy_chunks(uuid)
  TO authenticated;
