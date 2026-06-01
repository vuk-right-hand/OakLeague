-- RAG v3 step 7 / mig 50 — corpus_reprocess_finalize_v3 + mark_done_v3 upgrade.
-- ADDITIVE-BUILD semantics (round-5 audit C1): finalize_v3 deletes ONLY
-- chunker_version=1 chunks; v2 chunks + v2 units SURVIVE (live read path
-- during the build-then-flip window); v3 chunks/units survive. The v1+v2
-- cutover happens at the flip (tested in admin_set_retrieval_version_v3_gate).
--
-- Coverage:
--   1. service-role only.
--   2. BUILD-PHASE happy path: creator still at retrieval_version=2 (the
--      real build-window state). finalize_v3 → returns new version, DELETEs
--      v1 chunks ONLY, PRESERVES v2 chunks (live read path), PRESERVES v3
--      chunks, PRESERVES v2 units (section_id NULL), PRESERVES v3 units,
--      bumps current_corpus_version, flips job done + finished_at.
--   3. target_version=2 job → finalize_v3 silent-abandons (NULL).
--   4. enqueue_version mismatch → NULL, no bump.
--   5. job not 'processing' → NULL.
--   6. v1 chunks for OTHER samples NOT deleted (sample-scoped).
--   7. advisory-lock textual proof: SAME hashtext('reprocess:') key as v2.
--   8. mark_done_v3 DELEGATES (deletes v1 only + bumps + returns p_job_id).
--   9. mark_done_v3 on target_version=2 job → NULL (gate preserved).

BEGIN;
SELECT plan(9);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user        uuid := tests.create_auth_user('crfv3@test');
  v_app         uuid;
  v_creator     uuid;
  v_sample1     uuid;
  v_sample2     uuid;
  v_sec1        uuid;
  v_unit_v3     uuid;
  v_job1        uuid;
  v_job2        uuid;
  v_job_v2      uuid;
  v_vec         halfvec(768);
  v_new_version int;
  v_v1_count    int;
  v_v2_count    int;
  v_v3_count    int;
  v_v2units     int;
  v_v3units     int;
  v_other       int;
  v_status      text;
  v_finished    timestamptz;
  v_done_ret    uuid;
  v_active_gen  int;
BEGIN
  SELECT array_fill(0::real, ARRAY[768])::halfvec(768) INTO v_vec;

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'CRFV3', 'crfv3', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  -- Creator at retrieval_version=2 — THE BUILD-PHASE STATE (round-5 C1/C3):
  -- finalize_v3 runs per-sample while the creator is still reading v2.
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, retrieval_version)
    VALUES (gen_random_uuid(), v_user, v_app, 'CRFV3', 'crfv3', 'ready', 2)
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);

  -- 1: service-role only.
  RETURN NEXT ok(
    NOT has_function_privilege('public',
        'public.corpus_reprocess_finalize_v3(uuid, int, int)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated'::regrole,
        'public.corpus_reprocess_finalize_v3(uuid, int, int)', 'EXECUTE')
    AND has_function_privilege('service_role'::regrole,
        'public.corpus_reprocess_finalize_v3(uuid, int, int)', 'EXECUTE'),
    '1: corpus_reprocess_finalize_v3 is service-role-only'
  );

  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'S1', 'b1', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample1;
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'S2', 'b2', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample2;

  -- v3 section + v3 unit for sample1 (the just-built v3 artifacts).
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    (v_sample1, v_creator, 0, 'Sec', 's', 0, 100, ARRAY['topic-a'], v_vec, v_vec)
  RETURNING id INTO v_sec1;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample1, v_creator, 1000, 'V3 Unit', 'u', 10, ARRAY['topic-a'], v_sec1)
  RETURNING id INTO v_unit_v3;

  -- v2-shape unit (section_id NULL) for sample1 — MUST SURVIVE during build
  -- (it backs the live v2 chunk). unit_index 0 (below the v3 base of 1000).
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample1, v_creator, 0, 'V2 Unit', 'u2', 10, ARRAY['topic-a'], NULL);

  -- Chunks for sample1: v1 (deleted), v2 (SURVIVES — live read), v3 (survives).
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version)
  VALUES
    (gen_random_uuid(), v_sample1, v_creator, 0, 'v1 chunk', ARRAY['topic-a'], v_vec, 1),
    (gen_random_uuid(), v_sample1, v_creator, 1, 'v2 chunk', ARRAY['topic-a'], v_vec, 2);
  PERFORM public._insert_chunk_v3_unsafe(
    v_unit_v3, v_sec1, 0, 'v3 chunk', NULL, 10, ARRAY['topic-a'], v_vec);

  -- v1 chunk for sample2 (control — must NOT be deleted).
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version)
  VALUES
    (gen_random_uuid(), v_sample2, v_creator, 0, 's2 v1 chunk', ARRAY['topic-a'], v_vec, 1);

  DELETE FROM public.sample_content_embedding_jobs WHERE sample_id IN (v_sample1, v_sample2);
  DELETE FROM public.corpus_reprocess_jobs WHERE sample_id IN (v_sample1, v_sample2);
  INSERT INTO public.corpus_reprocess_jobs
    (sample_id, target_version, status, attempts, enqueue_version, claimed_by, claimed_at)
  VALUES (v_sample1, 3, 'processing', 1, 1, 'test-worker', now())
  RETURNING id INTO v_job1;

  -- 2: BUILD-PHASE happy path — v1 deleted, v2 + v3 + v2unit all SURVIVE.
  -- finalize is called with p_target_generation=1 (the sample's default active
  -- gen), so the swap here is 1->1: this case proves finalize WRITES the pointer
  -- to the requested generation (not that it skips the UPDATE) alongside the
  -- v1-delete / version-bump / job-done behavior. The pointer MOVE (1->2 +
  -- route/fetch/gate following the new active gen) is proven in
  -- v3_section_generations.test.sql case 8.
  SELECT public.corpus_reprocess_finalize_v3(v_job1, 1, 1) INTO v_new_version;
  SELECT active_section_generation INTO v_active_gen
    FROM public.sample_content WHERE id = v_sample1;
  SELECT count(*) INTO v_v1_count FROM public.sample_content_chunks
   WHERE sample_id = v_sample1 AND chunker_version = 1;
  SELECT count(*) INTO v_v2_count FROM public.sample_content_chunks
   WHERE sample_id = v_sample1 AND chunker_version = 2;
  SELECT count(*) INTO v_v3_count FROM public.sample_content_chunks
   WHERE sample_id = v_sample1 AND chunker_version = 3;
  SELECT count(*) INTO v_v2units FROM public.sample_content_narrative_units
   WHERE sample_id = v_sample1 AND section_id IS NULL;
  SELECT count(*) INTO v_v3units FROM public.sample_content_narrative_units
   WHERE sample_id = v_sample1 AND section_id IS NOT NULL;
  SELECT status, finished_at INTO v_status, v_finished
    FROM public.corpus_reprocess_jobs WHERE id = v_job1;
  RETURN NEXT ok(
    v_new_version = 2
      AND v_active_gen = 1    -- finalize WROTE the pointer to p_target_generation
      AND v_v1_count = 0      -- v1 deleted
      AND v_v2_count = 1      -- v2 PRESERVED (live read during build)
      AND v_v3_count = 1      -- v3 preserved
      AND v_v2units = 1       -- v2 unit PRESERVED
      AND v_v3units = 1       -- v3 unit preserved
      AND v_status = 'done'
      AND v_finished IS NOT NULL,
    format('2: build-phase finalize_v3 → ver=%s gen=%s v1=%s v2=%s v3=%s v2u=%s v3u=%s status=%s',
           v_new_version, v_active_gen, v_v1_count, v_v2_count, v_v3_count, v_v2units, v_v3units, v_status)
  );

  -- 6: sample2 v1 chunk NOT deleted (sample-scoped).
  SELECT count(*) INTO v_other FROM public.sample_content_chunks WHERE sample_id = v_sample2;
  RETURN NEXT ok(v_other = 1, format('6: sample2 chunk preserved (sample-scoped) — got %s', v_other));

  -- 3: target_version=2 job → finalize_v3 silent-abandons.
  INSERT INTO public.corpus_reprocess_jobs
    (sample_id, target_version, status, attempts, enqueue_version, claimed_by, claimed_at)
  VALUES (v_sample2, 2, 'processing', 1, 1, 'test-worker', now())
  RETURNING id INTO v_job_v2;
  SELECT public.corpus_reprocess_finalize_v3(v_job_v2, 1, 1) INTO v_new_version;
  SELECT current_corpus_version INTO v_v1_count FROM public.creators WHERE id = v_creator;
  RETURN NEXT ok(
    v_new_version IS NULL AND v_v1_count = 2,
    format('3: target_version=2 job → finalize_v3 silent-abandons (ret=%s ver=%s)',
           COALESCE(v_new_version::text, 'NULL'), v_v1_count)
  );

  -- 4: enqueue_version mismatch → NULL, no bump.
  INSERT INTO public.corpus_reprocess_jobs
    (sample_id, target_version, status, attempts, enqueue_version, claimed_by, claimed_at)
  VALUES (v_sample2, 3, 'processing', 1, 7, 'test-worker', now())
  RETURNING id INTO v_job2;
  SELECT public.corpus_reprocess_finalize_v3(v_job2, 4, 1) INTO v_new_version;
  SELECT current_corpus_version INTO v_v1_count FROM public.creators WHERE id = v_creator;
  RETURN NEXT ok(
    v_new_version IS NULL AND v_v1_count = 2,
    format('4: enqueue_version mismatch → NULL + no bump (ret=%s ver=%s)',
           COALESCE(v_new_version::text, 'NULL'), v_v1_count)
  );

  -- 5: job not 'processing' → NULL.
  UPDATE public.corpus_reprocess_jobs SET status = 'done' WHERE id = v_job2;
  SELECT public.corpus_reprocess_finalize_v3(v_job2, 7, 1) INTO v_new_version;
  RETURN NEXT ok(
    v_new_version IS NULL,
    format('5: non-processing job → NULL (got %s)', COALESCE(v_new_version::text, 'NULL'))
  );

  -- 7: advisory-lock textual proof — SAME key as v2 finalize.
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.proname = 'corpus_reprocess_finalize_v3'
         AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
         AND pg_get_functiondef(p.oid) ILIKE '%pg_advisory_xact_lock%hashtext%reprocess:%'
    ),
    '7: finalize_v3 takes pg_advisory_xact_lock on hashtext(''reprocess:''||creator_id)'
  );

  -- 8: mark_done_v3 DELEGATES (deletes v1 only, bumps, returns p_job_id).
  -- Fresh v3 job + v1 chunk for sample2; mark_done_v3 should delete the v1
  -- chunk (only), bump version, return p_job_id. (sample2 still has its
  -- original v1 chunk from setup; add another for clarity.)
  INSERT INTO public.sample_content_chunks
    (id, sample_id, creator_id, chunk_index, text, topic_tags, embedding, chunker_version)
  VALUES
    (gen_random_uuid(), v_sample2, v_creator, 5, 's2 v1 b', ARRAY['topic-a'], v_vec, 1),
    (gen_random_uuid(), v_sample2, v_creator, 6, 's2 v2 b', ARRAY['topic-a'], v_vec, 2);
  DELETE FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample2;
  INSERT INTO public.corpus_reprocess_jobs
    (sample_id, target_version, status, attempts, enqueue_version, claimed_by, claimed_at)
  VALUES (v_sample2, 3, 'processing', 1, 1, 'test-worker', now())
  RETURNING id INTO v_job2;
  SELECT public.corpus_reprocess_mark_done_v3(v_job2, 1, 1) INTO v_done_ret;
  SELECT count(*) INTO v_v1_count FROM public.sample_content_chunks
   WHERE sample_id = v_sample2 AND chunker_version = 1;
  SELECT count(*) INTO v_v2_count FROM public.sample_content_chunks
   WHERE sample_id = v_sample2 AND chunker_version = 2;
  SELECT current_corpus_version INTO v_new_version FROM public.creators WHERE id = v_creator;
  RETURN NEXT ok(
    v_done_ret = v_job2 AND v_v1_count = 0 AND v_v2_count = 1 AND v_new_version = 3,
    format('8: mark_done_v3 delegates (v1-only delete) (ret=%s v1=%s v2=%s ver=%s)',
           COALESCE(v_done_ret::text, 'NULL'), v_v1_count, v_v2_count, v_new_version)
  );

  -- 9: mark_done_v3 on a target_version=2 job → NULL (gate through delegation).
  INSERT INTO public.corpus_reprocess_jobs
    (sample_id, target_version, status, attempts, enqueue_version, claimed_by, claimed_at)
  VALUES (v_sample2, 2, 'processing', 1, 1, 'test-worker', now())
  RETURNING id INTO v_job_v2;
  SELECT public.corpus_reprocess_mark_done_v3(v_job_v2, 1, 1) INTO v_done_ret;
  SELECT status INTO v_status FROM public.corpus_reprocess_jobs WHERE id = v_job_v2;
  RETURN NEXT ok(
    v_done_ret IS NULL AND v_status = 'processing',
    format('9: mark_done_v3 refuses v2 job through delegation (ret=%s status=%s)',
           COALESCE(v_done_ret::text, 'NULL'), v_status)
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
