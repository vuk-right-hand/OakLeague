-- §9.3: rollup trigger skips rows where skipped_reason IS NOT NULL. Confirms
-- dead-zone swipes land in the raw table (kept for debug) but do not
-- propagate to affinity.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-dzrollup@test');
  v_creator_u uuid := tests.create_auth_user('algo-dzrollup-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
BEGIN
  UPDATE public.profiles SET handle = 'dzrc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'D', 'dzrc', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_dzr', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_id;

  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload, skipped_reason)
    VALUES (v_user, 'hook_swipe', v_hook_id, gen_random_uuid(),
            jsonb_build_object('direction','up','seconds_to_decision_ms',200),
            'dead_zone_swipe');

  RETURN NEXT is(
    (SELECT count(*)::int FROM public.feed_events_raw WHERE user_id = v_user),
    1,
    '1: raw row stored'
  );
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.user_topic_affinity WHERE user_id = v_user),
    0,
    '2: no user_topic_affinity row (rollup skipped the dead-zone event)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
