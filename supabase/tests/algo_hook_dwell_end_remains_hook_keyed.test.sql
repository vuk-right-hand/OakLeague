-- T-0504-6: hook_dwell_end stays in Pass A (hook-keyed). A high-completion
-- dwell on lesson 1 of a 5-hook video must retire ONLY lesson 1. Pass A
-- regression: this exists in 0503-16 today as a hook-keyed cooldown; the
-- 0504-03 rewrite must preserve that semantic.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('lf-dwell@test');
  v_creator_u  uuid := tests.create_auth_user('lf-dwell-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_lesson1    uuid;
  v_count_v    int;
  v_lesson1_present boolean;
BEGIN
  UPDATE public.profiles SET handle = 'lfdwellc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'C', 'lfdwellc', 'ready', now())
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
      VALUES (v_video_id, i, 'mux_dwell_' || i::text, 30,
              ARRAY['cold_outreach'], 'ready', now());
  END LOOP;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;
  SELECT id INTO v_lesson1
    FROM public.hooks WHERE video_id = v_video_id AND lesson_number = 1;

  -- High-completion dwell → 3-day hook-level cooldown.
  INSERT INTO public.feed_events_raw
    (user_id, hook_id, video_id, creator_id,
     event_name, idempotency_key, payload)
    VALUES (
      v_user, v_lesson1, v_video_id, v_creator_id,
      'hook_dwell_end', gen_random_uuid(),
      jsonb_build_object('completion_pct', 0.95, 'dwell_ms', 28000, 'lesson_number', 1)
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
    format('1: dwell≥0.8 on lesson 1 retires only lesson 1; siblings (4) served (got %s)', v_count_v)
  );
  RETURN NEXT ok(
    NOT v_lesson1_present,
    '2: dwelled hook (lesson 1) absent from feed (3d cooldown)'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
