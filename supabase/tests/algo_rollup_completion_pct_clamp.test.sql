-- Audit M1-clamp (round-5): a malformed client payload with completion_pct
-- outside [0, 1] must not propagate to hook_global_stats.avg_completion_pct
-- (constrained BETWEEN 0 AND 1) and must not abort the ingest batch via
-- check_violation. The rollup trigger clamps v_completion_pct defensively.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-clamp@test');
  v_creator_u uuid := tests.create_auth_user('algo-clamp-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_avg real;
BEGIN
  UPDATE public.profiles SET handle = 'clampdwell' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'CD', 'clampdwell', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_clamp', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_id;

  -- Malformed payload: completion_pct = 1.5. Pre-clamp, the rollup formula
  -- would write 1.5 into avg_completion_pct, trip the BETWEEN 0 AND 1
  -- CHECK on hook_global_stats, and abort the INSERT. The ingest RPC's
  -- exception handler catches only unique_violation + invalid_text_representation,
  -- so the check_violation would bubble out and nuke the entire batch.
  --
  -- Post-clamp: v_completion_pct is clamped to 1.0 before hitting the
  -- formula. Event inserts cleanly, avg_completion_pct lands at 1.0.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'hook_dwell_end', v_hook_id, gen_random_uuid(),
            jsonb_build_object('dwell_ms', 30000, 'completion_pct', 1.5));

  RETURN NEXT is(
    (SELECT count(*)::int FROM public.feed_events_raw
      WHERE user_id = v_user AND event_name = 'hook_dwell_end'),
    1,
    '1: malformed completion_pct=1.5 did not abort the event insert'
  );

  SELECT avg_completion_pct INTO v_avg
    FROM public.hook_global_stats WHERE hook_id = v_hook_id;
  RETURN NEXT ok(
    abs(v_avg - 1.0) < 1e-6,
    format('2: avg_completion_pct clamped to 1.0 (got %s)', v_avg)
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
