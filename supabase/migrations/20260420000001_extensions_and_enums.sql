-- 0001 — extensions, enums, size/tz helper functions
-- See docs/_planning/SCHEMA_V1_PLAN.md §Extensions, enums, helper functions.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Enums ---------------------------------------------------------------------

CREATE TYPE profile_tier          AS ENUM ('free', 'premium', 'boardroom');
CREATE TYPE creator_type          AS ENUM ('human', 'brand', 'sponsored_segment');
CREATE TYPE brain_status          AS ENUM ('pending', 'queued', 'training', 'ready', 'errored');
CREATE TYPE sample_source_type    AS ENUM ('youtube', 'transcript', 'book_or_doc', 'mastermind_or_course', 'testimonial');
CREATE TYPE application_status    AS ENUM ('submitted', 'under_review', 'approved', 'rejected');
CREATE TYPE video_status          AS ENUM ('uploading', 'processing', 'ready', 'failed');
CREATE TYPE session_status        AS ENUM ('starting', 'active', 'ending', 'ended', 'errored');
CREATE TYPE session_turn_role     AS ENUM ('user', 'assistant');
CREATE TYPE admin_role_name       AS ENUM ('superadmin', 'reviewer');
CREATE TYPE cogs_service          AS ENUM ('gemini', 'cartesia', 'simli', 'tavus', 'mux', 'supabase', 'livekit', 'resend');
CREATE TYPE verification_purpose  AS ENUM ('email_signup', 'magic_link');
CREATE TYPE handle_owner_kind     AS ENUM ('profile', 'creator');
CREATE TYPE voice_model AS ENUM (
  'gemini_3_1_flash_live_preview',
  'gemini_live_2_5_flash_native_audio',
  'gemini_pro_audio_v2'
);

-- Voice model wire value ----------------------------------------------------

CREATE FUNCTION public.voice_model_wire_value(m voice_model) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE m
    WHEN 'gemini_3_1_flash_live_preview'      THEN 'gemini-3.1-flash-live-preview'
    WHEN 'gemini_live_2_5_flash_native_audio' THEN 'gemini-live-2.5-flash-native-audio'
    WHEN 'gemini_pro_audio_v2'                THEN 'gemini-pro-audio-v2'
  END;
$$;

-- Size-cap helpers (R4-C1) --------------------------------------------------
-- Postgres rejects subqueries in CHECK bodies but accepts functions whose
-- bodies contain subqueries, so we wrap unnest() in an IMMUTABLE helper.

CREATE FUNCTION public._max_text_array_elem_len(arr text[]) RETURNS int
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(max(char_length(x)), 0) FROM unnest(arr) x;
$$;

CREATE FUNCTION public._all_text_array_elems_within(arr text[], max_len int) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT arr IS NULL OR public._max_text_array_elem_len(arr) <= max_len;
$$;

-- Timezone validator (R6-C1) ------------------------------------------------
-- STABLE not IMMUTABLE: pg_timezone_names is a view that can change across
-- Postgres upgrades. CHECK accepts STABLE; Postgres does not re-validate
-- existing rows when tzdata moves.

CREATE FUNCTION public._is_valid_timezone(tz text) RETURNS boolean
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
BEGIN
  IF tz IS NULL THEN RETURN false; END IF;
  PERFORM now() AT TIME ZONE tz;
  RETURN true;
EXCEPTION WHEN invalid_parameter_value OR undefined_object THEN
  RETURN false;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_model_wire_value(voice_model)      FROM public;
REVOKE EXECUTE ON FUNCTION public._max_text_array_elem_len(text[])         FROM public;
REVOKE EXECUTE ON FUNCTION public._all_text_array_elems_within(text[],int) FROM public;
REVOKE EXECUTE ON FUNCTION public._is_valid_timezone(text)                 FROM public;
GRANT  EXECUTE ON FUNCTION public.voice_model_wire_value(voice_model)      TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public._max_text_array_elem_len(text[])         TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public._all_text_array_elems_within(text[],int) TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public._is_valid_timezone(text)                 TO authenticated, service_role;
