-- 0056 — voice_usage_daily / voice_usage_weekly + ticket-check RPC
--
-- Days 8–12 plan REV 5.2, migration 12 of 12. Pipeline α' minutes-per-day
-- enforcement layer.
--
-- THREE-table design:
--   public.voice_usage_turns   — (user_id, session_id, turn_number)  → idempotency key
--   public.voice_usage_daily   — (user_id, day)                       → seconds_used
--   public.voice_usage_weekly  — (user_id, iso_week_mon)              → seconds_used
--
-- WHY the turn-idempotency table (C2 from REV 5.1 audit):
--   The proxy flushes usage at turn-end. A transient Postgres error + proxy
--   retry would additively upsert the same p_seconds twice, silently halving
--   the user's effective cap. cogs_insert_turn_voice dedupes via partial
--   unique index on (session_id, turn_number, service, operation). The cap
--   counter needs the same treatment but at a coarser grain — one dedup
--   key per turn (not per leg) — so we use a dedicated PK table. The RPC
--   INSERT..ON CONFLICT DO NOTHING and only updates counters when the insert
--   claimed the row, making voice_usage_record exactly-once-per-turn.
--
-- WHY two counter tables (daily + weekly, not SUM(cogs_log) at mint-time):
--   cogs_log grows forever and becomes a fat aggregate at 100K+ DAU. A
--   2-column-keyed O(1) upsert on every turn flush scales to any DAU. A
--   2-column-keyed O(1) lookup at ticket-mint scales to any DAU.
--
-- WHY "seconds" as the currency (not turns / cost):
--   The minutes-per-day cap is the user-facing contract. Cartesia
--   voice_tts_audio_seconds (leg 4 of cogs_insert_turn_voice) is the
--   authoritative meter — it's the audio the user actually heard. We mirror
--   that value into this table so the ticket-mint path doesn't have to read
--   cogs_log at all.
--
-- WHY three caps (daily, weekly, monthly):
--   - daily: baseline gate. Free = 300s (5 min). Non-negotiable.
--   - weekly: funnel lever. Free = 900s (15 min). Flattens binge users;
--             when user hits weekly cap in 3 days it's a natural upgrade moment.
--   - monthly: paid-tier cap. Pro = 9900s (165 min), Premium = bigger, etc.
--              NULL = unlimited (boardroom / admin).
--
-- The ticket-mint RPC returns remaining seconds under ALL caps; proxy
-- picks min() and clamps session length to that.

-- 1. profiles voice cap columns --------------------------------------------
-- Separate columns (not jsonb) so CHECK constraints work and the indexable
-- defaults are explicit. jsonb was considered and rejected as over-flexible
-- for a feature that's going to have exactly 3 knobs for the next year.

ALTER TABLE public.profiles
  ADD COLUMN voice_daily_cap_seconds   int NOT NULL DEFAULT 300
    CHECK (voice_daily_cap_seconds BETWEEN 0 AND 86400),
  ADD COLUMN voice_weekly_cap_seconds  int          DEFAULT 900
    CHECK (voice_weekly_cap_seconds IS NULL OR voice_weekly_cap_seconds BETWEEN 0 AND 604800),
  ADD COLUMN voice_monthly_cap_seconds int
    CHECK (voice_monthly_cap_seconds IS NULL OR voice_monthly_cap_seconds BETWEEN 0 AND 2678400);

COMMENT ON COLUMN public.profiles.voice_daily_cap_seconds IS
  'Hard daily cap on voice TTS audio seconds. 300 = 5 min (free default). NEVER reduce below current value for existing users.';
COMMENT ON COLUMN public.profiles.voice_weekly_cap_seconds IS
  'Hard weekly cap on voice TTS audio seconds. NULL = no weekly limit (disabled, NOT zero). 900 = 15 min (free default). Admin flip to NULL explicitly to lift the cap.';
COMMENT ON COLUMN public.profiles.voice_monthly_cap_seconds IS
  'Hard monthly cap on voice TTS audio seconds. NULL = unlimited (boardroom / admin). Set explicitly on paid tiers.';

-- 2. voice_usage_turns: idempotency key for voice_usage_record -------------
-- Audit C2 fix. One row per voice turn; serves as the "was this turn already
-- counted?" sentinel. Small rows, grow linearly with turns (~1M rows/year at
-- 10K DAU × 100 turns/day), no RLS policies, service-role writes only.

CREATE TABLE public.voice_usage_turns (
  user_id       uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  session_id    uuid        NOT NULL,
  turn_number   int         NOT NULL CHECK (turn_number > 0),
  seconds_used  numeric(12,4) NOT NULL CHECK (seconds_used >= 0),
  day           date        NOT NULL,
  iso_week_mon  date        NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id, turn_number)
);

CREATE INDEX voice_usage_turns_session_idx
  ON public.voice_usage_turns (session_id, turn_number);

ALTER TABLE public.voice_usage_turns ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only (proxy writes, admin reads via separate RPC).

COMMENT ON TABLE public.voice_usage_turns IS
  'Idempotency ledger for voice_usage_record. One row per voice turn. PK on (user_id, session_id, turn_number) guarantees a duplicate RPC call from a proxy retry is a no-op, preventing double-counting of minutes-per-day.';

-- 3. voice_usage_daily -----------------------------------------------------
-- (user_id, day) key. Day is the user's local calendar day at the moment the
-- turn STARTED (not when it flushed) — audit M4. A turn that begins at 23:58
-- and ends at 00:05 books to the day it began, which matches how users mentally
-- attribute usage.

CREATE TABLE public.voice_usage_daily (
  user_id       uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day           date        NOT NULL,
  seconds_used  numeric(12,4) NOT NULL DEFAULT 0 CHECK (seconds_used >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

-- Plain btree on (day) supports admin-dashboard range scans ("usage per day,
-- last 7 days"). No partial predicate — current_date is STABLE not IMMUTABLE
-- and would be rejected; more importantly a partial predicate freezes the
-- boundary at CREATE INDEX time and silently drifts out of relevance.
CREATE INDEX voice_usage_daily_day_idx
  ON public.voice_usage_daily (day);

ALTER TABLE public.voice_usage_daily ENABLE ROW LEVEL SECURITY;
-- Service-role only (proxy-side upserts + RPC reads). No policies.

-- 4. voice_usage_weekly ----------------------------------------------------
-- iso_week_mon stored as date = the Monday of the ISO week containing the turn.
-- Same PK shape as voice_usage_daily for consistency.

CREATE TABLE public.voice_usage_weekly (
  user_id       uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  iso_week_mon  date        NOT NULL,
  seconds_used  numeric(12,4) NOT NULL DEFAULT 0 CHECK (seconds_used >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, iso_week_mon)
);

ALTER TABLE public.voice_usage_weekly ENABLE ROW LEVEL SECURITY;

-- 5. voice_usage_record: atomic exactly-once upsert after each voice turn --
-- Signature-change vs REV 5.1: adds p_session_id, p_turn_number,
-- p_turn_started_at for idempotency + correct day bucketing (audit C2 + M4).
--
-- Call pattern from Fly proxy at turn-end:
--   PERFORM public.voice_usage_record(
--     user_id, session_id, turn_number, cartesia_audio_seconds, turn_started_at);
--
-- The RPC:
--   1. Inserts a row into voice_usage_turns with INSERT..ON CONFLICT DO
--      NOTHING RETURNING 1. If the insert was a no-op (turn already counted),
--      returns immediately — retry is safe.
--   2. Only if the idempotency row was claimed, upserts the daily + weekly
--      counters. Day/week derived from p_turn_started_at (or now() if NULL)
--      in the user's timezone.

CREATE FUNCTION public.voice_usage_record(
  p_user_id          uuid,
  p_session_id       uuid,
  p_turn_number      int,
  p_seconds          numeric,
  p_turn_started_at  timestamptz DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role   text;
  v_tz         text;
  v_anchor_ts  timestamptz;
  v_day        date;
  v_week_mon   date;
  v_rowcount   int := 0;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
      RAISE EXCEPTION 'caller cannot record voice usage for another user'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_turn_number IS NULL OR p_turn_number <= 0 THEN
    RAISE EXCEPTION 'turn_number must be positive' USING ERRCODE = '22003';
  END IF;
  IF p_seconds IS NULL OR p_seconds < 0 OR p_seconds > 3600 THEN
    RAISE EXCEPTION 'seconds out of range [0, 3600]' USING ERRCODE = '22003';
  END IF;

  SELECT COALESCE(timezone, 'UTC') INTO v_tz FROM public.profiles WHERE id = p_user_id;
  IF v_tz IS NULL THEN v_tz := 'UTC'; END IF;

  -- Day bucketing: anchor to turn start, not flush time. A 23:58 → 00:05
  -- turn books to the day it started — matches user intuition and admin
  -- "usage per day" reports.
  v_anchor_ts := COALESCE(p_turn_started_at, now());
  v_day       := (v_anchor_ts AT TIME ZONE v_tz)::date;
  v_week_mon  := date_trunc('week', v_day)::date;

  -- Claim the turn. If a prior call already claimed it, return false so the
  -- caller knows the counters were not touched this time. The counters MUST
  -- only be incremented when we successfully claimed.
  INSERT INTO public.voice_usage_turns
    (user_id, session_id, turn_number, seconds_used, day, iso_week_mon, recorded_at)
  VALUES
    (p_user_id, p_session_id, p_turn_number, p_seconds, v_day, v_week_mon, now())
  ON CONFLICT (user_id, session_id, turn_number) DO NOTHING;

  GET DIAGNOSTICS v_rowcount = ROW_COUNT;
  IF v_rowcount = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.voice_usage_daily (user_id, day, seconds_used, updated_at)
  VALUES (p_user_id, v_day, p_seconds, now())
  ON CONFLICT (user_id, day) DO UPDATE
    SET seconds_used = voice_usage_daily.seconds_used + EXCLUDED.seconds_used,
        updated_at   = now();

  INSERT INTO public.voice_usage_weekly (user_id, iso_week_mon, seconds_used, updated_at)
  VALUES (p_user_id, v_week_mon, p_seconds, now())
  ON CONFLICT (user_id, iso_week_mon) DO UPDATE
    SET seconds_used = voice_usage_weekly.seconds_used + EXCLUDED.seconds_used,
        updated_at   = now();

  RETURN true;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_usage_record(uuid, uuid, int, numeric, timestamptz)
  FROM public, anon, authenticated;

COMMENT ON FUNCTION public.voice_usage_record(uuid, uuid, int, numeric, timestamptz) IS
  'Exactly-once voice-usage counter update. Returns true if counters incremented, false if turn was already recorded (proxy retry). Day/week buckets anchored to p_turn_started_at (falls back to now()).';

-- 6. voice_usage_ticket_check: called at session-open ticket-mint time -----
-- Returns the minimum remaining seconds across daily / weekly / monthly
-- caps. Monthly is computed from SUM(voice_usage_daily) over the current
-- month — rare read path (once per ticket mint), and the PK (user_id, day)
-- already makes this an index-only scan over ≤31 rows.

CREATE FUNCTION public.voice_usage_ticket_check(p_user_id uuid)
RETURNS TABLE (
  remaining_seconds     int,
  daily_used            numeric,
  daily_cap             int,
  weekly_used           numeric,
  weekly_cap            int,
  monthly_used          numeric,
  monthly_cap           int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role    text;
  v_tz          text;
  v_day         date;
  v_week_mon    date;
  v_month_start date;
  v_daily_cap   int;
  v_weekly_cap  int;
  v_monthly_cap int;
  v_daily_used  numeric;
  v_weekly_used numeric;
  v_monthly_used numeric;
  v_remaining   int;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
      RAISE EXCEPTION 'caller cannot check voice usage for another user'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT COALESCE(timezone, 'UTC'),
         voice_daily_cap_seconds,
         voice_weekly_cap_seconds,
         voice_monthly_cap_seconds
    INTO v_tz, v_daily_cap, v_weekly_cap, v_monthly_cap
    FROM public.profiles
   WHERE id = p_user_id;

  IF v_daily_cap IS NULL THEN
    RAISE EXCEPTION 'user % not found', p_user_id USING ERRCODE = 'P0002';
  END IF;

  v_day         := (now() AT TIME ZONE v_tz)::date;
  v_week_mon    := date_trunc('week', v_day)::date;
  v_month_start := date_trunc('month', v_day)::date;

  SELECT COALESCE(seconds_used, 0) INTO v_daily_used
    FROM public.voice_usage_daily
   WHERE user_id = p_user_id AND day = v_day;
  v_daily_used := COALESCE(v_daily_used, 0);

  SELECT COALESCE(seconds_used, 0) INTO v_weekly_used
    FROM public.voice_usage_weekly
   WHERE user_id = p_user_id AND iso_week_mon = v_week_mon;
  v_weekly_used := COALESCE(v_weekly_used, 0);

  SELECT COALESCE(SUM(seconds_used), 0) INTO v_monthly_used
    FROM public.voice_usage_daily
   WHERE user_id = p_user_id AND day >= v_month_start;

  -- remaining = min(cap - used) across enabled caps. NULL cap = unlimited.
  -- FLOOR (not cast-round) on used values so fractional-second usage never
  -- rounds up into denying a user the last half-second of their quota
  -- (audit S2).
  v_remaining := GREATEST(0, v_daily_cap - FLOOR(v_daily_used)::int);
  IF v_weekly_cap IS NOT NULL THEN
    v_remaining := LEAST(v_remaining, GREATEST(0, v_weekly_cap - FLOOR(v_weekly_used)::int));
  END IF;
  IF v_monthly_cap IS NOT NULL THEN
    v_remaining := LEAST(v_remaining, GREATEST(0, v_monthly_cap - FLOOR(v_monthly_used)::int));
  END IF;

  RETURN QUERY SELECT
    v_remaining,
    v_daily_used,
    v_daily_cap,
    v_weekly_used,
    v_weekly_cap,
    v_monthly_used,
    v_monthly_cap;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_usage_ticket_check(uuid)
  FROM public, anon, authenticated;

-- 7. Append-only discipline for usage tables -------------------------------
-- All three tables are service-role-only (no RLS policies). The idempotency
-- table is insert-only in practice (no path updates it). The counter tables
-- are INSERT + ON CONFLICT UPDATE within the RPC — no trigger blocks needed.
