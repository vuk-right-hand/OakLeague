-- §9.8 / NC3: feed_ranked_anon_page is NOT granted to anon / authenticated.
-- The API route calls it via supabaseAdmin() only.
BEGIN;
SELECT plan(2);

SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.feed_ranked_anon_page(uuid, int, bigint)', 'EXECUTE'),
  '1: authenticated role cannot EXECUTE feed_ranked_anon_page'
);

SELECT ok(
  NOT has_function_privilege('anon',
    'public.feed_ranked_anon_page(uuid, int, bigint)', 'EXECUTE'),
  '2: anon role cannot EXECUTE feed_ranked_anon_page'
);

SELECT * FROM finish();
ROLLBACK;
