-- 20260531000002 — section_generation columns + UNIQUE swaps (Step-9 audit C2/C3).
--
-- ── Why this exists (the half-built-read bug) ───────────────────────────
-- A re-ingest of a creator ALREADY live on retrieval_version=3 deletes all of
-- a sample's sections up front (embed-worker.js) then rebuilds over minutes-to-
-- hours → empty/partial retrieval mid-rebuild ("the avatar blanks on what he
-- obviously knows"). creator_v3_ready only gates the INITIAL 2→3 flip, not
-- re-ingest of an already-flipped creator (Step-9 audit C2/C3).
--
-- ── The fix: generations ────────────────────────────────────────────────
-- A re-ingest builds a NEW "generation" of sections+units+chunks ALONGSIDE the
-- live one; finalize swaps a per-sample `active_section_generation` pointer
-- atomically; a deferred GC reclaims old generations (keeping active + prior
-- for rollback). This migration is the SCHEMA half: the generation columns +
-- the UNIQUE-constraint swaps that let two generations coexist. The RPC half
-- (route filter, gate scoping, finalize swap, GC) is 20260531000003.
--
-- ── Generation numbering (plan REV 3) ──────────────────────────────────
-- DEFAULT 1 everywhere → gen 1 = "everything that existed at migration time"
-- (v2-legacy units with section_id NULL AND any pre-existing v3 rows). Existing
-- data is already collision-free under the OLD uniques, so it satisfies the NEW
-- uniques at gen 1 unchanged (replay-safe; vuk_lehendas/scratch stay readable).
-- Every FUTURE v3 build targets active+1, so v3 re-ingests are always gen ≥ 2.
-- v2-legacy rows (section_id NULL) stay gen 1 and are owned by
-- admin_purge_legacy_chunks (the C1 soft-cutover purge), never the v3 GC.
--
-- ── C-1 (the constraint REV 2 forgot) ──────────────────────────────────
-- The v3 chunk UNIQUE is keyed on (section_index, chunk_index), NOT unit_index.
-- Without section_generation in it, gen N+1's section 0 / chunk 0 collides with
-- gen N's existing (sample,3,0,0) → 23505 on the first child insert of every
-- re-ingest. All three uniques get section_generation.
--
-- Additive + replay-safe. No new CREATE TABLE → existing grants inherit (S-1).

-- ── 1. Generation columns ───────────────────────────────────────────────
ALTER TABLE public.sample_content_sections
  ADD COLUMN IF NOT EXISTS section_generation int NOT NULL DEFAULT 1
    CHECK (section_generation >= 1);
ALTER TABLE public.sample_content_narrative_units
  ADD COLUMN IF NOT EXISTS section_generation int NOT NULL DEFAULT 1
    CHECK (section_generation >= 1);
ALTER TABLE public.sample_content_chunks
  ADD COLUMN IF NOT EXISTS section_generation int NOT NULL DEFAULT 1
    CHECK (section_generation >= 1);

-- Per-SAMPLE active pointer (swapped per-sample-finalize; finalize runs per
-- job = per sample). The single source of truth for "which generation the v3
-- read path sees" for that sample.
ALTER TABLE public.sample_content
  ADD COLUMN IF NOT EXISTS active_section_generation int NOT NULL DEFAULT 1
    CHECK (active_section_generation >= 1);

COMMENT ON COLUMN public.sample_content_sections.section_generation IS
  'RAG v3 atomic-swap re-ingest (Step-9 audit C2/C3). Which build generation this section belongs to. A re-ingest builds active+1 alongside the live generation; finalize swaps sample_content.active_section_generation. DEFAULT 1 = pre-migration data. The v3 read path (route + flat-fallback + creator_v3_ready) filters to the active generation; inactive generations are dormant + GC-reclaimed (admin_gc_stale_section_generations), keeping active + prior for rollback.';
COMMENT ON COLUMN public.sample_content.active_section_generation IS
  'RAG v3 atomic-swap re-ingest (Step-9 audit C2/C3). The currently-live section_generation for this sample. Swapped atomically by corpus_reprocess_finalize_v3 at the end of a re-ingest. DEFAULT 1. Per-SAMPLE (finalize runs per job = per sample). The route RPC / flat-fallback / creator_v3_ready filter v3 sections to this generation.';

-- ── 2. UNIQUE swaps — exact names verified against the live DB ───────────
-- sections: (sample_id, section_index) → (sample_id, section_generation, section_index)
ALTER TABLE public.sample_content_sections
  DROP CONSTRAINT sample_content_sections_sample_id_section_index_key;
ALTER TABLE public.sample_content_sections
  ADD CONSTRAINT sample_content_sections_sample_gen_section_index_key
  UNIQUE (sample_id, section_generation, section_index);

-- units: (sample_id, unit_index) → (sample_id, section_generation, unit_index).
-- This is what lets the worker drop the v3UnitBase watermark + restart
-- unit_index at 0 per generation (kills the int4-overflow + cross-gen-collision
-- class — Step-9 audit C4). v2-legacy units (section_id NULL) stay gen 1 and
-- keep their existing low unit_index values → no collision with a gen-1 v3
-- build (future v3 builds are gen ≥ 2; plan M-1).
ALTER TABLE public.sample_content_narrative_units
  DROP CONSTRAINT sample_content_narrative_units_sample_id_unit_index_key;
ALTER TABLE public.sample_content_narrative_units
  ADD CONSTRAINT sample_content_narrative_units_sample_gen_unit_index_key
  UNIQUE (sample_id, section_generation, unit_index);

-- chunks v3 partial: add section_generation BETWEEN chunker_version and
-- section_index (THE C-1 fix). Partial WHERE chunker_version=3 preserved.
DROP INDEX public.sample_content_chunks_v3_sample_section_chunk_index_key;
CREATE UNIQUE INDEX sample_content_chunks_v3_sample_section_chunk_index_key
  ON public.sample_content_chunks
     (sample_id, chunker_version, section_generation, section_index, chunk_index)
  WHERE chunker_version = 3;

-- ── 3. Indexes for the gen-aware readers ────────────────────────────────
-- (creator_id, section_generation) — serves _creator_active_section_ids_v3 (R2)
-- + the flat path; creator_id LEADING (those filter by creator_id). NOT the
-- HNSW route (that's index-scan-driven by the embedding ORDER BY). (S-2: the
-- existing _creator_idx leads on creator_id alone; this composite adds the gen
-- tiebreak for the active-id pull.)
CREATE INDEX IF NOT EXISTS sample_content_sections_creator_gen_idx
  ON public.sample_content_sections (creator_id, section_generation);
-- (sample_id, section_generation) — serves finalize's count + GC's per-sample
-- per-generation delete.
CREATE INDEX IF NOT EXISTS sample_content_sections_sample_gen_idx
  ON public.sample_content_sections (sample_id, section_generation);
-- chunks by (section_generation) for the GC's bulk delete-by-generation.
CREATE INDEX IF NOT EXISTS sample_content_chunks_sample_gen_idx
  ON public.sample_content_chunks (sample_id, section_generation)
  WHERE chunker_version = 3;
CREATE INDEX IF NOT EXISTS sample_content_narrative_units_sample_gen_idx
  ON public.sample_content_narrative_units (sample_id, section_generation);
