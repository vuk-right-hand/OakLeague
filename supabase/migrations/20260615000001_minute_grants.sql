-- 20260615000001 — Growth & Minutes Economy, Phase 1a: the ledger spine
--
-- Plan: docs/_planning/GROWTH_MINUTES_ECONOMY_PLAN.md §3.
--
-- Adds a DURABLE minutes wallet on top of the existing per-period free
-- allowance (Option A hybrid — we do NOT rip out voice_usage_daily/weekly).
--
--   effective_remaining = free_allowance_remaining + wallet_remaining
--
-- This migration is the wallet half:
--   * minute_grant_type enum + minute_grants append-only ledger
--   * profiles.wallet_active_seconds  (materialised Σ of grant seconds, O(1))
--   * profiles.wallet_spent_seconds   (monotonic Σ drawn beyond the free pool)
--   * profiles.recruiter_bonus_daily_seconds (permanent daily-cap bump perk)
--   * minute_grant_insert() — the SOLE write path (maintains wallet_active_seconds)
--
-- The balance read (voice_balance_check) + per-turn draw (voice_usage_record_v2)
-- + the monthly counter live in 20260615000002 (they depend on these columns).
--
-- DECISION (plan §12.8, locked 2026-06-16): ALL wallet grants are NON-EXPIRING
-- in v1. That makes `wallet_active_seconds` an EXACT materialised total
-- (Σ seconds == wallet_active_seconds always), so the per-turn gate never has to
-- SUM(minute_grants) on the hot path (R2-M2). minute_grant_insert HARD-REJECTS a
-- non-null expires_at so the invariant can't be violated by a future caller.
-- Expiring promo grants would need the Option-B FIFO draw-down model — out of
-- v1 scope; documented at the enum site.

BEGIN;

-- ── 1. grant_type enum ─────────────────────────────────────────────────────
-- R1-S2: dropped 'weekly_refill' (Option A never mints it — the free allowance
-- is the resetting voice_usage_weekly counter, not a wallet grant — and a dead
-- enum value invites misuse). 'admin_adjustment' is for manual ops corrections.
CREATE TYPE public.minute_grant_type AS ENUM (
  'signup_bonus',
  'share_tap',
  'referral_verified',
  'paid_topup',
  'admin_adjustment'
);

-- ── 2. minute_grants ledger ────────────────────────────────────────────────
CREATE TABLE public.minute_grants (
  id          bigserial             PRIMARY KEY,
  user_id     uuid                  NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  grant_type  public.minute_grant_type NOT NULL,
  seconds     int                   NOT NULL CHECK (seconds > 0 AND seconds <= 2678400), -- ≤31d sanity ceiling
  granted_at  timestamptz           NOT NULL DEFAULT now(),
  expires_at  timestamptz,          -- v1: ALWAYS NULL (non-expiring). Reserved for a future Option-B promo model.
  source_kind text                  NOT NULL CHECK (length(source_kind) <= 32),  -- 'referral_token'|'stripe_event'|'share_token'|'signup'|'admin'
  source_key  text                  CHECK (source_key IS NULL OR length(source_key) <= 128), -- token_hash / evt_… / 'signup:'||uid
  metadata    jsonb                 CHECK (metadata IS NULL OR octet_length(metadata::text) <= 2048)
);

-- Idempotency: a Stripe invoice.id, a referral token_hash, or a 'signup:uid'
-- can each grant exactly once. R2-S1: admin_adjustment rows with NULL source_key
-- are intentionally NOT deduped (manual ops) — a double ops-entry won't be caught
-- here; the admin RPC (Phase 4/7) logs every insert for after-the-fact audit.
CREATE UNIQUE INDEX minute_grants_dedup
  ON public.minute_grants (grant_type, source_kind, source_key)
  WHERE source_key IS NOT NULL;

-- (user_id, expires_at): pre-built for a future Option-B expiring-promo model. In
-- v1 expires_at is ALWAYS NULL, so this is effectively a (user_id) index and is NOT
-- load-bearing today (balance reads the materialised column, not a grant scan). S3.
CREATE INDEX minute_grants_user_active_idx ON public.minute_grants (user_id, expires_at);
CREATE INDEX minute_grants_user_type_idx   ON public.minute_grants (user_id, grant_type, granted_at DESC); -- caps/velocity (Phase 4)
CREATE INDEX minute_grants_granted_at_idx  ON public.minute_grants (granted_at DESC);                      -- reconciliation (Phase 7)

ALTER TABLE public.minute_grants ENABLE ROW LEVEL SECURITY;
-- Service-role only. ZERO policies — every write goes through minute_grant_insert,
-- every read through voice_balance_check / the admin viewer (Phase 7).

COMMENT ON TABLE public.minute_grants IS
  'Append-only durable minutes wallet (Growth & Minutes Economy). One row per grant. '
  'v1: all grants non-expiring (expires_at always NULL) so profiles.wallet_active_seconds '
  'is an exact materialised total. Immutable: UPDATE/TRUNCATE blocked; DELETE is reserved '
  'for the profiles ON DELETE CASCADE (user deletion). WARNING (M4): a MANUAL DELETE is NOT '
  'forbidden by a trigger (it cannot be distinguished from a cascade) and does NOT decrement '
  'profiles.wallet_active_seconds — it corrupts the invariant. Never DELETE rows by hand; the '
  'Phase-7 reconciler MUST alert when wallet_active_seconds <> SUM(seconds). Corrections are '
  'new admin_adjustment rows, never edits.';

-- ── 3. Append-only discipline ──────────────────────────────────────────────
-- Block UPDATE (a granted amount must never silently change — it would desync
-- the materialised wallet_active_seconds) and TRUNCATE. DELETE is ALLOWED: the
-- only delete path is the profiles ON DELETE CASCADE (user deletion), which a
-- BEFORE DELETE row trigger cannot distinguish from a manual delete — and we
-- must not break user deletion. raise_append_only() already exists (cogs_log 0020).
CREATE FUNCTION public.minute_grants_block_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'minute_grants is append-only (corrections = new admin_adjustment rows)'
    USING ERRCODE = '42501';
END;$$;
REVOKE EXECUTE ON FUNCTION public.minute_grants_block_update() FROM public;

CREATE TRIGGER minute_grants_no_update
  BEFORE UPDATE ON public.minute_grants
  FOR EACH ROW EXECUTE FUNCTION public.minute_grants_block_update();

CREATE TRIGGER minute_grants_no_truncate
  BEFORE TRUNCATE ON public.minute_grants
  FOR EACH STATEMENT EXECUTE FUNCTION public.raise_append_only();

-- ── 4. Wallet + recruiter columns on profiles ──────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN wallet_active_seconds bigint NOT NULL DEFAULT 0 CHECK (wallet_active_seconds >= 0),
  ADD COLUMN wallet_spent_seconds  bigint NOT NULL DEFAULT 0 CHECK (wallet_spent_seconds  >= 0),
  -- Permanent daily-cap bump from recruited signups. R3-#3: the CHECK is a
  -- generous SAFETY WALL (7200s = 2h, never reached in normal ops); the ACTUAL
  -- live cap is env-driven RECRUITER_BONUS_CEILING_SECONDS (default 1800), read
  -- by the Phase-4 grant RPC. The CHECK only stops a runaway bug.
  ADD COLUMN recruiter_bonus_daily_seconds int NOT NULL DEFAULT 0
    CHECK (recruiter_bonus_daily_seconds BETWEEN 0 AND 7200);

COMMENT ON COLUMN public.profiles.wallet_active_seconds IS
  'Materialised Σ of all (non-expiring) minute_grants.seconds for this user. Maintained '
  'atomically by minute_grant_insert. wallet_remaining = max(0, wallet_active_seconds − '
  'wallet_spent_seconds). Phase-7 reconcile asserts it equals SUM(minute_grants.seconds).';
COMMENT ON COLUMN public.profiles.wallet_spent_seconds IS
  'Monotonic lifetime Σ of seconds drawn from the WALLET (turn usage beyond the free '
  'allowance). Clamped to never exceed wallet_active_seconds (voice_usage_record_v2).';
COMMENT ON COLUMN public.profiles.recruiter_bonus_daily_seconds IS
  'Permanent daily-cap bump earned by referring new users. Added to the DAILY side only '
  '(never the weekly side) inside voice_balance_check / voice_usage_record_v2. Per R2-C1 it '
  'is part of daily_cap_eff and so DOES raise the 150%% COGS fuse anchor (daily_cap_eff + '
  'wallet) — but that anchor is hard-bounded by ABSOLUTE_DAILY_COGS_CEILING_SECONDS, so a '
  'maxed recruiter bonus (or a sock-puppet) cannot uncap the fuse. Live ceiling = env '
  'RECRUITER_BONUS_CEILING_SECONDS; the CHECK is a safety wall.';

-- NOTE (plan §10 R1-M1): profiles table-wide UPDATE for `authenticated` is already
-- REVOKEd (20260525000010) with an explicit column allowlist. The three trust-bearing
-- columns above are therefore SAFE BY DEFAULT — do NOT add them to that grant.

-- ── 5. minute_grant_insert — the SOLE wallet write path ────────────────────
-- SECURITY DEFINER, service-role only (all grants are server-decided; there is no
-- self-grant path). Idempotent via the partial dedup index. Maintains the
-- materialised wallet_active_seconds in the same transaction so the column stays
-- exact. Phase 4 CREATE OR REPLACEs this to layer on the per-type lifetime +
-- velocity caps and the share-tap 2/day cap — the core insert/dedup/wallet-bump
-- contract below stays identical.
CREATE FUNCTION public.minute_grant_insert(
  p_user_id     uuid,
  p_grant_type  public.minute_grant_type,
  p_seconds     int,
  p_source_kind text,
  p_source_key  text        DEFAULT NULL,
  p_metadata    jsonb       DEFAULT NULL,
  p_expires_at  timestamptz DEFAULT NULL
) RETURNS TABLE (granted boolean, reason text, grant_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_new_id   bigint;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'minute_grant_insert is service-role only' USING ERRCODE = '42501';
  END IF;

  IF p_seconds IS NULL OR p_seconds <= 0 OR p_seconds > 2678400 THEN
    RAISE EXCEPTION 'seconds out of range (0, 2678400]: %', p_seconds USING ERRCODE = '22003';
  END IF;
  IF p_source_kind IS NULL OR length(p_source_kind) = 0 OR length(p_source_kind) > 32 THEN
    RAISE EXCEPTION 'source_kind required, ≤32 chars' USING ERRCODE = '22023';
  END IF;
  -- v1 invariant: non-expiring only (keeps wallet_active_seconds exact).
  IF p_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'expiring grants are not supported in v1 (wallet is non-expiring)'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.minute_grants
    (user_id, grant_type, seconds, granted_at, expires_at, source_kind, source_key, metadata)
  VALUES
    (p_user_id, p_grant_type, p_seconds, now(), NULL, p_source_kind, p_source_key, p_metadata)
  ON CONFLICT (grant_type, source_kind, source_key) WHERE source_key IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_new_id;

  -- DO NOTHING → no row returned → dedup hit. Idempotent no-op (only possible
  -- when source_key was non-null; NULL-source_key rows never conflict).
  IF v_new_id IS NULL THEN
    RETURN QUERY SELECT false, 'duplicate'::text, NULL::bigint;
    RETURN;
  END IF;

  -- Maintain the materialised wallet total (non-expiring ⇒ exact).
  UPDATE public.profiles
     SET wallet_active_seconds = wallet_active_seconds + p_seconds
   WHERE id = p_user_id;

  RETURN QUERY SELECT true, NULL::text, v_new_id;
END;$$;

REVOKE EXECUTE ON FUNCTION
  public.minute_grant_insert(uuid, public.minute_grant_type, int, text, text, jsonb, timestamptz)
  FROM public, anon, authenticated;

COMMENT ON FUNCTION
  public.minute_grant_insert(uuid, public.minute_grant_type, int, text, text, jsonb, timestamptz) IS
  'Sole write path for minute_grants. Service-role only. Idempotent on (grant_type, '
  'source_kind, source_key) when source_key is non-null. Maintains profiles.wallet_active_seconds. '
  'Returns (granted, reason, grant_id): granted=false reason=duplicate on a dedup no-op.';

-- ── 6. GRANTs (CLAUDE.md hard rule — Supabase dropped default grants 2026-10-30) ──
GRANT ALL ON TABLE public.minute_grants TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.minute_grants_id_seq TO service_role;

COMMIT;
