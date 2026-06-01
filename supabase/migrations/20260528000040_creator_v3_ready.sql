-- 20260528000040 -- creator_v3_ready RPC (RAG v3 step 6 / plan §6 step 2).
--
-- The READINESS GATE the admin flip checks before letting a creator move
-- from retrieval_version=2 -> 3. Plan §6 step 2 (round-4 M3 -- was vague):
--
--   creator_v3_ready(creator_id) = TRUE iff:
--     * Creator has >=1 fetch_status='ready' sample_content row, AND
--     * For EVERY such 'ready' sample, all three of:
--       (a) corpus_reprocess_jobs has a row with target_version=3 AND
--           status='done' for that sample_id (the v3 worker finished),
--       (b) sample_content_sections has >=1 row for sample_id AND every
--           one of those rows has non-NULL summary_embedding AND non-NULL
--           centroid_embedding (no worker-mid-flight partials -- CLEANUP M5
--           was the explicit "MUST reject NULL embeddings" carve-out),
--       (c) sample_content_chunks has >=1 row with chunker_version=3 for
--           EVERY section_id from (b) (no orphan section without children).
--
-- ROUND-5 AUDIT C1 -- "ready"-only gate, not "any-non-errored".
-- The plan §6 step 2 text says "any non-errored sample", which would
-- include in-flight 'pending' / 'queued' / 'training' samples. In practice
-- that creates a UX paper-cut: admin uploads a 51st sample 30s before
-- clicking Flip -> the pending sample has no v3 data -> gate trivially
-- returns FALSE for as long as the worker takes to process it. The
-- "ready"-only filter matches the operational intent: the v3 flip is gated
-- on every CURRENTLY-SERVING sample being v3-warm; in-flight samples will
-- catch up via the v3 enqueue routing trigger (mig 20260516000003 +
-- step-7 mig 9) once they reach 'ready'.
--
-- WHY THIS GATE EXISTS -- plan §6 step 1's UX death scenario:
-- If the admin flips creators.retrieval_version to 3 before v3 chunks
-- exist, every session reads via topk_v3 -> filters chunker_version=3 ->
-- finds NONE (worker may take hours-to-days for a book) -> he BLANKS on
-- every turn for the entire rebuild window. The exact UX failure this
-- plan exists to prevent, triggered by the rollout procedure itself. The
-- gate makes that impossible: admin_set_creator_retrieval_version (mig 41)
-- RAISES if a flip to 3 is attempted while creator_v3_ready returns false.
--
-- Returns boolean. NULL p_creator_id returns FALSE (M2 -- caller-friendly,
-- no NULL leaking to clients). STABLE because read-only over committed
-- state; the planner can inline it. SECURITY DEFINER because the gate
-- runs from the admin RPC which itself is SECURITY DEFINER; the function
-- needs the same elevated permissions to read sample_content_sections etc.

CREATE FUNCTION public.creator_v3_ready(p_creator_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  -- M2: explicit NULL guard so admin-console clients render FALSE, not NULL.
  IF p_creator_id IS NULL THEN
    RETURN false;
  END IF;

  -- ">=1 'ready' sample" gate ANDed with "no 'ready' sample fails any of
  -- (a)+(b)+(c)". NOT EXISTS short-circuits at the first failure so cost
  -- is bounded by the first incomplete sample.
  RETURN (
    EXISTS (
      SELECT 1 FROM public.sample_content sc
       WHERE sc.creator_id   = p_creator_id
         AND sc.fetch_status = 'ready'
    )
    AND NOT EXISTS (
      SELECT 1
        FROM public.sample_content sc
       WHERE sc.creator_id   = p_creator_id
         AND sc.fetch_status = 'ready'
         AND (
           -- (a) no done v3 job for this sample.
           NOT EXISTS (
             SELECT 1 FROM public.corpus_reprocess_jobs j
              WHERE j.sample_id      = sc.id
                AND j.target_version = 3
                AND j.status         = 'done'
           )
           -- (b) no sections at all.
           OR NOT EXISTS (
             SELECT 1 FROM public.sample_content_sections s
              WHERE s.sample_id = sc.id
           )
           -- (b) any section with NULL embedding (worker mid-flight or
           -- crashed before embed-worker landed both vectors).
           OR EXISTS (
             SELECT 1 FROM public.sample_content_sections s
              WHERE s.sample_id = sc.id
                AND (s.summary_embedding  IS NULL
                  OR s.centroid_embedding IS NULL)
           )
           -- (c) any section without >=1 v3 child chunk (orphan section).
           OR EXISTS (
             SELECT 1 FROM public.sample_content_sections s
              WHERE s.sample_id = sc.id
                AND NOT EXISTS (
                  SELECT 1 FROM public.sample_content_chunks c
                   WHERE c.section_id      = s.id
                     AND c.chunker_version = 3
                )
           )
         )
    )
  );
END;
$$;

COMMENT ON FUNCTION public.creator_v3_ready(uuid) IS
$c$Plan §6 step 2 (audit round-4 M3 pinned). Returns TRUE iff creator has
>=1 fetch_status='ready' sample AND every such sample passes:
(a) v3 reprocess job done,
(b) sections exist with non-NULL summary + centroid embeddings,
(c) every section has >=1 chunker_version=3 child chunk.

Round-5 C1: filters on fetch_status='ready', not <>'errored'. In-flight
'pending'/'queued'/'training' samples are EXCLUDED so a fresh upload 30s
before flip doesn't trivially block the gate -- they catch up via the v3
enqueue trigger once they reach 'ready'.

Used by admin_set_creator_retrieval_version as the v3-flip gate -- the
admin literally cannot flip a half-built creator. Also useful as a
UI/diagnostic check. NULL p_creator_id returns FALSE (M2).

SECURITY DEFINER + locked search_path; purely read-only.$c$;

REVOKE ALL ON FUNCTION public.creator_v3_ready(uuid)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.creator_v3_ready(uuid)
  TO service_role, authenticated;
