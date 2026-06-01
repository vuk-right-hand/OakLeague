-- 20260601000001 — SECURITY HOTFIX (whole-build audit C1/H1): revoke EXECUTE on the
-- v2/v3 retrieval RPCs from `authenticated`.
--
-- ── The hole (live on prod as of the 2026-06-01 v3 migration push) ──────────
-- These functions are SECURITY DEFINER (they bypass RLS on the corpus tables) and
-- TRUST a caller-supplied creator_id (`p_creator_id`), but were granted
-- `EXECUTE ... TO authenticated`. PostgREST exposes the `public` schema, so ANY
-- logged-in user could call them directly with an arbitrary creator_id and read
-- the verbatim source corpus (book/transcript prose, up to 3500 chars/parent) of
-- ANY creator — including unpublished / in-training creators they have no licence
-- to see. Cross-tenant data exfiltration.
--
-- The v1 RPC (creator_knowledge_topk, 20260512000005) is correctly service_role
-- ONLY. v2 (creator_knowledge_topk_v2, 20260521000002) regressed to
-- `+ authenticated`, and the four v3 RPCs copied the regression.
--
-- ── Why this is safe to revoke ──────────────────────────────────────────────
-- Every LEGITIMATE call goes through the service-role admin client
-- (src/lib/voice/retrieve-knowledge.ts) — no JWT-bound/authenticated client ever
-- calls these. creator_v3_ready is additionally called in-DB by
-- admin_set_creator_retrieval_version (SECURITY DEFINER) — an in-DB PERFORM does
-- not depend on the caller's EXECUTE grant. So revoking `authenticated` removes
-- pure, unnecessary attack surface with zero functional impact.
--
-- Idempotent (REVOKE of a non-existent grant is a no-op). No body change.

-- C1 — the five retrieval RPCs that leak verbatim corpus / section ids.
-- NOTE on v2: unlike the v3 funcs (which did `REVOKE ALL FROM public, anon`), the
-- v2 migration never revoked the default PUBLIC grant, so EXECUTE leaks to BOTH
-- anon and authenticated via PUBLIC. Revoke from public + anon + authenticated.
REVOKE EXECUTE ON FUNCTION public.creator_knowledge_topk_v2(uuid, halfvec, tsquery, int, int, float)
  FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._creator_knowledge_topk_v3(uuid, uuid[], halfvec, tsquery, int, int, float, text, float)
  FROM authenticated;
REVOKE EXECUTE ON FUNCTION public._creator_route_sections_v3(uuid, halfvec, text[], int, float, float)
  FROM authenticated;
REVOKE EXECUTE ON FUNCTION public._creator_active_section_ids_v3(uuid, int)
  FROM authenticated;
REVOKE EXECUTE ON FUNCTION public._fetch_active_parents_v3(uuid, uuid[])
  FROM authenticated;

-- H1 — creator_v3_ready leaks per-creator pipeline state for arbitrary creators
-- (boolean oracle). Bare read, no _assert_caller_is_admin; only ever called in-DB
-- (by admin_set_creator_retrieval_version) or via the service-role admin client.
REVOKE EXECUTE ON FUNCTION public.creator_v3_ready(uuid)
  FROM authenticated;
