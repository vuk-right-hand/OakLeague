-- FISH_AUDIO_PHASE_1 §4 M4 — voice_delete_queue: Fish-readiness assertions + doc
--
-- The Fish provider needs no NEW schema in voice_delete_queue. Once M1
-- (20260608100001_tts_provider_enum_add_fish.sql) widens the enum:
--   * Composite PK (tts_provider, voice_id) — already in place from
--     20260520000002_hume_voice_provider.sql §6. PK accepts fish rows.
--   * CHECK voice_delete_queue_hume_needs_name — predicate is
--     "tts_provider != 'hume' OR voice_name IS NOT NULL". Fish rows skip
--     the rhs requirement (predicate is true for them — Fish DELETE is
--     keyed by ID, not name).
--   * voice_delete_queue_claim_v2 / complete_v2 / record_failure_v2 —
--     don't filter by provider; transparent pass-through for fish.
--
-- This migration is intentionally minimal: a defensive assertion block
-- that guarantees the schema-side prerequisites haven't drifted since
-- plan v4 was written (round 3 M5 — implementation-time sanity check),
-- plus a column-comment refresh to mention Fish's DELETE shape.
--
-- The substantive Fish work for voice-delete-worker lives in
-- server/voice-proxy/voice-delete-worker.js (FISH_AUDIO_PHASE_1 §6,
-- separate task — adds dispatchFish() that calls DELETE
-- https://api.fish.audio/model/{voice_id} with Bearer auth; treats
-- 200/204/404 as success per Phase 0.5 #8 idempotency check).
--
-- Application-side prerequisites (audit C4 — out of schema scope but
-- LOAD-BEARING for the cutover; do NOT apply this migration to prod
-- before they are all on prod main):
--   * Zod validators in /api/admin/voice-clone/* and creator-tts-provider
--     mutation routes accept 'fish' as a valid tts_provider value.
--   * src/lib/admin/cogs-aggregations.ts adds 'fish' to its provider union
--     and exposes a cost_usd_fish bucket.
--   * server/voice-proxy/index.js, mint-voice-ticket.ts, sessions/open
--     all widen their tts_provider switches to include 'fish' (with
--     fallback default 'cartesia' unchanged).
--   * voice-delete-worker.js implements dispatchFish().
-- CI grep guard: scripts/check-tts-provider-writes.sh should fail when
-- it finds 'cartesia' | 'hume' narrow unions in routes that handle
-- per-creator overrides.

DO $$
DECLARE
  v_pk_columns text;
  v_has_hume_check boolean;
  v_has_fish boolean;
BEGIN
  -- 1. Composite PK still (tts_provider, voice_id). Audit M3 fix: order
  -- the columns by PK DEFINITION ordinality (k.ord), not by table attnum,
  -- so a future `PRIMARY KEY (voice_id, tts_provider)` reorder would be
  -- detected even though the column SET is the same.
  SELECT string_agg(a.attname, ',' ORDER BY k.ord)
    INTO v_pk_columns
    FROM pg_constraint c
    JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.conrelid = 'public.voice_delete_queue'::regclass
     AND c.contype  = 'p';
  IF v_pk_columns IS DISTINCT FROM 'tts_provider,voice_id' THEN
    RAISE EXCEPTION 'voice_delete_queue PK has unexpected shape (%); M4 expects composite (tts_provider, voice_id) from 20260520000002_hume_voice_provider', v_pk_columns;
  END IF;

  -- 2. hume_needs_name constraint still present (does not block fish).
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.voice_delete_queue'::regclass
       AND conname  = 'voice_delete_queue_hume_needs_name'
       AND contype  = 'c'
  ) INTO v_has_hume_check;
  IF NOT v_has_hume_check THEN
    RAISE EXCEPTION 'voice_delete_queue_hume_needs_name constraint missing — was dropped between Hume migration and Fish M4. Investigate before proceeding.';
  END IF;

  -- 3. 'fish' enum value visible (M1 must have run).
  SELECT EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'tts_provider'
       AND t.typnamespace = 'public'::regnamespace
       AND e.enumlabel = 'fish'
  ) INTO v_has_fish;
  IF NOT v_has_fish THEN
    RAISE EXCEPTION 'M4 requires 20260608100001 (tts_provider+fish). Apply migrations in order.';
  END IF;
END $$;

-- Audit M2 removed an ALTER TABLE ... VALIDATE CONSTRAINT line that was
-- intended as defensive intent but is NOT a no-op: VALIDATE CONSTRAINT
-- takes a SHARE UPDATE EXCLUSIVE lock on the table even when the
-- constraint is already valid (it was added without NOT VALID in
-- 20260520000002_hume_voice_provider:282-284, so it's already validated).
-- The DO-block assertion above is sufficient defensive intent without
-- the prod-hot-table lock cost.

COMMENT ON COLUMN public.voice_delete_queue.tts_provider IS
  'Which provider DELETE to dispatch. '
  'Cartesia → DELETE /voices/{voice_id} Bearer auth. '
  'Hume → DELETE /v0/tts/voices?name=<voice_name> X-Hume-Api-Key auth. '
  'Fish → DELETE https://api.fish.audio/model/{voice_id} Bearer auth (200/204/404 idempotent — pending Phase 0.5 #8 manual verification; update this comment with the cleared date once confirmed).';

COMMENT ON COLUMN public.voice_delete_queue.voice_name IS
  'Hume voice name (used as DELETE query param). NULL for Cartesia + Fish rows (both key DELETE by id). App-layer invariant: tts_provider=hume implies voice_name NOT NULL — enforced by writer routes (HUME_TTS_PLAN §5.4) AND the voice_delete_queue_hume_needs_name CHECK constraint.';

NOTIFY pgrst, 'reload schema';
