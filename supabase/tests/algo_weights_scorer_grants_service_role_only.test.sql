-- S-D3-1 regression guard (pre-commit audit C1, 2026-06-12): the 0613-01
-- DROP/CREATE of compute_hook_score (8-arg → 9-arg) must NOT resurrect the
-- authenticated EXECUTE grant that 20260503000011 deliberately revoked — an
-- authenticated caller could probe other users' scoring state via guessed
-- hook/user UUID pairs. The weights loader helper follows the same rule.
-- Privilege checks via has_function_privilege — never SET ROLE + call on a
-- secdef fn (PG17 segfault trap, .claude_learnings 2026-05-22).
BEGIN;
SELECT plan(4);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.compute_hook_score(uuid, uuid, text, text, int, real, real, text[], jsonb)',
    'EXECUTE'),
  '1: authenticated cannot execute compute_hook_score (S-D3-1 preserved across 9-arg re-create)'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.compute_hook_score(uuid, uuid, text, text, int, real, real, text[], jsonb)',
    'EXECUTE'),
  '2: anon cannot execute compute_hook_score'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated', 'public._feed_algo_weights_jsonb()', 'EXECUTE'),
  '3: authenticated cannot execute the weights loader helper'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.compute_hook_score(uuid, uuid, text, text, int, real, real, text[], jsonb)',
    'EXECUTE'),
  '4: service_role can execute compute_hook_score'
);

SELECT * FROM finish();
ROLLBACK;
