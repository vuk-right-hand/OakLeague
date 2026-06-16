-- voice_fuse_anchor_apply: GREATEST-only raise of today's 150%-fuse anchor
-- (daily_quotas.daily_limit_s) to the session's real entitlement — never lowers,
-- never retro-latches (seconds_used untouched), skips already-latched rows.
-- Growth & Minutes Economy Phase 1 (migration 20260615000002, R2-C1).
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid   uuid := tests.create_auth_user('fuse@test');
  v_qdate date;
  v_limit int;
  v_kill  timestamptz;
BEGIN
  UPDATE public.profiles SET timezone = 'UTC' WHERE id = v_uid;
  v_qdate := (now() AT TIME ZONE 'UTC')::date;
  -- Base free anchor at 300 with some usage well under 150% (no latch).
  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
  VALUES (v_uid, v_qdate, 'free', 300, 100);

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 1) Raise to 1500 (entitlement = base + wallet).
  PERFORM public.voice_fuse_anchor_apply(v_uid, 1500);
  SELECT daily_limit_s INTO v_limit FROM public.daily_quotas WHERE user_id = v_uid AND quota_date = v_qdate;
  RETURN NEXT is(v_limit, 1500, '1: anchor raises daily_limit_s 300 -> 1500');

  -- 2) A lower anchor never lowers it (GREATEST).
  PERFORM public.voice_fuse_anchor_apply(v_uid, 500);
  SELECT daily_limit_s INTO v_limit FROM public.daily_quotas WHERE user_id = v_uid AND quota_date = v_qdate;
  RETURN NEXT is(v_limit, 1500, '2: a lower anchor (500) does not lower daily_limit_s');

  -- 3) Raising the limit did not retro-latch (seconds_used untouched).
  SELECT kill_switch_fired_at INTO v_kill FROM public.daily_quotas WHERE user_id = v_uid AND quota_date = v_qdate;
  RETURN NEXT ok(v_kill IS NULL, '3: raising the anchor did not retro-latch the kill switch');

  -- 4) An already-latched row is skipped (anchor must not resurrect a latched quota).
  UPDATE public.daily_quotas SET kill_switch_fired_at = now()
    WHERE user_id = v_uid AND quota_date = v_qdate;
  PERFORM public.voice_fuse_anchor_apply(v_uid, 3000);
  SELECT daily_limit_s INTO v_limit FROM public.daily_quotas WHERE user_id = v_uid AND quota_date = v_qdate;
  RETURN NEXT is(v_limit, 1500, '4: latched row is skipped (daily_limit_s unchanged)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
