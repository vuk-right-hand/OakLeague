-- score_explain returns envelope with breakdown + narrative + score_total.
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-se-rb-admin@test');
  v_user  uuid := tests.create_auth_user('algo-se-rb-user@test');
  v_creat uuid := tests.create_auth_user('algo-se-rb-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_resp jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-se-rb-admin@test', 'superadmin');

  UPDATE public.profiles SET handle = 'serbc' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat, 'C', 'serbc', 'ready', now()) RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready') RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_serb', 30, ARRAY['cold_outreach'], 'ready', now())
    RETURNING id INTO v_hook_id;

  UPDATE public.videos SET published_at = now() WHERE published_at IS NULL;
  PERFORM tests.set_authenticated(v_admin);
  v_resp := public.admin_algo_score_explain(v_user, v_hook_id, gen_random_uuid());

  RETURN NEXT ok(v_resp ? 'breakdown', '1: envelope contains breakdown');
  RETURN NEXT ok(v_resp ? 'narrative', '2: envelope contains narrative');
  RETURN NEXT ok(
    (v_resp->'breakdown'->>'score_total')::real IS NOT NULL,
    '3: score_total is non-null real'
  );
  RETURN NEXT ok(
    char_length(v_resp->>'narrative') > 0,
    '4: narrative is non-empty'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
