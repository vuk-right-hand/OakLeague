-- §9.4 / M8: consecutive same-creator impressions trailing the feed penalize
-- new hooks from that creator. Helper _consecutive_streak_from_tail counts
-- the leading run in a reverse-chronological impression list; scorer maps
-- streak {0,1}→0.0, {2}→0.2, {>=3}→0.8.
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-streak@test');
  v_creator_u uuid := tests.create_auth_user('algo-streak-c@test');
  v_creator_id uuid;
  v_other_creator_u uuid := tests.create_auth_user('algo-streak-other@test');
  v_other_creator_id uuid;
  v_score int;
BEGIN
  UPDATE public.profiles SET handle = 'streakc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'ST', 'streakc', 'ready', now())
    RETURNING id INTO v_creator_id;

  UPDATE public.profiles SET handle = 'streakother' WHERE id = v_other_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_other_creator_u, 'OT', 'streakother', 'ready', now())
    RETURNING id INTO v_other_creator_id;

  -- Streak 0 (no trailing matches).
  RETURN NEXT is(
    public._consecutive_streak_from_tail(
      ARRAY[v_other_creator_id, v_other_creator_id, v_other_creator_id]::uuid[],
      v_creator_id),
    0,
    '1: no trailing match → streak = 0'
  );

  -- Streak 2 (two leading matches, then break).
  RETURN NEXT is(
    public._consecutive_streak_from_tail(
      ARRAY[v_creator_id, v_creator_id, v_other_creator_id, v_creator_id]::uuid[],
      v_creator_id),
    2,
    '2: first 2 elements match target → streak = 2'
  );

  -- Streak resets on the first different creator (M8 invariant).
  RETURN NEXT is(
    public._consecutive_streak_from_tail(
      ARRAY[v_other_creator_id, v_creator_id, v_creator_id, v_creator_id]::uuid[],
      v_creator_id),
    0,
    '3: first element different → streak = 0 (resets)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
