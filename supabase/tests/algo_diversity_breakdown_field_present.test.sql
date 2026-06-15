-- 0613-03 fix 2: score_breakdown.diversity rides EXPLOIT rows only (audit
-- S-R2-3); explore rows carry no diversity field. Sparse topic + non-zero
-- global quality forces at least one explore row.
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-divb@test');
  v_creator_u uuid := tests.create_auth_user('algo-divb-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook uuid;
  v_i int;
  v_exploit_missing int;
  v_explore_with int;
  v_explore_count int;
BEGIN
  UPDATE public.profiles SET handle = 'divbc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'DB', 'divbc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 5, 'ready')
    RETURNING id INTO v_video_id;

  FOR v_i IN 1..5 LOOP
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at, created_at)
      VALUES (v_video_id, v_i, 'mux_divb_' || v_i, 30, ARRAY['cold_outreach'],
              'ready', now() - (v_i || ' minutes')::interval,
              now() - (v_i || ' minutes')::interval)
      RETURNING id INTO v_hook;
    -- Non-zero global quality => S_explore > 0 (sparse topic, no affinity rows).
    INSERT INTO public.hook_global_stats
      (hook_id, impressions, full_opens,
       impressions_decayed, full_opens_decayed, global_quality)
      VALUES (v_hook, 10, 5, 10, 5, 0.5);
  END LOOP;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  PERFORM tests.set_authenticated(v_user);
  SELECT
    count(*) FILTER (WHERE p.score_breakdown->>'slot_type' = 'exploit'
                       AND NOT (p.score_breakdown ? 'diversity')),
    count(*) FILTER (WHERE p.score_breakdown->>'slot_type' = 'explore'
                       AND (p.score_breakdown ? 'diversity')),
    count(*) FILTER (WHERE p.score_breakdown->>'slot_type' = 'explore')
    INTO v_exploit_missing, v_explore_with, v_explore_count
    FROM public.feed_ranked_page(10, NULL, '{}'::uuid[]) p;
  PERFORM tests.reset_role();

  RETURN NEXT ok(v_explore_count >= 1,
    format('1: at least one explore row in the slate (got %s)', v_explore_count));
  RETURN NEXT is(v_exploit_missing, 0,
    '2: every exploit row carries score_breakdown.diversity');
  RETURN NEXT is(v_explore_with, 0,
    '3: no explore row carries a diversity field');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
