-- HUME_TTS_PLAN unit-wide audit M6 fix (2026-05-13) — voice_delete_queue
-- dead-row GC.
--
-- After 10 failed attempts, voice_delete_queue_claim_v2 stops claiming
-- the row (its WHERE clause filters attempts < 10). The row sits orphan
-- forever. Over time:
--   * Cartesia keys that legitimately rejected DELETE (Cartesia outage,
--     auth rotated mid-window) accumulate
--   * Hume keys where the voice was renamed in app.hume.ai/voices between
--     enqueue and dispatch (Round-3 M7 fix flagged this) accumulate
--   * voice_delete_queue grows monotonically; claim queries scan more
--     dead rows than live rows
--
-- Cleanup policy: rows with attempts >= 10 AND updated_at older than 30
-- days get deleted. The 30-day grace gives ops time to investigate
-- before the row disappears from operational visibility.
--
-- Schedule: pg_cron runs daily at 03:17 UTC (off-hour). Job name carries
-- the migration filename so a future re-run is idempotent.
--
-- Safe to re-apply: the unschedule + reschedule pattern.

CREATE OR REPLACE FUNCTION public.voice_delete_queue_purge_dead()
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_deleted  bigint;
BEGIN
  -- §5 audit C1 fix (2026-05-13): pg_cron invokes scheduled jobs as the
  -- DB owner (`postgres` on Supabase) with NO JWT context. The original
  -- service-role gate would 42501 every nightly run silently. Allow both
  -- service_role (manual ops calls via PostgREST) AND the postgres/
  -- supabase_admin DB roles (cron-job execution context). The cron
  -- schedule itself is the auth boundary — only superusers can install
  -- jobs.
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF current_user NOT IN ('postgres', 'supabase_admin')
     AND v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_delete_queue_purge_dead: service_role or postgres only'
      USING ERRCODE = '42501';
  END IF;

  WITH deleted AS (
    DELETE FROM public.voice_delete_queue
     WHERE attempts >= 10
       AND updated_at < now() - interval '30 days'
    RETURNING tts_provider, voice_id
  )
  SELECT count(*) INTO v_deleted FROM deleted;

  -- Surface the GC count so observability dashboards can see when the
  -- queue is bleeding rows. Zero deletes most days = healthy. Non-zero
  -- = either a Cartesia/Hume outage drained the bypass cap OR a code
  -- bug enqueued garbage. RAISE NOTICE shows up in pg_cron job logs.
  RAISE NOTICE 'voice_delete_queue_purge_dead: % rows purged', v_deleted;
  RETURN v_deleted;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_delete_queue_purge_dead()
  FROM public, anon, authenticated;


-- §5 audit C2 fix (2026-05-13): wrap pg_cron calls in DO/EXCEPTION so a
-- project without the extension doesn't abort the migration. Mirrors the
-- pattern in 20260511000005_voice_tickets_purge_consumed.sql:64-74. The
-- function above stays usable as a manual-trigger RPC even when the
-- extension is unavailable; only the schedule is best-effort.
DO $guard$
BEGIN
  PERFORM cron.unschedule('voice_delete_queue_purge_dead_daily');
EXCEPTION WHEN OTHERS THEN
  -- Job didn't exist on first apply, OR pg_cron extension absent — ignore.
  NULL;
END $guard$;

DO $guard$
BEGIN
  PERFORM cron.schedule(
    'voice_delete_queue_purge_dead_daily',
    '17 3 * * *',
    'SELECT public.voice_delete_queue_purge_dead();'
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'voice_delete_queue_purge_dead_daily: pg_cron extension absent — schedule deferred; queue must be GC''d manually until extension is enabled (RPC public.voice_delete_queue_purge_dead() callable as service_role)';
END $guard$;

COMMENT ON FUNCTION public.voice_delete_queue_purge_dead() IS
  'GC for voice_delete_queue rows that have hit the 10-attempt cutoff AND have been there for 30+ days. Prevents monotonic queue growth. Scheduled daily at 03:17 UTC by pg_cron when extension is enabled; otherwise callable manually as service_role.';

NOTIFY pgrst, 'reload schema';
