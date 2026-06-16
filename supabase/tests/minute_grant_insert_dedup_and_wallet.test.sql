-- minute_grant_insert: idempotent dedup, materialised wallet_active_seconds,
-- NULL source_key never deduped, and the v1 guards (non-expiring, seconds range).
-- Growth & Minutes Economy Phase 1 (migration 20260615000001).
BEGIN;
SELECT plan(8);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid    uuid := tests.create_auth_user('grant@test');
  v_r      record;
  v_active bigint;
  v_count  int;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 1) first referral grant succeeds
  SELECT * INTO v_r FROM public.minute_grant_insert(
    v_uid, 'referral_verified', 900, 'referral_token', 'tok_abc', NULL, NULL);
  RETURN NEXT is(v_r.granted, true, '1: first referral grant succeeds');

  -- 2) wallet_active_seconds incremented by the grant (materialised, O(1))
  SELECT wallet_active_seconds INTO v_active FROM public.profiles WHERE id = v_uid;
  RETURN NEXT is(v_active, 900::bigint, '2: wallet_active_seconds += granted seconds');

  -- 3) duplicate (same type+kind+key) is an idempotent dedup no-op
  SELECT * INTO v_r FROM public.minute_grant_insert(
    v_uid, 'referral_verified', 900, 'referral_token', 'tok_abc', NULL, NULL);
  RETURN NEXT is(v_r.granted, false, '3: duplicate grant deduped (granted=false)');
  RETURN NEXT is(v_r.reason, 'duplicate', '3b: dedup reason=duplicate');

  -- 4) the dedup no-op did NOT double-increment the wallet
  SELECT wallet_active_seconds INTO v_active FROM public.profiles WHERE id = v_uid;
  RETURN NEXT is(v_active, 900::bigint, '4: dedup did not double-count wallet');

  -- 5) NULL source_key never dedupes — two admin_adjustment rows both insert (R2-S1)
  PERFORM public.minute_grant_insert(v_uid, 'admin_adjustment', 60, 'admin', NULL, NULL, NULL);
  PERFORM public.minute_grant_insert(v_uid, 'admin_adjustment', 60, 'admin', NULL, NULL, NULL);
  SELECT count(*)::int INTO v_count FROM public.minute_grants
    WHERE user_id = v_uid AND grant_type = 'admin_adjustment';
  RETURN NEXT is(v_count, 2, '5: NULL source_key rows are not deduped');

  -- 6) non-null expires_at rejected (v1 wallet is non-expiring)
  RETURN NEXT throws_ok(
    format($q$ SELECT public.minute_grant_insert(%L,'signup_bonus',900,'signup','signup:x',NULL, now()+interval '1 day') $q$, v_uid),
    '22023', NULL, '6: non-null expires_at rejected (22023)');

  -- 7) seconds <= 0 rejected
  RETURN NEXT throws_ok(
    format($q$ SELECT public.minute_grant_insert(%L,'signup_bonus',0,'signup','signup:y') $q$, v_uid),
    '22003', NULL, '7: seconds <= 0 rejected (22003)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
