-- 20260525000011 — handshakes: RPC-only read (close raw auth-uuid exposure)
--
-- Red-team finding (2026-05-25): handshakes had `GRANT SELECT TO anon,
-- authenticated` + an RLS `USING (true)` policy, so a direct PostgREST query
-- (`GET /rest/v1/handshakes`) returned follower_id/followee_id — which are
-- auth.users.id UUIDs — plus the entire follow graph, bypassing the list RPCs
-- that deliberately project ONLY the public handle. That contradicts the
-- codebase's "never expose auth.users.id to clients" rule (the reason public_id
-- exists and public_profiles drops id/public_id).
--
-- Fix: lock the table to RPC-only. The SECURITY DEFINER read fns
-- (list_handshakers / list_handshaked / viewer_handshake_state) run as the table
-- owner, so they are UNAFFECTED — public follower lists keep working, by handle,
-- with no UUID leak. Writes were already RPC-only. After this the table is RLS
-- ENABLED + ZERO client policies (the service-role-only pattern).
DROP POLICY IF EXISTS "handshakes public read" ON public.handshakes;
REVOKE SELECT ON public.handshakes FROM anon, authenticated;
