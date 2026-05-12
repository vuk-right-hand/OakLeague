-- 20260512000002 — brain_mode enum + creators.brain_mode column.
--
-- M2 of pgvector RAG plan (R3 C1 + C2 fix: prior draft declared these in prose
-- only, leaving M6/M7/route SELECTs unresolvable). Must land BEFORE any
-- downstream RPC, CHECK, or route reads the column.
--
-- DEFAULT 'drawer' keeps existing creators on the proven topic-drawer path.
-- Flipped to 'vector' only via admin_set_creator_brain_mode (M7) which also
-- triggers a persona recompile (per-mode personas — see M10).

CREATE TYPE public.brain_mode AS ENUM ('drawer', 'vector');

ALTER TABLE public.creators
  ADD COLUMN brain_mode public.brain_mode NOT NULL DEFAULT 'drawer';

COMMENT ON COLUMN public.creators.brain_mode IS
  'Retrieval strategy. ''drawer'' = hook-tag overlap seed at session-open (legacy). ''vector'' = per-turn pgvector retrieval injected mid-session. Admin-only flip via admin_set_creator_brain_mode; flip triggers a per-mode persona recompile inside the same transaction.';
