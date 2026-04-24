-- §9.3 / S3: 14-day half-life decay via manual last_event_at backdating
-- (no pg_sleep). Seeds score = 2.0 at t0, backdates last_event_at by 14
-- days, fires a second weight-1.0 event, asserts new score ≈ 2.0 * 0.5 + 1.0 = 2.0.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-decay@test');
  v_creator_u uuid := tests.create_auth_user('algo-decay-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_aff real;
BEGIN
  UPDATE public.profiles SET handle = 'decayc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'D', 'decayc', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'build_in_public', 'BIP');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_decay', 30, ARRAY['build_in_public'])
    RETURNING id INTO v_hook_id;

  -- Seed: full_video_quartile=100 → weight 1.0. Two of them → score 2.0.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES
    (v_user, 'full_video_quartile', v_hook_id, gen_random_uuid(),
     jsonb_build_object('quartile', 100)),
    (v_user, 'full_video_quartile', v_hook_id, gen_random_uuid(),
     jsonb_build_object('quartile', 100));

  -- Backdate the rollup row by 14 days (exactly one half-life).
  UPDATE public.user_topic_affinity
     SET last_event_at = now() - interval '14 days'
   WHERE user_id = v_user AND topic_slug = 'build_in_public';

  -- Fire one more weight-1.0 event.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'full_video_quartile', v_hook_id, gen_random_uuid(),
            jsonb_build_object('quartile', 100));

  SELECT affinity_score INTO v_aff
    FROM public.user_topic_affinity
   WHERE user_id = v_user AND topic_slug = 'build_in_public';

  -- Expected: prev (2.0) * 0.5 + new (1.0) = 2.0. Allow ±0.01 for clock drift
  -- (NEW.created_at is a hair later than the backdated last_event_at).
  RETURN NEXT ok(
    abs(v_aff - 2.0) < 0.01,
    format('1: 14d half-life → 2.0 * 0.5 + 1.0 = 2.0 (got %s)', v_aff)
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
