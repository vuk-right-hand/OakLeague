-- 20260528000014 — _insert_chunk_v3_unsafe: section_id must match
-- parent_unit.section_id (round-5 audit C2 — defense at the write path).
--
-- ── The bug class this migration closes ─────────────────────────────────
-- Round-5 audit C2: the v3 RPC validates `section.sample_id =
-- parent_unit.sample_id` (the v3 cross-sample closure from mig 13) but
-- NEVER checks that the section_id passed by the worker MATCHES the
-- parent_unit's own section_id. A worker bug, partial rerun, or manual
-- UPDATE could insert chunks of the same parent under TWO different
-- section_ids (both under the same sample). The downstream
-- _creator_knowledge_topk_v3 RPC would then group that parent's chunks
-- under each section_id separately — double-counting parent budget under
-- the per-section clamp, polluting the rerank candidate set with the same
-- parent_text in two slots, and silently scrambling MAX-child scoring.
--
-- ── Defense in depth ───────────────────────────────────────────────────
-- Round-5 also lifted the read-path defense: _creator_knowledge_topk_v3
-- now JOINs narrative_units.section_id (authoritative) instead of trusting
-- the denormalized chunks.section_id alone (migration 20260528000031 round-5
-- edit). This write-path check is the FIRST line — a bad row never lands.
-- The read-path JOIN is the SECOND line — even if some row slipped in (e.g.
-- via raw SQL bypassing the RPC), the topk emits the right number of rows.
--
-- ── Why this is its own migration ──────────────────────────────────────
-- 20260528000013 is already committed (commit 5f38799). Editing it would
-- rewrite history; safer to add a tiny CREATE OR REPLACE migration on top.
-- The function signature is unchanged, so no PostgREST cache concerns and
-- no caller changes are required.

CREATE OR REPLACE FUNCTION public._insert_chunk_v3_unsafe(
  p_parent_unit_id  uuid,
  p_section_id      uuid,
  p_chunk_index     int,
  p_text            text,
  p_chunk_context   text,
  p_token_count     int,
  p_topic_tags      text[],
  p_embedding       halfvec(768),
  p_embedding_model text DEFAULT 'gemini-embedding-001'
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_parent_sample        uuid;
  v_parent_section_id    uuid;
  v_creator_id           uuid;
  v_section_sample       uuid;
  v_section_index        smallint;
  v_chunk_id             uuid;
  v_bad                  text[];
BEGIN
  -- Derive canonical IDs from the parent unit row. Audit-2 C1.
  -- New round-5: pull parent_unit.section_id here too so we can check
  -- match against p_section_id below.
  SELECT sample_id, creator_id, section_id
    INTO v_parent_sample, v_creator_id, v_parent_section_id
    FROM public.sample_content_narrative_units
   WHERE id = p_parent_unit_id;
  IF v_parent_sample IS NULL THEN
    RAISE EXCEPTION USING errcode = '42704', message = 'parent_unit_not_found';
  END IF;

  -- v3 invariant: the parent unit MUST have a section_id (v3 narrative_units
  -- are inserted with section_id from mig 11). A v3 chunk parented to a
  -- v1/v2 unit (where section_id IS NULL) is a worker bug — refuse.
  IF v_parent_section_id IS NULL THEN
    RAISE EXCEPTION USING errcode = '23514',
      message = 'parent_unit_missing_section_id — v3 chunk cannot parent to a v1/v2 narrative_unit';
  END IF;

  -- Derive + cross-sample-check the section. Lookup section BEFORE the
  -- match check so a totally-bogus p_section_id surfaces as 42704
  -- section_not_found (caller-visible diagnostic), not 23514 mismatch.
  -- The match check below is the v3 cross-section closure (audit C2).
  SELECT sample_id, section_index INTO v_section_sample, v_section_index
    FROM public.sample_content_sections
   WHERE id = p_section_id;
  IF v_section_sample IS NULL THEN
    RAISE EXCEPTION USING errcode = '42704', message = 'section_not_found';
  END IF;

  -- v3 cross-section closure (round-5 audit C2). The passed section_id MUST
  -- equal the parent_unit's own section_id. A mismatch means the caller
  -- attempted to spread a parent across two sections — refuse before the
  -- denormalized chunks.section_id can mislead the read path.
  IF p_section_id <> v_parent_section_id THEN
    RAISE EXCEPTION USING errcode = '23514',
      message = 'section_parent_mismatch — chunk section_id <> parent_unit.section_id';
  END IF;

  -- Belt + braces: section.sample_id matches parent.sample_id. If the
  -- section_parent_mismatch above passed, this is structurally redundant
  -- (matching section_id ⇒ matching sample_id), but keep it as defense in
  -- depth against ANY future refactor that loosens the section_id check.
  IF v_section_sample <> v_parent_sample THEN
    RAISE EXCEPTION USING errcode = '23514',
      message = 'section_sample_mismatch — chunk parent_unit.sample_id <> section.sample_id';
  END IF;

  -- Slug-verify (same gap as v2; sample_content trigger doesn't fire here).
  SELECT array_agg(t) INTO v_bad
    FROM unnest(p_topic_tags) t
    WHERE NOT EXISTS (
      SELECT 1 FROM public.creator_topics
       WHERE creator_id = v_creator_id AND slug = t
    );
  IF v_bad IS NOT NULL AND cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION 'sample_content_chunks.topic_tags contains unregistered slugs: %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version, section_id, section_index)
  VALUES
    (v_parent_sample, v_creator_id, p_chunk_index, p_text, p_chunk_context,
     p_token_count, p_topic_tags, p_embedding, p_embedding_model, now(),
     p_parent_unit_id, 3, p_section_id, v_section_index)
  RETURNING id INTO v_chunk_id;

  RETURN v_chunk_id;
END;$$;

COMMENT ON FUNCTION public._insert_chunk_v3_unsafe(uuid, uuid, int, text, text, int, text[], halfvec(768), text) IS
  'Single-write insert for v3 chunks. Derives sample_id + creator_id from parent_unit_id (audit-2 C1). Audit round-5 C2: ALSO checks p_section_id matches parent_unit.section_id (refuses cross-section parent spreading — was the silent dup-emission bug at read time). Belt-and-braces section.sample_id = parent_unit.sample_id check kept. section_index denormalized from sample_content_sections for the partial UNIQUE on chunks (R2-C4). Service-role only.';
