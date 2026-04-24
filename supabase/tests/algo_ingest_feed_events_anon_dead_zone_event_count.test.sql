-- Audit M6: dead-zone swipes (<500ms) are counted in the dead_zoned return
-- column but NOT added to anon_feed_sessions.event_count. This matters
-- because regime B promotion (event_count >= 3) should not be farmable by
-- rapid-fire noise swipes.
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_creator_u  uuid := tests.create_auth_user('algo-dz-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_anon_id    uuid := gen_random_uuid();
  v_inserted   int;
  v_dead       int;
  v_event_count int;
BEGIN
  UPDATE public.profiles SET handle = 'dzcreator' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'DZ', 'dzcreator', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'build_in_public', 'Build in Public');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_dz', 30, ARRAY['build_in_public'])
    RETURNING id INTO v_hook_id;

  INSERT INTO public.anon_feed_sessions (anon_id) VALUES (v_anon_id);

  -- 3 real events + 3 dead-zone swipes.
  SELECT inserted, dead_zoned
    INTO v_inserted, v_dead
    FROM public.ingest_feed_events_anon(
      v_anon_id,
      jsonb_build_array(
        jsonb_build_object('event_name','hook_impression',
                           'hook_id', v_hook_id::text, 'payload','{}'::jsonb),
        jsonb_build_object('event_name','full_video_open',
                           'hook_id', v_hook_id::text, 'payload','{}'::jsonb),
        jsonb_build_object('event_name','hook_impression',
                           'hook_id', v_hook_id::text, 'payload','{}'::jsonb),
        jsonb_build_object('event_name','hook_swipe', 'hook_id', v_hook_id::text,
          'payload', jsonb_build_object('direction','up','seconds_to_decision_ms', 200)),
        jsonb_build_object('event_name','hook_swipe', 'hook_id', v_hook_id::text,
          'payload', jsonb_build_object('direction','up','seconds_to_decision_ms', 100)),
        jsonb_build_object('event_name','hook_swipe', 'hook_id', v_hook_id::text,
          'payload', jsonb_build_object('direction','up','seconds_to_decision_ms', 400))
      )
    );

  RETURN NEXT is(v_inserted, 3, '1: 3 real events inserted');
  RETURN NEXT is(v_dead,     3, '2: 3 dead-zone swipes counted as dead');

  SELECT event_count
    INTO v_event_count
    FROM public.anon_feed_sessions
   WHERE anon_id = v_anon_id;
  RETURN NEXT is(
    v_event_count,
    3,
    '3: event_count reflects only real events (dead-zone excluded from regime-B threshold)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
