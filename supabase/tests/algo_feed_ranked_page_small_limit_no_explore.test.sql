-- T-D3-6 / M-3: slot-guard is limit-sensitive.
-- Test 1: p_limit=2 → explore_slot_1 ∈ {2,3,4} ≥ 2 = v_limit → no explore slots fit;
--   all returned hooks must be slot_type='exploit'.
-- Test 2: p_limit=10 → explore_slot_1 < 10 AND explore_slot_2 < 10 → both hooks go
--   into explore slots, confirming the same hooks ARE explore-eligible at a larger limit
--   (distinguishes "slot suppressed" from "no explore candidates").
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('algo-smalllim@test');
  v_creator_u  uuid := tests.create_auth_user('algo-smalllim-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_exploit_count  int;
  v_explore_count  int;
  i                int;
BEGIN
  UPDATE public.profiles SET handle = 'smalllimc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'SL', 'smalllimc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'build_in_public', 'BIP');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 2, 'ready')
    RETURNING id INTO v_video_id;
  FOR i IN 1..2 LOOP
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at)
      VALUES (v_video_id, i, 'mux_smalllim_' || i, 30,
              ARRAY['build_in_public'], 'ready', now() - (i * interval '1 second'));
  END LOOP;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- global_quality=0.9 → these hooks would be explore-eligible at a larger limit.
  -- No user affinity row → sparse topic → S_explore = 0.9 > 0.
  INSERT INTO public.hook_global_stats (hook_id, impressions, full_opens, mic_taps, global_quality)
  SELECT h.id, 100, 90, 15, 0.9
    FROM public.hooks h WHERE h.video_id = v_video_id;

  PERFORM tests.set_authenticated(v_user);

  -- p_limit=2 → explore_slot_1 ∈ {2,3,4}, all ≥ 2 = v_limit → no explore slots fit.
  SELECT COUNT(*)::int INTO v_exploit_count
    FROM public.feed_ranked_page(2, NULL, '{}'::uuid[])
   WHERE score_breakdown->>'slot_type' = 'exploit';

  RETURN NEXT ok(
    v_exploit_count = 2,
    format('1: p_limit=2 suppresses all explore slots → 2 exploit hooks (got %s)', v_exploit_count)
  );

  -- Test 2: p_limit=10 → both explore slots fit (slot_1 ∈ {2,3,4} < 10, slot_2 ∈ {6,7,8} < 10).
  -- With only 2 hooks both explore-eligible, they both land in explore slots; top_exploit empty.
  SELECT COUNT(*)::int INTO v_explore_count
    FROM public.feed_ranked_page(10, NULL, '{}'::uuid[])
   WHERE score_breakdown->>'slot_type' = 'explore';

  RETURN NEXT ok(
    v_explore_count = 2,
    format('2: p_limit=10 allows both explore slots → 2 explore hooks (got %s)', v_explore_count)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
