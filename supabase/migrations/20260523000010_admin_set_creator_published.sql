-- 20260523000010 — admin_set_creator_published RPC.
-- (Renumbered from 000005 to dodge a collision with another agent's
-- 000005_brain_compile_variable_depth WIP. Standalone — nothing depends on its
-- ordinal — so applying it last is fine.)
--
-- FIVE_CREATOR_ONBOARDING_READINESS_PLAN P0-1. The canonical (and ONLY)
-- code path that flips a creator to publication-ready. Before this, nothing
-- in the app set creators.published_at / brain_status='ready' — creator #1
-- (Vuk) reached the feed only via hand-run SQL. This unblocks onboarding
-- creator #2..N through the admin UI with zero scripts.
--
-- Pairs with / mirrors the admin-RPC pattern from:
--   * 20260523000001_admin_set_creator_decoupled.sql — SECURITY DEFINER,
--     _assert_caller_is_admin(), auth.uid() audit row, GRANT authenticated.
--     The route calls this via the JWT-bound supabaseServer() client so
--     auth.uid() resolves (admin_audit_log.admin_user_id is NOT NULL FK).
--
-- PUBLISH (p_publish=true) — single atomic UPDATE setting
--   brain_status='ready', published_at=now(). Two separate writes would
--   transiently violate the table CHECK (published_at IS NULL OR
--   brain_status='ready') — see SCHEMA_V1_PLAN §retraining. Guarded by
--   readiness preconditions (each RAISEs a distinct message the route maps
--   to HTTP 422):
--     voice_not_cloned   — creators.voice_id IS NULL (prod voice column;
--                          preview/dev voices are a separate concern)
--     face_not_uploaded  — creators.simli_face_id IS NULL
--     brain_not_compiled — creators.system_prompt IS NULL
--     brain_errored      — brain_status='errored' (pipeline explicitly failed)
--     no_corpus          — no sample_content row with raw_text for the creator
--     no_v2_chunks       — ONLY when brain_mode='vector' AND retrieval_version=2:
--                          requires ≥1 EMBEDDED v2 child chunk
--                          (sample_content_chunks chunker_version=2 AND
--                          embedding IS NOT NULL). A populated narrative unit
--                          with un-embedded children retrieves NOTHING, so the
--                          parent-unit table is the WRONG guard (auditor C1);
--                          gating on embedded children prevents the documented
--                          empty-retrieval foot-gun (PROD_DEPLOY_GATE §F1).
--
-- UNPUBLISH (p_publish=false) — single UPDATE published_at=NULL. Leaves
--   brain_status alone (re-publish later is just another call). NOTE: hiding
--   from the feed is NOT enough to stop sessions — the session-open route
--   does not gate on published_at by default. The companion route patch
--   (src/app/api/sessions/open/route.ts) adds a published_at requirement for
--   non-admin callers so unpublish/takedown actually halts sessions
--   (auditor C3).

CREATE FUNCTION public.admin_set_creator_published(
  p_creator_id uuid,
  p_publish    boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_published   timestamptz;
  v_prev_status      public.brain_status;
  v_voice_id         text;
  v_face_id          text;
  v_system_prompt    text;
  v_brain_mode       public.brain_mode;
  v_retrieval_ver    smallint;
  v_user_id          uuid;
  v_has_corpus       boolean;
  v_has_v2_chunks    boolean;
  v_has_voice_consent   boolean;
  v_has_likeness_consent boolean;
  v_new_published    timestamptz;
  v_new_status       public.brain_status;
BEGIN
  PERFORM public._assert_caller_is_admin();

  IF p_publish IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='publish_required';
  END IF;

  -- FOR UPDATE closes the TOCTOU window (auditor C3): without the row lock, a
  -- concurrent voice-clone delete / corpus wipe / brain-mode flip could clear
  -- voice_id (etc.) between this readiness SELECT and the publish UPDATE,
  -- publishing a creator that fails its own precondition. The lock serializes
  -- against those UPDATEs (all touch the same creators row). Single-row,
  -- admin-only path → no contention concern.
  SELECT published_at, brain_status, voice_id, simli_face_id, system_prompt,
         brain_mode, retrieval_version, user_id
    INTO v_prev_published, v_prev_status, v_voice_id, v_face_id, v_system_prompt,
         v_brain_mode, v_retrieval_ver, v_user_id
    FROM public.creators
   WHERE id = p_creator_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode='42704', message='creator_not_found';
  END IF;

  IF p_publish THEN
    -- ── Readiness preconditions (each maps to HTTP 422 in the route) ──────
    IF v_voice_id IS NULL THEN
      RAISE EXCEPTION USING errcode='P0001', message='voice_not_cloned';
    END IF;
    IF v_face_id IS NULL THEN
      RAISE EXCEPTION USING errcode='P0001', message='face_not_uploaded';
    END IF;
    IF v_system_prompt IS NULL THEN
      RAISE EXCEPTION USING errcode='P0001', message='brain_not_compiled';
    END IF;
    IF v_prev_status = 'errored' THEN
      RAISE EXCEPTION USING errcode='P0001', message='brain_errored';
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM public.sample_content
       WHERE creator_id = p_creator_id AND raw_text IS NOT NULL
    ) INTO v_has_corpus;
    IF NOT v_has_corpus THEN
      RAISE EXCEPTION USING errcode='P0001', message='no_corpus';
    END IF;

    -- Active consent (holistic-audit C1): a creator can be cloned WITH consent,
    -- then have it REVOKED. voice_id/simli_face_id persist, so without this
    -- check the publish RPC would happily (re-)publish a creator whose
    -- voice/likeness consent was withdrawn. Require ACTIVE (revoked_at IS NULL)
    -- voice_clone + likeness consent. Pairs with admin_revoke_creator_consent
    -- auto-unpublishing a live creator on revoke (migration 20260523000007).
    SELECT
      EXISTS (SELECT 1 FROM public.creator_consents
               WHERE user_id = v_user_id AND consent_type = 'voice_clone' AND revoked_at IS NULL),
      EXISTS (SELECT 1 FROM public.creator_consents
               WHERE user_id = v_user_id AND consent_type = 'likeness' AND revoked_at IS NULL)
      INTO v_has_voice_consent, v_has_likeness_consent;
    IF NOT v_has_voice_consent THEN
      RAISE EXCEPTION USING errcode='P0001', message='voice_consent_missing';
    END IF;
    IF NOT v_has_likeness_consent THEN
      RAISE EXCEPTION USING errcode='P0001', message='likeness_consent_missing';
    END IF;

    -- v2 vector creators must have ≥1 EMBEDDED child chunk or retrieval
    -- returns nothing → confident ungrounded answers (auditor C1). Drawer
    -- mode and v1 vector skip this — they retrieve via topic drawers /
    -- legacy chunks respectively.
    IF v_brain_mode = 'vector' AND v_retrieval_ver = 2 THEN
      SELECT EXISTS (
        SELECT 1 FROM public.sample_content_chunks
         WHERE creator_id = p_creator_id
           AND chunker_version = 2
           AND embedding IS NOT NULL
      ) INTO v_has_v2_chunks;
      IF NOT v_has_v2_chunks THEN
        RAISE EXCEPTION USING errcode='P0001', message='no_v2_chunks';
      END IF;
    END IF;

    -- Atomic publish: single UPDATE so the CHECK never sees a transient
    -- (published_at NOT NULL, brain_status<>'ready') state.
    v_new_status    := 'ready';
    v_new_published := now();
    UPDATE public.creators
       SET brain_status = v_new_status,
           published_at = v_new_published
     WHERE id = p_creator_id;
  ELSE
    -- Unpublish: clear published_at only. brain_status stays as-is (the
    -- CHECK permits published_at IS NULL with any brain_status).
    v_new_status    := v_prev_status;
    v_new_published := NULL;
    UPDATE public.creators
       SET published_at = NULL
     WHERE id = p_creator_id;
  END IF;

  -- Audit `after` is branch-specific (auditor M3): the publish branch records
  -- the brain_status it actually set; the unpublish branch records only that
  -- published_at was cleared and flags brain_status as unchanged, so a reviewer
  -- reconstructing state from the log doesn't misread unpublish as a
  -- brain_status write (before==after would otherwise look like a no-op set).
  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
  VALUES
    (auth.uid(), 'creator_published_set', 'creator', p_creator_id,
     jsonb_build_object(
       'published_at', v_prev_published,
       'brain_status', v_prev_status::text),
     CASE WHEN p_publish THEN
       jsonb_build_object(
         'publish',      true,
         'published_at', v_new_published,
         'brain_status', v_new_status::text)
     ELSE
       jsonb_build_object(
         'publish',                false,
         'published_at',           NULL,
         'brain_status_unchanged', true)
     END);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_creator_published(uuid, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_creator_published(uuid, boolean) TO authenticated;

COMMENT ON FUNCTION public.admin_set_creator_published(uuid, boolean) IS
  'FIVE_CREATOR_ONBOARDING_READINESS P0-1. The canonical publish/unpublish setter. p_publish=true atomically sets brain_status=ready + published_at=now() after readiness preconditions (voice_id, simli_face_id, system_prompt, non-errored brain, ≥1 raw_text corpus row, and for vector+v2 ≥1 embedded v2 chunk). p_publish=false clears published_at. Writes admin_audit_log via auth.uid() — call via the JWT-bound client.';

-- RPC signature add → invalidate PostgREST OpenAPI cache (mirrors
-- 20260523000001). Else PGRST202 for up to 60-300s after apply.
NOTIFY pgrst, 'reload schema';
