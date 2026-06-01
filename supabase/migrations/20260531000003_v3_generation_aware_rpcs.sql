-- 20260531000003 — generation-aware v3 RPCs (Step-9 audit C2/C3, plan REV 3).
--
-- Companion to 20260531000002 (the generation columns + UNIQUE swaps). This
-- migration makes every v3 READER + the finalize swap generation-aware so a
-- re-ingest builds a new generation invisibly and swaps it in atomically.
--
-- Edits (plan REV 3 + 3rd-audit Mediums):
--   • _creator_route_sections_v3      — gen filter as a correlated SCALAR inside
--                                       both HNSW CTEs (M-3: scalar equality does
--                                       NOT defeat the partial-index scan; a
--                                       semi-join would, and an outer filter
--                                       starves the candidate window).
--   • _creator_active_section_ids_v3  — NEW (R2): active-gen ids for the flat
--                                       fallback (replaces the raw client SELECT).
--   • creator_v3_ready                — clauses (b)(c)(d) gen-scoped to the
--                                       sample's active generation (R3/R4/M-2).
--   • corpus_reprocess_finalize_v3    — atomic swap of active_section_generation
--                                       + write expected/skipped counts in the
--                                       SAME txn (M-2/M-3); NO old-gen GC here
--                                       (C-3: GC is the deferred sweep below);
--                                       v1 delete preserved; corpus_version bump.
--   • corpus_reprocess_mark_done_v3   — wrapper gains p_target_generation,
--                                       forwards it (M-1 signature chain).
--   • _insert_chunk_v3_unsafe         — DERIVES section_generation from the
--                                       section row (M-5: never trust an arg —
--                                       keeps the parameter-trust closure).
--   • admin_gc_stale_section_generations — NEW deferred GC (keeps active+prior).
--
-- Generation numbering (plan M-1): DEFAULT 1 = pre-migration data; future v3
-- builds target active+1, so live v3 re-ingests are gen ≥ 2.

-- ════════════════════════════════════════════════════════════════════════
-- 1. _insert_chunk_v3_unsafe — derive section_generation (M-5)
--    Same body as mig 14 + read section_generation alongside section_index and
--    write it into the chunk. NO new arg (trusting an arg would reopen the
--    parameter-trust hole mig 13/14 exists to close). Signature UNCHANGED.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public._insert_chunk_v3_unsafe(
  p_parent_unit_id  uuid,
  p_section_id      uuid,
  p_chunk_index     int,
  p_text            text,
  p_chunk_context   text,
  p_token_count     int,
  p_topic_tags      text[],
  p_embedding       halfvec(768),
  p_embedding_model text DEFAULT 'gemini-embedding-001'
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_parent_sample        uuid;
  v_parent_section_id    uuid;
  v_creator_id           uuid;
  v_section_sample       uuid;
  v_section_index        smallint;
  v_section_generation   int;
  v_chunk_id             uuid;
  v_bad                  text[];
BEGIN
  SELECT sample_id, creator_id, section_id
    INTO v_parent_sample, v_creator_id, v_parent_section_id
    FROM public.sample_content_narrative_units
   WHERE id = p_parent_unit_id;
  IF v_parent_sample IS NULL THEN
    RAISE EXCEPTION USING errcode = '42704', message = 'parent_unit_not_found';
  END IF;

  IF v_parent_section_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '23514',
      message = 'parent_unit_missing_section_id — v3 chunk cannot parent to a v1/v2 narrative_unit';
  END IF;

  -- Derive section_index AND section_generation from the section row (M-5).
  -- The chunk's generation MUST equal its section's generation by definition
  -- (same tree node) — derive it, never accept it as an arg.
  SELECT sample_id, section_index, section_generation
    INTO v_section_sample, v_section_index, v_section_generation
    FROM public.sample_content_sections
   WHERE id = p_section_id;
  IF v_section_sample IS NULL THEN
    RAISE EXCEPTION USING errcode = '42704', message = 'section_not_found';
  END IF;

  IF p_section_id <> v_parent_section_id THEN
    RAISE EXCEPTION USING errcode = '23514',
      message = 'section_parent_mismatch — chunk section_id <> parent_unit.section_id';
  END IF;

  IF v_section_sample <> v_parent_sample THEN
    RAISE EXCEPTION USING errcode = '23514',
      message = 'section_sample_mismatch — chunk parent_unit.sample_id <> section.sample_id';
  END IF;

  SELECT array_agg(t) INTO v_bad
    FROM unnest(p_topic_tags) t
    WHERE NOT EXISTS (
      SELECT 1 FROM public.creator_topics
       WHERE creator_id = v_creator_id AND slug = t
    );
  IF v_bad IS NOT NULL AND cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION 'sample_content_chunks.topic_tags contains unregistered slugs: %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index, section_generation)
  VALUES
    (v_parent_sample, v_creator_id, p_chunk_index, p_text, p_chunk_context,
     p_token_count, p_topic_tags, p_embedding, p_embedding_model, now(),
     p_parent_unit_id, 3, p_section_id, v_section_index, v_section_generation)
  RETURNING id INTO v_chunk_id;

  RETURN v_chunk_id;
END;$$;

COMMENT ON FUNCTION public._insert_chunk_v3_unsafe(uuid, uuid, int, text, text, int, text[], halfvec(768), text) IS
  'Single-write insert for v3 chunks. Derives sample_id+creator_id from parent_unit (audit-2 C1) AND section_index+section_generation from the section row (Step-9 audit M-5 — never trust a gen arg; the chunk gen MUST equal its section gen). Round-5 C2 cross-section closure preserved. Writes section_generation into the chunk so the (sample,chunker_version,section_generation,section_index,chunk_index) partial UNIQUE lets two generations coexist (C-1). Service-role only.';

REVOKE ALL ON FUNCTION public._insert_chunk_v3_unsafe(uuid, uuid, int, text, text, int, text[], halfvec(768), text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._insert_chunk_v3_unsafe(uuid, uuid, int, text, text, int, text[], halfvec(768), text)
  TO service_role;


-- ════════════════════════════════════════════════════════════════════════
-- 2. _creator_route_sections_v3 — gen filter as correlated SCALAR (M-3)
--    Body identical to mig 30 EXCEPT each HNSW CTE's WHERE gains:
--      AND s.section_generation = (SELECT sc.active_section_generation
--                                  FROM sample_content sc WHERE sc.id = s.sample_id)
--    A correlated scalar equality on a PK lookup is the SAME filter class as
--    the existing `s.creator_id = p_creator_id` — it does NOT defeat the partial
--    HNSW index scan (driven by `ORDER BY embedding <=> vec LIMIT k` + the
--    TEXTUAL IS NOT NULL predicates, all preserved). An EXISTS/IN semi-join
--    WOULD; an outer-after-LIMIT filter would STARVE the candidate window with
--    inactive-gen near-duplicates mid-re-ingest. pgTAP EXPLAIN-asserts the
--    Index Scan survives WITH two generations present.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public._creator_route_sections_v3(
  p_creator_id   uuid,
  p_query_vec    halfvec(768),
  p_topic_tags   text[]  DEFAULT NULL,
  p_top_s        int     DEFAULT 4,
  p_min_sim      float   DEFAULT 0.30,
  p_lambda_topic float   DEFAULT 0.05
) RETURNS TABLE (
  section_id     uuid,
  sample_id      uuid,
  title          text,
  summary_sim    float,
  centroid_sim   float,
  topic_boost    float,
  score          float
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  BEGIN
    PERFORM set_config('hnsw.iterative_scan', 'strict_order', true);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN QUERY
  WITH params AS (
    SELECT GREATEST(1, LEAST(p_top_s, 10))::int    AS top_s,
           GREATEST(0::float, LEAST(p_min_sim, 1.0)) AS min_sim
  ),
  summary_top AS (
    SELECT s.id           AS section_id,
           s.sample_id    AS sample_id,
           s.title        AS title,
           s.topic_tags   AS topic_tags,
           1 - (s.summary_embedding <=> p_query_vec) AS sim
      FROM public.sample_content_sections s, params
     WHERE s.creator_id = p_creator_id
       AND s.summary_embedding IS NOT NULL    -- audit M3 — partial-HNSW pushdown
       AND s.centroid_embedding IS NOT NULL
       -- Step-9 M-3: active-generation filter (correlated scalar, preserves HNSW).
       AND s.section_generation = (
         SELECT sc.active_section_generation
           FROM public.sample_content sc WHERE sc.id = s.sample_id
       )
     ORDER BY s.summary_embedding <=> p_query_vec
     LIMIT (SELECT top_s * 3 FROM params)
  ),
  centroid_top AS (
    SELECT s.id           AS section_id,
           s.sample_id    AS sample_id,
           s.title        AS title,
           s.topic_tags   AS topic_tags,
           1 - (s.centroid_embedding <=> p_query_vec) AS sim
      FROM public.sample_content_sections s, params
     WHERE s.creator_id = p_creator_id
       AND s.summary_embedding IS NOT NULL    -- audit M3 — partial-HNSW pushdown
       AND s.centroid_embedding IS NOT NULL
       -- Step-9 M-3: active-generation filter (correlated scalar, preserves HNSW).
       AND s.section_generation = (
         SELECT sc.active_section_generation
           FROM public.sample_content sc WHERE sc.id = s.sample_id
       )
     ORDER BY s.centroid_embedding <=> p_query_vec
     LIMIT (SELECT top_s * 3 FROM params)
  ),
  merged AS (
    SELECT COALESCE(s.section_id, c.section_id)             AS section_id,
           COALESCE(s.sample_id,  c.sample_id)              AS sample_id,
           COALESCE(s.title,      c.title)                  AS title,
           COALESCE(s.topic_tags, c.topic_tags)             AS topic_tags,
           COALESCE(s.sim, 0)                               AS summary_sim,
           COALESCE(c.sim, 0)                               AS centroid_sim
      FROM summary_top  s
      FULL OUTER JOIN centroid_top c ON c.section_id = s.section_id
  ),
  scored AS (
    SELECT m.section_id,
           m.sample_id,
           m.title,
           m.summary_sim,
           m.centroid_sim,
           CASE
             WHEN p_topic_tags IS NULL OR cardinality(p_topic_tags) = 0 THEN 0::float
             ELSE p_lambda_topic * cardinality(
               ARRAY(SELECT unnest(m.topic_tags) INTERSECT SELECT unnest(p_topic_tags))
             )::float
           END                                              AS topic_boost,
           GREATEST(m.summary_sim, m.centroid_sim)          AS sim_max
      FROM merged m
  ),
  gated AS (
    SELECT s.section_id,
           s.sample_id,
           s.title,
           s.summary_sim,
           s.centroid_sim,
           s.topic_boost,
           (s.sim_max + s.topic_boost)::float AS score
      FROM scored s, params
     WHERE s.sim_max >= params.min_sim
  )
  SELECT g.section_id, g.sample_id, g.title,
         g.summary_sim, g.centroid_sim, g.topic_boost, g.score
    FROM gated g, params
   ORDER BY g.score DESC
   LIMIT (SELECT top_s FROM params);
END;
$$;

COMMENT ON FUNCTION public._creator_route_sections_v3(uuid, halfvec, text[], int, float, float) IS
  'v3 routing: top-S sections for a query. Score = max(cos summary, cos centroid) + topic boost. Partial-HNSW pushdown via TEXTUAL IS NOT NULL predicates (audit M3). Step-9 audit M-3: filters to the sample''s active_section_generation via a correlated scalar inside both HNSW CTEs (does NOT defeat the index scan; keeps inactive-gen sections from starving the candidate window during a re-ingest). Caller passes session-closure-captured creator_id; SECURITY DEFINER. p_top_s [1,10], p_min_sim [0,1].';

REVOKE ALL ON FUNCTION public._creator_route_sections_v3(uuid, halfvec, text[], int, float, float)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._creator_route_sections_v3(uuid, halfvec, text[], int, float, float)
  TO service_role, authenticated;


-- ════════════════════════════════════════════════════════════════════════
-- 3. _creator_active_section_ids_v3 — NEW (R2)
--    Active-generation section ids for the flat fallback (replaces the raw
--    client SELECT at retrieve-knowledge.ts:1421-1430, which had NO gen filter).
--    Returns the SAME id set the route would consider (same active-gen rule +
--    IS NOT NULL gate) — pgTAP asserts R1 and R2 agree.
-- ════════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._creator_active_section_ids_v3(
  p_creator_id uuid,
  p_limit      int DEFAULT 50
) RETURNS TABLE (section_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT s.id
    FROM public.sample_content_sections s
    JOIN public.sample_content sc ON sc.id = s.sample_id
   WHERE s.creator_id = p_creator_id
     AND s.section_generation = sc.active_section_generation
     AND s.summary_embedding  IS NOT NULL
     AND s.centroid_embedding IS NOT NULL
   ORDER BY s.section_index
   LIMIT GREATEST(1, LEAST(p_limit, 200));
$$;

COMMENT ON FUNCTION public._creator_active_section_ids_v3(uuid, int) IS
  'v3 flat-fallback support (Step-9 audit R2/C-1): active-generation section ids for a creator, IS-NOT-NULL-gated like the route. Replaces the raw client SELECT (retrieve-knowledge.ts) that had no generation filter and would pull both generations + duplicate section_index rows mid-re-ingest. Returns the same id set the route considers. Service-role/authenticated.';

REVOKE ALL ON FUNCTION public._creator_active_section_ids_v3(uuid, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._creator_active_section_ids_v3(uuid, int)
  TO service_role, authenticated;


-- ════════════════════════════════════════════════════════════════════════
-- 3b. _fetch_active_parents_v3 — gen-filtered cache-hit parent re-fetch (R5/C-2)
--    The cache stores parent_unit_ids keyed on (creator_id, corpus_version,
--    query_hash). corpusVersionAtSession is FROZEN at session-open (index.js:1016,
--    "never live-read mid-session"), so a corpus_version bump CANNOT invalidate
--    an in-flight session's cache. If a re-ingest swaps generations mid-session,
--    a cache hit would return OLD-generation parent ids. This RPC gen-filters
--    the by-id fetch server-side: a stale-gen id (its section_generation no
--    longer equals its sample's active_section_generation) returns 0 rows
--    deterministically, regardless of cache/session timing. The TS caller
--    (fetchParentNarrativesByIds) treats 0 rows as a cache miss → fresh retrieve.
--    Replaces the raw `.from(narrative_units).select(...).in(id, ids)` which had
--    no gen filter (C-2). Joins sample_content for source_type (the envelope
--    needs it) + active_section_generation (the gen gate) in one server hop.
-- ════════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._fetch_active_parents_v3(
  p_creator_id uuid,
  p_ids        uuid[]
) RETURNS TABLE (id uuid, text text, title text, source_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.text, u.title, sc.source_type
    FROM public.sample_content_narrative_units u
    JOIN public.sample_content sc ON sc.id = u.sample_id
   WHERE u.creator_id = p_creator_id
     AND u.id = ANY(p_ids)
     -- gen gate: only parents whose generation is the sample's ACTIVE one.
     -- v2-legacy units (section_id NULL, section_generation 1) are served only
     -- when the sample is still on active generation 1 — correct: a v2-on-v3
     -- creator reads v3 (section_id NOT NULL) parents; this RPC is the v3
     -- cache-hit path, and a v2 parent id can't be in a v3 cache row anyway.
     AND u.section_generation = sc.active_section_generation;
$$;

COMMENT ON FUNCTION public._fetch_active_parents_v3(uuid, uuid[]) IS
  'v3 cache-hit parent re-fetch, gen-filtered (Step-9 audit R5/C-2). Returns only parents whose section_generation equals their sample''s active_section_generation, so a stale-generation id (after a mid-session re-ingest swap) deterministically returns 0 rows → caller treats as cache miss. Replaces a raw by-id select that had no gen filter; the corpus_version bump cannot fix this because corpusVersionAtSession is frozen at session-open. Joins sample_content for source_type + the active-gen gate. Service-role/authenticated.';

REVOKE ALL ON FUNCTION public._fetch_active_parents_v3(uuid, uuid[])
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._fetch_active_parents_v3(uuid, uuid[])
  TO service_role, authenticated;


-- ════════════════════════════════════════════════════════════════════════
-- 4. creator_v3_ready — gen-scope clauses (b)(c)(d) (R3/R4/M-2)
--    Each section subquery filters to the sample's active generation, so the
--    mid-build NEW generation (NULL embeddings, partial chunks, ~2x count) is
--    invisible to the gate → the gate reflects the ACTIVE gen → stays TRUE
--    during a re-ingest (C3 closed). Clause (c)'s chunk check is keyed on
--    section_id AND carries an explicit c.section_generation = s.section_generation
--    predicate (Step-9 CODE-audit M4 — defense-in-depth past the plan-audit M-4
--    stance; redundant under the single-writer invariant, but the gate no longer
--    DEPENDS on it). Clause (d) count gen-scoped (M-2).
-- ════════════════════════════════════════════════════════════════════════
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
           -- (b) no ACTIVE-gen sections at all.
           OR NOT EXISTS (
             SELECT 1 FROM public.sample_content_sections s
              WHERE s.sample_id = sc.id
                AND s.section_generation = sc.active_section_generation
           )
           -- (b) any ACTIVE-gen section with NULL embedding.
           OR EXISTS (
             SELECT 1 FROM public.sample_content_sections s
              WHERE s.sample_id = sc.id
                AND s.section_generation = sc.active_section_generation
                AND (s.summary_embedding  IS NULL
                  OR s.centroid_embedding IS NULL)
           )
           -- (c) any ACTIVE-gen section without >=1 v3 child chunk. The chunk
           -- check is keyed on section_id AND carries an explicit chunk-gen
           -- predicate (Step-9 CODE-audit M4 — hardens past the plan-audit M-4
           -- stance). Today _insert_chunk_v3_unsafe derives a chunk's
           -- section_generation FROM its section, so c.section_generation always
           -- equals s.section_generation and the predicate is redundant-but-free.
           -- Adding it means the gate no longer DEPENDS on that single-writer
           -- invariant holding forever: a future writer that mis-stamps a chunk's
           -- generation can't make a half-built creator read as ready.
           OR EXISTS (
             SELECT 1 FROM public.sample_content_sections s
              WHERE s.sample_id = sc.id
                AND s.section_generation = sc.active_section_generation
                AND NOT EXISTS (
                  SELECT 1 FROM public.sample_content_chunks c
                   WHERE c.section_id          = s.id
                     AND c.chunker_version     = 3
                     AND c.section_generation  = s.section_generation
                )
           )
           -- (d) ACTIVE-gen section-count invariant (M-2: gen-scoped count).
           OR (
             sc.v3_expected_section_count IS NOT NULL
             AND (
               SELECT count(*) FROM public.sample_content_sections s
                WHERE s.sample_id = sc.id
                  AND s.section_generation = sc.active_section_generation
             ) <> (sc.v3_expected_section_count - COALESCE(sc.v3_skipped_empty_count, 0))
           )
         )
    )
  );
END;
$$;

COMMENT ON FUNCTION public.creator_v3_ready(uuid) IS
$c$Plan §6 step 2 + audit round-1 M4 + Step-9 audit R3/R4/M-2. TRUE iff creator has >=1 fetch_status=ready sample AND every such sample passes (a) v3 job done, (b) ACTIVE-generation sections exist with non-NULL embeddings, (c) every active-gen section has >=1 v3 child chunk, (d) active-gen section count = v3_expected - v3_skipped (when recorded). All section subqueries gen-scoped to sample_content.active_section_generation so a mid-re-ingest new generation is invisible → gate stays TRUE during re-ingest. NULL creator → FALSE. SECURITY DEFINER, read-only.$c$;

REVOKE ALL ON FUNCTION public.creator_v3_ready(uuid)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.creator_v3_ready(uuid)
  TO service_role, authenticated;


-- ════════════════════════════════════════════════════════════════════════
-- 5. corpus_reprocess_finalize_v3 — atomic generation SWAP (M-1/M-2/M-3, C-3)
--    New arg p_target_generation. Under the per-creator advisory lock, one txn:
--      (1) swap active_section_generation = p_target_generation + write the
--          expected/skipped counts (worker still writes them pre-finalize; here
--          we re-stamp them atomically WITH the swap so clause (d) flips together
--          — M-2). Worker passes the counts via sample_content already; finalize
--          just moves the POINTER, and the counts the worker wrote describe the
--          generation being activated.
--      (2) bump current_corpus_version (cache freshness for NEW sessions).
--      (3) delete chunker_version=1 (preserved from mig 50).
--      (4) NO old-generation GC here (C-3 — that's the deferred sweep #7;
--          deleting the old gen at swap would re-introduce the one-way-door
--          rollback bug C1 just fixed).
--      (5) mark job done.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.corpus_reprocess_finalize_v3(
  p_job_id            uuid,
  p_claimed_version   int,
  p_target_generation int
) RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sample_id   uuid;
  v_creator_id  uuid;
  v_new_version int;
BEGIN
  SET LOCAL lock_timeout = '5s';

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
    RETURN NULL;   -- silent-abandon: job missing / not processing / version-mismatch / target<>3
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('reprocess:' || v_creator_id::text));

  -- (1) ATOMIC SWAP — activate the just-built generation. The worker already
  -- wrote v3_expected_section_count / v3_skipped_empty_count for THIS build to
  -- the sample row pre-finalize; the pointer flip here makes them describe the
  -- now-active generation in the same txn (M-2: clause (d) flips with the swap).
  UPDATE public.sample_content
     SET active_section_generation = p_target_generation
   WHERE id = v_sample_id;

  -- (3) ADDITIVE-BUILD: delete chunker_version=1 ONLY (preserved from mig 50).
  -- v2 chunks survive until the v2→v3 flip soft-cutover. v3 OLD generations
  -- survive until the deferred GC (rollback safety).
  DELETE FROM public.sample_content_chunks
   WHERE sample_id = v_sample_id
     AND chunker_version = 1;

  -- (2) cache-invalidation revision bump (new sessions).
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

COMMENT ON FUNCTION public.corpus_reprocess_finalize_v3(uuid, int, int) IS
  'Atomic v3 worker-finalize for one sample (target_version=3). Step-9 audit C2/C3: SWAPS sample_content.active_section_generation to p_target_generation (activating the just-built generation; the worker''s pre-finalize expected/skipped counts describe it). Deletes chunker_version=1 only (additive-build); v2 chunks + OLD v3 generations survive (rollback safety — NO old-gen GC here, that''s admin_gc_stale_section_generations). Bumps current_corpus_version. pg_advisory_xact_lock(reprocess:||creator_id) — same key/order as the flip + GC + purge. Returns new corpus_version, NULL on silent-abandon, RAISES 02000 on creator-disappeared. Service-role only.';

REVOKE ALL ON FUNCTION public.corpus_reprocess_finalize_v3(uuid, int, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.corpus_reprocess_finalize_v3(uuid, int, int)
  TO service_role;

-- Drop the OLD 2-arg finalize (superseded by the 3-arg). It was only ever
-- called by mark_done_v3, which we re-point below.
DROP FUNCTION IF EXISTS public.corpus_reprocess_finalize_v3(uuid, int);


-- ════════════════════════════════════════════════════════════════════════
-- 6. corpus_reprocess_mark_done_v3 — wrapper gains p_target_generation (M-1)
--    The worker calls THIS; it forwards to the 3-arg finalize. Signature
--    changes (uuid,int) → (uuid,int,int) so the worker call site updates too.
--    Drop the old 2-arg wrapper first (signature change).
-- ════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.corpus_reprocess_mark_done_v3(uuid, int);

CREATE FUNCTION public.corpus_reprocess_mark_done_v3(
  p_job_id            uuid,
  p_claimed_version   int,
  p_target_generation int
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_new_version int;
BEGIN
  v_new_version := public.corpus_reprocess_finalize_v3(
    p_job_id, p_claimed_version, p_target_generation);
  IF v_new_version IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN p_job_id;
END;
$$;

COMMENT ON FUNCTION public.corpus_reprocess_mark_done_v3(uuid, int, int) IS
  'v3 worker-finish wrapper. Step-9 audit M-1: gains p_target_generation, forwarded to corpus_reprocess_finalize_v3 (which swaps the active generation). Returns p_job_id on success, NULL on silent-abandon. The worker (embed-worker.js) passes the generation it just built. Service-role only.';

REVOKE ALL ON FUNCTION public.corpus_reprocess_mark_done_v3(uuid, int, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.corpus_reprocess_mark_done_v3(uuid, int, int)
  TO service_role;


-- ════════════════════════════════════════════════════════════════════════
-- 7. admin_gc_stale_section_generations — deferred GC (C-3, M-2, M-4)
--    Reclaims v3 generations STRICTLY BELOW active-1 per sample (keeps active +
--    immediately-prior for rollback). Only v3 rows (section_generation is a v3
--    concept; v2-legacy units have section_id NULL and are NOT sections, so the
--    section delete never touches them — admin_purge_legacy_chunks owns v1/v2).
--    Re-reads active_section_generation INSIDE the advisory lock (M-2: a finalize
--    swap between read + delete must not let GC delete the just-activated gen).
--    Deleting sections CASCADEs their units + chunks (FK ON DELETE CASCADE).
--    Bumps current_corpus_version. Idempotent. NEVER runs inside finalize (M5).
-- ════════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.admin_gc_stale_section_generations(
  p_creator_id uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id          uuid;
  v_sections_deleted  int := 0;
  v_new_version       int;
  v_result            jsonb;
BEGIN
  v_admin_id := auth.uid();
  PERFORM public._assert_caller_is_admin();

  SET LOCAL lock_timeout = '5s';
  PERFORM pg_advisory_xact_lock(hashtext('reprocess:' || p_creator_id::text));

  -- Delete v3 sections whose generation is strictly below (active - 1) for
  -- their sample. active read INSIDE the lock (M-2). CASCADE wipes units+chunks.
  WITH stale AS (
    SELECT s.id
      FROM public.sample_content_sections s
      JOIN public.sample_content sc ON sc.id = s.sample_id
     WHERE sc.creator_id = p_creator_id
       AND s.section_generation < (sc.active_section_generation - 1)
  )
  DELETE FROM public.sample_content_sections s
   USING stale
   WHERE s.id = stale.id;
  GET DIAGNOSTICS v_sections_deleted = ROW_COUNT;

  -- Bump cache revision if we reclaimed anything.
  IF v_sections_deleted > 0 THEN
    UPDATE public.creators
       SET current_corpus_version = current_corpus_version + 1
     WHERE id = p_creator_id
     RETURNING current_corpus_version INTO v_new_version;
  ELSE
    SELECT current_corpus_version INTO v_new_version
      FROM public.creators WHERE id = p_creator_id;
  END IF;

  v_result := jsonb_build_object(
    'creator_id', p_creator_id,
    'stale_sections_deleted', v_sections_deleted,
    'corpus_version', v_new_version
  );

  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
  VALUES
    (v_admin_id, 'creator_v3_generations_gc', 'creator', p_creator_id,
     '{}'::jsonb, v_result);

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.admin_gc_stale_section_generations(uuid) IS
  'Deferred GC of stale v3 section generations (Step-9 audit C2/C3 + M-4). Deletes sections whose section_generation < active_section_generation - 1 per sample (keeps active + immediately-prior for rollback); CASCADE wipes their units+chunks. Active read INSIDE the reprocess:||id advisory lock so a racing finalize swap cannot make GC delete the just-activated gen. NEVER touches v2-legacy (section_id NULL is not a section). Disjoint from admin_purge_legacy_chunks (that purges chunker_version IN (1,2)). Bumps current_corpus_version when it reclaims. Idempotent. Service-role/admin only.';

REVOKE ALL ON FUNCTION public.admin_gc_stale_section_generations(uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_gc_stale_section_generations(uuid)
  TO authenticated;
