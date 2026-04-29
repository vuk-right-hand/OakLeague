-- T-0504-4: full_video_open alone — no quartile follow-up — applies the
-- 24h cooldown via Pass B fanout to every hook of the video. Asserts
-- the no-quartile branch is reachable from Pass B (it was the dominant
-- branch in 0503-16 hook-keyed; here it must fan out to all hooks).
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('lf-noq@test');
  v_creator_u  uuid := tests.create_auth_user('lf-noq-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_lesson1    uuid;
  v_count_v    int;
BEGIN
  UPDATE public.profiles SET handle = 'lfnoqc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'C', 'lfnoqc', 'ready', now())
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
      VALUES (v_video_id, i, 'mux_noq_' || i::text, 30,
              ARRAY['cold_outreach'], 'ready', now());
  END LOOP;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;
  SELECT id INTO v_lesson1
    FROM public.hooks WHERE video_id = v_video_id AND lesson_number = 1;

  -- Open at T-12h. No quartile event exists. 24h cooldown is active.
  INSERT INTO public.feed_events_raw
    (user_id, hook_id, video_id, creator_id,
     event_name, idempotency_key, payload, created_at)
    VALUES (
      v_user, v_lesson1, v_video_id, v_creator_id,
      'full_video_open', gen_random_uuid(),
      jsonb_build_object('source', 'pill'),
      now() - interval '12 hours'
    );

  PERFORM tests.set_authenticated(v_user);

  SELECT COUNT(*)::int INTO v_count_v
    FROM public.feed_ranked_page(50, NULL, '{}'::uuid[])
   WHERE video_id = v_video_id;

  RETURN NEXT ok(
    v_count_v = 0,
    format('1: open with no quartile follow-up retires all 5 hooks of V for 24h (got %s of 5)', v_count_v)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
