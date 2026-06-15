-- 0613-02 decay job: decayed counters × pow(0.5, 1/30) to 1e-5 (audit
-- S-R2-5), raw counters untouched, global_quality recomputed from post-decay
-- values, dust < 0.01 floors to 0, authenticated cannot execute.
-- Role check via has_function_privilege — never SET ROLE + call on a secdef
-- fn (PG17 segfault trap, .claude_learnings 2026-05-22).
BEGIN;
SELECT plan(6);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_creator_u uuid := tests.create_auth_user('algo-dcj-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_a uuid;
  v_hook_b uuid;
  v_mult double precision := pow(0.5, 1.0/30.0);
  v_row record;
BEGIN
  UPDATE public.profiles SET handle = 'dcjc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'D', 'dcjc', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 2, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_dcj_a', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_a;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 2, 'mux_pb_dcj_b', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_b;

  -- Hook A: healthy counters. Hook B: dust about to floor.
  INSERT INTO public.hook_global_stats
    (hook_id, impressions, full_opens, mic_taps,
     impressions_decayed, full_opens_decayed, mic_taps_decayed, global_quality)
  VALUES
    (v_hook_a, 100, 20, 5, 100, 20, 5, 0.0),
    (v_hook_b,   3,  0, 0, 0.005, 0.005, 0.005, 0.0);

  PERFORM public.hook_global_stats_decay();

  SELECT * INTO v_row FROM public.hook_global_stats WHERE hook_id = v_hook_a;
  RETURN NEXT ok(
    abs(v_row.impressions_decayed - 100 * v_mult) < 1e-5
      AND abs(v_row.full_opens_decayed - 20 * v_mult) < 1e-5
      AND abs(v_row.mic_taps_decayed - 5 * v_mult) < 1e-5,
    format('1: decayed counters × pow(0.5,1/30)=%s within 1e-5 (got %s, %s, %s)',
           v_mult, v_row.impressions_decayed, v_row.full_opens_decayed, v_row.mic_taps_decayed));
  RETURN NEXT ok(
    v_row.impressions = 100 AND v_row.full_opens = 20 AND v_row.mic_taps = 5,
    '2: raw counters untouched by decay');
  RETURN NEXT ok(
    abs(v_row.global_quality
        - ((1 + 20 * v_mult + 3 * 5 * v_mult) / (10 + 100 * v_mult))) < 1e-5,
    format('3: global_quality recomputed from post-decay values (got %s)', v_row.global_quality));

  SELECT * INTO v_row FROM public.hook_global_stats WHERE hook_id = v_hook_b;
  RETURN NEXT ok(
    v_row.impressions_decayed = 0 AND v_row.full_opens_decayed = 0
      AND v_row.mic_taps_decayed = 0,
    '4: dust < 0.01 floors to exactly 0');
  RETURN NEXT ok(
    abs(v_row.global_quality - 0.1) < 1e-5,
    format('5: fully-decayed hook drifts to the 1/10 prior (got %s)', v_row.global_quality));

  RETURN NEXT ok(
    NOT has_function_privilege('authenticated', 'public.hook_global_stats_decay()', 'EXECUTE'),
    '6: authenticated cannot execute the decay job');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
