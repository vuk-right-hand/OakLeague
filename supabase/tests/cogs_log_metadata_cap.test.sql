-- R4-S3: metadata JSONB capped at 4096 octets.
BEGIN;
SELECT plan(1);

SELECT throws_like(
  $$ INSERT INTO public.cogs_log (service, operation, units, unit_label, cost_usd, metadata)
     VALUES ('gemini', 'x', 1, 'u', 0,
             jsonb_build_object('blob', repeat('a', 5000))) $$,
  '%check%',
  'metadata over 4096 octets rejected'
);

SELECT * FROM finish();
ROLLBACK;
