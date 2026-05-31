-- v3_section_generations.test.sql — atomic-swap re-ingest (Step-9 audit C2/C3).
-- Migrations 20260531000002 (columns + UNIQUE swaps) + 20260531000003 (gen-aware
-- RPCs). Pins the generation machinery: a re-ingest builds a NEW generation
-- alongside the live one; the route/flat/gate/fetch see ONLY the active gen;
-- finalize swaps atomically; GC keeps active + prior.
--
-- Cases:
--  1  C-1: two generations of CHUNKS coexist with NO 23505 (the constraint
--          REV 2 missed — chunk UNIQUE keyed on section_index/chunk_index).
--  2  C-1: two generations of UNITS coexist (per-gen unit_index).
--  3  R1: route_sections_v3 returns ONLY active-gen sections (gen1 live, gen2
--         built alongside → route sees gen1 only).
--  4  R1 EXPLAIN: route still uses the HNSW Index Scan with two gens present
--         (M-3 — correlated scalar gen filter must not defeat the partial index).
--  5  R2: _creator_active_section_ids_v3 excludes the inactive gen AND returns
--         the SAME section set the route considers (R1==R2).
--  6  R3: creator_v3_ready stays TRUE while gen2 (NULL embeddings) is mid-build.
--  7  R4: clause (d) count is gen-scoped (gen1 count = expected, ignores gen2).
--  8  finalize: swaps active_section_generation 1→2 + bumps corpus_version.
--  9  R1-after-swap: route now returns ONLY gen2 sections.
-- 10  R5: _fetch_active_parents_v3 returns active-gen parent, DROPS stale-gen id.
-- 11  GC: admin_gc_stale_section_generations at active=2 keeps active+prior →
--         deletes NOTHING (gen1 survives).
-- 12  GC: after a 2nd swap (active=3), GC deletes gen1, keeps {2,3}.
-- 13  GC guard: non-admin caller blocked.

BEGIN;
SELECT plan(13);

CREATE FUNCTION pg_temp.uvec(p int) RETURNS halfvec(768)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE a real[]; i int := ((p - 1) % 768) + 1;
BEGIN a := array_fill(0::real, ARRAY[768]); a[i] := 1.0::real; RETURN a::halfvec(768); END;$$;

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin   uuid := tests.create_auth_user('gen-admin@test');
  v_user    uuid := tests.create_auth_user('gen-user@test');
  v_app     uuid;
  v_creator uuid;
  v_sample  uuid;
  v_sec_g1  uuid;
  v_sec_g2  uuid;
  v_unit_g1 uuid;
  v_unit_g2 uuid;
  v_job     uuid;
  v_routed  int;
  v_routed2 int;
  v_r1      uuid[];
  v_r2      uuid[];
  v_ready   boolean;
  v_cnt     int;
  v_active  int;
  v_cv0     int;
  v_cv1     int;
  v_fetch   int;
  v_gc      jsonb;
  v_g1      int;
  v_g2      int;
  v_g3      int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'gen-admin@test', 'superadmin');

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'Gen', 'gen', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode, retrieval_version)
    VALUES (gen_random_uuid(), v_user, v_app, 'Gen', 'gen', 'ready', 'vector', 3)
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);
  -- Sample starts active_section_generation=1 (default). gen1 = the live corpus.
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status,
                                     v3_expected_section_count, v3_skipped_empty_count)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'S', 'body', ARRAY['topic-a'], 'ready', 1, 0)
    RETURNING id INTO v_sample;

  -- ── GEN 1 (active): one fully-built section + unit + chunk ──────────────
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, section_generation, title, summary,
     char_start, char_end, topic_tags, summary_embedding, centroid_embedding)
  VALUES (v_sample, v_creator, 0, 1, 'G1 Sec', 'gen one summary', 0, 100,
          ARRAY['topic-a'], pg_temp.uvec(1), pg_temp.uvec(2))
  RETURNING id INTO v_sec_g1;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, section_generation, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 0, 1, 'G1 Unit', 'gen one unit text', 10, ARRAY['topic-a'], v_sec_g1)
  RETURNING id INTO v_unit_g1;
  PERFORM public._insert_chunk_v3_unsafe(
    v_unit_g1, v_sec_g1, 0, 'g1 chunk', NULL, 10, ARRAY['topic-a'], pg_temp.uvec(1));

  -- ── GEN 2 (mid-build, inactive): same section_index 0, NULL embeddings ──
  -- This is what a re-ingest writes alongside the live gen1.
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, section_generation, title, summary,
     char_start, char_end, topic_tags, summary_embedding, centroid_embedding)
  VALUES (v_sample, v_creator, 0, 2, 'G2 Sec', 'gen two summary', 0, 100,
          ARRAY['topic-a'], pg_temp.uvec(1), NULL)  -- centroid NULL = mid-build
  RETURNING id INTO v_sec_g2;
  -- 1: C-1 — gen2 chunk with SAME section_index 0 / chunk_index 0 as gen1's
  -- coexists (would 23505 under the old 4-col unique). Insert a gen2 unit+chunk.
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, section_generation, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 0, 2, 'G2 Unit', 'gen two unit text', 10, ARRAY['topic-a'], v_sec_g2)
  RETURNING id INTO v_unit_g2;
  BEGIN
    PERFORM public._insert_chunk_v3_unsafe(
      v_unit_g2, v_sec_g2, 0, 'g2 chunk', NULL, 10, ARRAY['topic-a'], pg_temp.uvec(1));
    RETURN NEXT pass('1: C-1 two-generation chunks coexist (no 23505 on dup section_index/chunk_index)');
  EXCEPTION WHEN unique_violation THEN
    RETURN NEXT fail('1: C-1 chunk gen collision — 23505 (the constraint REV 2 missed)');
  END;

  -- 2: C-1 units — both gens' unit_index 0 coexist (per-gen unique).
  SELECT count(*) INTO v_cnt FROM public.sample_content_narrative_units
   WHERE sample_id = v_sample AND unit_index = 0;
  RETURN NEXT is(v_cnt, 2, '2: C-1 two generations of units share unit_index 0 (per-gen UNIQUE)');

  -- 3: R1 — route returns ONLY active-gen (gen1) sections. gen2 has NULL
  -- centroid so it's doubly-excluded, but assert the gen filter directly by
  -- giving gen2 a centroid first would defeat the point; instead check the
  -- returned section_id is the gen1 one.
  SELECT count(*) INTO v_routed FROM public._creator_route_sections_v3(
    v_creator, pg_temp.uvec(1), ARRAY['topic-a'], 6, 0.0, 0.05) r
   WHERE r.section_id = v_sec_g1;
  SELECT count(*) INTO v_routed2 FROM public._creator_route_sections_v3(
    v_creator, pg_temp.uvec(1), ARRAY['topic-a'], 6, 0.0, 0.05) r
   WHERE r.section_id = v_sec_g2;
  RETURN NEXT ok(v_routed = 1 AND v_routed2 = 0,
    format('3: R1 route returns active gen1 (g1=%s g2=%s, want 1/0)', v_routed, v_routed2));

  -- 4: M-3 contract — the gen filter must NOT defeat the partial HNSW index.
  -- An EXPLAIN-assert at fixture size is planner-unstable (≤200 rows → seq scan
  -- beats HNSW even with enable_seqscan=off; verified — the existing route test
  -- uses this same reasoning). Instead assert the CONTRACT that lets the planner
  -- pick the partial index at prod scale: (a) the partial HNSW index exists with
  -- its IS NOT NULL predicate, (b) the RPC source keeps BOTH IS NOT NULL
  -- predicates, AND (c) the gen filter is a CORRELATED SCALAR equality
  -- (`section_generation = (SELECT ... active_section_generation ...)`), NOT an
  -- EXISTS/IN semi-join (which WOULD defeat the index — M-3). A refactor that
  -- swaps the scalar for a semi-join, or drops a NULL predicate, fails loud.
  DECLARE
    v_idx_ok  boolean;
    v_src     text;
    v_scalar  boolean;
    v_semi    boolean;
  BEGIN
    -- Give gen2 a centroid so it's a real HNSW competitor for the rest of the
    -- run; correctness (gen filter excludes it) is asserted in case 5.
    UPDATE public.sample_content_sections SET centroid_embedding = pg_temp.uvec(2)
     WHERE id = v_sec_g2;
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'sample_content_sections'
         AND indexname = 'sample_content_sections_summary_embedding_hnsw_idx'
         AND indexdef ILIKE '%where (summary_embedding is not null)%'
    ) INTO v_idx_ok;
    SELECT pg_get_functiondef(
      ('public._creator_route_sections_v3(uuid,halfvec,text[],int,float,float)')::regprocedure
    ) INTO v_src;
    v_scalar :=
      v_src ILIKE '%summary_embedding IS NOT NULL%'
      AND v_src ILIKE '%centroid_embedding IS NOT NULL%'
      -- correlated scalar gen filter present:
      AND v_src ILIKE '%section_generation = (%active_section_generation%';
    -- semi-join forms that WOULD defeat the index must be ABSENT:
    v_semi := v_src ILIKE '%section_generation%IN (SELECT%'
           OR v_src ~* 'EXISTS[[:space:]]*\([^)]*active_section_generation';
    RETURN NEXT ok(v_idx_ok AND v_scalar AND NOT v_semi,
      format('4: M-3 partial-HNSW contract (idx=%s scalar_gen_filter=%s no_semijoin=%s)',
             v_idx_ok, v_scalar, NOT v_semi));
  END;

  -- gen2 has a centroid now; R1 must STILL exclude it via the gen FILTER (not
  -- the NULL gate). Asserted in case 5's R1==R2=={gen1}.
  SELECT count(*) INTO v_routed2 FROM public._creator_route_sections_v3(
    v_creator, pg_temp.uvec(1), ARRAY['topic-a'], 6, 0.0, 0.05) r
   WHERE r.section_id = v_sec_g2;

  -- 5: R2 — _creator_active_section_ids_v3 returns same set as R1 (gen1 only).
  SELECT array_agg(r.section_id ORDER BY r.section_id) INTO v_r1
    FROM public._creator_route_sections_v3(v_creator, pg_temp.uvec(1), ARRAY['topic-a'], 6, 0.0, 0.05) r;
  SELECT array_agg(a.section_id ORDER BY a.section_id) INTO v_r2
    FROM public._creator_active_section_ids_v3(v_creator, 50) a;
  RETURN NEXT ok(v_r1 = v_r2 AND v_r1 = ARRAY[v_sec_g1] AND v_routed2 = 0,
    format('5: R2 active-ids == R1 route set == {gen1} (r1=%s r2=%s g2excluded=%s)',
           v_r1::text, v_r2::text, (v_routed2 = 0)));

  -- 6: R3 — creator_v3_ready. Reset gen2 centroid to NULL to simulate true
  -- mid-build; gate must stay TRUE (gen1 active + complete; gen2 invisible).
  UPDATE public.sample_content_sections SET centroid_embedding = NULL WHERE id = v_sec_g2;
  DELETE FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample;
  INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version, status, enqueue_version)
    VALUES (v_sample, 3, 'done', 1);
  SELECT public.creator_v3_ready(v_creator) INTO v_ready;
  RETURN NEXT ok(v_ready, '6: R3 creator_v3_ready stays TRUE mid-re-ingest (gen2 invisible)');

  -- 7: R4 — clause (d) count is gen-scoped: active gen1 has 1 section =
  -- expected(1)-skipped(0). The gen2 row must NOT inflate the count to 2.
  SELECT count(*) INTO v_cnt FROM public.sample_content_sections
   WHERE sample_id = v_sample AND section_generation = 1;
  RETURN NEXT ok(v_ready AND v_cnt = 1,
    format('7: R4 count gen-scoped — active gen1 sections=%s = expected (ready=%s)', v_cnt, v_ready));

  -- 8: finalize swap. Build gen2 fully (give it a chunk already done above;
  -- set centroid back so it is complete), then mark_done with target_gen=2.
  UPDATE public.sample_content_sections SET centroid_embedding = pg_temp.uvec(2) WHERE id = v_sec_g2;
  UPDATE public.sample_content SET v3_expected_section_count = 1, v3_skipped_empty_count = 0 WHERE id = v_sample;
  DELETE FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample;
  INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version, status, enqueue_version, claimed_by, claimed_at)
    VALUES (v_sample, 3, 'processing', 1, 'tw', now()) RETURNING id INTO v_job;
  SELECT current_corpus_version INTO v_cv0 FROM public.creators WHERE id = v_creator;
  PERFORM public.corpus_reprocess_mark_done_v3(v_job, 1, 2);
  SELECT active_section_generation INTO v_active FROM public.sample_content WHERE id = v_sample;
  SELECT current_corpus_version INTO v_cv1 FROM public.creators WHERE id = v_creator;
  RETURN NEXT ok(v_active = 2 AND v_cv1 > v_cv0,
    format('8: finalize swap active 1->2 (active=%s) + corpus_version bumped (%s->%s)', v_active, v_cv0, v_cv1));

  -- 9: R1-after-swap — route now returns ONLY gen2.
  SELECT count(*) INTO v_routed FROM public._creator_route_sections_v3(
    v_creator, pg_temp.uvec(1), ARRAY['topic-a'], 6, 0.0, 0.05) r WHERE r.section_id = v_sec_g2;
  SELECT count(*) INTO v_routed2 FROM public._creator_route_sections_v3(
    v_creator, pg_temp.uvec(1), ARRAY['topic-a'], 6, 0.0, 0.05) r WHERE r.section_id = v_sec_g1;
  RETURN NEXT ok(v_routed = 1 AND v_routed2 = 0,
    format('9: R1 post-swap returns active gen2 only (g2=%s g1=%s, want 1/0)', v_routed, v_routed2));

  -- 10: R5 — _fetch_active_parents_v3 returns the active-gen (gen2) parent,
  -- DROPS the stale-gen (gen1) parent id.
  SELECT count(*) INTO v_fetch FROM public._fetch_active_parents_v3(v_creator, ARRAY[v_unit_g2])
   WHERE id = v_unit_g2;
  SELECT count(*) INTO v_cnt FROM public._fetch_active_parents_v3(v_creator, ARRAY[v_unit_g1]);
  RETURN NEXT ok(v_fetch = 1 AND v_cnt = 0,
    format('10: R5 active-parent fetched (g2=%s) stale-gen dropped (g1=%s, want 1/0)', v_fetch, v_cnt));

  -- 11: GC — at active=2, keep active(2) + prior(1) → deletes NOTHING. Then
  -- (case 12) build+swap a gen3, making active=3, so gen1 (< active-1=2) is GC'd.
  PERFORM tests.set_authenticated(v_admin);
  SELECT public.admin_gc_stale_section_generations(v_creator) INTO v_gc;
  PERFORM tests.reset_role();
  SELECT count(*) INTO v_g1 FROM public.sample_content_sections WHERE sample_id = v_sample AND section_generation = 1;
  RETURN NEXT ok(
    v_g1 = 1 AND (v_gc->>'stale_sections_deleted') = '0',
    format('11: GC at active=2 keeps active+prior — gen1 survives, deletes nothing (g1=%s gc=%s, want 1/0)',
           v_g1, v_gc->>'stale_sections_deleted'));
  -- now create gen3 + swap to it
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, section_generation, title, summary, char_start, char_end,
     topic_tags, summary_embedding, centroid_embedding)
  VALUES (v_sample, v_creator, 0, 3, 'G3', 'g3', 0, 100, ARRAY['topic-a'], pg_temp.uvec(1), pg_temp.uvec(2))
  RETURNING id INTO v_sec_g2;  -- reuse var
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, section_generation, title, text, token_count, topic_tags, section_id)
  VALUES (v_sample, v_creator, 0, 3, 'G3U', 'u', 10, ARRAY['topic-a'], v_sec_g2) RETURNING id INTO v_unit_g2;
  PERFORM public._insert_chunk_v3_unsafe(v_unit_g2, v_sec_g2, 0, 'g3c', NULL, 10, ARRAY['topic-a'], pg_temp.uvec(1));
  DELETE FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample;
  INSERT INTO public.corpus_reprocess_jobs (sample_id, target_version, status, enqueue_version, claimed_by, claimed_at)
    VALUES (v_sample, 3, 'processing', 1, 'tw', now()) RETURNING id INTO v_job;
  PERFORM public.corpus_reprocess_mark_done_v3(v_job, 1, 3);
  PERFORM tests.set_authenticated(v_admin);
  SELECT public.admin_gc_stale_section_generations(v_creator) INTO v_gc;
  PERFORM tests.reset_role();
  SELECT count(*) INTO v_g1 FROM public.sample_content_sections WHERE sample_id = v_sample AND section_generation = 1;
  SELECT count(*) INTO v_g2 FROM public.sample_content_sections WHERE sample_id = v_sample AND section_generation = 2;
  SELECT count(*) INTO v_g3 FROM public.sample_content_sections WHERE sample_id = v_sample AND section_generation = 3;
  RETURN NEXT ok(v_g1 = 0 AND v_g2 = 1 AND v_g3 = 1,
    format('12: GC at active=3 deletes gen1, keeps {2,3} (g1=%s g2=%s g3=%s, want 0/1/1; gc=%s)',
           v_g1, v_g2, v_g3, v_gc->>'stale_sections_deleted'));

  -- 13: GC guard — non-admin blocked.
  PERFORM tests.set_authenticated(v_user);
  RETURN NEXT throws_ok(
    format('SELECT public.admin_gc_stale_section_generations(%L::uuid)', v_creator),
    '42501',
    NULL,
    '13: GC guard — non-admin caller blocked');
  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
