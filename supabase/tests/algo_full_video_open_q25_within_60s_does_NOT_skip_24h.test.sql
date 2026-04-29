-- T-0504-3: AUDIT C3 REGRESSION TEST. q=25 within 60s of full_video_open
-- must NOT suppress the 24h cooldown. The NOT EXISTS guard requires
-- (q2.payload->>'quartile')::int >= 50. q=25 alone hits no CASE branch
-- AND must not satisfy the guard.
--
-- Setup: open at T-23h, q=25 at T-23h+10s (within 60s window). No q≥50
-- exists. Outcome: 24h cooldown applies to all 5 hooks of V via Pass B
-- fanout. Expires at T+1h. Hooks ABSENT from feed.
--
-- Discriminator vs the q=50 test: identical event timing, only the
-- quartile value differs. q=50 → 24h skipped + own 7d → 5 served (other
-- test runs both events 8d ago to expire all cooldowns). q=25 → 24h
-- applies → 5 ABSENT.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('lf-c3@test');
  v_creator_u  uuid := tests.create_auth_user('lf-c3-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_lesson1    uuid;
  v_t_open     timestamptz := now() - interval '23 hours';
  v_count_v    int;
  v_count_total int;
BEGIN
  UPDATE public.profiles SET handle = 'lfc3c' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'C', 'lfc3c', 'ready', now())
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
      VALUES (v_video_id, i, 'mux_c3_' || i::text, 30,
              ARRAY['cold_outreach'], 'ready', now());
  END LOOP;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;
  SELECT id INTO v_lesson1
    FROM public.hooks WHERE video_id = v_video_id AND lesson_number = 1;

  -- Open at T-23h, q=25 at T-23h+10s. No q≥50 anywhere.
  INSERT INTO public.feed_events_raw
    (user_id, hook_id, video_id, creator_id,
     event_name, idempotency_key, payload, created_at)
    VALUES (
      v_user, v_lesson1, v_video_id, v_creator_id,
      'full_video_open', gen_random_uuid(),
      jsonb_build_object('source', 'pill'),
      v_t_open
    );
  INSERT INTO public.feed_events_raw
    (user_id, hook_id, video_id, creator_id,
     event_name, idempotency_key, payload, created_at)
    VALUES (
      v_user, v_lesson1, v_video_id, v_creator_id,
      'full_video_quartile', gen_random_uuid(),
      jsonb_build_object('quartile', 25, 'source', 'pill'),
      v_t_open + interval '10 seconds'
    );

  PERFORM tests.set_authenticated(v_user);

  SELECT COUNT(*)::int INTO v_count_v
    FROM public.feed_ranked_page(50, NULL, '{}'::uuid[])
   WHERE video_id = v_video_id;
  SELECT COUNT(*)::int INTO v_count_total
    FROM public.feed_ranked_page(50, NULL, '{}'::uuid[]);

  -- 24h cooldown applies → expires at T+1h → ACTIVE → all 5 hooks absent.
  -- If the bug returned (q=25 satisfying the guard), no cooldown would
  -- apply and 5 hooks would appear.
  RETURN NEXT ok(
    v_count_v = 0,
    format('1: q=25 within 60s does NOT skip 24h cooldown — 5 hooks of V absent (got %s of 5)', v_count_v)
  );
  RETURN NEXT ok(
    v_count_total = 0,
    format('2: catalog otherwise empty (got %s)', v_count_total)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
