-- Audit M2 (round-5 actual invariant test): sessions_creator_affinity_on_close
-- guards on OLD.ended_at IS NOT NULL so a status-only re-UPDATE (e.g. admin
-- rollback, buggy write that regresses status and re-advances it) does not
-- double-fire the boost. The two pre-existing M7 tests don't exercise this
-- because they only UPDATE status once; this test UPDATEs twice and
-- asserts the trigger fires exactly once.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-sc-idem@test');
  v_creator_u uuid := tests.create_auth_user('algo-sc-idem-c@test');
  v_creator_id uuid;
  v_session_id uuid;
  v_aff_after_first real;
  v_aff_after_second real;
BEGIN
  UPDATE public.profiles SET handle = 'scidem' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'SI', 'scidem', 'pending')
    RETURNING id INTO v_creator_id;

  INSERT INTO public.sessions
    (user_id, creator_id, model_used, tier_at_session, status, active_seconds)
    VALUES
    (v_user, v_creator_id, 'gemini_3_1_flash_live_preview', 'free', 'active', 300)
    RETURNING id INTO v_session_id;

  -- First close: should boost by 300/600 * 1.5 = 0.75.
  UPDATE public.sessions
     SET status = 'ended', active_seconds = 300, ended_at = now()
   WHERE id = v_session_id;
  SELECT affinity_score INTO v_aff_after_first
    FROM public.user_creator_affinity
   WHERE user_id = v_user AND creator_id = v_creator_id;
  RETURN NEXT ok(
    abs(v_aff_after_first - 0.75) < 1e-6,
    format('1: first close boosts affinity to 0.75 (got %s)', v_aff_after_first)
  );

  -- Simulate a buggy/admin path that re-writes the status. The M2 guard
  -- (OLD.ended_at IS NOT NULL) must prevent a second boost.
  UPDATE public.sessions
     SET status = 'ended', active_seconds = 300
   WHERE id = v_session_id;
  SELECT affinity_score INTO v_aff_after_second
    FROM public.user_creator_affinity
   WHERE user_id = v_user AND creator_id = v_creator_id;
  RETURN NEXT ok(
    abs(v_aff_after_second - 0.75) < 1e-6,
    format(
      '2: second UPDATE on already-ended session does NOT re-boost (still 0.75, got %s)',
      v_aff_after_second
    )
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
