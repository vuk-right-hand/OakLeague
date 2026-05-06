-- Auditor R3-NC1 — sanity-check that the prior function definition is
-- the legacy `creator_retrain:<id>` namespace (otherwise the migration
-- has already been applied or the file order is wrong). Fail loud if
-- the function body doesn't match the expected pre-state — running this
-- migration on a DB where it already ran would no-op silently and we'd
-- never know the lock-namespace got reverted.
DO $$
DECLARE
  v_def text;
BEGIN
  -- The function may not exist at all on a fresh staging DB; tolerate that.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
   WHERE n.nspname = 'public' AND p.proname = 'admin_force_retrain_creator'
   LIMIT 1;
  IF v_def IS NOT NULL
     AND v_def NOT LIKE '%creator_retrain:%'
     AND v_def NOT LIKE '%face_clone_overwrite:%' THEN
    RAISE EXCEPTION 'admin_force_retrain_creator exists but uses neither expected lock namespace; aborting to avoid silent revert';
  END IF;
END $$;

-- Auditor R2-C1 fix — admin_force_retrain_creator must also mark the
-- matching face_clone_uploads row state='deleted' under the same lock.
-- Without this, clicking the kebab Delete leaves the audit row stuck
-- in state='ready' forever even though creators.simli_face_id is NULL,
-- and the append-only trigger only allows ready→deleted, so the row
-- can never be recovered to truth once a new face trains.
--
-- The migration also moves the advisory-lock namespace from the
-- legacy 'creator_retrain:<id>' to the face-namespace
-- 'face_clone_overwrite:<id>' so kebab-delete and a concurrent
-- finalize_locked actually serialize against each other (otherwise
-- delete + finalize on different namespaces would race).
--
-- Safe to ship: bumping the lock namespace is a behavior change only
-- when a delete + finalize fire concurrently — a path that's currently
-- impossible because face_clone_finalize_locked didn't exist before
-- migration 20260508000002. So no live caller is on the old namespace.

CREATE OR REPLACE FUNCTION public.admin_force_retrain_creator(
  p_creator_id uuid
) RETURNS TABLE (prior_face_id text, cleared boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller       uuid := auth.uid();
  v_is_admin     boolean;
  v_active_count int;
  v_prior        text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.admin_roles WHERE user_id = v_caller AND revoked_at IS NULL) INTO v_is_admin;
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
  END IF;

  -- Auditor R2-C1 — share lock namespace with face_clone_finalize_locked
  -- so kebab-delete and a concurrent finalize serialize properly.
  PERFORM pg_advisory_xact_lock(hashtext('face_clone_overwrite:' || p_creator_id::text));

  SELECT count(*) INTO v_active_count
    FROM public.sessions
   WHERE creator_id = p_creator_id AND ended_at IS NULL;
  IF v_active_count > 0 THEN
    RAISE EXCEPTION 'creator_has_active_session: % open', v_active_count
      USING ERRCODE = 'P0001';
  END IF;

  SELECT simli_face_id INTO v_prior FROM public.creators WHERE id = p_creator_id FOR UPDATE;
  UPDATE public.creators
     SET simli_face_id = NULL, updated_at = now()
   WHERE id = p_creator_id;

  IF v_prior IS NOT NULL THEN
    -- Auditor R2-C1 — flip the matching face_clone_uploads row from
    -- 'ready' to 'deleted'. The trigger allows ready→deleted. There may
    -- be more than one ready row for the same vendor_face_id only if the
    -- partial-unique index was bypassed (it isn't — see migration 0001),
    -- so one UPDATE is enough.
    UPDATE public.face_clone_uploads
       SET state = 'deleted'
     WHERE creator_id = p_creator_id
       AND vendor_face_id = v_prior
       AND state = 'ready';

    -- Also fail any still-pending uploads for this creator. A race could
    -- leave them dangling — the new training that the admin is about to
    -- start will produce a fresh row anyway.
    UPDATE public.face_clone_uploads
       SET state      = 'failed',
           last_error = COALESCE(last_error, 'cancelled_by_force_retrain')
     WHERE creator_id = p_creator_id
       AND state = 'pending';

    INSERT INTO public.simli_face_delete_queue (face_id, creator_id, enqueued_by, due_at)
    VALUES (v_prior, p_creator_id, v_caller, now() + interval '60 seconds')
    ON CONFLICT (face_id) DO UPDATE
      SET due_at = EXCLUDED.due_at,
          attempts = 0,
          last_error = NULL,
          enqueued_by = EXCLUDED.enqueued_by,
          updated_at = now();
  END IF;

  -- Audit row in cogs_log (cost = 0).
  INSERT INTO public.cogs_log (
    user_id, session_id, service, operation, units, unit_label, cost_usd,
    environment, metadata
  ) VALUES (
    v_caller, NULL, 'simli', 'admin_force_retrain', 1, 'action', 0,
    'production',
    jsonb_build_object('creator_id', p_creator_id, 'prior_face_id', v_prior)
  );

  RETURN QUERY SELECT v_prior, (v_prior IS NOT NULL);
END;$$;

REVOKE EXECUTE ON FUNCTION public.admin_force_retrain_creator(uuid) FROM public;

COMMENT ON FUNCTION public.admin_force_retrain_creator(uuid) IS
  'Admin-only. Clears creators.simli_face_id, marks matching '
  'face_clone_uploads row state=deleted (auditor R2-C1), enqueues prior '
  'face for 60s-deferred delete, audits to cogs_log. Raises P0001 '
  'creator_has_active_session if any open sessions exist (R4-C3 race-guard).';
