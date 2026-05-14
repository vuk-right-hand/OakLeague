-- ─────────────────────────────────────────────────────────────────────────
-- RAG SOTA Phase 2 — Day 8/9/10/11 cross-cutting audit M5
-- semantic_query_cache_upsert: first-write-wins on payload race
-- ─────────────────────────────────────────────────────────────────────────
--
-- Day-8 MIG-3 shipped `ON CONFLICT DO UPDATE SET payload_json = EXCLUDED…`
-- which is last-write-wins. Concurrent sessions for the same creator/query
-- compute slightly different rerank outputs (Voyage's relevance_score is
-- stable but not bit-exact across runs), race, and the LAST writer's
-- parent_unit_ids[] persists for 7 days.
--
-- The deeper concern: with last-wins, a cache row's contents can flicker
-- between user-visible sessions. Two users 5 seconds apart asking the same
-- question against the cached row see different parent narratives because
-- a third session raced in between. The UNIQUE constraint correctly
-- serializes the inserts, but the SEMANTIC ordering ("which ranking is
-- canonical?") is undefined.
--
-- This migration switches to FIRST-WRITE-WINS for payload + embedding +
-- expires_at: the original INSERT defines the canonical ranking; subsequent
-- racing writers only bump telemetry (hit_count + last_hit_at). Trade-off
-- analysis:
--
--   - PRO: deterministic cache contents. A user's repeated paraphrases get
--     the same parent narratives. Future-correct as we scale beyond one
--     creator.
--   - PRO: matches the FOR SHARE corpus_version invariant — if first writer's
--     corpus_version was valid, freezing their result is correct.
--   - CON: if Voyage briefly returned suboptimal rankings (transient model
--     blip), the cache holds that for up to 7 days. Mitigation: TTL expiry
--     replaces the row; corpus_version bump invalidates immediately.
--   - CON: no "rerank with new method" upgrade path inside a TTL window.
--     Acceptable — corpus_version bump is the upgrade signal.
--
-- The CHANGE: DO NOTHING for payload/embedding/expires_at; keep hit_count
-- + last_hit_at bumps so race telemetry remains accurate. created_at NOT
-- refreshed — it now genuinely reflects when the canonical ranking was
-- written, which is what age_seconds was supposed to be measuring.

CREATE OR REPLACE FUNCTION public.semantic_query_cache_upsert(
  p_creator_id        uuid,
  p_corpus_version    int,
  p_query_vec         halfvec(768),
  p_query_text_hash   bytea,
  p_parent_unit_ids   uuid[],
  p_scores            float[],
  p_ttl_seconds       int DEFAULT 604800
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id                uuid;
  v_payload           jsonb;
  v_ttl               int;
  v_current_version   int;
BEGIN
  -- Input validation (unchanged from MIG-3).
  IF p_creator_id IS NULL OR p_corpus_version IS NULL OR p_corpus_version < 1
     OR p_query_vec IS NULL OR p_query_text_hash IS NULL
     OR p_parent_unit_ids IS NULL OR p_scores IS NULL THEN
    RETURN NULL;
  END IF;

  IF octet_length(p_query_text_hash) <> 32 THEN
    RETURN NULL;
  END IF;

  IF array_length(p_parent_unit_ids, 1) IS NULL
     OR array_length(p_parent_unit_ids, 1) <> array_length(p_scores, 1) THEN
    RETURN NULL;
  END IF;

  IF array_length(p_parent_unit_ids, 1) > 50 THEN
    RETURN NULL;
  END IF;

  -- FOR SHARE guard against stale corpus version (unchanged).
  SELECT current_corpus_version INTO v_current_version
    FROM public.creators
    WHERE id = p_creator_id
    FOR SHARE;

  IF v_current_version IS NULL OR v_current_version <> p_corpus_version THEN
    RETURN NULL;
  END IF;

  -- TTL clamping (unchanged).
  v_ttl := GREATEST(60, LEAST(p_ttl_seconds, 2592000));

  -- Build payload jsonb.
  v_payload := jsonb_build_object(
    'parent_unit_ids', to_jsonb(p_parent_unit_ids),
    'scores',          to_jsonb(p_scores)
  );

  -- First-write-wins on payload/embedding/expires_at (Day-11-cross M5).
  -- Racing writers update ONLY hit_count + last_hit_at. created_at stays
  -- on the original write — the canonical write moment.
  INSERT INTO public.semantic_query_cache
    (creator_id, corpus_version, query_embedding, query_text_hash, payload_json,
     hit_count, last_hit_at, expires_at)
  VALUES
    (p_creator_id, p_corpus_version, p_query_vec, p_query_text_hash, v_payload,
     0, now(), now() + make_interval(secs => v_ttl))
  ON CONFLICT (creator_id, corpus_version, query_text_hash) DO UPDATE
     SET last_hit_at     = now(),
         hit_count       = semantic_query_cache.hit_count + 1
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Permissions unchanged.
GRANT EXECUTE ON FUNCTION public.semantic_query_cache_upsert(uuid, int, halfvec, bytea, uuid[], float[], int)
  TO service_role;

COMMENT ON FUNCTION public.semantic_query_cache_upsert(uuid, int, halfvec, bytea, uuid[], float[], int) IS
  'Atomic semantic cache upsert with FIRST-WRITE-WINS on payload. Day-11-cross M5: payload/embedding/expires_at frozen on first INSERT; racing writers only bump hit_count + last_hit_at. Rejects (returns NULL) on: NULL inputs, array-length mismatch, oversized payload (>50), short/long query_text_hash, stale corpus_version (FOR SHARE on creators row). TTL clamped to [60s, 30d]. Service-role only. Cache invalidation: corpus_version bump (immediate) OR TTL expiry (7d default).';
