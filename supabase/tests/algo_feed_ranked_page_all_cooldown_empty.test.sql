-- T-D3-5: when every candidate hook is in cooldown, feed_ranked_page returns
-- 0 rows without error. Uses the mic_tap / session_opened event which applies
-- a 30-day cooldown.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('algo-coolall@test');
  v_creator_u  uuid := tests.create_auth_user('algo-coolall-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_session_id uuid;
  v_count      int;
BEGIN
  UPDATE public.profiles SET handle = 'coolallc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'CA', 'coolallc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_coolall', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_hook_id;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- 30-day cooldown via mic_tap + session_opened. R-M5: the cooldown CTE
  -- requires session_id IS NOT NULL so this test also seeds a real session
  -- row (otherwise the forged event is now correctly ignored).
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_user, v_creator_id, 'gemini_3_1_flash_live_preview', 'free')
    RETURNING id INTO v_session_id;

  INSERT INTO public.feed_events_raw
    (user_id, hook_id, video_id, creator_id, session_id,
     event_name, idempotency_key, payload)
    VALUES (
      v_user, v_hook_id, v_video_id, v_creator_id, v_session_id,
      'mic_tap', gen_random_uuid(),
      jsonb_build_object('mic_tap_outcome', 'session_opened')
    );

  PERFORM tests.set_authenticated(v_user);

  SELECT COUNT(*)::int INTO v_count
    FROM public.feed_ranked_page(10, NULL, '{}'::uuid[]);

  RETURN NEXT ok(
    v_count = 0,
    format('1: all hooks in 30-day cooldown → 0 results, no error (got %s)', v_count)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
