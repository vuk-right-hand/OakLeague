-- 20260612000001 — Creator Studio (WS4/5/6): creator self-serve voice/face/video.
-- CREATOR_STUDIO_WS456_PLAN + audit round-1 resolutions (C1-C5, M1-M7).
--
-- 1. voice_clone_uploads + face_clone_uploads: admin_user_id → nullable,
--    uploaded_by_user_id added, provenance CHECK (exactly one actor).
-- 2. Voice append-only trigger REWRITTEN with IS NOT DISTINCT FROM (audit C1:
--    the old `NEW.admin_user_id = OLD.admin_user_id` chain evaluates NULL=NULL
--    → NULL → falls through to RAISE, hard-blocking every creator finalize).
--    Face trigger gains uploaded_by_user_id immutability (its accumulate
--    pattern is already NULL-safe).
-- 3. voice_clone_uploads: source_object_path (fish buffer-room — raw WAV kept
--    so future provider clones never need a re-record) + script_id.
-- 4. voice_clone_scripts — server-generated 4-sentence recording scripts.
--    Replay-resistance ONLY (audit M2: NOT a liveness check — documented).
-- 5. storage bucket voice-source — public=false, ZERO storage.objects
--    policies (service-role only).
-- 6. videos.admin_removed_at — video-level admin takedown lock (audit M4).
-- 7. content_reports — public report path for feed content (audit C3
--    mitigation; per-video approval intentionally NOT added — Vuk decision).
-- 8. voice_clone_finalize_creator / face_clone_finalize_creator — creator-
--    scoped siblings of the admin _locked RPCs (audit C2: NOT a shared core;
--    admin RPCs untouched byte-for-byte). Ownership from auth.uid(), no
--    creator_id param. Overwrite blocked while creator is published (audit
--    M5, re-checked UNDER the advisory lock); first-fill always completes.

-- ── 1. Actor provenance ─────────────────────────────────────────────────────
ALTER TABLE public.voice_clone_uploads
  ALTER COLUMN admin_user_id DROP NOT NULL,
  ADD COLUMN uploaded_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN source_object_path text CHECK (char_length(source_object_path) <= 300),
  ADD COLUMN script_id uuid,
  ADD CONSTRAINT voice_clone_uploads_actor_chk
    CHECK (num_nonnulls(admin_user_id, uploaded_by_user_id) = 1);

ALTER TABLE public.face_clone_uploads
  ALTER COLUMN admin_user_id DROP NOT NULL,
  ADD COLUMN uploaded_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT face_clone_uploads_actor_chk
    CHECK (num_nonnulls(admin_user_id, uploaded_by_user_id) = 1);

-- ── 2. Trigger rewrites ─────────────────────────────────────────────────────
-- VOICE: current body = the fish-aware version (20260608100005) with ONLY two
-- changes: (a) immutable-field chain uses IS NOT DISTINCT FROM (audit C1 —
-- `NEW.admin_user_id = OLD.admin_user_id` is NULL=NULL → NULL on creator rows
-- → fell through to RAISE, blocking every creator finalize), and (b) the three
-- new columns join the immutable chain. Provider arms + messages verbatim.
CREATE OR REPLACE FUNCTION public.voice_clone_uploads_block_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_active_arm_ok boolean;
  v_other_arms_ok boolean;
BEGIN
  -- Immutable fields first — fail fast on tampering.
  IF NOT (
       NEW.id                  IS NOT DISTINCT FROM OLD.id
   AND NEW.admin_user_id       IS NOT DISTINCT FROM OLD.admin_user_id
   AND NEW.uploaded_by_user_id IS NOT DISTINCT FROM OLD.uploaded_by_user_id
   AND NEW.creator_id          IS NOT DISTINCT FROM OLD.creator_id
   AND NEW.sha256              IS NOT DISTINCT FROM OLD.sha256
   AND NEW.duration_seconds    IS NOT DISTINCT FROM OLD.duration_seconds
   AND NEW.mime                IS NOT DISTINCT FROM OLD.mime
   AND NEW.bytes               IS NOT DISTINCT FROM OLD.bytes
   AND NEW.created_at          IS NOT DISTINCT FROM OLD.created_at
   AND NEW.tts_provider        IS NOT DISTINCT FROM OLD.tts_provider   -- tts_provider IMMUTABLE
   AND NEW.source_object_path  IS NOT DISTINCT FROM OLD.source_object_path
   AND NEW.script_id           IS NOT DISTINCT FROM OLD.script_id
  ) THEN
    RAISE EXCEPTION 'voice_clone_uploads is append-only (immutable row fields were mutated; only the active-provider fill-in-once column may transition)'
      USING ERRCODE = '42501';
  END IF;

  -- Per-provider arm: exactly the active-provider's fill-in-once column may
  -- transition; all other providers' columns must stay at OLD values.
  IF NEW.tts_provider = 'cartesia' THEN
    v_active_arm_ok := (
         NEW.cartesia_voice_id IS NOT DISTINCT FROM OLD.cartesia_voice_id
      OR (OLD.cartesia_voice_id IS NULL AND NEW.cartesia_voice_id IS NOT NULL)
    );
    v_other_arms_ok := (
         NEW.hume_voice_id   IS NOT DISTINCT FROM OLD.hume_voice_id
     AND NEW.hume_voice_name IS NOT DISTINCT FROM OLD.hume_voice_name
     AND NEW.fish_voice_id   IS NOT DISTINCT FROM OLD.fish_voice_id
    );
  ELSIF NEW.tts_provider = 'hume' THEN
    v_active_arm_ok := (
         (NEW.hume_voice_id   IS NOT DISTINCT FROM OLD.hume_voice_id AND
          NEW.hume_voice_name IS NOT DISTINCT FROM OLD.hume_voice_name)
      OR (OLD.hume_voice_id IS NULL AND OLD.hume_voice_name IS NULL
          AND NEW.hume_voice_id IS NOT NULL AND NEW.hume_voice_name IS NOT NULL)
    );
    v_other_arms_ok := (
         NEW.cartesia_voice_id IS NOT DISTINCT FROM OLD.cartesia_voice_id
     AND NEW.fish_voice_id     IS NOT DISTINCT FROM OLD.fish_voice_id
    );
  ELSIF NEW.tts_provider = 'fish' THEN
    v_active_arm_ok := (
         NEW.fish_voice_id IS NOT DISTINCT FROM OLD.fish_voice_id
      OR (OLD.fish_voice_id IS NULL AND NEW.fish_voice_id IS NOT NULL)
    );
    v_other_arms_ok := (
         NEW.cartesia_voice_id IS NOT DISTINCT FROM OLD.cartesia_voice_id
     AND NEW.hume_voice_id     IS NOT DISTINCT FROM OLD.hume_voice_id
     AND NEW.hume_voice_name   IS NOT DISTINCT FROM OLD.hume_voice_name
    );
  ELSE
    RAISE EXCEPTION 'voice_clone_uploads_block_update: unhandled tts_provider=% (extend trigger when adding a new provider enum value)', NEW.tts_provider
      USING ERRCODE = '42501';
  END IF;

  IF v_active_arm_ok AND v_other_arms_ok THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'voice_clone_uploads is append-only (only the active-provider fill-in-once column may transition; other providers'' columns must stay unchanged)'
    USING ERRCODE = '42501';
END;$$;

-- FACE: original body (20260508000001) verbatim, with ONLY: admin_user_id
-- comparison made NULL-safe (IS DISTINCT FROM) + uploaded_by_user_id added
-- to the immutable set. State machine, warnings/last_error fill-in-once,
-- ready_at rule, and the RAISE message are unchanged.
CREATE OR REPLACE FUNCTION public.face_clone_uploads_block_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_blocked boolean := false;
BEGIN
  IF NEW.id              <> OLD.id              THEN v_blocked := true; END IF;
  IF NEW.admin_user_id   IS DISTINCT FROM OLD.admin_user_id THEN v_blocked := true; END IF;
  IF NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id THEN v_blocked := true; END IF;
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
  IF NEW.force_overwrite IS DISTINCT FROM OLD.force_overwrite THEN v_blocked := true; END IF;

  IF OLD.vendor_face_id IS NOT NULL
     AND NEW.vendor_face_id IS DISTINCT FROM OLD.vendor_face_id THEN
    v_blocked := true;
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.state = 'pending' AND NEW.state IN ('ready','failed','deleted') THEN
      NULL;
    ELSIF OLD.state = 'ready' AND NEW.state = 'deleted' THEN
      NULL;
    ELSE
      v_blocked := true;
    END IF;
  END IF;

  IF OLD.ready_at IS NOT NULL AND NEW.ready_at IS DISTINCT FROM OLD.ready_at THEN
    v_blocked := true;
  END IF;

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

-- ── 3/4. Voice scripts ──────────────────────────────────────────────────────
CREATE TABLE public.voice_clone_scripts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  sentences  jsonb NOT NULL CHECK (jsonb_typeof(sentences) = 'array'
               AND jsonb_array_length(sentences) = 4
               AND pg_column_size(sentences) <= 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz
);
CREATE INDEX voice_clone_scripts_creator_idx
  ON public.voice_clone_scripts (creator_id, created_at DESC);
ALTER TABLE public.voice_clone_scripts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.voice_clone_scripts FROM public, anon, authenticated;
GRANT ALL ON TABLE public.voice_clone_scripts TO service_role;
COMMENT ON TABLE public.voice_clone_scripts IS
  'Server-generated 4-sentence recording scripts for creator voice cloning. Replay-resistance + recording guidance ONLY — NOT a liveness/anti-impersonation check (audit M2: a malicious creator can have anyone read it; the real control is invite-only vetting). 30min TTL enforced at the clone route; used_at stamped single-use inside voice_clone_finalize_creator.';

ALTER TABLE public.voice_clone_uploads
  ADD CONSTRAINT voice_clone_uploads_script_fk
    FOREIGN KEY (script_id) REFERENCES public.voice_clone_scripts(id) ON DELETE SET NULL;

-- ── 5. voice-source bucket (fish buffer-room). public=false; NO
-- storage.objects policies → service-role only (pattern: 20260525000006). ──
INSERT INTO storage.buckets (id, name, public)
VALUES ('voice-source', 'voice-source', false)
ON CONFLICT (id) DO NOTHING;

-- ── 6. Video-level admin takedown lock (audit M4) ───────────────────────────
ALTER TABLE public.videos
  ADD COLUMN admin_removed_at timestamptz;
COMMENT ON COLUMN public.videos.admin_removed_at IS
  'Admin takedown lock (CREATOR_STUDIO audit M4). While non-NULL, creator studio publish/unpublish actions refuse to touch this video (stops unpublish→republish takedown-evasion). Set/cleared by admin only. Feed exposure is governed by published_at + creators.published_at as before; admin sets published_at=NULL alongside this lock.';

-- ── 7. content_reports (audit C3 mitigation) ────────────────────────────────
CREATE TABLE public.content_reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind       text NOT NULL CHECK (target_kind IN ('hook', 'video', 'creator', 'comment')),
  target_id         uuid NOT NULL,
  reporter_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason            text CHECK (char_length(reason) <= 1000),
  created_ip        inet,
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolved_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX content_reports_open_idx
  ON public.content_reports (created_at DESC) WHERE resolved_at IS NULL;
ALTER TABLE public.content_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.content_reports FROM public, anon, authenticated;
GRANT ALL ON TABLE public.content_reports TO service_role;
COMMENT ON TABLE public.content_reports IS
  'Public content reports (anon allowed; service-role insert via /api/report). The counterweight to no-per-video-approval (CREATOR_STUDIO audit C3): converts a bad-content incident into a logged, admin-triaged event. Admin panic path = creator-unpublish cascade (20260523000006).';

-- ── 8a. voice_clone_finalize_creator ────────────────────────────────────────
-- Creator-scoped sibling of voice_clone_finalize_locked_v2 (cartesia lane
-- only — creators self-clone via the Cartesia pipeline). Called via the
-- JWT-bound client so auth.uid() resolves (audit C2). Semantics preserved
-- from the admin RPC: advisory lock, FOR UPDATE reads, already-finalized
-- guard, overwrite force semantics, delete-queue race block. Differences:
--   * ownership from auth.uid() (no p_creator_id / p_admin_user_id)
--   * overwrite additionally blocked while creators.published_at IS NOT NULL
--     (re-read UNDER the lock — audit M5; first-fill always completes)
--   * stamps voice_clone_scripts.used_at in the same txn (single-use)
CREATE FUNCTION public.voice_clone_finalize_creator(
  p_upload_id bigint,
  p_voice_id  text
) RETURNS TABLE (prior_voice_id text, active_sessions bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_creator_id uuid;
  v_published  timestamptz;
  v_upload     record;
  v_open       bigint;
  v_prior      text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT id INTO v_creator_id FROM public.creators WHERE user_id = v_uid;
  IF v_creator_id IS NULL THEN
    RAISE EXCEPTION 'not_a_creator' USING ERRCODE = '42501';
  END IF;

  IF p_voice_id IS NULL OR char_length(p_voice_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid voice_id length' USING ERRCODE = '22023';
  END IF;

  -- Same lock namespace as the admin RPC — admin + creator finalizes for the
  -- same creator serialize against each other.
  PERFORM pg_advisory_xact_lock(hashtext('voice_clone_overwrite:' || v_creator_id::text));

  SELECT uploaded_by_user_id, creator_id, cartesia_voice_id, tts_provider, script_id
    INTO v_upload
    FROM public.voice_clone_uploads
   WHERE id = p_upload_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload % not found', p_upload_id USING ERRCODE = '23503';
  END IF;
  IF v_upload.uploaded_by_user_id IS DISTINCT FROM v_uid
     OR v_upload.creator_id IS DISTINCT FROM v_creator_id THEN
    RAISE EXCEPTION 'upload ownership mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_upload.tts_provider IS DISTINCT FROM 'cartesia'::public.tts_provider THEN
    RAISE EXCEPTION 'creator finalize is cartesia-only' USING ERRCODE = '22023';
  END IF;
  IF v_upload.cartesia_voice_id IS NOT NULL THEN
    RAISE EXCEPTION 'upload % already finalized', p_upload_id USING ERRCODE = '23505';
  END IF;

  -- Prior voice + published state, both under the lock (audit M5 TOCTOU fix).
  SELECT voice_id, published_at INTO v_prior, v_published
    FROM public.creators WHERE id = v_creator_id FOR UPDATE;

  IF v_prior IS NOT NULL THEN
    -- Overwrite path. First-fill (v_prior NULL) always completes, even if the
    -- admin published the creator mid-clone (it is a fill, not a swap).
    IF v_published IS NOT NULL THEN
      RAISE EXCEPTION 'voice_locked_while_live' USING ERRCODE = 'P0001';
    END IF;
    SELECT count(*) INTO v_open
      FROM public.sessions
     WHERE creator_id = v_creator_id AND ended_at IS NULL;
    IF v_open > 0 THEN
      RAISE EXCEPTION 'creator has % active sessions', v_open USING ERRCODE = '55006';
    END IF;
  END IF;

  UPDATE public.voice_clone_uploads
     SET cartesia_voice_id = p_voice_id
   WHERE id = p_upload_id;

  UPDATE public.creators
     SET voice_id = p_voice_id
   WHERE id = v_creator_id;

  -- Script single-use stamp, same txn (plan R7).
  IF v_upload.script_id IS NOT NULL THEN
    UPDATE public.voice_clone_scripts
       SET used_at = now()
     WHERE id = v_upload.script_id AND used_at IS NULL;
  END IF;

  -- Delete-queue race block — verbatim semantics from finalize_locked_v2.
  DECLARE
    v_queue_attempts int;
  BEGIN
    SELECT attempts INTO v_queue_attempts
      FROM public.voice_delete_queue
     WHERE tts_provider = 'cartesia' AND voice_id = p_voice_id
     FOR UPDATE;
    IF FOUND THEN
      IF v_queue_attempts >= 1 THEN
        RAISE EXCEPTION 'voice_just_deleted_retry_paste: worker is/was dispatching DELETE for this voice (attempts=%)',
          v_queue_attempts USING ERRCODE = '55006';
      END IF;
      DELETE FROM public.voice_delete_queue
       WHERE tts_provider = 'cartesia' AND voice_id = p_voice_id;
    END IF;
  END;

  RETURN QUERY SELECT v_prior, COALESCE(v_open, 0::bigint);
END;$$;

REVOKE ALL ON FUNCTION public.voice_clone_finalize_creator(bigint, text)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.voice_clone_finalize_creator(bigint, text)
  TO authenticated;

-- ── 8b. face_clone_finalize_creator ─────────────────────────────────────────
-- Creator-scoped sibling of face_clone_finalize_locked. Same lock namespace,
-- same state machine, same idempotent ready-recheck; ownership from
-- auth.uid(); overwrite blocked while published (under lock).
CREATE FUNCTION public.face_clone_finalize_creator(
  p_upload_id      bigint,
  p_vendor_face_id text
) RETURNS TABLE (prior_face_id text, active_sessions bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_creator_id uuid;
  v_published  timestamptz;
  v_upload     record;
  v_open       bigint;
  v_prior      text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT id INTO v_creator_id FROM public.creators WHERE user_id = v_uid;
  IF v_creator_id IS NULL THEN
    RAISE EXCEPTION 'not_a_creator' USING ERRCODE = '42501';
  END IF;
  IF p_vendor_face_id IS NULL OR NOT (char_length(p_vendor_face_id) BETWEEN 1 AND 128) THEN
    RAISE EXCEPTION 'invalid vendor_face_id length' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('face_clone_overwrite:' || v_creator_id::text));

  SELECT id, uploaded_by_user_id, creator_id, vendor_face_id, state, force_overwrite
    INTO v_upload
    FROM public.face_clone_uploads
   WHERE id = p_upload_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload % not found', p_upload_id USING ERRCODE = '23503';
  END IF;
  IF v_upload.uploaded_by_user_id IS DISTINCT FROM v_uid
     OR v_upload.creator_id IS DISTINCT FROM v_creator_id THEN
    RAISE EXCEPTION 'upload ownership mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_upload.vendor_face_id IS DISTINCT FROM p_vendor_face_id THEN
    RAISE EXCEPTION 'vendor_face_id mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_upload.state = 'ready' THEN
    -- Idempotent re-poll (R2-C3 semantics preserved from the admin RPC).
    SELECT simli_face_id INTO v_prior FROM public.creators WHERE id = v_creator_id;
    IF v_prior IS DISTINCT FROM p_vendor_face_id THEN
      RAISE EXCEPTION 'face_state_drift: creators.simli_face_id=% expected=%', v_prior, p_vendor_face_id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT NULL::text, 0::bigint;
    RETURN;
  END IF;
  IF v_upload.state <> 'pending' THEN
    RAISE EXCEPTION 'upload % cannot finalize from state=%', p_upload_id, v_upload.state
      USING ERRCODE = '22023';
  END IF;

  SELECT simli_face_id, published_at INTO v_prior, v_published
    FROM public.creators WHERE id = v_creator_id FOR UPDATE;
  IF v_prior IS NOT NULL THEN
    IF v_published IS NOT NULL THEN
      RAISE EXCEPTION 'face_locked_while_live' USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_upload.force_overwrite THEN
      RAISE EXCEPTION 'creator already has a face' USING ERRCODE = '23505';
    END IF;
    SELECT count(*) INTO v_open
      FROM public.sessions
     WHERE creator_id = v_creator_id AND ended_at IS NULL;
    IF v_open > 0 THEN
      RAISE EXCEPTION 'creator has % active sessions', v_open USING ERRCODE = '55006';
    END IF;
  END IF;

  UPDATE public.face_clone_uploads
     SET state = 'ready', ready_at = now()
   WHERE id = p_upload_id;

  UPDATE public.creators
     SET simli_face_id = p_vendor_face_id, updated_at = now()
   WHERE id = v_creator_id;

  RETURN QUERY SELECT v_prior, COALESCE(v_open, 0::bigint);
END;$$;

REVOKE ALL ON FUNCTION public.face_clone_finalize_creator(bigint, text)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.face_clone_finalize_creator(bigint, text)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
