-- Audit C2 guard: the rollup's INSERT VALUES arm (first event for a hook)
-- must set the decayed columns AND a global_quality derived from the row's
-- OWN values — not literal 0, not a hardcoded numerator (audit M-R2-1).
--   impression-first ⇒ quality = (1+0+0)/(10+1) = 1/11
--   open-first       ⇒ quality = (1+1+0)/(10+0) = 2/10
BEGIN;
SELECT plan(6);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-fid@test');
  v_creator_u uuid := tests.create_auth_user('algo-fid-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_a uuid;
  v_hook_b uuid;
  v_row record;
BEGIN
  UPDATE public.profiles SET handle = 'fidc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'F', 'fidc', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 2, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_fid_a', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_a;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 2, 'mux_pb_fid_b', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_b;

  -- Hook A: impression-first.
  INSERT INTO public.feed_events_raw (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'hook_impression', v_hook_a, gen_random_uuid(), '{}'::jsonb);

  SELECT * INTO v_row FROM public.hook_global_stats WHERE hook_id = v_hook_a;
  RETURN NEXT ok(
    abs(v_row.impressions_decayed - 1.0) < 1e-6 AND v_row.impressions = 1,
    format('1: impression-first — impressions_decayed == raw == 1 (got %s/%s)',
           v_row.impressions_decayed, v_row.impressions));
  RETURN NEXT ok(
    abs(v_row.global_quality - (1.0/11.0)) < 1e-4,
    format('2: impression-first — VALUES-arm quality = 1/11 (got %s)', v_row.global_quality));

  -- Hook A second event: full_video_open → DO UPDATE arm, laplace parity.
  INSERT INTO public.feed_events_raw (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'full_video_open', v_hook_a, gen_random_uuid(),
            jsonb_build_object('source','swipe'));

  SELECT * INTO v_row FROM public.hook_global_stats WHERE hook_id = v_hook_a;
  RETURN NEXT ok(
    abs(v_row.global_quality - (2.0/11.0)) < 1e-4,
    format('3: after impression+open, quality = 2/11 (laplace parity; got %s)',
           v_row.global_quality));
  RETURN NEXT ok(
    abs(v_row.full_opens_decayed - 1.0) < 1e-6 AND v_row.full_opens = 1,
    '4: DO-UPDATE arm tracks full_opens_decayed alongside raw');

  -- Hook B: open-first (no prior impression).
  INSERT INTO public.feed_events_raw (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'full_video_open', v_hook_b, gen_random_uuid(),
            jsonb_build_object('source','swipe'));

  SELECT * INTO v_row FROM public.hook_global_stats WHERE hook_id = v_hook_b;
  RETURN NEXT ok(
    abs(v_row.global_quality - 0.2) < 1e-4,
    format('5: open-first — VALUES-arm quality = (1+1)/(10+0) = 0.2 (got %s)',
           v_row.global_quality));
  RETURN NEXT ok(
    abs(v_row.full_opens_decayed - 1.0) < 1e-6 AND v_row.impressions_decayed = 0,
    '6: open-first — decayed cols mirror raw on the INSERT arm');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
