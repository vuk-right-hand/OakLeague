-- T-D3-7 / C-3: promote_regime_on_interests trigger coverage.
-- 1. UPDATE interest_slugs empty → non-empty at regime A → promotes to B.
-- 2. UPDATE interest_slugs empty-array → non-empty at regime A → promotes to B.
-- 3. UPDATE interest_slugs while at regime C → stays C (M-A2: OLD.feed_regime guard).
-- 4. INSERT path: profile inserted with interest_slugs pre-populated → promotes to B.
-- 5. No-op UPDATE: same interest_slugs value → WHEN guard prevents firing → stays B.
-- 6. Shrink: interest_slugs non-empty → empty at regime B → stays B (monotonic).
BEGIN;
SELECT plan(6);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user1  uuid := tests.create_auth_user('algo-tri1@test');
  v_user2  uuid := tests.create_auth_user('algo-tri2@test');
  v_user3  uuid := tests.create_auth_user('algo-tri3@test');
  v_user4  uuid := tests.create_auth_user('algo-tri4@test');
  v_user5  uuid := tests.create_auth_user('algo-tri5@test');
  v_user6  uuid := tests.create_auth_user('algo-tri6@test');
  v_regime feed_regime;
BEGIN
  -- Test 1: interest_slugs '{}' (default) → non-empty at regime A → promotes to B.
  UPDATE public.profiles
     SET interest_slugs = ARRAY['cold_outreach']
   WHERE id = v_user1;
  SELECT feed_regime INTO v_regime FROM public.profiles WHERE id = v_user1;
  RETURN NEXT is(
    v_regime, 'B'::feed_regime,
    '1: setting interest_slugs from empty default promotes regime A → B'
  );

  -- Test 2: explicit empty-array → non-empty at regime A → promotes to B.
  UPDATE public.profiles SET interest_slugs = '{}'::text[] WHERE id = v_user2;
  UPDATE public.profiles
     SET interest_slugs = ARRAY['build_in_public']
   WHERE id = v_user2;
  SELECT feed_regime INTO v_regime FROM public.profiles WHERE id = v_user2;
  RETURN NEXT is(
    v_regime, 'B'::feed_regime,
    '2: setting interest_slugs from empty array promotes regime A → B'
  );

  -- Test 3: already at regime C → stays C (M-A2: OLD.feed_regime = 'C' blocks promotion).
  -- This is the co-write downgrade attack: user sets feed_regime='A' and interest_slugs
  -- simultaneously. The trigger sees OLD.feed_regime='C' and rejects the promotion.
  UPDATE public.profiles SET feed_regime = 'C' WHERE id = v_user3;
  UPDATE public.profiles
     SET interest_slugs = ARRAY['cold_outreach']
   WHERE id = v_user3;
  SELECT feed_regime INTO v_regime FROM public.profiles WHERE id = v_user3;
  RETURN NEXT is(
    v_regime, 'C'::feed_regime,
    '3: interest_slugs update on regime C does not downgrade to B (OLD.feed_regime guard)'
  );

  -- Test 4: INSERT trigger path — profile inserted with interest_slugs pre-populated.
  -- create_auth_user auto-creates a profiles row (empty interest_slugs). Delete it and
  -- re-insert with interest_slugs already set to exercise the INSERT trigger branch.
  DELETE FROM public.profiles WHERE id = v_user4;
  INSERT INTO public.profiles (id, interest_slugs)
    VALUES (v_user4, ARRAY['cold_outreach']);
  SELECT feed_regime INTO v_regime FROM public.profiles WHERE id = v_user4;
  RETURN NEXT is(
    v_regime, 'B'::feed_regime,
    '4: INSERT with non-empty interest_slugs triggers INSERT path → promotes A → B'
  );

  -- Test 5: no-op UPDATE — WHEN guard (IS DISTINCT FROM) prevents the function firing.
  -- First promote to B by setting interest_slugs.
  UPDATE public.profiles SET interest_slugs = ARRAY['cold_outreach'] WHERE id = v_user5;
  -- Re-set to the same value; WHEN guard returns FALSE, trigger does not fire.
  UPDATE public.profiles SET interest_slugs = ARRAY['cold_outreach'] WHERE id = v_user5;
  SELECT feed_regime INTO v_regime FROM public.profiles WHERE id = v_user5;
  RETURN NEXT is(
    v_regime, 'B'::feed_regime,
    '5: no-op UPDATE (same interest_slugs) leaves regime unchanged at B'
  );

  -- Test 6: shrink — interest_slugs non-empty → empty at regime B → stays B (monotonic).
  UPDATE public.profiles SET interest_slugs = ARRAY['cold_outreach'] WHERE id = v_user6;
  -- Shrink back to empty; trigger fires but function sees feed_regime='B' (not 'A') → no-op.
  UPDATE public.profiles SET interest_slugs = '{}'::text[] WHERE id = v_user6;
  SELECT feed_regime INTO v_regime FROM public.profiles WHERE id = v_user6;
  RETURN NEXT is(
    v_regime, 'B'::feed_regime,
    '6: shrinking interest_slugs to empty at regime B does not downgrade'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
