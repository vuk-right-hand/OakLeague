-- 0054 — reap_stale_sessions: default 60s + internal advisory lock
--
-- Days 8–12 plan REV 5, migration 10 of 11.
-- Two REV 4 changes codified:
--   N2-M4: move the reaper's advisory lock INSIDE the RPC body. Single
--   source of truth. Multi-proxy deployments can safely call the RPC
--   concurrently; only the lock-winner runs the UPDATE. Transaction-scoped
--   lock auto-releases on commit.
--   Phase 8 / N2-M4: default threshold 60s (raised from 90s spike default),
--   6× flush-interval safety margin with the new 10s heartbeat cadence.
--
-- The proxy no longer needs its own caller-side `pg_try_advisory_lock`
-- wrapper (N2-M4 "replace REV 2 wrap"); the RPC handles it.

CREATE OR REPLACE FUNCTION public.reap_stale_sessions(p_threshold_seconds int DEFAULT 60)
RETURNS TABLE (session_id uuid, user_id uuid, age_seconds int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_threshold_seconds < 30 OR p_threshold_seconds > 3600 THEN
    RAISE EXCEPTION 'threshold out of range [30, 3600]' USING ERRCODE = '22003';
  END IF;

  -- Single-lock-per-call, tx-scoped; non-lock-winners early-return empty.
  -- hashtext('voice_reaper') is a stable int — all callers agree on the key.
  IF NOT pg_try_advisory_xact_lock(hashtext('voice_reaper')) THEN
    RETURN;
  END IF;

  -- N3-N1 confirmation: 'ending' is deliberately EXCLUDED. That state is a
  -- transient teardown in flight; racing the cleanup path would double-mark
  -- the row. The reaper only touches 'starting' and 'active' rows.
  --
  -- Audit S4 — mirror note for Phase 1 resume-flow implementers: the resume
  -- path (ticket.resume_from_session_id → new session backed by prior
  -- transcript) must flip the prior row back to status='active' and NULL
  -- ended_at if the product model allows resuming into the SAME row. If
  -- Phase 1 instead spawns a NEW session linked to the prior via
  -- resume_from_session_id (the current design), the prior row stays
  -- 'ended' and this note is a non-issue. Whichever path lands, it must
  -- not leave a session in status='ended' with no ended_at — the reaper's
  -- predicate (`ended_at IS NULL AND status IN ('starting','active')`)
  -- would otherwise never touch it regardless.
  RETURN QUERY
  UPDATE public.sessions s
     SET ended_at    = now(),
         status      = 'ended',
         end_reason  = 'ghost_reaper'
   WHERE s.ended_at IS NULL
     AND s.status   IN ('starting', 'active')
     AND s.last_heartbeat_at < now() - make_interval(secs => p_threshold_seconds)
  RETURNING s.id, s.user_id,
            EXTRACT(EPOCH FROM (now() - s.last_heartbeat_at))::int;
END;$$;

-- Preserve lock-down from 0040 / 0043.
REVOKE EXECUTE ON FUNCTION public.reap_stale_sessions(int)
  FROM public, anon, authenticated;
