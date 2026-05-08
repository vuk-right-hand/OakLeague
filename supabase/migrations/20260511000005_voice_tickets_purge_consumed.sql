-- 20260511000005 — voice_tickets PII retention purge cron
--
-- Brain wire-up M5 (R3 audit M2). voice_tickets.prefix_turns now carries
-- creator sample_content PII (mastermind transcripts, testimonials).
-- Without this purge, consumed AND unconsumed-expired tickets would
-- accumulate forever — the "7-day PII retention" claim in CLAUDE.md and
-- the column COMMENT would be a lie.
--
-- Purge predicate (R3 audit M2):
--   * consumed_at IS NOT NULL AND consumed_at < now() - 7d
--   * OR consumed_at IS NULL AND expires_at < now() - 7d
-- The OR-branch catches abandoned tickets (TTL=120s, browser tab closed,
-- proxy never reached) which were silently leaking PII.
--
-- Implementation (R3 audit small):
--   * Batched DELETE via WHERE id IN (... LIMIT 10000) so a 100K-ticket
--     accumulation doesn't lock voice_tickets for minutes
--   * GET DIAGNOSTICS ROW_COUNT (NO RETURNING-INTO scalar — would raise
--     TOO_MANY_ROWS on 2+ rows; R2 audit C4)
--   * pg_sleep(0.1) between batches to share the lock
--
-- Schedule: daily at 03:17 UTC (off-peak, mirrors rate_limit_log_purge).
--
-- pg_cron unavailable on local Supabase Docker; the DO/EXCEPTION wrapper
-- mirrors 20260425000003 so the migration lands even without pg_cron.

CREATE FUNCTION public.voice_tickets_purge_consumed() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_total int := 0;
  v_batch int;
BEGIN
  LOOP
    DELETE FROM voice_tickets
     WHERE ticket_id IN (
       SELECT ticket_id FROM voice_tickets
        WHERE (consumed_at IS NOT NULL AND consumed_at < now() - interval '7 days')
           OR (consumed_at IS NULL     AND expires_at  < now() - interval '7 days')
        LIMIT 10000
     );
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
    -- PR-2 audit S4: explicit zero-row exit so the loop terminates
    -- promptly when the table is fully drained, not on the next batch
    -- drop-below-10000.
    EXIT WHEN v_batch = 0;
    EXIT WHEN v_batch < 10000;
    PERFORM pg_sleep(0.1);
  END LOOP;
  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_tickets_purge_consumed() FROM public;

-- Unschedule any prior registration (idempotent re-run).
DO $guard$
BEGIN
  PERFORM cron.unschedule('voice_tickets_purge_consumed_daily');
EXCEPTION WHEN OTHERS THEN NULL;
END;
$guard$;

DO $guard$
BEGIN
  PERFORM cron.schedule(
    'voice_tickets_purge_consumed_daily',
    '17 3 * * *',
    $job$ SELECT public.voice_tickets_purge_consumed(); $job$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available; voice_tickets_purge_consumed_daily not scheduled. Enable pg_cron in Supabase → Database → Extensions and re-run this migration.';
END;
$guard$;
