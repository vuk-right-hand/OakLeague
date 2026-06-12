-- 0613-03 fix 1 inertness property (audit S-R2-5 strategy): while the
-- catalog <= 120, the pool union equals the full filtered base -- nothing is
-- unreachable. 60 hooks, page of 50, then page 2 with the 50 served ids
-- excluded must return exactly the remaining 10. Single creator + non-sparse
-- topic (no explore, diversity no-op) keeps paging deterministic.
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-rpm@test');
  v_creator_u uuid := tests.create_auth_user('algo-rpm-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_i int;
  v_j int;
  v_n int := 0;
  v_page1 uuid[];
  v_page2 uuid[];
BEGIN
  UPDATE public.profiles SET handle = 'rpmc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'RM', 'rpmc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');

  FOR v_i IN 1..12 LOOP
    INSERT INTO public.videos (creator_id, title, lesson_count, status)
      VALUES (v_creator_id, 'V' || v_i, 5, 'ready')
      RETURNING id INTO v_video_id;
    FOR v_j IN 1..5 LOOP
      v_n := v_n + 1;
      INSERT INTO public.hooks
        (video_id, lesson_number, mux_playback_id, duration_seconds,
         topic_tags, mux_status, published_at, created_at)
        VALUES (v_video_id, v_j, 'mux_rpm_' || v_n, 30, ARRAY['cold_outreach'],
                'ready', now() - (v_n || ' minutes')::interval,
                now() - (v_n || ' minutes')::interval);
    END LOOP;
    UPDATE public.videos SET published_at = now() WHERE id = v_video_id;
  END LOOP;

  -- Non-sparse topic => S_explore = 0 => pure exploit pages.
  INSERT INTO public.user_topic_affinity (user_id, topic_slug, impressions, affinity_score)
    VALUES (v_user, 'cold_outreach', 5, 0);

  PERFORM tests.set_authenticated(v_user);

  SELECT COALESCE(array_agg(p.hook_id), '{}'::uuid[]) INTO v_page1
    FROM public.feed_ranked_page(50, NULL, '{}'::uuid[]) p;

  SELECT COALESCE(array_agg(p.hook_id), '{}'::uuid[]) INTO v_page2
    FROM public.feed_ranked_page(50, NULL, v_page1) p;

  PERFORM tests.reset_role();

  RETURN NEXT is(cardinality(v_page1), 50, '1: page 1 serves a full 50');
  RETURN NEXT is(cardinality(v_page2), 10, '2: page 2 serves exactly the 10 remaining hooks');
  RETURN NEXT is(
    (SELECT count(DISTINCT x)::int FROM unnest(v_page1 || v_page2) AS x), 60,
    '3: pages 1+2 cover all 60 hooks -- pool membership is complete under 120');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
