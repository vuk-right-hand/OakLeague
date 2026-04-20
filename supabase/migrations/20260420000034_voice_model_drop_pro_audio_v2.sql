-- 0034 — drop speculative `gemini_pro_audio_v2` from voice_model (R3-Small).
-- CLAUDE.md §Hard Rules: "no v2-later placeholders." The value has no writer
-- and no column contains it, so the swap is lossless.

DROP FUNCTION public.voice_model_wire_value(voice_model);

ALTER TYPE voice_model RENAME TO voice_model__old;

CREATE TYPE voice_model AS ENUM (
  'gemini_3_1_flash_live_preview',
  'gemini_live_2_5_flash_native_audio'
);

ALTER TABLE public.sessions
  ALTER COLUMN model_used TYPE voice_model
  USING model_used::text::voice_model;

DROP TYPE voice_model__old;

CREATE FUNCTION public.voice_model_wire_value(m voice_model) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE m
    WHEN 'gemini_3_1_flash_live_preview'      THEN 'gemini-3.1-flash-live-preview'
    WHEN 'gemini_live_2_5_flash_native_audio' THEN 'gemini-live-2.5-flash-native-audio'
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.voice_model_wire_value(voice_model) FROM public;
GRANT  EXECUTE ON FUNCTION public.voice_model_wire_value(voice_model) TO authenticated, service_role;
