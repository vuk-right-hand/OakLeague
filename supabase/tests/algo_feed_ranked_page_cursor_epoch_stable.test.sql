-- D5 audit P2-D: cursor_epoch is page-stable, not row-incremental.
-- The SQL function returns the same v_cursor_epoch value on every row
-- of a page (it seeds explore-slot positioning, not pagination). The
-- API picks items[0].cursor_epoch as "next-page cursor"; this test
-- asserts that's safe — items[N-1] would yield the same value.
--
-- Also asserts that pagination via p_exclude_hook_ids advances rather
-- than loops: page 2 (with page 1's hooks excluded) returns disjoint
-- hooks. Without this, a silent regression to "infinite first page"
-- would not surface in the type system.
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user        uuid := tests.create_auth_user('algo-cursor-stable@test');
  v_creator_u   uuid := tests.create_auth_user('algo-cursor-stable-c@test');
  v_creator_id  uuid;
  v_video_a     uuid;
  v_video_b     uuid;
  v_distinct_cursors int;
  v_page1_ids   uuid[];
  v_page2_ids   uuid[];
  v_overlap_count int;
  i int;
BEGIN
  UPDATE public.profiles SET handle = 'cstable' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'CS', 'cstable', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  -- videos.lesson_count is CHECK BETWEEN 0 AND 5. Split 6 hooks across
  -- two videos so we can populate two disjoint pages of 3.
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'A', 3, 'ready')
    RETURNING id INTO v_video_a;
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'B', 3, 'ready')
    RETURNING id INTO v_video_b;
  FOR i IN 1..3 LOOP
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at)
      VALUES (v_video_a, i, 'mux_cstable_a_' || i, 30,
              ARRAY['cold_outreach'], 'ready',
              now() - (i || ' seconds')::interval);
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at)
      VALUES (v_video_b, i, 'mux_cstable_b_' || i, 30,
              ARRAY['cold_outreach'], 'ready',
              now() - ((i + 3) || ' seconds')::interval);
  END LOOP;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_a;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_b;

  PERFORM tests.set_authenticated(v_user);

  -- Page 1: top 3 hooks. Capture both their cursor_epoch column count
  -- (must be 1 across all 3 rows) and their ids (for page 2 exclusion).
  WITH p1 AS (
    SELECT * FROM public.feed_ranked_page(3, NULL, '{}'::uuid[])
  )
  SELECT COUNT(DISTINCT cursor_epoch)::int,
         ARRAY_AGG(hook_id)
    INTO v_distinct_cursors, v_page1_ids
    FROM p1;

  RETURN NEXT ok(
    v_distinct_cursors = 1,
    format('1: cursor_epoch is identical across all rows of a page (got %s distinct values)', v_distinct_cursors)
  );
  RETURN NEXT ok(
    cardinality(v_page1_ids) = 3,
    format('2: page 1 returned 3 hooks (got %s)', cardinality(v_page1_ids))
  );

  -- Page 2: same cursor, but exclude page 1's hook_ids. Should return
  -- a disjoint set (the remaining 3 hooks).
  WITH p2 AS (
    SELECT hook_id FROM public.feed_ranked_page(3, NULL, v_page1_ids)
  )
  SELECT ARRAY_AGG(hook_id) INTO v_page2_ids FROM p2;

  SELECT COUNT(*)::int INTO v_overlap_count
    FROM unnest(v_page1_ids) p1(id)
   WHERE p1.id = ANY(v_page2_ids);

  RETURN NEXT ok(
    v_overlap_count = 0,
    format('3: page 2 (with page 1 excluded) is disjoint from page 1 (got %s overlapping hooks)', v_overlap_count)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
