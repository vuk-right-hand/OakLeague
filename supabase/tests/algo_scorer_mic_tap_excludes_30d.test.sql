-- §9.4 / M5: mic_tap session_opened cooldowns a hook for 30 days via the
-- on-the-fly CTE. The feed does not serve it.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-cool@test');
  v_creator_u uuid := tests.create_auth_user('algo-cool-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_seen_hook_id uuid;
  v_fresh_hook_id uuid;
  v_count int;
BEGIN
  UPDATE public.profiles SET handle = 'coolc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'CO', 'coolc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 2, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_pb_seen', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_seen_hook_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 2, 'mux_pb_fresh', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_fresh_hook_id;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- User mic_tap'd the "seen" hook yesterday.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload, created_at)
    VALUES (v_user, 'mic_tap', v_seen_hook_id, gen_random_uuid(),
            jsonb_build_object('mic_tap_outcome', 'session_opened'),
            now() - interval '1 day');

  PERFORM tests.set_authenticated(v_user);

  -- Seen hook is NOT in the feed (30-day cooldown).
  SELECT count(*)::int INTO v_count
    FROM public.feed_ranked_page(50, NULL, '{}'::uuid[])
   WHERE hook_id = v_seen_hook_id;
  RETURN NEXT is(v_count, 0, '1: mic_tap hook excluded for 30d');

  -- Fresh hook IS in the feed.
  SELECT count(*)::int INTO v_count
    FROM public.feed_ranked_page(50, NULL, '{}'::uuid[])
   WHERE hook_id = v_fresh_hook_id;
  RETURN NEXT is(v_count, 1, '2: un-mic_tap hook still served');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
