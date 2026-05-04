-- 2026-05-04 audit M1 — drop the original voice_clone_finalize (0002).
-- The route only calls voice_clone_finalize_locked (0005); the non-locked
-- variant lacks the active-sessions check and admin re-validation, so
-- keeping it callable is a footgun for any future caller.

REVOKE EXECUTE ON FUNCTION public.voice_clone_finalize(uuid, bigint, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.voice_clone_finalize(uuid, bigint, uuid, text);
