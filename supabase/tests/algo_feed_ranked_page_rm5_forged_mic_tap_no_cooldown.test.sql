-- D4 post-audit R-M5: a forged mic_tap event (outcome='session_opened'
-- with session_id = NULL) must NOT grant the 30-day cooldown at the
-- scorer. Without the session_id NOT NULL guard, a user can self-forge
-- a cooldown against any hook to hide it from their feed.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('algo-rm5@test');
  v_creator_u  uuid := tests.create_auth_user('algo-rm5-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_count_forged int;
  v_count_real   int;
  v_session_id   uuid;
BEGIN
  UPDATE public.profiles SET handle = 'rm5c' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'RM', 'rm5c', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_rm5', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_hook_id;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- (1) Forged mic_tap: outcome='session_opened' but session_id = NULL
  -- (simulates the exploit ingest_feed_events actually permits when a
  --  client posts session_id_if_opened that belongs to another user —
  --  the RPC nulls v_session_id and still inserts the row).
  INSERT INTO public.feed_events_raw
    (user_id, hook_id, video_id, creator_id, session_id,
     event_name, idempotency_key, payload)
    VALUES (
      v_user, v_hook_id, v_video_id, v_creator_id, NULL,
      'mic_tap', gen_random_uuid(),
      jsonb_build_object('mic_tap_outcome', 'session_opened')
    );

  PERFORM tests.set_authenticated(v_user);

  SELECT COUNT(*)::int INTO v_count_forged
    FROM public.feed_ranked_page(10, NULL, '{}'::uuid[]);

  RETURN NEXT ok(
    v_count_forged = 1,
    format('1: forged mic_tap (session_id NULL) does not cool down hook (got %s rows, expected 1)', v_count_forged)
  );

  PERFORM tests.reset_role();

  -- (2) Add a real session + mic_tap pairing. Now the cooldown SHOULD fire.
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

  SELECT COUNT(*)::int INTO v_count_real
    FROM public.feed_ranked_page(10, NULL, '{}'::uuid[]);

  RETURN NEXT ok(
    v_count_real = 0,
    format('2: real mic_tap with owned session_id cools down hook (got %s rows, expected 0)', v_count_real)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
