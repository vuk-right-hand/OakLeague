-- RAG v3 step 5 / migration 5 — _creator_route_sections_v3 RPC.
--
--  1. Service-role + authenticated grant; public/anon denied.
--  2. Returns empty for a creator with no sections.
--  3. Happy path: with one section, returns it.
--  4. MAX-of-two-signals: a section whose centroid is closer than its
--     summary still surfaces.
--  5. min_sim floor: a section far from the query is filtered out.
--  6. Top-S clamp: with 5 candidate sections + p_top_s=2 → exactly 2 returned.
--  7. Topic-tag boost is SOFT (re-ranks but doesn't filter): a topic-matched
--     section with lower cosine can outrank a topic-unmatched section with
--     slightly higher cosine, when the boost flips the order.
--  8. NULL embeddings (worker-in-flight) are EXCLUDED — audit M3 partial-index contract.
--  9. EXPLAIN-assert — round-5 audit C1: the partial-HNSW index on
--     summary_embedding is REACHABLE through the RPC's textual IS NOT NULL
--     predicate. Pins mig 30's load-bearing planner-pushdown contract
--     against any future refactor that drops the predicate.
-- 10. round-5 audit S8: a section with summary_embedding populated but
--     centroid_embedding still NULL (worker mid-flight) MUST be excluded,
--     per mig 30's "caller invariant — both NN gates same population."
-- 11. round-5 audit S10: passing ARRAY[]::text[] for p_topic_tags is
--     equivalent to NULL — both disable the soft boost (mig 30's
--     CASE WHEN p_topic_tags IS NULL OR cardinality()=0 THEN 0 …).

BEGIN;
SELECT plan(11);

-- Helpers — positions are modulo'd into [1, 768] so callers can use any int.
-- Out-of-range assignment in PL/pgSQL extends the array with NULL gaps,
-- which makes the halfvec(768) cast fail with "array must not contain nulls".
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

CREATE FUNCTION pg_temp.two_hot(p_a int, p_b int) RETURNS halfvec(768)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_arr real[];
        v_ia int := ((p_a - 1) % 768) + 1;
        v_ib int := ((p_b - 1) % 768) + 1;
BEGIN
  v_arr := array_fill(0::real, ARRAY[768]);
  v_arr[v_ia] := 0.70710677::real;
  v_arr[v_ib] := 0.70710677::real;
  RETURN v_arr::halfvec(768);
END;
$$;

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user      uuid := tests.create_auth_user('crs3-route@test');
  v_app       uuid;
  v_creator   uuid;
  v_sample    uuid;
  v_sec_a     uuid;
  v_sec_b     uuid;
  v_count     int;
  v_first_id  uuid;
  v_rows_text text;
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'CRS3', 'crs3', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'CRS3', 'crs3', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0),
           (v_creator, 'topic-b', 'Topic B', 1);
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'CRS3 Sample',
            'body', ARRAY['topic-a','topic-b'], 'ready')
    RETURNING id INTO v_sample;

  -- 1: privileges.
  RETURN NEXT ok(
    NOT has_function_privilege('anon'::regrole,
        'public._creator_route_sections_v3(uuid, halfvec, text[], int, float, float)', 'EXECUTE')
    AND has_function_privilege('authenticated'::regrole,
        'public._creator_route_sections_v3(uuid, halfvec, text[], int, float, float)', 'EXECUTE')
    AND has_function_privilege('service_role'::regrole,
        'public._creator_route_sections_v3(uuid, halfvec, text[], int, float, float)', 'EXECUTE'),
    '1: service_role + authenticated EXECUTE; anon denied'
  );

  -- 2: zero sections → zero rows.
  SELECT count(*) INTO v_count
    FROM public._creator_route_sections_v3(v_creator, pg_temp.unit_vec(1));
  RETURN NEXT is(v_count, 0, '2: no sections → empty result');

  -- 3: happy path — one section with matching summary embedding.
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    (v_sample, v_creator, 0, 'Sec A', 'Sec A summary', 0, 100,
     ARRAY['topic-a'], pg_temp.unit_vec(1), pg_temp.unit_vec(2))
  RETURNING id INTO v_sec_a;
  SELECT section_id INTO v_first_id
    FROM public._creator_route_sections_v3(v_creator, pg_temp.unit_vec(1), NULL, 4, 0.0)
   ORDER BY score DESC LIMIT 1;
  RETURN NEXT is(v_first_id, v_sec_a, '3: happy path — section surfaces on summary match');

  -- 4: MAX-of-two — section whose centroid is closer than its summary.
  -- Query @ pos 100. Section B's centroid is at pos 100 (perfect), summary at pos 999 (far).
  -- Section A's summary is at pos 1 (far from query @ pos 100), centroid at pos 2.
  -- Section B should rank #1 because centroid_sim=1.0 > all of A's signals.
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    (v_sample, v_creator, 1, 'Sec B', 'Sec B summary', 100, 200,
     ARRAY['topic-b'], pg_temp.unit_vec(999), pg_temp.unit_vec(100))
  RETURNING id INTO v_sec_b;
  SELECT section_id INTO v_first_id
    FROM public._creator_route_sections_v3(v_creator, pg_temp.unit_vec(100), NULL, 4, 0.0)
   ORDER BY score DESC LIMIT 1;
  RETURN NEXT is(v_first_id, v_sec_b, '4: MAX-of-two — centroid signal alone surfaces a section');

  -- 5: min_sim floor. Query @ pos 500, no section has either vector at 500
  -- → max cosine = 0.0 → below min_sim=0.3 → zero rows.
  SELECT count(*) INTO v_count
    FROM public._creator_route_sections_v3(v_creator, pg_temp.unit_vec(500), NULL, 4, 0.3);
  RETURN NEXT is(v_count, 0, '5: min_sim floor drops sections below threshold');

  -- 6: top_s clamp. Seed 5 sections that all match → ask for top_s=2 → 2 rows.
  -- Reuse sec A + sec B and add 3 more, all with summary at position 50
  -- (perfect for a query at pos 50).
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    (v_sample, v_creator, 2, 'Sec C', 'C', 200, 300, ARRAY['topic-a'], pg_temp.unit_vec(50), pg_temp.unit_vec(51)),
    (v_sample, v_creator, 3, 'Sec D', 'D', 300, 400, ARRAY['topic-a'], pg_temp.unit_vec(50), pg_temp.unit_vec(52)),
    (v_sample, v_creator, 4, 'Sec E', 'E', 400, 500, ARRAY['topic-a'], pg_temp.unit_vec(50), pg_temp.unit_vec(53));
  SELECT count(*) INTO v_count
    FROM public._creator_route_sections_v3(v_creator, pg_temp.unit_vec(50), NULL, 2, 0.0);
  RETURN NEXT is(v_count, 2, '6: top_s=2 clamp returns exactly 2 rows when more candidates exist');

  -- 7: topic boost re-ranks. Two sections at identical cosine sim (both two_hot
  -- to query) — one has matching topic, one doesn't. Topic-matched should win.
  DELETE FROM public.sample_content_sections WHERE creator_id = v_creator;
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    (v_sample, v_creator, 0, 'Topic-Match', 'tm', 0, 100,
     ARRAY['topic-a'], pg_temp.two_hot(1, 200), pg_temp.two_hot(1, 201)),
    (v_sample, v_creator, 1, 'No-Match', 'nm', 100, 200,
     ARRAY['topic-b'], pg_temp.two_hot(1, 200), pg_temp.two_hot(1, 201));
  SELECT title INTO v_rows_text
    FROM public._creator_route_sections_v3(v_creator, pg_temp.unit_vec(1),
                                           ARRAY['topic-a'], 4, 0.0)
   ORDER BY score DESC LIMIT 1;
  RETURN NEXT is(v_rows_text, 'Topic-Match', '7: topic boost flips ordering between equal-cosine sections');

  -- 8: NULL embeddings excluded. Insert a section with both embeddings NULL.
  DELETE FROM public.sample_content_sections WHERE creator_id = v_creator;
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    (v_sample, v_creator, 0, 'Null-Embed', 'partial worker', 0, 100,
     ARRAY['topic-a'], NULL, NULL),
    (v_sample, v_creator, 1, 'Real', 'real', 100, 200,
     ARRAY['topic-a'], pg_temp.unit_vec(1), pg_temp.unit_vec(2));
  SELECT count(*) INTO v_count
    FROM public._creator_route_sections_v3(v_creator, pg_temp.unit_vec(1), NULL, 4, 0.0);
  RETURN NEXT is(v_count, 1, '8: sections with NULL embeddings excluded (worker-in-flight + audit M3)');

  -- 9: round-5 C1 — partial-HNSW pushdown contract.
  -- An EXPLAIN-assert at fixture size is planner-unstable: with ≤200 rows
  -- the seq-scan + sort cost beats HNSW even with enable_seqscan=off
  -- (pgvector HNSW probes have non-trivial fixed cost). At prod scale
  -- (50 creators × 30+ sections) HNSW dominates — but the test can't
  -- afford to insert thousands of sections per pgTAP run.
  --
  -- TWO-PART CONTRACT ASSERTION (catches the bug class without planner
  -- coupling): (a) the partial HNSW index on summary_embedding EXISTS with
  -- the WHERE summary_embedding IS NOT NULL predicate, and (b) the RPC's
  -- source text contains both `summary_embedding IS NOT NULL` and
  -- `centroid_embedding IS NOT NULL` so the planner CAN match the partial
  -- predicate at prod volume. A future refactor that drops either side
  -- fails this test loud.
  DECLARE
    v_idx_ok    boolean;
    v_rpc_src   text;
    v_rpc_ok    boolean;
  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'sample_content_sections'
         AND indexname = 'sample_content_sections_summary_embedding_hnsw_idx'
         AND indexdef ILIKE '%where (summary_embedding is not null)%'
    ) INTO v_idx_ok;
    SELECT pg_get_functiondef(
      ('public._creator_route_sections_v3(uuid,halfvec,text[],int,float,float)')::regprocedure
    ) INTO v_rpc_src;
    v_rpc_ok :=
      v_rpc_src ILIKE '%summary_embedding IS NOT NULL%'
      AND v_rpc_src ILIKE '%centroid_embedding IS NOT NULL%';
    RETURN NEXT ok(
      v_idx_ok AND v_rpc_ok,
      '9: partial-HNSW contract — index has WHERE IS NOT NULL AND RPC has textual IS NOT NULL'
    );
  END;

  -- 10: S8 — summary-set + centroid-NULL is excluded (worker mid-flight).
  -- Pins mig 30's "caller invariant — both NN gates same population."
  DELETE FROM public.sample_content_sections WHERE creator_id = v_creator;
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES
    -- Summary populated, centroid still NULL (mid-flight): MUST be excluded.
    (v_sample, v_creator, 0, 'Half-Embed', 'half', 0, 100,
     ARRAY['topic-a'], pg_temp.unit_vec(1), NULL),
    -- Fully populated: MUST surface.
    (v_sample, v_creator, 1, 'Full', 'full', 100, 200,
     ARRAY['topic-a'], pg_temp.unit_vec(1), pg_temp.unit_vec(2));
  SELECT count(*) INTO v_count
    FROM public._creator_route_sections_v3(v_creator, pg_temp.unit_vec(1), NULL, 4, 0.0);
  RETURN NEXT is(v_count, 1,
    '10: section with summary set + centroid NULL is excluded (both-or-neither invariant)');

  -- 11: S10 — empty p_topic_tags array vs NULL: both disable the boost.
  -- Reuse fixture from 10 (one fully-populated section).
  DECLARE
    v_score_null  float;
    v_score_empty float;
  BEGIN
    SELECT topic_boost INTO v_score_null
      FROM public._creator_route_sections_v3(v_creator, pg_temp.unit_vec(1), NULL,           4, 0.0)
     ORDER BY score DESC LIMIT 1;
    SELECT topic_boost INTO v_score_empty
      FROM public._creator_route_sections_v3(v_creator, pg_temp.unit_vec(1), ARRAY[]::text[], 4, 0.0)
     ORDER BY score DESC LIMIT 1;
    RETURN NEXT is(
      v_score_null::text || '|' || v_score_empty::text,
      '0|0',
      '11: NULL and ARRAY[]::text[] both disable the topic boost (parity)'
    );
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
