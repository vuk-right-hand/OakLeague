-- 20260525000002 — handshakes (one-way follow, branded "handshake")
-- PROFILE_SYSTEM_PLAN U1 / §3.3.
--
-- A handshake is a directed edge follower_id → followee_id. Keyed on
-- profiles.id always (a creator IS a user; following a creator = following
-- their profile). Counts are denormalized onto profiles by an AFTER trigger.
--
-- RLS: SELECT public; writes ONLY via the rate-limited SECURITY DEFINER RPCs
-- (no direct client INSERT/DELETE). Lists join profiles directly (NOT the
-- public_profiles view) so they can key on the real id internally while
-- never returning auth.users.id to the client (audit M4).

CREATE TABLE public.handshakes (
  follower_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  followee_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)            -- no self-handshake
);

-- Keyset-pagination indexes. Composite cursor (created_at, <other id>) — created_at
-- alone is not unique (audit Round-1 Small).
CREATE INDEX handshakes_followee_idx ON public.handshakes (followee_id, created_at DESC, follower_id DESC);
CREATE INDEX handshakes_follower_idx ON public.handshakes (follower_id, created_at DESC, followee_id DESC);

-- Count maintenance ---------------------------------------------------------
-- On cascade-delete of a profile P, edge rows where P is on either side are
-- deleted, firing this trigger. The UPDATE on the *deleted* side matches zero
-- rows (P already gone) → harmless no-op; the *counterparty* is decremented
-- correctly. GREATEST(0,…) floors against any double-fire (audit M1).

CREATE FUNCTION public.handshakes_maintain_counts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.profiles SET handshakes_given_count = handshakes_given_count + 1
      WHERE id = NEW.follower_id;
    UPDATE public.profiles SET handshake_count = handshake_count + 1
      WHERE id = NEW.followee_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.profiles SET handshakes_given_count = GREATEST(0, handshakes_given_count - 1)
      WHERE id = OLD.follower_id;
    UPDATE public.profiles SET handshake_count = GREATEST(0, handshake_count - 1)
      WHERE id = OLD.followee_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;$$;

REVOKE EXECUTE ON FUNCTION public.handshakes_maintain_counts() FROM public;

CREATE TRIGGER handshakes_maintain_counts
  AFTER INSERT OR DELETE ON public.handshakes
  FOR EACH ROW EXECUTE FUNCTION public.handshakes_maintain_counts();

-- RLS -----------------------------------------------------------------------

ALTER TABLE public.handshakes ENABLE ROW LEVEL SECURITY;

-- Public read (handshake lists are public). Explicit GRANT required — the
-- codebase default-grant posture is restrictive (20260420000021).
CREATE POLICY "handshakes public read"
  ON public.handshakes FOR SELECT
  USING (true);

GRANT SELECT ON public.handshakes TO anon, authenticated;
-- No INSERT/UPDATE/DELETE policy: writes go through the RPCs only.

-- _profile_id_for_handle(handle) -------------------------------------------
-- Resolve a PUBLIC handle to its owning profiles.id. A creator's handle is
-- promoted to creators.handle and their profiles.handle is NULLed
-- (creators_handle_sync_after, 20260420000011) — so a handle may live on
-- EITHER table. Handshakes always key on the profile (creators.user_id).
-- Internal only (not granted); called from SECURITY DEFINER RPCs (run as owner).

CREATE FUNCTION public._profile_id_for_handle(p_handle citext) RETURNS uuid
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT id FROM (
    SELECT p.id,      1 AS pri FROM public.profiles p WHERE p.handle = p_handle
    UNION ALL
    SELECT c.user_id, 2 AS pri FROM public.creators c WHERE c.handle = p_handle
  ) s ORDER BY pri LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public._profile_id_for_handle(citext) FROM public, anon, authenticated;

-- handshake(target_handle) --------------------------------------------------
-- Handle-based public API: the client only ever knows the handle (the URL),
-- never profiles.id (= auth.users.id). The uuid stays server-side (audit M4).

CREATE FUNCTION public.handshake(p_target_handle citext) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_target uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;

  v_target := public._profile_id_for_handle(p_target_handle);
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'target_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_target = v_uid THEN
    RAISE EXCEPTION 'bad_target' USING ERRCODE = 'check_violation';
  END IF;

  -- Rate limit INSIDE the RPC (audit C4) so calling it directly via PostgREST
  -- can't bypass the cap. rate_limit_hit is 1-minute-window-only by design
  -- (20260420000032 M5 — other windows trip the limit N× too fast). Per-caller
  -- throttle (60/min) + per-target harassment cap (100/min). A coarser daily
  -- cap awaits true variable-window support; 60/min is already a strong guard.
  IF NOT public.rate_limit_hit('handshake', v_uid::text, interval '1 minute', 60) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.rate_limit_hit('handshake_target', v_target::text, interval '1 minute', 100) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.handshakes (follower_id, followee_id)
  VALUES (v_uid, v_target)
  ON CONFLICT (follower_id, followee_id) DO NOTHING;  -- idempotent; count never double-moves
END;$$;

REVOKE ALL   ON FUNCTION public.handshake(citext) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.handshake(citext) TO authenticated;

-- unhandshake(target_handle) ------------------------------------------------

CREATE FUNCTION public.unhandshake(p_target_handle citext) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.handshakes h
   WHERE h.followee_id = public._profile_id_for_handle(p_target_handle)
     AND h.follower_id = v_uid;  -- idempotent
END;$$;

REVOKE ALL   ON FUNCTION public.unhandshake(citext) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.unhandshake(citext) TO authenticated;

-- list_handshakers / list_handshaked ---------------------------------------
-- Public, keyset-paginated. Join profiles directly + LEFT JOIN published
-- creators for the branded face. Filter handle IS NOT NULL so not-yet-onboarded
-- accounts (no public identity) never surface in a public list (audit C3.2).
-- Never returns profiles.id (auth uuid) — only public-safe columns (audit M4).

-- A row's PUBLIC handle is creators.handle when published, else profiles.handle
-- (the creator-promotion NULLs profiles.handle). Filter on the resolved public
-- handle so creator followers show with their creator face and not-yet-onboarded
-- accounts (no public identity either way) never appear (audit C3.2).

CREATE FUNCTION public.list_handshakers(
  p_handle citext,
  p_cursor timestamptz DEFAULT NULL,
  p_limit  int DEFAULT 30
) RETURNS TABLE (
  handle       citext,
  display_name text,
  avatar_url   text,
  is_creator   boolean,
  created_at   timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(c.handle, p.handle),
         COALESCE(c.display_name, p.display_name),
         COALESCE(c.avatar_url, p.avatar_url),
         (c.id IS NOT NULL),
         h.created_at
    FROM public.handshakes h
    JOIN public.profiles p ON p.id = h.follower_id
    LEFT JOIN public.creators c
      ON c.user_id = p.id AND c.published_at IS NOT NULL
   WHERE h.followee_id = public._profile_id_for_handle(p_handle)
     AND COALESCE(c.handle, p.handle) IS NOT NULL
     AND (p_cursor IS NULL OR h.created_at < p_cursor)
   ORDER BY h.created_at DESC, h.follower_id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
$$;

REVOKE EXECUTE ON FUNCTION public.list_handshakers(citext, timestamptz, int) FROM public;
GRANT  EXECUTE ON FUNCTION public.list_handshakers(citext, timestamptz, int) TO anon, authenticated;

CREATE FUNCTION public.list_handshaked(
  p_handle citext,
  p_cursor timestamptz DEFAULT NULL,
  p_limit  int DEFAULT 30
) RETURNS TABLE (
  handle       citext,
  display_name text,
  avatar_url   text,
  is_creator   boolean,
  created_at   timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(c.handle, p.handle),
         COALESCE(c.display_name, p.display_name),
         COALESCE(c.avatar_url, p.avatar_url),
         (c.id IS NOT NULL),
         h.created_at
    FROM public.handshakes h
    JOIN public.profiles p ON p.id = h.followee_id
    LEFT JOIN public.creators c
      ON c.user_id = p.id AND c.published_at IS NOT NULL
   WHERE h.follower_id = public._profile_id_for_handle(p_handle)
     AND COALESCE(c.handle, p.handle) IS NOT NULL
     AND (p_cursor IS NULL OR h.created_at < p_cursor)
   ORDER BY h.created_at DESC, h.followee_id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
$$;

REVOKE EXECUTE ON FUNCTION public.list_handshaked(citext, timestamptz, int) FROM public;
GRANT  EXECUTE ON FUNCTION public.list_handshaked(citext, timestamptz, int) TO anon, authenticated;
