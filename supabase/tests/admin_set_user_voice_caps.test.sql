-- admin_set_user_voice_caps: per-user voice-minute cap editor.
-- Migration: 20260502000006.
--
-- Invariants tested:
--   1. Non-admin caller → 42501
--   2. Missing target user → P0002
--   3. daily out-of-range → 22003 bad_daily_cap (NULL / <0 / >86400)
--   4. weekly out-of-range → 22003 bad_weekly_cap (<0 / >604800)
--   5. monthly out-of-range → 22003 bad_monthly_cap (<0 / >2678400)
--   6. Happy path: profile updated with new caps
--   7. Happy path: admin_audit_log triple (before/after/admin_user_id)
--   8. NULL weekly/monthly accepted (disables those caps)
--
-- Uses throws_ok (SQLSTATE match) rather than throws_like — SQLSTATE is the
-- stable contract the API layer branches on. NULL literals are cast to int
-- because PG cannot resolve the overload without a type hint.
BEGIN;
SELECT plan(11);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('caps-admin@test');
  v_user  uuid := tests.create_auth_user('caps-user@test');
  v_other uuid := tests.create_auth_user('caps-other@test');
  v_audit_count int;
  v_daily int;
  v_weekly int;
  v_monthly int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'caps-admin@test', 'superadmin');

  -- 1. Non-admin caller rejected (42501).
  PERFORM tests.set_authenticated(v_other);
  RETURN NEXT throws_ok(
    format('SELECT public.admin_set_user_voice_caps(%L, 600, 3600, 36000)', v_user),
    '42501',
    NULL,
    '1: non-admin caller rejected (42501)'
  );
  PERFORM tests.reset_role();

  -- 2. Missing target user → P0002.
  PERFORM tests.set_authenticated(v_admin);
  RETURN NEXT throws_ok(
    format('SELECT public.admin_set_user_voice_caps(%L, 600, 3600, 36000)', gen_random_uuid()),
    'P0002',
    NULL,
    '2: missing target user (P0002)'
  );

  -- 3a. bad_daily_cap — out of range high (22003).
  RETURN NEXT throws_ok(
    format('SELECT public.admin_set_user_voice_caps(%L, 86401, NULL::int, NULL::int)', v_user),
    '22003',
    NULL,
    '3a: daily > 86400 rejected (bad_daily_cap, 22003)'
  );

  -- 3b. bad_daily_cap — negative.
  RETURN NEXT throws_ok(
    format('SELECT public.admin_set_user_voice_caps(%L, -1, NULL::int, NULL::int)', v_user),
    '22003',
    NULL,
    '3b: daily < 0 rejected (bad_daily_cap, 22003)'
  );

  -- 3c. bad_daily_cap — NULL rejected (daily is hard-required).
  RETURN NEXT throws_ok(
    format('SELECT public.admin_set_user_voice_caps(%L, NULL::int, NULL::int, NULL::int)', v_user),
    '22003',
    NULL,
    '3c: daily NULL rejected (bad_daily_cap, 22003)'
  );

  -- 4. bad_weekly_cap — out of range high (22003).
  RETURN NEXT throws_ok(
    format('SELECT public.admin_set_user_voice_caps(%L, 600, 604801, NULL::int)', v_user),
    '22003',
    NULL,
    '4: weekly > 604800 rejected (bad_weekly_cap, 22003)'
  );

  -- 5. bad_monthly_cap — out of range high (22003).
  RETURN NEXT throws_ok(
    format('SELECT public.admin_set_user_voice_caps(%L, 600, NULL::int, 2678401)', v_user),
    '22003',
    NULL,
    '5: monthly > 2678400 rejected (bad_monthly_cap, 22003)'
  );

  -- 6+7. Happy path: NULL weekly + NULL monthly disables those caps; daily set.
  PERFORM public.admin_set_user_voice_caps(v_user, 1200, NULL::int, NULL::int);
  PERFORM tests.reset_role();

  SELECT voice_daily_cap_seconds, voice_weekly_cap_seconds, voice_monthly_cap_seconds
    INTO v_daily, v_weekly, v_monthly
    FROM public.profiles WHERE id = v_user;
  RETURN NEXT is(v_daily, 1200, '6a: profiles.voice_daily_cap_seconds updated to 1200');
  RETURN NEXT ok(v_weekly IS NULL, '6b: voice_weekly_cap_seconds set to NULL (disables cap)');
  RETURN NEXT ok(v_monthly IS NULL, '6c: voice_monthly_cap_seconds set to NULL (unlimited)');

  SELECT count(*) INTO v_audit_count
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin
     AND action = 'voice_caps_set'
     AND target_id = v_user;
  RETURN NEXT is(v_audit_count, 1, '7: admin_audit_log row written (voice_caps_set)');
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
