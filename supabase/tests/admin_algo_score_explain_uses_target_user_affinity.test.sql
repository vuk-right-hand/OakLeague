-- Round-1 critical 3: score_explain reads the TARGET user's affinity, not
-- the admin's. Admin A inspects target B with B's seeded topic affinity →
-- S_topic > 0 (would be 0 if admin's empty affinity were used by mistake).
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-tua-admin@test');
  v_user  uuid := tests.create_auth_user('algo-tua-user@test');
  v_creat uuid := tests.create_auth_user('algo-tua-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_resp jsonb;
  v_s_topic real;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-tua-admin@test', 'superadmin');

  -- Target user is regime C with strong affinity on cold_outreach.
  UPDATE public.profiles SET feed_regime = 'C' WHERE id = v_user;
  INSERT INTO public.user_topic_affinity (user_id, topic_slug, affinity_score)
    VALUES (v_user, 'cold_outreach', 4.0);

  UPDATE public.profiles SET handle = 'tuac' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat, 'C', 'tuac', 'ready', now()) RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready') RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_tua', 30, ARRAY['cold_outreach'], 'ready', now())
    RETURNING id INTO v_hook_id;

  UPDATE public.videos SET published_at = now() WHERE published_at IS NULL;
  PERFORM tests.set_authenticated(v_admin);
  v_resp := public.admin_algo_score_explain(v_user, v_hook_id, gen_random_uuid());
  v_s_topic := (v_resp->'breakdown'->'components'->>'S_topic')::real;

  -- If admin's empty affinity were used by mistake, S_topic would be 0.
  -- With target's 4.0 affinity, S_topic should be > 0.
  RETURN NEXT ok(
    v_s_topic > 0,
    format('1: S_topic > 0 (got %s) — target user affinity used, not admin', v_s_topic)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
