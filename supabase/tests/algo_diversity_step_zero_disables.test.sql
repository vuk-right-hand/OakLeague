-- 0613-03 fix 2 kill switch: W_DIVERSITY_STEP = 0 => penalized key collapses
-- to exploit_rn => exact pre-change ordering even with two creators (the
-- interleave test's AABABB seed serves AAABBB instead).
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-div0@test');
  v_ca_u uuid := tests.create_auth_user('algo-div0-a@test');
  v_cb_u uuid := tests.create_auth_user('algo-div0-b@test');
  v_ca uuid; v_cb uuid;
  v_va uuid; v_vb uuid;
  v_i int;
  v_order text;
BEGIN
  UPDATE public.profiles SET handle = 'div0a' WHERE id = v_ca_u;
  UPDATE public.profiles SET handle = 'div0b' WHERE id = v_cb_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_ca_u, 'A', 'div0a', 'ready', now()) RETURNING id INTO v_ca;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cb_u, 'B', 'div0b', 'ready', now()) RETURNING id INTO v_cb;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_ca, 'cold_outreach', 'C'), (v_cb, 'cold_outreach', 'C');

  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_ca, 'VA', 3, 'ready') RETURNING id INTO v_va;
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_cb, 'VB', 3, 'ready') RETURNING id INTO v_vb;

  FOR v_i IN 1..3 LOOP
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at, created_at)
      VALUES (v_va, v_i, 'mux_div0_a' || v_i, 30, ARRAY['cold_outreach'],
              'ready', now() - (v_i || ' minutes')::interval,
              now() - (v_i || ' minutes')::interval);
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at, created_at)
      VALUES (v_vb, v_i, 'mux_div0_b' || v_i, 30, ARRAY['cold_outreach'],
              'ready', now() - ((10 + v_i) || ' minutes')::interval,
              now() - ((10 + v_i) || ' minutes')::interval);
  END LOOP;
  UPDATE public.videos SET published_at = now() WHERE id IN (v_va, v_vb);

  INSERT INTO public.user_creator_affinity (user_id, creator_id, affinity_score)
    VALUES (v_user, v_ca, 5.0);
  INSERT INTO public.user_topic_affinity (user_id, topic_slug, impressions, affinity_score)
    VALUES (v_user, 'cold_outreach', 5, 0);

  UPDATE public.feed_algo_weights SET weight_value = 0 WHERE weight_key = 'W_DIVERSITY_STEP';

  PERFORM tests.set_authenticated(v_user);
  SELECT string_agg(CASE WHEN p.creator_id = v_ca THEN 'A' ELSE 'B' END, '' ORDER BY p.served_rank)
    INTO v_order
    FROM public.feed_ranked_page(6, NULL, '{}'::uuid[]) p;
  PERFORM tests.reset_role();

  RETURN NEXT is(v_order, 'AAABBB',
    format('1: step=0 disables the interleave -- pure score order (got %s)', v_order));
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
