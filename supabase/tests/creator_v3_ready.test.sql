-- RAG v3 step 6 / mig 40 — creator_v3_ready RPC.
--
-- 1. Privileges: service_role + authenticated EXECUTE; public/anon denied.
-- 2. Zero-sample creator → FALSE (no work to verify means no "ready"
--    signal; admin gate must not allow flipping an empty creator).
-- 3. Errored-only samples → FALSE (no non-errored sample).
-- 4. Happy path — one sample passing (a)+(b)+(c) → TRUE.
-- 5. CLEANUP M5 carve-out — one section has summary_embedding=NULL → FALSE.
-- 6. CLEANUP M5 carve-out — one section has centroid_embedding=NULL → FALSE.
-- 7. (a) gate — no done v3 job for the sample → FALSE.
-- 8. (b) gate — sample has zero sections → FALSE.
-- 9. (c) gate — a section exists with no v3 child chunks → FALSE.
-- 10. Multi-sample: one ready + one not-yet-ready → FALSE (every sample
--     must pass; partial readiness doesn't count).
-- 11. Errored sample is IGNORED -- a healthy 'ready' sample + an
--     'errored' sample missing v3 data -> TRUE (errored samples don't gate).
-- 12. Round-5 C1 -- in-flight 'pending' sample is IGNORED. A 'ready' sample
--     fully v3-wired + a coexisting 'pending' sample with no v3 data
--     -> TRUE. Pins the "only-ready" filter contract: a fresh upload 30s
--     before the admin clicks Flip cannot retroactively block the gate.
-- 13. Round-5 M2 -- NULL p_creator_id returns FALSE (caller-friendly).

-- 14. Round-1 M4 — count invariant satisfied: v3_expected_section_count=1,
--     skipped=0, one section present → TRUE.
-- 15. Round-1 M4 — count MISMATCH: expected=2 but only 1 section row → FALSE
--     (a silently dropped section the per-section checks couldn't see).
-- 16. Round-1 M4 — skipped-empty math: expected=2, skipped=1, 1 section → TRUE.

BEGIN;
SELECT plan(16);

-- Local halfvec helper (same pattern as the v3 route/topk tests).
CREATE FUNCTION pg_temp.unit_vec(p_position int) RETURNS halfvec(768)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_arr real[];
        v_idx int := ((p_position - 1) % 768) + 1;
BEGIN
  v_arr := array_fill(0::real, ARRAY[768]);
  v_arr[v_idx] := 1.0::real;
  RETURN v_arr::halfvec(768);
END;
$$;

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user        uuid := tests.create_auth_user('cv3r@test');
  v_app         uuid;
  v_creator     uuid;
  v_sample_ok   uuid;
  v_sample_bad  uuid;
  v_sample_err  uuid;
  v_sec_ok      uuid;
  v_sec_orphan  uuid;
  v_unit_ok     uuid;
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'CV3R', 'cv3r', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'CV3R', 'cv3r', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);

  -- 1: privileges. SECURITY HOTFIX (audit H1, mig 20260601000001): authenticated
  -- DENIED — leaked per-creator readiness for arbitrary creator_id. Only called
  -- in-DB (by admin_set_creator_retrieval_version) + via service-role. service_role ONLY.
  RETURN NEXT ok(
    NOT has_function_privilege('public',
        'public.creator_v3_ready(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon'::regrole,
        'public.creator_v3_ready(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated'::regrole,
        'public.creator_v3_ready(uuid)', 'EXECUTE')
    AND has_function_privilege('service_role'::regrole,
        'public.creator_v3_ready(uuid)', 'EXECUTE'),
    '1: service_role ONLY EXECUTE; public/anon/authenticated denied (audit H1)'
  );

  -- 2: zero samples → FALSE.
  RETURN NEXT is(
    public.creator_v3_ready(v_creator), false,
    '2: zero-sample creator returns FALSE (no work to verify = NOT ready)'
  );

  -- 3: only errored sample → FALSE.
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'Errored', 'e',
            ARRAY['topic-a'], 'errored')
    RETURNING id INTO v_sample_err;
  RETURN NEXT is(
    public.creator_v3_ready(v_creator), false,
    '3: only ''errored'' sample present → FALSE (no non-errored sample)'
  );

  -- 4: happy path — single non-errored sample fully wired.
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'OK', 'body',
            ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample_ok;
  -- (a) corpus_reprocess_jobs done v3.
  INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version, status, enqueue_version)
    VALUES (v_sample_ok, 3, 'done', 1);
  -- (b) one section with non-NULL summary + centroid.
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    (v_sample_ok, v_creator, 0, 'S1', 's', 0, 100, ARRAY['topic-a'],
     pg_temp.unit_vec(1), pg_temp.unit_vec(2))
  RETURNING id INTO v_sec_ok;
  -- (c) parent unit + child v3 chunk in that section.
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample_ok, v_creator, 0, 'U1', 'u', 10, ARRAY['topic-a'], v_sec_ok)
  RETURNING id INTO v_unit_ok;
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index)
  VALUES
    (v_sample_ok, v_creator, 0, 'c', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(1), 'gemini-embedding-001', now(),
     v_unit_ok, 3, v_sec_ok, 0);
  RETURN NEXT is(
    public.creator_v3_ready(v_creator), true,
    '4: happy path — all three (a)+(b)+(c) met → TRUE'
  );

  -- 5: CLEANUP M5 — set summary_embedding to NULL → FALSE.
  UPDATE public.sample_content_sections
     SET summary_embedding = NULL
   WHERE id = v_sec_ok;
  RETURN NEXT is(
    public.creator_v3_ready(v_creator), false,
    '5: section with summary_embedding NULL → FALSE (CLEANUP M5 carve-out)'
  );

  -- 6: CLEANUP M5 — restore summary, NULL centroid → FALSE.
  UPDATE public.sample_content_sections
     SET summary_embedding  = pg_temp.unit_vec(1),
         centroid_embedding = NULL
   WHERE id = v_sec_ok;
  RETURN NEXT is(
    public.creator_v3_ready(v_creator), false,
    '6: section with centroid_embedding NULL → FALSE (CLEANUP M5 carve-out)'
  );

  -- Restore the embeddings so subsequent tests reset cleanly.
  UPDATE public.sample_content_sections
     SET centroid_embedding = pg_temp.unit_vec(2)
   WHERE id = v_sec_ok;

  -- 7: (a) gate — flip the job to 'processing' (no done v3 job).
  UPDATE public.corpus_reprocess_jobs
     SET status = 'processing'
   WHERE sample_id = v_sample_ok AND target_version = 3;
  RETURN NEXT is(
    public.creator_v3_ready(v_creator), false,
    '7: no done v3 job for sample → FALSE (gate a)'
  );
  -- Restore.
  UPDATE public.corpus_reprocess_jobs
     SET status = 'done'
   WHERE sample_id = v_sample_ok AND target_version = 3;

  -- 8: (b) gate — delete sections (sample now has zero sections).
  DELETE FROM public.sample_content_chunks WHERE sample_id = v_sample_ok;
  DELETE FROM public.sample_content_narrative_units WHERE sample_id = v_sample_ok;
  DELETE FROM public.sample_content_sections WHERE id = v_sec_ok;
  RETURN NEXT is(
    public.creator_v3_ready(v_creator), false,
    '8: sample with zero sections → FALSE (gate b)'
  );
  -- Restore section + parent + chunk for subsequent tests.
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    (v_sample_ok, v_creator, 0, 'S1', 's', 0, 100, ARRAY['topic-a'],
     pg_temp.unit_vec(1), pg_temp.unit_vec(2))
  RETURNING id INTO v_sec_ok;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample_ok, v_creator, 0, 'U1', 'u', 10, ARRAY['topic-a'], v_sec_ok)
  RETURNING id INTO v_unit_ok;
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index)
  VALUES
    (v_sample_ok, v_creator, 0, 'c', NULL, 10, ARRAY['topic-a'],
     pg_temp.unit_vec(1), 'gemini-embedding-001', now(),
     v_unit_ok, 3, v_sec_ok, 0);

  -- 9: (c) gate -- add an orphan section with no v3 chunks -> FALSE.
  -- Add a SECOND section to the same sample; the first stays fully wired.
  -- The new orphan section has summary+centroid embeddings (so (b) passes)
  -- but zero child chunks (so (c) trips).
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    (v_sample_ok, v_creator, 1, 'Orphan', 'o', 100, 200, ARRAY['topic-a'],
     pg_temp.unit_vec(3), pg_temp.unit_vec(4))
  RETURNING id INTO v_sec_orphan;
  RETURN NEXT is(
    public.creator_v3_ready(v_creator), false,
    '9: orphan section with zero v3 chunks -> FALSE (gate c)'
  );
  DELETE FROM public.sample_content_sections WHERE id = v_sec_orphan;

  -- 10: multi-sample — one ready + one not-yet-ready → FALSE.
  -- v_sample_ok still passes. Add v_sample_bad with NO v3 job.
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'Bad', 'b',
            ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample_bad;
  RETURN NEXT is(
    public.creator_v3_ready(v_creator), false,
    '10: any non-errored sample not v3-ready → FALSE (no partial readiness)'
  );

  -- 11: errored samples are IGNORED. Flip v_sample_bad to 'errored' -> TRUE
  -- (only v_sample_ok remains in the 'ready' gate, and it's ready).
  UPDATE public.sample_content SET fetch_status = 'errored' WHERE id = v_sample_bad;
  RETURN NEXT is(
    public.creator_v3_ready(v_creator), true,
    '11: errored samples are ignored (only "ready" gates -- round-5 C1)'
  );

  -- 12: pending sample doesn't gate either. Flip v_sample_bad to 'pending'
  -- (in-flight upload). v_sample_ok stays ready + v3-wired -> TRUE.
  UPDATE public.sample_content SET fetch_status = 'pending' WHERE id = v_sample_bad;
  RETURN NEXT is(
    public.creator_v3_ready(v_creator), true,
    '12: in-flight pending sample is ignored (only "ready" gates -- round-5 C1)'
  );

  -- 13: NULL p_creator_id -> FALSE (caller-friendly NULL guard, round-5 M2).
  RETURN NEXT is(
    public.creator_v3_ready(NULL::uuid), false,
    '13: NULL p_creator_id returns FALSE (no NULL leak to clients)'
  );

  -- Reset to a clean single-ready-sample state for the count-invariant tests:
  -- drop the pending sibling so only v_sample_ok (1 fully-wired section) gates.
  DELETE FROM public.sample_content WHERE id = v_sample_bad;

  -- 14: count invariant satisfied — expected=1, skipped=0, 1 section → TRUE.
  UPDATE public.sample_content
     SET v3_expected_section_count = 1, v3_skipped_empty_count = 0
   WHERE id = v_sample_ok;
  RETURN NEXT is(
    public.creator_v3_ready(v_creator), true,
    '14: section-count invariant satisfied (1 = 1-0) → TRUE (round-1 M4)'
  );

  -- 15: count mismatch — expected=2 but only 1 section row → FALSE.
  UPDATE public.sample_content
     SET v3_expected_section_count = 2, v3_skipped_empty_count = 0
   WHERE id = v_sample_ok;
  RETURN NEXT is(
    public.creator_v3_ready(v_creator), false,
    '15: section-count mismatch (1 <> 2-0) → FALSE — catches a dropped section (round-1 M4)'
  );

  -- 16: skipped-empty math — expected=2, skipped=1, 1 section → TRUE.
  UPDATE public.sample_content
     SET v3_expected_section_count = 2, v3_skipped_empty_count = 1
   WHERE id = v_sample_ok;
  RETURN NEXT is(
    public.creator_v3_ready(v_creator), true,
    '16: skipped-empty subtracted (1 = 2-1) → TRUE (round-1 M4)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
