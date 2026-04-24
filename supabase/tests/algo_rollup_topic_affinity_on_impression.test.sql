-- §9.3: rollup trigger writes user_topic_affinity on hook_impression with
-- weight 0.02 (per compute_event_weight).
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-rollup-imp@test');
  v_creator_u uuid := tests.create_auth_user('algo-rollup-imp-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_aff real;
  v_impressions int;
BEGIN
  UPDATE public.profiles SET handle = 'rollupimp' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'RI', 'rollupimp', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'Cold');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_imp', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_id;

  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'hook_impression', v_hook_id, gen_random_uuid(), '{}'::jsonb);

  SELECT affinity_score, impressions INTO v_aff, v_impressions
    FROM public.user_topic_affinity
   WHERE user_id = v_user AND topic_slug = 'cold_outreach';

  RETURN NEXT ok(
    abs(v_aff - 0.02) < 1e-6,
    format('1: affinity_score = 0.02 after first impression (got %s)', v_aff)
  );
  RETURN NEXT is(v_impressions, 1, '2: impressions counter bumped to 1');

  -- Creator affinity row also present.
  RETURN NEXT ok(
    abs((SELECT affinity_score FROM public.user_creator_affinity
          WHERE user_id = v_user AND creator_id = v_creator_id) - 0.02) < 1e-6,
    '3: user_creator_affinity also updated'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
