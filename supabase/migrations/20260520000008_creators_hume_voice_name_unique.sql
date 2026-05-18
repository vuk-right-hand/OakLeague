-- HUME_TTS_PLAN §5 audit C3 fix (2026-05-13)
--
-- Hume's voice library is keyed by NAME at the org level (not by id).
-- The voice_delete_queue worker dispatches DELETE-by-name. If two
-- creators happen to be assigned the same hume_voice_name (admin reused
-- a name, or two creators uploaded clips Hume auto-named identically),
-- an overwrite of creator A's voice would enqueue a DELETE that nukes
-- creator B's still-live voice too. Cross-creator collision.
--
-- Add partial UNIQUE INDEX per env-scoped column. Partial WHERE NOT
-- NULL because most creators today have no Hume voice — NULLs must be
-- allowed to coexist freely. The index activates the constraint only
-- on populated rows.
--
-- This is defense-in-depth alongside the route-level pre-check in
-- /api/admin/voice-clone/hume-id/route.ts which queries creators for
-- a conflicting name BEFORE calling the finalize RPC. The DB index is
-- the load-bearing guarantee.

CREATE UNIQUE INDEX IF NOT EXISTS creators_hume_voice_name_unique
  ON public.creators (hume_voice_name)
  WHERE hume_voice_name IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS creators_hume_voice_name_preview_unique
  ON public.creators (hume_voice_name_preview)
  WHERE hume_voice_name_preview IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS creators_hume_voice_name_dev_unique
  ON public.creators (hume_voice_name_dev)
  WHERE hume_voice_name_dev IS NOT NULL;

COMMENT ON INDEX public.creators_hume_voice_name_unique IS
  'Partial UNIQUE — prevents two creators from pointing at the same Hume voice name (Hume library is keyed by name org-wide; collision would let overwrite-DELETE nuke the wrong creator). Production env scope.';

NOTIFY pgrst, 'reload schema';
