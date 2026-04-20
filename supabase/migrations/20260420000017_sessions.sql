-- 0017 — sessions
-- Per-session tier snapshot (no mid-session swap). Kill-switch latch checked
-- at open via sessions_enforce_tier_and_kill_switch (SECURITY DEFINER).
-- quota_date computed in user-local tz (R6-C2).

CREATE TABLE public.sessions (
  id               uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid           NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  creator_id       uuid           NOT NULL REFERENCES public.creators(id)  ON DELETE CASCADE,
  hook_id          uuid           REFERENCES public.hooks(id) ON DELETE SET NULL,
  livekit_room_id  text,
  model_used       voice_model    NOT NULL,
  tier_at_session  profile_tier   NOT NULL,
  status           session_status NOT NULL DEFAULT 'starting',
  end_reason       text           CHECK (end_reason IS NULL OR char_length(end_reason) <= 200),
  started_at       timestamptz    NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  active_seconds   int            NOT NULL DEFAULT 0 CHECK (active_seconds >= 0),
  total_cost_usd   numeric(10,4)  NOT NULL DEFAULT 0 CHECK (total_cost_usd >= 0),
  created_at       timestamptz    NOT NULL DEFAULT now(),
  updated_at       timestamptz    NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX sessions_user_idx        ON public.sessions (user_id, started_at DESC);
CREATE INDEX sessions_creator_idx     ON public.sessions (creator_id, started_at DESC);
CREATE INDEX sessions_status_idx      ON public.sessions (status) WHERE status IN ('starting','active');

CREATE TRIGGER sessions_touch_updated_at
  BEFORE UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- At session open: snapshot tier, ensure today's quota row exists
-- (keyed on user-local date, R6-C2), and raise if the kill-switch is already
-- latched. Tier is locked for the session's full duration.

CREATE FUNCTION public.sessions_enforce_tier_and_kill_switch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tier       profile_tier;
  v_tz         text;
  v_limit_s    int;
  v_local_date date;
  v_latched    boolean;
BEGIN
  SELECT tier, timezone INTO v_tier, v_tz
    FROM public.profiles WHERE id = NEW.user_id;
  IF v_tier IS NULL THEN
    RAISE EXCEPTION 'sessions.user_id % has no profile', NEW.user_id USING ERRCODE = '23503';
  END IF;

  -- Snapshot tier onto the session row.
  NEW.tier_at_session := v_tier;

  -- Tier → daily limit in seconds. Free = 10min, premium = 60min, boardroom = 240min.
  v_limit_s := CASE v_tier
    WHEN 'free'      THEN 600
    WHEN 'premium'   THEN 3600
    WHEN 'boardroom' THEN 14400
  END;

  v_local_date := (now() AT TIME ZONE v_tz)::date;

  -- Fast pre-check: already latched?
  SELECT kill_switch_fired_at IS NOT NULL INTO v_latched
    FROM public.daily_quotas
   WHERE user_id = NEW.user_id AND quota_date = v_local_date;
  IF v_latched THEN
    RAISE EXCEPTION 'kill_switch_fired'
      USING HINT    = 'daily quota latched; admin must clear to unlock',
            ERRCODE = 'P0001';
  END IF;

  -- Upsert today's quota row. ON CONFLICT skips latched rows (R5-S2).
  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s)
  VALUES (NEW.user_id, v_local_date, v_tier, v_limit_s)
  ON CONFLICT (user_id, quota_date)
  DO UPDATE SET
    daily_limit_s = EXCLUDED.daily_limit_s,
    tier_snapshot = EXCLUDED.tier_snapshot
  WHERE public.daily_quotas.kill_switch_fired_at IS NULL;

  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.sessions_enforce_tier_and_kill_switch() FROM public;

CREATE TRIGGER sessions_enforce_tier_and_kill_switch
  BEFORE INSERT ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.sessions_enforce_tier_and_kill_switch();

-- RLS ---------------------------------------------------------------------

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sessions own read"
  ON public.sessions FOR SELECT
  USING (user_id = auth.uid());
-- INSERT/UPDATE/DELETE go via service-role (voice service).
