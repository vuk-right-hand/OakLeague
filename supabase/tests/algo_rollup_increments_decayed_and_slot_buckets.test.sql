-- 0613-02 rollup: slot buckets classify served_rank (0..2 ⇒ top3, else/
-- missing/malformed ⇒ rest) and decayed counters track raw across the
-- DO-UPDATE arm.
BEGIN;
SELECT plan(5);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-slb@test');
  v_creator_u uuid := tests.create_auth_user('algo-slb-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_row record;
BEGIN
  UPDATE public.profiles SET handle = 'slbc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'S', 'slbc', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_slb', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_id;

  -- served_rank 1 → top3.
  INSERT INTO public.feed_events_raw (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'hook_impression', v_hook_id, gen_random_uuid(),
            jsonb_build_object('served_rank', 1));
  SELECT * INTO v_row FROM public.hook_global_stats WHERE hook_id = v_hook_id;
  RETURN NEXT ok(v_row.impressions_top3 = 1 AND v_row.impressions_rest = 0,
    format('1: served_rank=1 buckets to top3 (top3=%s rest=%s)',
           v_row.impressions_top3, v_row.impressions_rest));

  -- served_rank 5 → rest.
  INSERT INTO public.feed_events_raw (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'hook_impression', v_hook_id, gen_random_uuid(),
            jsonb_build_object('served_rank', 5));
  SELECT * INTO v_row FROM public.hook_global_stats WHERE hook_id = v_hook_id;
  RETURN NEXT ok(v_row.impressions_top3 = 1 AND v_row.impressions_rest = 1,
    '2: served_rank=5 buckets to rest');

  -- Malformed served_rank (string) → rest, no crash (hardened cast).
  INSERT INTO public.feed_events_raw (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'hook_impression', v_hook_id, gen_random_uuid(),
            jsonb_build_object('served_rank', 'first'));
  SELECT * INTO v_row FROM public.hook_global_stats WHERE hook_id = v_hook_id;
  RETURN NEXT ok(v_row.impressions_rest = 2,
    '3: malformed served_rank buckets to rest without raising');

  -- Missing served_rank → rest.
  INSERT INTO public.feed_events_raw (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'hook_impression', v_hook_id, gen_random_uuid(), '{}'::jsonb);
  SELECT * INTO v_row FROM public.hook_global_stats WHERE hook_id = v_hook_id;
  RETURN NEXT ok(v_row.impressions_top3 = 1 AND v_row.impressions_rest = 3,
    '4: missing served_rank buckets to rest');

  -- Decayed counters tracked raw across all four DO-UPDATE hits.
  RETURN NEXT ok(
    abs(v_row.impressions_decayed - v_row.impressions) < 1e-6
      AND v_row.impressions = 4,
    format('5: impressions_decayed == raw == 4 pre-decay (got %s/%s)',
           v_row.impressions_decayed, v_row.impressions));
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
