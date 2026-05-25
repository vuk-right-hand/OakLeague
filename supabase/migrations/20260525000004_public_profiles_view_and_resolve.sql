-- 20260525000004 — public_profiles view + resolver / viewer-state / availability RPCs
-- PROFILE_SYSTEM_PLAN U1 / §3.2.
--
-- ── DELIBERATE DIVERGENCE FROM R4-C1 (20260420000030) ──────────────────────
-- Every other public view in this codebase (hooks_public, welcome_hooks_public)
-- is security_invoker = true because R4-C1 chose RLS-as-the-gate. This view is
-- security_invoker = false (runs as owner = postgres) ON PURPOSE: profiles RLS
-- is own-read-only, so an invoker view could NEVER serve anon a public profile.
-- The trade: the COLUMN ALLOWLIST below is now the SOLE PII gatekeeper. profiles
-- provably grows columns (email added post-ship in 20260420000027). Therefore:
--   1. The view exposes ONLY the allowlist below — NEVER email / goals /
--      obstacles / tier / timezone / id (auth uuid).
--   2. public_profiles.test.sql asserts the EXACT column set against
--      information_schema and FAILS THE BUILD on any drift.
--   3. The view is NOT granted to anon/authenticated — it is read only by the
--      SECURITY DEFINER RPCs below (single-handle lookup + public lists),
--      preventing bulk enumeration of the whole user base.
-- Do NOT "fix" this back to security_invoker = true — that breaks public profiles.

-- The public handle is creators.handle for PUBLISHED creators (the creator
-- promotion NULLs profiles.handle — 20260420000011), else profiles.handle.
-- An in-review/unpublished creator therefore has NO public handle (their old
-- profile handle was vacated) → no row here → /@handle 404s for the public;
-- the owner sees their pending state via the authed self-view, not this view.

CREATE VIEW public.public_profiles
WITH (security_invoker = false) AS
SELECT
  COALESCE(c.handle, p.handle)                         AS handle,
  COALESCE(c.display_name, p.display_name)             AS display_name,
  COALESCE(c.avatar_url,   p.avatar_url)               AS avatar_url,
  COALESCE(c.bio,          p.bio)                      AS bio,
  (c.id IS NOT NULL)                                   AS is_creator,
  c.id                                                 AS creator_id,
  p.handshake_count,
  p.handshakes_given_count,
  p.created_at
FROM public.profiles p
LEFT JOIN public.creators c
  ON c.user_id = p.id AND c.published_at IS NOT NULL    -- creator face only when published
WHERE COALESCE(c.handle, p.handle) IS NOT NULL;         -- no public handle = no public profile

-- resolve_public_profile(handle) — single row, cacheable (NO per-viewer field, audit M5).
-- GRANT TO anon so logged-out profile views work (audit C2 grant matrix).

CREATE FUNCTION public.resolve_public_profile(p_handle citext)
RETURNS SETOF public.public_profiles
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM public.public_profiles WHERE handle = p_handle;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_public_profile(citext) FROM public;
GRANT  EXECUTE ON FUNCTION public.resolve_public_profile(citext) TO anon, authenticated;

-- viewer_handshake_state(target_handle) — per-viewer, authenticated only, NEVER cached.
-- Split out from resolve_public_profile so the cacheable response never carries
-- per-viewer state (audit M5).

CREATE FUNCTION public.viewer_handshake_state(p_target_handle citext)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.handshakes h
     WHERE h.followee_id = public._profile_id_for_handle(p_target_handle)
       AND h.follower_id = auth.uid()
  );
$$;

REVOKE ALL   ON FUNCTION public.viewer_handshake_state(citext) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.viewer_handshake_state(citext) TO authenticated;

-- handle_available(handle) — UX pre-check (registry unique index is the real
-- guard). Returns a single boolean: NEVER discloses taken-vs-reserved-vs-by-whom
-- (no ownership enumeration, audit Round-1 Small). GRANT anon (onboarding runs
-- the check before the row exists / pre-auth in some flows).

CREATE FUNCTION public.handle_available(p_handle citext)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    p_handle IS NOT NULL
    AND char_length(p_handle) BETWEEN 3 AND 30
    AND p_handle ~ '^[a-z0-9_]+$'
    AND NOT EXISTS (SELECT 1 FROM public.handles_registry WHERE handle = lower(p_handle))
    AND NOT EXISTS (SELECT 1 FROM public.reserved_handles WHERE handle = lower(p_handle));
$$;

REVOKE EXECUTE ON FUNCTION public.handle_available(citext) FROM public;
GRANT  EXECUTE ON FUNCTION public.handle_available(citext) TO anon, authenticated;
