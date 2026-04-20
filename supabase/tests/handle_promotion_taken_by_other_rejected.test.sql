-- R4-M3: another creator holds the handle. Applicant's creator insert raises.
BEGIN;
SELECT plan(1);

-- Setup: v_other promotes 'alice' to creator ownership. v_new has a different
-- profile handle — we're only testing that v_new's creator-INSERT with the
-- taken handle conflicts on the registry.
DO $$
DECLARE
  v_other uuid := tests.create_auth_user('other-alice@test');
  v_new   uuid := tests.create_auth_user('new-alice@test');
BEGIN
  UPDATE public.profiles SET handle = 'other_a' WHERE id = v_other;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_other, 'OA', 'alice', 'pending');

  UPDATE public.profiles SET handle = 'new_a' WHERE id = v_new;
END $$;

-- v_new tries to create a creator with the already-taken 'alice' handle.
SELECT throws_like(
  $$ INSERT INTO public.creators (user_id, display_name, handle, brain_status)
     VALUES ((SELECT id FROM auth.users WHERE email = 'new-alice@test'),
             'NA', 'alice', 'pending') $$,
  '%duplicate%',
  'second creator claiming taken handle raises UNIQUE violation'
);

SELECT * FROM finish();
ROLLBACK;
