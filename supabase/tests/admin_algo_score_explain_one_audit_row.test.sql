-- score_explain writes exactly one audit row per call (no INSERT-then-UPDATE
-- doubling, no double-audit from the cut narrative RPC).
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-1ar-admin@test');
  v_user  uuid := tests.create_auth_user('algo-1ar-user@test');
  v_creat uuid := tests.create_auth_user('algo-1ar-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_count int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-1ar-admin@test', 'superadmin');

  UPDATE public.profiles SET handle = '1arc' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat, 'C', '1arc', 'ready', now()) RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_creator_id, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready') RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_1ar', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_id;

  UPDATE public.videos SET published_at = now() WHERE published_at IS NULL;
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_algo_score_explain(v_user, v_hook_id, gen_random_uuid());
  PERFORM tests.reset_role();

  SELECT count(*) INTO v_count
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin AND target_id = v_user
     AND action LIKE 'algo_score_explained%';

  RETURN NEXT is(v_count, 1, '1: exactly one audit row written');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
