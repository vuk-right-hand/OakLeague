-- R4-C1: helper-backed CHECK compiles and enforces per-element cap on text[].
BEGIN;
SELECT plan(3);

SELECT lives_ok(
  $$ SELECT public._all_text_array_elems_within(ARRAY['ok'], 200) $$,
  'helper function exists and is callable'
);

DO $$
DECLARE v uuid;
BEGIN
  v := tests.create_auth_user('goals-ok@test');
  UPDATE public.profiles
     SET goals = ARRAY[repeat('a', 200)]
   WHERE id = v;
END $$;
SELECT pass('goals element with exactly 200 chars accepted');

SELECT throws_like(
  $$ UPDATE public.profiles
        SET goals = ARRAY[repeat('a', 201)]
      WHERE id = (SELECT id FROM auth.users WHERE email = 'goals-ok@test' LIMIT 1) $$,
  '%check%',
  'goals element over 200 chars rejected by CHECK'
);

SELECT * FROM finish();
ROLLBACK;
