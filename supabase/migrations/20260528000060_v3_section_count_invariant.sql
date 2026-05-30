-- 20260528000060 — v3 section-count invariant (RAG v3 bulletproofing, audit
-- round 1 / finding M4).
--
-- The worker-side "no section silently dropped" backstop (embed-worker.js)
-- protects the happy finalize path, but creator_v3_ready — the DB-side gate
-- the admin v2→v3 flip actually trusts — had NO notion of "how many sections
-- SHOULD exist." A job marked 'done' by an older worker build, or by a manual
-- DB poke, with a missing section row, would pass the gate (it checks
-- per-EXISTING-section, never "is one missing"). That is the exact
-- worker-decides / gate-trusts-blindly shape that allowed the original
-- silent-loss hole.
--
-- Defense-in-depth: the v3 worker now writes, per sample, BEFORE finalize:
--   • v3_expected_section_count — segments emitted by section-segment.ts
--   • v3_skipped_empty_count     — sections with zero word content (skipped)
-- and creator_v3_ready asserts:
--   count(sample_content_sections for sample)
--     = v3_expected_section_count − v3_skipped_empty_count
--
-- NULL-tolerant by design: a sample whose v3_expected_section_count IS NULL
-- (ingested before this migration, or by a worker that predates the count
-- write) is NOT newly blocked — the existing (a)+(b)+(c) checks still apply.
-- The stronger invariant kicks in only once the count is present, which the
-- new worker writes on every v3 finalize. This avoids regressing any
-- already-v3-ready creator while making every FUTURE ingest provably complete.

ALTER TABLE public.sample_content
  ADD COLUMN IF NOT EXISTS v3_expected_section_count int,
  ADD COLUMN IF NOT EXISTS v3_skipped_empty_count    int;

COMMENT ON COLUMN public.sample_content.v3_expected_section_count IS
  'RAG v3 bulletproofing (audit round-1 M4): number of sections section-segment.ts emitted for this sample on the last v3 ingest. Written by the v3 worker BEFORE corpus_reprocess_finalize_v3. creator_v3_ready asserts count(sample_content_sections) = v3_expected_section_count - v3_skipped_empty_count. NULL = pre-invariant ingest (gate falls back to (a)+(b)+(c) only).';
COMMENT ON COLUMN public.sample_content.v3_skipped_empty_count IS
  'RAG v3 bulletproofing (audit round-1 C2/C3): number of emitted sections the v3 worker skipped because they had zero word characters (nothing to ingest). Subtracted from v3_expected_section_count in the creator_v3_ready count invariant.';

-- Re-create creator_v3_ready with the extra count clause. Body is identical to
-- migration 20260528000040 plus the (d) clause; signature unchanged.
CREATE OR REPLACE FUNCTION public.creator_v3_ready(p_creator_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_creator_id IS NULL THEN
    RETURN false;
  END IF;

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
           -- (b) any section with NULL embedding (worker mid-flight or crashed).
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
           -- (d) AUDIT ROUND-1 M4 — section-count invariant. When the worker
           -- recorded an expected count, the actual section-row count MUST
           -- equal expected − skipped_empty. Catches a silently dropped
           -- section that left no row (the original hole) even on a job the
           -- worker marked done. NULL-tolerant: pre-invariant samples skip it.
           OR (
             sc.v3_expected_section_count IS NOT NULL
             AND (
               SELECT count(*) FROM public.sample_content_sections s
                WHERE s.sample_id = sc.id
             ) <> (sc.v3_expected_section_count - COALESCE(sc.v3_skipped_empty_count, 0))
           )
         )
    )
  );
END;
$$;

COMMENT ON FUNCTION public.creator_v3_ready(uuid) IS
$c$Plan §6 step 2 + audit round-1 M4. Returns TRUE iff creator has >=1
fetch_status='ready' sample AND every such sample passes:
(a) v3 reprocess job done,
(b) sections exist with non-NULL summary + centroid embeddings,
(c) every section has >=1 chunker_version=3 child chunk,
(d) actual section count = v3_expected_section_count - v3_skipped_empty_count
    (when the worker recorded a count; NULL-tolerant for pre-invariant samples).

Round-5 C1: filters on fetch_status='ready'. Round-5 M2: NULL creator → FALSE.
SECURITY DEFINER + locked search_path; read-only.$c$;

REVOKE ALL ON FUNCTION public.creator_v3_ready(uuid)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.creator_v3_ready(uuid)
  TO service_role, authenticated;
