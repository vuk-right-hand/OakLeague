-- R4-S3: operation column capped at 64 chars.
BEGIN;
SELECT plan(2);

SELECT lives_ok(
  $$ INSERT INTO public.cogs_log (service, operation, units, unit_label, cost_usd)
     VALUES ('gemini', repeat('x', 64), 1, 'u', 0) $$,
  'exactly 64 chars accepted'
);

SELECT throws_like(
  $$ INSERT INTO public.cogs_log (service, operation, units, unit_label, cost_usd)
     VALUES ('gemini', repeat('x', 65), 1, 'u', 0) $$,
  '%check%',
  '65-char operation rejected'
);

SELECT * FROM finish();
ROLLBACK;
