-- §9.3: mic_tap session_opened writes the largest single-event weight (2.0)
-- to both topic + creator affinity. North-star event.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-mictap@test');
  v_creator_u uuid := tests.create_auth_user('algo-mictap-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
BEGIN
  UPDATE public.profiles SET handle = 'mictapc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'M', 'mictapc', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'raising_seed', 'R');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_mic', 30, ARRAY['raising_seed'])
    RETURNING id INTO v_hook_id;

  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'mic_tap', v_hook_id, gen_random_uuid(),
            jsonb_build_object('mic_tap_outcome','session_opened'));

  RETURN NEXT ok(
    abs((SELECT affinity_score FROM public.user_topic_affinity
          WHERE user_id = v_user AND topic_slug = 'raising_seed') - 2.0) < 1e-6,
    '1: topic affinity = 2.0 after mic_tap session_opened'
  );
  RETURN NEXT ok(
    abs((SELECT affinity_score FROM public.user_creator_affinity
          WHERE user_id = v_user AND creator_id = v_creator_id) - 2.0) < 1e-6,
    '2: creator affinity = 2.0 after mic_tap session_opened'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
