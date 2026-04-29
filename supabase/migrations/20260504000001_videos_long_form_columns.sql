-- 0504-01 — videos.long_form_* columns (long-form viewer plan §1.1).
--
-- A "video" is one creator content unit with two independent, optional assets:
--   • Hooks — 1–5 vertical 9:16 clips, ≤300s each (existing schema).
--   • Long-form — one 16:9 lesson, 5–55 min, with inline avatar interaction.
--
-- Both sides are publishable independently. A creator can ship hooks-only
-- forever; long-form is a depth feature, not a publish gate. The feed pill
-- "Chat with @handle" only renders when long-form_mux_playback_id IS NOT NULL
-- AND long_form_published_at IS NOT NULL — gated at the application layer.
--
-- Mirrors the hook upload-tracking pattern from 0042. mux_status is text+CHECK
-- (not an enum) for parity with hooks/welcome_hooks. Aspect-ratio enforcement
-- and the user-facing 5–55 min rule live in publishLongForm() at the
-- application layer; the DB CHECK is a loose 60–3600s belt-and-suspenders.

ALTER TABLE public.videos
  ADD COLUMN long_form_mux_upload_id    text,
  ADD COLUMN long_form_mux_asset_id     text UNIQUE,
  ADD COLUMN long_form_mux_playback_id  text,
  ADD COLUMN long_form_mux_passthrough  uuid,
  ADD COLUMN long_form_mux_status       text NOT NULL DEFAULT 'pending'
    CHECK (long_form_mux_status IN
      ('pending','uploading','processing','ready','failed')),
  ADD COLUMN long_form_mux_aspect_ratio text,
  ADD COLUMN long_form_mux_duration_ms  integer
    CHECK (long_form_mux_duration_ms IS NULL OR long_form_mux_duration_ms > 0),
  ADD COLUMN long_form_duration_seconds int
    CHECK (long_form_duration_seconds IS NULL
           OR long_form_duration_seconds BETWEEN 60 AND 3600),
  ADD COLUMN long_form_aspect_ratio     text DEFAULT '16:9',
  ADD COLUMN long_form_processing_error text
    CHECK (long_form_processing_error IS NULL
           OR char_length(long_form_processing_error) <= 1024),
  ADD COLUMN long_form_published_at     timestamptz;

-- Backfill passthrough on existing rows. gen_random_uuid() is VOLATILE so
-- a column DEFAULT applied on ADD COLUMN would generate a single value
-- shared across every row, violating UNIQUE. Backfill explicitly per row,
-- then promote NOT NULL + DEFAULT + UNIQUE. Sub-second at current scale.
UPDATE public.videos
   SET long_form_mux_passthrough = gen_random_uuid()
 WHERE long_form_mux_passthrough IS NULL;

ALTER TABLE public.videos
  ALTER COLUMN long_form_mux_passthrough SET NOT NULL,
  ALTER COLUMN long_form_mux_passthrough SET DEFAULT gen_random_uuid();

ALTER TABLE public.videos
  ADD CONSTRAINT videos_long_form_mux_passthrough_key
    UNIQUE (long_form_mux_passthrough);

-- Partial index for "is this video's long-form publishable in the feed?" —
-- the pill-render predicate the feed RPC projects as long_form_available.
CREATE INDEX videos_long_form_published_idx
  ON public.videos (long_form_published_at)
  WHERE long_form_published_at IS NOT NULL;

NOTIFY pgrst, 'reload schema';
