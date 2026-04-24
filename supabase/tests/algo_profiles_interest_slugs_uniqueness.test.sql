-- Audit S5: profiles.interest_slugs CHECK rejects duplicates. A duplicate
-- would double-weight its signal in the S_cold scorer before the INTERSECT
-- de-dupe at query time (subtle ranking bug).
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-islugs@test');
BEGIN
  -- Unique slugs: accepted.
  UPDATE public.profiles
     SET interest_slugs = ARRAY['cold_outreach','raising_seed']
   WHERE id = v_user;
  RETURN NEXT is(
    (SELECT cardinality(interest_slugs) FROM public.profiles WHERE id = v_user),
    2,
    '1: distinct slugs accepted'
  );

  -- Duplicate slugs: rejected.
  RETURN NEXT throws_like(
    format($q$
      UPDATE public.profiles
         SET interest_slugs = ARRAY['cold_outreach','cold_outreach']
       WHERE id = %L
    $q$, v_user),
    '%check%',
    '2: duplicate slug rejected by CHECK'
  );

  -- Empty array: accepted (regime A fallthrough).
  UPDATE public.profiles SET interest_slugs = '{}'::text[] WHERE id = v_user;
  RETURN NEXT is(
    (SELECT cardinality(interest_slugs) FROM public.profiles WHERE id = v_user),
    0,
    '3: empty array still accepted'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
