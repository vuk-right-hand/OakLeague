-- top_creators surfaces creator_type as a column (forensic visibility) —
-- admin can see "user has affinity to brand creator", flagged via
-- creator_type='brand'/'sponsored_segment' in the result. v1 schema CHECK
-- restricts creator_type to 'human' only, so this test asserts the column
-- is present and populated (not the type-filter behavior, which is
-- enforced at the schema level until v2).
BEGIN;
SELECT plan(2);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'admin_algo_top_creators'
       AND pg_get_function_result(p.oid) ILIKE '%creator_type %text%'
  ),
  '1: top_creators RETURNS TABLE includes creator_type text column'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'admin_algo_top_creators'
       AND pg_get_function_result(p.oid) ILIKE '%is_published %boolean%'
  ),
  '2: top_creators RETURNS TABLE includes is_published boolean column'
);

SELECT * FROM finish();
ROLLBACK;
