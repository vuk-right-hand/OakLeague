-- 0613-03 fix 2 inertness proof: with a single creator, creator_seq equals
-- the rank-by-score, so the penalized key is strictly monotone and the served
-- order is EXACTLY the score order. This is the at-launch state (N=1 creator)
-- -- diversity must be a provable no-op there.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-div1@test');
  v_creator_u uuid := tests.create_auth_user('algo-div1-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_i int;
  v_served uuid[];
  v_by_score uuid[];
BEGIN
  UPDATE public.profiles SET handle = 'div1c' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'D1', 'div1c', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 5, 'ready')
    RETURNING id INTO v_video_id;

  FOR v_i IN 1..5 LOOP
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at, created_at)
      VALUES (v_video_id, v_i, 'mux_div1_' || v_i, 30, ARRAY['cold_outreach'],
              'ready', now() - (v_i || ' minutes')::interval,
              now() - (v_i || ' minutes')::interval);
  END LOOP;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- Non-sparse topic => no explore rows => slots are pure exploit order.
  INSERT INTO public.user_topic_affinity (user_id, topic_slug, impressions, affinity_score)
    VALUES (v_user, 'cold_outreach', 5, 0);

  PERFORM tests.set_authenticated(v_user);
  SELECT array_agg(p.hook_id ORDER BY p.served_rank) INTO v_served
    FROM public.feed_ranked_page(5, NULL, '{}'::uuid[]) p;
  SELECT array_agg(p.hook_id ORDER BY p.score_total DESC, p.hook_created_at DESC, p.hook_id)
    INTO v_by_score
    FROM public.feed_ranked_page(5, NULL, '{}'::uuid[]) p;
  PERFORM tests.reset_role();

  RETURN NEXT ok(v_served = v_by_score,
    '1: single creator -- served order == score order (diversity no-op at N=1)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
