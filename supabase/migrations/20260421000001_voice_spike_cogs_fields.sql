-- 0040 — Spike A voice foundation: concurrency index, heartbeat, tickets, environment tag
--
-- Phase 0 placeholder migration (SPIKE_A_V2_PLAN.md Rev 5). Lands the structural
-- pieces BEFORE proxy code so the migration number is locked in git history and
-- later phases don't race for a number (Round 2 M3).
--
-- Scope of this migration:
--   1. sessions: unique partial index (D2 — 1 active session per user)
--   2. sessions: last_heartbeat_at column (ghost-session reaper input)
--   3. voice_tickets: table + RLS (C2 — ticket-in-URL WS auth, cookies don't cross upgrade)
--   4. cogs_log: environment column (default 'production', spike writes 'spike_a')
--   5. reap_stale_sessions() RPC stub (Fly proxy calls on startup + every 60s)
--   6. cogs_insert_turn() RPC stub (two-row atomic insert for per-turn COGS)

-- 1. Concurrency: one active session per user -----------------------------------
-- Enforces D2 at the database boundary. Second concurrent INSERT fails with
-- unique_violation; proxy catches and closes WS with 4001 session_already_active.

CREATE UNIQUE INDEX sessions_one_active_per_user
  ON public.sessions (user_id)
  WHERE ended_at IS NULL;

-- 2. Heartbeat column for ghost-session reaper ----------------------------------

ALTER TABLE public.sessions
  ADD COLUMN last_heartbeat_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX sessions_heartbeat_idx
  ON public.sessions (last_heartbeat_at)
  WHERE ended_at IS NULL;

-- 3. voice_tickets --------------------------------------------------------------
-- Short-lived (30s), single-use, UA-hash-bound tickets. Minted by RSC route
-- under assertAdminFromSession(); atomically consumed by Fly proxy on WS upgrade.
-- UA-hash (not IP) — mobile carrier NAT churns IPs mid-session.

CREATE TABLE public.voice_tickets (
  ticket_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bound_ua_hash  text        NOT NULL CHECK (char_length(bound_ua_hash) BETWEEN 32 AND 128),
  expires_at     timestamptz NOT NULL DEFAULT (now() + interval '30 seconds'),
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX voice_tickets_expires_idx
  ON public.voice_tickets (expires_at)
  WHERE consumed_at IS NULL;

-- CLAUDE.md hard rule: RLS on every table. Service-role-only = enabled, zero policies.
ALTER TABLE public.voice_tickets ENABLE ROW LEVEL SECURITY;
-- (intentionally no policies — only Fly proxy's service-role key reads/writes)

-- 4. cogs_log.environment -------------------------------------------------------
-- Partition spike noise from production metrics. Default 'production' so existing
-- rows + future prod writes don't need touch-up.

ALTER TABLE public.cogs_log
  ADD COLUMN environment text NOT NULL DEFAULT 'production'
    CHECK (environment IN ('production', 'spike_a', 'spike_b', 'dev'));

CREATE INDEX cogs_log_environment_idx
  ON public.cogs_log (environment, created_at DESC)
  WHERE environment <> 'production';

-- Extend append-only trigger to cover the new column. The existing trigger
-- permits FK-cascade SET NULL on user_id / session_id but blocks all other
-- updates. environment is business data — same rule applies.

CREATE OR REPLACE FUNCTION public.cogs_log_block_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id          = OLD.id
 AND NEW.created_at  = OLD.created_at
 AND NEW.service     = OLD.service
 AND NEW.operation   = OLD.operation
 AND NEW.units       = OLD.units
 AND NEW.unit_label  = OLD.unit_label
 AND NEW.cost_usd    = OLD.cost_usd
 AND NEW.metadata    IS NOT DISTINCT FROM OLD.metadata
 AND NEW.environment = OLD.environment
 AND (NEW.user_id    IS NOT DISTINCT FROM OLD.user_id    OR NEW.user_id    IS NULL)
 AND (NEW.session_id IS NOT DISTINCT FROM OLD.session_id OR NEW.session_id IS NULL)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'cogs_log is append-only' USING ERRCODE = '42501';
END;$$;

REVOKE EXECUTE ON FUNCTION public.cogs_log_block_update() FROM public;

-- 5. reap_stale_sessions() ------------------------------------------------------
-- Closes sessions whose last_heartbeat_at is older than threshold. Called by
-- Fly proxy on startup + every 60s. SECURITY DEFINER so service role can invoke
-- via RPC without granting broad UPDATE on sessions.
--
-- Default threshold 90s = 3 missed 20s heartbeats + jitter. Tightenable in prod.

CREATE FUNCTION public.reap_stale_sessions(p_threshold_seconds int DEFAULT 90)
RETURNS TABLE (session_id uuid, user_id uuid, age_seconds int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_threshold_seconds < 30 OR p_threshold_seconds > 3600 THEN
    RAISE EXCEPTION 'threshold out of range [30, 3600]' USING ERRCODE = '22003';
  END IF;

  RETURN QUERY
  UPDATE public.sessions s
     SET ended_at    = now(),
         status      = 'ended',
         end_reason  = 'ghost_reaper'
   WHERE s.ended_at IS NULL
     AND s.last_heartbeat_at < now() - make_interval(secs => p_threshold_seconds)
  RETURNING s.id, s.user_id,
            EXTRACT(EPOCH FROM (now() - s.last_heartbeat_at))::int;
END;$$;

REVOKE EXECUTE ON FUNCTION public.reap_stale_sessions(int) FROM public;

-- 6. cogs_insert_turn() ---------------------------------------------------------
-- Atomic two-row insert for per-turn COGS (input-seconds + output-seconds).
-- cogs_log UPDATE is blocked by cogs_log_block_update (migration 0020) — so
-- "reservation-row + finalize" is impossible. Two-insert is the contract.
--
-- Called from Fly proxy at turn_end. Returns both row ids for Sentry span tagging.

CREATE FUNCTION public.cogs_insert_turn(
  p_user_id        uuid,
  p_session_id     uuid,
  p_service        cogs_service,
  p_model          text,
  p_input_seconds  numeric,
  p_output_seconds numeric,
  p_input_cost     numeric,
  p_output_cost    numeric,
  p_environment    text,
  p_metadata       jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (input_row_id bigint, output_row_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_input_id  bigint;
  v_output_id bigint;
BEGIN
  -- NOTE: the caller-identity guard + tightened REVOKEs were added in migration
  -- 0043 (CREATE OR REPLACE). Leaving this body as-originally-applied so the
  -- file mirrors the state the database was created in. Migrations are append-
  -- only; never edit an applied migration in place.

  IF p_environment NOT IN ('production', 'spike_a', 'spike_b', 'dev') THEN
    RAISE EXCEPTION 'invalid environment: %', p_environment USING ERRCODE = '22023';
  END IF;
  IF p_input_seconds < 0 OR p_output_seconds < 0 THEN
    RAISE EXCEPTION 'negative seconds' USING ERRCODE = '22003';
  END IF;
  IF p_input_seconds > 3600 OR p_output_seconds > 3600 THEN
    RAISE EXCEPTION 'seconds exceed per-turn cap (3600)' USING ERRCODE = '22003';
  END IF;

  INSERT INTO public.cogs_log (user_id, session_id, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES (p_user_id, p_session_id, p_service, 'voice_audio_input_seconds',
          p_input_seconds, 'seconds', p_input_cost, p_environment,
          p_metadata || jsonb_build_object('model', p_model, 'direction', 'input'))
  RETURNING id INTO v_input_id;

  INSERT INTO public.cogs_log (user_id, session_id, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES (p_user_id, p_session_id, p_service, 'voice_audio_output_seconds',
          p_output_seconds, 'seconds', p_output_cost, p_environment,
          p_metadata || jsonb_build_object('model', p_model, 'direction', 'output'))
  RETURNING id INTO v_output_id;

  RETURN QUERY SELECT v_input_id, v_output_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.cogs_insert_turn(uuid, uuid, cogs_service, text, numeric, numeric, numeric, numeric, text, jsonb) FROM public;
