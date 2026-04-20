-- 0018 — session_turns
-- Single merged BEFORE INSERT trigger (R4-S4): populates user_id from the
-- parent session and enforces the kill-switch latch keyed on the SESSION
-- START DAY in USER-LOCAL time (R4-M1 + R6-C2). Nothing in the trigger
-- persists — the voice service reacts to P0001 out-of-band.

CREATE TABLE public.session_turns (
  id                       uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               uuid              NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id                  uuid              NOT NULL REFERENCES public.profiles(id)  ON DELETE CASCADE,
  turn_number              int               NOT NULL CHECK (turn_number > 0),
  role                     session_turn_role NOT NULL,
  transcript               text              CHECK (transcript IS NULL OR char_length(transcript) <= 8192),
  user_audio_duration_ms   int               CHECK (user_audio_duration_ms IS NULL OR user_audio_duration_ms >= 0),
  llm_input_tokens         int               CHECK (llm_input_tokens        IS NULL OR llm_input_tokens        >= 0),
  llm_output_tokens        int               CHECK (llm_output_tokens       IS NULL OR llm_output_tokens       >= 0),
  llm_cache_hit            boolean,
  tts_characters           int               CHECK (tts_characters          IS NULL OR tts_characters          >= 0),
  avatar_seconds           numeric(8,3)      CHECK (avatar_seconds          IS NULL OR avatar_seconds          >= 0),
  cost_breakdown           jsonb             CHECK (cost_breakdown IS NULL OR octet_length(cost_breakdown::text) <= 4096),
  created_at               timestamptz       NOT NULL DEFAULT now(),
  UNIQUE (session_id, turn_number)
);

CREATE INDEX session_turns_session_idx ON public.session_turns (session_id, turn_number);
CREATE INDEX session_turns_user_idx    ON public.session_turns (user_id, created_at DESC);

-- Single merged BEFORE INSERT trigger (R4-S4 + R6-C2) -----------------------

CREATE FUNCTION public.session_turns_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_session record;
  v_quota   record;
BEGIN
  -- Part 1: populate/validate user_id from the parent session; capture tz for
  -- the kill-switch date math.
  SELECT s.user_id, s.started_at, s.tier_at_session, p.timezone
    INTO v_session
    FROM public.sessions s
    JOIN public.profiles p ON p.id = s.user_id
   WHERE s.id = NEW.session_id;

  IF v_session.user_id IS NULL THEN
    RAISE EXCEPTION 'session % not found', NEW.session_id USING ERRCODE = '23503';
  END IF;

  IF NEW.user_id IS NULL THEN
    NEW.user_id := v_session.user_id;
  ELSIF NEW.user_id <> v_session.user_id THEN
    RAISE EXCEPTION 'session_turns.user_id (%) does not match sessions.user_id (%)',
      NEW.user_id, v_session.user_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Part 2: kill-switch enforcement keyed on the session's starting
  -- user-local day (R4-M1 + R6-C2). Cross-midnight sessions check the day
  -- they opened on, not current_date.
  SELECT seconds_used, daily_limit_s, kill_switch_fired_at
    INTO v_quota
    FROM public.daily_quotas
   WHERE user_id    = v_session.user_id
     AND quota_date = (v_session.started_at AT TIME ZONE v_session.timezone)::date;

  IF FOUND AND (
       v_quota.kill_switch_fired_at IS NOT NULL
    OR v_quota.seconds_used >= (v_quota.daily_limit_s * 3) / 2
  ) THEN
    -- Nothing in this trigger persists. RAISE rolls back the turn insert.
    -- Voice service catches P0001 and issues its own
    -- UPDATE sessions SET status='ending', end_reason='kill_switch'
    -- in a separate transaction.
    RAISE EXCEPTION 'kill_switch_fired'
      USING HINT    = 'voice service: UPDATE sessions SET status=''ending'', end_reason=''kill_switch'' out-of-band',
            ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.session_turns_guard() FROM public;

CREATE TRIGGER session_turns_guard
  BEFORE INSERT ON public.session_turns
  FOR EACH ROW EXECUTE FUNCTION public.session_turns_guard();

-- RLS ---------------------------------------------------------------------

ALTER TABLE public.session_turns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "session_turns own read"
  ON public.session_turns FOR SELECT
  USING (user_id = auth.uid());
-- Writes via service-role only.
