-- minute_grants is append-only: UPDATE + TRUNCATE blocked; DELETE only via the
-- profiles ON DELETE CASCADE (user deletion must still succeed).
-- Growth & Minutes Economy Phase 1 (migration 20260615000001).
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('append@test');
  v_gid bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  SELECT grant_id INTO v_gid FROM public.minute_grant_insert(
    v_uid, 'signup_bonus', 900, 'signup', 'signup:' || v_uid::text, NULL, NULL);

  -- 1) UPDATE blocked (a granted amount must never silently change)
  RETURN NEXT throws_ok(
    format($q$ UPDATE public.minute_grants SET seconds = 1 WHERE id = %s $q$, v_gid),
    '42501', NULL, '1: UPDATE on minute_grants blocked (append-only)');

  -- 2) TRUNCATE blocked
  RETURN NEXT throws_ok(
    $q$ TRUNCATE public.minute_grants $q$,
    '42501', NULL, '2: TRUNCATE on minute_grants blocked');

  -- 3) DELETE via profiles ON DELETE CASCADE works (no BEFORE DELETE block)
  DELETE FROM public.profiles WHERE id = v_uid;
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.minute_grants WHERE id = v_gid),
    0, '3: grant row cascade-deleted when the profile is deleted');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
