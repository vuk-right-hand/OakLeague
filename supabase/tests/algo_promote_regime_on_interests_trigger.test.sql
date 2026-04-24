-- T-D3-7 / C-3: promote_regime_on_interests trigger coverage.
-- 1. UPDATE interest_slugs NULL → non-empty while at regime A → promotes to B.
-- 2. UPDATE interest_slugs empty-array → non-empty while at regime A → promotes to B.
-- 3. UPDATE interest_slugs while at regime C → stays C (monotonic, no downgrade).
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user1  uuid := tests.create_auth_user('algo-tri1@test');
  v_user2  uuid := tests.create_auth_user('algo-tri2@test');
  v_user3  uuid := tests.create_auth_user('algo-tri3@test');
  v_regime feed_regime;
BEGIN
  -- Test 1: NULL interest_slugs → non-empty at regime A → promotes to B.
  UPDATE public.profiles
     SET interest_slugs = ARRAY['cold_outreach']
   WHERE id = v_user1;
  SELECT feed_regime INTO v_regime FROM public.profiles WHERE id = v_user1;
  RETURN NEXT is(
    v_regime, 'B'::feed_regime,
    '1: setting interest_slugs from NULL promotes regime A → B'
  );

  -- Test 2: empty-array interest_slugs → non-empty at regime A → promotes to B.
  -- First set to empty (should not promote, cardinality=0).
  UPDATE public.profiles SET interest_slugs = '{}'::text[] WHERE id = v_user2;
  -- Then set to non-empty.
  UPDATE public.profiles
     SET interest_slugs = ARRAY['build_in_public']
   WHERE id = v_user2;
  SELECT feed_regime INTO v_regime FROM public.profiles WHERE id = v_user2;
  RETURN NEXT is(
    v_regime, 'B'::feed_regime,
    '2: setting interest_slugs from empty array promotes regime A → B'
  );

  -- Test 3: already at regime C → stays C even after interest_slugs update.
  UPDATE public.profiles SET feed_regime = 'C' WHERE id = v_user3;
  UPDATE public.profiles
     SET interest_slugs = ARRAY['cold_outreach']
   WHERE id = v_user3;
  SELECT feed_regime INTO v_regime FROM public.profiles WHERE id = v_user3;
  RETURN NEXT is(
    v_regime, 'C'::feed_regime,
    '3: interest_slugs update on regime C does not downgrade to B'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
