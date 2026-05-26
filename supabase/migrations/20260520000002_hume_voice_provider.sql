-- HUME_TTS_PLAN §3.2 — Hume voice provider schema
--
-- Adds the tts_provider enum + per-creator override columns + env-scoped
-- Hume voice id/name columns + paired-CHECK + speed CHECK. Extends
-- sessions, voice_tickets, voice_clone_uploads, voice_delete_queue with
-- tts_provider + backfill to 'cartesia' for historical rows. Reworks the
-- voice_clone_uploads append-only trigger to honor the new columns.
-- Composite-PKs voice_delete_queue on (tts_provider, voice_id) and adds
-- v2 queue RPCs that take tts_provider explicitly.
--
-- DELETE-by-name discovery (Phase-0 2026-05-13): Hume keys voice DELETE by
-- NAME (`DELETE /v0/tts/voices?name=<name>`), not by UUID. Synthesis uses
-- the voice id. So we store BOTH and the paired-CHECK enforces they move
-- together — see voice_clone_finalize_locked_v2 in 20260520000004.
--
-- Order of operations (R3-C3 fix — application of HUME_TTS_PLAN §5.5):
--   1. This migration adds tts_provider with DEFAULT 'cartesia' on
--      voice_clone_uploads + voice_delete_queue. Existing routes keep
--      working (their INSERTs don't pass tts_provider; default fills it in).
--   2. §5.5 route patches land in /api/admin/voice-clone/route.ts so every
--      writer site passes tts_provider explicitly. CI grep enforces.
--   3. ONLY after §5.5 ships: 20260521000000 follow-up migration DROPS the
--      DEFAULTs so any missed writer 23502s instead of silently mis-tagging.
--
-- This migration is idempotent (ADD COLUMN IF NOT EXISTS / DO blocks).
-- Safe to re-apply if a partial run aborts.

-- ─────────────────────────────────────────────────────────────────────
-- 1. tts_provider enum
-- ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.tts_provider AS ENUM ('cartesia', 'hume');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ─────────────────────────────────────────────────────────────────────
-- 2. creators: per-creator override + env-scoped Hume voice id/name pairs + speed
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.creators
  ADD COLUMN IF NOT EXISTS tts_provider             public.tts_provider, -- NULL = inherit env (resolved at session-open)
  ADD COLUMN IF NOT EXISTS hume_voice_id            text CHECK (hume_voice_id            IS NULL OR char_length(hume_voice_id)            BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS hume_voice_id_preview    text CHECK (hume_voice_id_preview    IS NULL OR char_length(hume_voice_id_preview)    BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS hume_voice_id_dev        text CHECK (hume_voice_id_dev        IS NULL OR char_length(hume_voice_id_dev)        BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS hume_voice_name          text CHECK (hume_voice_name          IS NULL OR char_length(hume_voice_name)          BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS hume_voice_name_preview  text CHECK (hume_voice_name_preview  IS NULL OR char_length(hume_voice_name_preview)  BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS hume_voice_name_dev      text CHECK (hume_voice_name_dev      IS NULL OR char_length(hume_voice_name_dev)      BETWEEN 1 AND 128),
  -- Hume's own UI documents speed range as [0.5, 2.0] (Phase-0 re-probe
  -- 2026-05-13 via Hume Python SDK + dashboard screenshot). Founder tested
  -- speed=1.5 + trailing_silence=0.25 on Hume Octave 2 and verified result
  -- was dramatically better than default — earlier audit's [0.85, 1.10] cap
  -- was tighter than what Hume itself exposes. Sweet spot per Hume docs is
  -- 0.75–1.5; values outside that can cause instability but are accepted.
  ADD COLUMN IF NOT EXISTS hume_tts_speed           numeric CHECK (hume_tts_speed IS NULL OR (hume_tts_speed >= 0.5 AND hume_tts_speed <= 2.0)),

  -- Trailing silence: 0–5 seconds, applied per synthesis turn. Default 0.3
  -- matches Hume's dashboard default. Phase-0 re-probe 2026-05-13 confirms
  -- per-request synthesis parameter on /v0/tts/stream/input.
  ADD COLUMN IF NOT EXISTS hume_trailing_silence         numeric DEFAULT 0.3 CHECK (hume_trailing_silence         IS NULL OR (hume_trailing_silence         >= 0 AND hume_trailing_silence         <= 5)),
  ADD COLUMN IF NOT EXISTS hume_trailing_silence_preview numeric DEFAULT 0.3 CHECK (hume_trailing_silence_preview IS NULL OR (hume_trailing_silence_preview >= 0 AND hume_trailing_silence_preview <= 5)),
  ADD COLUMN IF NOT EXISTS hume_trailing_silence_dev     numeric DEFAULT 0.3 CHECK (hume_trailing_silence_dev     IS NULL OR (hume_trailing_silence_dev     >= 0 AND hume_trailing_silence_dev     <= 5)),

  -- Octave 2 acting-instructions hint. Hume cap is 1000 chars per request
  -- but recommends ≤100 chars when voice is set (per Hume docs 2026-05-13).
  -- NOTE: as of 2026-05-13 description is currently inert on Octave 2 — Hume
  -- says acting instructions on v2 is "coming soon." We persist it now so
  -- the bridge is ready the moment Hume turns it on, and so admin can
  -- author per-creator prosody hints alongside the voice.
  ADD COLUMN IF NOT EXISTS hume_voice_description         text CHECK (hume_voice_description         IS NULL OR char_length(hume_voice_description)         BETWEEN 1 AND 1000),
  ADD COLUMN IF NOT EXISTS hume_voice_description_preview text CHECK (hume_voice_description_preview IS NULL OR char_length(hume_voice_description_preview) BETWEEN 1 AND 1000),
  ADD COLUMN IF NOT EXISTS hume_voice_description_dev     text CHECK (hume_voice_description_dev     IS NULL OR char_length(hume_voice_description_dev)     BETWEEN 1 AND 1000),

  -- Octave model pin. '2' (default) = newer model, better baseline quality,
  -- founder-tested. '1' = older, slower, but acting-instructions work today.
  -- 'default' = let Hume auto-route based on detected language.
  ADD COLUMN IF NOT EXISTS hume_model_version         text DEFAULT '2' CHECK (hume_model_version         IN ('1','2','default')),
  ADD COLUMN IF NOT EXISTS hume_model_version_preview text DEFAULT '2' CHECK (hume_model_version_preview IN ('1','2','default')),
  ADD COLUMN IF NOT EXISTS hume_model_version_dev     text DEFAULT '2' CHECK (hume_model_version_dev     IN ('1','2','default'));

-- Paired-presence: id and name move together across all three envs.
-- HUME_TTS_PLAN §3.2: Hume keys DELETE by name, synthesis by id; both must
-- exist before either is usable. The CHECK ensures we never persist an
-- orphan id (no name to delete with) or an orphan name (no id to synthesize
-- with). voice_clone_finalize_locked_v2 (migration 4) writes both columns
-- in the same UPDATE statement so the CHECK never sees an intermediate state.
ALTER TABLE public.creators
  ADD CONSTRAINT creators_hume_voice_paired_chk CHECK (
    (hume_voice_id         IS NULL) = (hume_voice_name         IS NULL) AND
    (hume_voice_id_preview IS NULL) = (hume_voice_name_preview IS NULL) AND
    (hume_voice_id_dev     IS NULL) = (hume_voice_name_dev     IS NULL)
  );

COMMENT ON COLUMN public.creators.tts_provider IS
  'NULL = inherit voice-proxy env (VOICE_TTS_PROVIDER). Set to cartesia|hume to override per-creator. Locked at session-open snapshot into sessions.tts_provider_at_session and voice_tickets.tts_provider — never re-read mid-session.';
COMMENT ON COLUMN public.creators.hume_voice_id IS
  'Hume Octave 2 voice UUID for VERCEL_ENV=production. Synthesis-side. NULL until admin pastes from app.hume.ai/voices via /api/admin/voice-clone/hume-id (HUME_TTS_PLAN §5.2). Paired with hume_voice_name.';
COMMENT ON COLUMN public.creators.hume_voice_name IS
  'Hume voice NAME (production env). Used for DELETE /v0/tts/voices?name=<name> per Phase-0 2026-05-13 verification. Paired with hume_voice_id.';
COMMENT ON COLUMN public.creators.hume_tts_speed IS
  'Hume synth-time speed multiplier, range [0.5, 2.0] matching Hume dashboard. Sweet spot 0.75–1.5 per Hume docs; outside instability accepted but flagged. Founder-tested 1.5 on Octave 2 — verified dramatic improvement.';
COMMENT ON COLUMN public.creators.hume_trailing_silence IS
  'Seconds of trailing silence per synth turn, [0, 5], default 0.3. Per-request parameter on /v0/tts/stream/input (Phase-0 re-probe 2026-05-13).';
COMMENT ON COLUMN public.creators.hume_voice_description IS
  'Acting-instructions hint passed per synth call (≤1000 chars; recommended ≤100). INERT on Octave 2 today — Hume says coming soon. Persisted now for forward-compat.';
COMMENT ON COLUMN public.creators.hume_model_version IS
  'Octave model pin: 2 (default, founder-tested), 1 (older, supports acting today), or default (Hume auto-routes by language).';


-- ─────────────────────────────────────────────────────────────────────
-- 3. sessions: snapshot the provider at session-open
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS tts_provider_at_session public.tts_provider;

-- R1-C4 + R2-Small: backfill historical rows (only ended ones to dodge
-- lock contention on live rows; live rows will be re-snapshotted by
-- /api/sessions/open after §6 deploys). Stays nullable — pre-migration
-- rows have no snapshot and dashboards read NULL as "Cartesia by
-- construction" (only provider before this migration existed).
UPDATE public.sessions
   SET tts_provider_at_session = 'cartesia'
 WHERE tts_provider_at_session IS NULL
   AND ended_at IS NOT NULL;

COMMENT ON COLUMN public.sessions.tts_provider_at_session IS
  'TTS provider snapshotted at /api/sessions/open. NEVER re-read mid-session. NULL on pre-migration rows = cartesia by construction (HUME_TTS_PLAN §2.5).';


-- ─────────────────────────────────────────────────────────────────────
-- 4. voice_tickets: carry the provider so the proxy reads it once at consume
-- ─────────────────────────────────────────────────────────────────────
-- R2-C1: the proxy's consumeTicket() SELECT extends to read tts_provider.
-- Without this column the proxy would either need an extra DB round-trip
-- (sessions lookup) or fall back to env (which races with mid-session flips).
--
-- Unit-wide audit M1 fix (2026-05-13): add temporary DEFAULT 'cartesia'
-- to dodge the SET-NOT-NULL race. Between the UPDATE backfill below and
-- the SET NOT NULL further down, concurrent mint-voice-ticket INSERTs
-- (which don't yet pass tts_provider explicitly — that's a §6 wire-up)
-- would land as NULL and trip SET-NOT-NULL validation. DEFAULT fills
-- them in instead. The DEFAULT gets dropped in
-- 20260520000012_drop_voice_tickets_tts_provider_default.sql (audit S4 —
-- corrected from a stale "20260521000000" reference) after §6 mint code
-- is patched to pass tts_provider explicitly. The parallel
-- voice_clone_uploads / voice_delete_queue DEFAULT drop is
-- 20260520000007_drop_tts_provider_defaults.sql.
ALTER TABLE public.voice_tickets
  ADD COLUMN IF NOT EXISTS tts_provider public.tts_provider NOT NULL DEFAULT 'cartesia';

-- ADD COLUMN ... NOT NULL DEFAULT is a single atomic operation in PG 11+:
-- existing rows are populated with the DEFAULT instantly (metadata-only
-- change, no rewrite) AND the column comes in NOT NULL from the start.
-- Concurrent INSERTs land with the DEFAULT. No window where NULL can
-- exist. Audit C5 (expiry-gated DELETE) became unnecessary once the
-- column was made NOT NULL DEFAULT atomically — the original
-- expiry-gated DELETE was guarding against a NULL window that no
-- longer exists. The DEFAULT itself gets dropped in 20260521000000
-- follow-up after §6 mint-voice-ticket code passes tts_provider
-- explicitly.

COMMENT ON COLUMN public.voice_tickets.tts_provider IS
  'TTS provider locked at mint time. Proxy reads via consumeTicket; never falls back to env on consume side (HUME_TTS_PLAN §6.1).';


-- ─────────────────────────────────────────────────────────────────────
-- 5. voice_clone_uploads: tts_provider + Hume id/name audit columns
-- ─────────────────────────────────────────────────────────────────────
-- R2-C3 / R3-C3: NOT NULL with TEMPORARY DEFAULT 'cartesia' for the deploy
-- window. The §5.5 route patches add explicit tts_provider to every INSERT
-- BEFORE 20260521000000 drops the DEFAULT.
ALTER TABLE public.voice_clone_uploads
  ADD COLUMN IF NOT EXISTS tts_provider     public.tts_provider NOT NULL DEFAULT 'cartesia',
  ADD COLUMN IF NOT EXISTS hume_voice_id    text CHECK (hume_voice_id   IS NULL OR char_length(hume_voice_id)   BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS hume_voice_name  text CHECK (hume_voice_name IS NULL OR char_length(hume_voice_name) BETWEEN 1 AND 128);

COMMENT ON COLUMN public.voice_clone_uploads.tts_provider IS
  'Which TTS provider this clone targets. Drives the rate-limit COUNT query (HUME_TTS_PLAN §5.3).';
COMMENT ON COLUMN public.voice_clone_uploads.hume_voice_id IS
  'Hume voice UUID assigned at finalize. NULL until finalize succeeds (audit ledger of failed attempts stays NULL). Paired with hume_voice_name.';
COMMENT ON COLUMN public.voice_clone_uploads.hume_voice_name IS
  'Hume voice name used for DELETE dispatch. Paired with hume_voice_id.';


-- R3-M3: rework voice_clone_uploads_block_update to honor the new columns
-- without losing the append-only contract. Current trigger only knows
-- cartesia_voice_id. New rules:
--   * tts_provider is IMMUTABLE after insert
--   * cartesia_voice_id: NULL → non-NULL once (existing behavior preserved)
--   * hume_voice_id AND hume_voice_name: NULL → non-NULL ONCE, MUST transition
--     together (matches creators paired-CHECK)
--
-- Replace the function in place; trigger binding survives the OR REPLACE.
CREATE OR REPLACE FUNCTION public.voice_clone_uploads_block_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id                = OLD.id
 AND NEW.admin_user_id     = OLD.admin_user_id
 AND NEW.creator_id        = OLD.creator_id
 AND NEW.sha256            = OLD.sha256
 AND NEW.duration_seconds  = OLD.duration_seconds
 AND NEW.mime              = OLD.mime
 AND NEW.bytes             = OLD.bytes
 AND NEW.created_at        = OLD.created_at
 AND NEW.tts_provider      = OLD.tts_provider  -- IMMUTABLE after insert
 AND (
      -- cartesia_voice_id transition rule (existing)
      NEW.cartesia_voice_id IS NOT DISTINCT FROM OLD.cartesia_voice_id
      OR (OLD.cartesia_voice_id IS NULL AND NEW.cartesia_voice_id IS NOT NULL)
    )
 AND (
      -- hume_voice_id / hume_voice_name paired-transition rule
      (NEW.hume_voice_id   IS NOT DISTINCT FROM OLD.hume_voice_id AND
       NEW.hume_voice_name IS NOT DISTINCT FROM OLD.hume_voice_name)
      OR (OLD.hume_voice_id IS NULL AND OLD.hume_voice_name IS NULL
          AND NEW.hume_voice_id IS NOT NULL AND NEW.hume_voice_name IS NOT NULL)
    )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'voice_clone_uploads is append-only (cartesia_voice_id OR (hume_voice_id + hume_voice_name) are the only fill-in-once transitions; tts_provider is immutable)'
    USING ERRCODE = '42501';
END;$$;


-- ─────────────────────────────────────────────────────────────────────
-- 6. voice_delete_queue: composite PK + tts_provider + voice_name
-- ─────────────────────────────────────────────────────────────────────
-- R3-M5: composite PK (tts_provider, voice_id) prevents the conceptually-
-- wrong "same voice_id-string keys both providers" edge case. Practical
-- collision probability between Cartesia + Hume UUIDs is near-zero but
-- onConflict-by-voice_id-alone in upsert paths would silently mis-merge.
--
-- The migration drops the existing single-column PK and recreates it as a
-- composite. Existing rows are all Cartesia (only provider before this);
-- the DEFAULT 'cartesia' on the new column means they backfill automatically
-- and the new PK applies cleanly.

ALTER TABLE public.voice_delete_queue
  ADD COLUMN IF NOT EXISTS tts_provider public.tts_provider NOT NULL DEFAULT 'cartesia',
  ADD COLUMN IF NOT EXISTS voice_name   text CHECK (voice_name IS NULL OR char_length(voice_name) BETWEEN 1 AND 128);

-- Drop the old single-column PK and recreate composite.
--
-- Audit M7 — make the PK swap a TRUE no-op on re-run. The bare
-- DROP IF EXISTS / ADD pair is NOT idempotent: if a prior `db push`
-- batch aborted between the DROP and the ADD, a re-run either (a) ADDs a
-- second PK (42P16) or (b) ADDs an already-present composite PK (42710).
-- Guard on the actual constraint shape: only act when the composite PK is
-- not already in place. (Verified 2026-05-14: no FK references
-- voice_delete_queue.voice_id, so the DROP cannot fail on 2BP01
-- dependent-objects.)
DO $$
DECLARE
  v_is_composite boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.voice_delete_queue'::regclass
      AND c.contype = 'p'
      AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
          WHERE attrelid = 'public.voice_delete_queue'::regclass AND attname = 'tts_provider'),
        (SELECT attnum FROM pg_attribute
          WHERE attrelid = 'public.voice_delete_queue'::regclass AND attname = 'voice_id')
      ]::int2[]
  ) INTO v_is_composite;

  IF NOT v_is_composite THEN
    ALTER TABLE public.voice_delete_queue DROP CONSTRAINT IF EXISTS voice_delete_queue_pkey;
    ALTER TABLE public.voice_delete_queue
      ADD CONSTRAINT voice_delete_queue_pkey PRIMARY KEY (tts_provider, voice_id);
  END IF;
END $$;

-- Audit M3 fix (2026-05-13): DB-level enforcement that Hume rows always
-- carry a voice_name. Hume's DELETE endpoint is keyed by name; an enqueued
-- row without one would be undispatchable by the §5.4 worker — silent
-- orphan. Cartesia rows are unaffected (Cartesia keys by id, voice_name
-- stays NULL).
ALTER TABLE public.voice_delete_queue
  DROP CONSTRAINT IF EXISTS voice_delete_queue_hume_needs_name;
ALTER TABLE public.voice_delete_queue
  ADD CONSTRAINT voice_delete_queue_hume_needs_name
  CHECK (tts_provider != 'hume' OR voice_name IS NOT NULL);

COMMENT ON COLUMN public.voice_delete_queue.tts_provider IS
  'Which provider DELETE to dispatch. Cartesia → DELETE /voices/{voice_id} Bearer auth. Hume → DELETE /v0/tts/voices?name=<voice_name> X-Hume-Api-Key auth.';
COMMENT ON COLUMN public.voice_delete_queue.voice_name IS
  'Hume voice name (used as DELETE query param). NULL for Cartesia rows (Cartesia keys by id). App-layer invariant: tts_provider=hume implies voice_name NOT NULL — enforced by writer routes (HUME_TTS_PLAN §5.4).';


-- ─────────────────────────────────────────────────────────────────────
-- 7. voice_delete_queue RPCs v2 — take tts_provider explicitly
-- ─────────────────────────────────────────────────────────────────────
-- New RPCs with _v2 suffix; old RPCs remain callable for one deploy
-- window. The §5.4 worker code switches to v2 in the same PR. After
-- burn-in, old RPCs can be dropped in a follow-up migration.

CREATE OR REPLACE FUNCTION public.voice_delete_queue_claim_v2(p_limit int DEFAULT 5)
RETURNS TABLE (tts_provider public.tts_provider, voice_id text, voice_name text, attempts int, due_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_delete_queue_claim_v2: service_role only'
      USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'p_limit out of range' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    UPDATE public.voice_delete_queue q
       SET attempts = q.attempts + 1, updated_at = now()
     WHERE (q.tts_provider, q.voice_id) IN (
       SELECT inner_q.tts_provider, inner_q.voice_id
         FROM public.voice_delete_queue inner_q
        WHERE inner_q.due_at <= now()
          AND inner_q.attempts < 10
        ORDER BY inner_q.due_at ASC
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
     )
    RETURNING q.tts_provider, q.voice_id, q.voice_name, q.attempts, q.due_at;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_delete_queue_claim_v2(int)
  FROM public, anon, authenticated;


CREATE OR REPLACE FUNCTION public.voice_delete_queue_complete_v2(
  p_tts_provider public.tts_provider,
  p_voice_id     text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_delete_queue_complete_v2: service_role only'
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.voice_delete_queue
   WHERE tts_provider = p_tts_provider
     AND voice_id     = p_voice_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_delete_queue_complete_v2(public.tts_provider, text)
  FROM public, anon, authenticated;


CREATE OR REPLACE FUNCTION public.voice_delete_queue_record_failure_v2(
  p_tts_provider public.tts_provider,
  p_voice_id     text,
  p_last_error   text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_delete_queue_record_failure_v2: service_role only'
      USING ERRCODE = '42501';
  END IF;
  -- §5 audit M7 fix + unit-wide audit M5 (2026-05-13): record_failure
  -- must capture the final attempt's error message too (attempts<=10),
  -- otherwise the fatal Sentry alert at attempts=10 references stale
  -- last_error from attempt 9. The 30-day purge_dead GC still works
  -- because record_failure stops being called on the next tick once
  -- claim_v2's `attempts < 10` filter excludes the row, freezing
  -- updated_at.
  UPDATE public.voice_delete_queue
     SET last_error = LEFT(coalesce(p_last_error, 'unknown'), 500),
         updated_at = now()
   WHERE tts_provider = p_tts_provider
     AND voice_id     = p_voice_id
     AND attempts     <= 10;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_delete_queue_record_failure_v2(public.tts_provider, text, text)
  FROM public, anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────
-- 8. PostgREST schema reload (audit M7 fix)
-- ─────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE FUNCTION changes function signatures (paired v2 RPCs +
-- new columns exposed via PostgREST views). Without an explicit reload,
-- PostgREST's 60–300s OpenAPI cache may serve the OLD signature/columns
-- and return PGRST204 (column not found) or call the wrong function
-- variant. NOTIFY pgrst, 'reload schema' forces an immediate refresh.
NOTIFY pgrst, 'reload schema';
