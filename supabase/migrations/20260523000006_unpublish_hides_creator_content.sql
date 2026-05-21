-- 20260523000006 — unpublish cascades to creator-content visibility.
--
-- FIVE_CREATOR_ONBOARDING_READINESS P0-1 audit (M1 + M2). The C3 session-open
-- gate stops new SESSIONS for an unpublished creator, but two read surfaces
-- still leaked the creator's CONTENT after unpublish — a takedown / consent
-- withdrawal must remove the entry points too, not just block the mic:
--
--   M1: welcome_hooks_public filtered only on active + mux_status, so an
--       unpublished creator's welcome hook stayed on the anon landing feed.
--   M2: the hooks public-read RLS policy gated on videos.published_at only.
--       A creator can be unpublished while their videos remain published, so
--       hooks_public (security_invoker=true) still served their hooks to
--       direct readers (deep links, /v/[id] hook validation). The ranked-feed
--       RPCs already filter creators.published_at (SECURITY DEFINER), so the
--       ranked feed was clean — this closes the RLS surface to match.
--
-- NOTE (tracked, NOT closed here): videos' own public-read RLS still gates on
-- videos.published_at independent of creators.published_at, so a deep link
-- straight to a published video of an unpublished creator can still render the
-- video shell (no hook, no session). Full content takedown (cascade unpublish
-- to videos RLS) is a broader change tracked as a follow-up in
-- FIVE_CREATOR_ONBOARDING_READINESS_PLAN; this migration covers the two feed
-- entry-point surfaces the P0-1 unpublish promise implies.

-- ── M1: welcome_hooks_public also requires a published creator ──────────────
-- Column list + order preserved verbatim from 20260425000001 (CREATE OR
-- REPLACE VIEW requires it); only the WHERE gains the creators.published_at
-- EXISTS. security_invoker preserved.
CREATE OR REPLACE VIEW public.welcome_hooks_public WITH (security_invoker = true) AS
  SELECT id,
         creator_id,
         video_id,
         mux_playback_id,
         mux_aspect_ratio,
         mux_duration_ms,
         duration_seconds,
         transcript,
         active
    FROM public.welcome_hooks w
   WHERE active = true
     AND mux_status = 'ready'
     AND EXISTS (
       SELECT 1 FROM public.creators c
        WHERE c.id = w.creator_id
          AND c.published_at IS NOT NULL
     );

-- ── M2: hooks public-read RLS also requires a published creator ─────────────
-- Replaces the videos-only gate from 20260420000016. The "hooks own all"
-- policy is untouched, so a creator still manages their own (unpublished)
-- hooks; only the PUBLIC read is tightened.
DROP POLICY IF EXISTS "hooks public read when parent published" ON public.hooks;
CREATE POLICY "hooks public read when parent published"
  ON public.hooks FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.videos v
      JOIN public.creators c ON c.id = v.creator_id
     WHERE v.id = video_id
       AND v.published_at IS NOT NULL
       AND c.published_at IS NOT NULL
  ));
