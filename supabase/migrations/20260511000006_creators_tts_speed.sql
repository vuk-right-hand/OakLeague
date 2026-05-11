-- 20260511000006 — creators.tts_speed + voice_tickets.tts_speed
--
-- Creator-tunable Cartesia Sonic 3 playback speed. Stored as the literal
-- Cartesia API value (multiplier in [0.6, 1.5], default 1.0 = no-op).
-- Rides voice_tickets at session-open → proxy → cartesia-bridge, which
-- inserts it into the `generation_config.speed` field on each sendText
-- / turnEnd message.
--
-- Why this column vs. an env var or per-tier setting:
--   * Each creator's natural speech cadence + clone fidelity differs;
--     a global "slow everyone 15%" causes some clones to sound sluggish
--     and others to still feel rushed. Per-creator dial is the right
--     abstraction.
--   * Surfaced to the creator via /creator/voice — a slider with three
--     preset chips (0.85 / 1.0 / 1.15) and a Check Speech button that
--     synthesizes ~7s of audio at the current value so the creator
--     HEARS the change before saving.
--
-- Audit-driven design (R2 audit applied):
--   * Range [0.6, 1.5] = Cartesia Sonic 3 documented bounds. Sending
--     outside this range produces unnatural / broken speech; the DB CHECK
--     is the hard floor. UI clamps to a tighter ergonomic subset.
--   * Default 1.0 = Cartesia native, no behavior change on existing rows.
--     We deliberately do NOT pre-seed Vucko (or any existing creator) to
--     a non-1.0 value; first use of the slider IS the dogfood test.
--   * NOT NULL on creators: every creator has a speed preference, even
--     if it's "default". Avoids the COALESCE branching on every session
--     open.
--   * NULL allowed on voice_tickets: legacy tickets minted before this
--     migration carry NULL; the bridge treats NULL (or 1.0) as "skip the
--     generation_config.speed field entirely" for forward compatibility
--     with Cartesia param renames. The shouldSendSpeed() helper in the
--     bridge enforces this — it returns true only when v !== 1.0 AND
--     v !== null AND Number.isFinite(v).
--
-- RLS posture (R1 audit C5 — ACCEPT public-read):
--   * Postgres has no column-level RLS. The existing "creators public
--     read when published" policy (20260420000011_creators.sql:122) grants
--     `anon` SELECT on every column of published-human creators. This
--     migration's tts_speed column inherits that grant. Acceptable: the
--     value is a UX preference, not sensitive. Same posture as
--     creators.system_prompt (20260511000001) which is far more sensitive.
--     If we ever split sensitive columns into a creators_private table,
--     tts_speed comes along with system_prompt at that time. Document
--     this intent in the column COMMENT below.
--
-- Audit-trail (R1 audit S7): explicit decision — no history table. The
-- existing creators.updated_at tick is sufficient for v1 (low-frequency
-- mutation, easy to inspect via updated_at + last-write-wins semantics).
--
-- Brain-recompile interaction (R2 audit M7): the
-- recompileBrainAfterResponse() trigger in src/app/creator/brain/actions.ts
-- is MANUALLY invoked by specific actions (addTopic, deleteTopic,
-- addSampleContent, deleteSampleContent). It's NOT a DB trigger on
-- creators UPDATE. The new updateTtsSpeed() server action does NOT call
-- recompileBrainAfterResponse — tts_speed has no bearing on the persona.

ALTER TABLE public.creators
  ADD COLUMN tts_speed numeric NOT NULL DEFAULT 1.0
  CHECK (tts_speed >= 0.6 AND tts_speed <= 1.5);

COMMENT ON COLUMN public.creators.tts_speed IS
  'Cartesia Sonic 3 generation_config.speed value. Range [0.6, 1.5]; 1.0 = Cartesia default (no-op), <1.0 = slower playback, >1.0 = faster. Per-creator playback tuning; rides voice_tickets → proxy → cartesia-bridge, inserted into generation_config.speed on each sendText / turnEnd message. Publicly readable via creators "published" RLS policy (Postgres has no column-level RLS); accepted as UX preference, not sensitive. R1 audit C5 disposition.';

ALTER TABLE public.voice_tickets
  ADD COLUMN tts_speed numeric NULL
  CHECK (tts_speed IS NULL OR (tts_speed >= 0.6 AND tts_speed <= 1.5));

COMMENT ON COLUMN public.voice_tickets.tts_speed IS
  'Mirrors creators.tts_speed at session-open. NULL means "use Cartesia default" (legacy ticket pre-migration OR explicit no-op). Bridge omits the generation_config.speed field when NULL OR 1.0 — we treat sending speed:1.0 as functionally equivalent to omitting, and prefer minimal wire payloads forward-compatible with Cartesia param renames. Only meaningful for purpose=''voice_session'' tickets; voice_clone tickets leave this NULL by convention.';

-- Day-window rate limit RPC for the voice-preview endpoint.
--
-- The existing rate_limit_hit() RPC (20260503000009:380) only accepts a
-- '1 minute' window; broader buckets RAISE 22023. The voice-speed feature
-- needs a per-day cap (Vuk decision 2026-05-11: 20 previews/day/creator,
-- which is "way more than a sane individual needs"). Rather than
-- generalize the existing RPC and risk regressing the call sites that
-- depend on minute-bucket semantics, we add a sister function that
-- buckets on day. Same rate_limit_counters table.
--
-- Why a new function instead of generalizing rate_limit_hit():
--   * rate_limit_hit() is used by /api/feed, /api/feed/events, /api/admin/
--     mux-upload, /api/sessions/open — minute-bucketing is correct for
--     all of them. Generalizing would either change those semantics
--     (regression) or require call-site changes (scope creep).
--   * Day-bucketing is a different invariant from minute-bucketing
--     (resets at midnight UTC, not on every minute tick). A purpose-built
--     function makes the invariant explicit in the name.
--
-- Bucket reset: midnight UTC. A creator can tap their 20th preview at
-- 23:59:00 and get one fresh tap at 00:00:00 the same day — acceptable.
-- Anyone hitting the cap is by definition not in normal tuning behavior.

CREATE FUNCTION public.rate_limit_hit_day(
  p_scope  text,
  p_key    text,
  p_limit  int DEFAULT 20
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_window_start timestamptz := date_trunc('day', now());
  v_count int;
BEGIN
  INSERT INTO public.rate_limit_counters (scope, key, window_start, hit_count)
  VALUES (p_scope, p_key, v_window_start, 1)
  ON CONFLICT (scope, key, window_start) DO UPDATE
    SET hit_count = rate_limit_counters.hit_count + 1
  RETURNING hit_count INTO v_count;
  RETURN v_count <= p_limit;
END;$$;

-- ACL: mirror rate_limit_hit. Service-role caller (proxy + route admin
-- clients) needs EXECUTE. Anon/authenticated do not — preview endpoint
-- only runs server-side.
REVOKE ALL ON FUNCTION public.rate_limit_hit_day(text, text, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit_day(text, text, int) TO service_role;
