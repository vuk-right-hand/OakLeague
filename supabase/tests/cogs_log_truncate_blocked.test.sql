BEGIN;
SELECT plan(3);

SELECT throws_like(
  $$ TRUNCATE TABLE public.cogs_log $$,
  '%append-only%',
  'TRUNCATE cogs_log blocked'
);

INSERT INTO public.cogs_log (service, operation, units, unit_label, cost_usd)
  VALUES ('gemini', 'generate', 100, 'tokens', 0.001);

SELECT throws_like(
  $$ UPDATE public.cogs_log SET cost_usd = 0 $$,
  '%append-only%',
  'UPDATE cogs_log blocked'
);

SELECT throws_like(
  $$ DELETE FROM public.cogs_log $$,
  '%append-only%',
  'DELETE cogs_log blocked'
);

SELECT * FROM finish();
ROLLBACK;
