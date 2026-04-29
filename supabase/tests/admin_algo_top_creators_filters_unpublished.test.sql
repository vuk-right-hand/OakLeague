-- top_creators surfaces unpublished creators (forensic visibility) — admin
-- can see "user has affinity to creator who isn't published", with
-- is_published=false flagging the state. Pre-tightening, this filtered
-- unpublished out; post-tightening, the row is returned with the flag.
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin    uuid := tests.create_auth_user('algo-tcu-admin@test');
  v_user     uuid := tests.create_auth_user('algo-tcu-user@test');
  v_creat_p  uuid := tests.create_auth_user('algo-tcu-p@test');
  v_creat_u  uuid := tests.create_auth_user('algo-tcu-u@test');
  v_p_id uuid;
  v_u_id uuid;
  v_count int;
  v_pub_flag boolean;
  v_unpub_flag boolean;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-tcu-admin@test', 'superadmin');

  UPDATE public.profiles SET handle = 'tcup' WHERE id = v_creat_p;
  UPDATE public.profiles SET handle = 'tcuu' WHERE id = v_creat_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat_p, 'TCUP', 'tcup', 'ready', now())
    RETURNING id INTO v_p_id;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creat_u, 'TCUU', 'tcuu', 'training')
    RETURNING id INTO v_u_id;

  INSERT INTO public.user_creator_affinity (user_id, creator_id, affinity_score)
    VALUES (v_user, v_p_id, 1.0),
           (v_user, v_u_id, 5.0);

  PERFORM tests.set_authenticated(v_admin);

  SELECT count(*) INTO v_count FROM public.admin_algo_top_creators(v_user, 5);
  RETURN NEXT is(v_count, 2,
                 '1: forensic mode shows BOTH published and unpublished creators');

  SELECT is_published INTO v_pub_flag
    FROM public.admin_algo_top_creators(v_user, 5)
   WHERE handle = 'tcup';
  RETURN NEXT is(v_pub_flag, true,
                 '2: published creator flagged is_published=true');

  SELECT is_published INTO v_unpub_flag
    FROM public.admin_algo_top_creators(v_user, 5)
   WHERE handle = 'tcuu';
  RETURN NEXT is(v_unpub_flag, false,
                 '3: unpublished creator flagged is_published=false');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
