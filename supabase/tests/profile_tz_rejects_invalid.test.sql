-- R6-C1: profiles.timezone CHECK uses _is_valid_timezone(text).
BEGIN;
SELECT plan(2);

DO $$
DECLARE v uuid;
BEGIN
  v := tests.create_auth_user('tz-test@test');
END $$;

SELECT throws_like(
  $$ UPDATE public.profiles
        SET timezone = 'Mars/Phobos'
      WHERE id = (SELECT id FROM auth.users WHERE email = 'tz-test@test') $$,
  '%check%',
  'invalid tz rejected'
);

SELECT lives_ok(
  $$ UPDATE public.profiles
        SET timezone = 'America/Los_Angeles'
      WHERE id = (SELECT id FROM auth.users WHERE email = 'tz-test@test') $$,
  'valid IANA tz accepted'
);

SELECT * FROM finish();
ROLLBACK;
