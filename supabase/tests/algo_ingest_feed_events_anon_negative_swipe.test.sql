-- §9.8 / NC1 + M6: a fast-dismiss swipe (direction=up, <2s, completion<0.2)
-- drives the anon topic_affinity blob below zero. Parity with the authenticated
-- rollup trigger's signed EMA.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_creator_u  uuid := tests.create_auth_user('algo-anon-neg-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_anon_id    uuid := gen_random_uuid();
  v_score      real;
BEGIN
  UPDATE public.profiles SET handle = 'anonneg' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'Anon Neg', 'anonneg', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'raising_seed', 'Raising Seed');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_neg', 30, ARRAY['raising_seed'])
    RETURNING id INTO v_hook_id;

  INSERT INTO public.anon_feed_sessions (anon_id) VALUES (v_anon_id);

  PERFORM public.ingest_feed_events_anon(
    v_anon_id,
    jsonb_build_array(jsonb_build_object(
      'event_name', 'hook_swipe',
      'hook_id',    v_hook_id::text,
      'payload',    jsonb_build_object(
        'direction',               'up',
        'seconds_to_decision_ms',  800,
        'completion_pct',          0.05
      )
    ))
  );

  SELECT (topic_affinity->>'raising_seed')::real
    INTO v_score
    FROM public.anon_feed_sessions
   WHERE anon_id = v_anon_id;

  RETURN NEXT ok(
    v_score < 0,
    format('1: fast-dismiss swipe drives topic affinity below zero (got %s)', v_score)
  );
  RETURN NEXT ok(
    abs(v_score - (-0.3)) < 0.001,
    format('2: fast-dismiss weight is exactly -0.3 (got %s)', v_score)
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
