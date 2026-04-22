-- Day 13–14 plan REV 5, migration 1 of 5.
-- Session metadata + avatar status + pause tracking + reaper extension.
-- Also fixes voice_model_wire_value drift for the 2.5 enum (spike_a hardcoded
-- the -preview-12-2025 suffix; the PG function lagged behind — see
-- .claude_learnings.md 2026-04-21). Parity enforced by
-- tests/model-map-parity.spec.ts against src/lib/voice/model-map.ts.
--
-- Audit refs:
--   R4-C1 — `public.sessions` has no `metadata` column today; rollover writes
--           `metadata->>'prev_session_id'` so this is load-bearing.
--   C2-R1 — `avatar_status` column + transition state table (pending → …).
--   C5-R1 — `paused_seconds_total` for server-computed active_seconds at close.
--   R3-S7 — minted→failed_connect transition distinct from pre-mint failure.
--   R3-S8 — reaper distinguishes mint-never-completed from heartbeat-stale.
--   R2-Small — `session_pauses_one_open_per_session` partial-unique index
--           prevents double-pause races.

-- ── 1. sessions.metadata (R4-C1) ─────────────────────────────────────────
-- Rollover writes prev_session_id + rollover=true marker; 4096-byte cap
-- matches admin_audit_log.before/after jsonb caps. NOT NULL so triggers can
-- safely read `NEW.metadata->>'rollover'` without COALESCE.
ALTER TABLE public.sessions
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(metadata::text) <= 4096);

-- ── 2. sessions.avatar_status ────────────────────────────────────────────
-- Values (R3-S7):
--   'pending'         — seeded on session_open, mint in flight
--   'minted'          — simli /compose/token returned session_token
--   'skipped_tier'    — tier has no avatar provider (none in v1, future)
--   'failed_mint'     — token mint 4xx/5xx or timeout (pre-transport)
--   'failed_connect'  — mint OK, WebRTC/LiveKit handshake later collapsed
--   'not_applicable'  — should not reach production in v1 (safety valve)
-- Legal transitions: pending → {minted, skipped_tier, failed_mint,
-- not_applicable}; minted → failed_connect. Enforced by session_set_avatar_status
-- RPC (migration 2). NULL is disallowed after this column lands.
ALTER TABLE public.sessions
  ADD COLUMN avatar_status text NOT NULL DEFAULT 'pending'
    CHECK (avatar_status IN (
      'pending', 'minted', 'skipped_tier', 'failed_mint',
      'failed_connect', 'not_applicable'
    ));

-- ── 3. sessions.paused_seconds_total (C5-R1) ─────────────────────────────
-- Monotonically increasing per-session total of time spent in a paused
-- window. session_resume adds (now() - paused_at) to this each close.
-- active_seconds at close = LEAST(wall_elapsed - paused_seconds_total,
-- tier_limit_s). Clamp upper bound with active_seconds_sane CHECK below.
ALTER TABLE public.sessions
  ADD COLUMN paused_seconds_total int NOT NULL DEFAULT 0
    CHECK (paused_seconds_total >= 0);

-- 28800s = 8h = 2× boardroom daily cap. Any row hitting this is a bug.
ALTER TABLE public.sessions
  ADD CONSTRAINT active_seconds_sane CHECK (active_seconds <= 28800);

-- ── 4. session_pauses ────────────────────────────────────────────────────
CREATE TABLE public.session_pauses (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid        NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  paused_at   timestamptz NOT NULL DEFAULT now(),
  resumed_at  timestamptz,
  CHECK (resumed_at IS NULL OR resumed_at >= paused_at)
);

CREATE INDEX session_pauses_session_idx
  ON public.session_pauses (session_id, paused_at DESC);

-- Double-pause guard: at most one open (unresumed) pause row per session.
-- session_pause RPC catches unique_violation and soft-no-ops (R3-M6).
CREATE UNIQUE INDEX session_pauses_one_open_per_session
  ON public.session_pauses (session_id)
  WHERE resumed_at IS NULL;

-- CLAUDE.md hard rule: RLS on every table. Service-role-only = enabled, zero
-- policies. Pause/resume flows through SECURITY DEFINER RPCs; clients never
-- SELECT this table directly.
ALTER TABLE public.session_pauses ENABLE ROW LEVEL SECURITY;

-- ── 5. reap_stale_sessions: extend to catch never-minted + preserve the
--       advisory-lock discipline from migration 0054 ───────────────────────
--
-- Three classes of row to close:
--   (a) avatar_status='pending' AND created_at < now() - 60s AND
--       last_heartbeat_at = created_at (never heartbeat since insert)
--       → end_reason='mint_never_completed', avatar_status='failed_mint'
--   (b) last_heartbeat_at < now() - threshold (heartbeat-stale ghost)
--       → end_reason='ghost_reaper' (existing behavior)
--   (c) (default path) status IN ('starting','active') only — skip 'ending'
--
-- The two-CTE UNION lets us update both buckets in one pass and keep
-- RETURN QUERY simple.
--
-- NOTE: the prior signature (0421000001, refreshed in 0427000010) returned
-- a 3-column TABLE. We're extending it to 4 columns here, which CREATE OR
-- REPLACE cannot do — Postgres rejects RETURNS TABLE shape changes on
-- existing functions. Drop first, then recreate clean.

DROP FUNCTION IF EXISTS public.reap_stale_sessions(int);

CREATE FUNCTION public.reap_stale_sessions(p_threshold_seconds int DEFAULT 60)
RETURNS TABLE (session_id uuid, user_id uuid, age_seconds int, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_threshold_seconds < 30 OR p_threshold_seconds > 3600 THEN
    RAISE EXCEPTION 'threshold out of range [30, 3600]' USING ERRCODE = '22003';
  END IF;

  -- tx-scoped advisory lock; non-lock-winners early-return empty.
  IF NOT pg_try_advisory_xact_lock(hashtext('voice_reaper')) THEN
    RETURN;
  END IF;

  -- (a) mint-never-completed: avatar_status still 'pending' AND the session
  --     was created >60s ago AND no heartbeat activity since created_at
  --     (last_heartbeat_at gets bumped to now() on INSERT per 0040; if it's
  --     stayed at its original value, client never reached the session page).
  RETURN QUERY
  UPDATE public.sessions s
     SET ended_at      = now(),
         status        = 'ended',
         end_reason    = 'mint_never_completed',
         avatar_status = 'failed_mint'
   WHERE s.ended_at IS NULL
     AND s.status IN ('starting', 'active')
     AND s.avatar_status = 'pending'
     AND s.created_at < now() - interval '60 seconds'
     AND s.last_heartbeat_at <= s.created_at + interval '1 second'
  RETURNING s.id, s.user_id,
            EXTRACT(EPOCH FROM (now() - s.created_at))::int,
            'mint_never_completed'::text;

  -- (b) heartbeat-stale ghosts. Unchanged from migration 0054 except we now
  --     avoid double-touching rows already handled in branch (a).
  RETURN QUERY
  UPDATE public.sessions s
     SET ended_at    = now(),
         status      = 'ended',
         end_reason  = 'ghost_reaper'
   WHERE s.ended_at IS NULL
     AND s.status IN ('starting', 'active')
     AND s.last_heartbeat_at < now() - make_interval(secs => p_threshold_seconds)
  RETURNING s.id, s.user_id,
            EXTRACT(EPOCH FROM (now() - s.last_heartbeat_at))::int,
            'ghost_reaper'::text;
END;$$;

REVOKE EXECUTE ON FUNCTION public.reap_stale_sessions(int)
  FROM public, anon, authenticated;

-- ── 6. voice_model_wire_value fixup (drift from .claude_learnings.md
--       2026-04-21) ─────────────────────────────────────────────────────
-- The 2.5 model wire form is 'gemini-2.5-flash-native-audio-preview-12-2025'
-- everywhere in code paths; this function previously returned a stale
-- 'gemini-live-2.5-flash-native-audio' variant. The TS model-map.ts uses the
-- canonical form; bringing PG in alignment lets tests/model-map-parity.spec.ts
-- pass by construction.

CREATE OR REPLACE FUNCTION public.voice_model_wire_value(m voice_model) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE m
    WHEN 'gemini_3_1_flash_live_preview'      THEN 'gemini-3.1-flash-live-preview'
    WHEN 'gemini_live_2_5_flash_native_audio' THEN 'gemini-2.5-flash-native-audio-preview-12-2025'
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.voice_model_wire_value(voice_model)
  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.voice_model_wire_value(voice_model)
  TO authenticated, service_role;
