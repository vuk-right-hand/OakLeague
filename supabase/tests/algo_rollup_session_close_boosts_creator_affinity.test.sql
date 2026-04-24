-- §9.3 / M7: sessions.status → ended with active_seconds=300 boosts
-- user_creator_affinity by 300/600*1.5 = 0.75.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-sc-boost@test');
  v_creator_u uuid := tests.create_auth_user('algo-sc-boost-c@test');
  v_creator_id uuid;
  v_session_id uuid;
  v_aff real;
  v_total_s int;
BEGIN
  UPDATE public.profiles SET handle = 'scboost' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'SC', 'scboost', 'pending')
    RETURNING id INTO v_creator_id;

  INSERT INTO public.sessions
    (user_id, creator_id, model_used, tier_at_session, status, active_seconds)
    VALUES
    (v_user, v_creator_id, 'gemini_3_1_flash_live_preview', 'free', 'active', 300)
    RETURNING id INTO v_session_id;

  UPDATE public.sessions
     SET status = 'ended', active_seconds = 300
   WHERE id = v_session_id;

  SELECT affinity_score, total_session_seconds
    INTO v_aff, v_total_s
    FROM public.user_creator_affinity
   WHERE user_id = v_user AND creator_id = v_creator_id;

  RETURN NEXT ok(
    abs(v_aff - 0.75) < 1e-6,
    format('1: 300s session → affinity_score = 0.75 (got %s)', v_aff)
  );
  RETURN NEXT is(
    v_total_s, 300,
    '2: total_session_seconds updated to 300'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
