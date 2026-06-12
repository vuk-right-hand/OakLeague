-- 20260605000001 — creator_requests (public "Request to become a creator" lead queue)
--
-- CREATOR_JOURNEY_GO_LIVE_PLAN WS1. A public, unauthenticated form writes a
-- lead here; an admin reviews it in /admin/requests and, if it's a fit,
-- approves → mints+sends an invite (existing /invite → /apply flow). This is
-- the single creator-entry funnel (Vuk: "0 difference" between waitlist and
-- request — one good flow). The consumer waitlist stays separate for viewers.
--
-- Untrusted input: email + free-text name/pitch + proof links come from an
-- anonymous browser. The submit action (server-side, service-role) is the gate:
--   - Turnstile + dual-key (IP + normalized email) + global rate limit
--   - proof locked to http(s)-scheme, fixed-key object (mirrors apply ProofSchema)
--   - all anon text HTML-escaped at the email-template boundary (audit H3)
-- The row's `email` is an UNTRUSTED lead, NOT proof of ownership — the approving
-- admin is the human identity check before an invite token is minted (audit C3/C6).
--
-- Service-role only: RLS enabled, ZERO policies, explicit GRANTs. The public
-- insert goes through the admin (service-role) client in the action, never a
-- client-side .from('creator_requests') — so anon/authenticated get no grant.
-- (Same pattern as public.waitlist.)

CREATE TABLE public.creator_requests (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text        NOT NULL CHECK (char_length(email) BETWEEN 3 AND 200),
  name           text        CHECK (name IS NULL OR char_length(name) <= 120),
  pitch          text        CHECK (pitch IS NULL OR char_length(pitch) <= 2000),
  -- Optional proof links. Shape + http(s) scheme enforced in the action layer
  -- (zod), stored verbatim. Bounded so a single row can't be a JSON bomb.
  proof          jsonb       NOT NULL DEFAULT '{}'::jsonb
                               CHECK (jsonb_typeof(proof) = 'object'
                                      AND pg_column_size(proof) <= 8192),
  status         text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'invited', 'declined')),
  created_ip     inet,
  internal_notes text        CHECK (internal_notes IS NULL OR char_length(internal_notes) <= 4000),
  invitation_id  uuid        REFERENCES public.creator_invitations(id) ON DELETE SET NULL,
  reviewed_by    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Queue read: pending first, oldest first. Partial index keeps the common
-- "show me the open queue" scan tiny as decided rows accumulate.
CREATE INDEX creator_requests_pending_idx
  ON public.creator_requests (created_at ASC)
  WHERE status = 'pending';

-- Open-lead lookup by email. Both callers — the /request dedupe
-- (status IN pending,invited) and the creator-status 'requested' check — filter
-- on the BARE column `email = $1` (we store an already-lowercased address), so a
-- functional lower(email) index can't serve them. This partial index on the
-- bare column, scoped to open statuses, is what those queries actually hit and
-- stays tiny as decided rows accumulate (audit M2).
CREATE INDEX creator_requests_open_email_idx
  ON public.creator_requests (email)
  WHERE status IN ('pending', 'invited');

-- Service-role only. RLS on, zero policies = deny-all for anon/authenticated.
ALTER TABLE public.creator_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.creator_requests FROM public, anon, authenticated;
GRANT ALL ON TABLE public.creator_requests TO service_role;

COMMENT ON TABLE public.creator_requests IS
  'Public "Request to become a creator" lead queue. Anonymous form → service-role insert → admin review in /admin/requests → approve mints+sends an invite. email is an untrusted lead, not proof of ownership; the approving admin is the identity check. Service-role only (RLS on, zero policies).';

-- Retention (audit M-3): this is an anonymous-lead table holding PII (email, IP,
-- pitch). Purge DECIDED leads (invited/declined) + their PII 90 days after
-- review. Pending leads are kept (still actionable). Service-role only.
CREATE FUNCTION public.creator_requests_purge_decided() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_deleted int;
BEGIN
  DELETE FROM public.creator_requests
   WHERE status IN ('invited', 'declined')
     AND reviewed_at IS NOT NULL
     AND reviewed_at < now() - interval '90 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;$$;

REVOKE ALL ON FUNCTION public.creator_requests_purge_decided()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.creator_requests_purge_decided() TO service_role;

COMMENT ON FUNCTION public.creator_requests_purge_decided() IS
  'Purges decided (invited/declined) creator_requests + PII >90 days after review. Daily via pg_cron when available; harmless ad-hoc. Returns rows deleted.';

-- Idempotent daily schedule (pg_cron optional; offset from other purge jobs).
DO $$
BEGIN
  PERFORM cron.unschedule('creator_requests_purge_decided');
EXCEPTION
  WHEN undefined_function THEN NULL;  -- pg_cron not installed
  WHEN OTHERS THEN NULL;              -- job didn't exist
END
$$;

DO $$
BEGIN
  PERFORM cron.schedule(
    'creator_requests_purge_decided',
    '17 4 * * *',  -- 04:17 UTC daily
    $sched$SELECT public.creator_requests_purge_decided();$sched$
  );
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'pg_cron not installed; skipping creator_requests_purge_decided schedule.';
END
$$;
