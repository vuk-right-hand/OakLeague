-- Audit M3 (full): the authenticated rollup path and the anon ingest path
-- both route through public.compute_event_weight. Firing the same event
-- sequence through both and comparing final affinity is the structural
-- guarantee that no weight drift can creep in.
--
-- Events fire in the same transaction so time decay ≈ 1.0 on the
-- authenticated side (t_new - t_old is microseconds), and the anon side
-- has no decay at all. Neither hits the [-0.5, 5.0] clamp. Scores should
-- match to floating-point noise.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-parity@test');
  v_creator_u uuid := tests.create_auth_user('algo-parity-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_anon_id uuid := gen_random_uuid();
  v_auth_score real;
  v_anon_score real;
  v_auth_creator real;
  v_anon_creator real;
  v_idem1 uuid := gen_random_uuid();
  v_idem2 uuid := gen_random_uuid();
  v_idem3 uuid := gen_random_uuid();
BEGIN
  UPDATE public.profiles SET handle = 'parityc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'P', 'parityc', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_parity', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_id;

  INSERT INTO public.anon_feed_sessions (anon_id) VALUES (v_anon_id);

  -- Build one event list: full_video_open (0.6) + hook_dwell_end completion=0.5 (0.5)
  -- + hook_swipe right (0.5). Sum = 1.6. All under the 5.0 ceiling.

  -- Authenticated path.
  PERFORM tests.set_authenticated(v_user);
  PERFORM public.ingest_feed_events(jsonb_build_array(
    jsonb_build_object(
      'event_name','full_video_open','hook_id', v_hook_id::text,
      'idempotency_key', v_idem1::text,
      'payload', jsonb_build_object('source','swipe')),
    jsonb_build_object(
      'event_name','hook_dwell_end','hook_id', v_hook_id::text,
      'idempotency_key', v_idem2::text,
      'payload', jsonb_build_object('dwell_ms', 15000, 'completion_pct', 0.5)),
    jsonb_build_object(
      'event_name','hook_swipe','hook_id', v_hook_id::text,
      'idempotency_key', v_idem3::text,
      'payload', jsonb_build_object('direction','right','seconds_to_decision_ms', 3000))
  ));
  PERFORM tests.reset_role();

  -- Anon path — same events, same payloads.
  PERFORM public.ingest_feed_events_anon(v_anon_id, jsonb_build_array(
    jsonb_build_object(
      'event_name','full_video_open','hook_id', v_hook_id::text,
      'payload', jsonb_build_object('source','swipe')),
    jsonb_build_object(
      'event_name','hook_dwell_end','hook_id', v_hook_id::text,
      'payload', jsonb_build_object('dwell_ms', 15000, 'completion_pct', 0.5)),
    jsonb_build_object(
      'event_name','hook_swipe','hook_id', v_hook_id::text,
      'payload', jsonb_build_object('direction','right','seconds_to_decision_ms', 3000))
  ));

  SELECT affinity_score INTO v_auth_score
    FROM public.user_topic_affinity
   WHERE user_id = v_user AND topic_slug = 'cold_outreach';
  SELECT (topic_affinity->>'cold_outreach')::real INTO v_anon_score
    FROM public.anon_feed_sessions WHERE anon_id = v_anon_id;

  RETURN NEXT ok(
    abs(v_auth_score - v_anon_score) < 0.001,
    format('1: topic affinity parity (auth=%s anon=%s diff=%s)',
           v_auth_score, v_anon_score, abs(v_auth_score - v_anon_score))
  );

  SELECT affinity_score INTO v_auth_creator
    FROM public.user_creator_affinity
   WHERE user_id = v_user AND creator_id = v_creator_id;
  SELECT (creator_affinity->>v_creator_id::text)::real INTO v_anon_creator
    FROM public.anon_feed_sessions WHERE anon_id = v_anon_id;

  RETURN NEXT ok(
    abs(v_auth_creator - v_anon_creator) < 0.001,
    format('2: creator affinity parity (auth=%s anon=%s diff=%s)',
           v_auth_creator, v_anon_creator, abs(v_auth_creator - v_anon_creator))
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
