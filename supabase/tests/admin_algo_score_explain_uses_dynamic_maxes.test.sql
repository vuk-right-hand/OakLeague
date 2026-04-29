-- score_explain uses dynamic max for normalization (not hardcoded 5.0).
-- A user with topic affinity at 8.0 → S_topic uses 8.0 ceiling → S_topic
-- < 1.0 with same raw input that would saturate at 1.0 with 5.0 ceiling.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-dm-admin@test');
  v_user  uuid := tests.create_auth_user('algo-dm-user@test');
  v_creat uuid := tests.create_auth_user('algo-dm-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_resp jsonb;
  v_s_topic real;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-dm-admin@test', 'superadmin');

  UPDATE public.profiles SET feed_regime = 'C' WHERE id = v_user;
  -- Two topics: matched topic at 4.0; an unrelated topic at 8.0 sets the
  -- dynamic max ceiling.
  INSERT INTO public.user_topic_affinity (user_id, topic_slug, affinity_score)
    VALUES (v_user, 'cold_outreach', 4.0),
           (v_user, 'other_topic',   8.0);

  UPDATE public.profiles SET handle = 'dmc' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat, 'C', 'dmc', 'ready', now()) RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready') RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_dm', 30, ARRAY['cold_outreach'], 'ready', now())
    RETURNING id INTO v_hook_id;

  UPDATE public.videos SET published_at = now() WHERE published_at IS NULL;
  PERFORM tests.set_authenticated(v_admin);
  v_resp := public.admin_algo_score_explain(v_user, v_hook_id, gen_random_uuid());
  v_s_topic := (v_resp->'breakdown'->'components'->>'S_topic')::real;

  -- With v_topic_max = 8.0, raw_topic_sum / 1 = 4.0, clamped to [-0.5, 1.0]
  -- → 1.0, divided by 8.0 = 0.125. With hardcoded 5.0, would be 0.2.
  RETURN NEXT ok(
    v_s_topic < 0.2,
    format('1: dynamic max (8.0) yields S_topic %s < 0.2 (would be 0.2 with 5.0 ceiling)',
           round(v_s_topic::numeric, 4)::text)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
