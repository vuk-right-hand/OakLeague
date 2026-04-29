-- T-0504-7: AUDIT C3c REGRESSION TEST. Outer MAX collapses Pass A 30d
-- (mic_tap session_opened) and Pass B 14d (q=100) for the same hook. The
-- discriminating setup places mic_tap 29 days ago (Pass A row's 30d
-- cooldown still active by ~1 day) and q=100 15 days ago (Pass B row's
-- 14d cooldown expired by ~1 day).
--
-- Without the outer MAX (e.g. plain UNION accidentally dedups or first-row
-- wins), Pass A's still-active 30d could be lost and lesson 1 would
-- incorrectly appear in the feed. With outer MAX, the active 30d wins
-- and lesson 1 stays absent. Lessons 2–5 only have the expired Pass B
-- row → they appear (verifies fanout works AND that expired cooldowns
-- correctly drop out of `available_after > now()`).
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('lf-max@test');
  v_creator_u  uuid := tests.create_auth_user('lf-max-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_lesson1    uuid;
  v_session_id uuid;
  v_count_v    int;
  v_lesson1_present boolean;
BEGIN
  UPDATE public.profiles SET handle = 'lfmaxc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'C', 'lfmaxc', 'ready', now())
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
      VALUES (v_video_id, i, 'mux_max_' || i::text, 30,
              ARRAY['cold_outreach'], 'ready', now());
  END LOOP;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;
  SELECT id INTO v_lesson1
    FROM public.hooks WHERE video_id = v_video_id AND lesson_number = 1;

  -- mic_tap requires a real owned session row (R-M5).
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_user, v_creator_id, 'gemini_3_1_flash_live_preview', 'free')
    RETURNING id INTO v_session_id;

  -- Pass A row: mic_tap on lesson 1, 29 days ago. 30d cooldown ends in ~1d.
  INSERT INTO public.feed_events_raw
    (user_id, hook_id, video_id, creator_id, session_id,
     event_name, idempotency_key, payload, created_at)
    VALUES (
      v_user, v_lesson1, v_video_id, v_creator_id, v_session_id,
      'mic_tap', gen_random_uuid(),
      jsonb_build_object('mic_tap_outcome', 'session_opened'),
      now() - interval '29 days'
    );

  -- Pass B row: q=100 on V, 15 days ago. 14d cooldown ended ~1d ago.
  INSERT INTO public.feed_events_raw
    (user_id, hook_id, video_id, creator_id,
     event_name, idempotency_key, payload, created_at)
    VALUES (
      v_user, v_lesson1, v_video_id, v_creator_id,
      'full_video_quartile', gen_random_uuid(),
      jsonb_build_object('quartile', 100, 'source', 'pill'),
      now() - interval '15 days'
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
    format('1: lesson 1 absent (30d still active via Pass A MAX), 4 siblings served (got %s)', v_count_v)
  );
  RETURN NEXT ok(
    NOT v_lesson1_present,
    '2: outer MAX correctly preserved the longer Pass A cooldown over expired Pass B'
  );
  -- Sanity: confirm at least one sibling is in fact appearing (not blocked
  -- by some unrelated filter).
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.feed_ranked_page(50, NULL, '{}'::uuid[])
             WHERE video_id = v_video_id AND lesson_number = 2),
    '3: lesson 2 appears in feed (Pass B row exists but expired)'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
