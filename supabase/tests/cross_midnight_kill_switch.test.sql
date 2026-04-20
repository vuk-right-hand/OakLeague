-- R4-M1: session starts 23:55 day N (user-local); latched quota for day N;
-- a turn landing on day N+1 still raises (keys on session start day).
--
-- Uses a distant-past date (2024-01-01) so sessions_enforce_tier_and_kill_switch
-- (which checks CURRENT user-local date) doesn't hit the pre-seeded latch.
-- session_turns_guard keys on started_at's user-local date → hits the latch.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('cross-ks@test');
  v_cuid uuid := tests.create_auth_user('creator-cks@test');
  v_cid uuid;
  v_sid uuid;
BEGIN
  UPDATE public.profiles SET timezone = 'UTC' WHERE id = v_uid;
  UPDATE public.profiles SET handle = 'ccks' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'CCKS', 'ccks', 'ready', now())
    RETURNING id INTO v_cid;

  -- pre-latch day N (distant past — won't collide with session-open's
  -- current_date check)
  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
    VALUES (v_uid, '2024-01-01', 'free', 600, 900);

  -- session started at 23:55 day N (2024-01-01)
  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, started_at)
    VALUES (gen_random_uuid(), v_uid, v_cid, 'gemini_3_1_flash_live_preview', 'free',
            '2024-01-01 23:55:00+00')
    RETURNING id INTO v_sid;

  RETURN NEXT throws_like(
    format($$ INSERT INTO public.session_turns (session_id, turn_number, role)
              VALUES ('%s', 1, 'user') $$, v_sid),
    '%kill_switch%',
    'cross-midnight turn still raises — keys on session start day'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
