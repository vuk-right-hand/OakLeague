-- _creator_brain_compile_unsafe REVOKE'd from public/authenticated/anon,
-- GRANT'd to service_role only. Asserts via has_function_privilege rather
-- than SET ROLE (server crashes on SET ROLE inside pgTAP function body —
-- see algo_retention_purge_functions_grant_matrix.test.sql).
BEGIN;
SELECT plan(5);

-- Negative: anon, authenticated do NOT have EXECUTE.
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = '_creator_brain_compile_unsafe'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0,
  '1: anon has no EXECUTE on _creator_brain_compile_unsafe'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = '_creator_brain_compile_unsafe'
      AND has_function_privilege('authenticated', oid, 'EXECUTE')),
  0,
  '2: authenticated has no EXECUTE on _creator_brain_compile_unsafe'
);

-- Positive: service_role HAS EXECUTE (backfill DO-block + edge functions).
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = '_creator_brain_compile_unsafe'
      AND has_function_privilege('service_role', oid, 'EXECUTE')),
  1,
  '3: service_role HAS EXECUTE on _creator_brain_compile_unsafe (R2 audit M2)'
);

-- creator_brain_compile public wrapper: authenticated has EXECUTE; anon does not.
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'creator_brain_compile'
      AND has_function_privilege('authenticated', oid, 'EXECUTE')),
  1,
  '4: authenticated HAS EXECUTE on creator_brain_compile (body asserts auth)'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'creator_brain_compile'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0,
  '5: anon has no EXECUTE on creator_brain_compile'
);

SELECT * FROM finish();
ROLLBACK;
