-- 0613-03 fix 1: quality-blended retrieval pool. 230 hooks (46 videos x 5,
-- one registered topic slug -- respects the lesson cap + verify_hook_topic_slugs,
-- audit M-R2-6). One hook is 100 days old with top global_quality; under the
-- old recency-only LIMIT 200 pool it ranked #230 by recency and was
-- unreachable. The quality arm must retrieve it; with a neutral user its
-- blended score beats the fresh zero-quality hooks, so it appears on page 1
-- (exploit or explore slot -- either proves retrieval).
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-rpq@test');
  v_creator_u uuid := tests.create_auth_user('algo-rpq-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_old_hook uuid;
  v_i int;
  v_j int;
  v_n int := 0;
  v_total int;
  v_found boolean;
BEGIN
  UPDATE public.profiles SET handle = 'rpqc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'RP', 'rpqc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');

  FOR v_i IN 1..46 LOOP
    INSERT INTO public.videos (creator_id, title, lesson_count, status)
      VALUES (v_creator_id, 'V' || v_i, 5, 'ready')
      RETURNING id INTO v_video_id;
    FOR v_j IN 1..5 LOOP
      v_n := v_n + 1;
      IF v_n = 1 THEN
        -- The old high-quality hook: 100 days old.
        INSERT INTO public.hooks
          (video_id, lesson_number, mux_playback_id, duration_seconds,
           topic_tags, mux_status, published_at, created_at)
          VALUES (v_video_id, v_j, 'mux_rpq_old', 30, ARRAY['cold_outreach'],
                  'ready', now() - interval '100 days', now() - interval '100 days')
          RETURNING id INTO v_old_hook;
      ELSE
        -- Fresh filler, slightly staggered for deterministic recency order.
        INSERT INTO public.hooks
          (video_id, lesson_number, mux_playback_id, duration_seconds,
           topic_tags, mux_status, published_at, created_at)
          VALUES (v_video_id, v_j, 'mux_rpq_' || v_n, 30, ARRAY['cold_outreach'],
                  'ready', now() - (v_n || ' seconds')::interval,
                  now() - (v_n || ' seconds')::interval);
      END IF;
    END LOOP;
    -- Publish AFTER hooks exist (publish guard requires ready hooks).
    UPDATE public.videos SET published_at = now() WHERE id = v_video_id;
  END LOOP;

  SELECT count(*)::int INTO v_total FROM public.hooks h
    JOIN public.videos v ON v.id = h.video_id WHERE v.creator_id = v_creator_id;
  RETURN NEXT is(v_total, 230, '1: 230 hooks seeded (46 videos x 5)');

  -- Top global quality on the old hook only.
  INSERT INTO public.hook_global_stats
    (hook_id, impressions, full_opens, mic_taps,
     impressions_decayed, full_opens_decayed, mic_taps_decayed, global_quality)
    VALUES (v_old_hook, 100, 90, 20, 100, 90, 20, 0.9);

  PERFORM tests.set_authenticated(v_user);
  SELECT EXISTS (
    SELECT 1 FROM public.feed_ranked_page(10, NULL, '{}'::uuid[]) p
     WHERE p.hook_id = v_old_hook
  ) INTO v_found;
  PERFORM tests.reset_role();

  RETURN NEXT ok(v_found,
    '2: 100-day-old top-quality hook is served on page 1 (recency-only pool would have dropped it at rank 230)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
