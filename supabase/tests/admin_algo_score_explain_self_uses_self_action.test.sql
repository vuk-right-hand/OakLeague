-- score_explain self-inspection (p_user_id == admin_id) writes
-- action='algo_score_explained_self' to admin_audit_log.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-self-se-admin@test');
  v_creat uuid := tests.create_auth_user('algo-self-se-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_action text;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-self-se-admin@test', 'superadmin');

  UPDATE public.profiles SET feed_regime = 'C' WHERE id = v_admin;

  UPDATE public.profiles SET handle = 'sselfc' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat, 'C', 'sselfc', 'ready', now()) RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_creator_id, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready') RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_self', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_id;

  UPDATE public.videos SET published_at = now() WHERE published_at IS NULL;
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_algo_score_explain(v_admin, v_hook_id, gen_random_uuid());
  PERFORM tests.reset_role();

  SELECT action INTO v_action
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin AND target_id = v_admin
     AND action LIKE 'algo_score_explained%'
   LIMIT 1;

  RETURN NEXT is(v_action, 'algo_score_explained_self', '1: self-inspection uses _self action');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
