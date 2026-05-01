-- 0009 — React/duet schema (D8): recordings + referrals + quota counters +
-- pg_cron sweeps. Per REACT_DUET_PLAN.md §9 + §20.6 + §23.5 + §25.3.
--
-- Tables (in dependency order):
--   1. referral_tokens          (HMAC token row, minted at recording_open_check)
--   2. recordings               (one row per finalized duet — bytes NOT stored)
--   3. referral_redemptions     (landing + first_session credit, no PII per R3-M2)
--   4. recording_usage_daily    (finalized counter, source of truth for caps)
--   5. recording_pending_arms   (multi-tab safe pending counter, R3 C3)
--
-- Quota model:
--   - profile cap columns recording_daily_cap / recording_weekly_cap
--     (defaults 5 / 15) — column-level REVOKE UPDATE so a self-update
--     via "profiles own update" policy cannot raise them; admin RPC
--     to be added later if needed.
--   - recording_open_check_rpc reads (count(*) finalized) + (count(*)
--     pending unresolved) and rejects if >= cap. Returns arm_id which
--     client passes to recording_finalize_action. (RPCs ship in a later
--     migration alongside the route handlers.)
--   - pg_cron sweep clears stale pending_arms (armed_at < now()-90s) so
--     a backgrounded tab that never finalizes does not permanently hold
--     a slot.
--
-- Referral semantics (per R3-M5 + plan §20.7):
--   - Token mint at arm time so the in-video end-card URL == share URL
--     (no race between recording bytes and token row).
--   - referral_tokens.recording_id is forward-ref'd to recordings via
--     ALTER ... ADD CONSTRAINT after CREATE TABLE recordings (single-
--     migration cycle dependency).
--   - referral_redemptions partial unique index on (new_user_id) where
--     credit_event = 'first_session' — exactly one first-session credit
--     per new user, ever, across all tokens. Last-clicked-wins via
--     cookie (set in /r/[token] route).
--   - device_fp + ip_prefix INTENTIONALLY NOT INCLUDED (R3-M2 GDPR cut).
--     Fraud detection deferred until volume justifies the legal basis.
--
-- RLS:
--   - recordings:                    owner SELECT only; service-role write.
--   - recording_usage_daily:         owner SELECT only; service-role write.
--   - referral_tokens:               service-role only (zero policies).
--   - referral_redemptions:          service-role only (zero policies).
--   - recording_pending_arms:        service-role only (zero policies).
--
-- pg_cron precondition: extension is required by 20260425000003 +
-- 20260427000006 + 20260504000007 — already enabled.

-- ── 1. Enums ─────────────────────────────────────────────────────────────
CREATE TYPE recording_kind AS ENUM ('hook_duet', 'long_form_duet', 'ask_duet');
CREATE TYPE recording_status AS ENUM ('uploading', 'ready', 'failed', 'deleted');
CREATE TYPE referral_credit_event AS ENUM ('landing', 'first_session', 'first_paid');

-- ── 2. profiles cap columns ──────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN recording_daily_cap  int NOT NULL DEFAULT 5
    CHECK (recording_daily_cap  BETWEEN 0 AND 1000),
  ADD COLUMN recording_weekly_cap int NOT NULL DEFAULT 15
    CHECK (recording_weekly_cap BETWEEN 0 AND 7000);

COMMENT ON COLUMN public.profiles.recording_daily_cap IS
  'Max finalized duet recordings per UTC day. Default 5 (free tier). '
  'Frozen against user self-edit by profiles_freeze_recording_caps trigger; '
  'service-role / postgres bypass via auth.uid() IS NULL check.';
COMMENT ON COLUMN public.profiles.recording_weekly_cap IS
  'Max finalized duet recordings per ISO week (Mon-anchored). Default 15.';

-- Freeze trigger — prevents authenticated users from raising their own
-- caps via the "profiles own update" RLS policy. Mirrors the pattern in
-- creator_applications_freeze_after_submit (20260420000010).
--
-- Bypass surface (audit R1 M1):
--   - Plain service-role JS calls (no JWT) → auth.uid() NULL → pass.
--   - Postgres role / pg_cron context → auth.uid() NULL → pass.
--   - SECURITY DEFINER RPC invoked by an admin user → auth.uid() returns
--     the ADMIN's UUID (NOT NULL) → trigger raises 42501. Any future
--     admin_set_user_recording_caps RPC must therefore either:
--       (a) explicitly `SET LOCAL role TO postgres` inside the function
--           body to drop into a NULL-auth.uid() context, OR
--       (b) set a session GUC `app.bypass_recording_cap_freeze=on` and
--           amend this trigger to honor it (preferred — keeps audit
--           breadcrumbs in postgres logs).
--   The existing admin_set_user_voice_caps RPC does NOT touch these
--   columns and is unaffected.
--
-- Why a trigger and not column-level REVOKE: PostgreSQL column-level
-- GRANT/REVOKE does not override the table-level GRANT ALL that Supabase
-- applies to authenticated by default. To restrict via privileges we'd
-- have to REVOKE UPDATE on the whole table and GRANT back column-by-
-- column, which would conflict with the existing "profiles own update"
-- RLS policy and require maintaining the column allowlist forever.
CREATE OR REPLACE FUNCTION public.profiles_freeze_recording_caps()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- auth.uid() is NULL for service-role / postgres / cron contexts; let
  -- those through.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.recording_daily_cap IS DISTINCT FROM OLD.recording_daily_cap THEN
    RAISE EXCEPTION 'recording_daily_cap is admin-only' USING ERRCODE = '42501';
  END IF;
  IF NEW.recording_weekly_cap IS DISTINCT FROM OLD.recording_weekly_cap THEN
    RAISE EXCEPTION 'recording_weekly_cap is admin-only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.profiles_freeze_recording_caps() FROM PUBLIC;

CREATE TRIGGER profiles_freeze_recording_caps_trg
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_freeze_recording_caps();

-- ── 3. referral_tokens (created BEFORE recordings; recordings.share_token
--     references it) ─────────────────────────────────────────────────────
CREATE TABLE public.referral_tokens (
  token_hash         text        PRIMARY KEY,                   -- HMAC of plaintext token
  user_id            uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  creator_id         uuid        REFERENCES public.creators(id) ON DELETE SET NULL,
  hook_id            uuid        REFERENCES public.hooks(id) ON DELETE SET NULL,
  video_id           uuid        REFERENCES public.videos(id) ON DELETE SET NULL,
  recording_id       uuid,                                      -- FK added below after recordings exists
  -- Tombstone bit set ONCE at recording_finalize_action time and never
  -- cleared, even if the recording is later hard-deleted. The abandoned
  -- sweep skips any token with this set so a Twitter-shared duet URL
  -- keeps crediting the inviter regardless of recording lifecycle.
  -- Cannot use `recording_id IS NOT NULL` for the same purpose because
  -- recording_id reverts to NULL on recordings hard-delete via the
  -- ON DELETE SET NULL FK. (Audit R2 M3.)
  bound_at_finalize  boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  redeemed_count     int         NOT NULL DEFAULT 0
                                   CHECK (redeemed_count >= 0),
  last_redeemed_at   timestamptz
);

CREATE INDEX referral_tokens_user_idx ON public.referral_tokens (user_id, created_at DESC);
-- Plain B-tree on expires_at — partial-WHERE-now() rejected by Postgres
-- (now() is STABLE, not IMMUTABLE; partial-index predicates require
-- IMMUTABLE). The sweep range scan picks up this index just fine.
CREATE INDEX referral_tokens_expires_idx ON public.referral_tokens (expires_at);

ALTER TABLE public.referral_tokens ENABLE ROW LEVEL SECURITY;
-- Zero policies → service-role only. RPC is the read/write surface.

REVOKE ALL ON public.referral_tokens FROM PUBLIC, anon, authenticated;
-- Supabase grants service_role full DML by default — leave that intact.

-- ── 4. recordings (depends on referral_tokens for share_token FK) ────────
CREATE TABLE public.recordings (
  id                 uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid             NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  creator_id         uuid             NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  kind               recording_kind   NOT NULL,
  source_hook_id     uuid             REFERENCES public.hooks(id)    ON DELETE SET NULL,
  source_video_id    uuid             REFERENCES public.videos(id)   ON DELETE SET NULL,
  source_session_id  uuid             REFERENCES public.sessions(id) ON DELETE SET NULL,
  duration_ms        int              NOT NULL CHECK (duration_ms BETWEEN 1000 AND 65000),
  client_mime        text             NOT NULL CHECK (char_length(client_mime) <= 100),
  storage_key        text             CHECK (storage_key IS NULL OR char_length(storage_key) <= 500),
  share_token        text             REFERENCES public.referral_tokens(token_hash) ON DELETE SET NULL,
  c2pa_manifest_sha  text             CHECK (c2pa_manifest_sha IS NULL OR char_length(c2pa_manifest_sha) <= 128),
  watermark_version  int              NOT NULL DEFAULT 1 CHECK (watermark_version >= 1),
  created_at         timestamptz      NOT NULL DEFAULT now(),
  status             recording_status NOT NULL DEFAULT 'ready'
);

CREATE INDEX recordings_user_created_idx
  ON public.recordings (user_id, created_at DESC);
CREATE INDEX recordings_creator_created_idx
  ON public.recordings (creator_id, created_at DESC);

ALTER TABLE public.recordings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "recordings owner read"
  ON public.recordings FOR SELECT
  USING (user_id = auth.uid());
-- No INSERT/UPDATE/DELETE policies — all writes via service-role through
-- recording_finalize_action RPC (ships in a later migration).

REVOKE INSERT, UPDATE, DELETE ON public.recordings FROM PUBLIC, anon, authenticated;

-- Forward-ref: referral_tokens.recording_id → recordings.id. Now that
-- recordings exists, attach the FK.
ALTER TABLE public.referral_tokens
  ADD CONSTRAINT referral_tokens_recording_id_fkey
  FOREIGN KEY (recording_id) REFERENCES public.recordings(id) ON DELETE SET NULL;

-- ── 5. referral_redemptions (no device_fp / ip_prefix per R3-M2) ─────────
-- token_hash is NULLABLE + ON DELETE SET NULL to preserve the partial-
-- unique entry on (new_user_id) WHERE credit_event='first_session' even
-- when the original token vanishes (audit R1 M2).
--
-- Concrete attack this closes: A invites B (first_session credit). A
-- deletes account → cascade through profiles → referral_tokens (token
-- 'hash_a' removed). If the redemption FK had been ON DELETE CASCADE,
-- the redemption row would also vanish, freeing up the partial unique
-- on B's new_user_id. B then clicks A2's link → second first_session
-- credit succeeds. With SET NULL, the redemption row persists with
-- token_hash=NULL, partial unique stays armed, second credit blocked.
-- PROBE_4 verifies this end-to-end.
CREATE TABLE public.referral_redemptions (
  id            uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable per M2; see header block + COMMENT ON COLUMN below.
  token_hash    text                  REFERENCES public.referral_tokens(token_hash) ON DELETE SET NULL,
  new_user_id   uuid                  NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  redeemed_at   timestamptz           NOT NULL DEFAULT now(),
  credit_event  referral_credit_event NOT NULL,
  -- Note: the table-level UNIQUE (token_hash, new_user_id, credit_event)
  -- is effectively not enforced for token_hash=NULL rows because SQL
  -- treats NULL <> NULL in UNIQUE. Duplicate landing rows for the same
  -- new_user_id against a deleted token can stack — analytics impact
  -- only (no credit attached to landing).
  UNIQUE (token_hash, new_user_id, credit_event)
);

COMMENT ON COLUMN public.referral_redemptions.token_hash IS
  'Nullable. Set NULL by ON DELETE SET NULL when the parent referral_tokens '
  'row is removed (typically via inviter account deletion cascade). Future '
  'consumers MUST handle NULL — never assume NOT NULL in joins or analytics.';

-- Exactly one first_session credit per new_user_id, ever, across ALL tokens.
-- Per plan §20.7 + R3-M5: blocks dual-credit attacks via cross-token
-- abandoned-cookie chains.
CREATE UNIQUE INDEX referral_redemptions_first_session_unique
  ON public.referral_redemptions (new_user_id)
  WHERE credit_event = 'first_session';

CREATE INDEX referral_redemptions_token_idx
  ON public.referral_redemptions (token_hash, redeemed_at DESC);

ALTER TABLE public.referral_redemptions ENABLE ROW LEVEL SECURITY;
-- Zero policies → service-role only.

REVOKE ALL ON public.referral_redemptions FROM PUBLIC, anon, authenticated;

-- ── 6. recording_usage_daily (finalized counter — source of truth) ──────
CREATE TABLE public.recording_usage_daily (
  user_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day      date NOT NULL,
  count    int  NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (user_id, day)
);

ALTER TABLE public.recording_usage_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "recording_usage_daily owner read"
  ON public.recording_usage_daily FOR SELECT
  USING (user_id = auth.uid());

REVOKE INSERT, UPDATE, DELETE ON public.recording_usage_daily FROM PUBLIC, anon, authenticated;

-- ── 7. recording_pending_arms (multi-tab safe per R3 C3) ─────────────────
CREATE TABLE public.recording_pending_arms (
  arm_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day         date        NOT NULL,
  armed_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution  text        CHECK (resolution IS NULL
                                 OR resolution IN ('finalized','timeout','aborted'))
);

CREATE INDEX recording_pending_arms_open_idx
  ON public.recording_pending_arms (user_id, day)
  WHERE resolved_at IS NULL;

CREATE INDEX recording_pending_arms_sweep_idx
  ON public.recording_pending_arms (armed_at)
  WHERE resolved_at IS NULL;

ALTER TABLE public.recording_pending_arms ENABLE ROW LEVEL SECURITY;
-- Zero policies → service-role only.

REVOKE ALL ON public.recording_pending_arms FROM PUBLIC, anon, authenticated;

-- ── 8. Sweep functions (postgres-owned, REVOKEd from everyone) ───────────

-- Mark stale pending arms as timeout. Runs every minute via pg_cron.
-- TTL = 90s — comfortably longer than the longest realistic recording
-- (60s hard cap + 5s slack + finalize round-trip).
CREATE OR REPLACE FUNCTION public.recording_pending_arms_sweep()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  SET LOCAL lock_timeout      = '5s';
  SET LOCAL statement_timeout = '60s';

  PERFORM pg_advisory_xact_lock(hashtext('recording_pending_arms_sweep')::bigint);

  UPDATE public.recording_pending_arms
     SET resolved_at = now(),
         resolution  = 'timeout'
   WHERE resolved_at IS NULL
     AND armed_at    < now() - interval '90 seconds';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER FUNCTION public.recording_pending_arms_sweep() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.recording_pending_arms_sweep()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.recording_pending_arms_sweep() IS
  '60s pg_cron sweep. Marks pending arms older than 90s as timeout, '
  'releasing their cap slot. Idempotent; advisory-lock prevents '
  'concurrent runs from a manual invocation racing the cron.';

-- Sweep abandoned referral tokens (created >24h ago, never bound to a
-- recording or redeemed). Runs daily.
--
-- Audit R2 M3: bound_at_finalize is the immutable tombstone — set at
-- recording_finalize_action time, never cleared. recording_id alone is
-- NOT a safe tombstone because it ON DELETE SET NULLs back to NULL when
-- the recording is hard-deleted (DMCA / GDPR), at which point the next
-- 11:00 UTC sweep would expire a token whose share URL is already in
-- the wild on Twitter / IG. The boolean tombstone survives all
-- recording-side delete paths.
--
-- Audit R2 M4: the soft-delete asymmetry — recordings.share_token has
-- ON DELETE SET NULL, and referral_tokens.recording_id has ON DELETE
-- SET NULL. So a recording soft-delete (status='deleted') leaves both
-- pointers intact; a recording hard-DELETE clears both. The token row
-- and its bound_at_finalize=true persist either way and remain
-- redeemable. Documented as intent: a creator's duet share URL keeps
-- crediting the inviter even if the creator later removes the
-- underlying recording.
CREATE OR REPLACE FUNCTION public.referral_tokens_abandoned_sweep()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  SET LOCAL lock_timeout      = '5s';
  SET LOCAL statement_timeout = '5min';

  PERFORM pg_advisory_xact_lock(hashtext('referral_tokens_abandoned_sweep')::bigint);

  -- Expire (don't delete) so any in-flight /r/[token] redemption attempt
  -- sees a clean expired-token error instead of a missing-row error.
  -- Tombstone clause: NOT t.bound_at_finalize — once a token has ever
  -- been bound to a finalized recording (boolean set at finalize time,
  -- never cleared), it is immune to abandoned sweep regardless of any
  -- subsequent recording soft- or hard-delete.
  UPDATE public.referral_tokens t
     SET expires_at = now()
   WHERE t.expires_at        >  now()
     AND t.created_at        <  now() - interval '24 hours'
     AND NOT t.bound_at_finalize
     AND NOT EXISTS (SELECT 1 FROM public.referral_redemptions x WHERE x.token_hash = t.token_hash);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER FUNCTION public.referral_tokens_abandoned_sweep() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.referral_tokens_abandoned_sweep()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.referral_tokens_abandoned_sweep() IS
  'Daily pg_cron sweep. Expires referral tokens >24h old that were '
  'never bound to a recording (user discarded preview / closed tab) '
  'and never redeemed. Bounds the unbounded-mint surface even with '
  'the open-check rate limit.';

-- ── 9. Cron registration (idempotent) ────────────────────────────────────
DO $guard$
BEGIN
  PERFORM cron.unschedule('recording_pending_arms_sweep');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'unschedule of recording_pending_arms_sweep skipped: %', SQLERRM;
END;
$guard$;

DO $guard$
BEGIN
  PERFORM cron.unschedule('referral_tokens_abandoned_sweep');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'unschedule of referral_tokens_abandoned_sweep skipped: %', SQLERRM;
END;
$guard$;

SELECT cron.schedule(
  'recording_pending_arms_sweep',
  '* * * * *',                    -- every minute
  $job$ SELECT public.recording_pending_arms_sweep(); $job$
);

SELECT cron.schedule(
  'referral_tokens_abandoned_sweep',
  '0 11 * * *',                   -- 11:00 UTC, 1h after the existing retention sweeps
  $job$ SELECT public.referral_tokens_abandoned_sweep(); $job$
);
