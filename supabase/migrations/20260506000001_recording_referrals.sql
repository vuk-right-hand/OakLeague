-- Day 4 — recording referral system + per-user mint rate limit.
--
-- REACT_DUET_PLAN §8a + §23.7-8 + §NEW-C1.
--
-- Tables:
--   referral_tokens               — HMAC token registry, 90-day TTL
--   referral_redemptions          — credit events (landing / first_session / first_paid)
--   recording_token_mints_daily   — per-user-per-day cap on referral mints (NEW-C1 fix)
--
-- All three are service-role-only (RLS enabled, ZERO policies). Reads happen
-- exclusively via server actions / route handlers using the service-role key.
-- The client never queries these directly.
--
-- HMAC strategy: client receives a base32 plaintext token; server stores
-- only hmac_sha256(secret, plaintext). Validation does a timing-safe compare
-- of the recomputed HMAC against the stored hash. Rotation: secrets are
-- env-driven (RECORDING_REFERRAL_HMAC_SECRET_CURRENT / _NEXT) and BOTH are
-- tried on validation, mirroring the invite-tokens pattern in
-- src/lib/invite-tokens.ts. Keeps token rotation a config flip, not a backfill.

-- 1. referral_tokens -------------------------------------------------------
-- token_hash is the HMAC of the plaintext (server never stores plaintext).
-- creator_id / clip_id / recording_id are advisory — used to power the
-- "@vuk gets credit for inviting you" toast and a future creator-drawer
-- redirect. None of them are required to mint a token because we don't yet
-- know the recording_id at mint-time (the user just tapped React, no blob
-- exists). These columns are populated by /api/recording/finalize (Day 5)
-- once the blob lands.

CREATE TABLE public.referral_tokens (
  token_hash       text         NOT NULL PRIMARY KEY,
  user_id          uuid         NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  creator_id       uuid         REFERENCES public.creators(id) ON DELETE SET NULL,
  clip_id          uuid,                                        -- hooks.id or videos.id; FK omitted (cross-table)
  recording_id     uuid,                                        -- bound at finalize-time, Day 5
  created_at       timestamptz  NOT NULL DEFAULT now(),
  expires_at       timestamptz  NOT NULL DEFAULT now() + interval '90 days',
  redeemed_count   int          NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
  last_redeemed_at timestamptz
);

ALTER TABLE public.referral_tokens ENABLE ROW LEVEL SECURITY;
-- ZERO policies — service-role-only.

COMMENT ON TABLE public.referral_tokens IS
  'HMAC referral tokens minted at recording arm. token_hash stored, plaintext returned to client once. Service-role-only — no RLS policies.';

CREATE INDEX referral_tokens_user_id_created_at_idx
  ON public.referral_tokens (user_id, created_at DESC);
CREATE INDEX referral_tokens_expires_at_idx
  ON public.referral_tokens (expires_at);
-- Was: WHERE expires_at > now(). Postgres rejects now() in index predicates
-- (functions in index predicate must be marked IMMUTABLE — now() is STABLE).
-- Full index is functionally equivalent for active-token lookups at our scale;
-- expired entries grow linearly but are pruned by future GC sweeps.

-- 2. referral_redemptions --------------------------------------------------
-- Credit events: landing / first_session / first_paid.
--
-- device_fp + ip_prefix are stored for fraud review only — NOT enforced.
-- Plan §8a: "avoids dorm-room false positives." Audit M7 Day 4 added
-- cookie_set_ok for post-mortem analysis of Safari ITP / private-mode
-- patterns where a cookie write silently fails and orphans the redemption.

CREATE TABLE public.referral_redemptions (
  id           uuid         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text         NOT NULL REFERENCES public.referral_tokens(token_hash) ON DELETE CASCADE,
  new_user_id  uuid         REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- new_user_id NULLable for credit_event='landing' on visitors who haven't
  -- signed in yet. The cookie is set anyway; the redemption row is upgraded
  -- (matched by token_hash + cookie's session_token, written into device_fp
  -- when /api/sessions/open promotes a landing → first_session).
  device_fp    text         NOT NULL,
  ip_prefix    text         NOT NULL,
  redeemed_at  timestamptz  NOT NULL DEFAULT now(),
  credit_event text         NOT NULL CHECK (credit_event IN ('landing','first_session','first_paid')),
  cookie_set_ok boolean     NOT NULL DEFAULT true,
  -- (token_hash, new_user_id, credit_event) is the dedup key for credit_event
  -- in {first_session, first_paid}. For landing, new_user_id may be null;
  -- we dedup on (token_hash, device_fp, credit_event='landing') instead via
  -- the partial unique index below.
  CONSTRAINT referral_redemptions_user_event_unique
    UNIQUE NULLS NOT DISTINCT (token_hash, new_user_id, credit_event)
);

ALTER TABLE public.referral_redemptions ENABLE ROW LEVEL SECURITY;
-- ZERO policies — service-role-only.

COMMENT ON TABLE public.referral_redemptions IS
  'Credit events for referral_tokens. landing fires from /r/[token]; first_session from /api/sessions/open. Service-role-only.';

CREATE INDEX referral_redemptions_token_hash_idx
  ON public.referral_redemptions (token_hash);
-- For the /api/sessions/open first-session lookup (audit Small Day 4):
CREATE INDEX referral_redemptions_user_event_idx
  ON public.referral_redemptions (new_user_id, credit_event)
  WHERE new_user_id IS NOT NULL;

-- Anonymous landing dedup — same device hitting the link 100× shouldn't
-- create 100 landing rows. Partial unique on (token_hash, device_fp) WHERE
-- credit_event='landing' AND new_user_id IS NULL.
CREATE UNIQUE INDEX referral_redemptions_landing_anon_unique_idx
  ON public.referral_redemptions (token_hash, device_fp)
  WHERE credit_event = 'landing' AND new_user_id IS NULL;

-- 3. recording_token_mints_daily -------------------------------------------
-- Per-user-per-day mint cap (audit NEW-C1 / M2 Day 4). Reuses the
-- voice_usage_daily idempotent-upsert pattern. Cap default 20/day; admin
-- can flip per-user via profiles.recording_share_daily_cap (added below).

CREATE TABLE public.recording_token_mints_daily (
  user_id  uuid         NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day      date         NOT NULL,
  count    int          NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (user_id, day)
);

ALTER TABLE public.recording_token_mints_daily ENABLE ROW LEVEL SECURITY;
-- ZERO policies — service-role-only.

COMMENT ON TABLE public.recording_token_mints_daily IS
  'Per-user-per-day referral token mint cap. NEW-C1 anti-bot. Default 20/day; profiles.recording_share_daily_cap overrides.';

ALTER TABLE public.profiles
  ADD COLUMN recording_share_daily_cap int NOT NULL DEFAULT 20
    CHECK (recording_share_daily_cap BETWEEN 0 AND 1000);

COMMENT ON COLUMN public.profiles.recording_share_daily_cap IS
  'Per-day cap on referral_tokens mints. 20 = baseline; admin flip up for power users (creators promoting many duets in a day).';
