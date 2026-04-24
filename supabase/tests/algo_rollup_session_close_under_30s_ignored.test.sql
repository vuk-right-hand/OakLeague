-- §9.3 / M7: sessions closed with active_seconds < 30 are noise (a user
-- tapped mic, changed their mind). No affinity boost.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-sc-short@test');
  v_creator_u uuid := tests.create_auth_user('algo-sc-short-c@test');
  v_creator_id uuid;
  v_session_id uuid;
BEGIN
  UPDATE public.profiles SET handle = 'scshort' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'SS', 'scshort', 'pending')
    RETURNING id INTO v_creator_id;

  INSERT INTO public.sessions
    (user_id, creator_id, model_used, tier_at_session, status, active_seconds)
    VALUES
    (v_user, v_creator_id, 'gemini_3_1_flash_live_preview', 'free', 'active', 20)
    RETURNING id INTO v_session_id;

  -- Match prod session-close pattern (sets ended_at alongside status).
  UPDATE public.sessions
     SET status = 'ended', active_seconds = 20, ended_at = now()
   WHERE id = v_session_id;

  RETURN NEXT is(
    (SELECT count(*)::int FROM public.user_creator_affinity
      WHERE user_id = v_user AND creator_id = v_creator_id),
    0,
    '1: <30s session produces no creator affinity row'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
