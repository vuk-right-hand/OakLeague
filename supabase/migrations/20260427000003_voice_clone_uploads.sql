-- 0047 — voice_clone_uploads (admin audit log)
--
-- Days 8–12 plan REV 5, migration 3 of 11.
-- Append-only audit of every voice-clone upload: who uploaded, for which
-- creator, SHA-256 of the bytes, duration + mime + byte count. 3/day/admin
-- rate limit lives in the mint route (N2-M3). Writes go via service-role
-- only (Fly proxy endpoint). RLS enabled with zero policies.

CREATE TABLE public.voice_clone_uploads (
  id                bigserial   PRIMARY KEY,
  admin_user_id     uuid        NOT NULL REFERENCES auth.users(id)         ON DELETE RESTRICT,
  creator_id        uuid        NOT NULL REFERENCES public.creators(id)    ON DELETE RESTRICT,
  sha256            text        NOT NULL CHECK (char_length(sha256) = 64),
  duration_seconds  numeric(8,3) NOT NULL CHECK (duration_seconds BETWEEN 3.0 AND 120.0),
  mime              text        NOT NULL CHECK (mime IN (
    'audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/x-m4a', 'audio/mp4'
  )),
  bytes             bigint      NOT NULL CHECK (bytes BETWEEN 1 AND 20971520), -- 20 MB (audit S2: 120s @ 44.1kHz/16-bit stereo ≈ 21 MB; 10 MB clipped hi-fi source)
  cartesia_voice_id text        CHECK (cartesia_voice_id IS NULL OR char_length(cartesia_voice_id) BETWEEN 1 AND 128),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Rate-limit index: 3/day/admin count is a partial index on created_at + admin.
CREATE INDEX voice_clone_uploads_admin_day_idx
  ON public.voice_clone_uploads (admin_user_id, created_at DESC);

-- Creator lookup (reverse audit: "what clones have been uploaded for $creator").
CREATE INDEX voice_clone_uploads_creator_idx
  ON public.voice_clone_uploads (creator_id, created_at DESC);

-- Append-only enforcement: reuse the pattern from cogs_log (migration 0020).
-- UPDATE blocked except when the FK cascade null-transitions a column; here
-- we use ON DELETE RESTRICT so cascades don't fire. DELETE + TRUNCATE blocked.

CREATE FUNCTION public.voice_clone_uploads_block_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Allow only a post-insert UPDATE of cartesia_voice_id when it transitions
  -- from NULL → non-NULL (the proxy learns the voice_id after the Cartesia
  -- clone-create call returns and writes it back). Every other column is
  -- immutable after insert.
  IF NEW.id                = OLD.id
 AND NEW.admin_user_id     = OLD.admin_user_id
 AND NEW.creator_id        = OLD.creator_id
 AND NEW.sha256            = OLD.sha256
 AND NEW.duration_seconds  = OLD.duration_seconds
 AND NEW.mime              = OLD.mime
 AND NEW.bytes             = OLD.bytes
 AND NEW.created_at        = OLD.created_at
 AND (
      NEW.cartesia_voice_id IS NOT DISTINCT FROM OLD.cartesia_voice_id
      OR (OLD.cartesia_voice_id IS NULL AND NEW.cartesia_voice_id IS NOT NULL)
    )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'voice_clone_uploads is append-only (cartesia_voice_id is the only fill-in-once column)'
    USING ERRCODE = '42501';
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_clone_uploads_block_update() FROM public;

CREATE TRIGGER voice_clone_uploads_no_update
  BEFORE UPDATE ON public.voice_clone_uploads
  FOR EACH ROW EXECUTE FUNCTION public.voice_clone_uploads_block_update();

CREATE TRIGGER voice_clone_uploads_no_delete
  BEFORE DELETE ON public.voice_clone_uploads
  FOR EACH ROW EXECUTE FUNCTION public.raise_append_only();

CREATE TRIGGER voice_clone_uploads_no_truncate
  BEFORE TRUNCATE ON public.voice_clone_uploads
  FOR EACH STATEMENT EXECUTE FUNCTION public.raise_append_only();

-- Service-role only. Zero policies.
ALTER TABLE public.voice_clone_uploads ENABLE ROW LEVEL SECURITY;
