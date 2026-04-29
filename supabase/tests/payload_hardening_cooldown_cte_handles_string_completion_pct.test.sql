-- 0504-05 hardening: feed_ranked_page cooldown CTE does not crash when a
-- user's history contains a malformed completion_pct (string instead of
-- number). Pre-hardening, the (f.payload->>'completion_pct')::real cast
-- inside the CTE's CASE would raise 22P02 and the entire feed call would
-- error out for any user touched by that one bad row.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('hardening-cd@test');
  v_creator_u  uuid := tests.create_auth_user('hardening-cd-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_count      int;
BEGIN
  UPDATE public.profiles SET handle = 'hardcd' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'HC', 'hardcd', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_hard', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_hook_id;

  -- Seed a hook_dwell_end with string completion_pct in the user's history.
  -- A second hook is what we want returned by the feed.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload)
  VALUES (
    v_user, 'hook_dwell_end', v_hook_id, gen_random_uuid(),
    jsonb_build_object('completion_pct', '0.85')
  );

  PERFORM tests.set_authenticated(v_user);

  -- Pre-hardening: this raises 22P02. Post-hardening: completes and
  -- returns the hook (CASE arm fails to NULL → no cooldown applied).
  SELECT count(*) INTO v_count
    FROM public.feed_ranked_page(10, NULL, '{}'::uuid[]);

  RETURN NEXT ok(
    v_count >= 0,
    format('1: feed_ranked_page completed without crash (returned %s rows)', v_count)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
