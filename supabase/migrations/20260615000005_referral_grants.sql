-- 20260615000005 — Growth & Minutes Economy, Phase 4: referral engine grants
--
-- Plan: docs/_planning/GROWTH_MINUTES_ECONOMY_PLAN.md §6. Credit on OUTCOME, not
-- clicks. Every grant flows through minute_grant_insert (the sole wallet write
-- path, Phase 1) so the materialised wallet_active_seconds stays exact.
--
-- Pieces:
--   1. referral_tokens += minter_device_fp / minter_ip_prefix  (R2-M4 sock-puppet)
--   2. minute_share_tap_daily                                   (atomic 2/day cap)
--   3. minute_grant_insert v2  — lifetime + velocity + share-tap-daily caps
--   4. recording_referral_mint v2  — persist the MINTER's fp/ip at mint time
--   5. recording_referral_credit_first_session_v2 — ONE RPC, ONE txn (R1-M4):
--        credit + referrer grant + new-user welcome + recruiter bump, with the
--        self-referral (R1-C4) and sock-puppet (R2-M4) guards, structured return.
--
-- Caps/bonuses are PARAMS with sane defaults (the live config); app-layer callers
-- pass env overrides. SQL can't read process.env, and the SQL-side caller
-- (credit_v2 → minute_grant_insert) relies on the defaults being correct.
--
-- DEPLOY ORDER (M3): this migration MUST be applied to prod BEFORE the Vercel app
-- deploys — the open + open-check routes call the new _v2 / 6-arg-mint signatures
-- unconditionally (no feature flag, unlike the ledger draw). If the app ships
-- first, mints fail (500 → no-token recording, survivable) and referral credits
-- error out; the credit is NOT permanently lost (it's idempotent and retries on
-- the user's next session once the migration lands), but conversions drop in the
-- window. Apply migrations first.

BEGIN;

-- ── 1. Minter fingerprint on the token (R2-M4) ─────────────────────────────
-- The redemption row stores the NEW user's fp/ip; to catch a referrer self-
-- referring once per fresh token behind incognito/VPN we need the MINTER's fp/ip
-- too. Nullable — pre-Phase-4 tokens have none, so the sock-puppet guard simply
-- can't fire for them (review-only stance; the real backstop is the lifetime +
-- velocity caps tied to the referrer).
ALTER TABLE public.referral_tokens
  ADD COLUMN minter_device_fp text,
  ADD COLUMN minter_ip_prefix text;

COMMENT ON COLUMN public.referral_tokens.minter_device_fp IS
  'fp of the user who MINTED this token (R2-M4). Compared to the new user''s fp at '
  'credit time to skip the recruiter bump on a self-referral. Review-only signal.';

-- ── 2. minute_share_tap_daily — atomic 2/day share-tap cap (R2-M7) ─────────
-- A user can MINT up to recording_share_daily_cap tokens/day (20), but only earns
-- a share_tap GRANT for the first SHARE_TAP_DAILY_CAP (2). Separate, smaller cap
-- on the grant. Mirrors recording_token_mints_daily's atomic-UPSERT shape so two
-- concurrent taps can't both slip past a COUNT-then-INSERT race.
CREATE TABLE public.minute_share_tap_daily (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day     date NOT NULL,
  count   int  NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (user_id, day)
);

ALTER TABLE public.minute_share_tap_daily ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.
GRANT ALL ON TABLE public.minute_share_tap_daily TO service_role;

COMMENT ON TABLE public.minute_share_tap_daily IS
  'Per-user-per-day share_tap GRANT counter (default cap 2). Distinct from '
  'recording_token_mints_daily (the 20/day MINT cap). Atomic UPSERT inside '
  'minute_grant_insert. UTC day, matching the mint counter.';

-- ── 3. minute_grant_insert v2 — per-type caps ──────────────────────────────
-- Adds three cap params (defaulted) and the referral-fraud guards. The core
-- insert/dedup/wallet-bump contract is byte-identical to Phase 1; the caps wrap
-- it. Caps apply ONLY to referral_verified / share_tap — signup_bonus, paid_topup
-- and admin_adjustment are exempt (a paid top-up must never be refused by a
-- referral cap). DROP+CREATE (not CREATE OR REPLACE) because the arg list grows:
-- the new params are defaulted so the original 7-arg named calls resolve to this.
-- No dependents: app-layer + the same-migration credit_v2 caller only (no trigger/
-- view references the old signature), so a bare DROP is safe — no CASCADE needed.
DROP FUNCTION public.minute_grant_insert(uuid, public.minute_grant_type, int, text, text, jsonb, timestamptz);

CREATE FUNCTION public.minute_grant_insert(
  p_user_id              uuid,
  p_grant_type           public.minute_grant_type,
  p_seconds              int,
  p_source_kind          text,
  p_source_key           text        DEFAULT NULL,
  p_metadata             jsonb       DEFAULT NULL,
  p_expires_at           timestamptz DEFAULT NULL,
  p_lifetime_cap_seconds int         DEFAULT 18000,  -- Σ(referral_verified+share_tap) ceiling/account
  p_velocity_24h         int         DEFAULT 10,     -- max referral_verified / rolling 24h
  p_share_tap_daily_cap  int         DEFAULT 2       -- max share_tap grants / UTC day
) RETURNS TABLE (granted boolean, reason text, grant_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role    text;
  v_new_id      bigint;
  v_lifetime    bigint;
  v_velocity    int;
  v_share_count int;
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
  IF p_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'expiring grants are not supported in v1 (wallet is non-expiring)'
      USING ERRCODE = '22023';
  END IF;

  -- ── Anti-fraud caps (referral grants only) ──────────────────────────────
  -- M1 — make the lifetime + velocity caps HARD under concurrency. They are
  -- SELECT-then-act, so without a lock two concurrent referral grants for the same
  -- account both read Σ/COUNT < cap and both insert (a burst of sock-puppet credits
  -- overshooting the ceiling). Take a row lock on the GRANTEE's profile up front so
  -- referral grants for one account serialize; different accounts never contend
  -- (and the recruiter bump in credit_v2 touches this same row, so no extra lock).
  IF p_grant_type IN ('referral_verified', 'share_tap') THEN
    PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  END IF;

  -- Lifetime: once Σ(referral_verified + share_tap) ≥ cap, refuse more of EITHER.
  IF p_grant_type IN ('referral_verified', 'share_tap') THEN
    SELECT COALESCE(SUM(seconds), 0) INTO v_lifetime
      FROM public.minute_grants
     WHERE user_id = p_user_id AND grant_type IN ('referral_verified', 'share_tap');
    IF v_lifetime >= p_lifetime_cap_seconds THEN
      RETURN QUERY SELECT false, 'lifetime_cap'::text, NULL::bigint;
      RETURN;
    END IF;
  END IF;

  -- Velocity: cap referral_verified per rolling 24h (a token-farm spraying signups).
  IF p_grant_type = 'referral_verified' THEN
    SELECT count(*) INTO v_velocity
      FROM public.minute_grants
     WHERE user_id = p_user_id AND grant_type = 'referral_verified'
       AND granted_at > now() - interval '24 hours';
    IF v_velocity >= p_velocity_24h THEN
      RETURN QUERY SELECT false, 'velocity_cap'::text, NULL::bigint;
      RETURN;
    END IF;
  END IF;

  -- Share-tap 2/day: a retry-safe dedup PRE-check (so re-granting an already-
  -- granted token doesn't burn a daily slot the unique index would otherwise
  -- no-op), then the atomic counter claim (R2-M7).
  IF p_grant_type = 'share_tap' THEN
    IF p_share_tap_daily_cap <= 0 THEN
      RETURN QUERY SELECT false, 'share_tap_daily_cap'::text, NULL::bigint;
      RETURN;
    END IF;
    IF p_source_key IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.minute_grants
       WHERE grant_type = 'share_tap' AND source_kind = p_source_kind AND source_key = p_source_key
    ) THEN
      RETURN QUERY SELECT false, 'duplicate'::text, NULL::bigint;
      RETURN;
    END IF;
    INSERT INTO public.minute_share_tap_daily (user_id, day, count)
    VALUES (p_user_id, (now() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (user_id, day) DO UPDATE
      SET count = minute_share_tap_daily.count + 1
      WHERE minute_share_tap_daily.count < p_share_tap_daily_cap
    RETURNING count INTO v_share_count;
    IF v_share_count IS NULL THEN
      RETURN QUERY SELECT false, 'share_tap_daily_cap'::text, NULL::bigint;
      RETURN;
    END IF;
  END IF;

  -- ── Insert + wallet bump (Phase-1 contract, unchanged) ──────────────────
  INSERT INTO public.minute_grants
    (user_id, grant_type, seconds, granted_at, expires_at, source_kind, source_key, metadata)
  VALUES
    (p_user_id, p_grant_type, p_seconds, now(), NULL, p_source_kind, p_source_key, p_metadata)
  ON CONFLICT (grant_type, source_kind, source_key) WHERE source_key IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_new_id;

  IF v_new_id IS NULL THEN
    -- Dedup hit. NOTE: a share_tap that reaches here already passed the EXISTS
    -- pre-check, so this is only a genuine race (concurrent same-token) — rare,
    -- and it harmlessly over-counted one share-tap slot for that user/day.
    RETURN QUERY SELECT false, 'duplicate'::text, NULL::bigint;
    RETURN;
  END IF;

  UPDATE public.profiles
     SET wallet_active_seconds = wallet_active_seconds + p_seconds
   WHERE id = p_user_id;

  RETURN QUERY SELECT true, NULL::text, v_new_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.minute_grant_insert(
  uuid, public.minute_grant_type, int, text, text, jsonb, timestamptz, int, int, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.minute_grant_insert(
  uuid, public.minute_grant_type, int, text, text, jsonb, timestamptz, int, int, int)
  TO service_role;

COMMENT ON FUNCTION public.minute_grant_insert(
  uuid, public.minute_grant_type, int, text, text, jsonb, timestamptz, int, int, int) IS
  'Sole minute_grants write path. Service-role only, idempotent, maintains '
  'wallet_active_seconds. v2 adds referral caps: lifetime Σ(referral_verified+share_tap), '
  'velocity (referral_verified/24h), share_tap 2/day — caps apply to referral grants only.';

-- ── 4. recording_referral_mint v2 — persist minter fp/ip ───────────────────
-- DROP+CREATE (arg list grows; new params defaulted so a 4-arg named call still
-- resolves). Body identical except it stores the minter fp/ip on the token row.
DROP FUNCTION public.recording_referral_mint(uuid, uuid, uuid, text);

CREATE FUNCTION public.recording_referral_mint(
  p_user        uuid,
  p_creator     uuid,
  p_clip        uuid,
  p_token_hash  text,
  p_device_fp   text DEFAULT NULL,
  p_ip_prefix   text DEFAULT NULL
) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_cap   int;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_count int;
BEGIN
  SELECT recording_share_daily_cap INTO v_cap FROM public.profiles WHERE id = p_user;
  IF v_cap IS NULL THEN
    RAISE EXCEPTION 'profile_not_found' USING ERRCODE = '42704';
  END IF;
  IF v_cap <= 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.recording_token_mints_daily (user_id, day, count)
    VALUES (p_user, v_today, 1)
    ON CONFLICT (user_id, day) DO UPDATE
      SET count = recording_token_mints_daily.count + 1
      WHERE recording_token_mints_daily.count < v_cap
    RETURNING count INTO v_count;
  IF v_count IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.referral_tokens (token_hash, user_id, creator_id, clip_id, minter_device_fp, minter_ip_prefix)
    VALUES (p_token_hash, p_user, p_creator, p_clip, p_device_fp, p_ip_prefix);

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.recording_referral_mint(uuid, uuid, uuid, text, text, text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recording_referral_mint(uuid, uuid, uuid, text, text, text)
  TO service_role;

COMMENT ON FUNCTION public.recording_referral_mint(uuid, uuid, uuid, text, text, text) IS
  'Mints a referral token if under the daily cap; persists the minter fp/ip (R2-M4). '
  'Returns false on cap hit. Service-role only.';

-- ── 5. recording_referral_credit_first_session_v2 — one RPC, one txn ───────
-- R1-M4: credit + BOTH grants + recruiter bump atomically, so a partial failure
-- can't leave a credited redemption with no grant. Returns a structured row so
-- the route emits accurate PostHog (today it only knows a boolean).
--
-- M5 — DROP the v1 credit RPC now that nothing calls it (the route switched to
-- _v2; verified zero app/test references). Leaving it is a FOOTGUN: v1 has NO
-- self-referral guard and grants nothing, but it DOES insert a 'first_session'
-- redemption — which would make _v2's already-credited check return early and
-- permanently SUPPRESS the real grants for that user+token. One credit RPC only.
DROP FUNCTION public.recording_referral_credit_first_session(text, uuid, text, text);

CREATE FUNCTION public.recording_referral_credit_first_session_v2(
  p_token_hash             text,
  p_new_user               uuid,
  p_device_fp              text,
  p_ip_prefix              text,
  p_referrer_bonus_seconds int DEFAULT 900,
  p_welcome_bonus_seconds  int DEFAULT 900,
  p_recruiter_per_signup   int DEFAULT 60,
  p_recruiter_ceiling      int DEFAULT 1800,
  p_lifetime_cap_seconds   int DEFAULT 18000,
  p_velocity_24h           int DEFAULT 10
) RETURNS TABLE (
  credited         boolean,
  referrer_granted boolean,
  welcome_granted  boolean,
  recruiter_bumped boolean,
  reason           text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role  text;
  v_valid     boolean;
  v_referrer  uuid;
  v_minter_fp text;
  v_minter_ip text;
  v_already   int;
  v_sockpuppet boolean := false;
  v_ref_granted boolean := false;
  v_wel_granted boolean := false;
  v_bumped    boolean := false;
  v_old_bonus int;
  v_new_bonus int;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'recording_referral_credit_first_session_v2 is service-role only' USING ERRCODE = '42501';
  END IF;

  SELECT (expires_at > now()), user_id, minter_device_fp, minter_ip_prefix
    INTO v_valid, v_referrer, v_minter_fp, v_minter_ip
    FROM public.referral_tokens WHERE token_hash = p_token_hash;
  IF v_valid IS NULL OR NOT v_valid THEN
    RETURN QUERY SELECT false, false, false, false, 'token_invalid'::text;
    RETURN;
  END IF;

  -- R1-C4 — self-referral: the minter signing up under their own token. No
  -- credit, no grants, no bump.
  IF v_referrer = p_new_user THEN
    RETURN QUERY SELECT false, false, false, false, 'self_referral'::text;
    RETURN;
  END IF;

  -- Idempotent: already credited this token for this user? (A token converts one
  -- first_session per the redemption unique constraint.)
  SELECT count(*) INTO v_already
    FROM public.referral_redemptions
   WHERE token_hash = p_token_hash AND new_user_id = p_new_user AND credit_event = 'first_session';
  IF v_already > 0 THEN
    RETURN QUERY SELECT false, false, false, false, 'already_credited'::text;
    RETURN;
  END IF;

  -- The credit.
  INSERT INTO public.referral_redemptions
    (token_hash, new_user_id, device_fp, ip_prefix, credit_event)
    VALUES (p_token_hash, p_new_user, p_device_fp, p_ip_prefix, 'first_session')
    ON CONFLICT DO NOTHING;

  -- Referrer grant — referral_verified, deduped on the token_hash (one verified-
  -- signup grant per token). lifetime + velocity capped. (The trailing `2` is the
  -- share_tap_daily_cap arg — INERT here: minute_grant_insert only consults it for
  -- grant_type='share_tap'. Positional, so it can't be omitted past lifetime/velocity.)
  SELECT mg.granted INTO v_ref_granted
    FROM public.minute_grant_insert(
      v_referrer, 'referral_verified', p_referrer_bonus_seconds, 'referral_token', p_token_hash,
      jsonb_build_object('new_user', p_new_user), NULL,
      p_lifetime_cap_seconds, p_velocity_24h, 2) mg;

  -- New-user welcome — signup_bonus, deduped on 'signup:'||uid (one welcome per
  -- user ever; the universal-welcome path in onboarding shares this key, so a
  -- referred user never double-grants).
  SELECT mg.granted INTO v_wel_granted
    FROM public.minute_grant_insert(
      p_new_user, 'signup_bonus', p_welcome_bonus_seconds, 'signup', 'signup:' || p_new_user::text,
      jsonb_build_object('referred_by_token', true), NULL,
      p_lifetime_cap_seconds, p_velocity_24h, 2) mg;

  -- Recruiter bump — sock-puppet guard (R2-M4): skip when the new user's fp OR ip
  -- matches the token MINTER's (a referrer self-referring behind incognito/VPN).
  -- The bump raises USABLE daily allowance (recruiter_bonus_daily_seconds), bounded
  -- by the ceiling; it does NOT uncap the 150% COGS fuse beyond the absolute ceiling
  -- (R1-M7 / R2-C1 — daily_cap_eff is bounded at session-open).
  -- NOTE (audit Small): an IP-only match suppresses the bump for two legit users
  -- behind the SAME NAT (dorm/cafe) — a false-negative on the bump, NEVER a false
  -- credit. Intended (the documented dorm-room tradeoff).
  v_sockpuppet := (v_minter_fp IS NOT NULL AND v_minter_fp = p_device_fp)
               OR (v_minter_ip IS NOT NULL AND v_minter_ip = p_ip_prefix);
  IF NOT v_sockpuppet AND p_recruiter_per_signup > 0 THEN
    -- M2 — report recruiter_bumped only when the value actually ROSE. FOUND would
    -- be true even at the ceiling (a no-op LEAST), inflating the growth dashboard.
    SELECT recruiter_bonus_daily_seconds INTO v_old_bonus FROM public.profiles WHERE id = v_referrer;
    UPDATE public.profiles
       SET recruiter_bonus_daily_seconds =
             LEAST(p_recruiter_ceiling, recruiter_bonus_daily_seconds + p_recruiter_per_signup)
     WHERE id = v_referrer
    RETURNING recruiter_bonus_daily_seconds INTO v_new_bonus;
    v_bumped := (v_new_bonus IS NOT NULL AND v_old_bonus IS NOT NULL AND v_new_bonus > v_old_bonus);
  END IF;

  RETURN QUERY SELECT true, v_ref_granted, v_wel_granted, v_bumped,
    CASE WHEN v_sockpuppet THEN 'credited_sockpuppet_no_bump'::text ELSE NULL::text END;
END;$$;

REVOKE EXECUTE ON FUNCTION public.recording_referral_credit_first_session_v2(
  text, uuid, text, text, int, int, int, int, int, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recording_referral_credit_first_session_v2(
  text, uuid, text, text, int, int, int, int, int, int)
  TO service_role;

COMMENT ON FUNCTION public.recording_referral_credit_first_session_v2(
  text, uuid, text, text, int, int, int, int, int, int) IS
  'Atomic referral credit (R1-M4): first_session redemption + referrer '
  'referral_verified grant + new-user signup_bonus welcome + recruiter bump, with '
  'the self-referral (R1-C4) and sock-puppet (R2-M4) guards. Returns '
  '{credited, referrer_granted, welcome_granted, recruiter_bumped, reason}. Service-role only.';

COMMIT;
