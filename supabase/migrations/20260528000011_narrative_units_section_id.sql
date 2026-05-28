-- 20260528000011 — sample_content_narrative_units.section_id (RAG v3 Step 3 / plan §4 item 2).
--
-- Adds the section FK on narrative units. NULL = v2 unit (no section);
-- NOT NULL = v3 unit (linked to a sample_content_sections row).
--
-- Per plan §11/M4: a NULLable column ADD is metadata-only (no table rewrite,
-- no ACCESS EXCLUSIVE for any meaningful duration, no HNSW rebuild). The
-- chunk-count guard from migration 20260514000003 does NOT apply here.
--
-- ON DELETE CASCADE matches the sample_content / creators FK shape on
-- narrative_units: deleting a section deletes its units → deletes its
-- chunks (chunks v3 has section_id FK with CASCADE too). This is what
-- makes per-section idempotent re-embed (audit C5) work: the worker
-- DELETEs that section's row, the cascade drops units + chunks, then
-- re-INSERTs cleanly.
--
-- Backfill: left NULL for every existing v2 unit. v3 reprocess populates
-- via the new _insert_chunk_v3_unsafe path that inserts unit + section
-- together. v2 worker / v2 read RPC never touch this column.

ALTER TABLE public.sample_content_narrative_units
  ADD COLUMN section_id uuid NULL
    REFERENCES public.sample_content_sections(id) ON DELETE CASCADE;

CREATE INDEX sample_content_narrative_units_section_idx
  ON public.sample_content_narrative_units (section_id)
  WHERE section_id IS NOT NULL;

COMMENT ON COLUMN public.sample_content_narrative_units.section_id IS
  'v3 routing: parent section. NULL for v2 units (no section). NOT NULL for v3. ON DELETE CASCADE so the C5 per-section idempotent re-embed (DELETE section → units → chunks fall via cascade) works cleanly.';
