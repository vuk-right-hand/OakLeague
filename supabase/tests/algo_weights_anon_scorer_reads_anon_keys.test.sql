-- Anon lite scorer reads the namespaced *_ANON keys (audit M1): bumping
-- W_GLOBAL_ANON moves the anon score; bumping the authenticated W_GLOBAL does
-- NOT. Runs as postgres — feed_ranked_anon_page is service-role-only. (0613-01)
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_creator_u uuid := tests.create_auth_user('algo-wan-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_s1 real;
  v_s2 real;
  v_s3 real;
BEGIN
  UPDATE public.profiles SET handle = 'wanc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'WAN', 'wanc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_pb_wan', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_hook_id;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- Non-zero global quality so W_GLOBAL_ANON has signal to amplify.
  INSERT INTO public.hook_global_stats (hook_id, impressions, full_opens, global_quality)
    VALUES (v_hook_id, 10, 5, 0.5);

  SELECT score_total INTO v_s1
    FROM public.feed_ranked_anon_page(NULL, 10, NULL, '{}'::uuid[]) LIMIT 1;

  -- Bump the AUTH key: anon score must not move (namespacing proof).
  UPDATE public.feed_algo_weights SET weight_value = 3.0 WHERE weight_key = 'W_GLOBAL';
  SELECT score_total INTO v_s2
    FROM public.feed_ranked_anon_page(NULL, 10, NULL, '{}'::uuid[]) LIMIT 1;

  -- Bump the ANON key: anon score must move by (0.8-0.4)*0.5 = +0.2.
  UPDATE public.feed_algo_weights SET weight_value = 0.8 WHERE weight_key = 'W_GLOBAL_ANON';
  SELECT score_total INTO v_s3
    FROM public.feed_ranked_anon_page(NULL, 10, NULL, '{}'::uuid[]) LIMIT 1;

  RETURN NEXT ok(v_s1 IS NOT NULL, format('1: anon page returns a scored row (%s)', v_s1));
  RETURN NEXT ok(abs(v_s2 - v_s1) < 1e-6,
    format('2: bumping auth W_GLOBAL leaves anon score unchanged (%s vs %s)', v_s1, v_s2));
  RETURN NEXT ok(abs((v_s3 - v_s2) - 0.2) < 1e-3,
    format('3: bumping W_GLOBAL_ANON 0.4→0.8 raises anon score by ≈0.2 (%s → %s)', v_s2, v_s3));
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
