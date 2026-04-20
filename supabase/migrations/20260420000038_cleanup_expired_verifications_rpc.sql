-- 0038 — daily cleanup for stale auth_pending_verifications (R2-M-β, R4-M6,
-- R5-S10).
-- Called from Vercel Cron (daily 03:00 UTC). Uses a transaction-scoped
-- advisory lock — `pg_try_advisory_xact_lock`, NOT `pg_try_advisory_lock`:
-- session-scoped locks leak across PgBouncer transaction-pool connections
-- and can be inherited by unrelated requests that reuse the same backend.
-- Txn-scoped locks release at COMMIT and are pool-safe.

CREATE FUNCTION public.cleanup_expired_verifications()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_deleted int;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('cleanup_pending_verifications')) THEN
    RETURN 0;
  END IF;

  DELETE FROM public.auth_pending_verifications
   WHERE expires_at < now() - interval '7 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  DELETE FROM public.rate_limit_log
   WHERE window_start < now() - interval '7 days';

  RETURN v_deleted;
END;$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_expired_verifications() FROM public;
-- Cron hits via service-role client, which bypasses REVOKE anyway; no GRANT
-- to authenticated.
