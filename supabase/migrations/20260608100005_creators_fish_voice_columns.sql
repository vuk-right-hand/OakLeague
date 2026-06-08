-- FISH_AUDIO_PHASE_1 §6 wire-up gap M5 — env-scoped Fish voice columns +
-- voice_clone_uploads.fish_voice_id + tightened append-only trigger +
-- defensive raise on voice_clone_finalize_locked_v2 for fish.
--
-- Phase 1 M1–M4 widened enums (tts_provider, cogs_service), added
-- cogs_insert_turn_voice_v3, and asserted voice_delete_queue's composite PK
-- and CHECK shape work for Fish rows. The wire-up gap surfaced during
-- /server/voice-proxy/index.js wiring: mint-voice-ticket and the proxy's
-- consumed-ticket SELECT need a column to READ the Fish reference_id from
-- when `creators.tts_provider='fish'`. Analogous columns already exist for:
--
--   * cartesia: creators.voice_id / voice_id_preview / voice_id_dev
--               (20260507000002_creators_voice_id_env_scoped.sql)
--   * hume:     creators.hume_voice_id / hume_voice_id_preview / hume_voice_id_dev
--               (20260520000002_hume_voice_provider.sql)
--
-- Fish DELETE is keyed BY id only (`DELETE https://api.fish.audio/model/{voice_id}`,
-- Bearer auth, 200/204/404 idempotent — pending Phase 0.5 #8 manual
-- verification stamp). No voice_name companion column needed.
--
-- Fish has NO prosody columns in Phase 1 (no speed / trailing_silence /
-- description / model_version). Plan §6 marks them out-of-scope. If/when we
-- add them, follow Hume's _preview/_dev env-scoping pattern.
--
-- Fish IDs are 32-char hex per Phase 0.5 spike (scripts/fish-audio-ws-spike.mjs),
-- e.g. `baa1fcbdb14d4bb492af632c1cb17ace`. char_length(1, 128) CHECK matches
-- the Hume column shape — same loose-enough cap. Charset CHECK restricts to
-- alphanumeric + `-` + `_` to catch future-API drift (e.g. if Fish ever
-- introduces path-shaped refs like `models/abc`) at the DB boundary instead
-- of letting a malformed reference break a downstream URL builder.
--
-- ── Audit findings applied (1 round, 4C+7M+8S) ──────────────────────
-- C1 → defensive RAISE for p_tts_provider='fish' on voice_clone_finalize_locked_v2
--      (a fish-aware v3 RPC ships in a later migration when programmatic
--      Fish clone API lands; Phase 1 admin pastes reference_id directly).
-- C2 → struck route reference `/api/admin/voice-clone/fish-id` (does not yet exist).
-- C3 → trigger tightened: fill-in-once column MUST match row.tts_provider.
-- C4 (deferred — intentional) → creators-table audit-log preservation: multiple
--      provider voice_id_<env> columns may legitimately be populated for a
--      single creator (admin wants Cartesia + Fish on file to A/B compare or
--      flip back). The schema permits all three; proxy is responsible for
--      reading the column that matches the active tts_provider at session-open
--      and failing loud (4014 tts_no_voice) if the active provider's column
--      is NULL or stale. Hume's parallel migration has the same intentional
--      gap; a stricter CHECK would force admins to delete clones to switch
--      providers (regret). Same rationale applies to M3 (no partial unique
--      index on creator_id WHERE tts_provider='fish' — only `creators` is
--      the live truth; `voice_clone_uploads` is an audit-log table where
--      duplicates per creator are intended).
-- M1 → NOTIFY comment expanded to cover both column adds AND trigger change.
-- M2 → REVOKE EXECUTE … FROM public re-emitted on the trigger function (defensive).
-- M4 → charset CHECK on fish_voice_id columns.
-- M5 → RLS note in header (no policy changes; service-role-only tables).
-- M6 → pre-flight DO block asserting 'fish' enum value exists (mirrors M4's
--      defensive pattern at 20260608100004 / round-2 M3).
-- M7 → rollback warning in header.
-- S1 → trigger function `OR REPLACE` preserves grants (verified PG 17 docs);
--      re-emitting REVOKE is belt-and-suspenders per M2.
-- S2 → test #11 flipped from permissive to blocking (lockstep with C3).
--
-- ── ROLLBACK GOTCHA ───────────────────────────────────────────────────
-- `ALTER TABLE creators DROP COLUMN fish_voice_id*` succeeds regardless
-- of populated values and SILENTLY LOSES the Fish reference_ids. Operators
-- must SELECT the populated values into voice_delete_queue BEFORE the
-- DROP, otherwise the Fish provider holds orphan models and the GDPR
-- delete-worker has no source-of-truth. See FISH_AUDIO_PHASE_1 §11
-- break-glass for the documented sequence.
--
-- ── RLS ───────────────────────────────────────────────────────────────
-- `creators` and `voice_clone_uploads` are RLS-enabled (service-role write;
-- creators readable per existing policies). This migration adds no policies
-- — writes to fish_voice_id columns flow through service-role via the
-- finalize RPC and admin clone-upload route (TBD). No RLS change required.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE). Safe to
-- re-apply if a partial run aborts.


-- ─────────────────────────────────────────────────────────────────────
-- 0. Pre-flight: confirm 'fish' enum value exists (M6)
-- ─────────────────────────────────────────────────────────────────────
-- Mirrors the defensive pattern in 20260608100004. Migrations are time-
-- stamped to apply in order, but if a partial-apply leaves M1 (enum widen)
-- un-applied and someone manually targets M5, this guards against a silent
-- success that leaves the new columns valid for `tts_provider='cartesia'`
-- usage only.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type  t ON t.oid = e.enumtypid
     WHERE t.typname = 'tts_provider'
       AND e.enumlabel = 'fish'
  ) THEN
    RAISE EXCEPTION 'tts_provider enum is missing ''fish'' value — apply 20260608100001_tts_provider_enum_add_fish.sql first';
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────
-- 1. creators: env-scoped Fish voice id columns (M4 — charset CHECK)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS fish_voice_id          text CHECK (fish_voice_id          IS NULL OR (char_length(fish_voice_id)          BETWEEN 1 AND 128 AND fish_voice_id          ~ '^[A-Za-z0-9_-]+$')),
  ADD COLUMN IF NOT EXISTS fish_voice_id_preview  text CHECK (fish_voice_id_preview  IS NULL OR (char_length(fish_voice_id_preview)  BETWEEN 1 AND 128 AND fish_voice_id_preview  ~ '^[A-Za-z0-9_-]+$')),
  ADD COLUMN IF NOT EXISTS fish_voice_id_dev      text CHECK (fish_voice_id_dev      IS NULL OR (char_length(fish_voice_id_dev)      BETWEEN 1 AND 128 AND fish_voice_id_dev      ~ '^[A-Za-z0-9_-]+$'));

COMMENT ON COLUMN public.creators.fish_voice_id IS
  'Fish Audio voice reference_id for VERCEL_ENV=production. NULL until admin pastes from app.fish.audio/voices (admin clone-upload route is TBD; today admin writes directly via service-role SQL or a one-off admin script). Synthesis: wss://api.fish.audio/v1/tts/live `start.reference_id`. DELETE: DELETE https://api.fish.audio/model/{voice_id} Bearer auth, idempotent (200/204/404 — Phase 0.5 #8 manual verification stamp pending). Charset constrained to [A-Za-z0-9_-] to catch future-API drift before downstream URL builders see it.';
COMMENT ON COLUMN public.creators.fish_voice_id_preview IS
  'Fish voice reference_id for VERCEL_ENV=preview branches. Isolates branch tests from prod voice id.';
COMMENT ON COLUMN public.creators.fish_voice_id_dev IS
  'Fish voice reference_id for local development (no VERCEL_ENV set, or VERCEL_ENV=development). Isolates dev tests from prod.';


-- ─────────────────────────────────────────────────────────────────────
-- 2. voice_clone_uploads: fish_voice_id audit column (M4 — charset CHECK)
-- ─────────────────────────────────────────────────────────────────────
-- Hume has hume_voice_id + hume_voice_name (paired). Fish has only the id
-- (DELETE keyed by id). Single fill-in-once column.
ALTER TABLE public.voice_clone_uploads
  ADD COLUMN IF NOT EXISTS fish_voice_id text CHECK (fish_voice_id IS NULL OR (char_length(fish_voice_id) BETWEEN 1 AND 128 AND fish_voice_id ~ '^[A-Za-z0-9_-]+$'));

COMMENT ON COLUMN public.voice_clone_uploads.fish_voice_id IS
  'Fish Audio voice reference_id assigned at finalize. NULL until finalize succeeds (audit ledger of failed attempts stays NULL). Charset [A-Za-z0-9_-].';


-- ─────────────────────────────────────────────────────────────────────
-- 3. voice_clone_uploads_block_update — tightened to enforce
--    tts_provider ↔ column-being-filled coupling (C3)
-- ─────────────────────────────────────────────────────────────────────
-- Prior (Hume rewrite): three independent AND-ed fill-in-once clauses. A
-- compromised or buggy writer route could insert with tts_provider='fish'
-- then UPDATE both cartesia_voice_id AND hume_voice_id (+ name) AND
-- fish_voice_id in a single statement — the audit log would lie. Test #11
-- in the prior draft documented this permissive contract.
--
-- Tightened semantics:
--   * tts_provider IMMUTABLE after insert (unchanged).
--   * For each UPDATE, exactly the active-provider's fill-in-once column
--     may transition NULL → non-NULL. All other providers' columns must
--     stay NULL.
--   * created_at + sha256 + bytes + ... immutable (unchanged).

CREATE OR REPLACE FUNCTION public.voice_clone_uploads_block_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_active_arm_ok boolean;
  v_other_arms_ok boolean;
BEGIN
  -- Immutable fields first — fail fast on tampering.
  IF NOT (
       NEW.id                = OLD.id
   AND NEW.admin_user_id     = OLD.admin_user_id
   AND NEW.creator_id        = OLD.creator_id
   AND NEW.sha256            = OLD.sha256
   AND NEW.duration_seconds  = OLD.duration_seconds
   AND NEW.mime              = OLD.mime
   AND NEW.bytes             = OLD.bytes
   AND NEW.created_at        = OLD.created_at
   AND NEW.tts_provider      = OLD.tts_provider   -- tts_provider IMMUTABLE
  ) THEN
    RAISE EXCEPTION 'voice_clone_uploads is append-only (immutable row fields were mutated; only the active-provider fill-in-once column may transition)'
      USING ERRCODE = '42501';
  END IF;

  -- Per-provider arm: exactly the active-provider's fill-in-once column may
  -- transition; all other providers' columns must stay at OLD values
  -- (effectively NULL, since they were never permitted to fill on a row of
  -- a different provider).
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
    -- New tts_provider enum value would land here. Fail-loud — schema
    -- evolution must update this function explicitly, not silently skip
    -- the audit-log check.
    RAISE EXCEPTION 'voice_clone_uploads_block_update: unhandled tts_provider=% (extend trigger when adding a new provider enum value)', NEW.tts_provider
      USING ERRCODE = '42501';
  END IF;

  IF v_active_arm_ok AND v_other_arms_ok THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'voice_clone_uploads is append-only (only the active-provider fill-in-once column may transition; other providers'' columns must stay unchanged)'
    USING ERRCODE = '42501';
END;$$;

-- M2 — re-emit REVOKE EXECUTE FROM public on the function. PG 17 docs
-- confirm CREATE OR REPLACE preserves existing ACL, but stating it
-- explicitly future-proofs against a hot-path drop/recreate.
REVOKE EXECUTE ON FUNCTION public.voice_clone_uploads_block_update() FROM public;


-- ─────────────────────────────────────────────────────────────────────
-- 4. voice_clone_finalize_locked_v2 — defensive fish raise (C1)
-- ─────────────────────────────────────────────────────────────────────
-- The v2 finalize RPC has explicit cartesia/hume branches. With M1's enum
-- widening, a route layer can now pass p_tts_provider='fish'. The function
-- would fall through the ELSE -- hume branch and attempt to write
-- creators.hume_voice_id + hume_voice_name; the trigger above would block
-- with a confusing append-only error AFTER acquiring the advisory lock and
-- doing prior-voice snapshotting.
--
-- Defensive RAISE at the top of the function fails LOUD with a clear
-- message before any side effects. Fish finalize is intentionally NOT
-- IMPLEMENTED in Phase 1 — admin pastes reference_id from the Fish
-- dashboard directly into creators.fish_voice_id_<env> via a one-off
-- admin script or service-role SQL. A v3 of this RPC with fish support
-- ships when (a) Fish has a programmatic clone API or (b) we wire the
-- existing audit-log/finalize flow to fish_voice_id.
--
-- Reproducing the v2 body verbatim from 20260520000004 with the defensive
-- raise prepended. Any maintenance to v2 must be mirrored here (until v3
-- supersedes both). The original function body has not been modified
-- between its definition migration and this point.

CREATE OR REPLACE FUNCTION public.voice_clone_finalize_locked_v2(
  p_admin_user_id  uuid,
  p_upload_id      bigint,
  p_creator_id     uuid,
  p_tts_provider   public.tts_provider,
  p_voice_id       text,
  p_voice_name     text,
  p_force          boolean DEFAULT false
) RETURNS TABLE (
  prior_voice_id   text,
  prior_voice_name text,
  active_sessions  bigint
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_upload   record;
  v_admin    record;
  v_open     bigint;
  v_prior_id   text;
  v_prior_name text;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_clone_finalize_locked_v2: service_role only'
      USING ERRCODE = '42501';
  END IF;

  -- C1 defensive raise — Fish finalize is not implemented in Phase 1.
  IF p_tts_provider = 'fish' THEN
    RAISE EXCEPTION 'fish_finalize_not_implemented: voice_clone_finalize_locked_v2 has no fish branch; admin pastes Fish reference_id directly into creators.fish_voice_id_<env> in Phase 1. A v3 RPC with fish support is tracked in FISH_AUDIO_PHASE_1.'
      USING ERRCODE = '0A000';  -- feature_not_supported
  END IF;

  IF p_voice_id IS NULL OR char_length(p_voice_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid voice_id length' USING ERRCODE = '22023';
  END IF;

  IF p_tts_provider = 'hume' THEN
    IF p_voice_name IS NULL OR char_length(p_voice_name) NOT BETWEEN 1 AND 128 THEN
      RAISE EXCEPTION 'hume_voice_name_required: tts_provider=hume requires non-null p_voice_name (1..128 chars)'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT user_id, role, revoked_at
    INTO v_admin
    FROM public.admin_roles
   WHERE user_id = p_admin_user_id
     AND revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin not active' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('voice_clone_overwrite:' || p_creator_id::text));

  SELECT admin_user_id, creator_id, cartesia_voice_id, hume_voice_id, hume_voice_name, tts_provider
    INTO v_upload
    FROM public.voice_clone_uploads
   WHERE id = p_upload_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload % not found', p_upload_id USING ERRCODE = '23503';
  END IF;
  IF v_upload.admin_user_id IS DISTINCT FROM p_admin_user_id THEN
    RAISE EXCEPTION 'admin mismatch on upload %', p_upload_id USING ERRCODE = '22023';
  END IF;
  IF v_upload.creator_id IS DISTINCT FROM p_creator_id THEN
    RAISE EXCEPTION 'creator mismatch on upload %', p_upload_id USING ERRCODE = '22023';
  END IF;
  IF v_upload.tts_provider IS DISTINCT FROM p_tts_provider THEN
    RAISE EXCEPTION 'tts_provider mismatch on upload % (row=%, arg=%)',
      p_upload_id, v_upload.tts_provider, p_tts_provider
      USING ERRCODE = '22023';
  END IF;
  IF p_tts_provider = 'cartesia' AND v_upload.cartesia_voice_id IS NOT NULL THEN
    RAISE EXCEPTION 'upload % already finalized', p_upload_id USING ERRCODE = '23505';
  END IF;
  IF p_tts_provider = 'hume' AND v_upload.hume_voice_id IS NOT NULL THEN
    RAISE EXCEPTION 'upload % already finalized', p_upload_id USING ERRCODE = '23505';
  END IF;

  IF p_tts_provider = 'cartesia' THEN
    SELECT voice_id, NULL::text
      INTO v_prior_id, v_prior_name
      FROM public.creators
     WHERE id = p_creator_id
     FOR UPDATE;
  ELSE -- hume (fish already raised above)
    SELECT hume_voice_id, hume_voice_name
      INTO v_prior_id, v_prior_name
      FROM public.creators
     WHERE id = p_creator_id
     FOR UPDATE;
  END IF;

  IF v_prior_id IS NOT NULL THEN
    IF NOT p_force THEN
      RAISE EXCEPTION 'creator already cloned' USING ERRCODE = '23505';
    END IF;
    SELECT count(*) INTO v_open
      FROM public.sessions
     WHERE creator_id = p_creator_id
       AND ended_at IS NULL;
    IF v_open > 0 THEN
      RAISE EXCEPTION 'creator has % active sessions', v_open USING ERRCODE = '55006';
    END IF;
  END IF;

  IF p_tts_provider = 'cartesia' THEN
    UPDATE public.voice_clone_uploads
       SET cartesia_voice_id = p_voice_id
     WHERE id = p_upload_id;

    UPDATE public.creators
       SET voice_id = p_voice_id
     WHERE id = p_creator_id;
  ELSE -- hume
    UPDATE public.voice_clone_uploads
       SET hume_voice_id   = p_voice_id,
           hume_voice_name = p_voice_name
     WHERE id = p_upload_id;

    UPDATE public.creators
       SET hume_voice_id   = p_voice_id,
           hume_voice_name = p_voice_name
     WHERE id = p_creator_id;
  END IF;

  DECLARE
    v_queue_attempts int;
  BEGIN
    SELECT attempts INTO v_queue_attempts
      FROM public.voice_delete_queue
     WHERE tts_provider = p_tts_provider
       AND voice_id     = p_voice_id
     FOR UPDATE;
    IF FOUND THEN
      IF v_queue_attempts >= 1 THEN
        RAISE EXCEPTION 'voice_just_deleted_retry_paste: worker is/was dispatching DELETE for this voice (attempts=%); retry paste after the worker drains',
          v_queue_attempts
          USING ERRCODE = '55006';
      END IF;
      DELETE FROM public.voice_delete_queue
       WHERE tts_provider = p_tts_provider
         AND voice_id     = p_voice_id;
    END IF;
  END;

  RETURN QUERY SELECT v_prior_id, v_prior_name, COALESCE(v_open, 0::bigint);
END;$$;

-- ACL preserved by CREATE OR REPLACE; re-emit for explicitness.
REVOKE EXECUTE ON FUNCTION public.voice_clone_finalize_locked_v2(uuid, bigint, uuid, public.tts_provider, text, text, boolean)
  FROM public, anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────
-- 5. PostgREST schema reload (M1 — scope expanded)
-- ─────────────────────────────────────────────────────────────────────
-- New columns on creators + voice_clone_uploads (PostgREST view cache),
-- trigger function body change (no API impact but grouped here for the
-- one-NOTIFY-per-migration discipline), and voice_clone_finalize_locked_v2
-- body change (OpenAPI signature unchanged but body is — NOTIFY refreshes
-- any internal RPC caches).
NOTIFY pgrst, 'reload schema';
