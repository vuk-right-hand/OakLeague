-- 20260528000012 — sample_content_chunks v3 (RAG v3 Step 3 / plan §4 item 3).
--
-- Extends the chunks table for v3 hierarchical retrieval:
--
--   * chunker_version CHECK: (1,2) → (1,2,3). Permanent enum extension
--     per plan §4 "Permanent-enum discipline"; v1/v2/v3 readers must never
--     mix, each read RPC hard-filters its own version.
--
--   * section_id uuid NULL → sample_content_sections(id) ON DELETE CASCADE.
--     NULL for v1/v2 chunks; NOT NULL for v3 (enforced by partial UNIQUE
--     and by _insert_chunk_v3_unsafe which derives it server-side).
--
--   * section_index smallint NULL. Denormalized from sections.section_index
--     so the partial UNIQUE below can dedup without a JOIN. NULL for v1/v2.
--     This denormalization mirrors how `chunker_version` is denormalized on
--     the chunk row itself.
--
-- ── R2-C4 — the partial-UNIQUE story (audit round-2) ─────────────────────
-- Today's 3-col unique `(sample_id, chunker_version, chunk_index)` from
-- 20260523000003 is UNCONDITIONAL. For v3, `chunk_index` becomes
-- SECTION-LOCAL (C5 idempotent re-embed needs section-bounded namespacing),
-- which means two v3 chunks in different sections of the same sample would
-- BOTH have e.g. (sample, 3, 0) and collide under the existing 3-col.
--
-- Round-2 R2-C4 chose: scope the existing 3-col to v1/v2 ONLY via partial,
-- and add a new 4-col partial for v3. `NULLS NOT DISTINCT` was the
-- rejected fallback (requires verifying the prod PG15 minor; partial-index
-- is portable and clearer).
--
-- Net contract:
--   v1/v2: dedup as before — `(sample_id, chunker_version, chunk_index)`
--          UNIQUE within {chunker_version IN (1, 2)}.
--   v3:    dedup on the 4-col `(sample_id, chunker_version, section_index,
--          chunk_index)` within {chunker_version = 3}. section_index
--          MUST be non-NULL for v3 (partial WHERE collapses NULL rows out).
--
-- ── Audit M4 — enum CHECK extension is the rewrite hazard ──────────────
-- `ALTER TABLE … ADD CONSTRAINT … NOT VALID` takes SHARE UPDATE EXCLUSIVE
-- (no read/write block) instead of ACCESS EXCLUSIVE. Then `VALIDATE
-- CONSTRAINT` takes SHARE UPDATE EXCLUSIVE too — readers + writers proceed
-- in parallel. The OLD CHECK is dropped LAST so the table is never
-- without an enum guard.
--
-- Adding a NULLable column (section_id, section_index) is metadata-only
-- on PG ≥11 — no table rewrite, no HNSW rebuild. The 10000-row guard
-- from migration 20260514000003 (which DID need it because v2 added a
-- STORED GENERATED column) is NOT required here.

-- ── 1. New CHECK constraint allowing (1,2,3), validated online ──────────
ALTER TABLE public.sample_content_chunks
  ADD CONSTRAINT sample_content_chunks_chunker_version_v3_check
    CHECK (chunker_version IN (1, 2, 3)) NOT VALID;

ALTER TABLE public.sample_content_chunks
  VALIDATE CONSTRAINT sample_content_chunks_chunker_version_v3_check;

-- Drop the old (1, 2) CHECK now that the new (1, 2, 3) is validated.
-- The old constraint's auto-generated name is sample_content_chunks_chunker_version_check
-- (from migration 20260514000003:39-40 — bare CHECK on the column).
-- IF EXISTS for replay safety: matches the discipline of 20260523000003:30
-- — a future hotfix or partial-snapshot rebuild that renames/drops this
-- constraint upstream would otherwise hard-error `db reset`. Audit round-4 M1.
ALTER TABLE public.sample_content_chunks
  DROP CONSTRAINT IF EXISTS sample_content_chunks_chunker_version_check;

COMMENT ON COLUMN public.sample_content_chunks.chunker_version IS
  '1 = legacy 300-token windows. 2 = narrative + contextual (RAG SOTA Phase 1). 3 = v3 routed hierarchy (Doc → Section → Unit → Child). Permanent enum extension — readers hard-filter by version (no mixing).';

-- ── 2. New NULLable section_id + section_index columns (metadata-only) ──
ALTER TABLE public.sample_content_chunks
  ADD COLUMN section_id uuid NULL
    REFERENCES public.sample_content_sections(id) ON DELETE CASCADE;

-- smallint ceiling 32767 >> any conceivable per-sample section count
-- (book: ~30-80; chapter-as-sample: ~5-15 — audit round-4 S6).
ALTER TABLE public.sample_content_chunks
  ADD COLUMN section_index smallint NULL CHECK (section_index IS NULL OR section_index >= 0);

CREATE INDEX sample_content_chunks_section_idx
  ON public.sample_content_chunks (section_id)
  WHERE section_id IS NOT NULL;

COMMENT ON COLUMN public.sample_content_chunks.section_id IS
  'v3: parent section. NULL for v1/v2. ON DELETE CASCADE so per-section re-embed (audit C5) cleans the whole subtree.';

COMMENT ON COLUMN public.sample_content_chunks.section_index IS
  'v3: denormalized sections.section_index so the partial-UNIQUE below can dedup without a JOIN. NULL for v1/v2 (those use the v1/v2 partial UNIQUE which excludes this column).';

-- ── 3. Scope the existing 3-col UNIQUE to v1/v2 ONLY (R2-C4 part 1) ─────
-- Drop the unconditional 3-col, replace with a partial covering chunker_version IN (1, 2).
-- Constraint→Index swap: an indexed constraint cannot have a WHERE; only a
-- UNIQUE INDEX can. The existing constraint name comes from migration
-- 20260523000003. IF EXISTS for replay safety (audit round-4 M1).
ALTER TABLE public.sample_content_chunks
  DROP CONSTRAINT IF EXISTS sample_content_chunks_sample_id_chunker_version_chunk_index_key;

CREATE UNIQUE INDEX sample_content_chunks_v1v2_sample_chunker_index_key
  ON public.sample_content_chunks (sample_id, chunker_version, chunk_index)
  WHERE chunker_version IN (1, 2);

-- ── 4. New 4-col partial UNIQUE for v3 (R2-C4 part 2) ───────────────────
-- v3 chunk_index is SECTION-LOCAL. (sample, 3, section, chunk_index) must
-- be unique. section_index NULL would be excluded by the WHERE, but the
-- v3 insert RPC enforces section_index NOT NULL server-side as a defense
-- in depth (NULL would silently slip through the partial dedup).
CREATE UNIQUE INDEX sample_content_chunks_v3_sample_section_chunk_index_key
  ON public.sample_content_chunks (sample_id, chunker_version, section_index, chunk_index)
  WHERE chunker_version = 3;
