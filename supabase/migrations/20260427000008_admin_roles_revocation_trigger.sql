-- 0052 — admin_roles revocation invalidates unconsumed Pro voice tickets
--
-- Days 8–12 plan REV 5, migration 8 of 11.
-- REV 5 schema correction (on top of REV 4 N2-M7a): the plan originally
-- specified an AFTER DELETE trigger on admin_roles. But migration 0006
-- installs `admin_roles_block_delete` — DELETEs are forbidden; demotions
-- happen via `UPDATE admin_roles SET revoked_at = now()`. The trigger
-- fires on the revocation update, not a non-event.
--
-- Semantics: the instant a superadmin is soft-deleted (revoked_at
-- transitions NULL → non-NULL), delete all unconsumed Pro session tickets
-- they minted. Unconsumed native_audio tickets stay — free-tier voice
-- isn't gated on admin privilege.
--
-- N3-M5 role filter + audit M1 expansion: Pro-ticket invalidation fires on
-- EITHER of:
--   (a) soft-delete  — OLD.revoked_at IS NULL     → NEW.revoked_at IS NOT NULL
--   (b) demotion    — OLD.role = 'superadmin'     → NEW.role <> 'superadmin'
--       (row still un-revoked; the admin just isn't a superadmin anymore)
-- Both paths revoke privilege; either alone would leave outstanding
-- Pro-session tickets live until TTL if untriggered. (Column is `role`
-- not `role_name` per migration 0006.)

CREATE FUNCTION public.admin_roles_on_revoke_kill_voice_tickets() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_did_soft_delete boolean;
  v_did_demotion    boolean;
BEGIN
  v_did_soft_delete :=
    OLD.role = 'superadmin'
    AND OLD.revoked_at IS NULL
    AND NEW.revoked_at IS NOT NULL;

  v_did_demotion :=
    OLD.role = 'superadmin'
    AND NEW.role IS DISTINCT FROM 'superadmin'
    AND OLD.revoked_at IS NULL;  -- already-revoked rows are a no-op.

  IF v_did_soft_delete OR v_did_demotion THEN
    DELETE FROM public.voice_tickets
     WHERE user_id = NEW.user_id
       AND purpose = 'voice_session'
       AND consumed_at IS NULL
       AND expected_tier IN ('premium', 'boardroom');
  END IF;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.admin_roles_on_revoke_kill_voice_tickets() FROM public;

CREATE TRIGGER admin_roles_revocation_voice_sweep
  AFTER UPDATE OF revoked_at, role ON public.admin_roles
  FOR EACH ROW EXECUTE FUNCTION public.admin_roles_on_revoke_kill_voice_tickets();
