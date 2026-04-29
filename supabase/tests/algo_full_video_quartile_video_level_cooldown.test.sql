-- T-0504-1: Pass B video-level cooldown — q=100 retires every hook of the
-- video, not just the hook_id on the event itself.
--
-- Setup: 5-hook video V. Insert one full_video_quartile q=100 event with
-- hook_id = lesson 1, video_id = V. Pass B JOINs hooks ON hooks.video_id
-- and applies the 14d cooldown to all 5 lessons. Asserts none of V's
-- hooks appear in feed_ranked_page results.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('lf-q100@test');
  v_creator_u  uuid := tests.create_auth_user('lf-q100-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_first_hook uuid;
  v_count_v    int;
  v_count_total int;
BEGIN
  UPDATE public.profiles SET handle = 'lfq100c' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'C', 'lfq100c', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 5, 'ready')
    RETURNING id INTO v_video_id;

  -- Five lessons under V.
  FOR i IN 1..5 LOOP
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at)
      VALUES (v_video_id, i, 'mux_q100_' || i::text, 30,
              ARRAY['cold_outreach'], 'ready', now())
      RETURNING id INTO v_first_hook;
  END LOOP;
  -- Publish AFTER hooks are ready (guard_published_requires_ready_hooks).
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;
  -- v_first_hook now holds lesson 5; for the event we want lesson 1.
  SELECT id INTO v_first_hook
    FROM public.hooks WHERE video_id = v_video_id AND lesson_number = 1;

  -- One q=100 event, attributed to lesson 1 only.
  INSERT INTO public.feed_events_raw
    (user_id, hook_id, video_id, creator_id,
     event_name, idempotency_key, payload)
    VALUES (
      v_user, v_first_hook, v_video_id, v_creator_id,
      'full_video_quartile', gen_random_uuid(),
      jsonb_build_object('quartile', 100, 'source', 'pill')
    );

  PERFORM tests.set_authenticated(v_user);

  SELECT COUNT(*)::int INTO v_count_v
    FROM public.feed_ranked_page(50, NULL, '{}'::uuid[])
   WHERE video_id = v_video_id;

  SELECT COUNT(*)::int INTO v_count_total
    FROM public.feed_ranked_page(50, NULL, '{}'::uuid[]);

  RETURN NEXT ok(
    v_count_v = 0,
    format('1: q=100 on lesson 1 retires all 5 hooks of video V (got %s of 5)', v_count_v)
  );
  RETURN NEXT ok(
    v_count_total = 0,
    format('2: catalog otherwise empty for caller — control (got %s)', v_count_total)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
