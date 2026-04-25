-- §9.3 / M6: fast-dismiss swipe writes negative weight; affinity_score goes
-- below zero. Authenticated parity with the anon-path negative-swipe test.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-neg@test');
  v_creator_u uuid := tests.create_auth_user('algo-neg-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_aff real;
BEGIN
  UPDATE public.profiles SET handle = 'negauth' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'N', 'negauth', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'saas_pricing', 'S');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_neg', 30, ARRAY['saas_pricing'])
    RETURNING id INTO v_hook_id;

  -- Fast-dismiss: direction down, 800ms, 5% completion → -0.3 weight.
  -- D5 H1: 'up' is now neutral (return-scroll, like 'left'); the dead-zone
  -- classifier only fires for intentional next-video gestures ('down').
  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'hook_swipe', v_hook_id, gen_random_uuid(),
            jsonb_build_object('direction','down','seconds_to_decision_ms',800,
                               'completion_pct',0.05));

  SELECT affinity_score INTO v_aff
    FROM public.user_topic_affinity
   WHERE user_id = v_user AND topic_slug = 'saas_pricing';

  RETURN NEXT ok(
    abs(v_aff - (-0.3)) < 1e-6,
    format('1: fast-dismiss → affinity -0.3 (got %s)', v_aff)
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
