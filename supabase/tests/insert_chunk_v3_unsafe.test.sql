-- RAG v3 step 3 / migration 4 — _insert_chunk_v3_unsafe RPC.
--
-- 1. Service-role only (REVOKE/GRANT contract).
-- 2. parent_unit_id not found → 42704.
-- 3. section_id not found → 42704.
-- 4. section.sample_id mismatch with parent_unit.sample_id → 23514 (cross-
--    sample closure — the v3-specific defense beyond the v2 parameter-trust).
-- 5. unregistered topic_tag slug → check_violation.
-- 6. Happy path: derives sample_id + creator_id + section_index server-side;
--    inserts chunk with chunker_version=3; returns uuid.
-- 7. Duplicate (parent_unit + section + chunk_index) → 23505 from the v3
--    partial UNIQUE (integration with migration 3's index).
-- 8. v3 step 5 round-5 C2 — section_id MUST match parent_unit.section_id
--    even when both belong to the same sample → 23514. Defense against
--    spreading a parent across two sections.
-- 9. v3 step 5 round-5 C2 — parent_unit with section_id IS NULL (v1/v2
--    unit) is refused with 23514 'parent_unit_missing_section_id'.

BEGIN;
SELECT plan(9);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user        uuid := tests.create_auth_user('iv3-creator@test');
  v_app         uuid;
  v_creator     uuid;
  v_sampleA     uuid;
  v_sampleB     uuid;
  v_secA        uuid;
  v_secB        uuid;
  v_unitA       uuid;
  v_unitB       uuid;
  v_chunk_id    uuid;
  v_chunk_row   record;
  v_dummy_vec   halfvec(768);
BEGIN
  v_dummy_vec := ('[' || array_to_string(array_fill(0.01::real, ARRAY[768]), ',') || ']')::halfvec(768);

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'IV3', 'iv3', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'IV3', 'iv3', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);

  -- Two distinct samples, each with its own section + unit, so test 4 can
  -- prove section-from-sampleB + unit-from-sampleA is refused.
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'Sample A',
            'body A', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sampleA;
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'Sample B',
            'body B', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sampleB;
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end, topic_tags)
  VALUES
    (v_sampleA, v_creator, 0, 'Sec A', 'Sec A summary', 0, 100, ARRAY['topic-a'])
  RETURNING id INTO v_secA;
  INSERT INTO public.sample_content_sections
    (sample_id, creator_id, section_index, title, summary, char_start, char_end, topic_tags)
  VALUES
    (v_sampleB, v_creator, 0, 'Sec B', 'Sec B summary', 0, 100, ARRAY['topic-a'])
  RETURNING id INTO v_secB;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sampleA, v_creator, 0, 'Unit A', 'unit A body', 50, ARRAY['topic-a'], v_secA)
  RETURNING id INTO v_unitA;
  INSERT INTO public.sample_content_narrative_units
    (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
  VALUES (v_sampleB, v_creator, 0, 'Unit B', 'unit B body', 50, ARRAY['topic-a'], v_secB)
  RETURNING id INTO v_unitB;

  -- 1: service-role only. `public` is a pseudo-role and cannot cast to
  -- regrole — has_function_privilege accepts it only as a text string.
  RETURN NEXT ok(
    NOT has_function_privilege('public',
        'public._insert_chunk_v3_unsafe(uuid, uuid, int, text, text, int, text[], halfvec(768), text)', 'EXECUTE')
    AND NOT has_function_privilege('anon'::regrole,
        'public._insert_chunk_v3_unsafe(uuid, uuid, int, text, text, int, text[], halfvec(768), text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated'::regrole,
        'public._insert_chunk_v3_unsafe(uuid, uuid, int, text, text, int, text[], halfvec(768), text)', 'EXECUTE')
    AND has_function_privilege('service_role'::regrole,
        'public._insert_chunk_v3_unsafe(uuid, uuid, int, text, text, int, text[], halfvec(768), text)', 'EXECUTE'),
    '1: _insert_chunk_v3_unsafe is service-role-only'
  );

  -- 2: parent_unit_not_found.
  BEGIN
    PERFORM public._insert_chunk_v3_unsafe(
      gen_random_uuid(), v_secA, 0, 't', NULL, 10, ARRAY['topic-a'], v_dummy_vec);
    RETURN NEXT fail('2: missing parent should raise 42704');
  EXCEPTION WHEN undefined_object THEN
    RETURN NEXT pass('2: parent_unit_not_found → 42704');
  END;

  -- 3: section_not_found.
  BEGIN
    PERFORM public._insert_chunk_v3_unsafe(
      v_unitA, gen_random_uuid(), 0, 't', NULL, 10, ARRAY['topic-a'], v_dummy_vec);
    RETURN NEXT fail('3: missing section should raise 42704');
  EXCEPTION WHEN undefined_object THEN
    RETURN NEXT pass('3: section_not_found → 42704');
  END;

  -- 4: cross-sample closure — section from sampleB + unit from sampleA.
  -- Post-mig-14: the section_parent_mismatch check fires first (v_secB !=
  -- v_unitA.section_id which is v_secA) — same SQLSTATE 23514, slightly
  -- different message. Both protect against the same class of corruption.
  BEGIN
    PERFORM public._insert_chunk_v3_unsafe(
      v_unitA, v_secB, 0, 't', NULL, 10, ARRAY['topic-a'], v_dummy_vec);
    RETURN NEXT fail('4: cross-sample (unit in A + section in B) should raise 23514');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('4: section mismatch (sample-and-section) → 23514 (v3 closures)');
  END;

  -- 5: unregistered topic_tag slug.
  BEGIN
    PERFORM public._insert_chunk_v3_unsafe(
      v_unitA, v_secA, 0, 't', NULL, 10, ARRAY['unregistered-slug'], v_dummy_vec);
    RETURN NEXT fail('5: unregistered slug should raise check_violation');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('5: unregistered topic_tag slug → check_violation');
  END;

  -- 6: happy path. Caller never passes sample_id/creator_id/section_index;
  --    all derived server-side. Returns uuid; row reads back with v3 + the
  --    correct denormalized section_index.
  SELECT public._insert_chunk_v3_unsafe(
    v_unitA, v_secA, 0, 'real body', 'context header', 25, ARRAY['topic-a'], v_dummy_vec
  ) INTO v_chunk_id;
  SELECT sample_id, creator_id, chunker_version, section_id, section_index
    INTO v_chunk_row
    FROM public.sample_content_chunks WHERE id = v_chunk_id;
  RETURN NEXT is(
    v_chunk_row.sample_id::text || '|' || v_chunk_row.creator_id::text || '|' ||
      v_chunk_row.chunker_version || '|' || v_chunk_row.section_id::text || '|' ||
      v_chunk_row.section_index,
    v_sampleA::text || '|' || v_creator::text || '|3|' || v_secA::text || '|0',
    '6: happy path — server-derives sample/creator/section_index; chunker_version=3'
  );

  -- 7: dup (parent + section + chunk_index) raises 23505 from the v3 partial UNIQUE.
  BEGIN
    PERFORM public._insert_chunk_v3_unsafe(
      v_unitA, v_secA, 0, 'dup', NULL, 10, ARRAY['topic-a'], v_dummy_vec);
    RETURN NEXT fail('7: dup (parent, section, chunk_index=0) should raise unique_violation');
  EXCEPTION WHEN unique_violation THEN
    RETURN NEXT pass('7: v3 partial UNIQUE integrates with insert RPC (R2-C4 part 2)');
  END;

  -- 8: round-5 C2 — same-sample but different-section is refused.
  -- Setup: create a SECOND section in sampleA so the cross-sample check passes
  -- (sampleA = sampleA) but the new section_parent_mismatch check trips.
  DECLARE
    v_secA2 uuid;
  BEGIN
    INSERT INTO public.sample_content_sections
      (sample_id, creator_id, section_index, title, summary, char_start, char_end, topic_tags)
    VALUES
      (v_sampleA, v_creator, 1, 'Sec A2', 'Sec A2 summary', 100, 200, ARRAY['topic-a'])
    RETURNING id INTO v_secA2;
    BEGIN
      PERFORM public._insert_chunk_v3_unsafe(
        v_unitA, v_secA2, 0, 't', NULL, 10, ARRAY['topic-a'], v_dummy_vec);
      RETURN NEXT fail('8: parent in secA + caller passes secA2 should raise 23514');
    EXCEPTION WHEN check_violation THEN
      RETURN NEXT pass('8: section_parent_mismatch — same sample, wrong section → 23514');
    END;
  END;

  -- 9: round-5 C2 — parent_unit with section_id IS NULL is refused.
  -- Setup: insert a v1/v2-shaped parent (section_id NULL allowed for legacy).
  DECLARE
    v_legacy_unit uuid;
  BEGIN
    INSERT INTO public.sample_content_narrative_units
      (sample_id, creator_id, unit_index, title, text, token_count, topic_tags, section_id)
    VALUES (v_sampleA, v_creator, 99, 'Legacy', 'legacy body', 50, ARRAY['topic-a'], NULL)
    RETURNING id INTO v_legacy_unit;
    BEGIN
      PERFORM public._insert_chunk_v3_unsafe(
        v_legacy_unit, v_secA, 5, 't', NULL, 10, ARRAY['topic-a'], v_dummy_vec);
      RETURN NEXT fail('9: parent with section_id IS NULL should raise 23514');
    EXCEPTION WHEN check_violation THEN
      RETURN NEXT pass('9: parent_unit_missing_section_id (v1/v2 unit) → 23514');
    END;
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
