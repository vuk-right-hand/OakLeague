-- Audit M4: anon topic_affinity jsonb blob clamps to [-0.5, 5.0].
-- 20x full_video_quartile=100 events (weight 1.0 each = 20.0 raw) should
-- clamp at 5.0. 10x fast-dismiss swipes (-0.3 each = -3.0 raw) should
-- floor at -0.5.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_creator_u  uuid := tests.create_auth_user('algo-clamp-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_anon_id    uuid := gen_random_uuid();
  v_batch      jsonb;
  v_score      real;
  i int;
BEGIN
  UPDATE public.profiles SET handle = 'clampc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'Clamp', 'clampc', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'saas_pricing', 'SaaS Pricing');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_clamp', 30, ARRAY['saas_pricing'])
    RETURNING id INTO v_hook_id;

  INSERT INTO public.anon_feed_sessions (anon_id) VALUES (v_anon_id);

  -- Ceiling: 20 quartile=100 events. Batches are capped at 50, so send in
  -- two batches of 20 (well under the cap).
  v_batch := '[]'::jsonb;
  FOR i IN 1..20 LOOP
    v_batch := v_batch || jsonb_build_array(jsonb_build_object(
      'event_name', 'full_video_quartile',
      'hook_id',    v_hook_id::text,
      'payload',    jsonb_build_object('quartile', 100)
    ));
  END LOOP;
  PERFORM public.ingest_feed_events_anon(v_anon_id, v_batch);

  SELECT (topic_affinity->>'saas_pricing')::real
    INTO v_score
    FROM public.anon_feed_sessions
   WHERE anon_id = v_anon_id;
  RETURN NEXT ok(
    abs(v_score - 5.0) < 1e-6,
    format('1: 20x quartile-100 clamped at ceiling 5.0 (got %s)', v_score)
  );

  -- Floor: drive the same topic below zero with fast-dismiss swipes.
  v_batch := '[]'::jsonb;
  FOR i IN 1..20 LOOP
    v_batch := v_batch || jsonb_build_array(jsonb_build_object(
      'event_name', 'hook_swipe',
      'hook_id',    v_hook_id::text,
      'payload',    jsonb_build_object(
        -- D5 H1: 'down' is the dead-zone-eligible direction now.
        'direction',              'down',
        'seconds_to_decision_ms', 800,
        'completion_pct',         0.05
      )
    ));
  END LOOP;
  PERFORM public.ingest_feed_events_anon(v_anon_id, v_batch);

  SELECT (topic_affinity->>'saas_pricing')::real
    INTO v_score
    FROM public.anon_feed_sessions
   WHERE anon_id = v_anon_id;
  RETURN NEXT ok(
    abs(v_score - (-0.5)) < 1e-6,
    format('2: 20x fast-dismiss floored at -0.5 (got %s)', v_score)
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
