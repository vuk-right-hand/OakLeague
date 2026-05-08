-- Audit C1 regression test (2026-05-10 unification).
--
-- The latch trigger must NOT fire when daily_limit_s is lowered while
-- seconds_used stays flat — that would retro-latch users whose usage was
-- under the old cap's 150% but is over the new cap's 150%. The 150% latch
-- represents "user accumulated 150% of their cap during a day" (an
-- abuse/runaway signal anchored to USAGE), not a cap-change reaction.
--
-- Setup mirrors a free user pre-migration:
--   daily_limit_s = 600 (old hardcoded free)
--   seconds_used  = 500   (under old 600*1.5=900 → not latched)
--
-- Then we mirror daily_limit_s down to 300 (new free default) without
-- changing seconds_used. 500 >= 300*1.5=450 → would latch under the OLD
-- predicate. Must NOT latch under the new predicate.
--
-- Then we increment seconds_used by 1 to verify the latch DOES fire when
-- usage actually grows past the new threshold (graceful denial works).
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('latch-no-retro@test');
  v_qdate date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  -- Pre-migration shape: free user with 500s used out of 600s cap (not
  -- latched). The cap value (600) here is a synthetic ghost — what's
  -- being tested is the trigger's behavior on UPDATE, not the cap origin.
  INSERT INTO public.daily_quotas
    (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
  VALUES
    (v_uid, v_qdate, 'free', 600, 500);

  RETURN NEXT ok(
    (SELECT kill_switch_fired_at FROM public.daily_quotas
       WHERE user_id = v_uid AND quota_date = v_qdate) IS NULL,
    'baseline: not latched at 500s of 600s cap (under 150%)'
  );

  -- The migration's daily_quotas backfill mirrors daily_limit_s down to
  -- the user's profile cap (300, which is the new free default). This
  -- UPDATE simulates that mirror without touching seconds_used.
  UPDATE public.daily_quotas
     SET daily_limit_s = 300
   WHERE user_id = v_uid AND quota_date = v_qdate;

  RETURN NEXT ok(
    (SELECT kill_switch_fired_at FROM public.daily_quotas
       WHERE user_id = v_uid AND quota_date = v_qdate) IS NULL,
    'C1 invariant: cap mirror downward does NOT retro-latch (seconds_used unchanged)'
  );

  -- Graceful denial: the next turn that actually adds usage past 150% of
  -- the new cap latches as expected. seconds_used 500 → 501 crosses the
  -- new 450 threshold (already past it) but is the FIRST UPDATE that
  -- changes seconds_used post-mirror — latch must fire here.
  UPDATE public.daily_quotas
     SET seconds_used = 501
   WHERE user_id = v_uid AND quota_date = v_qdate;

  RETURN NEXT ok(
    (SELECT kill_switch_fired_at FROM public.daily_quotas
       WHERE user_id = v_uid AND quota_date = v_qdate) IS NOT NULL,
    'graceful denial: latch fires on first usage-growth UPDATE past new threshold'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
