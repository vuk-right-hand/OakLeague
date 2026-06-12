-- Live weight edit moves the scorer: doubling W_RECENCY doubles the
-- weighted recency term in the breakdown. Proves compute_hook_score reads
-- the TABLE (via the helper), not baked-in constants. (0613-01)
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-wlv@test');
  v_creator_u uuid := tests.create_auth_user('algo-wlv-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_w_before real;
  v_w_after  real;
BEGIN
  UPDATE public.profiles SET handle = 'wlvc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'WLV', 'wlvc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_pb_wlv', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_hook_id;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- Fresh hook: S_recency ≈ 1.0, so the weighted term ≈ W_RECENCY itself.
  v_w_before := (public.compute_hook_score(
    v_user, v_hook_id, 'exploit', 'C', 0, 5.0, 5.0, '{}'::text[]
  )->'weighted'->>'W_RECENCY x S_recency')::real;

  UPDATE public.feed_algo_weights SET weight_value = 0.6 WHERE weight_key = 'W_RECENCY';

  v_w_after := (public.compute_hook_score(
    v_user, v_hook_id, 'exploit', 'C', 0, 5.0, 5.0, '{}'::text[]
  )->'weighted'->>'W_RECENCY x S_recency')::real;

  RETURN NEXT ok(abs(v_w_before - 0.3) < 1e-3,
    format('1: seeded W_RECENCY=0.3 yields weighted recency ≈ 0.3 (got %s)', v_w_before));
  RETURN NEXT ok(abs(v_w_after - 2 * v_w_before) < 1e-3,
    format('2: doubling W_RECENCY doubles the weighted term (%s → %s)', v_w_before, v_w_after));
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
