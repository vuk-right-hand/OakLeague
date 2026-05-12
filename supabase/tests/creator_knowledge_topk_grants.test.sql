-- pgvector RAG plan M5 — creator_knowledge_topk RPC grants.
--
-- Public, anon, authenticated must NOT have EXECUTE. Only service_role.
-- Application-layer invariant (caller passes verified creator_id) is
-- documented on the function COMMENT, not SQL-enforced.

BEGIN;
SELECT plan(3);

SELECT ok(
  NOT has_function_privilege(
    'public'::regrole,
    'public.creator_knowledge_topk(uuid, halfvec, integer, numeric)',
    'EXECUTE'
  ),
  '1: public has no EXECUTE on creator_knowledge_topk'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated'::regrole,
    'public.creator_knowledge_topk(uuid, halfvec, integer, numeric)',
    'EXECUTE'
  ),
  '2: authenticated has no EXECUTE on creator_knowledge_topk'
);

SELECT ok(
  has_function_privilege(
    'service_role'::regrole,
    'public.creator_knowledge_topk(uuid, halfvec, integer, numeric)',
    'EXECUTE'
  ),
  '3: service_role has EXECUTE on creator_knowledge_topk'
);

SELECT * FROM finish();
ROLLBACK;
