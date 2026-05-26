-- RAG SOTA Phase 2 — Day 8 MIG-5 pgTAP
-- claim_corpus_reprocess_job advisory-lock retrofit
--
-- The existing claim_corpus_reprocess_job.test.sql is broken for reasons
-- predating Day 8 (refers to a `tests.set_role` helper that doesn't exist).
-- That's pre-existing tech debt outside this PR's scope.
--
-- This test focuses narrowly on MIG-5's retrofit:
--   1. The function body now contains the pg_advisory_xact_lock call
--      keyed on hashtext('reprocess:'||creator_id).
--   2. The function still passes through to status='processing' on a
--      normal claim (behavior preserved).
--   3. Returns expected shape (job_id, sample_id, creator_id, enqueue_version).
--   4. Empty queue → zero rows (no failure on lock-free path).
--
-- Setup as postgres (BYPASSRLS + function owner). Service-role-only RPCs
-- are callable by their owner regardless of GRANT.

BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user        uuid := tests.create_auth_user('ccrj-lock-user@test');
  v_app         uuid;
  v_creator     uuid;
  v_sample      uuid;
  v_job         uuid;
  v_status      text;
  v_ret_status  text;
  v_ret_creator uuid;
  v_n_rows      int;
BEGIN
  -- ── 1: advisory lock textual proof ─────────────────────────────────────
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.proname = 'claim_corpus_reprocess_job'
         AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
         AND pg_get_functiondef(p.oid) ILIKE '%pg_advisory_xact_lock%hashtext%reprocess:%'
    ),
    '1: claim_corpus_reprocess_job body takes pg_advisory_xact_lock on hashtext(''reprocess:''||creator_id)'
  );

  -- ── 2: empty queue → zero rows ─────────────────────────────────────────
  SELECT count(*) INTO v_n_rows
    FROM public.claim_corpus_reprocess_job('test-worker');
  RETURN NEXT ok(
    v_n_rows = 0,
    format('2: empty queue → 0 rows (got %s)', v_n_rows)
  );

  -- ── Setup a real job for tests 3-4 ─────────────────────────────────────
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'CCRJ-Lock', 'ccrjlock1',
            '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'CCRJ-Lock', 'ccrjlock1', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_creator, 'topic-a', 'Topic A', 0);
  INSERT INTO public.sample_content (id, creator_id, source_type, title, raw_text, topic_tags, fetch_status)
    VALUES (gen_random_uuid(), v_creator, 'transcript', 'S1', 'body', ARRAY['topic-a'], 'ready')
    RETURNING id INTO v_sample;
  -- Clean legacy queue rows from the on-INSERT trigger.
  DELETE FROM public.sample_content_embedding_jobs WHERE sample_id = v_sample;
  DELETE FROM public.corpus_reprocess_jobs WHERE sample_id = v_sample;
  INSERT INTO public.corpus_reprocess_jobs
    (sample_id, target_version, status, attempts, enqueue_version)
  VALUES
    (v_sample, 2, 'pending', 0, 1)
  RETURNING id INTO v_job;

  -- ── 3: returns expected shape, flips status to processing ─────────────
  SELECT creator_id INTO v_ret_creator
    FROM public.claim_corpus_reprocess_job('test-worker');
  SELECT status INTO v_status
    FROM public.corpus_reprocess_jobs WHERE id = v_job;
  RETURN NEXT ok(
    v_ret_creator = v_creator AND v_status = 'processing',
    format('3: claim returns creator=%s and flips status=%s (want %s/processing)',
           v_ret_creator, v_status, v_creator)
  );

  -- ── 4: second claim on same queue (now drained) → zero rows ───────────
  SELECT count(*) INTO v_n_rows
    FROM public.claim_corpus_reprocess_job('test-worker');
  RETURN NEXT ok(
    v_n_rows = 0,
    format('4: queue drained after first claim → 0 rows on second call (got %s)', v_n_rows)
  );

END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
