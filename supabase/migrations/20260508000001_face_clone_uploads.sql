-- FACE_UI_PLAN §8 migration 1 — face_clone_uploads (admin audit log).
--
-- Phase 0 (PHASE_0_FACE_API.md) confirmed Simli Trinity-1 is image-only
-- (JPEG/PNG ≤ 5 MB) and async (POST returns face_id immediately, status
-- via /faces/trinity/generation_status). Schema reflects that:
--
--   * vendor enum supports the dual-lane plan (image today via simli;
--     video tomorrow via tavus/heygen). v1 only writes 'simli'.
--   * media_kind tracks image-vs-video so future video-vendor rows are
--     unambiguous from a SQL audit.
--   * vendor_face_id holds the Simli face_id from the moment training
--     starts (still pending) — distinct from finalized state.
--   * face_state lifecycle: 'pending' (just enqueued), 'ready'
--     (compose-tokenable), 'failed' (Simli rejected), 'deleted'
--     (vendor face removed but row preserved for audit).
--   * Append-only with a narrow update window for face_state transitions
--     and warnings array (Simli emits warnings[] on training start; status
--     poll may surface late warnings). Mirrors voice_clone_uploads pattern.
--
-- RLS enabled, zero policies — service-role-only writes from
-- /api/admin/face-upload + status route.

CREATE TYPE public.face_vendor AS ENUM ('simli', 'tavus', 'heygen');
CREATE TYPE public.face_media_kind AS ENUM ('image', 'video');
CREATE TYPE public.face_state AS ENUM ('pending', 'ready', 'failed', 'deleted');

CREATE TABLE public.face_clone_uploads (
  id                bigserial   PRIMARY KEY,
  admin_user_id     uuid        NOT NULL REFERENCES auth.users(id)      ON DELETE RESTRICT,
  creator_id        uuid        NOT NULL REFERENCES public.creators(id) ON DELETE RESTRICT,
  vendor            public.face_vendor NOT NULL,
  media_kind        public.face_media_kind NOT NULL,
  sha256            text        NOT NULL CHECK (char_length(sha256) = 64),
  mime              text        NOT NULL CHECK (mime IN (
    'image/jpeg', 'image/png',
    'video/mp4',  'video/quicktime'
  )),
  bytes             bigint      NOT NULL CHECK (bytes BETWEEN 1 AND 52428800), -- 50 MB ceiling (covers future video lane; image lane enforces 5 MB at the route)
  width             int         NOT NULL CHECK (width  BETWEEN 256 AND 4096),
  height            int         NOT NULL CHECK (height BETWEEN 256 AND 4096),
  -- Optional video-only fields (NULL on image rows). Tavus/HeyGen rows
  -- will fill these.
  duration_seconds  numeric(8,3) CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0.5 AND 300.0),
  -- Vendor-side identifiers. Simli emits face_id immediately on POST
  -- (Phase 0 finding) — we store it here even while pending so the status
  -- poll can find it without joining creators.
  vendor_face_id    text        CHECK (vendor_face_id IS NULL OR char_length(vendor_face_id) BETWEEN 1 AND 128),
  state             public.face_state NOT NULL DEFAULT 'pending',
  warnings          jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
  last_error        text        CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  -- Auditor R2-M2 — persist the force-overwrite intent at upload time so
  -- the status route's finalize step doesn't depend on a per-poll query
  -- param (client could otherwise drop the flag mid-train and orphan a
  -- successfully-trained vendor face). Read by face_clone_finalize_locked.
  force_overwrite   boolean     NOT NULL DEFAULT false,
  ready_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- vendor lane sanity: image row → image mime; video row → video mime.
ALTER TABLE public.face_clone_uploads
  ADD CONSTRAINT face_clone_uploads_kind_mime_consistent CHECK (
    (media_kind = 'image' AND mime IN ('image/jpeg','image/png'))
    OR
    (media_kind = 'video' AND mime IN ('video/mp4','video/quicktime'))
  );

-- v1 vendor lane: simli is image-only. Future tavus/heygen rows will
-- accept video. Drop this CHECK when a video vendor lands.
ALTER TABLE public.face_clone_uploads
  ADD CONSTRAINT face_clone_uploads_simli_image_only CHECK (
    vendor <> 'simli' OR media_kind = 'image'
  );

CREATE INDEX face_clone_uploads_admin_created_idx
  ON public.face_clone_uploads (admin_user_id, created_at DESC);

CREATE INDEX face_clone_uploads_creator_idx
  ON public.face_clone_uploads (creator_id, created_at DESC);

-- Status-poll lookup (vendor_face_id → upload row). Partial: only rows
-- that are still in transit need the index.
CREATE INDEX face_clone_uploads_pending_vendor_idx
  ON public.face_clone_uploads (vendor_face_id)
  WHERE vendor_face_id IS NOT NULL AND state = 'pending';

-- Auditor R2-M3 — partial UNIQUE so two ready rows can never reference the
-- same Simli face_id. Defends against Simli reusing a face_id on a retry
-- under undocumented failure modes; the duplicate finalize would otherwise
-- silently double-claim the live face row.
CREATE UNIQUE INDEX face_clone_uploads_one_ready_per_vendor_idx
  ON public.face_clone_uploads (vendor, vendor_face_id)
  WHERE state = 'ready' AND vendor_face_id IS NOT NULL;

-- Auditor R2-M1 — pending-row lookup per creator, used by the page-load
-- resume path on the FaceUpload UI cell. Tab-close during a multi-minute
-- training shouldn't strand the upload; we re-attach to the in-flight
-- pending row when the admin returns.
CREATE INDEX face_clone_uploads_creator_pending_idx
  ON public.face_clone_uploads (creator_id, created_at DESC)
  WHERE state = 'pending';

-- Append-only with narrow lifecycle UPDATE window.
-- Allowed transitions:
--   * vendor_face_id NULL → non-NULL (set when Simli accepts the upload)
--   * state pending → ready | failed | deleted
--   * state ready → deleted
--   * warnings/last_error fill-in
--   * ready_at fill-in (NULL → timestamp on transition to ready)
-- Everything else (PK, FKs, sha256, dims, etc.) is immutable.

CREATE FUNCTION public.face_clone_uploads_block_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_blocked boolean := false;
BEGIN
  IF NEW.id              <> OLD.id              THEN v_blocked := true; END IF;
  IF NEW.admin_user_id   <> OLD.admin_user_id   THEN v_blocked := true; END IF;
  IF NEW.creator_id      <> OLD.creator_id      THEN v_blocked := true; END IF;
  IF NEW.vendor          <> OLD.vendor          THEN v_blocked := true; END IF;
  IF NEW.media_kind      <> OLD.media_kind      THEN v_blocked := true; END IF;
  IF NEW.sha256          <> OLD.sha256          THEN v_blocked := true; END IF;
  IF NEW.mime            <> OLD.mime            THEN v_blocked := true; END IF;
  IF NEW.bytes           <> OLD.bytes           THEN v_blocked := true; END IF;
  IF NEW.width           <> OLD.width           THEN v_blocked := true; END IF;
  IF NEW.height          <> OLD.height          THEN v_blocked := true; END IF;
  IF NEW.created_at      <> OLD.created_at      THEN v_blocked := true; END IF;
  IF NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds THEN v_blocked := true; END IF;
  -- force_overwrite is captured at insert time and is never mutable
  -- (auditor R2-M2): otherwise the persisted intent could be re-flipped
  -- mid-train, defeating the whole point of pulling it off the query string.
  IF NEW.force_overwrite IS DISTINCT FROM OLD.force_overwrite THEN v_blocked := true; END IF;

  -- vendor_face_id: NULL → non-NULL once; otherwise must equal old.
  IF OLD.vendor_face_id IS NOT NULL
     AND NEW.vendor_face_id IS DISTINCT FROM OLD.vendor_face_id THEN
    v_blocked := true;
  END IF;

  -- state transitions: pending → {ready,failed,deleted}; ready → deleted; equal is fine.
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.state = 'pending' AND NEW.state IN ('ready','failed','deleted') THEN
      NULL;
    ELSIF OLD.state = 'ready' AND NEW.state = 'deleted' THEN
      NULL;
    ELSE
      v_blocked := true;
    END IF;
  END IF;

  -- ready_at: NULL → timestamp once when state flips to ready.
  IF OLD.ready_at IS NOT NULL AND NEW.ready_at IS DISTINCT FROM OLD.ready_at THEN
    v_blocked := true;
  END IF;

  -- Auditor R2-C4 — fill-in-once on warnings and last_error so the audit
  -- log is actually append-only. Without these, a service-role caller
  -- (today: only our own routes) could rewrite warnings/last_error on a
  -- ready or failed row and corrupt the audit trail. warnings is set
  -- exactly once in face_clone_register_pending; last_error exactly once
  -- in face_clone_mark_failed.
  IF OLD.warnings IS NOT NULL
     AND OLD.warnings <> '[]'::jsonb
     AND NEW.warnings IS DISTINCT FROM OLD.warnings THEN
    v_blocked := true;
  END IF;
  IF OLD.last_error IS NOT NULL
     AND NEW.last_error IS DISTINCT FROM OLD.last_error THEN
    v_blocked := true;
  END IF;

  IF v_blocked THEN
    RAISE EXCEPTION 'face_clone_uploads is append-only with a narrow lifecycle UPDATE window'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.face_clone_uploads_block_update() FROM public;

CREATE TRIGGER face_clone_uploads_no_destructive_update
  BEFORE UPDATE ON public.face_clone_uploads
  FOR EACH ROW EXECUTE FUNCTION public.face_clone_uploads_block_update();

CREATE TRIGGER face_clone_uploads_touch_updated_at
  BEFORE UPDATE ON public.face_clone_uploads
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER face_clone_uploads_no_delete
  BEFORE DELETE ON public.face_clone_uploads
  FOR EACH ROW EXECUTE FUNCTION public.raise_append_only();

CREATE TRIGGER face_clone_uploads_no_truncate
  BEFORE TRUNCATE ON public.face_clone_uploads
  FOR EACH STATEMENT EXECUTE FUNCTION public.raise_append_only();

ALTER TABLE public.face_clone_uploads ENABLE ROW LEVEL SECURITY;
-- Zero policies — service-role only.

COMMENT ON TABLE public.face_clone_uploads IS
  'Admin audit log for face/avatar cloning. Provider-agnostic via vendor enum '
  '(simli today, tavus/heygen future). Image lane today via Simli Trinity-1; '
  'video lane reserved. State lifecycle pending → ready | failed | deleted '
  'mirrors Simli generation_status.';
