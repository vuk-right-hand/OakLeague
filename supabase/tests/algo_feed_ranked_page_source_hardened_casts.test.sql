-- Audit C-R2-3: cast-fidelity guard. feed_ranked_page has been re-created
-- three times (0504-05 hardening → 0613-01 weights → 0613-03 pool/diversity);
-- each transcription must keep the hardened _jsonb_real/_jsonb_int cooldown
-- casts. A regression to a naked (payload->>'quartile')::int reintroduces the
-- round-3 C-NEW1 crash (one malformed payload aborts the feed). This test
-- greps the LIVE function source so any future re-creation slip fails CI.
BEGIN;
SELECT plan(4);

SELECT ok(
  pg_get_functiondef('public.feed_ranked_page(int, bigint, uuid[])'::regprocedure)
    LIKE '%_jsonb_real%',
  '1: cooldown completion_pct reads go through _jsonb_real'
);

SELECT ok(
  pg_get_functiondef('public.feed_ranked_page(int, bigint, uuid[])'::regprocedure)
    LIKE '%_jsonb_int%',
  '2: cooldown quartile reads go through _jsonb_int'
);

SELECT ok(
  pg_get_functiondef('public.feed_ranked_page(int, bigint, uuid[])'::regprocedure)
    NOT LIKE '%>>''quartile''%',
  '3: no naked payload->>''quartile'' cast anywhere in the body'
);

SELECT ok(
  pg_get_functiondef('public.feed_ranked_page(int, bigint, uuid[])'::regprocedure)
    NOT LIKE '%>>''completion_pct''%',
  '4: no naked payload->>''completion_pct'' cast anywhere in the body'
);

SELECT * FROM finish();
ROLLBACK;
