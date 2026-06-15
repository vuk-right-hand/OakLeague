-- At-scale regression guard for the 0613-03 retrieval-pool blend + diversity
-- re-rank. 500 hooks across 5 creators (100 videos x 5) is well past the
-- 120/50/30 pool caps, so this exercises: the three pool arms, the
-- DISTINCT ON dedup over the UNION ALL, dual compute_hook_score scoring on the
-- capped candidate set, the multi-creator diversity interleave, and the
-- explore-slot machinery — all at once. Deterministic structural assertions
-- only (no timing — latency lives in scripts/feed_ranked_page_bench.sql), so
-- this is CI-safe. Catches any future change that makes the at-scale path
-- error, drop the page below a full 10, duplicate a hook, or skip a slot.
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_caller uuid := tests.create_auth_user('algo-scale@test');
  v_creators uuid[] := '{}';
  v_cu uuid;
  v_creator uuid;
  v_video uuid;
  v_i int;
  v_h int;
  v_n int := 0;
  v_ci int := 0;
  v_count int;
  v_distinct int;
  v_slots int[];
  v_page1 uuid[];
  v_page2_count int;
BEGIN
  FOR v_i IN 1..5 LOOP
    v_cu := tests.create_auth_user('algo-scale-c' || v_i || '@test');
    UPDATE public.profiles SET handle = 'scalec' || v_i WHERE id = v_cu;
    INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
      VALUES (v_cu, 'SC' || v_i, 'scalec' || v_i, 'ready', now())
      RETURNING id INTO v_creator;
    INSERT INTO public.creator_topics (creator_id, slug, title)
      VALUES (v_creator, 'cold_outreach', 'C');
    v_creators := v_creators || v_creator;
  END LOOP;

  -- 100 videos x 5 hooks = 500 hooks, round-robin across the 5 creators.
  FOR v_i IN 1..100 LOOP
    v_ci := (v_ci % 5) + 1;
    INSERT INTO public.videos (creator_id, title, lesson_count, status)
      VALUES (v_creators[v_ci], 'V' || v_i, 5, 'ready')
      RETURNING id INTO v_video;
    FOR v_h IN 1..5 LOOP
      v_n := v_n + 1;
      INSERT INTO public.hooks
        (video_id, lesson_number, mux_playback_id, duration_seconds,
         topic_tags, mux_status, published_at, created_at)
        VALUES (v_video, v_h, 'mux_scale_' || v_n, 30, ARRAY['cold_outreach'],
                'ready', now() - (v_n || ' seconds')::interval,
                now() - (v_n || ' seconds')::interval);
    END LOOP;
    UPDATE public.videos SET published_at = now() WHERE id = v_video;
  END LOOP;

  PERFORM tests.set_authenticated(v_caller);

  -- All RPC calls happen while authenticated; reset_role only after.
  SELECT count(*)::int, count(DISTINCT p.hook_id)::int,
         array_agg(p.served_rank ORDER BY p.served_rank),
         array_agg(p.hook_id)
    INTO v_count, v_distinct, v_slots, v_page1
    FROM public.feed_ranked_page(10, NULL, '{}'::uuid[]) p;

  SELECT count(*)::int
    INTO v_page2_count
    FROM public.feed_ranked_page(10, NULL, v_page1) p2;

  PERFORM tests.reset_role();

  RETURN NEXT is(v_count, 10, '1: 500-hook catalog still serves a full page of 10');
  RETURN NEXT is(v_distinct, 10, '2: all 10 served hooks are distinct (pool dedup holds at scale)');
  RETURN NEXT is(v_slots, ARRAY[0,1,2,3,4,5,6,7,8,9],
    '3: slots 0..9 all filled exactly once (no gap from diversity/explore interplay)');
  RETURN NEXT is(v_page2_count, 10,
    '4: page 2 (excluding page 1) also serves a full 10 — pool reaches past the first slate');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
