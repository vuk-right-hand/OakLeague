-- RAG SOTA Phase 2 — Day 8 MIG-3 pgTAP
-- semantic_query_cache + lookup/upsert RPCs
--
-- Setup as postgres (BYPASSRLS). RPCs are service-role-only without
-- _assert_caller_is_admin; we call them directly.
--
-- Coverage:
--   Table / constraints:
--     1.  16 partitions created (sentinel — confirms partition DDL succeeded)
--     2.  payload_json CHECK rejects missing keys
--     3.  payload_json CHECK rejects array-length mismatch
--     4.  payload_json CHECK rejects oversized arrays (>50)
--     5.  expires_at > created_at CHECK
--     6.  corpus_version >= 1 CHECK
--     7.  RLS deny-all from anon (no policies + RLS enabled)
--
--   Lookup RPC:
--     8.  Empty cache → zero rows
--     9.  Hit returns parent_unit_ids + scores + non-negative age_seconds
--    10.  Miss on similarity below threshold
--    11.  Miss on expired row
--    12.  Miss on stale corpus_version (different version filter)
--
--   Upsert RPC:
--    13.  Fresh insert returns new uuid
--    14.  Conflict on (creator_id, corpus_version, query_text_hash) → UPDATEs,
--         returns SAME uuid, bumps hit_count
--    15.  Rejects (NULL) on stale corpus_version (creator's current_corpus_version
--         differs from p_corpus_version)
--    16.  Rejects (NULL) on array-length mismatch
--    17.  Rejects (NULL) on empty arrays
--    18.  Rejects (NULL) on oversized arrays (>50)
--    19.  Rejects (NULL) on short query_text_hash
--
--   Purge:
--    20.  Purge deletes expired, leaves live rows.

BEGIN;
SELECT plan(22);

CREATE FUNCTION pg_temp.unit_vec(p_position int) RETURNS halfvec(768)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_arr real[];
BEGIN
  v_arr := array_fill(0::real, ARRAY[768]);
  v_arr[p_position] := 1.0;
  RETURN v_arr::halfvec(768);
END;
$$;

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user        uuid;
  v_app         uuid;
  v_creator     uuid;
  v_parent_id1  uuid := gen_random_uuid();
  v_parent_id2  uuid := gen_random_uuid();
  v_hash1       bytea := decode(md5('hello world')::text, 'hex');
  v_hash2       bytea := decode(md5('hola mundo')::text, 'hex');
  v_short_hash  bytea := decode(md5('x')::text || md5('x')::text, 'hex');  -- 32 bytes valid
  v_too_short   bytea := decode('aa', 'hex');                              -- 1 byte (invalid)
  v_inserted_id uuid;
  v_inserted2   uuid;
  v_partition_n int;
  v_row_count   int;
  v_rls_enabled bool;
  v_n_policies  int;
  v_pids        uuid[];
  v_scores_out  float[];
  v_age         int;
  v_row_id      uuid;
  v_purged      int;
BEGIN
  -- Setup
  v_user := tests.create_auth_user('sqc-user@test');
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'SQC', 'sqc1', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'SQC', 'sqc1', 'ready')
    RETURNING id INTO v_creator;
  -- creators.current_corpus_version defaults to 1.

  -- ── 1: 16 partitions created ──────────────────────────────────────────
  SELECT count(*) INTO v_partition_n
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
   WHERE i.inhparent = 'public.semantic_query_cache'::regclass;
  RETURN NEXT ok(
    v_partition_n = 16,
    format('1: 16 hash partitions created (got %s)', v_partition_n)
  );

  -- ── 2: CHECK rejects payload missing parent_unit_ids ──────────────────
  BEGIN
    INSERT INTO public.semantic_query_cache
      (creator_id, corpus_version, query_embedding, query_text_hash, payload_json, expires_at)
    VALUES
      (v_creator, 1, pg_temp.unit_vec(1), v_hash1,
       '{"scores": [0.9]}'::jsonb,
       now() + interval '1 hour');
    RETURN NEXT fail('2: missing parent_unit_ids should have raised CHECK violation');
  EXCEPTION
    WHEN check_violation THEN
      RETURN NEXT pass('2: CHECK rejects missing parent_unit_ids');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('2: unexpected sqlstate %s', SQLSTATE));
  END;

  -- ── 3: CHECK rejects array-length mismatch ────────────────────────────
  BEGIN
    INSERT INTO public.semantic_query_cache
      (creator_id, corpus_version, query_embedding, query_text_hash, payload_json, expires_at)
    VALUES
      (v_creator, 1, pg_temp.unit_vec(1), v_hash1,
       jsonb_build_object('parent_unit_ids', jsonb_build_array(v_parent_id1, v_parent_id2),
                          'scores',          jsonb_build_array(0.9)),
       now() + interval '1 hour');
    RETURN NEXT fail('3: array-length mismatch should have raised CHECK');
  EXCEPTION
    WHEN check_violation THEN
      RETURN NEXT pass('3: CHECK rejects array-length mismatch');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('3: unexpected sqlstate %s', SQLSTATE));
  END;

  -- ── 4: CHECK rejects oversized arrays (>50) ───────────────────────────
  BEGIN
    INSERT INTO public.semantic_query_cache
      (creator_id, corpus_version, query_embedding, query_text_hash, payload_json, expires_at)
    VALUES
      (v_creator, 1, pg_temp.unit_vec(1), v_hash1,
       jsonb_build_object(
         'parent_unit_ids', (SELECT jsonb_agg(gen_random_uuid()) FROM generate_series(1,51)),
         'scores',          (SELECT jsonb_agg(0.5::float)        FROM generate_series(1,51))
       ),
       now() + interval '1 hour');
    RETURN NEXT fail('4: 51-item array should have raised CHECK');
  EXCEPTION
    WHEN check_violation THEN
      RETURN NEXT pass('4: CHECK rejects oversized arrays (>50)');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('4: unexpected sqlstate %s', SQLSTATE));
  END;

  -- ── 5: expires_at > created_at CHECK ──────────────────────────────────
  BEGIN
    INSERT INTO public.semantic_query_cache
      (creator_id, corpus_version, query_embedding, query_text_hash, payload_json,
       created_at, expires_at)
    VALUES
      (v_creator, 1, pg_temp.unit_vec(1), v_hash1,
       jsonb_build_object('parent_unit_ids', jsonb_build_array(v_parent_id1),
                          'scores',          jsonb_build_array(0.9)),
       now(), now() - interval '1 hour');
    RETURN NEXT fail('5: expires_at < created_at should have raised CHECK');
  EXCEPTION
    WHEN check_violation THEN
      RETURN NEXT pass('5: CHECK rejects expires_at <= created_at');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('5: unexpected sqlstate %s', SQLSTATE));
  END;

  -- ── 6: corpus_version >= 1 CHECK ──────────────────────────────────────
  BEGIN
    INSERT INTO public.semantic_query_cache
      (creator_id, corpus_version, query_embedding, query_text_hash, payload_json, expires_at)
    VALUES
      (v_creator, 0, pg_temp.unit_vec(1), v_hash1,
       jsonb_build_object('parent_unit_ids', jsonb_build_array(v_parent_id1),
                          'scores',          jsonb_build_array(0.9)),
       now() + interval '1 hour');
    RETURN NEXT fail('6: corpus_version=0 should have raised CHECK');
  EXCEPTION
    WHEN check_violation THEN
      RETURN NEXT pass('6: CHECK rejects corpus_version < 1');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('6: unexpected sqlstate %s', SQLSTATE));
  END;

  -- ── 7: RLS deny-all (RLS enabled + zero policies) ─────────────────────
  SELECT relrowsecurity INTO v_rls_enabled
    FROM pg_class WHERE oid = 'public.semantic_query_cache'::regclass;
  SELECT count(*) INTO v_n_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'semantic_query_cache';
  RETURN NEXT ok(
    v_rls_enabled AND v_n_policies = 0,
    format('7: RLS enabled (%s) + zero policies (%s) = deny-all', v_rls_enabled, v_n_policies)
  );

  -- ── 7b (Day-9-cross M5): real-deny test — authenticated SELECT denied ──
  -- Seed one row as postgres (BYPASSRLS) so the SELECT, were it permitted,
  -- would return a row. REVOKE ALL on authenticated means even SELECT
  -- raises insufficient_privilege at the GRANT layer before RLS evaluates.
  INSERT INTO public.semantic_query_cache
    (creator_id, corpus_version, query_embedding, query_text_hash, payload_json, expires_at)
  VALUES
    (v_creator, 1, pg_temp.unit_vec(1), v_short_hash,
     jsonb_build_object('parent_unit_ids', jsonb_build_array(v_parent_id1),
                        'scores', jsonb_build_array(0.9)),
     now() + interval '1 hour');
  PERFORM tests.set_authenticated(v_user);
  BEGIN
    SELECT count(*) INTO v_row_count FROM public.semantic_query_cache;
    PERFORM tests.reset_role();
    -- If we got here, either (a) GRANT slipped in or (b) RLS filter passed
    -- it. Assert zero rows visible regardless.
    RETURN NEXT ok(
      v_row_count = 0,
      format('7b: authenticated SELECT visible rows=%s (want 0 — RLS or GRANT denies)', v_row_count)
    );
  EXCEPTION
    WHEN insufficient_privilege THEN
      PERFORM tests.reset_role();
      RETURN NEXT pass('7b: authenticated SELECT raised insufficient_privilege (REVOKE ALL holds)');
    WHEN OTHERS THEN
      PERFORM tests.reset_role();
      RETURN NEXT fail(format('7b: authenticated SELECT unexpected sqlstate %s', SQLSTATE));
  END;
  -- Clean up seed for downstream tests.
  DELETE FROM public.semantic_query_cache WHERE creator_id = v_creator;

  -- ── 7c: authenticated INSERT also denied ──────────────────────────────
  PERFORM tests.set_authenticated(v_user);
  BEGIN
    INSERT INTO public.semantic_query_cache
      (creator_id, corpus_version, query_embedding, query_text_hash, payload_json, expires_at)
    VALUES
      (v_creator, 1, pg_temp.unit_vec(1), v_short_hash,
       jsonb_build_object('parent_unit_ids', jsonb_build_array(v_parent_id1),
                          'scores', jsonb_build_array(0.9)),
       now() + interval '1 hour');
    -- INSERT under RLS deny-all returns 0 rows-inserted without raising.
    -- Verify the row didn't land.
    PERFORM tests.reset_role();
    SELECT count(*) INTO v_row_count FROM public.semantic_query_cache WHERE creator_id = v_creator;
    RETURN NEXT ok(
      v_row_count = 0,
      format('7c: authenticated INSERT blocked (row count=%s, want 0)', v_row_count)
    );
  EXCEPTION
    WHEN insufficient_privilege THEN
      PERFORM tests.reset_role();
      RETURN NEXT pass('7c: authenticated INSERT denied with insufficient_privilege');
    WHEN OTHERS THEN
      PERFORM tests.reset_role();
      RETURN NEXT pass(format('7c: authenticated INSERT denied with sqlstate %s', SQLSTATE));
  END;

  -- ═════════════════════════════════════════════════════════════════════
  -- Lookup RPC
  -- ═════════════════════════════════════════════════════════════════════

  -- ── 8: empty cache → zero rows ────────────────────────────────────────
  SELECT count(*) INTO v_row_count
    FROM public.semantic_query_cache_lookup(v_creator, 1, pg_temp.unit_vec(1), 0.92);
  RETURN NEXT ok(
    v_row_count = 0,
    format('8: empty cache lookup → 0 rows (got %s)', v_row_count)
  );

  -- Seed one row via upsert (test path for upsert hit too).
  v_inserted_id := public.semantic_query_cache_upsert(
    v_creator, 1, pg_temp.unit_vec(10), v_hash1,
    ARRAY[v_parent_id1, v_parent_id2], ARRAY[0.9, 0.7]::float[], 3600
  );

  -- ── 9: Hit returns payload + non-negative age ─────────────────────────
  SELECT parent_unit_ids, scores, age_seconds
    INTO v_pids, v_scores_out, v_age
    FROM public.semantic_query_cache_lookup(v_creator, 1, pg_temp.unit_vec(10), 0.92);
  RETURN NEXT ok(
    v_pids = ARRAY[v_parent_id1, v_parent_id2]
      AND v_scores_out[1] >= 0.89 AND v_scores_out[1] <= 0.91
      AND v_age >= 0,
    format('9: hit returns pids=%s scores=%s age=%s',
           coalesce(v_pids::text, 'null'),
           coalesce(v_scores_out::text, 'null'),
           v_age)
  );

  -- ── 10: similarity below threshold → miss ─────────────────────────────
  -- Query at orthogonal position → cosine 0 → below 0.92.
  SELECT count(*) INTO v_row_count
    FROM public.semantic_query_cache_lookup(v_creator, 1, pg_temp.unit_vec(700), 0.92);
  RETURN NEXT ok(
    v_row_count = 0,
    format('10: orthogonal query (sim=0) → miss (got %s rows)', v_row_count)
  );

  -- ── 11: expired row → miss ────────────────────────────────────────────
  -- Backdate BOTH created_at and expires_at so the CHECK (expires_at >
  -- created_at) still holds but the row is in the past.
  UPDATE public.semantic_query_cache
     SET created_at = now() - interval '2 hours',
         expires_at = now() - interval '1 minute'
   WHERE creator_id = v_creator;
  SELECT count(*) INTO v_row_count
    FROM public.semantic_query_cache_lookup(v_creator, 1, pg_temp.unit_vec(10), 0.92);
  RETURN NEXT ok(
    v_row_count = 0,
    format('11: expired row → miss (got %s rows)', v_row_count)
  );
  -- Restore for downstream tests.
  UPDATE public.semantic_query_cache
     SET created_at = now(),
         expires_at = now() + interval '1 hour'
   WHERE creator_id = v_creator;

  -- ── 12: corpus_version mismatch → miss ────────────────────────────────
  SELECT count(*) INTO v_row_count
    FROM public.semantic_query_cache_lookup(v_creator, 999, pg_temp.unit_vec(10), 0.92);
  RETURN NEXT ok(
    v_row_count = 0,
    format('12: corpus_version=999 (have 1) → miss (got %s)', v_row_count)
  );

  -- ═════════════════════════════════════════════════════════════════════
  -- Upsert RPC
  -- ═════════════════════════════════════════════════════════════════════

  -- ── 13: fresh insert returns uuid ─────────────────────────────────────
  v_inserted_id := public.semantic_query_cache_upsert(
    v_creator, 1, pg_temp.unit_vec(11), v_hash2,
    ARRAY[v_parent_id1], ARRAY[0.85]::float[], 3600
  );
  RETURN NEXT ok(
    v_inserted_id IS NOT NULL,
    format('13: fresh upsert returns uuid (got %s)', COALESCE(v_inserted_id::text, 'NULL'))
  );

  -- ── 14: conflict on (creator, corpus_version, hash) → same id, hit++ ──
  -- Lookup current hit_count first.
  SELECT id INTO v_row_id
    FROM public.semantic_query_cache
   WHERE creator_id = v_creator AND query_text_hash = v_hash2 LIMIT 1;

  v_inserted2 := public.semantic_query_cache_upsert(
    v_creator, 1, pg_temp.unit_vec(12), v_hash2,
    ARRAY[v_parent_id2], ARRAY[0.95]::float[], 3600
  );
  SELECT hit_count INTO v_row_count
    FROM public.semantic_query_cache
   WHERE id = v_row_id;
  RETURN NEXT ok(
    v_inserted2 = v_row_id AND v_row_count = 1,
    format('14: conflict → same id (%s=%s?) + hit_count=1 (got %s)',
           v_inserted2, v_row_id, v_row_count)
  );

  -- ── 15: stale corpus_version → NULL ───────────────────────────────────
  v_inserted_id := public.semantic_query_cache_upsert(
    v_creator, 999, pg_temp.unit_vec(13),
    decode(md5('stale')::text, 'hex'),
    ARRAY[v_parent_id1], ARRAY[0.5]::float[], 3600
  );
  RETURN NEXT ok(
    v_inserted_id IS NULL,
    format('15: stale corpus_version → NULL (got %s)',
           COALESCE(v_inserted_id::text, 'NULL'))
  );

  -- ── 16: array-length mismatch → NULL ──────────────────────────────────
  v_inserted_id := public.semantic_query_cache_upsert(
    v_creator, 1, pg_temp.unit_vec(14),
    decode(md5('mismatch')::text, 'hex'),
    ARRAY[v_parent_id1, v_parent_id2], ARRAY[0.5]::float[], 3600
  );
  RETURN NEXT ok(
    v_inserted_id IS NULL,
    format('16: array-length mismatch → NULL (got %s)',
           COALESCE(v_inserted_id::text, 'NULL'))
  );

  -- ── 17: empty arrays → NULL ───────────────────────────────────────────
  v_inserted_id := public.semantic_query_cache_upsert(
    v_creator, 1, pg_temp.unit_vec(15),
    decode(md5('empty')::text, 'hex'),
    ARRAY[]::uuid[], ARRAY[]::float[], 3600
  );
  RETURN NEXT ok(
    v_inserted_id IS NULL,
    format('17: empty arrays → NULL (got %s)', COALESCE(v_inserted_id::text, 'NULL'))
  );

  -- ── 18: oversized arrays (>50) → NULL ─────────────────────────────────
  v_inserted_id := public.semantic_query_cache_upsert(
    v_creator, 1, pg_temp.unit_vec(16),
    decode(md5('big')::text, 'hex'),
    (SELECT array_agg(gen_random_uuid()) FROM generate_series(1,51)),
    (SELECT array_agg(0.5::float)        FROM generate_series(1,51)),
    3600
  );
  RETURN NEXT ok(
    v_inserted_id IS NULL,
    format('18: oversized arrays → NULL (got %s)', COALESCE(v_inserted_id::text, 'NULL'))
  );

  -- ── 19: query_text_hash too short → NULL ──────────────────────────────
  v_inserted_id := public.semantic_query_cache_upsert(
    v_creator, 1, pg_temp.unit_vec(17),
    v_too_short,
    ARRAY[v_parent_id1], ARRAY[0.5]::float[], 3600
  );
  RETURN NEXT ok(
    v_inserted_id IS NULL,
    format('19: short query_text_hash → NULL (got %s)',
           COALESCE(v_inserted_id::text, 'NULL'))
  );

  -- ═════════════════════════════════════════════════════════════════════
  -- Purge
  -- ═════════════════════════════════════════════════════════════════════

  -- ── 20: purge deletes expired, leaves live ────────────────────────────
  -- Backdate one row's created_at + expires_at so it's expired but the
  -- CHECK (expires_at > created_at) still holds.
  UPDATE public.semantic_query_cache
     SET created_at = now() - interval '2 hours',
         expires_at = now() - interval '1 minute'
   WHERE creator_id = v_creator AND query_text_hash = v_hash1;
  v_purged := public.semantic_query_cache_purge_expired();
  SELECT count(*) INTO v_row_count
    FROM public.semantic_query_cache
   WHERE creator_id = v_creator;
  RETURN NEXT ok(
    v_purged >= 1 AND v_row_count = 1,
    format('20: purge deleted=%s, remaining=%s (expect ≥1 deleted, 1 remaining)',
           v_purged, v_row_count)
  );

END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
