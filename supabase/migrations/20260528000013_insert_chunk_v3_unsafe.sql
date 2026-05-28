-- 20260528000013 — _insert_chunk_v3_unsafe (RAG v3 Step 3 / plan §4 item 4).
--
-- Single-write insert for v3 chunks. Mirrors _insert_chunk_v2_unsafe (from
-- 20260514000003) with one additional root-id parameter — p_section_id —
-- so the worker emits ONE rpc call per chunk and the GENERATED text_search
-- tsvector computes once (audit-2 M4 amplification fix carries forward).
--
-- ── Parameter-trust closure (audit-2 C1, extended for v3) ───────────────
-- Caller does NOT supply sample_id or creator_id. The RPC server-derives
-- them from the parent unit row. AND — new for v3 — server-verifies that
-- the section row belongs to the SAME sample (defense in depth: a buggy
-- or malicious caller cannot cross-link a child chunk into a section
-- under a different sample, even if both IDs happen to be valid). The
-- partial UNIQUE on the chunks table (from 20260528000012) handles
-- intra-section dedup; this cross-sample check stops mismatched-tree
-- corruption before it reaches the index.
--
-- section_index is denormalized from sample_content_sections (NOT NULL
-- there) so the partial UNIQUE on chunks can dedup without a JOIN. The
-- RPC reads sections.section_index alongside the cross-sample check —
-- one extra SELECT, same row, free given we're already locking.

CREATE FUNCTION public._insert_chunk_v3_unsafe(
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
  v_parent_sample  uuid;
  v_creator_id     uuid;
  v_section_sample uuid;
  v_section_index  smallint;
  v_chunk_id       uuid;
  v_bad            text[];
BEGIN
  -- Derive canonical IDs from the parent unit row. Audit-2 C1.
  SELECT sample_id, creator_id INTO v_parent_sample, v_creator_id
    FROM public.sample_content_narrative_units
   WHERE id = p_parent_unit_id;
  IF v_parent_sample IS NULL THEN
    RAISE EXCEPTION USING errcode = '42704', message = 'parent_unit_not_found';
  END IF;

  -- Derive + cross-sample-check the section. v3 step 3 closure: the chunk's
  -- section MUST belong to the same sample as the parent unit. If not, the
  -- caller passed a section_id from a different sample (or different
  -- creator entirely) — refuse before inserting.
  SELECT sample_id, section_index INTO v_section_sample, v_section_index
    FROM public.sample_content_sections
   WHERE id = p_section_id;
  IF v_section_sample IS NULL THEN
    RAISE EXCEPTION USING errcode = '42704', message = 'section_not_found';
  END IF;
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
  'Single-write insert for v3 chunks. Derives sample_id + creator_id from parent_unit_id (audit-2 C1) AND server-verifies the section row belongs to the same sample (v3 step 3 cross-sample closure). section_index denormalized from sample_content_sections for the partial UNIQUE on chunks (R2-C4). Service-role only.';

REVOKE ALL ON FUNCTION public._insert_chunk_v3_unsafe(uuid, uuid, int, text, text, int, text[], halfvec(768), text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._insert_chunk_v3_unsafe(uuid, uuid, int, text, text, int, text[], halfvec(768), text)
  TO service_role;
