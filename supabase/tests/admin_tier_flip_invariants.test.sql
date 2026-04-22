-- admin_set_profile_tier: enforces the four invariants.
--   1. Non-admin caller → 42501 forbidden
--   2. Missing target → P0002 not found
--   3. Active session on target → P0004 has_active_session
--   4. Downgrade after seconds_used > 0 → P0003 downgrade_blocked_until_tomorrow
--   5. Happy path: tier flipped, daily_quotas row updated (preserves seconds_used),
--      audit row written.
BEGIN;
SELECT plan(7);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin  uuid := tests.create_auth_user('tierflip-admin@test');
  v_user   uuid := tests.create_auth_user('tierflip-user@test');
  v_cuid   uuid := tests.create_auth_user('tierflip-creator@test');
  v_other  uuid := tests.create_auth_user('tierflip-other@test');
  v_cid    uuid;
  v_sid    uuid;
  v_qdate  date;
  v_audit_count int;
  v_seconds_after int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'tierflip-admin@test', 'superadmin');

  UPDATE public.profiles SET handle = 'tfc' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'TFC', 'tfc', 'ready', now())
    RETURNING id INTO v_cid;

  -- 1. Non-admin rejected.
  PERFORM tests.set_authenticated(v_other);
  RETURN NEXT throws_like(
    format('SELECT public.admin_set_profile_tier(%L, %L)', v_user, 'premium'),
    '%admin not authorized%',
    '1: non-admin caller rejected'
  );

  -- 2. Missing target → P0002.
  PERFORM tests.set_authenticated(v_admin);
  RETURN NEXT throws_like(
    format('SELECT public.admin_set_profile_tier(%L, %L)', gen_random_uuid(), 'premium'),
    '%not found%',
    '2: missing target rejected (P0002)'
  );

  -- 3. Active session → P0004.
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_user, v_cid, 'gemini_3_1_flash_live_preview', 'free')
    RETURNING id INTO v_sid;

  RETURN NEXT throws_like(
    format('SELECT public.admin_set_profile_tier(%L, %L)', v_user, 'premium'),
    '%has_active_session%',
    '3: active session blocks tier flip (P0004)'
  );

  -- Close session, add 120s used today.
  UPDATE public.sessions SET ended_at = now(), status = 'ended' WHERE id = v_sid;
  v_qdate := (now() AT TIME ZONE 'UTC')::date;
  UPDATE public.daily_quotas SET seconds_used = 120
   WHERE user_id = v_user AND quota_date = v_qdate;

  -- 4. Downgrade blocked with logged seconds.
  UPDATE public.profiles SET tier = 'premium' WHERE id = v_user;
  UPDATE public.daily_quotas SET tier_snapshot = 'premium', daily_limit_s = 3600
   WHERE user_id = v_user AND quota_date = v_qdate;

  RETURN NEXT throws_like(
    format('SELECT public.admin_set_profile_tier(%L, %L)', v_user, 'free'),
    '%downgrade_blocked_until_tomorrow%',
    '4: downgrade blocked after seconds used (P0003)'
  );

  -- 5. Upgrade succeeds, audit row written, seconds_used preserved.
  PERFORM public.admin_set_profile_tier(v_user, 'boardroom');

  RETURN NEXT is(
    (SELECT tier FROM public.profiles WHERE id = v_user),
    'boardroom'::profile_tier,
    '5a: profiles.tier flipped to boardroom'
  );

  SELECT seconds_used INTO v_seconds_after
    FROM public.daily_quotas WHERE user_id = v_user AND quota_date = v_qdate;
  RETURN NEXT is(v_seconds_after, 120, '5b: daily_quotas.seconds_used preserved on flip');

  RETURN NEXT is(
    (SELECT daily_limit_s FROM public.daily_quotas WHERE user_id = v_user AND quota_date = v_qdate),
    14400,
    '5c: daily_quotas.daily_limit_s re-applied to boardroom (14400)'
  );

  SELECT count(*) INTO v_audit_count
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin
     AND action = 'tier_flip'
     AND target_id = v_user;
  RETURN NEXT is(v_audit_count, 1, '5d: admin_audit_log row written');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
