BEGIN;
SELECT plan(1);

SELECT is(
  (SELECT count(*)::int FROM public.reserved_handles WHERE handle = 'vuk'),
  0,
  'vuk is not a reserved handle — creator #1 goes through the real flow'
);

SELECT * FROM finish();
ROLLBACK;
