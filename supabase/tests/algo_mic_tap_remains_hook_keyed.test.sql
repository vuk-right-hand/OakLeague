-- T-0504-5: AUDIT C3a REGRESSION TEST. mic_tap stays in Pass A (hook-keyed),
-- not Pass B (video-keyed). One Ask tap on lesson 1 of a 5-hook video must
-- retire ONLY lesson 1, not all 5. Tested by serving the feed and asserting
-- exactly 4 of V's 5 hooks come back (the non-tapped lessons).
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('lf-mic@test');
  v_creator_u  uuid := tests.create_auth_user('lf-mic-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_lesson1    uuid;
  v_session_id uuid;
  v_count_v    int;
  v_lesson1_present boolean;
BEGIN
  UPDATE public.profiles SET handle = 'lfmicc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'C', 'lfmicc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 5, 'ready')
    RETURNING id INTO v_video_id;
  FOR i IN 1..5 LOOP
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at)
      VALUES (v_video_id, i, 'mux_mic_' || i::text, 30,
              ARRAY['cold_outreach'], 'ready', now());
  END LOOP;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;
  SELECT id INTO v_lesson1
    FROM public.hooks WHERE video_id = v_video_id AND lesson_number = 1;

  -- mic_tap requires a real owned session row (R-M5 guard) — seed one.
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_user, v_creator_id, 'gemini_3_1_flash_live_preview', 'free')
    RETURNING id INTO v_session_id;

  INSERT INTO public.feed_events_raw
    (user_id, hook_id, video_id, creator_id, session_id,
     event_name, idempotency_key, payload)
    VALUES (
      v_user, v_lesson1, v_video_id, v_creator_id, v_session_id,
      'mic_tap', gen_random_uuid(),
      jsonb_build_object('mic_tap_outcome', 'session_opened')
    );

  PERFORM tests.set_authenticated(v_user);

  SELECT COUNT(*)::int INTO v_count_v
    FROM public.feed_ranked_page(50, NULL, '{}'::uuid[])
   WHERE video_id = v_video_id;
  SELECT EXISTS (
    SELECT 1 FROM public.feed_ranked_page(50, NULL, '{}'::uuid[])
     WHERE hook_id = v_lesson1
  ) INTO v_lesson1_present;

  RETURN NEXT ok(
    v_count_v = 4,
    format('1: mic_tap on lesson 1 retires only lesson 1; siblings (4) still served (got %s)', v_count_v)
  );
  RETURN NEXT ok(
    NOT v_lesson1_present,
    '2: tapped hook (lesson 1) absent from feed (30d cooldown)'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
