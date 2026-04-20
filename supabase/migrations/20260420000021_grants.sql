-- 0021 — exhaustive grants / revokes
-- Belt-and-braces on top of RLS. Every service-role-only table explicitly
-- drops authenticated/anon write + read paths. R4-S2: service_role can no
-- longer DELETE admin_roles. R5-S3: service_role can no longer directly
-- write handles_registry (SECURITY DEFINER sync triggers still work
-- because their owner = postgres).

-- admin_roles -------------------------------------------------------------
REVOKE ALL                ON public.admin_roles FROM PUBLIC, authenticated, anon;
REVOKE DELETE             ON public.admin_roles FROM service_role;
-- service_role retains SELECT/INSERT/UPDATE for admin console.

-- handles_registry --------------------------------------------------------
REVOKE ALL                                  ON public.handles_registry FROM PUBLIC, authenticated, anon;
REVOKE DELETE, UPDATE, INSERT               ON public.handles_registry FROM service_role;
-- service_role retains SELECT only; all writes must flow through the
-- profiles_handle_sync / creators_handle_sync SECURITY DEFINER triggers.

-- reserved_handles --------------------------------------------------------
REVOKE ALL                ON public.reserved_handles FROM PUBLIC, authenticated, anon;

-- creator_invitations -----------------------------------------------------
REVOKE ALL                ON public.creator_invitations FROM PUBLIC, authenticated, anon;

-- auth_pending_verifications ---------------------------------------------
REVOKE ALL                ON public.auth_pending_verifications FROM PUBLIC, authenticated, anon;

-- waitlist: anon/authenticated need INSERT only (RLS narrows).
REVOKE ALL                ON public.waitlist FROM PUBLIC;
GRANT  INSERT             ON public.waitlist TO anon, authenticated;

-- cogs_log ---------------------------------------------------------------
REVOKE ALL                ON public.cogs_log FROM PUBLIC, authenticated, anon;
REVOKE TRUNCATE           ON public.cogs_log FROM service_role;

-- daily_quotas / sessions / session_turns --------------------------------
-- Authenticated reads its own via RLS; writes are service-role.
-- No additional grants needed beyond default authenticated SELECT.

-- Reload PostgREST so schema cache picks up the new world. ---------------
NOTIFY pgrst, 'reload schema';
