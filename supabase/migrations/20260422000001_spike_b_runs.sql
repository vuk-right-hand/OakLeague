-- 0046 — Spike B (avatar provider) persistence
--
-- Phase 0 placeholder migration (SPIKE_B_PLAN.md Rev 5). Lands the three
-- tables tonight (2026-04-21) so the migration number is reserved in git
-- history before any provider code is written. Parallel to Spike A's
-- 20260421000001 placeholder pattern — migrations are append-only, so we
-- lock the number now and iterate structure in follow-on migrations if
-- Phase 1–3 surface schema gaps.
--
-- Scope:
--   1. spike_b_runs         — per-run metadata, timers, provider, clip, cost
--   2. spike_b_rater_scores — rater submissions (lipsync / mouth-in-sync / feels-alive / sentinel)
--   3. spike_b_rater_tokens — voice_tickets-pattern token auth for /rate/[token]
--
-- All three: RLS enabled, ZERO policies (service-role only).
-- Spike B never writes to public.sessions (SPIKE_B_PLAN.md decision 17) — no
-- collision with sessions_one_active_per_user (migration 0040:19).
--
-- Avatar COGS writes land in cogs_log directly (service=simli|tavus,
-- environment='spike_b', operation='avatar_lipsync_seconds'). We do NOT
-- route through cogs_insert_turn — that RPC is voice-specific and hardcodes
-- voice_audio_{input,output}_seconds (migration 0045:181,187). cogs_service
-- enum already includes 'simli' and 'tavus' (migration 0001:18); cogs_log
-- environment CHECK already includes 'spike_b' (migration 0040:60).

-- 1. spike_b_runs ---------------------------------------------------------------
-- One row per provider run (one clip × one chunk-size × one iteration).
-- Written by /api/spike-b/record after the run completes. cost_usd is clamped
-- server-side to (duration_seconds/60) × CEILING_USD_PER_MIN before INSERT
-- (ceilings live in env vars, not DB — ship-agnostic).

CREATE TABLE public.spike_b_runs (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz  NOT NULL DEFAULT now(),
  run_by            uuid         NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider          cogs_service NOT NULL
    CHECK (provider IN ('simli', 'tavus')),
  clip_id           text         NOT NULL CHECK (char_length(clip_id) BETWEEN 1 AND 64),
  chunk_size_bytes  int          CHECK (chunk_size_bytes IS NULL OR chunk_size_bytes BETWEEN 1 AND 65536),
  iteration         int          NOT NULL CHECK (iteration BETWEEN 1 AND 100),
  device            text         NOT NULL CHECK (char_length(device) BETWEEN 1 AND 64),
  network           text         CHECK (network IS NULL OR char_length(network) <= 32),
  -- Timers (ms). Nullable: run may be aborted before a phase completes.
  t0_t1_ms          int          CHECK (t0_t1_ms IS NULL OR (t0_t1_ms >= 0 AND t0_t1_ms <= 120000)),
  t1_t2_ms          int          CHECK (t1_t2_ms IS NULL OR (t1_t2_ms >= 0 AND t1_t2_ms <= 120000)),
  duration_seconds  numeric(8,3) NOT NULL CHECK (duration_seconds >= 0 AND duration_seconds <= 3600),
  cost_usd          numeric(10,6) NOT NULL CHECK (cost_usd >= 0),
  -- Outcome taxonomy — mirrors AvatarBridge error union in plan §Architecture.
  -- 'other' is the catch-all for unknown provider codes. When outcome='other',
  -- bridges MUST write the raw provider string to metadata.outcome_raw so the
  -- real code is recoverable for taxonomy gap analysis (otherwise the CHECK
  -- loses signal as new provider error shapes surface).
  outcome           text         NOT NULL CHECK (outcome IN (
                                 'ok', 'connect_timeout', 'token_expired', 'replica_not_ready',
                                 'rtc_ice_failed', 'audio_format_rejected', 'quota_exceeded',
                                 'replica_not_found', 'app_message_too_large',
                                 'session_idle_killed', 'session_ttl_expired', 'other')),
  metadata          jsonb        CHECK (metadata IS NULL OR octet_length(metadata::text) <= 8192)
);

CREATE INDEX spike_b_runs_created_idx  ON public.spike_b_runs (created_at DESC);
CREATE INDEX spike_b_runs_provider_idx ON public.spike_b_runs (provider, created_at DESC);
CREATE INDEX spike_b_runs_clip_idx     ON public.spike_b_runs (clip_id, provider);

ALTER TABLE public.spike_b_runs ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.

-- 2. spike_b_rater_scores -------------------------------------------------------
-- One row per (rater, clip-pair). side_provider_map is the server-side ground
-- truth for "which side was which provider" — clients never receive it; they
-- see only "left" and "right". sentinel_flag marks the two duplicate injections
-- per rater session (not revealed to raters). drift is computed offline.

CREATE TABLE public.spike_b_rater_scores (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz  NOT NULL DEFAULT now(),
  rater_id            uuid         NOT NULL,  -- opaque rater handle, not profile.id (raters aren't users)
  rater_cohort        text         NOT NULL CHECK (rater_cohort IN ('vuk_naive', 'vuk_knower')),
  clip_pair_id        text         NOT NULL CHECK (char_length(clip_pair_id) BETWEEN 1 AND 64),
  -- Server-side ground truth. Per-pair mapping of display side → provider.
  -- Shape: {"left":"simli","right":"tavus"} or reversed per randomization.
  side_provider_map   jsonb        NOT NULL CHECK (octet_length(side_provider_map::text) <= 256),
  -- Rater inputs.
  lipsync_alignment   int          CHECK (lipsync_alignment IS NULL OR lipsync_alignment BETWEEN 1 AND 10),
  mouth_in_sync       boolean,
  feels_alive         int          CHECK (feels_alive IS NULL OR feels_alive BETWEEN 1 AND 10),
  -- Vuk-knower-only fields (kept nullable for Vuk-naïve rows).
  resemblance         int          CHECK (resemblance IS NULL OR resemblance BETWEEN 1 AND 10),
  uncanny_valley      boolean,
  would_listen_5_min  boolean,
  -- Sentinel bookkeeping — NOT revealed to raters. Two duplicate clip-pair
  -- injections per rater session; drift >2 on ≥2 of 4 Vuk-naïve raters aborts.
  sentinel_flag       boolean      NOT NULL DEFAULT false,
  submitted_at        timestamptz  NOT NULL DEFAULT now(),
  metadata            jsonb        CHECK (metadata IS NULL OR octet_length(metadata::text) <= 2048),
  -- Defense-in-depth: Vuk-naïve raters must not carry Vuk-knower-only fields.
  -- A client-side bug mis-routing a naïve rater into the knower form would
  -- pollute the gate analysis; DB-level CHECK catches it before INSERT.
  CONSTRAINT rater_cohort_fields_gated CHECK (
    (rater_cohort = 'vuk_naive'
      AND resemblance IS NULL
      AND uncanny_valley IS NULL
      AND would_listen_5_min IS NULL)
    OR rater_cohort = 'vuk_knower'
  )
);

CREATE INDEX spike_b_rater_scores_rater_idx ON public.spike_b_rater_scores (rater_id, submitted_at);
CREATE INDEX spike_b_rater_scores_clip_idx  ON public.spike_b_rater_scores (clip_pair_id);
CREATE INDEX spike_b_rater_scores_cohort_idx ON public.spike_b_rater_scores (rater_cohort, submitted_at DESC);

ALTER TABLE public.spike_b_rater_scores ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.

-- 3. spike_b_rater_tokens -------------------------------------------------------
-- voice_tickets shape. Minted by admin via /api/spike-b/rater-token, consumed
-- atomically by /rate/[token] on first GET (sets consumed_at = now() where
-- consumed_at IS NULL). UA-hash-bound to prevent token-sharing. 7-day TTL
-- because rater windows are human-scheduled, not sub-second.

CREATE TABLE public.spike_b_rater_tokens (
  token_id       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  rater_id       uuid         NOT NULL,   -- same opaque id shared with spike_b_rater_scores.rater_id
  rater_cohort   text         NOT NULL CHECK (rater_cohort IN ('vuk_naive', 'vuk_knower')),
  bound_ua_hash  text         NOT NULL CHECK (char_length(bound_ua_hash) BETWEEN 32 AND 128),
  expires_at     timestamptz  NOT NULL DEFAULT (now() + interval '7 days'),
  consumed_at    timestamptz,
  created_at     timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX spike_b_rater_tokens_expires_idx
  ON public.spike_b_rater_tokens (expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX spike_b_rater_tokens_rater_idx
  ON public.spike_b_rater_tokens (rater_id);

-- At most one live (unconsumed) token per rater. Prevents double-mint ambiguity
-- (admin re-clicks generate link → two valid tokens → which consumed_at row
-- reflects the real usage?). Matches sessions_one_active_per_user pattern
-- from migration 0040:19.
CREATE UNIQUE INDEX spike_b_rater_tokens_one_live_per_rater
  ON public.spike_b_rater_tokens (rater_id)
  WHERE consumed_at IS NULL;

ALTER TABLE public.spike_b_rater_tokens ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies — raters never hit Supabase directly; the
-- /rate/[token] route validates tokens via service-role reads on the server.
